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
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {
  $createTestDecoratorNode,
  TestDecoratorNode,
} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test} from 'vitest';

function makeArrowEvent(key: string, shiftKey = false): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key,
    shiftKey,
  });
}

// Structure used across tests:
//   root
//     decorator (block)   — index 0
//     paragraph > text    — index 1
//     decorator (block)   — index 2
function createBoundaryEditor() {
  return buildEditorFromExtensions({
    $initialEditorState: () => {
      const decorator1 = $createTestDecoratorNode().setIsInline(false);
      const paragraph = $createParagraphNode().append($createTextNode('text'));
      const decorator2 = $createTestDecoratorNode().setIsInline(false);
      $getRoot().clear().append(decorator1, paragraph, decorator2);
    },
    dependencies: [RichTextExtension],
    name: 'test',
    nodes: [TestDecoratorNode],
  });
}

function expectBlockCursorAt(editor: LexicalEditor, offset: number) {
  editor.read(() => {
    const s = $getSelection();
    assert($isRangeSelection(s));
    expect(s.isCollapsed()).toBe(true);
    expect(s.anchor.type).toBe('element');
    expect(s.anchor.key).toBe($getRoot().getKey());
    expect(s.anchor.offset).toBe(offset);
  });
}

describe('block cursor root boundary navigation (#8886)', () => {
  test('ArrowUp at block cursor before the top decorator does not leave the editor', () => {
    using editor = createBoundaryEditor();

    // Select the leading decorator (NodeSelection)
    editor.update(
      () => {
        const decorator = $getRoot().getChildAtIndex(0)!;
        const ns = $createNodeSelection();
        ns.add(decorator.getKey());
        $setSelection(ns);
      },
      {discrete: true},
    );

    // First ArrowUp collapses the NodeSelection to a block cursor at root:0
    editor.dispatchCommand(KEY_ARROW_UP_COMMAND, makeArrowEvent('ArrowUp'));
    expectBlockCursorAt(editor, 0);

    // Second ArrowUp must be handled (preventDefault) so the native selection
    // cannot escape above the editor, and the lexical selection stays put.
    const event = makeArrowEvent('ArrowUp');
    const handled = editor.dispatchCommand(KEY_ARROW_UP_COMMAND, event);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expectBlockCursorAt(editor, 0);
  });

  test('ArrowDown at block cursor after the bottom decorator does not leave the editor', () => {
    using editor = createBoundaryEditor();

    // Select the trailing decorator (NodeSelection)
    editor.update(
      () => {
        const decorator = $getRoot().getChildAtIndex(2)!;
        const ns = $createNodeSelection();
        ns.add(decorator.getKey());
        $setSelection(ns);
      },
      {discrete: true},
    );

    // First ArrowDown collapses the NodeSelection to a block cursor at root:3
    editor.dispatchCommand(KEY_ARROW_DOWN_COMMAND, makeArrowEvent('ArrowDown'));
    expectBlockCursorAt(editor, 3);

    // Second ArrowDown must be handled (preventDefault) so the native
    // selection cannot escape below the editor.
    const event = makeArrowEvent('ArrowDown');
    const handled = editor.dispatchCommand(KEY_ARROW_DOWN_COMMAND, event);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expectBlockCursorAt(editor, 3);
  });
});

describe('block cursor root boundary navigation (#7999)', () => {
  test('ArrowRight at the block cursor after the last block stays put', () => {
    using editor = createBoundaryEditor();

    editor.update(() => $getRoot().select(3, 3), {discrete: true});
    expectBlockCursorAt(editor, 3);

    const event = makeArrowEvent('ArrowRight');
    const handled = editor.dispatchCommand(KEY_ARROW_RIGHT_COMMAND, event);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expectBlockCursorAt(editor, 3);
  });

  test('ArrowLeft at the block cursor before the first block stays put', () => {
    using editor = createBoundaryEditor();

    editor.update(() => $getRoot().select(0, 0), {discrete: true});
    expectBlockCursorAt(editor, 0);

    const event = makeArrowEvent('ArrowLeft');
    const handled = editor.dispatchCommand(KEY_ARROW_LEFT_COMMAND, event);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expectBlockCursorAt(editor, 0);
  });

  test('ArrowRight at the block cursor before the last block is not consumed', () => {
    using editor = createBoundaryEditor();

    // root:2 sits between the paragraph and the trailing decorator, so there
    // is still a block to move into.
    editor.update(() => $getRoot().select(2, 2), {discrete: true});

    const event = makeArrowEvent('ArrowRight');
    editor.dispatchCommand(KEY_ARROW_RIGHT_COMMAND, event);
    // The pre-existing decorator navigation still runs and selects the
    // trailing decorator rather than leaving the caret at the root.
    editor.read(() => {
      const s = $getSelection();
      assert($isNodeSelection(s));
      expect(s.getNodes()).toEqual([$getRoot().getChildAtIndex(2)]);
    });
  });

  test('Shift+ArrowRight at the block cursor after the last block stays put', () => {
    using editor = createBoundaryEditor();

    // Holding shift does not create anything to extend toward: there is no
    // block past the last one, so the outward key is consumed either way.
    editor.update(() => $getRoot().select(3, 3), {discrete: true});

    const event = makeArrowEvent('ArrowRight', true);
    const handled = editor.dispatchCommand(KEY_ARROW_RIGHT_COMMAND, event);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expectBlockCursorAt(editor, 3);
  });

  test('Shift+ArrowLeft at the block cursor before the first block stays put', () => {
    using editor = createBoundaryEditor();

    editor.update(() => $getRoot().select(0, 0), {discrete: true});

    const event = makeArrowEvent('ArrowLeft', true);
    const handled = editor.dispatchCommand(KEY_ARROW_LEFT_COMMAND, event);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expectBlockCursorAt(editor, 0);
  });

  test('Shift+ArrowLeft at the block cursor after the last block is not consumed', () => {
    using editor = createBoundaryEditor();

    // Inward, not outward: root:3 is the end of the root, but ArrowLeft moves
    // back toward the trailing decorator, so the edge check must not fire.
    editor.update(() => $getRoot().select(3, 3), {discrete: true});

    const event = makeArrowEvent('ArrowLeft', true);
    editor.dispatchCommand(KEY_ARROW_LEFT_COMMAND, event);
    editor.read(() => {
      const s = $getSelection();
      assert($isRangeSelection(s));
      expect(s.isCollapsed()).toBe(false);
      expect(s.focus.offset).toBe(2);
    });
  });

  test('ArrowRight with a non-collapsed selection at the root edge is not consumed', () => {
    using editor = createBoundaryEditor();

    editor.update(() => $getRoot().select(0, 3), {discrete: true});

    const event = makeArrowEvent('ArrowRight');
    const handled = editor.dispatchCommand(KEY_ARROW_RIGHT_COMMAND, event);
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});
