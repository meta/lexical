/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// NodeState on text in a quote that holds paragraphs (a flat value and a set
// of ids on the same text, as an extension that anchors comments stores
// them; see ../utils/textStateQuote): a stated run inside one paragraph of
// the quote, one across both its paragraphs, and one from a root paragraph
// into the quote. A peer splits the stated text (Enter) while another types
// in it after the caret, or joins the quote's paragraphs (Backspace at the
// second's start) while another types in the second. Every peer and a fresh
// reader show what one editor shows after the same edits made one after
// another (the typing first): every character with the same NodeState,
// in the same paragraph. With and without block ids, gc off and on.

import {$getRoot, $isElementNode, type LexicalNode} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $selectIn,
  expectConverged,
  freshReader,
  type Peer,
  setup,
} from '../utils/harness';
import {TEXT_STATE_DOCS, type TextStateDoc} from '../utils/textStateQuote';

/**
 * Each block's text runs with their NodeState, block ids left out (each
 * editor names its own blocks; expectConverged compares them between peers).
 */
function runs(peer: Peer): unknown {
  const of = (node: LexicalNode): unknown => {
    const json = node.exportJSON() as {$?: Record<string, unknown>};
    const state = {...json.$};
    delete state.blockId;
    if ($isElementNode(node)) {
      return [node.getType(), node.getChildren().map(of)];
    }
    return [node.getTextContent(), state];
  };
  return peer.read(() => $getRoot().getChildren().map(of));
}

type Edit = {
  name: string;
  $edit: (doc: TextStateDoc) => void;
  /** The same edit made after the typing (by one editor). */
  $editAfterTyping: (doc: TextStateDoc) => void;
  $type: (doc: TextStateDoc) => void;
};

const TYPED = 'XY';

const EDITS: readonly Edit[] = [
  {
    $edit: d => {
      $selectIn(d.first, d.split).insertParagraph();
    },
    $editAfterTyping: d => {
      $selectIn(d.first, d.split).insertParagraph();
    },
    $type: d => {
      $selectIn(d.first, d.typeAfterSplit).insertText(TYPED);
    },
    name: 'Enter in the stated text ‖ typing after the caret',
  },
  {
    $edit: d => {
      $selectIn(d.second, 0).deleteCharacter(true);
    },
    $editAfterTyping: d => {
      $selectIn(d.second, 0).deleteCharacter(true);
    },
    $type: d => {
      $selectIn(d.second, d.typeInSecond).insertText(TYPED);
    },
    name: "Backspace at the second paragraph's start ‖ typing in it",
  },
];

describe('NodeState on text in a quote that holds paragraphs ‖ a split or a join', () => {
  for (const withBlockIds of [false, true]) {
    for (const gc of [false, true]) {
      for (const doc of TEXT_STATE_DOCS) {
        for (const edit of EDITS) {
          test(`${doc.name}: ${edit.name} (block ids ${withBlockIds ? 'on' : 'off'}, gc ${gc ? 'on' : 'off'})`, async () => {
            const oracle = await setup(doc.$init, {
              gc,
              ids: [9],
              withBlockIds,
            });
            oracle.a.update(() => edit.$type(doc));
            oracle.a.update(() => edit.$editAfterTyping(doc));
            const t = await setup(doc.$init, {gc, withBlockIds});
            t.offline();
            t.a.update(() => edit.$edit(doc));
            t.b.update(() => edit.$type(doc));
            await t.sync();
            await expectConverged(t.peers);
            const fresh = await freshReader(t.a);
            for (const peer of [...t.peers, fresh]) {
              expect(runs(peer)).toEqual(runs(oracle.a));
            }
          });
        }
      }
    }
  }
});
