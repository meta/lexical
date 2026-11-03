/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {LinkExtension} from '@lexical/link';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  $generateNodesFromMarkdownString,
  type MarkdownImportOptions,
  type PunctuationMode,
  TRANSFORMERS,
} from '@lexical/markdown';
import {
  $convertFromMarkdownString as $convertFromMdastMarkdownString,
  MdastExtension,
  MdastGfmExtension,
} from '@lexical/mdast';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
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
