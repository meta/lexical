/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {
  ChildSchema,
  DOMImportContext,
  ImportChildrenOpts,
  ImportNodeOpts,
  ImportSession,
  ImportStateConfig,
} from './types';

import {isDOMDocumentNode, type LexicalEditor, type LexicalNode} from 'lexical';

import {
  type CompiledDispatch,
  type CompiledRule,
  getDispatchIndices,
} from './compileImportRules';
import {
  $getImportContextValue,
  $withImportContext,
  ImportOverlays,
} from './ImportContext';
import {$applySchema, RootSchema} from './schemas';

const __DEV__ = process.env.NODE_ENV !== 'production';

// Annotated by hand: a module-scope call is a side effect to bundlers, and the
// build only injects annotations for Lexical's own factories.
const NO_CAPTURES: Record<string, RegExpMatchArray> =
  /* @__PURE__ */ Object.freeze({} as Record<string, RegExpMatchArray>);

interface Runtime {
  readonly dispatch: CompiledDispatch;
  readonly editor: LexicalEditor;
  readonly session: ImportSession;
  /**
   * Stack of overlay dispatchers installed via `$importChildren({rules})`.
   * The most recently pushed overlay is at the highest index and is
   * tried first; rules within an overlay are dispatched in their own
   * registration order. When all overlay rules for a node have been
   * exhausted (or have called `$next()` to defer), the main dispatcher
   * is consulted. This lets app rules scope cost-bearing predicates to
   * the subtrees where they apply.
   */
  readonly overlays: CompiledDispatch[];
}

function makeContext(
  runtime: Runtime,
  captures: Readonly<Record<string, RegExpMatchArray>>,
): DOMImportContext<Record<string, RegExpMatchArray>> {
  const ctx: DOMImportContext<Record<string, RegExpMatchArray>> = {
    $importChildren: (parent, opts) =>
      $importChildrenInternal(runtime, parent, opts),
    $importOne: (node, opts) => $importOneInternal(runtime, node, opts),
    captures,
    get<V>(cfg: ImportStateConfig<V>): V {
      return $getImportContextValue(cfg, runtime.editor);
    },
    session: runtime.session,
  };
  return ctx;
}

function $importChildrenInternal(
  runtime: Runtime,
  parent: ParentNode,
  opts: ImportChildrenOpts | undefined,
): LexicalNode[] {
  const overlay = opts && opts.rules ? opts.rules.dispatch : undefined;
  if (overlay) {
    runtime.overlays.push(overlay);
  }
  try {
    const run = () => $importChildrenRun(runtime, parent, opts);
    return opts && opts.context
      ? $withImportContext(opts.context, runtime.editor)(run)
      : run();
  } finally {
    if (overlay) {
      runtime.overlays.pop();
    }
  }
}

function $importChildrenRun(
  runtime: Runtime,
  parent: ParentNode,
  opts: ImportChildrenOpts | undefined,
): LexicalNode[] {
  const onChild = opts && opts.$onChild;
  const collected: LexicalNode[] = [];
  for (const child of Array.from(parent.childNodes)) {
    const produced = $importOneInternal(runtime, child, undefined);
    for (const lex of produced) {
      const result = onChild ? onChild(lex) : lex;
      if (result != null) {
        collected.push(result);
      }
    }
  }
  const afterApplied = opts && opts.$after ? opts.$after(collected) : collected;
  const schema: ChildSchema | undefined = opts && opts.schema;
  if (!schema) {
    return afterApplied;
  }
  return $applySchema(schema, afterApplied, null, parent);
}

function $importOneInternal(
  runtime: Runtime,
  node: Node,
  opts: ImportNodeOpts | undefined,
): LexicalNode[] {
  const run = () => $dispatch(runtime, node);
  const out =
    opts && opts.context
      ? $withImportContext(opts.context, runtime.editor)(run)
      : run();
  // Surface to callers as a mutable array per the DOMImportContext contract.
  return out as LexicalNode[];
}

