/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {ContextRecord} from '../types';
import type {
  DOMImportExtensionOutput,
  DOMPreprocessContext,
  DOMPreprocessFn,
  GenerateNodesFromDOMOptions,
  ImportContextPairOrUpdater,
} from './types';

import {$getExtensionOutput} from '@lexical/extension';
import {defineExtension, type LexicalNode, shallowMergeConfig} from 'lexical';

import {DOMImportContextSymbol, DOMImportExtensionName} from '../constants';
import {
  $withFullContext,
  contextFromPairs,
  getContextRecord,
} from '../ContextRecord';
import {type CompiledDispatch, compileImportRules} from './compileImportRules';
import {defineImportRule} from './defineImportRule';
import {
  type DOMImportRuleEntry,
  flattenRuleEntries,
} from './defineOverlayRules';
import {ImportSessionImpl} from './ImportContext';
import {$inlineStylesFromStyleSheets} from './inlineStylesFromStyleSheets';
import {$runImport} from './runImport';
import {selBase} from './sel';

/**
 * Configuration for {@link DOMImportExtension}.
 *
 * @experimental
 */
export interface DOMImportConfig {
  /**
   * The ordered list of rules compiled into the import dispatcher.
   * Entries can be raw {@link DOMImportRule}s or a
   * {@link CompiledOverlayRules} produced by {@link defineOverlayRules}
   * (the latter is inlined at its position in the list — useful for
   * libraries that already publish a compiled overlay).
   *
   * **Rules are evaluated in list order.** For a given DOM node the
   * dispatcher visits every rule whose `match` accepts that node, front
   * to back, and the first one that returns without calling `$next()`
   * decides the outcome. "Higher priority" and "earlier in this list"
   * mean the same thing.
   *
   * **Composition prepends.** `mergeConfig` puts `partial.rules` in
   * FRONT of the rules accumulated so far, and configs are merged in
   * dependency order — a dependency's contribution is merged before the
   * contribution of the extension that depends on it. So:
   *
   * - Each contributor's array is inlined as one contiguous chunk that
   *   keeps its own internal order: within a single
   *   `configExtension(DOMImportExtension, {rules})` call the first
   *   entry has the highest priority.
   * - The chunks are ordered from the most dependent contributor to the
   *   least. An extension's rules therefore outrank the rules
   *   contributed by its dependencies, and rules passed directly to
   *   `buildEditorFromExtensions` (merged last of all) outrank every
   *   extension's. This extension's own default entry
   *   ({@link DefaultHoistRule}) is the base of the list and so is
   *   always tried last.
   *
   * The relative order of two extensions where neither transitively
   * depends on the other falls out of the topological sort and is not
   * part of the API. Make the intended precedence explicit by having the
   * overriding extension depend on the one whose rules it overrides.
   */
  readonly rules: readonly DOMImportRuleEntry[];
  /**
   * Default context pairs applied to every `$generateNodesFromDOM` call.
   * Per-call overrides can be supplied via
   * {@link GenerateNodesFromDOMOptions.context}.
   */
  readonly contextDefaults: readonly ImportContextPairOrUpdater[];
  /**
   * Middleware run on the DOM before walking begins, mutating it in
   * place. Each function receives `$next` and may wrap or short-circuit
   * the rest of the chain (see {@link DOMPreprocessFn}). The default
   * config registers {@link $inlineStylesFromStyleSheets} (resolves
   * `<style>` rules to inline styles so the rules' style-driven matchers
   * see them); apps add more (e.g. strip unsafe elements, normalize
   * attributes, resolve relative URLs).
   *
   * **Composition appends, and the stack is run from the end.**
   * `mergeConfig` puts `partial.preprocess` AFTER the functions
   * accumulated so far, and the runner starts at the last entry and
   * works backwards. This is the opposite array direction from
   * {@link DOMImportConfig.rules} but reaches the same outcome: an
   * extension's preprocessors run before — and can wrap, via `$next()` —
   * those of its dependencies, and the default
   * `$inlineStylesFromStyleSheets` runs last of all (only if every
   * preprocessor above it calls `$next()`). Within a single
   * contribution the LAST entry runs first.
   *
   * Per-call preprocessors registered via
   * {@link GenerateNodesFromDOMOptions.preprocess} are appended on top of
   * the configured stack, so they run BEFORE the configured ones and can
   * wrap them.
   */
  readonly preprocess: readonly DOMPreprocessFn[];
}

/**
 * Drive a stack of {@link DOMPreprocessFn}s top-to-bottom: the highest-
 * index fn runs first and may call `$next()` to defer to the next-lower
 * one. Matches the export-side `callExportMimeTypeFunctionStack` shape.
 */
function $runPreprocessStack(
  stack: readonly DOMPreprocessFn[],
  dom: Document | ParentNode,
  ctx: DOMPreprocessContext,
): void {
  let i = stack.length - 1;
  const $next = () => {
    while (i >= 0) {
      const cur = stack[i--];
      cur(dom, ctx, $next);
      return;
    }
  };
  $next();
}

/**
 * Catch-all rule used as the default `config.rules` entry for
 * {@link DOMImportExtension}. Because every other contribution is
 * prepended to the base config (see {@link DOMImportConfig.rules}), it
 * sits at the end of the list and is the last rule tried: it descends
 * into the element's children and returns whatever they produced. With
 * no other matching rule, an element vanishes and its contents are
 * inserted in its place — the legacy `$createNodesFromDOM` hoisting
 * behavior, but now expressed as a regular rule that apps can override
 * (e.g. with a `sel.any()` rule that captures and discards unknown
 * elements).
 *
 * @experimental
 */
