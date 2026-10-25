/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $applyNodeReplacement,
  $copyNode,
  $getDocument,
  defineExtension,
  type EditorConfig,
  ElementNode,
  type LexicalNode,
  type RangeSelection,
  type SerializedElementNode,
} from 'lexical';

export type SerializedOverflowNode = SerializedElementNode;

/** @noInheritDoc */
export class OverflowNode extends ElementNode {
  /** @internal */
  $config() {
    return this.config('overflow', {
      $transform(node: OverflowNode) {
        if (node.isEmpty()) {
          node.remove();
        }
      },
      extends: ElementNode,
    });
  }

  createDOM(config: EditorConfig): HTMLElement {
    const div = $getDocument().createElement('span');
    const className = config.theme.characterLimit;
    if (typeof className === 'string') {
      div.className = className;
    }
    return div;
  }

  updateDOM(prevNode: this, dom: HTMLElement): boolean {
    return false;
  }

  // Now that the node is inline, a line break or paragraph inserted inside it
  // splits it with this method, so it must make the other half (as LinkNode
  // does) and not a new parent block.
  insertNewAfter(
    _: RangeSelection,
    restoreSelection = true,
  ): null | LexicalNode {
    const overflow = $copyNode(this);
    this.insertAfter(overflow, restoreSelection);
    return overflow;
  }

  excludeFromCopy(): boolean {
    return true;
  }

  isInline(): true {
    return true;
  }
}

export function $createOverflowNode(): OverflowNode {
  return $applyNodeReplacement(new OverflowNode());
}

export function $isOverflowNode(
  node: LexicalNode | null | undefined,
): node is OverflowNode {
  return node instanceof OverflowNode;
}

/**
 * Configures {@link OverflowNode}
 */
export const OverflowExtension = defineExtension({
  name: '@lexical/overflow',
  nodes: () => [OverflowNode],
});
