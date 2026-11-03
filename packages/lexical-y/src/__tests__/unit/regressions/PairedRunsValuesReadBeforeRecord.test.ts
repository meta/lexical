/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Written for values a plain fold read from
// end items before the layout 3 record arrived), kept as behaviour: read by
// identity syntax before the writer's record, no end shows as a value, and
// what an app does with the values the client shows is stored as it shows
// them (switch off = main):
// 1. an app assigning x's value to b makes it b's state;
// 2. a canonicalizing StateConfig (parse to frozen singletons, unparse by
//    identity) keeps main's values, with paired writes off;
// 3. an explicit edit of the link the writer wrote (setURL) is kept.

import {$isLinkNode, $toggleLink, type LinkNode} from '@lexical/link';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
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
import {afterEach, beforeEach, expect, test} from 'vitest';

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

beforeEach(() => {
  setFormatIdentityWritesDefault(false);
});
afterEach(() => {
  setFormatIdentityWritesDefault(false);
});

const ONE: readonly number[] = Object.freeze([1]);
const TWO: readonly number[] = Object.freeze([2]);
const EMPTY: readonly number[] = Object.freeze([]);
const numeric = createState('numeric\u001fstate', {
  parse: (v: unknown) =>
    Array.isArray(v) && v[0] === 1
      ? ONE
      : Array.isArray(v) && v[0] === 2
        ? TWO
        : EMPTY,
  unparse: (v: readonly number[]) => (v === ONE ? [1] : v === TWO ? [2] : []),
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

const $text = (token: string) =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n.getTextContent() === token) as TextNode;

const values = (peer: Peer) =>
  peer.read(() =>
    $getRoot()
      .getAllTextNodes()
      .filter($isTextNode)
      .map(n => [n.getTextContent(), [...$getState(n, numeric)]]),
  );

/** B's first paired write records layout 3; its second is delivered alone to A. */
async function deliverSecondOnly(
  t: Awaited<ReturnType<typeof setup>>,
  second: () => void,
) {
  const [a, b] = t.peers;
  setFormatIdentityWrites(b.doc, true);
  b.update(() => {
    $selectIn([2], 0, 1).formatText('italic');
    $setSelection(null);
  });
  const first = (a.pending.get(b) ?? []).length;
  b.update(second);
  const sent = a.pending.get(b) ?? [];
  a.pending.delete(b);
  for (const u of sent.slice(first)) {
    Y.applyUpdate(a.doc, u, a.net);
  }
  await flush();
  return sent.slice(0, first);
}

async function finish(
  t: Awaited<ReturnType<typeof setup>>,
  sent: Uint8Array[],
) {
  const [a] = t.peers;
  for (const u of sent) {
    Y.applyUpdate(a.doc, u, a.net);
  }
  await t.sync();
  const fresh = await freshReader(a);
  await expectConverged([...t.peers, fresh]);
  return fresh;
}

const $seed = () => {
  const ax = $createTextNode('ax');
  $setState(ax, numeric, TWO);
  const b = $createTextNode('b');
  $setState(b, numeric, ONE);
  $getRoot().append(
    $createParagraphNode().append(ax),
    $createParagraphNode().append(b),
    $createParagraphNode().append($createTextNode('q')),
  );
};

for (const gc of [false, true]) {
  test(`an app assigning a value read before the record to another node stores it (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup($seed, {delivery: 'sender', gc, prepare});
    const [a] = t.peers;
    const sent = await deliverSecondOnly(t, () => {
      const [first] = $text('ax').splitText(1);
      $setState(first, numeric, EMPTY);
      $setSelection(null);
    });
    // Read by syntax: x shows the paired [2], never the end as [1].
    expect(values(a)[1]).toEqual(['x', [2]]);
    setFormatIdentityWrites(a.doc, true);
    a.update(() => {
      const b = $text('b');
      $setState(b, numeric, $getState($text('x'), numeric));
      $selectIn([1], 0, 1).formatText('bold');
      $setSelection(null);
    });
    const fresh = await finish(t, sent);
    for (const peer of [a, fresh]) {
      expect(values(peer).find(r => r[0] === 'b')).toEqual(['b', [2]]);
    }
    expect(a.warnings.filter(w => w.includes('self-check'))).toEqual([]);
  });

  test(`a canonicalizing state keeps main's values with paired writes off (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup($seed, {delivery: 'sender', gc, prepare});
    const [a] = t.peers;
    const sent = await deliverSecondOnly(t, () => {
      const [first] = $text('ax').splitText(1);
      $setState(first, numeric, EMPTY);
      $setSelection(null);
    });
    // x shows the parser's TWO (read by syntax); its export is [2], as on
    // main.
    const exported = () =>
      JSON.stringify(a.editor.getEditorState().toJSON()).includes(
        '"numeric\\u001fstate":[2]',
      );
    expect(a.read(() => $getState($text('x'), numeric))).toBe(TWO);
    expect(exported()).toBe(true);
    // Paired writes off on A: bold x.
    a.update(() => {
      const x = $text('x');
      x.select(0, 1).formatText('bold');
      $setSelection(null);
    });
    await flush();
    const reload = await freshReader(a);
    expect(values(reload).find(r => r[0] === 'x')?.[1]).toEqual(
      values(a).find(r => r[0] === 'x')?.[1],
    );
    void sent;
  });

  test(`an explicit edit of the link read before the record is kept (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('ax')),
          $createParagraphNode().append($createTextNode('b')),
          $createParagraphNode().append($createTextNode('q')),
        );
      },
      {delivery: 'sender', gc},
    );
    const [a] = t.peers;
    const sent = await deliverSecondOnly(t, () => {
      const n = $text('ax');
      const sel = $createRangeSelection();
      sel.anchor.set(n.getKey(), 0, 'text');
      sel.focus.set(n.getKey(), 1, 'text');
      $setSelection(sel);
      $toggleLink('https://old.example');
      $setSelection(null);
    });
    setFormatIdentityWrites(a.doc, true);
    // Read by syntax: the link on "a" only, no blank link on "x".
    const urlOf = (peer: Peer, token: string) =>
      peer.read(() => {
        const n = $getRoot()
          .getAllTextNodes()
          .find(m => m.getTextContent() === token)!;
        const p = n.getParent();
        return $isLinkNode(p) ? p.getURL() : null;
      });
    expect(urlOf(a, 'a')).toBe('https://old.example');
    expect(urlOf(a, 'x')).toBe(null);
    a.update(() => {
      const n = $getRoot()
        .getAllTextNodes()
        .find(m => m.getTextContent() === 'a')!;
      (n.getParent() as LinkNode).setURL('https://intended.example');
      $setSelection(null);
    });
    const fresh = await finish(t, sent);
    for (const peer of [a, fresh]) {
      expect(urlOf(peer, 'a')).toBe('https://intended.example');
      expect(urlOf(peer, 'x')).toBe(null);
    }
  });
}
