/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A `<pre>` of plain text with more lines than a call can take as arguments,
// imported with `$generateNodesFromDOM`. The text converter turns the text
// into a TextNode per line and a LineBreakNode per line feed, so the one
// block it ends up in holds about twice as many nodes as lines. The
// `unit-size` project runs this file on a child process's main thread, whose
// argument limit (roughly 100,000 to 125,000 on Node) is the one production
// code runs under; spreading such a list into `push(...)` or `append(...)`
// throws `RangeError: Maximum call stack size exceeded` there.

import {$generateNodesFromDOM} from '@lexical/html';
import {$getRoot, $isParagraphNode, createEditor} from 'lexical';
import {assert, expect, test} from 'vitest';

import {LINES} from '../utils/sizeLimit';

test(`a <pre> of ${LINES} lines of plain text imports as one paragraph`, () => {
  const editor = createEditor({
    namespace: 'size',
    nodes: [],
    onError: error => {
      throw error;
    },
  });
  const text = Array.from({length: LINES}, (_, i) => `line ${i}`).join('\n');
  const dom = new DOMParser().parseFromString(
    `<pre>${text}</pre>`,
    'text/html',
  );
  editor.update(
    () => {
      $getRoot().clear().splice(0, 0, $generateNodesFromDOM(editor, dom));
    },
    {discrete: true},
  );
  editor.read(() => {
    const root = $getRoot();
    expect(root.getChildrenSize()).toBe(1);
    const block = root.getFirstChild();
    assert($isParagraphNode(block));
    expect(block.getChildrenSize()).toBe(LINES * 2 - 1);
    expect(block.getTextContent()).toBe(text);
  });
});
