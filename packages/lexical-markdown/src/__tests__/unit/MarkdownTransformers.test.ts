/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {CodeExtension} from '@lexical/code-core';
import {buildEditorFromExtensions} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {$createLinkNode, $isLinkNode, LinkExtension} from '@lexical/link';
import {ListExtension} from '@lexical/list';
import {registerMarkdownShortcuts} from '@lexical/markdown';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  defineExtension,
  type LexicalEditor,
  UNDO_COMMAND,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

const MarkdownShortcutTestExtension = defineExtension({
  dependencies: [
    HistoryExtension,
    LinkExtension,
    RichTextExtension,
    ListExtension,
    CodeExtension,
  ],
  name: 'MarkdownShortcutTest',
  register: editor_ => registerMarkdownShortcuts(editor_),
});

function typeMarkdown(editor: LexicalEditor, text: string) {
  editor.update(() => {
    const selection = $getSelection();
    if (!($isRangeSelection(selection) && selection.isCollapsed())) {
      $getRoot().selectEnd();
    }
  });
  for (const char of text) {
    editor.update(() => $getSelection()?.insertText(char), {discrete: true});
  }
  // Markdown shortcuts issues a cascading update that is not
  // discrete, so force sync reconciliation with a read.
  editor.read(() => {});
}

describe('LINK', () => {
  test('text before a markdown link is preserved', () => {
    using editor = buildEditorFromExtensions([MarkdownShortcutTestExtension]);
    typeMarkdown(editor, 'Start [test](url)');
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      const children = paragraph.getChildren();
      expect(children.map(node => node.getTextContent())).toEqual([
        'Start ',
        'test',
      ]);
      assert($isLinkNode(children[1]), 'Second child must be a LinkNode');
    });
  });

  test('formatted text before a markdown link is preserved', () => {
    using editor = buildEditorFromExtensions([MarkdownShortcutTestExtension]);
    typeMarkdown(editor, '**Bold** [Link](url)');

    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      const children = paragraph.getChildren();

      expect(children.map(node => node.getTextContent())).toEqual([
        'Bold',
        ' ',
        'Link',
      ]);

      const linkNode = children[2];
      assert($isLinkNode(linkNode), 'Third child must be a LinkNode');
      expect(linkNode.getTextContent()).toBe('Link');
      expect(linkNode.getURL()).toBe('url');
    });
  });

  test('LINK is not too greedy if there is a preceding match that was not processed', () => {
    // https://github.com/facebook/lexical/issues/8129
    using editor = buildEditorFromExtensions([MarkdownShortcutTestExtension]);
    // Set up initial condition, since we are not typing a character at a time
    // it's not handled by markdown shortcuts in this update
    editor.update(
      () => {
        $getRoot()
          .selectEnd()
          .insertRawText(
            `[a](https://a.example.com) [b](https://b.example.com`,
          );
      },
      {discrete: true},
    );
    typeMarkdown(editor, ')');
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      const children = paragraph.getChildren();

      expect(children.map(node => node.getTextContent())).toEqual([
        '[a](https://a.example.com) ',
        'b',
      ]);

      const linkNode = children[1];
      assert($isLinkNode(linkNode), 'Second child must be a LinkNode');
      expect(linkNode.getTextContent()).toBe('b');
      expect(linkNode.getURL()).toBe('https://b.example.com');
    });
  });

  test('a destination between angle brackets keeps the whitespace in the URL', () => {
    using editor = buildEditorFromExtensions([MarkdownShortcutTestExtension]);
    typeMarkdown(editor, '[test](<https://example.com/a b>)');

    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      const children = paragraph.getChildren();

      expect(children).toHaveLength(1);

      const linkNode = children[0];
      assert($isLinkNode(linkNode), 'First child must be a LinkNode');
      expect(linkNode.getTextContent()).toBe('test');
      expect(linkNode.getURL()).toBe('https://example.com/a b');
    });
  });

  test('markdown link should not be created inside another link.', async () => {
    using editor = buildEditorFromExtensions([MarkdownShortcutTestExtension]);
    editor.update(
      () => {
        $getRoot()
          .selectEnd()
          .insertNodes([
            $createParagraphNode().append(
              $createLinkNode('link').append($createTextNode('hello')),
            ),
          ]);
      },
      {discrete: true},
    );

    // moves the cursor inside the link text: hell‸o
    editor.update(() => $getRoot().getAllTextNodes()[0].select(4, 4), {
      discrete: true,
    });

    typeMarkdown(editor, '[world](www)');

    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      const children = paragraph.getChildren();

      expect(children.length).toBe(1);

      const linkNode = children[0];
      assert($isLinkNode(linkNode), 'First child must be a LinkNode');
      expect(linkNode.getTextContent()).toBe('hell[world](www)o');
      expect(linkNode.getURL()).toBe('link');
    });
  });
});

