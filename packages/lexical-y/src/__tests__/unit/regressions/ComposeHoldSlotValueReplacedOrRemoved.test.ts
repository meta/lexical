/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes `abc` in a slot's paragraph (a host paragraph's `title`
// slot); B types R in it, which A's hold keeps back. A replaces the slot's
// value: a new paragraph, the old one's children moved into it. The old
// value's shared node would be replaced in the host's slot map (not
// deleted through the sequence), which deletes it and R with it, so the
// replacement is refused: R stays in the slot on every peer and a fresh
// reader, with one warning. A's removal of the slot (on purpose) deletes R
// with it, with no warning, as main deletes what A removes.

import {
  $create,
  $createParagraphNode,
  $getRoot,
  $getSlot,
  $removeSlot,
  $setSelection,
  $setSlot,
  ParagraphNode,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  composing,
  GCS,
  held,
  ORDERS,
  refused,
  settled,
} from '../../utils/composeHold';
import {freshReader, type Peer} from '../../utils/harness';

class SlotHost extends ParagraphNode {
  $config() {
    return this.config('hold_slot_host', {
      extends: ParagraphNode,
      slots: ['title'],
    });
  }
}

class SlotText extends TextNode {
  $config() {
    return this.config('hold_slot_text', {extends: TextNode});
  }
}

const $host = () => $getRoot().getFirstChildOrThrow() as SlotHost;

/** The text of `peer`'s document, the slot's included (describe omits it). */
const textOf = (peer: Peer) =>
  peer.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => n.getTextContent())
      .join(''),
  );

/** Every peer and a fresh reader hold `text`. */
async function everywhere(
  t: Awaited<ReturnType<typeof composing>>,
  text: string,
) {
  const fresh = await freshReader(t.a);
  try {
    for (const peer of [...t.peers, fresh]) {
      expect(textOf(peer)).toBe(text);
    }
  } finally {
    fresh.stop();
  }
}

describe("a slot's value replaced or removed under a hold", () => {
  for (const gc of GCS) {
    for (const ids of ORDERS) {
      const id = `(gc ${gc ? 'on' : 'off'}, ids ${ids})`;
      const start = async () => {
        const t = await composing(
          () => {
            $getRoot().append(
              $setSlot(
                $create(SlotHost),
                'title',
                $createParagraphNode().append(
                  $create(SlotText).setTextContent('abc'),
                ),
              ),
            );
          },
          gc,
          ids,
          undefined,
          [SlotHost, SlotText],
        );
        // The host holds inline content and declares slots: stored as a
        // nested node, which the binding reports once (not this cell's
        // subject).
        expect(t.a.warnings).toHaveLength(1);
        t.a.warnings.length = 0;
        await held(t, () => {
          $getRoot()
            .getAllTextNodes()
            .find(n => n instanceof SlotText)!
            .spliceText(1, 0, 'R');
        });
        return t;
      };
      test(`replacing the slot's paragraph, its text moved into the new one, is refused: R stays in the slot ${id}`, async () => {
        const t = await start();
        t.a.update(() => {
          const slot = $getSlot($host(), 'title') as ParagraphNode;
          $setSlot(
            $host(),
            'title',
            $createParagraphNode().append(...slot.getChildren()),
          );
        });
        await t.sync();
        refused(t);
        await settled(t);
        await everywhere(t, 'aRbc');
      });
      test(`removing the slot is refused: R and the composed text stay ${id}`, async () => {
        const t = await start();
        t.a.update(() => {
          // (The composed text goes: no selection is left in it.)
          $setSelection(null);
          $removeSlot($host(), 'title');
        });
        await t.sync();
        refused(t);
        await settled(t);
        await everywhere(t, 'aRbc');
      });
    }
  }
});
