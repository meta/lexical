/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Version gate, concurrent initialization, NodeState on lines, undo across peers.
// @vitest-environment node
import type {ListItemNode} from '@lexical/list';

import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import * as Y from '@y/y';
import {
  $createTextNode,
  $getRoot,
  $getState,
  $setState,
  createEditor,
  createState,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, LAYOUT_VERSION, YBinding} from '../..';
import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  NODES,
  Peer,
  setup,
} from '../utils/harness';

const ORDERS = [
  {delivery: 'causal' as const, ids: [1, 2]},
  {delivery: 'causal' as const, ids: [2, 1]},
  {delivery: 'sender' as const, ids: [1, 2]},
  {delivery: 'sender' as const, ids: [2, 1]},
];
const $li = (text: string) =>
  $createListItemNode().append($createTextNode(text));

const lineState = createState('note', {
  parse: v => (typeof v === 'string' ? v : ''),
});
const objState = createState('obj', {
  parse: v =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : null,
});

function mkEditor(warnings: string[]) {
  return createEditor({
    namespace: 'p',
    nodes: NODES,
    onError: e => {
      throw e;
    },
    onWarn: e => warnings.push(String((e as Error).message)),
  });
}

describe('version gate', () => {
  test('foreign root content arriving by update (not doc.get) is detected', () => {
    const old = new Y.Doc();
    old.get('root').insert(0, 'old layout text');
    const doc = createYDoc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(old));
    const warnings: string[] = [];
    const editor = mkEditor(warnings);
    const b = new YBinding(editor, doc, {schemaVersion: 1, selfCheck: true});
    b.start();
    b.initialize();
    expect(b.status).toBe('readonly');
  });

  test('foreign root content in a Yjs-13-style XmlText root by update', () => {
    // content written under the v2 root name used by @lexical/yjs
    const old = new Y.Doc();
    old.get('root-v2').insert(0, [new Y.Node('paragraph')]);
    const doc = createYDoc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(old));
    const warnings: string[] = [];
    const b = new YBinding(mkEditor(warnings), doc, {
      schemaVersion: 1,
      selfCheck: true,
    });
    b.start();
    b.initialize();
    expect(b.status).toBe('readonly');
  });

  test('a layout record that is not a version (not an integer from 1, or not true)', () => {
    for (const [k, v] of [
      ['lexical-y:abc', true],
      ['lexical-y:0', true],
      ['lexical-y:-1', true],
      ['lexical-y:1.5', true],
      ['lexical-y:01', true],
      ['lexical-y:', true],
      ['lexical-y:1', 1],
      ['lexical-y:1', 'true'],
      ['lexical-y:1', null],
    ] as const) {
      const doc = createYDoc();
      doc.get('lexical-y').setAttr(k, v as never);
      const warnings: string[] = [];
      const editor = mkEditor(warnings);
      const b = new YBinding(editor, doc, {schemaVersion: 1, selfCheck: true});
      b.start();
      b.initialize();
      expect(b.status).toBe('readonly');
      expect(editor.isEditable()).toBe(false);
    }
  });

  test('dispose of a read-only binding gives the editor back its editability', () => {
    for (const editable of [true, false]) {
      const doc = createYDoc();
      doc.get('lexical-y').setAttr('lexical-y:999', true);
      const warnings: string[] = [];
      const editor = mkEditor(warnings);
      editor.setEditable(editable);
      const b = new YBinding(editor, doc, {schemaVersion: 1, selfCheck: true});
      b.start();
      b.initialize();
      expect(b.status).toBe('readonly');
      expect(editor.isEditable()).toBe(false);
      b.dispose();
      expect(editor.isEditable()).toBe(editable);
    }
  });

  test('root content without version, version arrives later', async () => {
    const src = createYDoc();
    src.clientID = 5;
    const warnings: string[] = [];
    const e1 = mkEditor(warnings);
    const b1 = new YBinding(e1, src, {schemaVersion: 1, selfCheck: true});
    b1.start();
    e1.update(() => $getRoot().clear().append($p('hello')), {discrete: true});
    b1.initialize();
    // Strip the version: copy the doc and delete the attr on a copy.
    const doc = createYDoc();
    doc.clientID = 6;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(src));
    doc.get('lexical-y').deleteAttr('lexical-y:1');
    const e2 = mkEditor(warnings);
    const b2 = new YBinding(e2, doc, {schemaVersion: 1, selfCheck: true});
    b2.start();
    b2.initialize();
    expect(b2.status).toBe('readonly');
    expect(Y.decodeStateVector(Y.encodeStateVector(doc)).has(6)).toBe(false);
    // The version arrives later: the document is one this version reads.
    doc.get('lexical-y').setAttr('lexical-y:1', true);
    expect(b2.status).toBe('active');
    expect(e2.isEditable()).toBe(true);
    e2.update(() => $getRoot().append($p('local')), {discrete: true});
    expect(Y.decodeStateVector(Y.encodeStateVector(doc)).has(6)).toBe(true);
  });

  test('active client receives a newer version mid session', async () => {
    const t = await setup(() => $getRoot().append($p('abc')));
    t.b.doc.transact(() =>
      t.b.doc
        .get('lexical-y')
        .setAttr('lexical-y:' + (LAYOUT_VERSION + 1), true),
    );
    await t.sync();
    // b's binding: its own transaction with origin != binding is treated as remote
    expect(t.a.binding.status).toBe('readonly');
    const before = Y.encodeStateVector(t.a.doc);
    t.a.update(() => $selectIn([0], 3).insertText('X'));
    await t.sync();
    // The edit stays local: nothing is written while read only.
    expect(Y.encodeStateVector(t.a.doc)).toEqual(before);
    expect(t.b.describe()).toBe('paragraph("abc")');
  });

  test('two clients record newer layouts at once (n+2 ‖ n+1): every client and a fresh reader take the highest', async () => {
    const t = await setup(() => $getRoot().append($p('abc')), {
      ids: [10, 20, 30],
    });
    const newer = LAYOUT_VERSION + 1;
    const newest = LAYOUT_VERSION + 2;
    t.offline();
    // As newer bindings would, each in the transaction that needs it.
    t.a.doc.transact(() =>
      t.a.doc.get('lexical-y').setAttr('lexical-y:' + newest, true),
    );
    t.b.doc.transact(() =>
      t.b.doc.get('lexical-y').setAttr('lexical-y:' + newer, true),
    );
    await t.sync();
    const layoutWarning = (warnings: string[]) =>
      warnings.filter(w => w.includes('is newer than')).pop();
    for (const peer of t.peers) {
      expect(peer.binding.status).toBe('readonly');
      expect(layoutWarning(peer.warnings)).toBe(
        `layout ${newest} is newer than ${LAYOUT_VERSION}. A newer version of the binding wrote this document, so this editor is read only: upgrade the binding on every client of the document`,
      );
      expect(peer.binding.root.getAttrs()).toMatchObject({
        'lexical-y:1': true,
        ['lexical-y:' + newer]: true,
        ['lexical-y:' + newest]: true,
      });
    }
    const warnings: string[] = [];
    const doc = createYDoc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(t.b.doc));
    const fresh = new YBinding(mkEditor(warnings), doc, {schemaVersion: 1});
    fresh.start();
    fresh.initialize();
    expect(fresh.status).toBe('readonly');
    expect(layoutWarning(warnings)).toBe(
      `layout ${newest} is newer than ${LAYOUT_VERSION}. A newer version of the binding wrote this document, so this editor is read only: upgrade the binding on every client of the document`,
    );
  });

  test('at a layout this version does not read, undo and redo write nothing, through the binding or its UndoManager', async () => {
    const t = await setup(() => $getRoot().append($p('abc')));
    const um = t.a.binding.undoManager!;
    t.a.update(() => $selectIn([0], 3).insertText('X'));
    um.stopCapturing();
    t.a.update(() => $selectIn([0], 4).insertText('Y'));
    um.stopCapturing();
    expect(t.a.binding.undo()).toBe(true);
    await t.sync();
    expect([um.canUndo(), um.canRedo()]).toEqual([true, true]);
    t.b.doc.transact(() =>
      t.b.doc.get('lexical-y').setAttr('lexical-y:99', true),
    );
    await t.sync();
    expect(t.a.binding.status).toBe('readonly');
    const before = Y.encodeStateVector(t.a.doc);
    expect(t.a.binding.undo()).toBe(false);
    expect(t.a.binding.redo()).toBe(false);
    um.undo();
    um.redo();
    expect(Y.encodeStateVector(t.a.doc)).toEqual(before);
    expect(t.a.describe()).toBe('paragraph("abcX")');
  });
});

