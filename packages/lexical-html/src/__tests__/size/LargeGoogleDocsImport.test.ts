/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A paragraph pasted from Google Docs with enough lines to hold more nodes than
// a call can take as arguments, imported with `$generateNodesFromDOM`. Google
// Docs wraps a paste in
// `<b style="font-weight:normal" id="docs-internal-guid-…">`, and writes each
// line of a paragraph (Shift+Enter) in a `<span>` of its own with a
// `<span><br /></span>` between lines. The HTML here keeps that structure, the
// `<b>`'s `font-weight` and the spans' `white-space`, and drops the other
// styles. The paragraph holds a TextNode per line and a LineBreakNode between
// lines, so about twice as many children as lines. The `unit-size` project
// runs this file on a child process's main thread, whose argument limit
// (roughly 100,000 to 125,000 on Node) is the one production code runs under;
// spreading such a list into `append(...)` throws `RangeError: Maximum call
// stack size exceeded` there.

import {$generateNodesFromDOM} from '@lexical/html';
import {$getRoot, $isParagraphNode, $isTextNode, createEditor} from 'lexical';
import {assert, expect, test} from 'vitest';

import {LINES} from '../utils/sizeLimit';

test(`a Google Docs paragraph of ${LINES} lines imports as one paragraph`, () => {
  const editor = createEditor({
    namespace: 'size',
    nodes: [],
    onError: error => {
      throw error;
    },
  });
  const lines = Array.from({length: LINES}, (_, i) => `line ${i}`);
  const dom = new DOMParser().parseFromString(
    '<b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr">' +
      lines
        .map(line => `<span style="white-space:pre-wrap;">${line}</span>`)
        .join('<span style="white-space:pre-wrap;"><br /></span>') +
      '</p></b>',
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
    expect(block.getTextContent()).toBe(lines.join('\n'));
    // The wrapper's normal font weight keeps the lines from turning bold.
    const text = block.getFirstChild();
    assert($isTextNode(text));
    expect(text.hasFormat('bold')).toBe(false);
  });
});
