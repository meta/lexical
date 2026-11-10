/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

import {
  $isHorizontalRuleNode,
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {$isHeadingNode} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  defineExtension,
  type ElementNode,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {
  MdastCommonMarkExtension,
  MdastGfmExtension,
  MdastShortcutsExtension,
} from '../../index';

// A block shortcut converts the whole paragraph. A TextNode can hold a
// newline (when app code inserts text that contains one), and then the text
// before the caret is more than one line: a marker on its first line must not
// convert it, which used to strip the lines after the marker.

function createEditor(): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        MdastCommonMarkExtension,
        MdastGfmExtension,
        MdastShortcutsExtension,
      ],
      name: '[mdast-shortcuts-multiline-text]',
    }),
  );
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      $getRoot().clear().append(paragraph);
      paragraph.selectEnd();
    },
    {discrete: true},
  );
  return editor;
}

/** Inserts each chunk at the selection in its own update. */
function type(editor: LexicalEditor, chunks: string[]): void {
  for (const chunk of chunks) {
    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(chunk);
        }
      },
      {discrete: true},
    );
  }
}

const $text = () => $getRoot().getTextContent();

describe('@lexical/mdast block shortcuts on text holding a newline', () => {
  describe.each(['---', '***', '___'])('a thematic break %s', marker => {
    it('Space after a following line keeps that line', () => {
      using editor = createEditor();
      type(editor, [marker + '\nvaluable', ' ']);
      editor.read(() => {
        expect($text()).toBe(marker + '\nvaluable ');
        expect($getRoot().getChildren().some($isHorizontalRuleNode)).toBe(
          false,
        );
      });
    });

    it('Enter after a following line keeps that line', () => {
      using editor = createEditor();
      type(editor, [marker + '\nvaluable']);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      editor.read(() => {
        expect($text()).toContain(marker + '\nvaluable');
        expect($getRoot().getChildren().some($isHorizontalRuleNode)).toBe(
          false,
        );
      });
    });

    it('alone on its line still becomes a rule on Enter', () => {
      using editor = createEditor();
      type(editor, [marker]);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      editor.read(() =>
        expect($getRoot().getChildren().some($isHorizontalRuleNode)).toBe(true),
      );
    });
  });

  it.each(['#', '-', '>', '```\n```', '1.'])(
    'Enter after a line following an empty %s keeps that line',
    marker => {
      using editor = createEditor();
      type(editor, [marker + '\nvaluable']);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      editor.read(() => expect($text()).toContain(marker + '\nvaluable'));
    },
  );

  it.each(['#', '-', '>', '1.'])(
    'Space after a line following an empty %s keeps that line',
    marker => {
      using editor = createEditor();
      type(editor, [marker + '\nvaluable', ' ']);
      editor.read(() => expect($text()).toBe(marker + '\nvaluable '));
    },
  );

  it.each(['\r', '\r\n'])(
    'a carriage return %j is a line break too',
    lineBreak => {
      using editor = createEditor();
      type(editor, ['---' + lineBreak + 'valuable']);
      editor.dispatchCommand(KEY_ENTER_COMMAND, null);
      editor.read(() =>
        expect($text()).toContain('---' + lineBreak + 'valuable'),
      );
    },
  );

  it('a newline after the marker and the caret does not change Enter', () => {
    // The marker `# ` is a whole text node; the newline is in the next one.
    using editor = createEditor();
    type(editor, ['# ']);
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChildOrThrow() as ElementNode;
        const marker = paragraph.getFirstChildOrThrow() as TextNode;
        paragraph.append(
          $createTextNode('valuable\nnotes').toggleFormat('bold'),
        );
        marker.select(2, 2);
      },
      {discrete: true},
    );
    editor.dispatchCommand(KEY_ENTER_COMMAND, null);
    editor.read(() => {
      const heading = $getRoot().getFirstChild();
      expect($isHeadingNode(heading)).toBe(true);
      expect(heading!.getTextContent()).toBe('valuable\nnotes');
    });
  });

  it('a blank line before the marker is not part of it', () => {
    // The text node `\n# ` ends at the caret; content follows in the next
    // one. As on a line of its own, the marker converts the paragraph.
    using editor = createEditor();
    type(editor, ['\n# ']);
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChildOrThrow() as ElementNode;
        const marker = paragraph.getFirstChildOrThrow() as TextNode;
        paragraph.append($createTextNode('valuable').toggleFormat('bold'));
        marker.select(3, 3);
      },
      {discrete: true},
    );
    editor.dispatchCommand(KEY_ENTER_COMMAND, null);
    editor.read(() => {
      const heading = $getRoot().getFirstChild();
      expect($isHeadingNode(heading)).toBe(true);
      expect(heading!.getTextContent()).toBe('valuable');
    });
  });

  it('a blank line and a marker typed after it convert on Space', () => {
    using editor = createEditor();
    type(editor, ['\n#', ' ']);
    editor.read(() =>
      expect($isHeadingNode($getRoot().getFirstChild())).toBe(true),
    );
  });

  it('a marker spanning a line break keeps the text after it on Enter', () => {
    // `>\n> ` is one quote over two lines; content follows in the next node.
    using editor = createEditor();
    type(editor, ['>\n> ']);
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChildOrThrow() as ElementNode;
        const marker = paragraph.getFirstChildOrThrow() as TextNode;
        paragraph.append($createTextNode('valuable').toggleFormat('bold'));
        marker.select(4, 4);
      },
      {discrete: true},
    );
    editor.dispatchCommand(KEY_ENTER_COMMAND, null);
    editor.read(() => expect($text()).toContain('>\n> valuable'));
  });

  it('a heading marker typed on one line still converts on Space', () => {
    using editor = createEditor();
    type(editor, ['#', ' ']);
    editor.read(() =>
      expect($isHeadingNode($getRoot().getFirstChild())).toBe(true),
    );
  });
});
