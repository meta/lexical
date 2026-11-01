/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
} from '@lexical/list';
import {$createHeadingNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

vi.mock('lexical/src/environment', () => ({
  CAN_USE_BEFORE_INPUT: true,
  CAN_USE_DOM: true,
  IS_ANDROID: false,
  IS_ANDROID_CHROME: false,
  IS_APPLE: true,
  IS_APPLE_WEBKIT: true,
  IS_CHROME: false,
  IS_FIREFOX: false,
  IS_IOS: true,
  IS_SAFARI: true,
}));

function createTestEditor($initialEditorState: () => void) {
  return buildEditorFromExtensions({
    $initialEditorState,
    afterRegistration: editor => {
      const root = document.createElement('div');
      root.contentEditable = 'true';
      document.body.append(root);
      editor.setRootElement(root);
      return () => {
        editor.setRootElement(null);
        root.remove();
      };
    },
    dependencies: [RichTextExtension, ListExtension],
    name: '[test]',
  });
}

function dispatchKey(
  editor: LexicalEditor,
  type: 'keydown' | 'keyup',
  key: string,
  shiftKey: boolean,
) {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key,
    shiftKey,
  });
  editor.getRootElement()!.dispatchEvent(event);
  return event;
}

function beforeInput(editor: LexicalEditor, inputType = 'insertParagraph') {
  const beforeinput = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType,
  });
  Object.defineProperty(beforeinput, 'getTargetRanges', {value: () => []});
  editor.getRootElement()!.dispatchEvent(beforeinput);
  expect(beforeinput.defaultPrevented).toBe(true);
}

function pressEnter(editor: LexicalEditor, shiftKey: boolean) {
  const keydown = dispatchKey(editor, 'keydown', 'Enter', shiftKey);
  expect(keydown.defaultPrevented).toBe(false);
  beforeInput(editor);
}

function editorWithText(offset = 10) {
  return createTestEditor(() => {
    const text = $createTextNode('Some words');
    $getRoot().append($createParagraphNode().append(text));
    text.select(offset, offset);
  });
}

function paragraphs(editor: LexicalEditor) {
  return editor.read(() =>
    $getRoot()
      .getChildren()
      .map(node => ({
        text: node.getTextContent(),
        type: node.getType(),
      })),
  );
}

