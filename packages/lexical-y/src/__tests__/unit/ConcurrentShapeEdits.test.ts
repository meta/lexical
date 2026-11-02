/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Local edits of shapes that concurrent edits left (two equal lists in one
// list item's line, a ragged table), by several clients at once or while a
// client composes. No client repairs these shapes; an edit that changes them
// is its author's own. Lexical merges two equal lists in an update that
// touches the second (written as a move: a delete and an insert), and pads a
// table before a table command.

import {$createListItemNode, $createListNode} from '@lexical/list';
import {
  $createTableNodeWithDimensions,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setCompositionKey,
  createEditor,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {describeNode, NODES} from '../utils/harness';

type P = {
  doc: Y.Doc;
  editor: ReturnType<typeof createEditor>;
  binding: YBinding;
  warnings: string[];
};

function peer(id: number, state?: Uint8Array): P {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = id;
  if (state !== undefined) {
    Y.applyUpdate(doc, state, 'load');
  }
  const warnings: string[] = [];
  const editor = createEditor({
    namespace: 'concurrent-shape-edits',
    nodes: NODES,
    onError: e => {
      throw e;
    },
    onWarn: e => warnings.push(String(e)),
  });
  const binding = new YBinding(editor, doc, {
    schemaVersion: 1,
    selfCheck: true,
  });
  binding.start();
  return {binding, doc, editor, warnings};
}

function fresh(p: P): P {
  const f = peer(99, Y.encodeStateAsUpdate(p.doc));
  f.binding.initialize();
  return f;
}

const describeP = (p: P) =>
  p.editor
    .getEditorState()
    .read(() => $getRoot().getChildren().map(describeNode).join(' / '));

const update = (p: P, fn: () => void) => {
  p.binding.undoManager?.stopCapturing();
  p.editor.update(fn, {discrete: true});
};

const send = (a: P, b: P) =>
  Y.applyUpdate(
    b.doc,
    Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
    'net',
  );

function exchange(peers: P[]): void {
  for (let round = 0; round < 3; round++) {
    for (const a of peers) {
      for (const b of peers) {
        if (a !== b) {
          send(a, b);
        }
      }
    }
  }
}

const $li = (text: string) =>
  $createListItemNode().append($createTextNode(text));

function $at(path: number[]): ElementNode {
  let n: ElementNode = $getRoot();
  for (const i of path) {
    n = n.getChildAtIndex(i) as ElementNode;
  }
  return n;
}

function $cell(r: number, c: number): ElementNode {
  const t = $getRoot().getChildren().find($isTableNode) as ElementNode;
  return (t.getChildAtIndex(r) as ElementNode).getChildAtIndex(
    c,
  ) as ElementNode;
}

const shape = (p: P) =>
  p.editor.getEditorState().read(() => {
    const t = $getRoot().getChildren().find($isTableNode) as ElementNode;
    return t.getChildren().map(r => (r as ElementNode).getChildrenSize());
  });

function undoRedo(p: P, $line: () => ElementNode): void {
  update(p, () => $line().selectEnd().insertText('ab'));
  update(p, () => $line().selectEnd().insertText('cd'));
  p.binding.undoManager!.stopCapturing();
  p.binding.undo();
  p.binding.undoManager!.stopCapturing();
  p.binding.undo();
  p.binding.undoManager!.stopCapturing();
  p.binding.redo();
}

function listPeers(n: number): P[] {
  const p1 = peer(1);
  update(p1, () =>
    $getRoot().append(
      $createListNode('bullet').append($li('item'), $li('next')),
    ),
  );
  p1.binding.initialize();
  const base = Y.encodeStateAsUpdate(p1.doc);
  const peers = [p1];
  for (let id = 2; id <= n; id++) {
    const p = peer(id, base);
    p.binding.initialize();
    peers.push(p);
  }
  return peers;
}

function expectSame(peers: P[], extra: P[] = []): string {
  const d = describeP(peers[0]);
  for (const p of [...peers, ...extra]) {
    expect(describeP(p)).toBe(d);
    expect(p.warnings).toEqual([]);
  }
  return d;
}

describe('@lexical/y edits of shapes concurrent edits left', () => {
  for (const moving of [false, true]) {
    test(`a client composing in ${moving ? 'the list that moves' : 'the list that stays'} while a peer types there, then its update merges the lists`, () => {
      const [p1, p2, p3, p4] = listPeers(4);
      // P2 and P4 add a list to the item at once.
      update(p2, () =>
        $at([0, 0]).append($createListNode('check').append($li('yy'))),
      );
      update(p4, () =>
        $at([0, 0]).append($createListNode('check').append($li('xx'))),
      );
      const first = moving ? p4 : p2;
      const second = moving ? p2 : p4;
      send(first, p1);
      send(first, p3);
      // P1 composes in that list's item; P3 types there (hidden on P1).
      update(p1, () => {
        const t = $at([0, 1, 0, 0]).getFirstChild() as TextNode;
        $setCompositionKey(t.getKey());
        t.select(2, 2);
      });
      update(p3, () =>
        ($at([0, 1, 0, 0]).getFirstChild() as TextNode)
          .select(0, 0)
          .insertText('Z'),
      );
      send(p3, p1);
      send(p3, first);
      // The other list reaches everyone; each merges before seeing another
      // merge.
      for (const p of [p1, p3, first]) {
        send(second, p);
      }
      // The update that ends P1's composition merges the lists, as P1's
      // own edit.
      update(p1, () => $setCompositionKey(null));
      const peers = [p1, p2, p3, p4];
      exchange(peers);
      const d = expectSame(peers, [fresh(p1), fresh(p4)]);
      expect(d.match(/list\[check\]/g)).toHaveLength(1);
      expect(d.match(/xx/g)).toHaveLength(1);
      expect(d.match(/yy/g)).toHaveLength(1);
      // Each list is in an item of its own (a list item holding a nested
      // list holds nothing else), so no merge moves one list into the
      // other, and what P3 typed is kept in either list (formerly the
      // documented limit: the merge, written as a move, deleted it in the
      // list that moved).
      expect(count(d, 'Z')).toBe(1);
    });
  }

  for (const split of [false, true]) {
    test(`two lists added at once keep both lists' items (author's items ${split ? 'split by undo/redo' : 'unsplit'})`, () => {
      const [p1, p2, p3] = listPeers(3);
      const sv = Y.encodeStateVector(p1.doc);
      update(p1, () =>
        $at([0, 0]).append($createListNode('check').append($li('x'))),
      );
      update(p2, () =>
        $at([0, 0]).append($createListNode('check').append($li('y'))),
      );
      if (split) {
        undoRedo(p2, () => $at([0, 1, 0, 0]));
      }
      const u1 = Y.encodeStateAsUpdate(p1.doc, sv);
      const u2 = Y.encodeStateAsUpdate(p2.doc, sv);
      Y.applyUpdate(p1.doc, u2, 'net');
      Y.applyUpdate(p2.doc, u1, 'net');
      Y.applyUpdate(p3.doc, Y.mergeUpdates([u1, u2]), 'net');
      exchange([p1, p2, p3]);
      const d = expectSame([p1, p2, p3], [fresh(p1)]);
      // Each in an item of its own after "item"; the two nested lists meet
      // and read as one.
      expect(d.match(/list\[check\]/g)).toHaveLength(1);
      expect(d.match(/"x"/g)).toHaveLength(1);
      expect(d.match(/"y(ab)?"/g)).toHaveLength(1);
    });

    test(`two clients run a table command on a ragged table at once: both pad it (row inserter's items ${split ? 'split by undo/redo' : 'unsplit'})`, () => {
      const p1 = peer(1);
      update(p1, () => {
        $getRoot().append(
          $createTableNodeWithDimensions(3, 3, false),
          $createParagraphNode(),
        );
      });
      p1.binding.initialize();
      const p2 = peer(2, Y.encodeStateAsUpdate(p1.doc));
      p2.binding.initialize();
      const p3 = peer(3, Y.encodeStateAsUpdate(p1.doc));
      p3.binding.initialize();
      if (split) {
        undoRedo(p1, () => $cell(1, 1).getFirstChild() as ElementNode);
        exchange([p1, p2, p3]);
      }
      const sv = Y.encodeStateVector(p1.doc);
      update(p1, () => {
        ($cell(0, 0).getFirstChild() as ElementNode).selectEnd();
        $insertTableRowAtSelection(true);
      });
      update(p2, () => {
        ($cell(0, 1).getFirstChild() as ElementNode).selectEnd();
        $insertTableColumnAtSelection(true);
      });
      const u1 = Y.encodeStateAsUpdate(p1.doc, sv);
      const u2 = Y.encodeStateAsUpdate(p2.doc, sv);
      Y.applyUpdate(p1.doc, u2, 'net');
      Y.applyUpdate(p2.doc, u1, 'net');
      Y.applyUpdate(p3.doc, Y.mergeUpdates([u1, u2]), 'net');
      exchange([p1, p2, p3]);
      expectSame([p1, p2, p3], [fresh(p1)]);
      // Shown as stored: the inserted row lacks the inserted column.
      expect(shape(p1)).toEqual([4, 3, 4, 4]);
      // P1 and P2 each insert a row at once; each pads the short row first.
      const sv2 = Y.encodeStateVector(p1.doc);
      for (const p of [p1, p2]) {
        update(p, () => {
          ($cell(3, 0).getFirstChild() as ElementNode).selectEnd();
          $insertTableRowAtSelection(true);
        });
      }
      const v1 = Y.encodeStateAsUpdate(p1.doc, sv2);
      const v2 = Y.encodeStateAsUpdate(p2.doc, sv2);
      Y.applyUpdate(p1.doc, v2, 'net');
      Y.applyUpdate(p2.doc, v1, 'net');
      exchange([p1, p2, p3]);
      expectSame([p1, p2, p3], [fresh(p1)]);
      // Documented limit: the short row got a cell from each, one too many.
      expect(shape(p1)).toEqual([4, 5, 4, 4, 4, 4]);
      // The next table command pads the others: an extra empty column.
      update(p3, () => {
        ($cell(0, 0).getFirstChild() as ElementNode).selectEnd();
        $insertTableRowAtSelection(true);
      });
      exchange([p1, p2, p3]);
      expectSame([p1, p2, p3], [fresh(p1)]);
      expect(shape(p1)).toEqual([5, 5, 5, 5, 5, 5, 5]);
    });
  }

  test('two clients holding the same lists with different item boundaries show them alike', () => {
    const [p1, p2, p3] = listPeers(3);
    const sync = (a: P, b: P) => {
      send(a, b);
      send(b, a);
    };
    update(p1, () =>
      $at([0, 0]).append($createListNode('check').append($li('x'))),
    );
    update(p3, () =>
      $at([0, 0]).append($createListNode('check').append($li('y'))),
    );
    update(p3, () => $at([0, 1, 0, 0]).selectEnd().insertText('ab'));
    update(p3, () => $at([0, 1, 0, 0]).selectEnd().insertText('cd'));
    sync(p3, p2);
    p3.binding.undoManager!.stopCapturing();
    p3.binding.undo();
    p3.binding.undoManager!.stopCapturing();
    p3.binding.undo();
    p3.binding.undoManager!.stopCapturing();
    p3.binding.redo();
    sync(p3, p2);
    // P2 and P3 each receive P1's list before seeing the other's merge.
    const ua = Y.encodeStateAsUpdate(p1.doc, Y.encodeStateVector(p2.doc));
    Y.applyUpdate(p2.doc, ua, 'net');
    Y.applyUpdate(p3.doc, ua, 'net');
    exchange([p1, p2, p3]);
    const d = expectSame([p1, p2, p3], [fresh(p1)]);
    // As above: the two nested lists meet and read as one.
    expect(d.match(/list\[check\]/g)).toHaveLength(1);
    expect(d.match(/"x"/g)).toHaveLength(1);
    expect(d.match(/"y[a-d]*"/g)).toHaveLength(1);
  });
});

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** exchange, letting deferred work (normalization, warnings) run between. */
async function exchangeAsync(peers: P[]): Promise<void> {
  for (let round = 0; round < 3; round++) {
    for (const a of peers) {
      for (const b of peers) {
        if (a !== b) {
          send(a, b);
          await tick();
        }
      }
    }
  }
}

const count = (d: string, token: string) => d.split(token).length - 1;

/**
 * A list item holding a check list; `n` more check lists, each added by
 * another client with one of `items`, reach `p1` one by one while it
 * composes in the first (when `composing`), after the others have
 * exchanged everything. `p1`'s update that ends the composition merges them,
 * as its own edit.
 */
async function mergeWhileComposing(
  items: (() => ElementNode[])[],
  composing: boolean,
): Promise<P[]> {
  const peers = listPeers(items.length + 1);
  const [p1] = peers;
  const sv = Y.encodeStateVector(p1.doc);
  const updates = items.map(($items, i) => {
    update(peers[i + 1], () =>
      $at([0, 0]).append($createListNode('check').append(...$items())),
    );
    return Y.encodeStateAsUpdate(peers[i + 1].doc, sv);
  });
  Y.applyUpdate(p1.doc, updates[0], 'net');
  await tick();
  if (composing) {
    update(p1, () => {
      const t = $at([0, 1, 0, 0]).getFirstChild() as TextNode;
      $setCompositionKey(t.getKey());
      t.select(1, 1);
    });
  }
  for (const u of updates.slice(1)) {
    Y.applyUpdate(p1.doc, u, 'net');
    await tick();
  }
  await exchangeAsync(peers.slice(1));
  update(p1, () => $setCompositionKey(null));
  await tick();
  await exchangeAsync(peers);
  return peers;
}

const $wrapper = (text: string) =>
  $createListItemNode().append($createListNode('bullet').append($li(text)));

describe('@lexical/y local merges of lists added at once', () => {
  test('a peer keystroke held back by a composition is shown once after the merge', async () => {
    const [p1, p2, p3, p4] = listPeers(4);
    update(p2, () =>
      $at([0, 0]).append($createListNode('check').append($li('yy'))),
    );
    update(p4, () =>
      $at([0, 0]).append($createListNode('check').append($li('xx'))),
    );
    send(p2, p1);
    send(p2, p3);
    await tick();
    // P1 composes in P2's list; P3 types there (held back on P1).
    update(p1, () => {
      const t = $at([0, 1, 0, 0]).getFirstChild() as TextNode;
      $setCompositionKey(t.getKey());
      t.select(2, 2);
    });
    await tick();
    update(p3, () =>
      ($at([0, 1, 0, 0]).getFirstChild() as TextNode)
        .select(0, 0)
        .insertText('Z'),
    );
    send(p3, p1);
    send(p3, p2);
    await tick();
    for (const p of [p1, p3, p2]) {
      send(p4, p);
      await tick();
    }
    // P1 types in its list: the update also merges P4's list into it.
    update(p1, () => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.insertText('Q');
      }
    });
    await tick();
    update(p1, () => $setCompositionKey(null));
    await tick();
    await exchangeAsync([p1, p2, p3, p4]);
    const d = expectSame([p1, p2, p3, p4], [fresh(p1)]);
    expect(d.match(/list\[check\]/g)).toHaveLength(1);
    expect([count(d, 'Z'), count(d, 'Q'), count(d, 'xx')]).toEqual([1, 1, 1]);
  });

  test('items that only wrap a nested list are joined at the seam once', async () => {
    const peers = await mergeWhileComposing(
      [() => [$li('aa'), $wrapper('a2')], () => [$wrapper('b2'), $li('bb')]],
      true,
    );
    const d = expectSame(peers, [fresh(peers[0])]);
    expect(
      ['aa', 'a2', 'b2', 'bb'].map(token => count(d, `"${token}"`)),
    ).toEqual([1, 1, 1, 1]);
  });

  for (const composing of [false, true]) {
    test(`three equal lists added from different states ${composing ? 'while a client composes' : 'with no composition'}: every item once`, async () => {
      const peers = await mergeWhileComposing(
        [() => [$li('aa')], () => [$li('bb')], () => [$li('cc')]],
        composing,
      );
      const d = expectSame(peers, [fresh(peers[0])]);
      // Each in an item of its own: the nested lists meet and read as one.
      expect(d.match(/list\[check\]/g)).toHaveLength(1);
      expect(['aa', 'bb', 'cc'].map(token => count(d, `"${token}"`))).toEqual([
        1, 1, 1,
      ]);
    });
  }

  test('a local merge that also edits the moved items: written once, as that edit', () => {
    const [p1, p2, p3, p4] = listPeers(4);
    update(p2, () =>
      $at([0, 0]).append($createListNode('check').append($li('yy'))),
    );
    update(p4, () =>
      $at([0, 0]).append($createListNode('check').append($li('xx'))),
    );
    send(p4, p1);
    send(p4, p3);
    update(p1, () => {
      const t = $at([0, 1, 0, 0]).getFirstChild() as TextNode;
      $setCompositionKey(t.getKey());
      t.select(2, 2);
    });
    for (const p of [p1, p3, p4]) {
      send(p2, p);
    }
    // The update that ends the composition types into the list that moves.
    update(p1, () => {
      $setCompositionKey(null);
      // The two nested lists meet and read as one: P2's item is its second.
      ($at([0, 1, 0, 1]).getFirstChild() as TextNode)
        .select(0, 0)
        .insertText('Q');
    });
    exchange([p1, p2, p3, p4]);
    const d = expectSame([p1, p2, p3, p4], [fresh(p1)]);
    expect([count(d, 'xx'), count(d, 'Q')]).toEqual([1, 1]);
  });
});
