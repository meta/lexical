/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {PlainTextExtension} from '@lexical/plain-text';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  DecoratorNode,
  DELETE_LINE_COMMAND,
  type ParagraphNode,
  type TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

class InlineDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_inline_decorator', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.textContent = 'X';
    return span;
  }
  updateDOM(): boolean {
    return false;
  }
  isInline(): boolean {
    return true;
  }
  decorate(): null {
    return null;
  }
}

const DISPLAYS = ['inline', 'inline-block'] as const;
const LINE_TEXT = ' tu vw xy';

// The second line begins with the decorator. Chromium has no caret position
// between the <br> and a decorator with text (#6916), so the line start it
// measures from that line can be on the line before the <br>.
describe.each([RichTextExtension, PlainTextExtension])('$name', extension => {
  function mountEditor(
    display: (typeof DISPLAYS)[number],
    $select: (paragraph: ParagraphNode, text: TextNode) => void,
  ) {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    root.style.cssText =
      'width: 500px; font: 16px monospace; line-height: 24px; white-space: pre-wrap';
    document.body.appendChild(root);
    const editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        const text = $createTextNode(LINE_TEXT);
        const paragraph = $createParagraphNode().append(
          $createTextNode('pq rs'),
          $createLineBreakNode(),
          $create(InlineDecoratorNode),
          text,
        );
        $getRoot().append(paragraph);
        $select(paragraph, text);
      },
      dependencies: [extension],
      name: '[line-break-decorator-line-deletion]',
      nodes: [InlineDecoratorNode],
    });
    onTestFinished(() => {
      editor.dispose();
      root.remove();
    });
    editor.setRootElement(root);
    root.querySelector<HTMLElement>('[data-lexical-decorator]')!.style.display =
      display;
    return {editor, root};
  }

  test.each(
    DISPLAYS.flatMap(display =>
      [0, 1, 4, 9].map(offset => ({display, offset})),
    ),
  )(
    'backward line deletion after a decorator that begins a line stops at the line break (display: $display, offset: $offset)',
    ({display, offset}) => {
      const {editor, root} = mountEditor(display, (_paragraph, text) =>
        text.select(offset, offset),
      );

      editor.update(() => editor.dispatchCommand(DELETE_LINE_COMMAND, true), {
        discrete: true,
      });
      expect(root.querySelector('[data-lexical-decorator]')).toBeNull();
      expect(editor.read(() => $getRoot().getTextContent())).toBe(
        'pq rs\n' + LINE_TEXT.slice(offset),
      );
    },
  );

  test.each(DISPLAYS)(
    'backward line deletion from the start of a line that begins with a decorator deletes the line break (display: %s)',
    display => {
      const {editor, root} = mountEditor(display, paragraph =>
        paragraph.select(2, 2),
      );

      editor.update(() => editor.dispatchCommand(DELETE_LINE_COMMAND, true), {
        discrete: true,
      });
      expect(root.querySelector('[data-lexical-decorator]')).not.toBeNull();
      expect(editor.read(() => $getRoot().getTextContent())).toBe(
        'pq rs' + LINE_TEXT,
      );
    },
  );
});
