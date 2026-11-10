/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The composer's hold against A's own relocations (see the ComposeHold*
// relocation cells): A composes `abc`; B changes the composed text, which
// A's hold keeps back; A's local edit then relocates what A composed in.
// Writing it would delete what B wrote with the old shared nodes, so the
// write is refused before it changes anything: A's editor reads the
// document again, every peer and a fresh reader keep B's text where it
// was, and A is warned once (UNSUPPORTED_EDIT_WARNING, reason
// 'held-composition'). A removal of what A composed in, on purpose, still
// deletes B's text with it.

import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  $isElementNode,
  $setCompositionKey,
  $setSelection,
  DecoratorNode,
  ElementNode,
  type Klass,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {expect, onTestFinished} from 'vitest';

import {freshReader, NODES, type Peer, type Setup, setup} from './harness';

/** An inline container (a text node's owner that holds no lines). */
export class HoldBox extends ElementNode {
  $config() {
    return this.config('hold_box', {children: 'inline', extends: ElementNode});
  }
  isInline(): true {
    return true;
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM(): false {
    return false;
  }
}

/** An inline decorator a collaborator inserts (it renders in a DOM). */
export class HoldChip extends DecoratorNode<null> {
  $config() {
    return this.config('hold_chip', {extends: DecoratorNode});
  }
  isInline(): true {
    return true;
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

export const HOLD_NODES = [...NODES, HoldBox, HoldChip];

export const GCS = [false, true];
/** Both client id orders (A first, and A last). */
export const ORDERS = [
  [1, 2, 3],
  [3, 2, 1],
];

/** The text node holding `bc` (the composed one), wherever it is. */
export const $composed = (): TextNode =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n.getTextContent().includes('bc'))!;

/**
 * A numbered list whose first item holds `item()`, then an item `tail`, a
 * paragraph and a second list (starting at 7) with an item `other`.
 */
export function $listDocument(item: () => LexicalNode[]): void {
  $getRoot().append(
    $createListNode('number').append(
      $createListItemNode().append(...item()),
      $createListItemNode().append($createTextNode('tail')),
    ),
    $createParagraphNode().append($createTextNode('separator')),
    $createListNode('number', 7).append(
      $createListItemNode().append($createTextNode('other')),
    ),
  );
}

export type Relocation = 'move' | 'other list' | 'nest' | 'unwrap';

/** Composed in an inline container in the item, or straight in its line. */
export type Shape = 'box' | 'line';

const SEPARATOR = 'paragraph("separator")';
const OTHER = 'list[number,7](listitem("other"))';

/**
 * The document describeNode shows after `relocation` (null: none) of the
 * first item, whose composed text shows as `content` (the box's children,
 * or the item's in a line).
 */
export function relocated(
  relocation: Relocation | null,
  shape: Shape,
  content: string,
): string {
  const inItem =
    shape === 'box' && relocation !== 'unwrap'
      ? `hold_box(${content})`
      : content;
  if (relocation === 'move') {
    return `list[number](listitem("tail") listitem(${inItem})) / ${SEPARATOR} / ${OTHER}`;
  }
  if (relocation === 'other list') {
    return `list[number](listitem("tail")) / ${SEPARATOR} / list[number,7](listitem("other") listitem(${inItem}))`;
  }
  if (relocation === 'nest') {
    return `list[number](listitem("tail") listitem(list[number](listitem(${inItem})))) / ${SEPARATOR} / ${OTHER}`;
  }
  return `list[number](listitem(${inItem}) listitem("tail")) / ${SEPARATOR} / ${OTHER}`;
}

/**
 * A's relocation of the first list's first item (or, `unwrap`, of the
 * inline container in it): to the end of its list, to the end of the other
 * list, nested under a new item, or the container's children moved into the
 * item.
 */
export function $relocate(relocation: Relocation): void {
  const root = $getRoot();
  const first = root.getFirstChildOrThrow() as ListNode;
  const item = first.getFirstChildOrThrow() as ListItemNode;
  const other = root.getLastChildOrThrow() as ListNode;
  if (relocation === 'move') {
    first.append(item);
  } else if (relocation === 'other list') {
    other.append(item);
  } else if (relocation === 'nest') {
    first.append(
      $createListItemNode().append($createListNode('number').append(item)),
    );
  } else {
    const box = item
      .getChildren()
      .find(c => $isElementNode(c) && c.isInline()) as ElementNode;
    for (const child of box.getChildren()) {
      box.insertBefore(child);
    }
    box.remove();
  }
}

/**
 * A set up with a DOM root (it composes there), composing at offset 1 of
 * the composed text; the peers synced. `before` runs first, on the synced
 * peers.
 */
export async function composing(
  init: () => void,
  gc: boolean,
  ids: number[],
  before?: (t: Setup) => Promise<void>,
  nodes: Klass<LexicalNode>[] = [],
): Promise<Setup> {
  const t = await setup(init, {gc, ids, nodes: [...HOLD_NODES, ...nodes]});
  if (before !== undefined) {
    await before(t);
  }
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  t.a.editor.setRootElement(host);
  host.focus();
  onTestFinished(() => {
    t.a.editor.setRootElement(null);
    host.remove();
    t.peers.forEach(p => p.stop());
  });
  t.a.update(() => {
    const n = $composed();
    n.select(1, 1);
    $setCompositionKey(n.getKey());
  });
  await t.sync();
  return t;
}

/** The message of the warning a refused relocation raises. */
export const REFUSAL = /would delete or leave behind text a collaborator wrote/;

/** A's last change was refused: one warning, the refusal (taken). */
export function refused(t: Setup): void {
  expect(t.a.warnings).toHaveLength(1);
  expect(t.a.warnings[0]).toMatch(REFUSAL);
  t.a.warnings.length = 0;
}

/** Whether A's hold keeps something back now. */
export const holds = (a: Peer): boolean =>
  (a.binding as unknown as {state: {hidden: unknown}}).state.hidden !== null;

/** B's change of the composed line, which A's hold keeps back. */
export async function held(t: Setup, fn: () => void): Promise<void> {
  const before = t.a.describe();
  t.b.update(() => {
    fn();
    $setSelection(null);
  });
  await t.sync();
  expect(holds(t.a)).toBe(true);
  expect(t.a.describe()).toBe(before);
}

/**
 * A ends its composition; every peer and a fresh reader of A's document
 * show the same, and A was warned of nothing. Returns what they show.
 */
export async function settled(t: Setup): Promise<string> {
  t.a.update(() => $setCompositionKey(null));
  await t.sync();
  const fresh = await freshReader(t.a);
  onTestFinished(() => fresh.stop());
  const shown = t.a.describe();
  for (const p of t.peers) {
    expect(p.describe()).toBe(shown);
  }
  expect(fresh.describe()).toBe(shown);
  expect(t.a.warnings).toEqual([]);
  return shown;
}

/** The first list's items, as describeNode shows them. */
export function items(shown: string): string {
  return shown.split(' / ')[0];
}
