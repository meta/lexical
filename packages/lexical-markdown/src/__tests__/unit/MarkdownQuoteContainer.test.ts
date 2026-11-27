/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {CodeExtension} from '@lexical/code-core';
import {
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
} from '@lexical/list';
import {
  $convertFromMarkdownString,
  $convertSelectionToMarkdownString,
  $convertToMarkdownString,
  QUOTE,
  QUOTE_CONTAINER,
  registerMarkdownShortcuts,
  type Transformer,
  TRANSFORMERS,
} from '@lexical/markdown';
import {
  $createHeadingNode,
  $createQuoteContainerNode,
  $createQuoteNode,
  QuoteContainerExtension,
  QuoteContainerReplacementExtension,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  type AnyLexicalExtensionArgument,
  defineExtension,
  KEY_ENTER_COMMAND,
  type LexicalNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

function createEditor(
  ...dependencies: AnyLexicalExtensionArgument[]
): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(
    defineExtension({dependencies, name: 'markdown-quote-container-host'}),
  );
  onTestFinished(() => editor.dispose());
  return editor;
}

function $describe(node: LexicalNode): string {
  return $isElementNode(node)
    ? `${node.getType()}(${node.getChildren().map($describe).join(' ')})`
    : JSON.stringify(node.getTextContent());
}

const describeRoot = (editor: LexicalEditorWithDispose): string =>
  editor.read(() => $getRoot().getChildren().map($describe).join(' / '));

const $p = (text?: string) =>
  text === undefined
    ? $createParagraphNode()
    : $createParagraphNode().append($createTextNode(text));

/** TRANSFORMERS with QUOTE_CONTAINER in place of QUOTE. */
const CONTAINER_TRANSFORMERS: Transformer[] = TRANSFORMERS.map(transformer =>
  transformer === QUOTE ? QUOTE_CONTAINER : transformer,
);

function importMarkdown(
  editor: LexicalEditorWithDispose,
  markdown: string,
  transformers: Transformer[],
): string {
  editor.update(() => $convertFromMarkdownString(markdown, transformers), {
    discrete: true,
  });
  return describeRoot(editor);
}

const exportMarkdown = (
  editor: LexicalEditorWithDispose,
  transformers: Transformer[],
): string => editor.read(() => $convertToMarkdownString(transformers));

const CASES: [name: string, markdown: string, expected: string][] = [
  ['one line', '> a', 'quote-container(paragraph("a"))'],
  [
    'lines that follow one another are one paragraph',
    '> a\n> b',
    'quote-container(paragraph("a" "\\n" "b"))',
  ],
  [
    'an empty quote line starts the next paragraph',
    '> a\n> \n> b\n> c',
    'quote-container(paragraph("a") paragraph("b" "\\n" "c"))',
  ],
  [
    'text around the quote',
    'before\n\n> a\n> \n> b\n\nafter',
    'paragraph("before") / quote-container(paragraph("a") paragraph("b")) / paragraph("after")',
  ],
  [
    'a bare ">" line starts the next paragraph (CommonMark)',
    '> a\n>\n> b',
    'quote-container(paragraph("a") paragraph("b"))',
  ],
  [
    'a line that continues the quote without a marker',
    '> a\nb',
    'quote-container(paragraph("a" "\\n" "b"))',
  ],
];

describe.each([
  [
    'QuoteNode replaced by QuoteContainerNode, QUOTE',
    QuoteContainerReplacementExtension,
    TRANSFORMERS,
  ],
  [
    'QuoteContainerNode registered, QUOTE_CONTAINER',
    QuoteContainerExtension,
    CONTAINER_TRANSFORMERS,
  ],
] as const)('Markdown quotes: %s', (_name, extension, transformers) => {
  test.each(CASES)('imports %s', (_case, markdown, expected) => {
    const editor = createEditor(extension);
    expect(importMarkdown(editor, markdown, transformers)).toBe(expected);
  });

  test.each(CASES.slice(0, 4))('round-trips %s', (_case, markdown) => {
    const editor = createEditor(extension);
    const imported = importMarkdown(editor, markdown, transformers);
    const exported = exportMarkdown(editor, transformers);
    expect(exported).toBe(markdown);
    expect(importMarkdown(editor, exported, transformers)).toBe(imported);
  });
});

/** Blocks inside a quote that `@lexical/markdown` reads only as text. */
const BLOCKS_IN_A_QUOTE = [
  '> ## two',
  '> - a',
  '> ```js',
  '> let x;',
  '> ```',
].join('\n');

describe.each([
  [
    'QuoteNode replaced by QuoteContainerNode, QUOTE',
    QuoteContainerReplacementExtension,
    TRANSFORMERS,
  ],
  [
    'QuoteContainerNode registered, QUOTE_CONTAINER',
    QuoteContainerExtension,
    CONTAINER_TRANSFORMERS,
  ],
] as const)(
  'Known limit, blocks inside a quote: %s',
  (_name, extension, transformers) => {
    test('import reads them as the text of one paragraph (@lexical/mdast reads the blocks)', () => {
      const editor = createEditor(extension, ListExtension, CodeExtension);
      expect(importMarkdown(editor, BLOCKS_IN_A_QUOTE, transformers)).toBe(
        'quote-container(paragraph("## two" "\\n" "- a" "\\n" "```js" "\\n" "let x;" "\\n" "```"))',
      );
    });
  },
);

