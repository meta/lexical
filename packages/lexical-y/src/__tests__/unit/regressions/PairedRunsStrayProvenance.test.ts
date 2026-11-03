/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// GPT code review r3, MUST 1 (written for values a plain fold read from end
// items before the layout 3 record arrived), kept as behaviour: a
// StateConfig that canonicalizes its values to shared frozen singletons
// gives two nodes the very same object; read by identity syntax before the
// writer's record, no end shows as a value on "x", and a paired write
// elsewhere keeps `b`'s legitimate [1] on every reader, with a silent
// self-check.

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $getWritableNodeState,
  $isTextNode,
  $setSelection,
  $setState,
  createState,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {
  $selectIn,
  expectConverged,
  flush,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';
import {
  setFormatIdentityWrites,
  setFormatIdentityWritesDefault,
} from '../../utils/noSwitch';

afterEach(() => {
  setFormatIdentityWritesDefault(false);
});

const ONE: readonly number[] = Object.freeze([1]);
const TWO: readonly number[] = Object.freeze([2]);
const EMPTY: readonly number[] = Object.freeze([]);
const numeric = createState('numeric\u001fstate', {
  parse: (v: unknown) =>
    Array.isArray(v) && v.length === 1 && v[0] === 1
      ? ONE
      : Array.isArray(v) && v.length === 1 && v[0] === 2
        ? TWO
        : EMPTY,
});

function prepare(editor: LexicalEditor): void {
  editor.update(
    () => {
      for (const node of [$createTextNode(), $createParagraphNode()]) {
        $getWritableNodeState(node);
        $getState(node, numeric);
      }
    },
    {discrete: true},
  );
}

const values = (peer: Peer) =>
  peer.read(() =>
    $getRoot()
      .getAllTextNodes()
      .filter($isTextNode)
      .map(n => [n.getTextContent(), [...$getState(n, numeric)]]),
  );

for (const gc of [false, true]) {
  test(`a canonical value two nodes share is kept where the client changed nothing, before the writer's record (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(
      () => {
        const ax = $createTextNode('ax');
        $setState(ax, numeric, TWO);
        const b = $createTextNode('b');
        $setState(b, numeric, ONE);
        $getRoot().append(
          $createParagraphNode().append(ax),
          $createParagraphNode().append(b),
          $createParagraphNode().append($createTextNode('q')),
        );
      },
      {delivery: 'sender', gc, prepare},
    );
    const [a, b] = t.peers;
    setFormatIdentityWrites(b.doc, true);
    // B's first paired write records layout 3; its second writes a paired
    // run of the state over "a" (its end, B's next item, is [1]).
    b.update(() => {
      $selectIn([2], 0, 1).formatText('italic');
      $setSelection(null);
    });
    b.update(() => {
      const ax = $getRoot().getAllTextNodes()[0] as TextNode;
      const [first] = ax.splitText(1);
      $setState(first, numeric, EMPTY);
      $setSelection(null);
    });
    const sent = a.pending.get(b) ?? [];
    a.pending.delete(b);
    Y.applyUpdate(a.doc, sent[sent.length - 1], a.net);
    await flush();
    // Read by syntax before the record: "x" shows the paired [2], never the
    // end's [1].
    expect(values(a)[1]).toEqual(['x', [2]]);
    // A upgrades by bolding "b".
    setFormatIdentityWrites(a.doc, true);
    a.update(() => {
      $selectIn([1], 0, 1).formatText('bold');
      $setSelection(null);
    });
    for (const u of sent.slice(0, -1)) {
      Y.applyUpdate(a.doc, u, a.net);
    }
    await t.sync();
    const fresh = await freshReader(a);
    for (const peer of [a, b, fresh]) {
      expect(values(peer).find(r => r[0] === 'b')).toEqual(['b', [1]]);
    }
    expect(a.warnings.filter(w => w.includes('self-check'))).toEqual([]);
    await expectConverged([...t.peers, fresh]);
  });
}
