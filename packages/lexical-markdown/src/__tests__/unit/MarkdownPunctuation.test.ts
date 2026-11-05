/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {$createLinkNode, LinkExtension, LinkNode} from '@lexical/link';
import {
  $convertFromMarkdownString,
  $convertSelectionToMarkdownString,
  $convertToMarkdownString,
  $generateNodesFromMarkdownString,
  type MarkdownImportOptions,
  type MultilineElementTransformer,
  type PunctuationMode,
  type TextMatchTransformer,
  TRANSFORMERS,
} from '@lexical/markdown';
import {
  $convertFromMarkdownString as $convertFromMdastMarkdownString,
  MdastExtension,
  MdastGfmExtension,
} from '@lexical/mdast';
import {
  $createQuoteNode,
  $isQuoteNode,
  QuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $selectAll,
  configExtension,
  defineExtension,
  type LexicalEditor,
  TEXT_TYPE_TO_FORMAT,
} from 'lexical';
import {assert, describe, expect, it, onTestFinished} from 'vitest';

const {bold, italic, strikethrough} = TEXT_TYPE_TO_FORMAT;

type Runs = [text: string, format: number][];

function $runs(): Runs {
  return $getRoot()
    .getAllTextNodes()
    .map(node => [node.getTextContent(), node.getFormat()]);
}

function createEditor(): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension, LinkExtension],
      name: '[root]',
    }),
  );
  onTestFinished(() => editor.dispose());
  return editor;
}

function createMdastEditor(punctuation: PunctuationMode): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        MdastGfmExtension,
        configExtension(MdastExtension, {importPunctuation: punctuation}),
      ],
      name: '[root]',
    }),
  );
  onTestFinished(() => editor.dispose());
  return editor;
}

function importRuns(markdown: string, punctuation?: PunctuationMode): Runs {
  const editor = createEditor();
  editor.update(
    () =>
      $convertFromMarkdownString(markdown, TRANSFORMERS, undefined, {
        punctuation,
      }),
    {discrete: true},
  );
  return editor.read('latest', $runs);
}

function importMdastRuns(markdown: string, punctuation: PunctuationMode): Runs {
  const editor = createMdastEditor(punctuation);
  editor.update(() => $convertFromMdastMarkdownString(markdown), {
    discrete: true,
  });
  return editor.read('latest', $runs);
}

function exportRuns(runs: Runs, punctuation?: PunctuationMode): string {
  const editor = createEditor();
  editor.update(
    () =>
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append(
            ...runs.map(([text, format]) =>
              $createTextNode(text).setFormat(format),
            ),
          ),
        ),
    {discrete: true},
  );
  return editor.read('latest', () =>
    $convertToMarkdownString(TRANSFORMERS, undefined, {punctuation}),
  );
}

