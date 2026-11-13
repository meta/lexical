/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A composes in a line; B types into that line, which the composer's hold
// keeps back from A (see Hidden); the update that ends A's composition sets
// a flat NodeState value (`s:<key>`) on the whole line. B's text, typed at
// the line's start or inside it, takes the value, as it did when layout 3
// wrote flat NodeState as a plain value (main): a flat NodeState run covers
// held content inside its range or right before its first
// content (Cursor#format), and stops at the range's end: text held right
// after it stays without the value. Text formats keep their own rule (held
// content is left out of the run), unchanged from main.

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $setCompositionKey,
  $setSelection,
  $setState,
  createState,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {expectConverged, freshReader, setup} from '../../utils/harness';

const note = createState('note', {
  parse: v => (typeof v === 'string' ? v : ''),
});

/** Each character of the first line with its note ("c:note"). */
const $notes = () =>
  ($getRoot().getFirstChildOrThrow() as ElementNode)
    .getChildren()
    .flatMap(n =>
      [...(n as TextNode).getTextContent()].map(
        ch => `${ch}:${$getState(n as TextNode, note)}`,
      ),
    )
    .join(' ');

for (const gc of [false, true]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    for (const [where, offset] of [
      ['at the start of', 0],
      ['inside', 2],
    ] as const) {
      test(`text a collaborator typed ${where} a held line takes the NodeState value the composition-ending update gives the line (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('see')),
            );
          },
          {gc, ids},
        );
        const {a, b} = t;
        a.update(() => {
          const n = $getRoot().getAllTextNodes()[0];
          n.select(3, 3);
          $setCompositionKey(n.getKey());
        });
        await t.sync();
        b.update(() => {
          $getRoot().getAllTextNodes()[0].spliceText(offset, 0, 'BB');
          $setSelection(null);
        });
        await t.sync();
        // Held from A while it composes.
        expect(
          (a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
        ).not.toBeNull();
        a.update(() => {
          $setCompositionKey(null);
          for (const n of $getRoot().getAllTextNodes()) {
            $setState(n, note, 'N');
          }
          $setSelection(null);
        });
        await t.sync();
        expect(a.warnings.filter(w => /self-check|recovered/.test(w))).toEqual(
          [],
        );
        await expectConverged(t.peers);
        const want = [...(offset === 0 ? 'BBsee' : 'seBBe')]
          .map(ch => `${ch}:N`)
          .join(' ');
        for (const p of t.peers) {
          expect(p.read($notes)).toBe(want);
        }
        expect((await freshReader(a)).describe()).toBe(a.describe());
      });
    }

    test(`text a collaborator typed right after the part of a held line the ending update gives a value stays without it (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('see')),
          );
        },
        {gc, ids},
      );
      const {a, b} = t;
      a.update(() => {
        const n = $getRoot().getAllTextNodes()[0];
        n.select(3, 3);
        $setCompositionKey(n.getKey());
      });
      await t.sync();
      b.update(() => {
        $getRoot().getAllTextNodes()[0].spliceText(2, 0, 'BB');
        $setSelection(null);
      });
      await t.sync();
      // The value goes to "se" only: B's text, held right after it, is past
      // the range's end.
      a.update(() => {
        $setCompositionKey(null);
        const [se] = $getRoot().getAllTextNodes()[0].splitText(2);
        $setState(se, note, 'N');
        $setSelection(null);
      });
      await t.sync();
      await expectConverged(t.peers);
      for (const p of t.peers) {
        expect(p.read($notes)).toBe('s:N e:N B: B: e:');
      }
      expect((await freshReader(a)).describe()).toBe(a.describe());
    });
  }
}
