/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A comment must not spread onto other blocks after concurrent undos when
// text entity transforms (a keyword and hashtags) move commented text between
// nodes inside one undo step.
//
// A, in one undo step: comment c1 on the keyword "two", type "x" after it,
// comment c3 on the node holding "two", type "#t" in front of it. Everyone
// syncs. B removes c3; A undoes its step; sync; B undoes its removal; sync.
//
// Mark removal splits ownership of an open/close pair, and undo restores an
// opener with no closer: the entity is stored as several runs with identical
// attributes, each with its own c3 pair; B's removal deletes a run's opener but
// keeps its closer (writing its own end instead); A's undo deletes that closer
// with the run's text; B's undo restores the opener alone, and c3 then covers
// everything after it on every peer. Main reaches it too (with its own entity
// path); keeping the comments on the entity reaches it more often. See #9716.

import {
  $createHashtagNode,
  HashtagNode,
  registerLexicalHashtag,
} from '@lexical/hashtag';
import {$addMarkID, $getNodeMarkIDs, $removeMarkID} from '@lexical/mark';
import {registerLexicalTextEntity} from '@lexical/text';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type LexicalEditor,
  TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {expectConverged, NODES, type Peer, setup} from '../utils/harness';
import {prepareMarkState} from '../utils/sizeOps';

/** A keyword entity, as the playground's keywords plugin makes them. */
class KeywordNode extends TextNode {
  $config() {
    return this.config('test-keyword', {extends: TextNode});
  }
  isTextEntity(): true {
    return true;
  }
  canInsertTextBefore(): boolean {
    return false;
  }
  canInsertTextAfter(): boolean {
    return false;
  }
}

const $createKeywordNode = (text: string): KeywordNode =>
  $create(KeywordNode).setTextContent(text);

const KEYWORD = /(^|[^a-z0-9#])(two|five)(?=[^a-z0-9]|$)/;

function prepare(editor: LexicalEditor): void {
  prepareMarkState(editor);
  registerLexicalHashtag(editor);
  registerLexicalTextEntity(
    editor,
    text => {
      const m = KEYWORD.exec(text);
      return m === null
        ? null
        : {
            end: m.index + m[1].length + m[2].length,
            start: m.index + m[1].length,
          };
    },
    KeywordNode,
    node => $createKeywordNode(node.getTextContent()),
  );
}

/** The text node of block 0 that holds "two". */
function $nodeWithTwo(): TextNode {
  const node = ($getRoot().getFirstChildOrThrow() as ElementNode)
    .getAllTextNodes()
    .find(n => n.getTextContent().includes('two'));
  if (node === undefined) {
    throw new Error('no node holds "two"');
  }
  return node;
}

function $select(node: TextNode, start: number, end: number) {
  const selection = $createRangeSelection();
  selection.anchor.set(node.getKey(), start, 'text');
  selection.focus.set(node.getKey(), end, 'text');
  $setSelection(selection);
  return selection;
}

/** The blocks each comment id is on. */
function blocksOf(peer: Peer): Record<string, number[]> {
  return peer.read(() => {
    const out: Record<string, number[]> = {};
    $getRoot()
      .getChildren()
      .forEach((block, i) => {
        for (const node of (block as ElementNode).getAllTextNodes()) {
          for (const id of $getNodeMarkIDs(node)) {
            const list = (out[id] = out[id] || []);
            if (!list.includes(i)) {
              list.push(i);
            }
          }
        }
      });
    return out;
  });
}

test('#9716: undo restores a comment opener without its closer after an entity type change (spreads to the end of the document)', async () => {
  const t = await setup(
    () => {
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('alpha one '),
          $createKeywordNode('two'),
          $createTextNode(' three '),
          $createHashtagNode('#four'),
          $createTextNode(' 0'),
        ),
        $createParagraphNode().append($createTextNode('beta one two three 1')),
        $createParagraphNode().append($createTextNode('gamma one two three 2')),
      );
    },
    {nodes: [...NODES, HashtagNode, KeywordNode], prepare},
  );
  const [a, b] = t.peers;
  // A's undo step: four updates with no step boundary between them
  a.update(() => {
    const two = $nodeWithTwo();
    $addMarkID('c1', $select(two, 0, two.getTextContentSize()));
    $setSelection(null);
  });
  const step = (fn: () => void) => a.editor.update(fn, {discrete: true});
  step(() => {
    const two = $nodeWithTwo();
    const at = two.getTextContent().indexOf('two') + 3;
    const selection = $select(two, at, at);
    selection.format = 0;
    selection.insertText('x');
    $setSelection(null);
  });
  step(() => {
    const two = $nodeWithTwo();
    $addMarkID('c3', $select(two, 0, two.getTextContentSize()));
    $setSelection(null);
  });
  step(() => {
    const two = $nodeWithTwo();
    const selection = $select(two, 0, 0);
    selection.format = 0;
    selection.insertText('#t');
    $setSelection(null);
  });
  await t.sync();
  b.update(() => $removeMarkID('c3'));
  a.undo();
  await t.sync();
  b.undo();
  await t.sync();
  await expectConverged(t.peers);
  const c3 = blocksOf(a).c3 || [];
  expect(c3.filter(i => i !== 0)).toEqual([]);
});
