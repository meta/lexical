/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createHeadingNode,
  $isHeadingNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  BEFORE_INPUT_COMMAND,
  COMMAND_PRIORITY_LOW,
  type ElementNode,
  KEY_DOWN_COMMAND,
  KEY_SPACE_COMMAND,
  type LexicalEditor,
  ParagraphNode,
} from 'lexical';
import {
  $createTestDecoratorNode,
  TestDecoratorNode,
} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, onTestFinished, test} from 'vitest';

function createEditor(
  followedBy: string | null,
  $block: () => ElementNode = $createParagraphNode,
) {
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      const decorator = $createTestDecoratorNode().setIsInline(false);
      $getRoot().append(
        $createParagraphNode().append($createTextNode('before')),
        decorator,
      );
      if (followedBy !== null) {
        const block = $block();
        if (followedBy !== '') {
          block.append($createTextNode(followedBy));
        }
        $getRoot().append(block);
      }
      const selection = $createNodeSelection();
      selection.add(decorator.getKey());
      $setSelection(selection);
    },
    dependencies: [RichTextExtension],
    name: 'test',
    nodes: [TestDecoratorNode],
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  onTestFinished(() => root.remove());
  return editor;
}

function type(editor: LexicalEditor, data: string) {
  const event = new InputEvent('beforeinput', {
    cancelable: true,
    data,
    inputType: 'insertText',
  });
  editor.update(() => editor.dispatchCommand(BEFORE_INPUT_COMMAND, event), {
    discrete: true,
  });
}

function texts(editor: LexicalEditor): string[] {
  return editor.read(() =>
    $getRoot()
      .getChildren()
      .map(node =>
        node instanceof ParagraphNode
          ? node.getTextContent()
          : $isHeadingNode(node)
            ? `<${node.getTag()}>${node.getTextContent()}`
            : '<decorator>',
      ),
  );
}

describe('typing while a block decorator is node-selected', () => {
  test.for(['altKey', 'ctrlKey', 'metaKey'] as const)(
    'leaves a printable key with %s to its modifier shortcut',
    modifier => {
      using editor = createEditor('after');
      const event = new KeyboardEvent('keydown', {
        cancelable: true,
        key: 'q',
        [modifier]: true,
      });
      editor.update(() => editor.dispatchCommand(KEY_DOWN_COMMAND, event), {
        discrete: true,
      });

      expect(texts(editor)).toEqual(['before', '<decorator>', 'after']);
      expect(event.defaultPrevented).toBe(false);
    },
  );

  test.for([true, false])(
    'dispatches Space before default insertion handled=%s',
    handled => {
      using editor = createEditor('after');
      let calls = 0;
      editor.registerCommand(
        KEY_SPACE_COMMAND,
        event => {
          calls++;
          if (handled) {
            event.preventDefault();
          }
          return handled;
        },
        COMMAND_PRIORITY_LOW,
      );
      const event = new KeyboardEvent('keydown', {cancelable: true, key: ' '});
      editor.update(() => editor.dispatchCommand(KEY_DOWN_COMMAND, event), {
        discrete: true,
      });

      expect(calls).toBe(1);
      expect(texts(editor)).toEqual(
        handled
          ? ['before', '<decorator>', 'after']
          : ['before', '<decorator>', ' ', 'after'],
      );
      expect(event.defaultPrevented).toBe(true);
    },
  );

  test('leaves typing in the selected decorator input to the input', () => {
    using editor = createEditor('after');
    const key = editor.read(() => $getRoot().getChildAtIndex(1)!.getKey());
    const input = document.createElement('input');
    editor.getElementByKey(key)!.appendChild(input);
    input.focus();
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'q',
    });

    input.dispatchEvent(event);

    expect(texts(editor)).toEqual(['before', '<decorator>', 'after']);
    expect(event.defaultPrevented).toBe(false);
  });

  test('types into a new paragraph after it, before the block that follows', () => {
    using editor = createEditor('after');

    type(editor, 'q');

    expect(texts(editor)).toEqual(['before', '<decorator>', 'q', 'after']);
    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.getNode().getTopLevelElementOrThrow()).toBe(
        $getRoot().getChildAtIndex(2),
      );
      expect(selection.anchor.offset).toBe(1);
    });
  });

  test('types into the empty paragraph already after it', () => {
    using editor = createEditor('');

    type(editor, 'q');

    expect(texts(editor)).toEqual(['before', '<decorator>', 'q']);
  });

  test('types into the empty heading already after it', () => {
    using editor = createEditor('', () => $createHeadingNode('h1'));

    type(editor, 'q');

    expect(texts(editor)).toEqual(['before', '<decorator>', '<h1>q']);
  });

  test('types into a new paragraph before a heading with text after it', () => {
    using editor = createEditor('Title', () => $createHeadingNode('h1'));

    type(editor, 'q');

    expect(texts(editor)).toEqual(['before', '<decorator>', 'q', '<h1>Title']);
  });

  test('types into a new paragraph when nothing follows', () => {
    using editor = createEditor(null);

    type(editor, 'q');

    expect(texts(editor)).toEqual(['before', '<decorator>', 'q']);
    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect(selection.anchor.getNode().getTopLevelElementOrThrow()).toBe(
        $getRoot().getLastChildOrThrow(),
      );
    });
  });

  test('leaves a range selection where it was', () => {
    using editor = createEditor('after');
    editor.update(() => $getRoot().getFirstChildOrThrow().selectEnd(), {
      discrete: true,
    });

    type(editor, 'q');

    expect(texts(editor)).toEqual(['before', '<decorator>', 'after']);
    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect(selection.anchor.getNode().getTopLevelElementOrThrow()).toBe(
        $getRoot().getFirstChildOrThrow(),
      );
    });
  });
});