describe('Markdown punctuation modes', () => {
  // markdown, read CJK-friendly, read strictly.
  it.each<[markdown: string, cjkFriendly: Runs, strict: Runs]>([
    [
      '**你好。**世界',
      [
        ['你好。', bold],
        ['世界', 0],
      ],
      [['**你好。**世界', 0]],
    ],
    [
      '中文**「强调」**',
      [
        ['中文', 0],
        ['「强调」', bold],
      ],
      [['中文**「强调」**', 0]],
    ],
    [
      '~~你好。~~세계',
      [
        ['你好。', strikethrough],
        ['세계', 0],
      ],
      [['~~你好。~~세계', 0]],
    ],
    // An ideographic variation selector before a marker counts as CJK.
    [
      '葛\u{e0100}**(a)**',
      [
        ['葛\u{e0100}', 0],
        ['(a)', bold],
      ],
      [['葛\u{e0100}**(a)**', 0]],
    ],
    // Before a marker, a variation selector reads as what it varies.
    [
      'a“︀**(b)**',
      [
        ['a“︀', 0],
        ['(b)', bold],
      ],
      [['a“︀**(b)**', 0]],
    ],
    // `_` still opens and closes inside a word only beside punctuation, and
    // text that is not CJK reads as CommonMark reads it.
    // A variation selector before a closing marker reads as the character
    // it varies; strict readers read a letter, so the run closes for both.
    [
      'x ~~Done \u2714\ufe0e~~ y',
      [
        ['x ', 0],
        ['Done \u2714\ufe0e', strikethrough],
        [' y', 0],
      ],
      [
        ['x ', 0],
        ['Done \u2714\ufe0e', strikethrough],
        [' y', 0],
      ],
    ],
    [
      '~~a.\ufe00~~',
      [['a.\ufe00', strikethrough]],
      [['a.\ufe00', strikethrough]],
    ],
    // A selector right after a link varies its `)`, also where a marker in
    // the link text pairs with one after it.
    [
      'x [*a](u)\ufe0e_b_*',
      [
        ['x ', 0],
        ['*a', 0],
        ['\ufe0e', 0],
        ['b', italic],
        ['*', 0],
      ],
      [
        ['x ', 0],
        ['*a', 0],
        ['\ufe0e_b_*', 0],
      ],
    ],
    [
      'x [*a](u)\ufe0e*_*「\ufe0e',
      [
        ['x ', 0],
        ['*a', 0],
        ['\ufe0e', 0],
        ['_', italic],
        ['「\ufe0e', 0],
      ],
      [
        ['x ', 0],
        ['*a', 0],
        ['\ufe0e*_*「\ufe0e', 0],
      ],
    ],
    // A selector that starts formatted or link text varies the syntax before
    // it.
    [
      '*\ufe0e__a__*',
      [
        ['\ufe0e', italic],
        ['a', italic | bold],
      ],
      [['\ufe0e__a__', italic]],
    ],
    [
      '[\ufe0e__a__](https://x.com)',
      [
        ['\ufe0e', 0],
        ['a', bold],
      ],
      [['\ufe0e__a__', 0]],
    ],
    [
      'b[\ufe0e__a__](https://x.com)',
      [
        ['b', 0],
        ['\ufe0e', 0],
        ['a', bold],
      ],
      [
        ['b', 0],
        ['\ufe0e__a__', 0],
      ],
    ],
    ['__「a」__世', [['__「a」__世', 0]], [['__「a」__世', 0]]],
    ['a**“b”**c', [['a**“b”**c', 0]], [['a**“b”**c', 0]]],
  ])('imports %j', (markdown, cjkFriendly, strict) => {
    expect(importRuns(markdown)).toEqual(cjkFriendly);
    expect(importRuns(markdown, 'cjk-friendly')).toEqual(cjkFriendly);
    expect(importRuns(markdown, 'strict-commonmark')).toEqual(strict);
    expect(importMdastRuns(markdown, 'cjk-friendly')).toEqual(cjkFriendly);
    expect(importMdastRuns(markdown, 'strict-commonmark')).toEqual(strict);
  });

  it('takes the import options in $generateNodesFromMarkdownString', () => {
    const editor = createEditor();
    const formats = (punctuation: PunctuationMode) => {
      let result: number[] = [];
      editor.update(
        () => {
          // As a wrapper that forwards either form would pass them.
          const $generate = (options: boolean | MarkdownImportOptions) =>
            $generateNodesFromMarkdownString(
              '**你好。**世界',
              TRANSFORMERS,
              options,
            );
          const [paragraph] = $generate({punctuation});
          assert($isParagraphNode(paragraph));
          result = paragraph.getAllTextNodes().map(node => node.getFormat());
        },
        {discrete: true},
      );
      return result;
    };
    expect(formats('cjk-friendly')).toEqual([bold, 0]);
    expect(formats('strict-commonmark')).toEqual([0]);
  });

  it('takes the export options in $convertSelectionToMarkdownString', () => {
    const editor = createEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('你好。').setFormat(bold),
              $createTextNode('世界'),
            ),
          );
        $selectAll();
      },
      {discrete: true},
    );
    const exportSelection = (punctuation: PunctuationMode) =>
      editor.read('latest', () =>
        $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection(), {
          punctuation,
        }),
      );
    expect(exportSelection('cjk-friendly')).toBe('**你好。**世界');
    expect(exportSelection('strict-commonmark')).toBe('**你好。**&#19990;界');
  });

  it('converts nested content in the mode of the outer conversion', () => {
    // A transformer that converts its content as one written before the
    // options object would, with the positional flag.
    const NESTED: MultilineElementTransformer = {
      dependencies: [QuoteNode],
      export: node =>
        $isQuoteNode(node)
          ? `:::\n${$convertToMarkdownString(TRANSFORMERS, node, false)}\n:::`
          : null,
      regExpEnd: /^:::$/,
      regExpStart: /^:::$/,
      replace: (rootNode, _children, _start, _end, lines) => {
        const quote = $createQuoteNode();
        quote.append(
          ...$generateNodesFromMarkdownString(
            (lines || []).join('\n'),
            TRANSFORMERS,
            false,
          ),
        );
        rootNode.append(quote);
      },
      type: 'multiline-element',
    };
    const transformers = [NESTED, ...TRANSFORMERS];
    const editor = createEditor();
    const importNested = (punctuation: PunctuationMode) => {
      editor.update(
        () =>
          $convertFromMarkdownString(
            ':::\n**你好。**世界\n:::',
            transformers,
            undefined,
            {punctuation},
          ),
        {discrete: true},
      );
      return editor.read('latest', $runs);
    };
    expect(importNested('cjk-friendly')).toEqual([
      ['你好。', bold],
      ['世界', 0],
    ]);
    expect(importNested('strict-commonmark')).toEqual([['**你好。**世界', 0]]);
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createQuoteNode().append(
              $createParagraphNode().append(
                $createTextNode('你好。').setFormat(bold),
                $createTextNode('世界'),
              ),
            ),
          ),
      {discrete: true},
    );
    const exportNested = (punctuation: PunctuationMode) =>
      editor.read('latest', () =>
        $convertToMarkdownString(transformers, undefined, {punctuation}),
      );
    expect(exportNested('cjk-friendly')).toBe(':::\n**你好。**世界\n:::');
    expect(exportNested('strict-commonmark')).toBe(
      ':::\n**你好。**&#19990;界\n:::',
    );
  });

  // runs, export for strict readers, export for CJK-friendly readers.
  it.each<[runs: Runs, strict: string, cjkFriendly: string]>([
    [
      [
        ['你好。', bold],
        ['世界', 0],
      ],
      '**你好。**&#19990;界',
      '**你好。**世界',
    ],
    [
      [
        ['中文', 0],
        ['「强调」', bold],
      ],
      '中&#25991;**「强调」**',
      '中文**「强调」**',
    ],
    [
      [
        ['你好。', strikethrough],
        ['세계', 0],
      ],
      '~~你好。~~&#49464;계',
      '~~你好。~~세계',
    ],
    [
      [
        ['a', 0],
        ['“b”', bold],
      ],
      '&#97;**“b”**',
      '&#97;**“b”**',
    ],
    // A variation selector that starts a piece varies what the piece before
    // it ends with, here a marker.
    [
      [
        ['x', 0],
        ['\ufe0e', italic],
        ['b', 0],
      ],
      'x*\ufe0e*&#98;',
      'x*\ufe0e*&#98;',
    ],
    [
      [
        ['\u00a9\ufe0e', bold],
        ['2024', 0],
      ],
      '**\u00a9\ufe0e**&#50;024',
      '**\u00a9\ufe0e**&#50;024',
    ],
    [
      [
        ['\ufe00', bold],
        ['b?계', italic],
      ],
      '**&#65024;***&#98;?계*',
      '**\ufe00***&#98;?계*',
    ],
    // A selector after a character written as a reference varies its `;`.
    [
      [
        ['\u3002', bold | strikethrough],
        ['0\ufe0e', bold],
        ['\ufe00x', 0],
      ],
      '**~~\u3002~~&#48;\ufe0e**&#65024;x',
      '**~~\u3002~~0\ufe0e**\ufe00x',
    ],
    [
      [
        ['\u3002', strikethrough],
        ['a\ufe0eb\ufe0e', 0],
        ['“y”', bold],
      ],
      '~~\u3002~~&#97;\ufe0eb&#65038;**“y”**',
      '~~\u3002~~a\ufe0eb&#65038;**“y”**',
    ],
    // Every common reader takes a vertical tab as whitespace (#9747).
    [
      [
        ['p\v', 0],
        ['.', bold],
        ['\vq', 0],
      ],
      'p\v**.**\vq',
      'p\v**.**\vq',
    ],
    // A selector before a closing `~~` goes out as a reference, which
    // micromark-extension-cjk-friendly-gfm-strikethrough reads as other
    // readers do.
    [
      [
        ['x ', 0],
        ['Done \u2714\ufe0e', strikethrough],
        ['next', 0],
      ],
      'x ~~Done \u2714&#65038;~~&#110;ext',
      'x ~~Done \u2714&#65038;~~&#110;ext',
    ],
    // A literal `<` or `&` before a selector stays: the selector continues
    // no autolink's address and no character reference, and nor does the
    // reference written for it, whose `;` no address holds before its `@` and
    // whose `&` no character reference continues with.
    [
      [
        ['a<\ufe0e', strikethrough],
        ['@x.co>', 0],
      ],
      '~~a<&#65038;~~@x.co>',
      '~~a<&#65038;~~@x.co>',
    ],
    [
      [
        ['a<\ufe0e', bold],
        ['@x.co>', 0],
      ],
      '**a<\ufe0e**@x.co>',
      '**a<\ufe0e**@x.co>',
    ],
    [
      [
        ['a&\ufe0e', strikethrough],
        ['#65;', 0],
      ],
      '~~a&&#65038;~~#65;',
      '~~a&&#65038;~~#65;',
    ],
  ])('exports %j', (runs, strict, cjkFriendly) => {
    expect(exportRuns(runs)).toBe(strict);
    expect(exportRuns(runs, 'strict-commonmark')).toBe(strict);
    expect(exportRuns(runs, 'cjk-friendly')).toBe(cjkFriendly);
    for (const punctuation of ['cjk-friendly', 'strict-commonmark'] as const) {
      expect(importRuns(strict, punctuation)).toEqual(runs);
      expect(importMdastRuns(strict, punctuation)).toEqual(runs);
    }
    expect(importRuns(cjkFriendly)).toEqual(runs);
    expect(importMdastRuns(cjkFriendly, 'cjk-friendly')).toEqual(runs);
  });

  it('reads U+0000 as the U+FFFD that readers replace it with', () => {
    const runs: Runs = [
      ['a\0', bold],
      ['b', 0],
    ];
    for (const punctuation of ['cjk-friendly', 'strict-commonmark'] as const) {
      const markdown = exportRuns(runs, punctuation);
      expect(markdown).toBe('**a\0**&#98;');
      expect(importRuns(markdown, punctuation)).toEqual(runs);
      // @lexical/mdast imports U+0000 as U+FFFD.
      expect(importMdastRuns(markdown, punctuation)).toEqual([
        ['a\ufffd', bold],
        ['b', 0],
      ]);
    }
  });

  it('writes a selector after U+0000 for both CJK-friendly readings', () => {
    // micromark-extension-cjk-friendly reads the selector as itself,
    // markdown-it-cjk-friendly as the U+FFFD.
    const cases: [Runs, string][] = [
      [
        [
          ['a\0\ufe0e', 0],
          ['“x”', bold],
          [' b', 0],
        ],
        'a\0&#65038;**“x”** b',
      ],
      [
        [
          ['x\0\ufe0e', bold],
          ['b', 0],
        ],
        '**x\0\ufe0e**&#98;',
      ],
    ];
    for (const [runs, expected] of cases) {
      for (const punctuation of [
        'cjk-friendly',
        'strict-commonmark',
      ] as const) {
        const markdown = exportRuns(runs, punctuation);
        expect(markdown).toBe(expected);
        expect(importRuns(markdown, punctuation)).toEqual(runs);
      }
    }
  });

  it('varies the syntax before link text read with its escapes out', () => {
    // A link whose text has its escapes taken out, which the URL holds too.
    const UNESCAPED_LINK: TextMatchTransformer = {
      dependencies: [LinkNode],
      importRegExp: /\[((?:\\.|[^\]\\])*)\]\(([^)]*)\)/,
      regExp: /\[((?:\\.|[^\]\\])*)\]\(([^)]*)\)$/,
      replace: (textNode, match) => {
        const text = $createTextNode(match[1].replace(/\\(.)/g, '$1'));
        textNode.replace($createLinkNode(match[2]).append(text));
        return text;
      },
      type: 'text-match',
    };
    const editor = createEditor();
    editor.update(
      () =>
        $convertFromMarkdownString(
          '[\ufe0e\\_x_](u\ufe0e_x_)',
          [UNESCAPED_LINK, ...TRANSFORMERS],
          undefined,
          {punctuation: 'cjk-friendly'},
        ),
      {discrete: true},
    );
    // The selector varies the `[`, not the `u` before the copy in the URL.
    expect(editor.read('latest', $runs)).toEqual([
      ['\ufe0e', 0],
      ['x', italic],
    ]);
  });

  it('varies the character before content wherever it stands in the match', () => {
    // Syntax with a letter before the content, content that starts the
    // match, and content after a selector in the syntax.
    const KEYWORD: TextMatchTransformer = {
      dependencies: [],
      importRegExp: /\{@k ([^}]*)\}/,
      regExp: /\{@k ([^}]*)\}$/,
      replace: (textNode, match) => {
        const text = $createTextNode(match[1]);
        textNode.replace(text);
        return text;
      },
      type: 'text-match',
    };
    const BANGS: TextMatchTransformer = {
      dependencies: [],
      importRegExp: /(\ufe0e[^!]*)!!/,
      regExp: /(\ufe0e[^!]*)!!$/,
      replace: (textNode, match) => {
        const text = $createTextNode(match[1]);
        textNode.replace(text);
        return text;
      },
      type: 'text-match',
    };
    // A link whose text has its escapes taken out, found by its opening
    // alone, which getEndIndex ends.
    const OPENED_LINK: TextMatchTransformer = {
      dependencies: [LinkNode],
      getEndIndex: (_node, match) => {
        const end = match.input!.indexOf('}}', match.index!);
        return end === -1 ? false : end + 2;
      },
      importRegExp: /\{\{([^|}]*)\|/,
      regExp: /\{\{([^|}]*)\|[^}]*\}\}$/,
      replace: (textNode, match) => {
        const text = $createTextNode(match[1].replace(/\\(.)/g, '$1'));
        textNode.replace($createLinkNode('u').append(text));
        return text;
      },
      type: 'text-match',
    };
    // A regular expression of flags that no copy with the `d` flag can be
    // made of, as in a browser without that flag.
    class WithoutIndices extends RegExp {
      get flags() {
        return 'q';
      }
    }
    const QUESTIONS: TextMatchTransformer = {
      dependencies: [],
      importRegExp: new WithoutIndices(/(\ufe0e[^?]*)\?\?/.source),
      regExp: /(\ufe0e[^?]*)\?\?$/,
      replace: (textNode, match) => {
        const text = $createTextNode(match[1]);
        textNode.replace(text);
        return text;
      },
      type: 'text-match',
    };
    // Content that no group holds, and the same after a copy of it.
    const PIPED: TextMatchTransformer = {
      dependencies: [],
      importRegExp: /\ufe0e\*\*“x”\*\*\|\ufe0e\*\*“x”\*\*/,
      regExp: /\ufe0e\*\*“x”\*\*\|\ufe0e\*\*“x”\*\*$/,
      replace: (textNode, match) => {
        const text = $createTextNode(match[0].slice(match[0].indexOf('|') + 1));
        textNode.replace(text);
        return text;
      },
      type: 'text-match',
    };
    const SLICED_KEYWORD: TextMatchTransformer = {
      dependencies: [],
      importRegExp: /\{@s [^}]*\}/,
      regExp: /\{@s [^}]*\}$/,
      replace: (textNode, match) => {
        const text = $createTextNode(match[0].slice(4, -1));
        textNode.replace(text);
        return text;
      },
      type: 'text-match',
    };
    // Content after a selector in the syntax.
    const WIKI_LINK: TextMatchTransformer = {
      dependencies: [],
      importRegExp: /\[\[([^|\]]*)\|([^\]]*)\]\]/,
      regExp: /\[\[([^|\]]*)\|([^\]]*)\]\]$/,
      replace: (textNode, match) => {
        const text = $createTextNode(match[2]);
        textNode.replace(text);
        return text;
      },
      type: 'text-match',
    };
    // The same, with group indices: the importer moves them with the match
    // it keeps for what is left of the text after an earlier match.
    const WIKI_LINK_WITH_INDICES: TextMatchTransformer = {
      ...WIKI_LINK,
      importRegExp: new RegExp(/\(\(([^|)]*)\|([^)]*)\)\)/.source, 'd'),
      regExp: /\(\(([^|)]*)\|([^)]*)\)\)$/,
    };
    const editor = createEditor();
    const importText = (markdown: string) => {
      editor.update(
        () =>
          $convertFromMarkdownString(
            markdown,
            [
              KEYWORD,
              BANGS,
              WIKI_LINK,
              WIKI_LINK_WITH_INDICES,
              SLICED_KEYWORD,
              PIPED,
              QUESTIONS,
              OPENED_LINK,
              ...TRANSFORMERS,
            ],
            undefined,
            {punctuation: 'cjk-friendly'},
          ),
        {discrete: true},
      );
      return editor.read('latest', $runs);
    };
    // The selector varies the space, not the `{`, so `**` stays literal.
    expect(importText('{@k \ufe0e**“x”**}')).toEqual([['\ufe0e**“x”**', 0]]);
    // The selector varies the `中` before the match, so `**` opens.
    expect(importText('中\ufe0e**“x”**!! b')).toEqual([
      ['中\ufe0e', 0],
      ['“x”', bold],
      [' b', 0],
    ]);
    // The selector varies the `|`, not the `u` before the selector in the
    // target, so `**` opens.
    expect(importText('[[u\ufe0ey|\ufe0e**“x”**]]')).toEqual([
      ['\ufe0e', 0],
      ['“x”', bold],
    ]);
    // Nor the `a` before a copy of the text in the target.
    expect(importText('[[a\ufe0e**“x”**|\ufe0e**“x”**]]')).toEqual([
      ['\ufe0e', 0],
      ['“x”', bold],
    ]);
    expect(importText('{@s \ufe0e**“x”**}')).toEqual([['\ufe0e**“x”**', 0]]);
    // Found without group indices at the match's start, after the `中`.
    expect(importText('中\ufe0e**“x”**??')).toEqual([
      ['中\ufe0e', 0],
      ['“x”', bold],
    ]);
    // The copy after the match's start, before which is the `|`.
    expect(importText('a\ufe0e**“x”**|\ufe0e**“x”**')).toEqual([
      ['a\ufe0e', 0],
      ['“x”', bold],
    ]);
    // The `{`, not the `u` before a copy of the text after the `|`.
    expect(importText('{{\ufe0e\\_x_|u\ufe0e_x_}}')).toEqual([
      ['\ufe0e', 0],
      ['x', italic],
    ]);
    expect(importText('a *b* ((u\ufe0ey|\ufe0e**“x”**))')).toEqual([
      ['a ', 0],
      ['b', italic],
      [' \ufe0e', 0],
      ['“x”', bold],
    ]);
    // Content that starts the text of a link: the selector varies the `[`.
    expect(importText('[\ufe0e**“x”**!!](u)')).toEqual([
      ['\ufe0e', 0],
      ['“x”', bold],
    ]);
  });

  it('reads null and an options object with the merge flag as before', () => {
    const editor = createEditor();
    const importText = (
      options: boolean | MarkdownImportOptions | null,
      shouldMergeAdjacentLines: boolean,
    ) => {
      editor.update(
        () =>
          $convertFromMarkdownString(
            'a\nb',
            TRANSFORMERS,
            undefined,
            // As JavaScript can pass it.
            options as boolean,
            shouldMergeAdjacentLines,
          ),
        {discrete: true},
      );
      return editor.read('latest', () => $getRoot().getTextContent());
    };
    expect(importText(null, false)).toBe('a\nb');
    expect(importText(null, true)).toBe('a b');
    expect(importText({punctuation: 'strict-commonmark'}, true)).toBe('a b');
    expect(
      editor.read('latest', () =>
        $convertToMarkdownString(TRANSFORMERS, undefined, null as never),
      ),
    ).toBe('a b');
  });

  it('exports a long paragraph of one-character pieces', () => {
    const runs: Runs = [];
    for (let i = 0; i < 4000; i++) {
      runs.push([String(i % 10), i % 2 ? bold : italic]);
    }
    expect(exportRuns(runs).startsWith('*0***1***2*')).toBe(true);
  });
});
