/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSlot,
} from 'lexical';
import {expect, test} from 'vitest';

test.each([false, true])(
  'selected text ends at the same boundary for an element or text point (backward=%s)',
  backward => {
    using editor = buildEditorFromExtensions({name: 'caret-selection-test'});
    editor.update(
      () => {
        const first = $createTextNode('abcd');
        const second = $createTextNode('efgh').setFormat('italic');
        const paragraph = $createParagraphNode().append(
          first,
          second,
          $createTextNode('ijkl').setFormat('bold'),
        );
        $getRoot().clear().append(paragraph);
        const selection = $createRangeSelection();
        const [start, end] = backward
          ? [selection.focus, selection.anchor]
          : [selection.anchor, selection.focus];
        start.set(first.getKey(), 1, 'text');
        end.set(second.getKey(), 4, 'text');
        expect(selection.getTextContent()).toBe('bcdefgh');
        end.set(paragraph.getKey(), 2, 'element');
        expect(selection.getTextContent()).toBe('bcdefgh');
        expect(paragraph.getTextContent()).toBe('abcdefghijkl');
      },
      {discrete: true},
    );
  },
);

test.each([false, true])(
  'equivalent mixed text and element points contain no selected text (backward=%s)',
  backward => {
    using editor = buildEditorFromExtensions({name: 'caret-selection-test'});
    editor.update(
      () => {
        const first = $createTextNode('abcd');
        const paragraph = $createParagraphNode().append(
          first,
          $createTextNode('efgh').setFormat('italic'),
        );
        $getRoot().clear().append(paragraph);
        const selection = $createRangeSelection();
        const [start, end] = backward
          ? [selection.focus, selection.anchor]
          : [selection.anchor, selection.focus];
        start.set(first.getKey(), 4, 'text');
        end.set(paragraph.getKey(), 1, 'element');
        expect(selection.getTextContent()).toBe('');
        expect(paragraph.getTextContent()).toBe('abcdefgh');
      },
      {discrete: true},
    );
  },
);

test.each([0, 1])(
  'collapsed element point beside a slot host contains no text (offset=%s)',
  offset => {
    using editor = buildEditorFromExtensions({name: 'caret-selection-test'});
    editor.update(
      () => {
        const root = $getRoot();
        const host = $createParagraphNode();
        root.clear().append(host);
        $setSlot(
          host,
          'title',
          $createParagraphNode().append($createTextNode('Title')),
        );
        const selection = $createRangeSelection();
        selection.anchor.set(root.getKey(), offset, 'element');
        selection.focus.set(root.getKey(), offset, 'element');
        expect(selection.getNodes()).toEqual([host]);
        expect(selection.getTextContent()).toBe('');
        expect(host.getTextContent()).toBe('Title');
      },
      {discrete: true},
    );
  },
);
