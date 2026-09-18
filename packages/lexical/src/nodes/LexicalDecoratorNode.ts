/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {KlassConstructor, LexicalEditor} from '../LexicalEditor';
import type {ElementNode} from './LexicalElementNode';
import type {EditorConfig} from 'lexical';

import invariant from '@lexical/internal/invariant';

import {
  LexicalNode,
  type NodeKey,
  type SlotChildNode,
  type SlotHostNode,
} from '../LexicalNode';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface DecoratorNode<T> {
  getTopLevelElement(): ElementNode | this | null;
  getTopLevelElementOrThrow(): ElementNode | this;
}

/** @noInheritDoc */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class DecoratorNode<T>
  extends LexicalNode
  implements SlotHostNode, SlotChildNode
{
  /** @internal */
  declare ['constructor']: KlassConstructor<typeof DecoratorNode<T>>;
  /** @internal */
  __slotHost: null | NodeKey;
  /** @internal */
  __slots: null | Map<string, NodeKey>;

  constructor(key?: NodeKey) {
    super(key);
    this.__slotHost = null;
    this.__slots = null;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    if (this.__key === prevNode.__key) {
      this.__slotHost = prevNode.__slotHost;
      invariant(
        this.__slotHost === null || this.__parent === null,
        'DecoratorNode: node %s is both slotted into host %s and a child of parent %s; __slotHost and __parent are mutually exclusive',
        this.__key,
        String(this.__slotHost),
        String(this.__parent),
      );
      // Copy-on-write: share the map across versions; the LexicalSlot
      // mutators clone it on a version's first write (owner ledger), so a
      // host cloned for any non-slot change pays no per-version Map copy.
      this.__slots = prevNode.__slots;
    }
  }

  /**
   * The returned value is added to the LexicalEditor._decorators
   */
  decorate(editor: LexicalEditor, config: EditorConfig): null | T {
    return null;
  }

  /**
   * Whether this decorator is isolated from caret interaction: an isolated
   * decorator can not be traversed, extended over, selected as a node, or
   * deleted by an adjacent caret operation. A caret that reaches one stops
   * there, so an inline isolated decorator is only reachable by pointer.
   *
   * Defaults to false, which lets the caret step over the decorator (and
   * select it, when {@link DecoratorNode.isKeyboardSelectable} is also true).
   */
  isIsolated(): boolean {
    return false;
  }

  isInline(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }
}

/** Returns true if the given node is a DecoratorNode. */
export function $isDecoratorNode<T>(
  node: LexicalNode | null | undefined,
): node is DecoratorNode<T> {
  return node instanceof DecoratorNode;
}
