/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {
  AnyDOMRenderMatch,
  AnyRenderStateConfigPairOrUpdater,
  ContextRecord,
  DOMRenderRuntime,
  RenderContextReader,
  RenderStateConfig,
} from './types';

import {
  $fullReconcile,
  $isLexicalNode,
  DEFAULT_EDITOR_DOM_CONFIG,
  type EditorDOMRenderConfig,
  type InitialEditorConfig,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';

import {compileDOMRenderConfigOverrides} from './compileDOMRenderConfigOverrides';
import {DOMRenderContextSymbol} from './constants';
import {
  contextFromPairs,
  getContextRecord,
  getContextValue,
} from './ContextRecord';

type RenderContextRecord = ContextRecord<typeof DOMRenderContextSymbol>;

function makeReader(record: RenderContextRecord): RenderContextReader {
  return {
    get<V>(cfg: RenderStateConfig<V>): V {
      return getContextValue(record, cfg);
    },
  };
}

/**
 * The mutable, writable editor-level context record. Reads of a render state
 * during reconciliation (and as the base layer of a session) fall through to
 * this record, and it is the layer the `disabledForEditor` predicates read.
 *
 * @internal
 */
export function createEditorContextRecord(
  contextDefaults: readonly AnyRenderStateConfigPairOrUpdater[],
): RenderContextRecord {
  const parent = Object.create(null) as RenderContextRecord;
  return contextFromPairs(contextDefaults, parent) || parent;
}

/**
 * Filter the configured overrides down to those that are resident in the
 * editor's render config, removing any whose `disabledForEditor` predicate
 * returns `true` for the given editor context.
 *
 * @internal
 */
export function filterEditorInstalled(
  overrides: readonly AnyDOMRenderMatch[],
  record: RenderContextRecord,
): AnyDOMRenderMatch[] {
  const reader = makeReader(record);
  return overrides.filter(
    o => !(o.disabledForEditor && o.disabledForEditor(reader)),
  );
}

function sameOverrides(
  a: readonly AnyDOMRenderMatch[],
  b: readonly AnyDOMRenderMatch[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function symmetricDiff(
  prev: readonly AnyDOMRenderMatch[],
  next: readonly AnyDOMRenderMatch[],
): AnyDOMRenderMatch[] {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  const changed: AnyDOMRenderMatch[] = [];
  for (const o of prev) {
    if (!nextSet.has(o)) {
      changed.push(o);
    }
  }
  for (const o of next) {
    if (!prevSet.has(o)) {
      changed.push(o);
    }
  }
  return changed;
}

/**
 * Build a predicate matching the nodes an override targets — `'*'` matches
 * everything, a node class matches by `instanceof`, and a guard is used as-is.
 */
function nodeMatcher(o: AnyDOMRenderMatch): (node: LexicalNode) => boolean {
  if (o.nodes === '*') {
    return () => true;
  }
  const matchers = o.nodes.map(match => {
    const klass = match as Klass<LexicalNode>;
    return $isLexicalNode(klass.prototype)
      ? (node: LexicalNode) => node instanceof klass
      : (match as (node: LexicalNode) => boolean);
  });
  return node => matchers.some(f => f(node));
}

/**
 * Build a predicate matching the nodes whose DOM must be recreated for the
 * given override change, or `null` when no live re-render is needed.
 *
 * `$createDOM`/`$getDOMSlot` produce the element and slot, and `$decorateDOM`
 * may add DOM that only a fresh `$createDOM` can revert — so toggling any of
 * them recreates the affected nodes. `$updateDOM` is diff-driven and applies on
 * the next node update, and export-only hooks ($exportDOM/$shouldInclude/…)
 * don't touch the live DOM, so neither needs a re-render. Recreating every
 * affected node is the simple, always-correct choice; toggles are rare, so the
 * cost is acceptable and can be optimized later if needed.
 */
function recreatePredicate(
  changed: readonly AnyDOMRenderMatch[],
): ((node: LexicalNode) => boolean) | null {
  const matchers: ((node: LexicalNode) => boolean)[] = [];
  for (const o of changed) {
    if (o.$createDOM || o.$getDOMSlot || o.$decorateDOM) {
      matchers.push(nodeMatcher(o));
    }
  }
  return matchers.length === 0 ? null : node => matchers.some(f => f(node));
}

/**
 * Per-editor runtime backing {@link DOMRenderExtension}'s conditional
 * overrides and imperative editor context. See {@link DOMRenderRuntime}.
 *
 * @internal
 */
export class DOMRenderRuntimeImpl implements DOMRenderRuntime {
  readonly editor: LexicalEditor;
  /**
   * The `nodes` and base `dom` captured at `init` (before `dom` was
   * overwritten with the compiled config) — the clean base for every recompile.
   */
  readonly initialEditorConfig: Pick<InitialEditorConfig, 'nodes' | 'dom'>;
  readonly overrides: readonly AnyDOMRenderMatch[];
  readonly editorContext: RenderContextRecord;
  readonly hasSessionGates: boolean;
  installed: readonly AnyDOMRenderMatch[];

  /** Memoized session configs keyed by the set of session-disabled overrides. */
  private readonly sessionCache = new Map<string, EditorDOMRenderConfig>();

  constructor(
    editor: LexicalEditor,
    initialEditorConfig: Pick<InitialEditorConfig, 'nodes' | 'dom'>,
    overrides: readonly AnyDOMRenderMatch[],
    editorContext: RenderContextRecord,
  ) {
    this.editor = editor;
    this.initialEditorConfig = initialEditorConfig;
    this.overrides = overrides;
    this.editorContext = editorContext;
    this.installed = filterEditorInstalled(overrides, editorContext);
    this.hasSessionGates = overrides.some(o => o.disabledForSession);
  }

  setContextValue<V>(cfg: RenderStateConfig<V>, value: V): void {
    const prev = this.installed;
    this.editorContext[cfg.key] = value;
    const next = filterEditorInstalled(this.overrides, this.editorContext);
    if (sameOverrides(prev, next)) {
      return;
    }
    const changed = symmetricDiff(prev, next);
    this.installed = next;
    this.sessionCache.clear();
    const dom = compileDOMRenderConfigOverrides(this.initialEditorConfig, {
      overrides: next as AnyDOMRenderMatch[],
    });
    this.editor._config.dom = dom;

    const recreate = recreatePredicate(changed);
    if (!recreate) {
      // $updateDOM-only or export-only change: the recompiled config is enough.
      return;
    }

    // Re-render through a full reconcile, which reuses the existing node
    // instances (no node-map mutation, so no spurious mutation/collaboration
    // changes). The affected nodes must be unmounted and recreated — the removed
    // override may have produced or decorated DOM that only a fresh $createDOM
    // reverts — so install a transient $updateDOM that reports a recreate for
    // matching nodes.
    //
    // This mutates the (shared) active config, so the reconcile MUST run and
    // finish synchronously before the original is restored on the next line —
    // hence `discrete`, and hence this must not be called from within an
    // editor.update (where the commit would defer). A deferred update would
    // either restore the wrapper before the reconcile reads it (no recreate) or
    // leave it armed across a window where an unrelated reconcile would
    // spuriously recreate matching nodes. No history tag is needed: a full
    // reconcile marks no nodes dirty, which history merges/discards without
    // pushing.
    const base = dom.$updateDOM;
    dom.$updateDOM = (nextNode, prevNode, el, editor) =>
      recreate(nextNode) ? true : base(nextNode, prevNode, el, editor);
    this.editor.update($fullReconcile, {discrete: true});
    dom.$updateDOM = base;
  }

  getSessionConfig(): EditorDOMRenderConfig {
    const resident = this.editor._config.dom || DEFAULT_EDITOR_DOM_CONFIG;
    if (!this.hasSessionGates) {
      return resident;
    }
    const reader = makeReader(
      getContextRecord(DOMRenderContextSymbol, this.editor) ||
        this.editorContext,
    );
    const disabledKeys: string[] = [];
    const sessionSet: AnyDOMRenderMatch[] = [];
    this.installed.forEach((o, i) => {
      if (o.disabledForSession && o.disabledForSession(reader)) {
        disabledKeys.push(String(i));
      } else {
        sessionSet.push(o);
      }
    });
    if (disabledKeys.length === 0) {
      return resident;
    }
    const key = disabledKeys.join(',');
    let cfg = this.sessionCache.get(key);
    if (!cfg) {
      cfg = compileDOMRenderConfigOverrides(this.initialEditorConfig, {
        overrides: sessionSet,
      });
      this.sessionCache.set(key, cfg);
    }
    return cfg;
  }
}
