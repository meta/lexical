/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Named-slot fixtures for the slot tests: hosts shaped like Meta Artifacts'
// components (a block decorator with undeclared slots holding a shadow-root
// body) and like the playground's pull quote (declared slots), card (an
// element with a declared slot next to its children) and an inline host.

import {$createListItemNode} from '@lexical/list';
import {
  $create,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $isTextNode,
  $setSelection,
  $setSlot,
  DecoratorNode,
  ElementNode,
  type Klass,
  type LexicalNode,
  type RangeSelection,
  type TextNode,
} from 'lexical';

import {NODES} from './harness';

/** A slot value that holds blocks (Artifacts' ComponentSlotNode). */
export class SlotBodyNode extends ElementNode {
  $config() {
    return this.config('test_slot_body', {extends: ElementNode});
  }
  isShadowRoot(): true {
    return true;
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): false {
    return false;
  }
}

/** A block decorator with undeclared slots (Artifacts' ComponentNode). */
export class ComponentNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_component', {extends: DecoratorNode});
  }
  isInline(): false {
    return false;
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

/** A block decorator that declares its slots (the playground's pull quote). */
export class PullQuoteNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_pullquote', {
      extends: DecoratorNode,
      slots: ['quote', 'attribution'],
    });
  }
  isInline(): false {
    return false;
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

/** An element with a declared slot next to its children (a card). */
export class CardNode extends ElementNode {
  $config() {
    return this.config('test_card', {extends: ElementNode, slots: ['title']});
  }
  isShadowRoot(): true {
    return true;
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): false {
    return false;
  }
}

/** An inline decorator with a slot (stored inside its line). */
export class ChipNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_chip', {extends: DecoratorNode});
  }
  isInline(): true {
    return true;
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

export const SLOT_NODES: Klass<LexicalNode>[] = [
  ...NODES,
  SlotBodyNode,
  ComponentNode,
  PullQuoteNode,
  CardNode,
  ChipNode,
];

export const $body = (...blocks: LexicalNode[]) =>
  $create(SlotBodyNode).append(...blocks);

export const $li = (text: string) =>
  $createListItemNode().append($createTextNode(text));

export function $component(slots: Record<string, LexicalNode>): ComponentNode {
  const host = $create(ComponentNode);
  for (const name of Object.keys(slots)) {
    $setSlot(host, name, slots[name]);
  }
  return host;
}

/** Every node, slots included (a host's slots before its children). */
export function $all(): LexicalNode[] {
  const out: LexicalNode[] = [];
  const visit = (n: LexicalNode) => {
    out.push(n);
    for (const name of $getSlotNames(n)) {
      const slot = $getSlot(n, name);
      if (slot !== null) {
        visit(slot);
      }
    }
    if ($isElementNode(n)) {
      n.getChildren().forEach(visit);
    }
  };
  visit($getRoot());
  return out;
}

/** The text node holding `token`, and the offset of `token` in it. */
export function $findText(token: string): [TextNode, number] {
  for (const n of $all()) {
    if ($isTextNode(n)) {
      const i = n.getTextContent().indexOf(token);
      if (i >= 0) {
        return [n, i];
      }
    }
  }
  throw new Error(`no text ${token}`);
}

/** A caret at `token` (after it with `after`). */
export function $caretAt(token: string, after = false): RangeSelection {
  const [text, at] = $findText(token);
  const offset = after ? at + token.length : at;
  const sel = $createRangeSelection();
  sel.anchor.set(text.getKey(), offset, 'text');
  sel.focus.set(text.getKey(), offset, 'text');
  $setSelection(sel);
  return sel;
}
