/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$createLinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
  type ListType,
} from '@lexical/list';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $setSelection,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$p, expectConverged, flush, type Peer, setup} from '../utils/harness';

const $item = (text: string): ListItemNode =>
  $createListItemNode().append($createTextNode(text));
const $list = (type: ListType, ...items: ListItemNode[]) =>
  $createListNode(type).append(...items);
const $wrapper = (type: ListType, ...items: ListItemNode[]) =>
  $createListItemNode().append($list(type, ...items));

// Lists whose items hold nested lists (wrapper items) at several depths,
// one starting with a wrapper, beside the other kinds of content.
function $init() {
  const cell = (text: string) => $createTableCellNode().append($p(text));
  $getRoot().append(
    $createHeadingNode('h2').append($createTextNode('Title')),
    $list(
      'bullet',
      $item('A top'),
      $wrapper(
        'bullet',
        $item('A n1'),
        $wrapper('bullet', $item('A nn1')),
        $item('A n2'),
      ),
      $item('A after'),
    ),
    $p('between ').append(
      $createLinkNode('https://lexical.dev').append($createTextNode('link')),
    ),
    $list(
      'number',
      $wrapper('number', $item('N1')),
      $item('N2'),
      $wrapper('number', $item('N3'), $item('N4')),
    ),
    $list('check', $item('C1'), $wrapper('check', $item('C n1'))),
    $createQuoteNode().append($createTextNode('quote')),
    $createTableNode().append(
      $createTableRowNode().append(cell('a'), cell('b')),
      $createTableRowNode().append(cell('c'), cell('d')),
    ),
    $p('last'),
  );
}

function rereadRoot(peer: Peer) {
  const binding = peer.binding as unknown as {
    rereadContainers: (list: unknown[]) => void;
    state: {containers: Map<unknown, unknown>};
    _root: unknown;
  };
  binding.rereadContainers([binding.state.containers.get(binding._root)]);
}

/** Every node, depth first: its key, type and parent key. */
function tree(peer: Peer): string[] {
  return peer.read(() => {
    const out: string[] = [];
    const walk = (n: LexicalNode) => {
      out.push(`${n.getKey()}:${n.getType()}<${n.getParentKeys()[0] ?? '-'}`);
      if ($isElementNode(n)) {
        n.getChildren().forEach(walk);
      }
    };
    walk($getRoot());
    return out;
  });
}

function selection(peer: Peer): string {
  return peer.read(() => {
    const s = $getSelection();
    if (!$isRangeSelection(s)) {
      return String(s);
    }
    const p = (pt: typeof s.anchor) => `${pt.key}:${pt.offset}:${pt.type}`;
    return `${p(s.anchor)} ${p(s.focus)}`;
  });
}

describe('a full read of an unchanged document gives back the same nodes', () => {
  test('every node key and the caret stay, wherever the caret is', async () => {
    const {a, b} = await setup($init);
    for (const peer of [a, b]) {
      const texts = peer.read(() =>
        $getRoot()
          .getAllTextNodes()
          .map(t => [t.getKey(), t.getTextContentSize()] as const),
      );
      expect(texts.length).toBeGreaterThan(10);
      for (const [key, size] of texts) {
        peer.update(() => {
          const s = $createRangeSelection();
          s.anchor.set(key, size >> 1, 'text');
          s.focus.set(key, size >> 1, 'text');
          $setSelection(s);
        });
        const before = {selection: selection(peer), tree: tree(peer)};
        rereadRoot(peer);
        await flush();
        expect({selection: selection(peer), tree: tree(peer)}).toEqual(before);
      }
    }
    await expectConverged([a, b]);
  });

  test('a range across lists stays, and nothing is written', async () => {
    const {a, b} = await setup($init);
    b.update(() => {
      const texts = $getRoot().getAllTextNodes();
      const from = texts.find(t => t.getTextContent() === 'A nn1')!;
      const to = texts.find(t => t.getTextContent() === 'C n1')!;
      const s = $createRangeSelection();
      s.anchor.set(from.getKey(), 2, 'text');
      s.focus.set(to.getKey(), 1, 'text');
      $setSelection(s);
    });
    const before = {selection: selection(b), tree: tree(b)};
    const updates: Uint8Array[] = [];
    const record = (u: Uint8Array) => updates.push(u);
    b.doc.on('update', record);
    rereadRoot(b);
    rereadRoot(b);
    await flush();
    b.doc.off('update', record);
    expect({selection: selection(b), tree: tree(b)}).toEqual(before);
    expect(updates).toEqual([]);
    await expectConverged([a, b]);
  });
});
