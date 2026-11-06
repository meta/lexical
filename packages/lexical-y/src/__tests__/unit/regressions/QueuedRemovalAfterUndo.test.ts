/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$addMarkID, $getNodeMarkIDs, $removeMarkID} from '@lexical/mark';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setSelection,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$selectIn, freshReader, type Peer, setup} from '../../utils/harness';
import {prepareMarkState as prepare} from '../../utils/sizeOps';

/*
 * #9719: B gives "bcde" of "abcdef" a value; A removes it from "bc" while B
 * undoes it. However A's removal reaches the document (written before the
 * undo arrived, written from the editor's view while the undo is still
 * unread, or offline), every client ends with the same document, and the
 * value never reaches "f", which nobody gave it. (What stays on "de" is
 * D64 / #9560, the same in all three.)
 */

type Value = 'bold' | 'bold, by node' | 'typed plain text' | 'comment';
type Timing = 'committed' | 'queued' | 'offline';

const TEXT = 'abcdef';

function $hasValue(value: Value, node: TextNode): boolean {
  return value === 'comment'
    ? $getNodeMarkIDs(node).includes('c1')
    : node.hasFormat('bold');
}

/** Per character: whether it shows the value. */
function marked(peer: Peer, value: Value): string {
  return peer.read(() => {
    let out = '';
    for (const node of $getRoot().getAllTextNodes()) {
      if ($isTextNode(node)) {
        out += node
          .getTextContent()
          .replace(/./gu, $hasValue(value, node) ? '1' : '0');
      }
    }
    return out;
  });
}

async function run(value: Value, timing: Timing, gc: boolean, ids: number[]) {
  const t = await setup(
    () =>
      $getRoot().append($createParagraphNode().append($createTextNode(TEXT))),
    {gc, ids, prepare},
  );
  t.b.update(() => {
    const selection = $selectIn([0], 1, 5);
    if (value === 'comment') {
      $addMarkID('c1', selection);
    } else {
      selection.formatText('bold');
    }
    $setSelection(null);
  });
  await t.sync();
  expect(marked(t.a, value)).toBe('011110');
  t.a.binding.undoManager!.stopCapturing();
  if (timing === 'offline') {
    t.offline();
  }
  const $remove = () => {
    const selection = $selectIn([0], 1, 3);
    if (value === 'bold') {
      selection.formatText('bold');
    } else if (value === 'typed plain text') {
      // bold off at a caret after "c", then type
      const caret = $selectIn([0], 3, 3);
      caret.format = 0;
      caret.insertText('X');
    } else if (value === 'bold, by node') {
      // as an app that sets the text nodes' format directly
      for (const node of selection.extract()) {
        if ($isTextNode(node)) {
          node.setFormat(0);
        }
      }
    } else {
      $removeMarkID('c1', selection);
    }
    $setSelection(null);
  };
  if (timing === 'queued') {
    // A normal update: it commits after B's undo has reached A's document,
    // and is written from what A's editor showed (the undo still unread).
    t.a.editor.update($remove);
    // still pending: the editor shows the run whole
    expect(marked(t.a, value)).toBe('011110');
  } else {
    t.a.editor.update($remove, {discrete: true});
  }
  t.b.undo();
  await t.sync();
  const fresh = await freshReader(t.a);
  const shown = [t.a, t.b, fresh].map(peer => marked(peer, value));
  fresh.stop();
  return shown;
}

for (const gc of [false, true]) {
  describe(`a removal over part of a run its author undoes (#9719, gc ${gc ? 'on' : 'off'})`, () => {
    for (const value of [
      'bold',
      'bold, by node',
      'typed plain text',
      'comment',
    ] as Value[]) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        test(`${value}: the removal's timing does not change the result, and the value never reaches the text after the run (ids ${ids})`, async () => {
          const results: Record<Timing, string[]> = {
            committed: await run(value, 'committed', gc, ids),
            offline: await run(value, 'offline', gc, ids),
            queued: await run(value, 'queued', gc, ids),
          };
          for (const timing of ['committed', 'offline', 'queued'] as Timing[]) {
            const [a, b, fresh] = results[timing];
            // converged, and equal to a fresh read
            expect({b, fresh, timing}).toEqual({b: a, fresh: a, timing});
            // "f" was never given the value
            expect({f: a[a.length - 1], timing}).toEqual({f: '0', timing});
          }
          expect(results.queued[0]).toBe(results.committed[0]);
          expect(results.offline[0]).toBe(results.committed[0]);
        });
      }
    }
  });
}
