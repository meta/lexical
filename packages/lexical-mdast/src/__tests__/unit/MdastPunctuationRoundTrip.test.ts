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
  TEXT_TYPE_TO_FORMAT,
} from 'lexical';
import {expect, it, onTestFinished} from 'vitest';

import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  MdastExtension,
  MdastGfmExtension,
} from '../../index';

type Runs = [text: string, format: number][];

const CODE = TEXT_TYPE_TO_FORMAT.code;

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
  '\\',
  '&',
];
// Fixed cases run every time. Random ones are too slow for every run: they
// run with the number of cases in this variable, as in
// `MDAST_ROUND_TRIP_CASES=3000 pnpm run test-unit MdastPunctuationRoundTrip`.
const CASES = Number(process.env.MDAST_ROUND_TRIP_CASES) || 0;
const FIXED_CASES: Runs[] = [
  [
    ['Hello', 0],
    ['\u{1f389} launch', 1],
  ],
  [
    ['你好。', 1],
    ['世界', 0],
  ],
  [
    ['Done \u2714\ufe0e', 1],
    ['next', 0],
  ],
  [
    ['a', 0],
    ['「x」', 6],
    ['b', 0],
  ],
  [
    ['x\ufeff', 0],
    ['。', 2],
    ['世', 0],
  ],
  [
    ['\u{1f680}', 7],
    ['now', 0],
  ],
  [
    ['code \u{1f389}', CODE],
    ['b', 1],
  ],
];

// mulberry32: a seeded generator with 32-bit state.
function createRandom(seed: number): (n: number) => number {
  return n => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
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
    // Formatting does not keep whitespace at its edges. Any of bold, italic
    // and strikethrough, and now and then code.
    runs.push([text.trim() || 'x', random(8) | (random(4) === 0 ? CODE : 0)]);
  }
  const result = normalize(runs);
  // Not bold and italic text followed by text with only one of them:
  // @lexical/markdown writes `***a****b*` for that, on main too.
  return result.some(
    ([, format], index) =>
      index > 0 &&
      (result[index - 1][1] & 3) === 3 &&
      (format & 3) !== 0 &&
      (format & 3) !== 3,
  )
    ? generate(random)
    : result;
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

it.each<
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
    const cases = [
      ...FIXED_CASES,
      ...Array.from({length: CASES}, () => generate(random)),
    ];
    for (const runs of cases) {
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
  // About 2 ms a case.
  5000 + CASES * 5,
);
