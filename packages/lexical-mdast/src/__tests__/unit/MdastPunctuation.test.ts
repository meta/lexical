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
    // A reference that is not beside a marker stays.
    [[['&世', 0]], '&世', '&世'],
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
});
