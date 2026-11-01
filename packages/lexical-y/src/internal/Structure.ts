/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $isLineBreakNode,
  $isTextNode,
  ElementNode,
  getStaticNodeConfig,
  type Klass,
  type LexicalNode,
} from 'lexical';

// What the binding reads about Lexical's node structure normalization
// (NodeStructureExtension) that `lexical` does not export: which nodes it
// treats as inline content.

/**
 * Whether a class is the character limit's OverflowNode (or one registered
 * in its place): a class in its chain whose own `$config()` names the type
 * `'overflow'`.
 */
function isOverflowKlass(klass: Klass<LexicalNode>): boolean {
  for (
    let k: Klass<LexicalNode> | null = klass;
    k !== null && k.prototype instanceof ElementNode;
    k = Object.getPrototypeOf(k) as Klass<LexicalNode> | null
  ) {
    if (getStaticNodeConfig(k).ownNodeType === 'overflow') {
      return true;
    }
  }
  return false;
}

const isOverflow = (n: LexicalNode): boolean =>
  isOverflowKlass(n.constructor as Klass<LexicalNode>);

/**
 * Inline content as the normalization reads it: inline nodes, and the
 * OverflowNode the character limit wraps around overflowing text (kept in
 * its paragraph although its `isInline()` is false).
 */
export function $isHeldInline(n: LexicalNode): boolean {
  if ($isTextNode(n) || $isLineBreakNode(n) || isOverflow(n)) {
    return true;
  }
  try {
    return n.isInline();
  } catch (_e) {
    return true;
  }
}
