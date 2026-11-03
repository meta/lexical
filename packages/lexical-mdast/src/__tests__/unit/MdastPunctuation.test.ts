/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {MdastConfig, MdastPunctuationMode} from '../../index';
import type {Paragraph} from 'mdast';

import {buildEditorFromExtensions} from '@lexical/extension';
import {$createLinkNode} from '@lexical/link';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
  defineExtension,
  type LexicalEditor,
  ParagraphNode,
  TEXT_TYPE_TO_FORMAT,
} from 'lexical';
import {defaultHandlers} from 'mdast-util-to-markdown';
import {toString as mdastToString} from 'mdast-util-to-string';
import {assert, describe, expect, it, onTestFinished} from 'vitest';

import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  MdastExtension,
  MdastGfmExtension,
} from '../../index';

const {bold, italic, strikethrough} = TEXT_TYPE_TO_FORMAT;

type Runs = [text: string, format: number][];

function createEditor(
  exportPunctuation?: MdastPunctuationMode,
  importPunctuation?: MdastPunctuationMode,
  config: Partial<MdastConfig> = {},
): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        MdastGfmExtension,
        configExtension(MdastExtension, {
          ...config,
          exportPunctuation,
          importPunctuation,
        }),
      ],
      name: '[root]',
    }),
  );
  onTestFinished(() => editor.dispose());
  return editor;
}

function $appendRuns(runs: Runs): void {
  $getRoot()
    .clear()
    .append(
      $createParagraphNode().append(
        ...runs.map(([text, format]) =>
          $createTextNode(text).setFormat(format),
        ),
      ),
    );
}

function roundTrip(
  runs: Runs,
  exportPunctuation?: MdastPunctuationMode,
  importPunctuation?: MdastPunctuationMode,
): [markdown: string, runs: Runs] {
  const editor = createEditor(exportPunctuation, importPunctuation);
  editor.update(() => $appendRuns(runs), {discrete: true});
  const markdown = editor.read('latest', () => $convertToMarkdownString());
  editor.update(() => $convertFromMarkdownString(markdown), {discrete: true});
  return [
    markdown,
    editor.read('latest', () =>
      $getRoot()
        .getAllTextNodes()
        .map(node => [node.getTextContent(), node.getFormat()]),
    ),
  ];
}

