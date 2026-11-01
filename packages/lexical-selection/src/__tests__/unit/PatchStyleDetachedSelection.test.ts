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
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isTextNode,
  $setSelection,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {expect, test} from 'vitest';

const ACTIVE_SELECTIONS = ['none', 'collapsed', 'range'] as const;

function $createFixture(active: (typeof ACTIVE_SELECTIONS)[number]) {
  const text = $createTextNode('abcdef');
  const paragraph = $createParagraphNode().append(text);
  const other = $createTextNode('xyz');
  $getRoot().append(paragraph, $createParagraphNode().append(other));
  const activeSelection =
    active === 'none' ? null : other.select(0, active === 'range' ? 2 : 0);
  $setSelection(activeSelection);
  const originalActive = activeSelection && activeSelection.clone();
  function $expectActiveUnchanged() {
    expect(other.getParentOrThrow().getChildren()).toEqual([other]);
    expect(other.getStyle()).toBe('');
    expect($getSelection()).toBe(activeSelection);
    if (activeSelection && originalActive) {
      expect(activeSelection.is(originalActive)).toBe(true);
    }
  }
  return {$expectActiveUnchanged, paragraph, text};
}

test.each(
  ACTIVE_SELECTIONS.flatMap(active =>
    [false, true].flatMap(backward =>
      [false, true].map(partial => ({active, backward, partial})),
    ),
  ),
)(
  'repeatedly styles a detached text range (active=$active, backward=$backward, partial=$partial)',
  ({active, backward, partial}) => {
    using editor = buildEditorFromExtensions({name: 'detached-style-range'});
    editor.update(
      () => {
        const {text, paragraph, $expectActiveUnchanged} =
          $createFixture(active);
        const selection = $createRangeSelection();
        const [start, end] = backward
          ? [selection.focus, selection.anchor]
          : [selection.anchor, selection.focus];
        start.set(text.getKey(), partial ? 2 : 0, 'text');
        end.set(text.getKey(), partial ? 4 : 6, 'text');
        const expectedText = partial ? 'cd' : 'abcdef';
        $patchStyleText(selection, {color: 'red'});
        const styled = $assertNodeType(
          paragraph.getChildAtIndex(partial ? 1 : 0),
          $isTextNode,
        );
        // The iterator preserves its existing forward single-text convention.
        expect(selection.anchor).toMatchObject({
          key: styled.getKey(),
          offset: 0,
          type: 'text',
        });
        expect(selection.focus).toMatchObject({
          key: styled.getKey(),
          offset: expectedText.length,
          type: 'text',
        });
        expect(selection.getTextContent()).toBe(expectedText);
        expect(selection.getNodes()).toEqual([styled]);
        $patchStyleText(selection, {'font-size': '20px'});
        expect(styled.getStyle()).toBe('color: red;font-size: 20px;');
        expect(selection.getTextContent()).toBe(expectedText);
        expect(paragraph.getTextContent()).toBe('abcdef');
        if (partial) {
          expect(
            $assertNodeType(
              paragraph.getFirstChildOrThrow(),
              $isTextNode,
            ).getStyle(),
          ).toBe('');
          expect(
            $assertNodeType(
              paragraph.getLastChildOrThrow(),
              $isTextNode,
            ).getStyle(),
          ).toBe('');
        }
        $expectActiveUnchanged();
      },
      {discrete: true},
    );
  },
);

test.each(ACTIVE_SELECTIONS)(
  'styles a detached caret without styling active text (%s)',
  active => {
    using editor = buildEditorFromExtensions({name: 'detached-style-caret'});
    editor.update(
      () => {
        const {text, $expectActiveUnchanged} = $createFixture(active);
        const selection = $createRangeSelection();
        selection.anchor.set(text.getKey(), 2, 'text');
        selection.focus.set(text.getKey(), 2, 'text');
        $patchStyleText(selection, {color: 'red'});
        expect(selection.style).toBe('color: red;');
        expect(text.getStyle()).toBe('');
        $expectActiveUnchanged();
      },
      {discrete: true},
    );
  },
);

test.each(ACTIVE_SELECTIONS)(
  'styles a detached node selection (%s)',
  active => {
    using editor = buildEditorFromExtensions({name: 'detached-style-node'});
    editor.update(
      () => {
        const {text, $expectActiveUnchanged} = $createFixture(active);
        const selection = $createNodeSelection();
        selection.add(text.getKey());
        $patchStyleText(selection, {color: 'red'});
        expect(text.getStyle()).toBe('color: red;');
        $expectActiveUnchanged();
      },
      {discrete: true},
    );
  },
);
