/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// NodeState named with U+001F is covered (paired runs), and its ordinary
// JSON values stay supported: an app's numeric-array state is never taken
// for an end. A paired write used to leave out any such value of an end's
// shape ([1]), so setting `numeric\u001fstate` to [1] in a layout 3
// document was discarded: existing and fresh readers kept [2] and the
// self-check warned. What a paired write
// leaves out is now decided by provenance: only values a read took from
// end items with the plain fold (State.strayEntries).

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
import {expect, test} from 'vitest';

import {
  $selectIn,
  expectConverged,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';

const numeric = createState('numeric\u001fstate', {
  parse: (v: unknown) =>
    Array.isArray(v) && v.every(x => typeof x === 'number')
      ? (v as number[])
      : [],
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
      .map(n => [n.getTextContent(), $getState(n, numeric)]),
  );

for (const gc of [false, true]) {
  for (const already of [false, true]) {
    test(`a numeric array NodeState under a U+001F name is written in a layout 3 document (${already ? 'already layout 3' : 'upgraded by bolding'}, gc ${gc ? 'on' : 'off'})`, async () => {
      const t = await setup(
        () => {
          const ab = $createTextNode('ab');
          $setState(ab, numeric, [2]);
          $getRoot().append($createParagraphNode().append(ab));
          if (already) {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('cd')),
            );
          }
        },
        {gc, prepare},
      );
      if (already) {
        // A first paired write records layout 3.
        t.b.update(() => {
          $selectIn([1], 0, 2).formatText('italic');
          $setSelection(null);
        });
        await t.sync();
      }
      // A upgrades (or writes paired runs) by bolding "ab".
      t.a.update(() => {
        $selectIn([0], 0, 2).formatText('bold');
        $setSelection(null);
      });
      await t.sync();
      expect(t.a.doc.get('lexical-y').getAttr('lexical-y:4')).toBe(true);
      // The next write is a paired run too.
      t.a.update(() => {
        const ab = $getRoot().getAllTextNodes()[0] as TextNode;
        $setState(ab, numeric, [1]);
      });
      await t.sync();
      const fresh = await freshReader(t.a);
      for (const peer of [t.a, t.b, fresh]) {
        expect(values(peer)[0]).toEqual(['ab', [1]]);
      }
      expect(t.a.warnings.filter(w => w.includes('self-check'))).toEqual([]);
      await expectConverged([...t.peers, fresh]);
    });
  }
}
