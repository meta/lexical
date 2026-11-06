/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Typing with a caret inside a segmented text node, after toggling a format
// on the caret: RangeSelection.insertText makes the segmented node a normal
// one, and gives that whole node the selection's format, so the words in it
// that were not typed take the format too
// (https://github.com/meta/lexical/issues/9833). Only the typed text should.

import {createHeadlessEditor} from '@lexical/headless';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

describe('typing inside a segmented text node with a format toggled', () => {
  test.fails('gives the format to the typed text only', () => {
    const editor = createHeadlessEditor({
      namespace: 'segmented-insert-format',
      nodes: [],
      onError: e => {
        throw e;
      },
    });
    editor.update(
      () => {
        const segmented = $createTextNode('one two').setMode('segmented');
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('zero '), segmented),
          );
        // The caret before "two".
        segmented.select(4, 4);
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'expected a range selection');
        selection.formatText('bold');
        selection.insertText('new ');
      },
      {discrete: true},
    );
    const runs = editor.read(() => {
      const paragraph = $getRoot().getFirstChild();
      assert($isElementNode(paragraph), 'expected a paragraph');
      return paragraph
        .getChildren()
        .map(node =>
          $isTextNode(node)
            ? [node.getTextContent(), node.hasFormat('bold')]
            : [node.getType(), false],
        );
    });
    expect(runs.map(([text]) => text).join('')).toBe('zero one new two');
    // The bold text is what was typed.
    expect(
      runs
        .filter(([, bold]) => bold)
        .map(([text]) => text)
        .join(''),
    ).toBe('new ');
  });
});