describe('concurrent init', () => {
  for (const o of ORDERS) {
    test(`two clients initialize an empty doc ${o.ids} ${o.delivery}`, async () => {
      const net = {
        delivery: o.delivery,
        peers: [] as Peer[],
        pumping: false,
        queue: [] as [Peer, Uint8Array][],
      };
      const a = new Peer(o.ids[0], net as never);
      const b = new Peer(o.ids[1], net as never);
      a.online = false;
      b.online = false;
      a.update(() => $getRoot().clear().append($p('from a')));
      b.update(() => $getRoot().clear().append($p('from b')));
      a.binding.initialize();
      b.binding.initialize();
      // exchange
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), net);
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), net);
      expect(a.describe()).toBe(b.describe());
      const f = await freshReader(a);
      expect(f.describe()).toBe(a.describe());
      expect([...a.warnings, ...b.warnings]).toEqual([]);
    });
  }
  test('two clients initialize with default empty editor (one empty paragraph each)', async () => {
    const net = {
      delivery: 'causal',
      peers: [] as Peer[],
      pumping: false,
      queue: [] as [Peer, Uint8Array][],
    };
    const a = new Peer(1, net as never);
    const b = new Peer(2, net as never);
    a.online = false;
    b.online = false;
    a.update(() => $getRoot().clear().append($p('')));
    b.update(() => $getRoot().clear().append($p('')));
    a.binding.initialize();
    b.binding.initialize();
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), net);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), net);
    // Identical initial content dedupes into one paragraph.
    expect(a.describe()).toBe('paragraph()');
    expect(b.describe()).toBe(a.describe());
  });
});

