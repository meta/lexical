/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes `abc` in an inline container in a list item; B types R in it,
// which A's hold keeps back (main has no hold: A shows R). Then B types S
// at the end of the same text, in the old container, while A moves the
// item to the end of its list, at one of four timings:
// - offline: every peer offline; B types S; A moves; they sync.
// - delivered before commit: S reaches A's document inside A's update,
//   after the move, before that update commits.
// - deferred: S reaches A's document while A's binding writes the move.
// - after commit: A's move would reach C, not B; B (not having seen it)
//   types S; they sync.
// Writing the move would delete R, which A's hold keeps back, with the old
// container, so it is refused at every timing (one warning): nothing
// moves, and R and S stay where B typed them on every peer and a fresh
// reader.
//
// Main be882d11, this file unchanged (both gc settings, both id orders):
// R is lost at all four timings (A's hold keeps R back and the move
// deletes it with the old container), and S is lost at all four
// (MAIN_KEEPS_S): a copy is not an alias, and an edit to a deleted
// container is lost (Yjs's limit).

import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  $setCompositionKey,
  $setSelection,
  ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {freshReader, NODES, type Peer, setup} from '../../utils/harness';

class TimingBox extends ElementNode {
  $config() {
    return this.config('hold_timing_box', {
      children: 'inline',
      extends: ElementNode,
    });
  }
  isInline(): true {
    return true;
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM(): false {
    return false;
  }
}

const TIMINGS = [
  'offline',
  'delivered before commit',
  'deferred',
  'after commit',
] as const;
type Timing = (typeof TIMINGS)[number];

/** Main be882d11: whether B's S survives A's move, per timing. */
const MAIN_KEEPS_S: Record<Timing, boolean> = {
  'after commit': false,
  deferred: false,
  'delivered before commit': false,
  offline: false,
};

const $composed = (): TextNode =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n.getTextContent().includes('bc'))!;

const $move = () => {
  const list = $getRoot().getFirstChildOrThrow() as ListNode;
  list.append(list.getFirstChildOrThrow() as ListItemNode);
};

/** B's typing of S at the end of the composed text. */
const typeS = (b: Peer) =>
  b.update(() => {
    const n = $composed();
    n.spliceText(n.getTextContentSize(), 0, 'S');
    $setSelection(null);
  });

/** Takes A's undelivered updates from `from`, merged. */
function take(a: Peer, from: Peer): Uint8Array {
  const list = a.pending.get(from)!;
  a.pending.delete(from);
  return Y.mergeUpdates(list as Uint8Array<ArrayBuffer>[]);
}

const holding = (a: Peer): boolean => {
  const state = (a.binding as unknown as {state?: {hidden?: unknown}}).state;
  return state !== undefined && state.hidden != null;
};

async function run(timing: Timing, gc: boolean, ids: number[]) {
  const t = await setup(
    () => {
      $getRoot().append(
        $createListNode('number').append(
          $createListItemNode().append(
            $create(TimingBox).append($createTextNode('abc')),
          ),
          $createListItemNode().append($createTextNode('tail')),
        ),
        $createParagraphNode().append($createTextNode('separator')),
      );
    },
    {gc, ids, nodes: [...NODES, TimingBox]},
  );
  const [a, b] = t.peers;
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  a.editor.setRootElement(host);
  host.focus();
  onTestFinished(() => {
    a.editor.setRootElement(null);
    host.remove();
    t.peers.forEach(p => p.stop());
  });
  a.update(() => {
    const n = $composed();
    n.select(1, 1);
    $setCompositionKey(n.getKey());
  });
  await t.sync();
  b.update(() => {
    $composed().spliceText(1, 0, 'R');
    $setSelection(null);
  });
  await t.sync();
  const held = holding(a);
  if (timing === 'offline') {
    t.offline();
    typeS(b);
    a.update($move);
  } else if (timing === 'delivered before commit') {
    b.online = false;
    typeS(b);
    const s = take(a, b);
    a.update(() => {
      $move();
      Y.applyUpdate(a.doc, s, a.net);
    });
  } else if (timing === 'deferred') {
    b.online = false;
    typeS(b);
    const s = take(a, b);
    let delivered = false;
    const deliver = (tr: Y.Transaction) => {
      if (!delivered && tr.local) {
        delivered = true;
        Y.applyUpdate(a.doc, s, a.net);
      }
    };
    a.doc.on('afterTransaction', deliver);
    a.update($move);
    a.doc.off('afterTransaction', deliver);
    if (!delivered) {
      // No write to deliver it in: the move was refused before writing.
      Y.applyUpdate(a.doc, s, a.net);
    }
  } else {
    b.online = false;
    a.update($move);
    typeS(b);
  }
  await t.sync();
  a.update(() => $setCompositionKey(null));
  await t.sync();
  const fresh = await freshReader(a);
  onTestFinished(() => fresh.stop());
  const shown = a.describe();
  for (const p of t.peers) {
    expect(p.describe()).toBe(shown);
  }
  expect(fresh.describe()).toBe(shown);
  const text = a.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => n.getTextContent())
      .join('|'),
  );
  return {held, shown, text, warnings: [...a.warnings]};
}

/** The message of the warning a refused relocation raises. */
const REFUSAL = /would delete or leave behind text a collaborator wrote/;

describe("A's move under a hold, with B's new edit to the old container, at four timings", () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const timing of TIMINGS) {
        const id = `(${timing}, gc ${gc ? 'on' : 'off'}, ids ${ids})`;
        test(`the move is refused: R and S stay where B typed them ${id}`, async () => {
          const {held, shown, text, warnings} = await run(timing, gc, ids);
          expect(held).toBe(true);
          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toMatch(REFUSAL);
          expect(text).toBe('aRbcS|tail|separator');
          expect(shown).toBe(
            'list[number](listitem(hold_timing_box("aRbcS")) listitem("tail")) / paragraph("separator")',
          );
        });
        if (timing === 'delivered before commit') {
          // S is in A's document before A's write, and A's binding reads it
          // only after that update; main's write then deletes the old
          // container with S in it.
          test(`text a collaborator added to the old container, received but not yet read, is kept: the move is refused (main loses it) (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
            const {text} = await run(timing, gc, ids);
            expect(MAIN_KEEPS_S[timing]).toBe(false);
            expect(text).toContain('S');
          });
        }
      }
    }
  }
});
