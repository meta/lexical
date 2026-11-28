/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$addMarkID} from '@lexical/mark';
import {$createHeadingNode} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  COLLABORATION_TAG,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $selectIn,
  expectConverged,
  setup,
  shape,
} from '../../utils/harness';
import {prepareMarkState} from '../../utils/sizeOps';

/*
 * #9514: an update listener registered before the binding's throws in one
 * commit (an app's bug, or a plugin's, as @lexical/table's selection sync on a
 * ragged table did). The editor still calls the binding's listener for that
 * commit, so its change is written and every client and a fresh read of the
 * author's document show it, whatever the next commit is (local, or the
 * read of a remote change).
 */

type Change = 'type' | 'format' | 'comment' | 'split' | 'delete' | 'retype';
type Next = 'local' | 'remote';

let throwNext: ((tags: Set<string>, editor: LexicalEditor) => boolean) | null =
  null;

function prepare(editor: LexicalEditor): void {
  prepareMarkState(editor);
  editor.registerUpdateListener(({tags}) => {
    if (throwNext !== null && throwNext(tags, editor)) {
      throwNext = null;
      throw new Error('listener failed');
    }
  });
}

function $change(change: Change) {
  if (change === 'type') {
    $selectIn([0], 3).insertText('XY');
  } else if (change === 'format') {
    $selectIn([0], 0, 5).formatText('bold');
  } else if (change === 'comment') {
    $addMarkID('c1', $selectIn([0], 2, 9));
  } else if (change === 'split') {
    $selectIn([0], 4).insertParagraph();
  } else if (change === 'delete') {
    $selectIn([0], 1, 6).removeText();
  } else {
    const block = $block([1]);
    const heading = $createHeadingNode('h2');
    block.replace(heading, true);
  }
  $setSelection(null);
}

const REST = 'paragraph("second line") / paragraph("tail end")';
const EXPECTED: Record<Change, string> = {
  comment: `paragraph("al" "pha bet" "a gamma") / ${REST}`,
  delete: `paragraph("abeta gamma") / ${REST}`,
  format: `paragraph("alpha"{1} " beta gamma") / ${REST}`,
  retype:
    'paragraph("alpha beta gamma") / heading[h2]("second line") / paragraph("tail end")',
  split: `paragraph("alph") / paragraph("a beta gamma") / ${REST}`,
  type: `paragraph("alpXYha beta gamma") / ${REST}`,
};

async function run(change: Change, next: Next, gc: boolean, ids: number[]) {
  const t = await setup(
    () =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode('alpha beta gamma')),
        $createParagraphNode().append($createTextNode('second line')),
        $createParagraphNode().append($createTextNode('tail')),
      ),
    {gc, ids, prepare},
  );
  const [a, b] = t.peers;
  throwNext = (tags, editor) =>
    editor === a.editor && !tags.has(COLLABORATION_TAG);
  let thrown = false;
  try {
    a.update(() => $change(change));
  } catch {
    thrown = true;
  }
  expect(thrown).toBe(true);
  throwNext = null;
  if (next === 'local') {
    a.update(() => {
      ($getRoot().getLastChild() as ElementNode).append(
        $createTextNode(' end'),
      );
      $setSelection(null);
    });
  } else {
    b.update(() => {
      ($getRoot().getLastChild() as ElementNode).append(
        $createTextNode(' end'),
      );
      $setSelection(null);
    });
  }
  await t.sync();
  // Every client and a fresh read of A's document show the change.
  await expectConverged(t.peers, EXPECTED[change]);
  if (change === 'comment') {
    expect(JSON.stringify(shape(a))).toContain('"c1"');
  }
  return a.describe();
}

for (const gc of [false, true]) {
  describe(`a commit an earlier update listener throws in is written (gc ${gc ? 'on' : 'off'})`, () => {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      for (const change of [
        'type',
        'format',
        'comment',
        'split',
        'delete',
        'retype',
      ] as Change[]) {
        test(`${change}, then the next commit is local or remote (ids ${ids})`, async () => {
          const local = await run(change, 'local', gc, ids);
          const remote = await run(change, 'remote', gc, ids);
          expect(remote).toBe(local);
        });
      }
    }
  });
}
