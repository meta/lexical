/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

import {
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  configExtension,
  defineExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $setState,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding, YCollabExtension} from '../..';

// The follow-up check (YBinding#$checkFollowUp) reads only the part of a
// container the follow-up changed, after walking the container up to it:
// followUpRanges finds the follow-up's unit with units.indexOf, and
// formatsAt walks the container's items from its start. So its cost grows
// with the follow-up's position, not with the rest of the document. A
// follow-up after each keystroke (BlockIdExtension's naming path) at the
// same block of a document ten times longer costs about the same, while a
// check that read the whole container would cost about ten times as much.
// The two documents are measured in turns, after a warm-up, and compared by
// their medians, so a burst of load or a cold first check lands on both.
// Comparing the same block of both cancels a cost that grows with the
// follow-up's position, so the last block of the larger document is
// measured in the same turns too, against a generous absolute ceiling: a
// check that walks every unit before the follow-up's costs tens of
// milliseconds there.

/** Median ceiling for the check at the larger document's last block. */
const END_CEILING_MS = 20;

const BLOCKS = 10000;
const SMALL = 1000;
const WARM = 10;
const KEYS = 60;

type Check = (this: YBinding, ...args: unknown[]) => void;
const proto = YBinding.prototype as unknown as {$checkFollowUp: Check};
const original = proto.$checkFollowUp;

function build(blocks: number): LexicalEditor {
  const doc = createYDoc();
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        configExtension(YCollabExtension, {doc, schemaVersion: 1}),
        BlockIdExtension,
      ],
      name: '@lexical/y/test/follow-up-cost',
      namespace: 'follow-up-cost',
      onError: e => {
        throw e;
      },
    }),
  );
  const {binding} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  editor.update(
    () => {
      const root = $getRoot().clear();
      for (let i = 0; i < blocks; i++) {
        root.append(
          $createParagraphNode().append($createTextNode(`line ${i} of text`)),
        );
      }
    },
    {discrete: true},
  );
  binding.initialize();
  return editor;
}

/**
 * A keystroke (a character typed at the end of block `at`), then a
 * follow-up that renames that block, as BlockIdExtension's naming update
 * does: tagged as it, in an update of its own.
 */
function keystroke(
  editor: LexicalEditor,
  at: number,
  k: number,
  name = `renamed-${k}`,
): void {
  editor.update(
    () => {
      const line = $getRoot().getChildAtIndex(at) as ElementNode;
      line.selectEnd().insertText('x');
    },
    {discrete: true},
  );
  editor.update(
    () => {
      $setState($getRoot().getChildAtIndex(at)!, blockIdState, name);
    },
    {discrete: true, tag: 'block-id-repair'},
  );
}

const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[xs.length >> 1];

describe('the follow-up check in a long document', () => {
  // The last block of the smaller document, and its middle.
  for (const [where, at] of [
    ['end', SMALL - 1],
    ['middle', SMALL / 2],
  ] as const) {
    test(`${KEYS} keystrokes at block ${at} of a ${BLOCKS}- and a ${SMALL}-block document (the smaller one's ${where}), each followed by a naming update: the check costs the same in both`, () => {
      const big = build(BLOCKS);
      const small = build(SMALL);
      // The time of each check, into the list of the document typed in.
      let into: number[] | null = null;
      let checks = 0;
      proto.$checkFollowUp = function (this: YBinding, ...args: unknown[]) {
        checks++;
        const t0 = performance.now();
        original.apply(this, args);
        if (into !== null) {
          into.push(performance.now() - t0);
        }
      };
      const bigMs: number[] = [];
      const smallMs: number[] = [];
      const endMs: number[] = [];
      try {
        for (let k = 0; k < WARM + KEYS; k++) {
          into = k < WARM ? null : bigMs;
          keystroke(big, at, k);
          into = k < WARM ? null : smallMs;
          keystroke(small, at, k);
          into = k < WARM ? null : endMs;
          keystroke(big, BLOCKS - 1, k, `end-${k}`);
        }
      } finally {
        proto.$checkFollowUp = original;
      }
      // Every rename was written (none read again).
      const stored = (editor: LexicalEditor, index = at) =>
        editor.read(() =>
          $getState($getRoot().getChildAtIndex(index)!, blockIdState),
        );
      const last = `renamed-${WARM + KEYS - 1}`;
      expect(stored(big)).toBe(last);
      expect(stored(small)).toBe(last);
      expect(stored(big, BLOCKS - 1)).toBe(`end-${WARM + KEYS - 1}`);
      (big as LexicalEditor & {dispose: () => void}).dispose();
      (small as LexicalEditor & {dispose: () => void}).dispose();
      expect(checks).toBe(3 * (WARM + KEYS));
      const b = median(bigMs);
      const m = median(smallMs);
      const e = median(endMs);
      // eslint-disable-next-line no-console
      console.log(
        `FOLLOWUP_COST ${where}: median check ${b.toFixed(3)} ms in ${BLOCKS} blocks, ${m.toFixed(3)} ms in ${SMALL} blocks (${(b / m).toFixed(2)}x); ${e.toFixed(3)} ms at block ${BLOCKS - 1}`,
      );
      // About the same in both; a check reading the whole container would
      // cost about ten times as much in the larger document.
      expect(b).toBeLessThan(3 * m + 0.1);
      // At the end of the larger document, well under the ceiling.
      expect(e).toBeLessThan(END_CEILING_MS);
    }, 120000);
  }
});
