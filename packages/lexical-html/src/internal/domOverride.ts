/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {
  AnyDOMRenderMatch,
  DOMOverrideOptions,
  DOMRenderMatch,
  DOMRenderMatchConfig,
  NodeMatch,
} from './types';
import type {LexicalNode} from 'lexical';

/**
 * A convenience function for type inference when constructing DOM overrides for
 * use with {@link DOMRenderExtension}.
 *
 * The optional `options` argument controls *whether* the override is installed
 * based only on render context — `disabledForEditor` gates residency in the
 * editor's render pipeline (reconciliation), `disabledForSession` gates
 * participation in a single export/generate session. See {@link DOMOverrideOptions}.
 *
 * @experimental
 * @__NO_SIDE_EFFECTS__
 */

export function domOverride(
  nodes: '*',
  config: DOMRenderMatchConfig<LexicalNode>,
  options?: DOMOverrideOptions,
): DOMRenderMatch<LexicalNode>;
export function domOverride<T extends LexicalNode>(
  nodes: readonly NodeMatch<T>[],
  config: DOMRenderMatchConfig<T>,
  options?: DOMOverrideOptions,
): DOMRenderMatch<T>;
export function domOverride(
  nodes: AnyDOMRenderMatch['nodes'],
  config: Omit<AnyDOMRenderMatch, 'nodes' | keyof DOMOverrideOptions>,
  options?: DOMOverrideOptions,
): AnyDOMRenderMatch {
  return {...config, ...options, nodes};
}
