/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

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
import MarkdownIt from 'markdown-it';
import markdownItCjkFriendly from 'markdown-it-cjk-friendly';
import {describe, expect, it, onTestFinished} from 'vitest';

import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  MdastExtension,
  MdastGfmExtension,
} from '../../index';

// Exports read through markdown-it, the most used CommonMark reader, and
// through its CJK-friendly plugin, must read as Lexical's own import of them
// does, so that "a strict export reads the same in every reader" holds
// beyond Lexical's importers. The cases the READMEs list as exceptions (a
// variation selector after whitespace other than a space, a vertical tab
// beside a marker, and a `***` run that a pair uses only part of) are left
// out.

type Runs = [text: string, format: number][];
type Reader = InstanceType<typeof MarkdownIt>;

const {bold, italic, strikethrough} = TEXT_TYPE_TO_FORMAT;
const FORMATS = bold | italic | strikethrough;

const STRICT = new MarkdownIt();
const CJK_FRIENDLY = new MarkdownIt().use(markdownItCjkFriendly);

// Characters that read differently beside a marker for some reader.
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
  '\u{20000}',
  '\\',
  '&',
  '*',
  '_',
  '~',
];
const FIXED_CASES: Runs[] = [
  [
    ['你好。', bold],
    ['世界', 0],
  ],
  [
    ['中文', 0],
    ['「强调」', bold],
  ],
  [
    ['你好。', strikethrough],
    ['세계', 0],
  ],
  [
    ['世', 0],
    ['「x」', strikethrough],
    ['界', 0],
  ],
  [
    ['a', 0],
    ['“b”', bold],
    ['c', 0],
  ],
  [
    ['Hello', 0],
    ['\u{1f389} launch', bold],
  ],
  [
    ['Release', 0],
    ['\u{1f680}', bold],
    ['now', 0],
  ],
  [
    ['\u00a9\ufe0e', bold],
    ['2024', 0],
  ],
  [
    ['x', 0],
    ['\ufe0e', italic],
    ['b', 0],
  ],
  [
    ['x ', 0],
    ['Done \u2714\ufe0e', strikethrough],
    [' y', 0],
  ],
  [
    ['x ', 0],
    ['Done \u2714\ufe0e', strikethrough],
    ['next', 0],
  ],
  [
    ['世', italic],
    ['「a」', bold],
  ],
  [
    ['世', 0],
    [' a', bold],
  ],
  [
    ['foo', 0],
    ['bar', italic],
    ['baz', bold | italic],
  ],
  [
    ['C:\\dir\\', 0],
    ['x', bold],
  ],
  [
    ['ภาษาไทย', bold],
    ['ครับ', 0],
  ],
  [
    ['“', italic],
    ['a', bold],
    ['!', strikethrough],
  ],
];
// Fixed cases run every time. Random ones are too slow for every run: they
// run with the number of cases in this variable, as in
// `MDAST_CROSS_READER_CASES=3000 pnpm run test-unit MdastCrossReader`.
const CASES = Number(process.env.MDAST_CROSS_READER_CASES) || 0;

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
    // Formatting does not keep whitespace at its edges.
    runs.push([text.trim() || 'x', random(8)]);
  }
  return normalize(runs);
}

// The text and formats of the paragraph markdown-it renders.
function read(reader: Reader, markdown: string): Runs {
  const html = reader.render(markdown).replace(/^<p>|<\/p>\n$/g, '');
  const tags: Record<string, number> = {
    em: italic,
    s: strikethrough,
    strong: bold,
  };
  const runs: Runs = [];
  let format = 0;
  for (const [, close, tag, text] of html.matchAll(
    /<(\/?)(em|s|strong)>|([^<]+)/g,
  )) {
    if (text !== undefined) {
      runs.push([
        text
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&'),
        format,
      ]);
    } else {
      format = close ? format & ~tags[tag] : format | tags[tag];
    }
  }
  return normalize(runs);
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

function createEditors(punctuation: PunctuationMode): {
  markdown: LexicalEditor;
  mdast: LexicalEditor;
} {
  const mdast = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        MdastGfmExtension,
        configExtension(MdastExtension, {
          exportPunctuation: punctuation,
          importPunctuation: punctuation,
        }),
      ],
      name: '[root]',
    }),
  );
  const markdown = buildEditorFromExtensions(
    defineExtension({dependencies: [RichTextExtension], name: '[root]'}),
  );
  onTestFinished(() => {
    mdast.dispose();
    markdown.dispose();
  });
  return {markdown, mdast};
}

describe('Markdown export read by markdown-it', () => {
  it.each<[punctuation: PunctuationMode, readers: Reader[]]>([
    ['strict-commonmark', [STRICT, CJK_FRIENDLY]],
    ['cjk-friendly', [CJK_FRIENDLY]],
  ])('reads %s exports as they were written', (punctuation, readers) => {
    const {markdown, mdast} = createEditors(punctuation);
    const random = createRandom(1);
    const failures: string[] = [];
    const cases = [
      ...FIXED_CASES,
      ...Array.from({length: CASES}, () => generate(random)),
    ];
    const $read = () =>
      normalize(
        $getRoot()
          .getAllTextNodes()
          .map(node => [node.getTextContent(), node.getFormat() & FORMATS]),
      );
    for (const runs of cases) {
      mdast.update(() => $setRuns(runs), {discrete: true});
      markdown.update(() => $setRuns(runs), {discrete: true});
      const exported = mdast.read('latest', () => $convertToMarkdownString());
      mdast.update(() => $convertFromMarkdownString(exported), {
        discrete: true,
      });
      const exportedMarkdown = markdown.read('latest', () =>
        $exportMarkdown(TRANSFORMERS, undefined, {punctuation}),
      );
      markdown.update(
        () =>
          $importMarkdown(exportedMarkdown, TRANSFORMERS, undefined, {
            punctuation,
          }),
        {discrete: true},
      );
      for (const [text, expected] of [
        [exported, mdast.read('latest', $read)],
        [exportedMarkdown, markdown.read('latest', $read)],
      ] as const) {
        // markdown-it applies the rule of 3 to the whole length of a run,
        // and micromark to what is left of it, so a run of three or more
        // markers that one pair uses only part of reads differently.
        if (/\*{3}|_{3}/.test(text)) {
          continue;
        }
        for (const reader of readers) {
          const actual = read(reader, text);
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            failures.push(
              `${JSON.stringify(runs)} -> ${JSON.stringify(text)} -> ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
