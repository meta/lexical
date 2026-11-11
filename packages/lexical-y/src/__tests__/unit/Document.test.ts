/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Group fields, NodeState defaults and pending local updates.
// @vitest-environment node
import type {ListItemNode, ListNode} from '@lexical/list';

import {$createListItemNode, $createListNode} from '@lexical/list';
import * as Y from '@y/y';
import {$createTextNode, $getRoot, $setState, createState} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  setup,
} from '../utils/harness';

const lineState = createState('note', {
  parse: v => (typeof v === 'string' ? v : ''),
});
const $li = (text: string) =>
  $createListItemNode().append($createTextNode(text));

describe('@lexical/y', () => {
  test('line NodeState set back to its default is deleted', async () => {
    const t = await setup(() => $getRoot().append($p('one')));
    t.a.update(() => $setState($block([0]), lineState, 'X'));
    t.a.update(() => $setState($block([0]), lineState, ''));
    await t.sync();
    const marker = t.a.binding.root
      .toArray()
      .find(c => c instanceof Y.Node) as Y.Node;
    expect(
      Object.keys(marker.getAttrs()).filter(k => k.startsWith('s:')),
    ).toEqual([]);
    const fresh = await freshReader(t.a);
    expect(JSON.stringify(fresh.json())).toBe(JSON.stringify(t.a.json()));
    await expectConverged(t.peers);
  });

  test('ListNode NodeState and other group fields sync', async () => {
    const t = await setup(() =>
      $getRoot().append($createListNode('bullet').append($li('a'))),
    );
    t.a.update(() => {
      $setState($block([0]), lineState, 'group');
      ($block([0]) as ListNode).setFormat('center');
      ($block([0]) as ListNode).setDirection('rtl');
    });
    await t.sync();
    await expectConverged(t.peers);
  });

  test('a pending (non-discrete) local update merged with a remote read commit', async () => {
    const t = await setup(() => $getRoot().append($p('one'), $p('two')));
    // b makes a remote change
    t.offline();
    t.b.update(() => $selectIn([1], 3).insertText('B'));
    // a: local change NOT discrete (as from an input event), then remote arrives synchronously
    t.a.editor.update(() => $selectIn([0], 3).insertText('A'));
    await t.sync(); // applies b's update to a while a's update may still be pending
    await new Promise(r => setTimeout(r, 0));
    await t.sync();
    await expectConverged(t.peers);
    expect(t.b.describe()).toContain('oneA');
  });

  test('a list type change after a peer checked an item writes every item', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $p('x'),
        $createListNode('bullet').append($li('a'), $li('b')),
      ),
    );
    t.a.update(() => ($block([1]) as ListNode).setListType('check'));
    await t.sync();
    t.b.update(() => ($block([1, 0]) as ListItemNode).setChecked(true));
    await t.sync();
    // Lexical reports the list as dirty without intent here.
    t.a.update(() => ($block([1]) as ListNode).setListType('bullet'));
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("x") / list[bullet](listitem("a") listitem("b"))',
    );
  });

  test('concurrent list start change and indent', async () => {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      const t = await setup(
        () =>
          $getRoot().append(
            $createListNode('number').append($li('a'), $li('b'), $li('c')),
          ),
        {ids},
      );
      t.offline();
      t.a.update(() => ($block([0]) as ListNode).setStart(5));
      t.b.update(() => ($block([0, 1]) as ListItemNode).setIndent(1));
      await t.sync();
      await expectConverged(t.peers);
    }
  });

  test('start change on a list a peer splits by inserting a paragraph', async () => {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      const t = await setup(
        () =>
          $getRoot().append(
            $createListNode('number').append($li('a'), $li('b'), $li('c')),
          ),
        {ids},
      );
      t.offline();
      t.a.update(() => ($block([0]) as ListNode).setStart(5));
      t.b.update(() => {
        // turn item b into a paragraph (splits the list)
        const li = $block([0, 1]);
        const p = $p('B');
        li.replace(p);
      });
      await t.sync();
      await expectConverged(t.peers);
    }
  });
});

describe('@lexical/y', () => {
  test('app observer on another Y type calls editor.update during a remote transaction', async () => {
    const t = await setup(() => $getRoot().append($p('one'), $p('two')));
    const threadsA = t.a.doc.get('threads');
    // App pattern: when a thread is resolved remotely, edit the editor (e.g.
    // remove its mark).
    threadsA.observe(() => {
      t.a.editor.update(() => $selectIn([0], 3).insertText('[resolved]'));
    });
    // b resolves a thread and edits text in the same transaction.
    t.b.doc.transact(() => {
      t.b.doc.get('threads').setAttr('t1', 'resolved');
    });
    t.b.update(() => $selectIn([1], 3).insertText('B'));
    await t.sync();
    await new Promise(r => setTimeout(r, 0));
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.describe()).toContain('[resolved]');
  });

  test('a list refresh leaves group fields a client wrote on one item as they are', async () => {
    // Each item's marker holds its group's fields; a reader takes them from
    // the group's first item. A refresh (list numbering) that wrote the
    // editor's fields back over another client's would answer each such
    // write, and two clients holding different first items would rewrite
    // each other's without end.
    const t = await setup(() => {
      const list = $createListNode('bullet').append($li('a'), $li('b'));
      $setState(list, lineState, 'one');
      $getRoot().append(list);
    });
    t.offline();
    const markers = (y: Y.Node, out: Y.Node[] = []): Y.Node[] => {
      for (let it = y._start; it !== null; it = it.right) {
        if (!it.deleted && it.content instanceof Y.ContentType) {
          const node = it.content.type as Y.Node;
          if (node.name === '\u00b6') {
            out.push(node);
          } else {
            markers(node, out);
          }
        }
      }
      return out;
    };
    const other = new Y.Doc();
    other.clientID = 77;
    Y.applyUpdate(other, Y.encodeStateAsUpdate(t.a.doc));
    const second = markers(other.get('lexical-y'))[1];
    other.transact(() => second.setAttr('g:$', {note: 'two'}));
    t.a.update(() => ($block([0]) as ListNode).append($li('c')));
    Y.applyUpdate(t.b.doc, Y.encodeStateAsUpdate(other), t.b.net);
    Y.applyUpdate(
      t.b.doc,
      Y.encodeStateAsUpdate(t.a.doc, Y.encodeStateVector(t.b.doc)),
      t.b.net,
    );
    // B refreshed the list (its children changed) and wrote nothing.
    expect(
      Y.decodeStateVector(Y.encodeStateVector(t.b.doc)).has(t.b.doc.clientID),
    ).toBe(false);
    Y.applyUpdate(t.a.doc, Y.encodeStateAsUpdate(other), t.a.net);
    await t.sync();
    await expectConverged([t.a, t.b]);
    expect(t.b.describe()).toContain('listitem("c")');
  });
});
