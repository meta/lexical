/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {MdastPunctuationMode} from '../../index';

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $convertFromMarkdownString as $importMarkdown,
  $convertToMarkdownString as $exportMarkdown,
  type PunctuationMode,
  TRANSFORMERS,
} from '@lexical/markdown';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {expect, it, onTestFinished} from 'vitest';

import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  MdastExtension,
  MdastGfmExtension,
} from '../../index';

type Runs = [text: string, format: number][];

// Characters that each read differently for some reader beside a marker.
const ALPHABET = [
  'a',
  '0',
  ' ',
  '!',
  '“',
  '©',
  '你',
  '。',
  '「',
  '」',
  '가',
  'ก',
  '\u{1f389}',
  '\u{1f680}',
  '\u{20000}',
  '\u{1d400}',
  '︀',
  '︁',
  '︎',
  '﻿',
  '⸀',
];
// A random round trip is too slow for every run: it runs with the number of
// cases in this variable, as in
// `MDAST_ROUND_TRIP_CASES=3000 pnpm run test-unit MdastPunctuationRoundTrip`.
const CASES = Number(process.env.MDAST_ROUND_TRIP_CASES) || 0;

function createRandom(seed: number): (n: number) => number {
  return n => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
}

function normalize(runs: Runs): Runs {
  const result: Runs = [];
  for (const [text, format] of runs) {
    const last = result[result.length - 1];
    if (last && last[1] === format) {
      last[0] += text;
    } else if (text) {
      result.push([text, format]);
    }
  }
  return result;
}

function generate(random: (n: number) => number): Runs {
  const runs: Runs = [];
  for (let i = 1 + random(4); i > 0; i--) {
    let text = '';
    for (let j = 1 + random(3); j > 0; j--) {
      text += ALPHABET[random(ALPHABET.length)];
    }
    // Formatting does not keep whitespace at its edges.
    runs.push([text.trim() || 'x', random(6)]);
  }
  return normalize(runs);
}

function $runs(): Runs {
  return normalize(
    $getRoot()
      .getAllTextNodes()
      .map(node => [node.getTextContent(), node.getFormat()]),
  );
}

function $setRuns(runs: Runs): void {
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

function createMdastEditor(
  exportPunctuation?: MdastPunctuationMode,
  importPunctuation?: MdastPunctuationMode,
): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        MdastGfmExtension,
        configExtension(MdastExtension, {exportPunctuation, importPunctuation}),
      ],
      name: '[root]',
    }),
  );
  onTestFinished(() => editor.dispose());
  return editor;
}

it
  .skipIf(CASES === 0)
  .each<
    [exportPunctuation: PunctuationMode, importPunctuation: PunctuationMode]
  >([
    ['strict-commonmark', 'cjk-friendly'],
    ['strict-commonmark', 'strict-commonmark'],
    ['cjk-friendly', 'cjk-friendly'],
  ])(
  'round-trips formatted text exported %s and imported %s',
  (exportPunctuation, importPunctuation) => {
    const mdast = createMdastEditor(exportPunctuation, importPunctuation);
    const markdown = buildEditorFromExtensions(
      defineExtension({dependencies: [RichTextExtension], name: '[root]'}),
    );
    onTestFinished(() => markdown.dispose());
    const random = createRandom(1);
    const failures: string[] = [];
    for (let i = 0; i < CASES; i++) {
      const runs = generate(random);
      // Each package's export, read back by both packages.
      mdast.update(() => $setRuns(runs), {discrete: true});
      markdown.update(() => $setRuns(runs), {discrete: true});
      const exports = [
        mdast.read('latest', () => $convertToMarkdownString()),
        markdown.read('latest', () =>
          $exportMarkdown(TRANSFORMERS, undefined, {
            punctuation: exportPunctuation,
          }),
        ),
      ];
      for (const exported of exports) {
        mdast.update(() => $convertFromMarkdownString(exported), {
          discrete: true,
        });
        markdown.update(
          () =>
            $importMarkdown(exported, TRANSFORMERS, undefined, {
              punctuation: importPunctuation,
            }),
          {discrete: true},
        );
        for (const editor of [mdast, markdown]) {
          const read = editor.read('latest', $runs);
          if (JSON.stringify(read) !== JSON.stringify(runs)) {
            failures.push(
              `${JSON.stringify(runs)} => ${exported} => ${JSON.stringify(read)}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  },
);