describe('NodeState on lines', () => {
  for (const o of ORDERS) {
    test(`concurrent different keys + same key ${o.ids} ${o.delivery}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('one'),
            $createHeadingNode('h2').append($createTextNode('two')),
          ),
        o,
      );
      t.offline();
      t.a.update(() => {
        $setState($block([0]), lineState, 'A');
        $setState($block([1]), objState, {x: 1, y: [1, 2]});
      });
      t.b.update(() => {
        $setState($block([0]), lineState, 'B');
        $setBlocksType($selectIn([1], 0), () => $createQuoteNode());
      });
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read(() => $getState($block([1]), objState))).toEqual({
        x: 1,
        y: [1, 2],
      });
      // remove
      t.a.update(() => $setState($block([0]), lineState, ''));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.b.read(() => $getState($block([0]), lineState))).toBe('');
    });
  }
  test('NodeState on a list item and a ListNode (group)', async () => {
    const t = await setup(() =>
      $getRoot().append($createListNode('bullet').append($li('a'), $li('b'))),
    );
    t.a.update(() => {
      $setState($block([0, 0]), lineState, 'item');
      $setState($block([0]), lineState, 'group');
    });
    await t.sync();
    await expectConverged(t.peers);
  });
  test('NodeState carried by a split', async () => {
    const t = await setup(() => $getRoot().append($p('Hello world')));
    t.a.update(() => $setState($block([0]), lineState, 'X'));
    await t.sync();
    t.a.update(() => $selectIn([0], 5).insertParagraph());
    await t.sync();
    await expectConverged(t.peers);
  });
});

describe('undo across peers', () => {
  for (const o of ORDERS) {
    test(`undo heading after peer changed it to quote ${o.ids} ${o.delivery}`, async () => {
      const t = await setup(() => $getRoot().append($p('Title')), o);
      t.a.update(() =>
        $setBlocksType($selectIn([0], 0), () => $createHeadingNode('h1')),
      );
      await t.sync();
      t.b.update(() =>
        $setBlocksType($selectIn([0], 0), () => $createQuoteNode()),
      );
      await t.sync();
      t.a.undo();
      await t.sync();
      await expectConverged(t.peers);
    });
    test(`undo Enter while peer typed in both halves offline ${o.ids} ${o.delivery}`, async () => {
      const t = await setup(() => $getRoot().append($p('Hello world')), o);
      t.a.update(() => $selectIn([0], 5).insertParagraph());
      await t.sync();
      t.offline();
      t.b.update(() => $selectIn([0], 5).insertText('B1'));
      t.b.update(() => $selectIn([1], 6).insertText('B2'));
      t.a.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toContain('B1');
      expect(t.a.describe()).toContain('B2');
      t.a.binding.redo();
      await t.sync();
      await expectConverged(t.peers);
    });
    test(`undo paste of 3 lines while peer typed in middle line ${o.ids} ${o.delivery}`, async () => {
      const t = await setup(() => $getRoot().append($p('top')), o);
      t.a.update(() => $getRoot().append($p('l1'), $p('l2'), $p('l3')));
      await t.sync();
      t.offline();
      t.b.update(() => $selectIn([2], 2).insertText('BB'));
      t.a.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toContain('BB');
    });
    test(`undo indent while peer outdented/changed list type ${o.ids} ${o.delivery}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createListNode('bullet').append(
              $li('one'),
              $li('two'),
              $li('three'),
            ),
          ),
        o,
      );
      t.a.update(() => ($block([0, 1]) as ListItemNode).setIndent(1));
      await t.sync();
      t.offline();
      t.b.update(() => ($block([0, 2]) as ListItemNode).setIndent(1));
      t.a.undo();
      await t.sync();
      await expectConverged(t.peers);
    });
    test(`undo of B's typing by B after A deleted the line ${o.ids} ${o.delivery}`, async () => {
      const t = await setup(
        () => $getRoot().append($p('one'), $p('two'), $p('three')),
        o,
      );
      t.b.update(() => $selectIn([1], 3).insertText('XX'));
      await t.sync();
      t.offline();
      t.a.update(() => $block([1]).remove());
      t.b.update(() => $selectIn([1], 5).insertText('YY'));
      await t.sync();
      t.b.undo();
      await t.sync();
      await expectConverged(t.peers);
      t.b.undo();
      await t.sync();
      await expectConverged(t.peers);
      t.b.binding.redo();
      t.b.binding.redo();
      await t.sync();
      await expectConverged(t.peers);
    });
  }
});