/**
 * Build the candidate (dispatch, indices) list for `node`. Overlays are
 * tried first in top-of-stack order; the main dispatcher comes last. The
 * `$next()` chain walks through all of them in sequence — an overlay rule
 * can defer to a lower overlay rule, or all the way through to a main
 * rule, just by calling `$next()`.
 */
function getCandidates(
  runtime: Runtime,
  node: Node,
): readonly {dispatch: CompiledDispatch; indices: readonly number[]}[] {
  const candidates: {
    dispatch: CompiledDispatch;
    indices: readonly number[];
  }[] = [];
  for (let i = runtime.overlays.length - 1; i >= 0; i--) {
    const d = runtime.overlays[i];
    const idx = getDispatchIndices(d, node);
    if (idx.length > 0) {
      candidates.push({dispatch: d, indices: idx});
    }
  }
  const mainIdx = getDispatchIndices(runtime.dispatch, node);
  if (mainIdx.length > 0) {
    candidates.push({dispatch: runtime.dispatch, indices: mainIdx});
  }
  return candidates;
}

function $dispatch(runtime: Runtime, node: Node): readonly LexicalNode[] {
  const candidates = getCandidates(runtime, node);
  if (candidates.length === 0) {
    return $hoistChildrenOf(runtime, node);
  }
  let groupCursor = 0;
  let ruleCursor = 0;
  const $next = (): readonly LexicalNode[] => {
    while (groupCursor < candidates.length) {
      const {dispatch, indices} = candidates[groupCursor];
      while (ruleCursor < indices.length) {
        const idx = indices[ruleCursor++];
        const rule: CompiledRule = dispatch.rules[idx];
        const captures: Record<string, RegExpMatchArray> = {};
        if (rule.predicate(node, captures)) {
          const ctx = makeContext(
            runtime,
            Object.keys(captures).length === 0 ? NO_CAPTURES : captures,
          );
          try {
            return rule.$import(ctx, node, $next);
          } catch (e) {
            if (__DEV__) {
              console.error(
                `[lexical] DOM import rule "${rule.name}" threw on node`,
                node,
                e,
              );
            }
            throw e;
          }
        }
      }
      groupCursor++;
      ruleCursor = 0;
    }
    return $hoistChildrenOf(runtime, node);
  };
  return $next();
}

/**
 * Fallback when no rule matched and `$next()` was called past the end of the
 * chain: hoist the element's children to take its place, recursively. Pure
 * elements with no rule become invisible, matching the legacy
 * `$createNodesFromDOM` hoisting behavior.
 */
function $hoistChildrenOf(runtime: Runtime, node: Node): LexicalNode[] {
  if (node.childNodes.length === 0) {
    return [];
  }
  const collected: LexicalNode[] = [];
  for (const child of Array.from(node.childNodes)) {
    const produced = $importOneInternal(runtime, child, undefined);
    for (const lex of produced) {
      collected.push(lex);
    }
  }
  return collected;
}

/**
 * Top-level walker for a compiled dispatcher. Iterates the DOM children of
 * `dom` (using the document body if a {@link Document} is passed) and
 * applies `RootSchema` to the produced lexical nodes so runs of inlines are
 * wrapped in paragraphs — same shape as the legacy `$generateNodesFromDOM`.
 *
 * @internal
 */
export function $runImport(
  dispatch: CompiledDispatch,
  editor: LexicalEditor,
  dom: Document | ParentNode,
  session: ImportSession,
): LexicalNode[] {
  // Prime the overlay stack with any overlays a preprocess wrote to
  // ImportOverlays. These remain in effect for the entire walk; nested
  // `$importChildren({rules})` calls push on top.
  const installed = session.get(ImportOverlays);
  const runtime: Runtime = {
    dispatch,
    editor,
    overlays: installed.map(o => o.dispatch),
    session,
  };
  const rootParent: ParentNode = isDOMDocumentNode(dom) ? dom.body : dom;
  return $importChildrenRun(runtime, rootParent, {schema: RootSchema});
}
