/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  effect,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$convertFromMarkdownString} from '@lexical/mdast';
import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
} from 'lexical';
import {assert, expect, onTestFinished, test, vi} from 'vitest';
import {userEvent} from 'vitest/browser';

import {MdastEditorExtension} from '../../extensions/MdastEditorExtension';
import {ToolbarStateExtension} from '../../extensions/ToolbarStateExtension';

function mountEditor(markdown: string) {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  const editor = buildEditorFromExtensions(ToolbarStateExtension);
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  const toolbar = getExtensionDependencyFromEditor(
    editor,
    ToolbarStateExtension,
  ).output;
  // Subscribe like ToolbarPlugin so the watched editor-state signal updates.
  onTestFinished(
    effect(() => {
      void toolbar.blockType.value;
      void toolbar.isBold.value;
      void toolbar.isItalic.value;
      void toolbar.isCode.value;
    }),
  );
  editor.update(() => $convertFromMarkdownString(markdown), {discrete: true});
  return {editor, root, toolbar};
}

test.each(['', '# Heading\n\nParagraph'])(
  'reads a root-anchored selection in %j without losing pending formats',
  markdown => {
    const {editor, toolbar} = mountEditor(markdown);
    editor.update(
      () => {
        const selection = $createRangeSelection();
        selection.anchor.set('root', 0, 'element');
        selection.focus.set('root', $getRoot().getChildrenSize(), 'element');
        selection.toggleFormat('bold');
        selection.toggleFormat('italic');
        selection.toggleFormat('code');
        $setSelection(selection);
      },
      {discrete: true},
    );
    expect(toolbar.blockType.value).toBe('paragraph');
    expect(toolbar.isBold.value).toBe(true);
    expect(toolbar.isItalic.value).toBe(true);
    expect(toolbar.isCode.value).toBe(true);
  },
);

test.each(['', '\n\n[^a]: Footnote'])(
  'the toolbar survives select-all and Backspace with footnotes %j',
  async footnotes => {
    const {editor, root, toolbar} = mountEditor(
      '# Heading\n\n**Bold** and *italic* text[^a].\n\n' +
        '- List item\n\n> [!NOTE]\n> Alert' +
        footnotes,
    );
    editor.update(() => $getRoot().selectStart(), {discrete: true});
    root.focus();
    window.focus();
    await vi.waitFor(() => expect(toolbar.blockType.value).toBe('h1'));

    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}');
    await vi.waitFor(() => {
      editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect(selection.isCollapsed()).toBe(false);
      });
      expect(toolbar.blockType.value).toBe('h1');
    });
    await userEvent.keyboard('{Backspace}');
    const {markdown} = getExtensionDependencyFromEditor(
      editor,
      MdastEditorExtension,
    ).output;
    await vi.waitFor(() => {
      // Select-all covers the root's children; footnote definitions occupy a
      // separate slot and remain outside that selection.
      expect(markdown.value).toBe(footnotes);
      expect(toolbar.blockType.value).toBe('paragraph');
      expect(toolbar.isBold.value).toBe(false);
      expect(toolbar.isItalic.value).toBe(false);
      expect(toolbar.isCode.value).toBe(false);
    });

    await userEvent.keyboard('replacement');
    await vi.waitFor(() =>
      expect(markdown.value).toBe('replacement' + footnotes),
    );
  },
);