describe('text edge chars', () => {
  test('text containing pilcrow, broken bar, U+2029, U+2028, NUL', async () => {
    const t = await setup(() =>
      $getRoot().append($p('a¶b¦c\u2029d\u2028e\u0000f')),
    );
    t.b.update(() => $selectIn([0], 2).insertText('¶'));
    await t.sync();
    await expectConverged(t.peers);
  });
});

describe('document settings', () => {
  test('the binding records moves and text edits while it is bound, then restores each flag', () => {
    for (const moves of [false, true]) {
      for (const edits of [false, true]) {
        const editor = mkEditor([]);
        editor._recordNodeMoves = moves;
        editor._recordTextEdits = edits;
        const b = new YBinding(editor, createYDoc(), {
          schemaVersion: 1,
          selfCheck: true,
        });
        const stop = b.start();
        expect(editor._recordNodeMoves).toBe(true);
        expect(editor._recordTextEdits).toBe(true);
        stop();
        b.dispose();
        expect(editor._recordNodeMoves).toBe(moves);
        expect(editor._recordTextEdits).toBe(edits);
      }
    }
  });

  test('the binding leaves the document formatting cleanup alone', () => {
    const doc = createYDoc();
    const before = doc.cleanupFormatting;
    const b = new YBinding(mkEditor([]), doc, {
      schemaVersion: 1,
      selfCheck: true,
    });
    const stop = b.start();
    expect(doc.cleanupFormatting).toBe(before);
    stop();
    expect(doc.cleanupFormatting).toBe(before);
  });
});
