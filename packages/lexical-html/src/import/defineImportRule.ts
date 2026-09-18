/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {CompiledSelector, DOMImportFn, DOMImportRule} from './types';

/**
 * Identity helper that infers a rule's matched node type and capture map
 * from its `match` selector and threads them into the `$import` signature.
 * Usage:
 *
 * ```ts
 * defineImportRule({
 *   name: '@lexical/list/li',
 *   match: sel.tag('li'),
 *   $import: (ctx, el, $next) => {
 *     // el: HTMLLIElement
 *     return [$createListItemNode()];
 *   },
 * });
 * ```
 *
 * @experimental
 * @__NO_SIDE_EFFECTS__
 * @lexical-inline identity
 */
export function defineImportRule<const S extends CompiledSelector>(rule: {
  readonly name?: string;
  readonly match: S;
  readonly $import: DOMImportFn<
    S extends CompiledSelector<infer N, Record<string, RegExpMatchArray>>
      ? N
      : Node,
    S extends CompiledSelector<Node, infer C> ? C : Record<string, never>
  >;
}): DOMImportRule<S> {
  return rule as DOMImportRule<S>;
}