describe.each([
  [
    'QuoteNode replaced by QuoteContainerNode, QUOTE',
    QuoteContainerReplacementExtension,
    TRANSFORMERS,
  ],
  [
    'QuoteContainerNode registered, QUOTE_CONTAINER',
    QuoteContainerExtension,
    CONTAINER_TRANSFORMERS,
  ],
] as const)(
  'Markdown quote containers, edge cases: %s',
  (_name, extension, transformers) => {
    test('round trips with shouldMergeAdjacentLines are stable', () => {
      const editor = createEditor(extension, ListExtension, CodeExtension);
      let markdown = '> ## h\n> \n> t';
      const exports: string[] = [];
      for (let i = 0; i < 3; i++) {
        editor.update(
          () =>
            $convertFromMarkdownString(
              markdown,
              transformers,
              undefined,
              false,
              true,
            ),
          {discrete: true},
        );
        markdown = exportMarkdown(editor, transformers);
        exports.push(markdown);
      }
      expect(exports).toEqual([
        '> ## h\n> \n> t',
        '> ## h\n> \n> t',
        '> ## h\n> \n> t',
      ]);
      expect(describeRoot(editor)).toBe(
        'quote-container(paragraph("## h") paragraph("t"))',
      );
    });

    test('with shouldPreserveNewLines, export writes each line once (whole document and selection)', () => {
      const editor = createEditor(extension);
      editor.update(
        () =>
          $convertFromMarkdownString('> a\n> b', transformers, undefined, true),
        {discrete: true},
      );
      expect(describeRoot(editor)).toBe(
        'quote-container(paragraph("a" "\\n" "b"))',
      );
      expect(
        editor.read(() =>
          $convertToMarkdownString(transformers, undefined, true),
        ),
      ).toBe('> a\n> b');
      editor.update(
        () => {
          $getRoot().select(0, $getRoot().getChildrenSize());
        },
        {discrete: true},
      );
      expect(
        editor.read(() =>
          $convertSelectionToMarkdownString(
            transformers,
            $getSelection(),
            true,
          ),
        ),
      ).toBe('> a\n> b');
    });
  },
);

describe('normalizeMarkdown with shouldMergeAdjacentLines, a QuoteNode of inline content', () => {
  test('keeps a bare ">" line inside a quote as a blank quote line, not text merged into the line before', () => {
    const editor = createEditor(RichTextExtension);
    editor.update(
      () =>
        $convertFromMarkdownString(
          '> a\n>\n> b',
          TRANSFORMERS,
          undefined,
          false,
          true,
        ),
      {discrete: true},
    );
    // It read `quote("a >" "\n" "b")`.
    expect(describeRoot(editor)).toBe('quote("a" "\\n" "\\n" "b")');
  });

  test('a bare ">" line outside a quote is merged as before', () => {
    const editor = createEditor(RichTextExtension);
    editor.update(
      () =>
        $convertFromMarkdownString(
          'a\n>\nb',
          TRANSFORMERS,
          undefined,
          false,
          true,
        ),
      {discrete: true},
    );
    expect(describeRoot(editor)).toBe('paragraph("a > b")');
  });
});

describe('Markdown export of a QuoteNode with the shadowRoot state', () => {
  test('writes its blocks as a quote container does', () => {
    const editor = createEditor(RichTextExtension, ListExtension);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createQuoteNode({shadowRoot: true}).append(
              $p('one'),
              $createListNode('bullet').append(
                $createListItemNode().append($createTextNode('a')),
              ),
              $p('two'),
            ),
          );
      },
      {discrete: true},
    );
    expect(exportMarkdown(editor, TRANSFORMERS)).toBe(
      ['> one', '> ', '> - a', '> ', '> two'].join('\n'),
    );
  });
});

describe('Markdown export of a QuoteContainerNode', () => {
  test('writes every block behind "> ", a blank quote line between two', () => {
    const editor = createEditor(QuoteContainerExtension, ListExtension);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createQuoteContainerNode().append(
              $p('one'),
              $createHeadingNode('h2').append($createTextNode('two')),
              $createListNode('bullet').append(
                $createListItemNode().append($createTextNode('a')),
                $createListItemNode().append($createTextNode('b')),
              ),
              $createQuoteContainerNode().append($p('inner'), $p('more')),
              $createQuoteNode().append($createTextNode('legacy')),
            ),
            $p('after'),
          );
      },
      {discrete: true},
    );
    expect(exportMarkdown(editor, TRANSFORMERS)).toBe(
      [
        '> one',
        '> ',
        '> ## two',
        '> ',
        '> - a',
        '> - b',
        '> ',
        '> > inner',
        '> > ',
        '> > more',
        '> ',
        '> > legacy',
        '',
        'after',
      ].join('\n'),
    );
  });

  test('QUOTE exports a QuoteNode as before where the container is registered', () => {
    const editor = createEditor(QuoteContainerExtension);
    expect(importMarkdown(editor, '> a\n> b', TRANSFORMERS)).toBe(
      'quote("a" "\\n" "b")',
    );
    expect(exportMarkdown(editor, TRANSFORMERS)).toBe('> a\n> b');
  });

  test('a caller of QUOTE.export that passes no block exporter gets the paragraphs', () => {
    const editor = createEditor(QuoteContainerExtension);
    editor.update(
      () => {
        const quote = $createQuoteContainerNode().append($p('a'), $p('b'));
        $getRoot().clear().append(quote);
        expect(
          QUOTE.export(quote, node => node.getTextContent().toUpperCase()),
        ).toBe('> A\n> \n> B');
      },
      {discrete: true},
    );
  });
});

