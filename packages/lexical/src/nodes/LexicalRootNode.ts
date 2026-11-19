/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalNode, SerializedPartial} from '../LexicalNode';

import invariant from '@lexical/internal/invariant';

import {NO_DIRTY_NODES} from '../LexicalConstants';
import {getActiveEditor, isCurrentlyReadOnlyMode} from '../LexicalUpdates';
import {$getRoot} from '../LexicalUtils';
import {$isDecoratorNode} from './LexicalDecoratorNode';
import {
  $isElementNode,
  ElementNode,
  type SerializedElementNode,
} from './LexicalElementNode';

export type SerializedRootNode = SerializedElementNode;

function $getCachedText(node: RootNode): string | null {
  const cachedText = node.getLatest().__cachedText;
  return cachedText !== null &&
    (isCurrentlyReadOnlyMode() ||
      getActiveEditor()._dirtyType === NO_DIRTY_NODES)
    ? cachedText
    : null;
}

/** @noInheritDoc */
export class RootNode extends ElementNode {
  /** @internal */
  __cachedText: null | string;

  $config() {
    return this.config('root', {extends: ElementNode});
  }

  constructor() {
    super('root');
    this.__cachedText = null;
  }

  getTopLevelElementOrThrow(): never {
    invariant(
      false,
      'getTopLevelElementOrThrow: root nodes are not top level elements',
    );
  }

  getTextContent(): string {
    const cachedText = $getCachedText(this);
    return cachedText !== null ? cachedText : super.getTextContent();
  }

  getTextContentSize(): number {
    const cachedText = $getCachedText(this);
    return cachedText !== null ? cachedText.length : super.getTextContentSize();
  }

  remove(): never {
    invariant(false, 'remove: cannot be called on root nodes');
  }

  replace<N = LexicalNode>(node: N): never {
    invariant(false, 'replace: cannot be called on root nodes');
  }

  insertBefore(nodeToInsert: LexicalNode): LexicalNode {
    invariant(false, 'insertBefore: cannot be called on root nodes');
  }

  insertAfter(nodeToInsert: LexicalNode): LexicalNode {
    invariant(false, 'insertAfter: cannot be called on root nodes');
  }

  // View

  updateDOM(prevNode: this, dom: HTMLElement): false {
    return false;
  }

  // Mutate
  splice(
    start: number,
    deleteCount: number,
    nodesToInsert: LexicalNode[],
  ): this {
    for (const node of nodesToInsert) {
      invariant(
        $isElementNode(node) || $isDecoratorNode(node),
        'rootNode.splice: Only element or decorator nodes can be inserted to the root node',
      );
    }
    return super.splice(start, deleteCount, nodesToInsert);
  }

  static importJSON(
    serializedNode: SerializedPartial<SerializedRootNode>,
  ): RootNode {
    // We don't create a root, and instead use the existing root.
    return $getRoot().updateFromJSON(serializedNode);
  }

  collapseAtStart(): true {
    return true;
  }
}

export function $createRootNode(): RootNode {
  return new RootNode();
}

/** Returns true if the given node is a RootNode. */
export function $isRootNode(
  node: RootNode | LexicalNode | null | undefined,
): node is RootNode {
  return node instanceof RootNode;
}
