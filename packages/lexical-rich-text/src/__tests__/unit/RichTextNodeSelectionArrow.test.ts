/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  type LexicalCommand,
  type LexicalEditor,
} from 'lexical';
import {
  $createTestDecoratorNode,
  TestDecoratorNode,
} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test} from 'vitest';

function createEditor() {
  return buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot()
        .clear()
        .append(
          $createTestDecoratorNode().setIsInline(false),
          $createTestDecoratorNode().setIsInline(false),
          $createTestDecoratorNode().setIsInline(false),
          $createParagraphNode().append($createTextNode('text')),
        );
    },
    dependencies: [RichTextExtension],
    name: 'test',
    nodes: [TestDecoratorNode],
  });
}

function makeArrowEvent(key: string, shiftKey = false): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key,
    shiftKey,
  });
}

function selectNodes(editor: LexicalEditor, indexes: number[]): void {
  editor.update(
    () => {
      const selection = $createNodeSelection();
      for (const index of indexes) {
        selection.add($getRoot().getChildAtIndex(index)!.getKey());
      }
      $setSelection(selection);
    },
    {discrete: true},
  );
}

function selectRoot(
  editor: LexicalEditor,
  anchorOffset: number,
  focusOffset: number,
): void {
  editor.update(
    () => {
      $getRoot().select(anchorOffset, focusOffset);
    },
    {discrete: true},
  );
}

function dispatchShiftArrow(
  editor: LexicalEditor,
  command: LexicalCommand<KeyboardEvent>,
  key: string,
): {defaultPrevented: boolean; handled: boolean} {
  const event = makeArrowEvent(key, true);
  const handled = editor.dispatchCommand(command, event);
  return {defaultPrevented: event.defaultPrevented, handled};
}

function expectRootRange(
  editor: LexicalEditor,
  anchorOffset: number,
  focusOffset: number,
): void {
  editor.read(() => {
    const selection = $getSelection();
    assert($isRangeSelection(selection));
    expect(selection.anchor).toMatchObject({
      key: $getRoot().getKey(),
      offset: anchorOffset,
      type: 'element',
    });
    expect(selection.focus).toMatchObject({
      key: $getRoot().getKey(),
      offset: focusOffset,
      type: 'element',
    });
  });
}

describe('Shift+Arrow on a NodeSelection (#9062)', () => {
  /**
   * A contiguous NodeSelection is converted to the RangeSelection that covers
   * the same siblings, oriented so that the focus is on the side the arrow key
   * moves toward, and then the regular RangeSelection handling runs. So each
   * case asserts both the conversion (`converted`) and that the outcome is
   * identical to pressing the same key with that RangeSelection already in
   * place — including whether the handler consumes the event at all.
   *
   * ArrowLeft/ArrowRight are consumed by `$moveCharacter`, which extends the
   * focus across the adjacent decorator. ArrowUp/ArrowDown are not handled by
   * rich text (except at the root edges); the browser performs the vertical
   * extension natively, so the handler leaves the converted selection alone,
   * returns `false`, and does not preventDefault.
   */
  test.for<{
    command: LexicalCommand<KeyboardEvent>;
    converted: [anchor: number, focus: number];
    expected: [anchor: number, focus: number];
    handled: boolean;
    key: string;
    selectedIndexes: number[];
  }>([
    {
      command: KEY_ARROW_RIGHT_COMMAND,
      converted: [0, 1],
      expected: [0, 2],
      handled: true,
      key: 'ArrowRight',
      selectedIndexes: [0],
    },
    {
      command: KEY_ARROW_DOWN_COMMAND,
      converted: [0, 1],
      expected: [0, 1],
      handled: false,
      key: 'ArrowDown',
      selectedIndexes: [0],
    },
    {
      command: KEY_ARROW_LEFT_COMMAND,
      converted: [2, 1],
      expected: [2, 0],
      handled: true,
      key: 'ArrowLeft',
      selectedIndexes: [1],
    },
    {
      command: KEY_ARROW_UP_COMMAND,
      converted: [2, 1],
      expected: [2, 1],
      handled: false,
      key: 'ArrowUp',
      selectedIndexes: [1],
    },
    {
      // The converted focus is already at the start of the root, so rich text
      // consumes the event instead of letting the browser move past it.
      command: KEY_ARROW_UP_COMMAND,
      converted: [1, 0],
      expected: [1, 0],
      handled: true,
      key: 'ArrowUp',
      selectedIndexes: [0],
    },
    {
      // Out of document order: the NodeSelection is sorted before conversion.
      command: KEY_ARROW_RIGHT_COMMAND,
      converted: [0, 2],
      expected: [0, 3],
      handled: true,
      key: 'ArrowRight',
      selectedIndexes: [1, 0],
    },
  ])(
    '$key with $selectedIndexes selected converts to $converted and matches the equivalent RangeSelection',
    ({command, converted, expected, handled, key, selectedIndexes}) => {
      using nodeSelectionEditor = createEditor();
      selectNodes(nodeSelectionEditor, selectedIndexes);
      const nodeSelectionResult = dispatchShiftArrow(
        nodeSelectionEditor,
        command,
        key,
      );

      expect(nodeSelectionResult).toEqual({
        defaultPrevented: handled,
        handled,
      });
      expectRootRange(nodeSelectionEditor, ...expected);

      // Starting from the converted RangeSelection produces the same outcome.
      using rangeSelectionEditor = createEditor();
      selectRoot(rangeSelectionEditor, ...converted);
      const rangeSelectionResult = dispatchShiftArrow(
        rangeSelectionEditor,
        command,
        key,
      );

      expect(rangeSelectionResult).toEqual(nodeSelectionResult);
      expectRootRange(rangeSelectionEditor, ...expected);
    },
  );

  test('does not convert a discontiguous NodeSelection to a range', () => {
    using editor = createEditor();
    selectNodes(editor, [0, 2]);

    const {defaultPrevented, handled} = dispatchShiftArrow(
      editor,
      KEY_ARROW_RIGHT_COMMAND,
      'ArrowRight',
    );

    expect(handled).toBe(true);
    expect(defaultPrevented).toBe(true);
    expectRootRange(editor, 1, 1);
  });
});
