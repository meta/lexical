/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A fenced code block with more lines than a call can take as arguments,
// imported from Markdown. The importer builds the block's children as a
// TextNode per run of text and a LineBreakNode per line feed, so the block
// holds about twice as many children as lines. The `unit-size` project runs
// this file on a child process's main thread, whose argument limit
// (131,072 on Node) is the one production code runs under; spreading such a
// list into `append(...)` throws `RangeError: Maximum call stack size
// exceeded` there, and the whole import is discarded.

import {$isCodeNode, CodeNode} from '@lexical/code-core';
import {createHeadlessEditor} from '@lexical/headless';
import {LinkNode} from '@lexical/link';
import {ListItemNode, ListNode} from '@lexical/list';
import {$convertFromMarkdownString, TRANSFORMERS} from '@lexical/markdown';
import {HeadingNode, QuoteNode} from '@lexical/rich-text';
import {$getRoot, $isLineBreakNode} from 'lexical';
import {expect, test} from 'vitest';

/**
 * The smallest power of two of arguments a spread into a call throws on in
 * this runtime (Node's main thread: 131,072; a worker thread: 524,288).
 */
function argumentLimit(): number {
  for (let n = 1 << 16; n <= 1 << 24; n *= 2) {
    const items = new Array<string>(n).fill('x');
    try {
      [].push(...(items as never[]));
    } catch {
      return n;
    }
  }
  throw new Error('no argument limit up to 2^24');
}

/** Lines of the block: its children (a text and a line break per line) pass the limit. */
const LINES = Math.ceil(argumentLimit() / 2) + 2_048;

test(`a fenced code block of ${LINES} lines imports, a LineBreakNode between lines`, () => {
  const editor = createHeadlessEditor({
    nodes: [CodeNode, HeadingNode, LinkNode, ListItemNode, ListNode, QuoteNode],
    onError: error => {
      throw error;
    },
  });
  const code = Array.from({length: LINES}, (_, i) => `line ${i}`).join('\n');
  editor.update(
    () => {
      $convertFromMarkdownString('```js\n' + code + '\n```', TRANSFORMERS);
    },
    {discrete: true},
  );
  editor.read(() => {
    const block = $getRoot().getFirstChild();
    expect($isCodeNode(block)).toBe(true);
    if (!$isCodeNode(block)) {
      return;
    }
    expect(block.getChildrenSize()).toBe(LINES * 2 - 1);
    expect($isLineBreakNode(block.getChildAtIndex(1))).toBe(true);
    expect(block.getTextContent()).toBe(code);
  });
});