export const DefaultHoistRule = defineImportRule({
  $import: (ctx, el) => ctx.$importChildren(el),
  match: selBase.any(),
  name: '@lexical/html/default-hoist',
});

/**
 * @experimental
 *
 * Extension-based replacement for the legacy `importDOM` / `DOMConversion`
 * machinery. Rules are contributed via configuration (see
 * {@link DOMImportConfig.rules}), compiled into a tag-bucketed dispatcher at
 * editor build time, and consumed via the extension's
 * {@link DOMImportExtensionOutput.$generateNodesFromDOM} output.
 *
 * There is no numeric priority: rules are tried in the order they appear
 * in `config.rules`, and that list is assembled so that an extension's
 * own rules come ahead of the rules its dependencies contributed. See
 * {@link DOMImportConfig.rules} for the exact composition order.
 *
 * The legacy `$generateNodesFromDOM` continues to work in parallel; the
 * intent is to migrate node packages over to this extension incrementally.
 */
export const DOMImportExtension = defineExtension<
  DOMImportConfig,
  typeof DOMImportExtensionName,
  DOMImportExtensionOutput,
  void
>({
  build(editor, config) {
    const dispatch: CompiledDispatch = compileImportRules(
      flattenRuleEntries(config.rules),
    );
    const defaults = contextFromPairs(config.contextDefaults, undefined);
    const configPreprocess = config.preprocess;
    return {
      $generateNodesFromDOM: (
        dom: Document | ParentNode,
        options?: GenerateNodesFromDOMOptions,
      ) => {
        // The session record IS the root layer of the walk's context.
        // When this import runs nested inside another import operation —
        // e.g. raw HTML inside a Markdown import, or a rule re-entering
        // the walk for sub-content — it chains to the ambient import
        // context so states layered by the outer operation stay
        // readable; the outermost call chains to the editor's
        // contextDefaults. Per-call options.context applies on top,
        // and the record is always a *fresh* mutable child (never the
        // shared parent) so session.set writes never leak outward.
        const parentRecord =
          getContextRecord(DOMImportContextSymbol, editor) || defaults;
        const fromOpts =
          options && options.context
            ? contextFromPairs(options.context, parentRecord)
            : parentRecord;
        const sessionRecord: ContextRecord<typeof DOMImportContextSymbol> =
          fromOpts !== undefined && fromOpts !== parentRecord
            ? fromOpts
            : Object.create(parentRecord || null);
        const session = new ImportSessionImpl(sessionRecord);
        const preprocessCtx: DOMPreprocessContext = {session};
        // Stack of preprocessors: config-level first, then per-call.
        // Top of stack (last in array) runs first; `next()` defers to
        // the next-lower one. Matches the GetClipboardDataExtension
        // convention so app-registered preprocessors can wrap built-in
        // ones via `next()`. Preprocess writes via `ctx.session.set`
        // mutate the session record directly.
        const stack: readonly DOMPreprocessFn[] =
          options && options.preprocess
            ? [...configPreprocess, ...options.preprocess]
            : configPreprocess;
        $runPreprocessStack(stack, dom, preprocessCtx);
        return $withFullContext(
          DOMImportContextSymbol,
          sessionRecord,
          () => $runImport(dispatch, editor, dom, session),
          editor,
        );
      },
      defaults,
    };
  },
  config: {
    contextDefaults: [],
    preprocess: [$inlineStylesFromStyleSheets],
    rules: [DefaultHoistRule],
  },
  // `contextDefaults` and `preprocess` append (last wins / runs first,
  // since the preprocess stack is run from the end) while `rules`
  // prepends (first entry wins, and dispatch reads the list front to
  // back). Configs are merged in dependency order, so in every case the
  // more dependent contributor ends up with the higher priority. See
  // `DOMImportConfig` for the full explanation.
  mergeConfig(config, partial) {
    return shallowMergeConfig(config, {
      ...partial,
      ...(partial.contextDefaults && {
        contextDefaults: [
          ...config.contextDefaults,
          ...partial.contextDefaults,
        ],
      }),
      ...(partial.preprocess && {
        preprocess: [...config.preprocess, ...partial.preprocess],
      }),
      ...(partial.rules && {
        rules: [...partial.rules, ...config.rules],
      }),
    });
  },
  name: DOMImportExtensionName,
});

/**
 * Look up the editor's {@link DOMImportExtension} and run its
 * `$generateNodesFromDOM`. Designed as a drop-in replacement for the
 * legacy `$generateNodesFromDOM(editor, dom)` signature so it can be
 * supplied to `ClipboardImportExtension.$generateNodesFromDOM` (or any
 * other consumer that wants to route through the extension pipeline).
 *
 * Throws if the editor was not built with {@link DOMImportExtension} as a
 * dependency.
 *
 * @experimental
 */
export function $generateNodesFromDOMViaExtension(
  dom: Document | ParentNode,
  options?: GenerateNodesFromDOMOptions,
): LexicalNode[] {
  return $getExtensionOutput(DOMImportExtension).$generateNodesFromDOM(
    dom,
    options,
  );
}
