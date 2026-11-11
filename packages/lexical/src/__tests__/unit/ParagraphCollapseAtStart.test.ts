/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test} from 'vitest';

const ext = defineExtension({
  dependencies: [RichTextExtension],
  name: '[paragraph-collapse-at-start]',
});

function createEditor() {
  const editor = buildEditorFromExtensions(ext);
  const element = document.createElement('div');
  element.contentEditable = 'true';
  document.body.appendChild(element);
  editor.setRootElement(element);
  return editor;
}

/** The work Backspace does: KEY_BACKSPACE_COMMAND -> DELETE_CHARACTER_COMMAND. */
function backspace(editor: LexicalEditor): void {
  editor.update(
    () => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.deleteCharacter(true);
      }
    },
    {discrete: true},
  );
}

function $blocks(): string[] {
  return $getRoot()
    .getChildren()
    .map(child => child.getTextContent());
}

describe('ParagraphNode.collapseAtStart', () => {
  test('keeps a first paragraph whose content follows a blank text node', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const first = $createParagraphNode();
        const bold = $createTextNode('hello');
        bold.toggleFormat('bold');
        first.append($createTextNode('  '), bold);
        const second = $createParagraphNode();
        second.append($createTextNode('world'));
        $getRoot().clear().append(first, second);
        first.selectStart();
      },
      {discrete: true},
    );

    backspace(editor);

    editor.read(() => {
      expect($blocks()).toEqual(['  hello', 'world']);
    });
  });

  test('keeps a first paragraph whose only other child is a line break', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const first = $createParagraphNode();
        first.append($createTextNode(' '), $createLineBreakNode());
        const second = $createParagraphNode();
        second.append($createTextNode('world'));
        $getRoot().clear().append(first, second);
        first.selectStart();
      },
      {discrete: true},
    );

    backspace(editor);

    editor.read(() => {
      expect($getRoot().getChildrenSize()).toBe(2);
    });
  });

  test('control: a blank first paragraph is still collapsed away', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const first = $createParagraphNode();
        first.append($createTextNode('  '));
        const second = $createParagraphNode();
        second.append($createTextNode('world'));
        $getRoot().clear().append(first, second);
        first.selectStart();
      },
      {discrete: true},
    );

    backspace(editor);

    editor.read(() => {
      expect($blocks()).toEqual(['world']);
    });
  });

  test('control: an empty first paragraph is still collapsed away', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const first = $createParagraphNode();
        const second = $createParagraphNode();
        second.append($createTextNode('world'));
        $getRoot().clear().append(first, second);
        first.selectStart();
      },
      {discrete: true},
    );

    backspace(editor);

    editor.read(() => {
      expect($blocks()).toEqual(['world']);
    });
  });
});
