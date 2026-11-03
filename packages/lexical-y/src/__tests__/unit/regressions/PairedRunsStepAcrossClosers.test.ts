/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The positional units of format items (no "one write" inferred from
// clocks) grouped a run's closer with the next run's opener of the same key
// when they were next to each other: "abc" bold, italic and strikethrough,
// "def" strikethrough, seeded (pre-upgrade closers after "abc"). B typed
// plain "Z" after "abc": the step over the closers stopped before the
// strikethrough closer (its unit, the closer and "def"'s opener, does not
// give "no strikethrough"), so "Z" was written with a paired null run of its
// own; A typed "1" right before "Z", inside that run, and B's undo deleted
// it: "1" showed strikethrough (a randomized op-list oracle: 1,678 of 400,000 runs worse
// than before positional units). A unit now stops at a second item of a key
// it already has, as one write's items never repeat a key: "Z" goes past
// every closer with no item of its own, as before.

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setSelection,
  type TextFormatType,
  type TextNode,
} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {
  expectConverged,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';
import {setFormatIdentityWritesDefault} from '../../utils/noSwitch';

afterEach(() => {
  setFormatIdentityWritesDefault(false);
});

const WORDS: [string, TextFormatType[]][] = [
  ['abc', ['bold', 'italic', 'strikethrough']],
  ['def', ['strikethrough']],
  ['ghi', []],
  ['jkl', ['italic']],
];
const FORMATS: TextFormatType[] = ['bold', 'italic', 'strikethrough'];

/** Insert plain `text` as a node of its own right after "abc". */
function $typePlainAfterAbc(text: string) {
  const abc = $getRoot()
    .getAllTextNodes()
    .find(n => n.getTextContent().startsWith('abc')) as TextNode;
  const node = $createTextNode(text);
  if (abc.getTextContentSize() > 3) {
    abc.splitText(3)[0].insertAfter(node);
  } else {
    abc.insertAfter(node);
  }
  $setSelection(null);
}

/** Each character with its formats. */
const chars = (peer: Peer) =>
  peer.read(() =>
    $getRoot()
      .getAllTextNodes()
      .filter($isTextNode)
      .flatMap(n =>
        [...n.getTextContent()].map(
          ch => ch + ':' + FORMATS.filter(f => n.hasFormat(f)).join(','),
        ),
      )
      .join(' '),
  );

for (const gc of [false, true]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`text typed before plain text another client typed past seeded closers stays plain after that client's undo (ids ${ids}, gc ${gc ? 'on' : 'off'})`, async () => {
      setFormatIdentityWritesDefault(true);
      const t = await setup(
        () => {
          const p = $createParagraphNode();
          for (const [w, formats] of WORDS) {
            const n = $createTextNode(w);
            for (const f of formats) {
              n.toggleFormat(f);
            }
            p.append(n);
          }
          $getRoot().append(p);
        },
        {gc, ids},
      );
      const [a, b] = t.peers;
      b.update(() => $typePlainAfterAbc('Z'));
      b.binding.undoManager?.stopCapturing();
      await t.sync();
      a.update(() => $typePlainAfterAbc('1'));
      b.undo();
      await t.sync();
      const fresh = await freshReader(a);
      await expectConverged([...t.peers, fresh]);
      expect(chars(a)).toBe(
        'a:bold,italic,strikethrough b:bold,italic,strikethrough c:bold,italic,strikethrough 1: d:strikethrough e:strikethrough f:strikethrough g: h: i: j:italic k:italic l:italic',
      );
    });
  }
}
