/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {AnyDOMImportRule} from './types';

import {type CompiledDispatch, compileImportRules} from './compileImportRules';

/**
 * Opaque handle for a pre-compiled set of overlay rules. Produce one with
 * {@link defineOverlayRules} and pass it to
 * {@link DOMImportContext.$importChildren} via
 * {@link ImportChildrenOpts.rules}.
 *
 * To merge two or more overlays into a single one, pass them (alongside
 * raw {@link DOMImportRule}s if desired) to a fresh
 * {@link defineOverlayRules} — the entries are flattened into a single
 * ordered list that is dispatched front to back, so earlier entries are
 * higher priority. (Unlike {@link DOMImportConfig.rules}, nothing
 * prepends here: what you write is the evaluation order.)
 *
 * The internal shape is intentionally not part of the public API: it's a
 * compiled dispatch table tagged with `__type` so callers cannot pass a
 * raw rule array where a compiled overlay is expected.
 *
 * @experimental
 */
export interface CompiledOverlayRules {
  readonly __type: 'CompiledOverlayRules';
  /** @internal */
  readonly dispatch: CompiledDispatch;
  /**
   * @internal — flattened source rules retained so an overlay can be
   * recompiled when it is passed to another {@link defineOverlayRules}
   * call or as part of {@link DOMImportConfig.rules}.
   */
  readonly rules: readonly AnyDOMImportRule[];
}

/**
 * An entry accepted everywhere rules are configured (overlay
 * definitions, {@link DOMImportConfig.rules}). Either a single
 * {@link DOMImportRule} or a {@link CompiledOverlayRules} produced by
 * a previous {@link defineOverlayRules} call — passing the latter
 * inlines the overlay's rules at this position in priority order.
 *
 * @experimental
 */
export type DOMImportRuleEntry = AnyDOMImportRule | CompiledOverlayRules;

/** @internal */
export function flattenRuleEntries(
  entries: readonly DOMImportRuleEntry[],
): AnyDOMImportRule[] {
  const out: AnyDOMImportRule[] = [];
  for (const entry of entries) {
    if (isCompiledOverlayRules(entry)) {
      for (const r of entry.rules) {
        out.push(r);
      }
    } else {
      out.push(entry);
    }
  }
  return out;
}

function isCompiledOverlayRules(
  entry: DOMImportRuleEntry,
): entry is CompiledOverlayRules {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    '__type' in entry &&
    entry.__type === 'CompiledOverlayRules'
  );
}

/**
 * Pre-compile a set of {@link DOMImportRuleEntry}s into a
 * {@link CompiledOverlayRules} handle that can be installed via
 * `ctx.$importChildren(el, {rules: …})`.
 *
 * Entries can be raw {@link DOMImportRule}s or other
 * {@link CompiledOverlayRules} (the latter are inlined at their
 * position in the list, so the same call composes any number of
 * overlays). The resulting list is dispatched front to back: earlier
 * entries are higher priority, and a rule defers to the next matching
 * entry by calling `$next()`. When the overlay is installed via
 * `$importChildren({rules})` its whole list is tried before the rules
 * from {@link DOMImportConfig.rules}.
 *
 * Overlay rules installed as a raw array would be re-compiled on every
 * `$importChildren` call. For overlays that are reused (e.g. a GitHub
 * code-table rule that wraps every matching table), call this once at
 * module scope so the dispatch table is built up front.
 *
 * @experimental
 * @__NO_SIDE_EFFECTS__
 */
export function defineOverlayRules(
  entries: readonly DOMImportRuleEntry[],
): CompiledOverlayRules {
  const rules = flattenRuleEntries(entries);
  return {
    __type: 'CompiledOverlayRules',
    dispatch: compileImportRules(rules),
    rules,
  };
}
