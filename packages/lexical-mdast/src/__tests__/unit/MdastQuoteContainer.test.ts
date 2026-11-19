/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  type AnyLexicalExtensionArgument,
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {
  $createQuoteContainerNode,
  QuoteContainerReplacementExtension,
} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  defineExtension,
  type LexicalNode,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  MdastCommonMarkExtension,
  MdastExtension,
  MdastQuoteContainerExtension,
  MdastShortcutsExtension,
} from '../../index';

function createEditor(
  ...extensions: AnyLexicalExtensionArgument[]
): LexicalEditorWithDispose {
  // The caller is responsible for disposal (with `using`).
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [MdastCommonMarkExtension, MdastExtension, ...extensions],
      name: '[root]',
    }),
  );
}

function $describe(node: LexicalNode): string {
  return $isElementNode(node)
    ? `${node.getType()}(${node.getChildren().map($describe).join(' ')})`
    : JSON.stringify(node.getTextContent());
}

const describeRoot = (editor: LexicalEditorWithDispose): string =>
  editor.read(() => $getRoot().getChildren().map($describe).join(' / '));

function importMarkdown(
  editor: LexicalEditorWithDispose,
  markdown: string,
): string {
  editor.update(() => $convertFromMarkdownString(markdown), {discrete: true});
  return describeRoot(editor);
}

const CASES: [name: string, markdown: string, expected: string][] = [
  [
    'simple quote',
    '> quoted text',
    'quote-container(paragraph("quoted text"))',
  ],
  [
    'multi-paragraph quote',
    '> para one\n>\n> para two',
    'quote-container(paragraph("para one") paragraph("para two"))',
  ],
  [
    'quote with a nested list',
    '> intro\n>\n> - a\n> - b',
    'quote-container(paragraph("intro") list(listitem("a") listitem("b")))',
  ],
  [
    'quote with a code block',
    '> before\n>\n> ```\n> code\n> ```',
    'quote-container(paragraph("before") code("code"))',
  ],
  [
    'nested quote',
    '> outer\n>\n> > inner',
    'quote-container(paragraph("outer") quote-container(paragraph("inner")))',
  ],
  [
    'quote with a heading',
    '> # Title\n>\n> body',
    'quote-container(heading("Title") paragraph("body"))',
  ],
  [
    'quote holding only a list item, a heading and fenced code',
    '> - item\n>\n> # heading\n>\n> ```js\n> let x;\n> ```',
    'quote-container(list(listitem("item")) heading("heading") code("let x;"))',
  ],
];

describe.each([
  ['MdastQuoteContainerExtension', MdastQuoteContainerExtension],
  [
    'QuoteNode replaced by QuoteContainerNode',
    QuoteContainerReplacementExtension,
  ],
] as const)('@lexical/mdast blockquotes with %s', (_name, extension) => {
  it.each(CASES)('imports %s', (_case, markdown, expected) => {
    using editor = createEditor(extension);
    expect(importMarkdown(editor, markdown)).toBe(expected);
  });

  it.each(CASES)('round-trips %s', (_case, markdown) => {
    using editor = createEditor(extension);
    const imported = importMarkdown(editor, markdown);
    const exported = editor.read(() => $convertToMarkdownString());
    expect(exported).toBe(markdown);
    expect(importMarkdown(editor, exported)).toBe(imported);
  });

  it.each([
    ['soft break stays soft', '> line one\n> line two'],
    ['hard break stays hard', '> line one\\\n> line two'],
  ])('%s', (_case, markdown) => {
    using editor = createEditor(extension);
    importMarkdown(editor, markdown);
    expect(editor.read(() => $convertToMarkdownString())).toBe(markdown);
  });
});

describe('@lexical/mdast and QuoteContainerNode', () => {
  it('without either extension, a blockquote imports as a QuoteNode', () => {
    using editor = createEditor();
    expect(importMarkdown(editor, '> a\n>\n> b')).toBe('quote("a" "\\n" "b")');
  });

  it('exports a container built in the editor', () => {
    using editor = createEditor(MdastQuoteContainerExtension);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createQuoteContainerNode().append(
              $createParagraphNode().append($createTextNode('a')),
              $createQuoteContainerNode().append(
                $createParagraphNode().append($createTextNode('b')),
              ),
            ),
          );
      },
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe('> a\n>\n> > b');
  });

  it('the "> " shortcut makes a container, the caret in its paragraph, where QuoteNode is replaced', () => {
    using editor = createEditor(
      QuoteContainerReplacementExtension,
      MdastShortcutsExtension,
    );
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().clear().append(paragraph);
        paragraph.selectEnd();
      },
      {discrete: true},
    );
    for (const chunk of ['>', ' ', 'quoted']) {
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
    expect(describeRoot(editor)).toBe('quote-container(paragraph("quoted"))');
  });
});