describe('Markdown of a selection in a QuoteContainerNode', () => {
  test('writes the selected blocks of the container', () => {
    const editor = createEditor(QuoteContainerExtension);
    editor.update(
      () => {
        const second = $createTextNode('second');
        const third = $createTextNode('third');
        $getRoot()
          .clear()
          .append(
            $createQuoteContainerNode().append(
              $p('first'),
              $createParagraphNode().append(second),
              $createParagraphNode().append(third),
            ),
          );
        const selection = $createRangeSelection();
        selection.anchor.set(second.getKey(), 0, 'text');
        selection.focus.set(third.getKey(), 3, 'text');
        expect($convertSelectionToMarkdownString(TRANSFORMERS, selection)).toBe(
          '> second\n> \n> thi',
        );
      },
      {discrete: true},
    );
  });
});

describe('the "> " shortcut', () => {
  function typeQuote(
    extension: AnyLexicalExtensionArgument,
    transformers: Transformer[],
  ): string {
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [extension],
        name: 'markdown-quote-container-shortcut-host',
        register: target => registerMarkdownShortcuts(target, transformers),
      }),
    );
    onTestFinished(() => editor.dispose());
    editor.update(
      () => {
        const text = $createTextNode('>quoted');
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(1, 1);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(' ');
        }
      },
      {discrete: true},
    );
    return editor.read(() => {
      const selection = $getSelection();
      const anchor = $isRangeSelection(selection)
        ? selection.anchor.getNode()
        : null;
      // The caret is in the line that was typed in.
      expect(anchor === null ? null : anchor.getTextContent()).toBe('quoted');
      return $getRoot().getChildren().map($describe).join(' / ');
    });
  }

  test.each([
    ['QuoteNode only, QUOTE', RichTextExtension, TRANSFORMERS],
    [
      'QuoteNode replaced by QuoteContainerNode, QUOTE',
      QuoteContainerReplacementExtension,
      TRANSFORMERS,
    ],
    [
      'QuoteContainerNode registered, QUOTE_CONTAINER',
      QuoteContainerExtension,
      CONTAINER_TRANSFORMERS,
    ],
  ] as const)(
    'Enter right after a lone ">" leaves the text after it as it is (%s)',
    (_name, extension, transformers) => {
      const editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [extension],
          name: 'markdown-quote-container-enter-host',
          register: target =>
            registerMarkdownShortcuts(
              target,
              transformers.filter(
                transformer =>
                  transformer === QUOTE || transformer === QUOTE_CONTAINER,
              ),
            ),
        }),
      );
      onTestFinished(() => editor.dispose());
      editor.update(
        () => {
          const marker = $createTextNode('>');
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                marker,
                $createLineBreakNode(),
                $createTextNode('next'),
              ),
              $createParagraphNode().append(
                $createTextNode('>'),
                $createTextNode('bold').toggleFormat('bold'),
              ),
            );
          marker.select(1, 1);
        },
        {discrete: true},
      );
      editor.update(
        () => {
          editor.dispatchCommand(KEY_ENTER_COMMAND, null);
        },
        {discrete: true},
      );
      editor.update(
        () => {
          const second = $getRoot().getLastChildOrThrow();
          if ($isElementNode(second)) {
            second.getFirstChildOrThrow().selectEnd();
          }
        },
        {discrete: true},
      );
      editor.update(
        () => {
          editor.dispatchCommand(KEY_ENTER_COMMAND, null);
        },
        {discrete: true},
      );
      // No `>` added to the text after the caret ("next", "bold").
      expect(describeRoot(editor)).toBe(
        'paragraph(">") / paragraph("\\n" "next") / paragraph(">") / paragraph("bold")',
      );
    },
  );

  test('makes a container where QuoteNode is replaced', () => {
    expect(typeQuote(QuoteContainerReplacementExtension, [QUOTE])).toBe(
      'quote-container(paragraph("quoted"))',
    );
  });

  test('makes a container with QUOTE_CONTAINER', () => {
    expect(typeQuote(QuoteContainerExtension, [QUOTE_CONTAINER])).toBe(
      'quote-container(paragraph("quoted"))',
    );
  });

  test('makes a QuoteNode with QUOTE where the container is only registered', () => {
    expect(typeQuote(QuoteContainerExtension, [QUOTE])).toBe('quote("quoted")');
  });
});
