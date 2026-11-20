/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A link with enough lines to hold more nodes than a call can take as arguments
// (`<br>`-separated lines inside one `<a>`), imported with
// `$generateNodesFromDOM`. The link holds a TextNode per line and a
// LineBreakNode between lines, so about twice as many children as lines. The
// `unit-size` project runs this file on a child process's main thread, whose
// argument limit (roughly 100,000 to 125,000 on Node) is the one production
// code runs under; spreading such a list into `append(...)` throws `RangeError:
// Maximum call stack size exceeded` there.

import {$generateNodesFromDOM} from '@lexical/html';
import {$isLinkNode, LinkNode} from '@lexical/link';
import {$getRoot, $isParagraphNode, createEditor} from 'lexical';
import {assert, expect, test} from 'vitest';

import {LINES} from '../utils/sizeLimit';

test(`a link of ${LINES} lines imports with every line in the link`, () => {
  const editor = createEditor({
    namespace: 'size',
    nodes: [LinkNode],
    onError: error => {
      throw error;
    },
  });
  const lines = Array.from({length: LINES}, (_, i) => `line ${i}`);
  const dom = new DOMParser().parseFromString(
    `<p><a href="https://lexical.dev/">${lines.join('<br>')}</a></p>`,
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
    expect(block.getChildrenSize()).toBe(1);
    const link = block.getFirstChild();
    assert($isLinkNode(link));
    expect(link.getURL()).toBe('https://lexical.dev/');
    expect(link.getChildrenSize()).toBe(LINES * 2 - 1);
    expect(link.getTextContent()).toBe(lines.join('\n'));
  });
});