describe('iOS line breaks and auto-capitalization', () => {
  test.each([0, 5, 10])(
    'inserts a line break at offset %i after an explicit Shift keydown',
    offset => {
      using editor = editorWithText(offset);
      dispatchKey(editor, 'keydown', 'Shift', true);
      pressEnter(editor, true);
      expect(paragraphs(editor)).toEqual([
        {
          text:
            'Some words'.slice(0, offset) + '\n' + 'Some words'.slice(offset),
          type: 'paragraph',
        },
      ]);
    },
  );

  test('supports repeated Enter while explicit Shift remains active', () => {
    using editor = editorWithText();
    dispatchKey(editor, 'keydown', 'Shift', true);
    pressEnter(editor, true);
    editor.read(() => {});
    dispatchKey(editor, 'keyup', 'Enter', true);
    pressEnter(editor, true);
    expect(paragraphs(editor)).toEqual([
      {text: 'Some words\n\n', type: 'paragraph'},
    ]);
  });

  test('remembers Enter intent if Shift is released before beforeinput', () => {
    using editor = editorWithText();
    dispatchKey(editor, 'keydown', 'Shift', true);
    dispatchKey(editor, 'keydown', 'Enter', true);
    dispatchKey(editor, 'keyup', 'Shift', false);
    beforeInput(editor);
    expect(paragraphs(editor)).toEqual([
      {text: 'Some words\n', type: 'paragraph'},
    ]);
  });

  test('consumes Enter intent when the browser reports insertLineBreak', () => {
    using editor = editorWithText();
    dispatchKey(editor, 'keydown', 'Shift', true);
    dispatchKey(editor, 'keydown', 'Enter', true);
    beforeInput(editor, 'insertLineBreak');
    editor.read(() => {});
    // An independent beforeinput without a keydown must not reuse the earlier
    // Enter's intent.
    beforeInput(editor);
    expect(paragraphs(editor)).toEqual([
      {text: 'Some words\n', type: 'paragraph'},
      {text: '', type: 'paragraph'},
    ]);
  });

  test('does not retain Enter intent when a command prevents its default', () => {
    using editor = editorWithText();
    editor.registerCommand(
      KEY_ENTER_COMMAND,
      event => {
        event?.preventDefault();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    dispatchKey(editor, 'keydown', 'Shift', true);
    expect(dispatchKey(editor, 'keydown', 'Enter', true).defaultPrevented).toBe(
      true,
    );
    beforeInput(editor);
    expect(paragraphs(editor)).toEqual([
      {text: 'Some words', type: 'paragraph'},
      {text: '', type: 'paragraph'},
    ]);
  });

  test('does not retain line-break intent after handling Control+O', () => {
    using editor = editorWithText();
    editor.getRootElement()!.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: 'o',
      }),
    );
    expect(paragraphs(editor)).toEqual([
      {text: 'Some words\n', type: 'paragraph'},
    ]);
    beforeInput(editor);
    expect(paragraphs(editor)).toEqual([
      {text: 'Some words', type: 'paragraph'},
      {text: '\n', type: 'paragraph'},
    ]);
  });

  test.each([
    ['keyup', 'Shift', false],
    ['keyup', 'A', false],
    ['keydown', 'a', false],
    ['keydown', 'CapsLock', true],
  ] as const)(
    'clears explicit Shift on %s %s with shiftKey=%s',
    (type, key, shiftKey) => {
      using editor = editorWithText();
      dispatchKey(editor, 'keydown', 'Shift', true);
      dispatchKey(editor, type, key, shiftKey);
      // Automatic capitalization can set the flag again without another
      // explicit Shift keydown.
      pressEnter(editor, true);
      expect(paragraphs(editor)).toEqual([
        {text: 'Some words', type: 'paragraph'},
        {text: '', type: 'paragraph'},
      ]);
    },
  );

  test('clears explicit Shift on blur', () => {
    using editor = editorWithText();
    dispatchKey(editor, 'keydown', 'Shift', true);
    editor.getRootElement()!.dispatchEvent(new FocusEvent('blur'));
    pressEnter(editor, true);
    expect(paragraphs(editor)).toEqual([
      {text: 'Some words', type: 'paragraph'},
      {text: '', type: 'paragraph'},
    ]);
  });

  // A read-only editor dispatches no BLUR_COMMAND, but a blur still ends
  // the keyboard state of its last edit.
  test('clears explicit Shift on blur while read-only', () => {
    using editor = editorWithText();
    dispatchKey(editor, 'keydown', 'Shift', true);
    editor.setEditable(false);
    editor.getRootElement()!.dispatchEvent(new FocusEvent('blur'));
    editor.setEditable(true);
    pressEnter(editor, true);
    expect(paragraphs(editor)).toEqual([
      {text: 'Some words', type: 'paragraph'},
      {text: '', type: 'paragraph'},
    ]);
  });

  test('clears Enter intent on blur while read-only', () => {
    using editor = editorWithText();
    dispatchKey(editor, 'keydown', 'Shift', true);
    dispatchKey(editor, 'keydown', 'Enter', true);
    editor.setEditable(false);
    editor.getRootElement()!.dispatchEvent(new FocusEvent('blur'));
    editor.setEditable(true);
    beforeInput(editor);
    expect(paragraphs(editor)).toEqual([
      {text: 'Some words', type: 'paragraph'},
      {text: '', type: 'paragraph'},
    ]);
  });

  test('does not share explicit Shift between editors', () => {
    using first = editorWithText();
    using second = editorWithText();
    dispatchKey(first, 'keydown', 'Shift', true);
    pressEnter(second, true);
    expect(paragraphs(second)).toEqual([
      {text: 'Some words', type: 'paragraph'},
      {text: '', type: 'paragraph'},
    ]);
  });

  test('does not retain Shift after replacing the root element', () => {
    using editor = editorWithText();
    dispatchKey(editor, 'keydown', 'Shift', true);
    const root = editor.getRootElement()!;
    editor.setRootElement(null);
    editor.setRootElement(root);
    pressEnter(editor, true);
    expect(paragraphs(editor)).toEqual([
      {text: 'Some words', type: 'paragraph'},
      {text: '', type: 'paragraph'},
    ]);
  });

  test('inserts a paragraph for unshifted Enter', () => {
    using editor = createTestEditor(() => {
      const text = $createTextNode('Some words');
      $getRoot().append($createParagraphNode().append(text));
      text.selectEnd();
    });
    pressEnter(editor, false);
    expect(paragraphs(editor)).toEqual([
      {text: 'Some words', type: 'paragraph'},
      {text: '', type: 'paragraph'},
    ]);
  });

  test('inserts another paragraph when iOS auto-shifts after Enter', () => {
    using editor = createTestEditor(() => {
      const text = $createTextNode('Some words');
      $getRoot().append($createParagraphNode().append(text));
      text.selectEnd();
    });
    pressEnter(editor, false);
    editor.read(() => {});
    pressEnter(editor, true);
    expect(paragraphs(editor)).toEqual([
      {text: 'Some words', type: 'paragraph'},
      {text: '', type: 'paragraph'},
      {text: '', type: 'paragraph'},
    ]);
  });

  test('inserts a paragraph before a heading with auto-shift active (#4335)', () => {
    using editor = createTestEditor(() => {
      const text = $createTextNode('Heading');
      $getRoot().append($createHeadingNode('h2').append(text));
      text.selectStart();
    });
    pressEnter(editor, true);
    expect(paragraphs(editor)).toEqual([
      {text: '', type: 'paragraph'},
      {text: 'Heading', type: 'heading'},
    ]);
  });

  test('exits an empty list item with auto-shift active (#4266)', () => {
    using editor = createTestEditor(() => {
      const item = $createListItemNode();
      $getRoot().append($createListNode('bullet').append(item));
      item.selectStart();
    });
    pressEnter(editor, true);
    expect(paragraphs(editor)).toEqual([{text: '', type: 'paragraph'}]);
  });
});