describe('CODE_SPAN_PRECEDENCE', () => {
  test('__bold__ inside backticks is not formatted as bold', () => {
    using editor = buildEditorFromExtensions([MarkdownShortcutTestExtension]);
    typeMarkdown(editor, '`__bold__`');
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      const children = paragraph.getChildren();
      expect(children).toHaveLength(1);
      const textNode = children[0];
      assert($isTextNode(textNode), 'Child must be a TextNode');
      expect(textNode.getTextContent()).toBe('__bold__');
      expect(textNode.hasFormat('code')).toBe(true);
      expect(textNode.hasFormat('bold')).toBe(false);
    });
  });

  test('**bold** inside backticks is not formatted as bold', () => {
    using editor = buildEditorFromExtensions([MarkdownShortcutTestExtension]);
    typeMarkdown(editor, '`**bold**`');
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      const children = paragraph.getChildren();
      expect(children).toHaveLength(1);
      const textNode = children[0];
      assert($isTextNode(textNode), 'Child must be a TextNode');
      expect(textNode.getTextContent()).toBe('**bold**');
      expect(textNode.hasFormat('code')).toBe(true);
      expect(textNode.hasFormat('bold')).toBe(false);
    });
  });

  test('*italic* inside backticks is not formatted as italic', () => {
    using editor = buildEditorFromExtensions([MarkdownShortcutTestExtension]);
    typeMarkdown(editor, '`*italic*`');
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      const children = paragraph.getChildren();
      expect(children).toHaveLength(1);
      const textNode = children[0];
      assert($isTextNode(textNode), 'Child must be a TextNode');
      expect(textNode.getTextContent()).toBe('*italic*');
      expect(textNode.hasFormat('code')).toBe(true);
      expect(textNode.hasFormat('italic')).toBe(false);
    });
  });

  test('__bold__ without backticks still formats as bold', () => {
    using editor = buildEditorFromExtensions([MarkdownShortcutTestExtension]);
    typeMarkdown(editor, '__bold__');
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      const children = paragraph.getChildren();
      expect(children).toHaveLength(1);
      const textNode = children[0];
      assert($isTextNode(textNode), 'Child must be a TextNode');
      expect(textNode.getTextContent()).toBe('bold');
      expect(textNode.hasFormat('bold')).toBe(true);
    });
  });

  test('__bold__ after a completed code span still formats as bold', () => {
    using editor = buildEditorFromExtensions([MarkdownShortcutTestExtension]);
    typeMarkdown(editor, '`code` __bold__');
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      const textNodes = paragraph
        .getChildren()
        .filter(node => $isTextNode(node));
      const boldNode = textNodes.find(
        node => $isTextNode(node) && node.hasFormat('bold'),
      );
      expect(boldNode).toBeDefined();
      assert($isTextNode(boldNode!), 'Bold node must be a TextNode');
      expect(boldNode!.getTextContent()).toBe('bold');
    });
  });
});

describe('WRAPPING_PRESERVES_FORMAT', () => {
  test('**...** around already-bold text preserves bold', () => {
    // https://github.com/facebook/lexical/issues/8727
    using editor = buildEditorFromExtensions([MarkdownShortcutTestExtension]);
    editor.update(
      () => {
        const textNode = $createTextNode('**bold*').toggleFormat('bold');
        $getRoot()
          .selectEnd()
          .insertNodes([$createParagraphNode().append(textNode)]);
        textNode.selectEnd().setFormat(textNode.getFormat());
      },
      {discrete: true},
    );
    typeMarkdown(editor, '*');
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      const children = paragraph.getChildren();
      expect(children).toHaveLength(1);
      const textNode = children[0];
      assert($isTextNode(textNode), 'Child must be a TextNode');
      expect(textNode.getTextContent()).toBe('bold');
      expect(textNode.hasFormat('bold')).toBe(true);
    });
  });

  test('**...** around mixed-format text formats every wrapped node bold', () => {
    // https://github.com/facebook/lexical/issues/8727
    using editor = buildEditorFromExtensions([MarkdownShortcutTestExtension]);
    editor.update(
      () => {
        const plainNode = $createTextNode('**foo');
        const boldNode = $createTextNode('bar*');
        boldNode.toggleFormat('bold');
        $getRoot()
          .selectEnd()
          .insertNodes([
            $createParagraphNode().append(plainNode).append(boldNode),
          ]);
        boldNode.selectEnd().setFormat(boldNode.getFormat());
      },
      {discrete: true},
    );
    typeMarkdown(editor, '*');
    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      expect(paragraph.getTextContent()).toBe('foobar');
      const textNodes = paragraph
        .getChildren()
        .filter(node => $isTextNode(node));
      expect(textNodes.every(node => node.hasFormat('bold'))).toBe(true);
    });
  });
});

describe('HISTORY', () => {
  test('undo after markdown format transform preserves typed markdown text', () => {
    using editor = buildEditorFromExtensions([MarkdownShortcutTestExtension]);
    typeMarkdown(editor, 'lorem *ipsum*');

    editor.update(
      () => {
        editor.dispatchCommand(UNDO_COMMAND);
      },
      {discrete: true},
    );

    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      expect(paragraph.getTextContent()).toBe('lorem *ipsum*');
    });
  });
});
