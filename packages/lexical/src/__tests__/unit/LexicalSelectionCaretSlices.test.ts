/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {buildEditorFromExtensions} from '@lexical/extension';
import {$patchStyleText} from '@lexical/selection';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isTextNode,
  $setSelection,
  IS_BOLD,
  IS_ITALIC,
} from 'lexical';
import {describe, expect, test} from 'vitest';

describe('selection text slices', () => {
  test.each(['format', 'extract'] as const)(
    '%s of a detached text range repairs the active element point',
    operation => {
      using editor = buildEditorFromExtensions({name: 'slice-active-element'});
      editor.update(
        () => {
          const text = $createTextNode('abcde');
          const following = $createTextNode('after').setFormat('italic');
          const paragraph = $createParagraphNode().append(text, following);
          $getRoot().clear().append(paragraph);
          const active = paragraph.select(2, 2);
          const selection = $createRangeSelection();
          selection.anchor.set(text.getKey(), 1, 'text');
          selection.focus.set(text.getKey(), 4, 'text');

          if (operation === 'format') {
            selection.formatText('bold');
          } else {
            selection.extract();
          }

          expect(selection.getTextContent()).toBe('bcd');
          expect($getSelection()).toBe(active);
          expect(active.isCollapsed()).toBe(true);
          expect(active.anchor.key).toBe(following.getKey());
          expect(active.anchor.type).toBe('text');
          expect(active.anchor.offset).toBe(5);
        },
        {discrete: true},
      );
    },
  );

  test.each([false, true])(
    'styling retains the selected prefix at an element start (backward=%s)',
    backward => {
      using editor = buildEditorFromExtensions({name: 'slice-style'});
      editor.update(
        () => {
          const text = $createTextNode('abc');
          const paragraph = $createParagraphNode().append(text);
          $getRoot().clear().append(paragraph);
          const selection = $createRangeSelection();
          const [start, end] = backward
            ? [selection.focus, selection.anchor]
            : [selection.anchor, selection.focus];
          start.set(paragraph.getKey(), 0, 'element');
          end.set(text.getKey(), 1, 'text');
          $setSelection(selection);

          $patchStyleText(selection, {color: 'red'});
          expect(selection.getTextContent()).toBe('a');
          $patchStyleText(selection, {color: 'blue'});
          expect(paragraph.getFirstChildOrThrow().getTextContent()).toBe('a');
          expect(selection.anchor.getNode().getStyle()).toBe('color: blue;');
          expect(paragraph.getLastChildOrThrow().getTextContent()).toBe('bc');
        },
        {discrete: true},
      );
    },
  );

  test.each(['format', 'extract'] as const)(
    '%s retains detached element endpoints after a split',
    operation => {
      using editor = buildEditorFromExtensions({name: 'slice-detached-end'});
      editor.update(
        () => {
          const first = $createTextNode('abc');
          const second = $createTextNode('def').setFormat('italic');
          const paragraph = $createParagraphNode().append(first, second);
          const other = $createTextNode('other');
          $getRoot()
            .clear()
            .append(paragraph, $createParagraphNode().append(other));
          const active = other.select(2, 2);
          const selection = $createRangeSelection();
          selection.anchor.set(first.getKey(), 1, 'text');
          selection.focus.set(paragraph.getKey(), 2, 'element');

          if (operation === 'format') {
            selection.formatText('bold');
          } else {
            selection.extract();
          }
          expect(selection.getTextContent()).toBe('bcdef');
          expect(selection.focus.offset).toBeLessThanOrEqual(
            selection.focus.type === 'element'
              ? selection.focus.getNode().getChildrenSize()
              : selection.focus.getNode().getTextContentSize(),
          );
          expect($getSelection()).toBe(active);
          expect(active.anchor.key).toBe(other.getKey());
          expect(active.anchor.offset).toBe(2);
        },
        {discrete: true},
      );
    },
  );

  test.each([false, true])(
    'extracts through an element endpoint between children (backward=%s)',
    backward => {
      using editor = buildEditorFromExtensions({name: 'selection-text-slices'});
      editor.update(
        () => {
          const first = $createTextNode('abcd');
          const second = $createTextNode('efgh').setFormat('italic');
          const third = $createTextNode('ijkl').setFormat('bold');
          const paragraph = $createParagraphNode().append(first, second, third);
          $getRoot().clear().append(paragraph);
          const selection = $createRangeSelection();
          const [start, end] = backward
            ? [selection.focus, selection.anchor]
            : [selection.anchor, selection.focus];
          start.set(first.getKey(), 1, 'text');
          end.set(paragraph.getKey(), 2, 'element');
          $setSelection(selection);

          expect(
            selection
              .extract()
              .filter($isTextNode)
              .map(node => node.getTextContent()),
          ).toEqual(['bcd', 'efgh']);
          expect(paragraph.getTextContent()).toBe('abcdefghijkl');
          expect(selection.isBackward()).toBe(backward);
        },
        {discrete: true},
      );
    },
  );

  test.each([false, true])(
    'does not extract text from an empty mixed-point range (backward=%s)',
    backward => {
      using editor = buildEditorFromExtensions({name: 'selection-text-slices'});
      editor.update(
        () => {
          const text = $createTextNode('abcd');
          const following = $createTextNode('efgh').setFormat('italic');
          const paragraph = $createParagraphNode().append(text, following);
          $getRoot().clear().append(paragraph);
          const selection = $createRangeSelection();
          const [elementPoint, textPoint] = backward
            ? [selection.focus, selection.anchor]
            : [selection.anchor, selection.focus];
          elementPoint.set(paragraph.getKey(), 1, 'element');
          textPoint.set(text.getKey(), 4, 'text');
          $setSelection(selection);

          expect(selection.extract()).toEqual([]);
          expect(paragraph.getChildren()).toEqual([text, following]);
          expect(text.getTextContent()).toBe('abcd');
        },
        {discrete: true},
      );
    },
  );

  test('pending format excludes a final node selected at offset zero', () => {
    using editor = buildEditorFromExtensions({name: 'selection-text-slices'});
    editor.update(
      () => {
        const first = $createTextNode('abcd').setFormat(IS_BOLD);
        const second = $createTextNode('efgh').setFormat(IS_ITALIC);
        const paragraph = $createParagraphNode().append(first, second);
        $getRoot().clear().append(paragraph);
        const selection = $createRangeSelection();
        selection.anchor.set(first.getKey(), 0, 'text');
        selection.focus.set(second.getKey(), 0, 'text');
        selection.format = IS_BOLD;
        $setSelection(selection);

        selection.formatText('bold');
        expect(first.getFormat()).toBe(0);
        expect(second.getFormat()).toBe(IS_ITALIC);
        expect(selection.format).toBe(0);
      },
      {discrete: true},
    );
  });

  test('formatting a detached selection retains its partial text range', () => {
    using editor = buildEditorFromExtensions({name: 'selection-text-slices'});
    editor.update(
      () => {
        const text = $createTextNode('abcde');
        const other = $createTextNode('other');
        const paragraph = $createParagraphNode().append(text);
        $getRoot()
          .clear()
          .append(paragraph, $createParagraphNode().append(other));
        const active = other.select(2, 2);
        const selection = $createRangeSelection();
        selection.anchor.set(text.getKey(), 4, 'text');
        selection.focus.set(text.getKey(), 1, 'text');

        selection.formatText('bold');
        expect(
          paragraph
            .getChildren()
            .map(node => [
              node.getTextContent(),
              $isTextNode(node) && node.getFormat(),
            ]),
        ).toEqual([
          ['a', 0],
          ['bcd', IS_BOLD],
          ['e', 0],
        ]);
        expect(selection.anchor.getNode().getTextContent()).toBe('bcd');
        expect(selection.anchor.offset).toBe(3);
        expect(selection.focus.offset).toBe(0);
        expect($getSelection()).toBe(active);
        expect(active.anchor.key).toBe(other.getKey());
        expect(active.anchor.offset).toBe(2);
      },
      {discrete: true},
    );
  });

  test.each(
    [false, true].flatMap(backward =>
      [false, true].flatMap(active =>
        [false, true].flatMap(preceding =>
          [1, 3].map(endOffset => ({active, backward, endOffset, preceding})),
        ),
      ),
    ),
  )(
    'formatting retains an element start (backward=$backward, active=$active, preceding=$preceding, end=$endOffset)',
    ({backward, active, preceding, endOffset}) => {
      using editor = buildEditorFromExtensions({name: 'selection-text-slices'});
      editor.update(
        () => {
          const text = $createTextNode('abc');
          const paragraph = $createParagraphNode();
          if (preceding)
            paragraph.append($createTextNode('before').setFormat('italic'));
          paragraph.append(text, $createTextNode('def'));
          const other = $createTextNode('other');
          $getRoot()
            .clear()
            .append(paragraph, $createParagraphNode().append(other));
          const unrelated = other.select(2, 2);
          const selection = $createRangeSelection();
          const [start, end] = backward
            ? [selection.focus, selection.anchor]
            : [selection.anchor, selection.focus];
          start.set(paragraph.getKey(), preceding ? 1 : 0, 'element');
          end.set(text.getKey(), endOffset, 'text');
          if (active) $setSelection(selection);
          for (const expectedFormat of [IS_BOLD, 0]) {
            selection.formatText('bold');
            const formatted = paragraph.getChildAtIndex(preceding ? 1 : 0);
            expect($isTextNode(formatted) && formatted.getFormat()).toBe(
              expectedFormat,
            );
            expect(formatted?.getTextContent()).toBe('abc'.slice(0, endOffset));
            expect(selection.getTextContent()).toBe('abc'.slice(0, endOffset));
            expect(start.key).toBe(
              endOffset === 3 ? paragraph.getKey() : formatted?.getKey(),
            );
            expect(start.type).toBe(endOffset === 3 ? 'element' : 'text');
            expect(start.offset).toBe(endOffset === 3 && preceding ? 1 : 0);
            expect(end.key).toBe(formatted?.getKey());
            expect(end.offset).toBe(endOffset);
            expect(selection.isBackward()).toBe(backward);
            if (!active) {
              expect($getSelection()).toBe(unrelated);
              expect(unrelated.anchor.key).toBe(other.getKey());
              expect(unrelated.anchor.offset).toBe(2);
            }
          }
        },
        {discrete: true},
      );
    },
  );
});