describe('Mdast punctuation modes', () => {
  // runs, export for strict readers, export for CJK-friendly readers.
  it.each<[runs: Runs, strict: string, cjkFriendly: string]>([
    [
      [
        ['你好。', bold],
        ['世界', 0],
      ],
      '**你好。**&#x4E16;界',
      '**你好。**世界',
    ],
    // Strikethrough writes references as emphasis does.
    [
      [
        ['世', 0],
        ['「x」', strikethrough],
        ['界', 0],
      ],
      '&#x4E16;~~「x」~~&#x754C;',
      '世~~「x」~~界',
    ],
    // A reference to whitespace inside a run stays.
    [
      [
        ['世', 0],
        [' a', bold],
      ],
      '&#x4E16;**&#x20;a**',
      '世**&#x20;a**',
    ],
    // `_` does not open between two letters for any reader.
    [
      [
        ['世', italic],
        ['「a」', bold],
      ],
      '*世*__「a」__',
      '*世*__「a」__',
    ],
    // Text that is not CJK keeps its references.
    [
      [
        ['a', 0],
        ['“b”', bold],
      ],
      '&#x61;**“b”**',
      '&#x61;**“b”**',
    ],
    // An emoji, outside the Basic Multilingual Plane, is punctuation for
    // CJK-friendly readers as for CommonMark, so a letter beside a run that
    // starts or ends with one goes out as a reference. micromark without the
    // CJK-friendly extension reads it as a letter, so for strict readers the
    // emoji goes out as one too where that would change how the run beside
    // it flanks.
    [
      [
        ['Hello', 0],
        ['\u{1f389} launch', bold],
      ],
      'Hell&#x6F;**&#x1F389; launch**',
      'Hell&#x6F;**\u{1f389} launch**',
    ],
    [
      [
        ['Release', 0],
        ['\u{1f680}', bold],
        ['now', 0],
      ],
      'Releas&#x65;**&#x1F680;**&#x6E;ow',
      'Releas&#x65;**\u{1f680}**&#x6E;ow',
    ],
    [
      [
        ['foo', 0],
        ['\u{1f525}hot', italic],
        ['bar', 0],
      ],
      'fo&#x6F;*&#x1F525;hot*bar',
      'fo&#x6F;*\u{1f525}hot*bar',
    ],
    [
      [
        ['a', 0],
        ['\u{1f44d}ok', strikethrough],
      ],
      '&#x61;~~&#x1F44D;ok~~',
      '&#x61;~~\u{1f44d}ok~~',
    ],
    // A CJK character beside the emoji needs one only for strict readers.
    [
      [
        ['你好', 0],
        ['\u{1f389}', bold],
      ],
      '你&#x597D;**&#x1F389;**',
      '你好**\u{1f389}**',
    ],
    // micromark without the CJK-friendly extension reads an emoji as a
    // letter, so one that would keep the run from opening for it goes out as
    // a reference.
    [
      [
        ['b\u{1f600}', 0],
        ['」0你', strikethrough],
      ],
      'b&#x1F600;~~」0你~~',
      'b\u{1f600}~~」0你~~',
    ],
    // A variation selector before a marker reads, for CJK-friendly readers,
    // as the character it varies; for others it is a letter.
    [
      [
        ['\u00a9\ufe0e', bold],
        ['2024', 0],
      ],
      '**\u00a9&#xFE0E;**&#x32;024',
      '**\u00a9&#xFE0E;**&#x32;024',
    ],
    [
      [
        ['x', 0],
        ['\ufe0e', italic],
        ['b', 0],
      ],
      '&#x78;*&#xFE0E;*&#x62;',
      '&#x78;*&#xFE0E;*&#x62;',
    ],
    [
      [['Done \u2714\ufe0e', strikethrough]],
      '~~Done \u2714\ufe0e~~',
      '~~Done \u2714\ufe0e~~',
    ],
    [
      [
        ['Done \u2714\ufe0e', bold],
        ['next', 0],
      ],
      '**Done \u2714&#xFE0E;**&#x6E;ext',
      '**Done \u2714&#xFE0E;**&#x6E;ext',
    ],
    // A backslash before a character that goes out as a reference is
    // escaped.
    [
      [
        ['a\\\ufe0e', bold],
        ['b', 0],
      ],
      '**a\\\\&#xFE0E;**&#x62;',
      '**a\\\\&#xFE0E;**&#x62;',
    ],
    // micromark reads U+FEFF as whitespace, CommonMark as a letter.
    [
      [
        ['\u00a9', italic],
        ['\ufeff\u3002世', 0],
      ],
      '*\u00a9*&#xFEFF;\u3002世',
      '*\u00a9*&#xFEFF;\u3002世',
    ],
    // An escaped marker beside an emoji is punctuation like any other.
    [
      [
        ['a*\u{1f389} ', 0],
        ['b', italic],
      ],
      'a\\*\u{1f389} *b*',
      'a\\*\u{1f389} *b*',
    ],
    // A reference that is not beside a marker stays.
    [[['&世', 0]], '&世', '&世'],
    // No reference stands for `\v`, which micromark reads as whitespace.
    [
      [
        ['x\v', 0],
        ['!b', bold],
      ],
      'x\v**!b**',
      'x\v**!b**',
    ],
  ])('exports %j', (runs, strict, cjkFriendly) => {
    expect(roundTrip(runs)).toEqual([strict, runs]);
    expect(roundTrip(runs, 'strict-commonmark')).toEqual([strict, runs]);
    expect(roundTrip(runs, 'strict-commonmark', 'strict-commonmark')).toEqual([
      strict,
      runs,
    ]);
    expect(roundTrip(runs, 'cjk-friendly')).toEqual([cjkFriendly, runs]);
  });

  it('keeps references in code and escaped ones', () => {
    const editor = createEditor('cjk-friendly');
    const markdown = '`**&#x4E16;`\n\n\\&#x4E16;**a**';
    editor.update(() => $convertFromMarkdownString(markdown), {
      discrete: true,
    });
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      markdown,
    );
  });

  it('picks emoji stand-ins that handlers do not write', () => {
    // A handler that writes a character the export would otherwise use as
    // the emoji's stand-in, and one it would use next.
    const editor = createEditor(undefined, undefined, {
      toMarkdownExtensions: [
        {
          handlers: {
            paragraph: (node, parent, state, info) =>
              defaultHandlers.paragraph(node, parent, state, info) +
              ' \u2e00\u2e01',
          },
        },
      ],
    });
    editor.update(
      () =>
        $appendRuns([
          ['Hello', 0],
          ['\u{1f389} launch', bold],
        ]),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      'Hell&#x6F;**&#x1F389; launch** \u2e00\u2e01',
    );
  });

  it('leaves the mdast tree as it was, data that is not JSON included', () => {
    const paragraphs: Paragraph[] = [];
    const editor = createEditor(undefined, undefined, {
      exportRules: [
        {
          $export: (_node, context) => {
            const [paragraph] = context.next();
            assert(paragraph.type === 'paragraph');
            paragraph.data = {
              cycle: paragraph,
              size: BigInt(1),
            } as Paragraph['data'];
            paragraphs.push(paragraph);
            return paragraph;
          },
          type: ParagraphNode,
        },
      ],
    });
    editor.update(
      () =>
        $appendRuns([
          ['Hello', 0],
          ['\u{1f389} launch', bold],
        ]),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      'Hell&#x6F;**&#x1F389; launch**',
    );
    expect(paragraphs.map(paragraph => mdastToString(paragraph))).toEqual([
      'Hello\u{1f389} launch',
    ]);
  });

  it('finds the references after a byte order mark', () => {
    const editor = createEditor('cjk-friendly');
    editor.update(
      () =>
        $appendRuns([
          ['\ufeff\u3002', 0],
          ['你好。', bold],
          ['世界', 0],
        ]),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      '\ufeff\u3002**你好。**世界',
    );
  });

  it('writes no reference in an autolink', () => {
    for (const url of ['https://x.com/_\u{1f389}', 'https://x.com/a_\ufe0e']) {
      const editor = createEditor();
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createLinkNode(url).append($createTextNode(url)),
              ),
            ),
        {discrete: true},
      );
      const markdown = editor.read('latest', () => $convertToMarkdownString());
      expect(markdown).toBe(`<${url}>`);
      editor.update(() => $convertFromMarkdownString(markdown), {
        discrete: true,
      });
      expect(editor.read('latest', () => $getRoot().getTextContent())).toBe(
        url,
      );
    }
  });

  it('counts the stand-ins text writes, not text an autolink writes', () => {
    // A text handler that writes U+2E00, the first stand-in, after `b`.
    const editor = createEditor(undefined, undefined, {
      toMarkdownExtensions: [
        {
          handlers: {
            text: (node, parent, state, info) =>
              defaultHandlers.text(node, parent, state, info) +
              (node.value === 'b' ? '\u2e00' : ''),
          },
        },
      ],
    });
    const url = 'https://x.com/\u{1f389}';
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createLinkNode(url).append($createTextNode(url)),
              $createTextNode('b'),
            ),
          ),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      `<${url}>b\u2e00`,
    );
  });

  it('counts no text that a look ahead at a link writes', () => {
    // A handler that writes U+2E00, the emoji's first stand-in, once.
    const editor = createEditor(undefined, undefined, {
      toMarkdownExtensions: [
        {
          handlers: {
            paragraph: (node, parent, state, info) =>
              defaultHandlers.paragraph(node, parent, state, info) + ' \u2e00',
          },
        },
      ],
    });
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('x\u{1f389} '),
              $createLinkNode('https://x.com').append(
                $createTextNode('\u{1f389}'),
              ),
            ),
          ),
      {discrete: true},
    );
    expect(editor.read('latest', () => $convertToMarkdownString())).toBe(
      'x\u{1f389} [\u{1f389}](https://x.com) \u2e00',
    );
  });

  it('aligns table cells as a CJK-friendly export writes them', () => {
    const editor = createEditor('cjk-friendly');
    editor.update(
      () =>
        $convertFromMarkdownString(
          '| a | b |\n| - | - |\n| **你好。**世界 | x |',
        ),
      {discrete: true},
    );
    const lines = editor
      .read('latest', () => $convertToMarkdownString())
      .split('\n');
    expect(lines[2]).toBe('| **你好。**世界 | x |');
    expect(lines.map(line => line.length)).toEqual(
      lines.map(() => lines[2].length),
    );
  });

  it('aligns table cells by the characters put back', () => {
    const editor = createEditor();
    editor.update(
      () =>
        $convertFromMarkdownString(
          '| \u{1f389}\u{1f389}\u{1f389} | x |\n| - | - |\n| &#x61;**\u{1f389}**&#x62; | b |',
        ),
      {discrete: true},
    );
    const lines = editor
      .read('latest', () => $convertToMarkdownString())
      .split('\n');
    expect(lines[2]).toBe('| &#x61;**&#x1F389;**&#x62; | b |');
    expect(lines.map(line => line.length)).toEqual(
      lines.map(() => lines[2].length),
    );
  });
});
