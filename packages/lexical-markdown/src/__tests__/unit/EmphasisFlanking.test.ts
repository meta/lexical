/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// #9660: a run of tags with punctuation on one side and a letter or digit on
// the other cannot close (`**Hello,**world`) or open (`x*(beta)*`) by
// CommonMark's flanking rules, so the exported Markdown imported again kept
// the asterisks as text and lost the format. The export now writes that
// letter or digit as a numeric character reference (`**Hello,**&#119;orld`),
// punctuation to the run and the same character once imported, and leaves
// every run that already flanks byte for byte as it was. Each case is read
// back by this package's import and by a CommonMark parser (micromark,
// through @lexical/mdast).

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
} from '@lexical/markdown';
import {
  $convertFromMarkdownString as $importCommonMark,
  MdastCommonMarkExtension,
  MdastExtension,
  MdastStrikethroughExtension,
} from '@lexical/mdast';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type TextFormatType,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {MarkdownTestExtension} from '../utils';

type Part = [string, TextFormatType[]];

const FORMATS: TextFormatType[] = [
  'bold',
  'italic',
  'strikethrough',
  'highlight',
  'code',
];

function editor() {
  return buildEditorFromExtensions({
    dependencies: [MarkdownTestExtension],
    name: 'test',
    onError: e => {
      throw e;
    },
  });
}

/** Each character of the paragraph with the formats it has, in order. */
function characters(parts: Part[]): string[] {
  return parts.flatMap(([text, formats]) =>
    [...text].map(c => `${c}:${[...formats].sort().join('+')}`),
  );
}

/** The characters of the root's text with their formats. */
function $characters(): string[] {
  return characters(
    $getRoot()
      .getAllTextNodes()
      .map(n => [
        n.getTextContent(),
        FORMATS.filter(format => n.hasFormat(format)),
      ]),
  );
}

/**
 * `markdown` read by a CommonMark parser (micromark, through @lexical/mdast,
 * with GFM strikethrough).
 */
function commonMark(markdown: string): string[] {
  const e = buildEditorFromExtensions({
    dependencies: [
      MdastCommonMarkExtension,
      MdastStrikethroughExtension,
      MdastExtension,
    ],
    name: 'commonmark',
    onError: error => {
      throw error;
    },
  });
  e.update(() => $importCommonMark(markdown), {discrete: true});
  const result = e.read($characters);
  e.dispose();
  return result;
}

/** Export `parts` as one paragraph and import the Markdown again. */
function roundTrip(parts: Part[]): {after: string[]; markdown: string} {
  const e = editor();
  e.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append(
            ...parts.map(([text, formats]) => {
              const node = $createTextNode(text);
              for (const format of formats) {
                node.toggleFormat(format);
              }
              return node;
            }),
          ),
        );
    },
    {discrete: true},
  );
  const markdown = e.read(() => $convertToMarkdownString(TRANSFORMERS));
  e.update(() => $convertFromMarkdownString(markdown, TRANSFORMERS), {
    discrete: true,
  });
  const after = e.read($characters);
  e.dispose();
  return {after, markdown};
}

describe('#9660: formatted text that ends or starts with punctuation next to a letter', () => {
  // Each exports as shown and reads back as the same characters with the
  // same formats, in this package's import and in a CommonMark parser.
  for (const [parts, markdown] of [
    [
      [
        ['Hello,', ['bold']],
        ['world', []],
      ],
      '**Hello,**&#119;orld',
    ],
    [
      [
        ['Note:', ['bold']],
        ['see', []],
      ],
      '**Note:**&#115;ee',
    ],
    [
      [
        ['x', []],
        ['(beta)', ['italic']],
      ],
      '&#120;*(beta)*',
    ],
    [
      [
        ['a.', ['italic']],
        ['b', []],
      ],
      '*a.*&#98;',
    ],
    [
      [
        ['(', ['bold']],
        ['b', []],
      ],
      '**(**&#98;',
    ],
    [
      [
        ['*', ['bold']],
        ['b', []],
      ],
      '**\\***&#98;',
    ],
    [
      [
        ['x', []],
        ['tag', ['bold', 'code']],
      ],
      '&#120;**`tag`**',
    ],
    [
      [
        ['a,', ['bold']],
        ['b', ['italic']],
      ],
      '**a,***&#98;*',
    ],
  ] as [Part[], string][]) {
    test(`${JSON.stringify(parts)} exports as ${markdown}`, () => {
      const result = roundTrip(parts);
      expect(result.markdown).toBe(markdown);
      expect(result.after).toEqual(characters(parts));
      expect(commonMark(result.markdown)).toEqual(characters(parts));
    });
  }
  // Export that already reads back stays byte for byte as it was.
  for (const [parts, markdown] of [
    [
      [
        ['Hello,', ['bold']],
        [' world', []],
      ],
      '**Hello,** world',
    ],
    [
      [
        ['Hello', ['bold']],
        ['world', []],
      ],
      '**Hello**world',
    ],
    [
      [
        ['Hello,', ['bold']],
        ['!', []],
      ],
      '**Hello,**!',
    ],
    [
      [
        ['x ', []],
        ['(beta)', ['italic']],
      ],
      'x *(beta)*',
    ],
    [
      [
        ['Hello,', ['bold']],
        ['world', ['bold']],
      ],
      '**Hello,world**',
    ],
    [
      [
        ['(beta)', ['italic']],
        ['€', ['bold']],
      ],
      '*(beta)***€**',
    ],
    [
      [
        ['a.', ['bold']],
        ['€', ['italic']],
      ],
      '**a.***€*',
    ],
    [
      [
        ['—', ['italic']],
        ['.', ['bold']],
      ],
      '*—***.**',
    ],
  ] as [Part[], string][]) {
    test(`control: ${JSON.stringify(parts)} exports as ${markdown}`, () => {
      const result = roundTrip(parts);
      expect(result.markdown).toBe(markdown);
      expect(result.after).toEqual(characters(parts));
      expect(commonMark(result.markdown)).toEqual(characters(parts));
    });
  }
  // An emoji is punctuation to CommonMark but not to parsers that read
  // UTF-16 units, which read this run as written: it stays as it is.
  test('control: a run next to an emoji that parsers disagree on stays as it is', () => {
    const parts: Part[] = [
      ['😀', ['bold', 'italic']],
      ['ab', ['italic']],
    ];
    const result = roundTrip(parts);
    expect(result.markdown).toBe('***😀****ab*');
    expect(result.after).toEqual(characters(parts));
  });
  // A C1 control is never written as a reference: CommonMark reads `&#128;`
  // as `€`. Its run stays as main wrote it.
  test('a C1 control next to a run stays as it is', () => {
    expect(
      roundTrip([
        ['Hello,', ['bold']],
        ['\u0080x', []],
      ]).markdown,
    ).toBe('**Hello,**\u0080x');
  });
});

/** A seeded random integer below `n`. */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return (n: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % n;
  };
}

/** A random paragraph of two to four text nodes. */
function paragraph(
  rnd: (n: number) => number,
  chunks: string[],
  formats: TextFormatType[],
): Part[] {
  const parts: Part[] = [];
  const count = 2 + rnd(3);
  for (let i = 0; i < count; i++) {
    let text = '';
    const size = 1 + rnd(3);
    for (let j = 0; j < size; j++) {
      text += chunks[rnd(chunks.length)];
    }
    parts.push([text, formats.filter(() => rnd(3) === 0)]);
  }
  return parts;
}

/**
 * Shapes the export cannot write for reasons other than flanking: a node
 * whose text starts or ends with white space inside a format (the tags go
 * inside the white space, so the space loses the format), and code with any
 * other format.
 */
function skip(parts: Part[]): boolean {
  return parts.some(
    ([text, formats]) =>
      (formats.length > 0 && (/^\s|\s$/.test(text) || text.trim() === '')) ||
      (formats.includes('code') && formats.length > 1),
  );
}

/**
 * Shapes a CommonMark parser reads differently for reasons other than
 * flanking: white space at the start or end of the paragraph (CommonMark
 * strips it), and two neighbours that share some formats but not all (the
 * export closes and opens tags of one kind in one run, `****`, which this
 * package's import reads back and CommonMark pairs differently).
 */
function skipCommonMark(parts: Part[]): boolean {
  const text = parts.map(([part]) => part).join('');
  return (
    skip(parts) ||
    /^\s|\s$/.test(text) ||
    parts.some(([, formats], i) => {
      if (i === 0) {
        return false;
      }
      const prev = parts[i - 1][1];
      const shared = formats.filter(f => prev.includes(f)).length;
      return shared > 0 && (shared < formats.length || shared < prev.length);
    })
  );
}

const SEEDS = Number(process.env.LEXICAL_MARKDOWN_SEEDS || 1500);

// Random paragraphs of letters, digits, punctuation and spaces with any
// formats export as Markdown that imports as the same characters with the
// same formats. This package's import counts only ASCII punctuation as
// punctuation (unlike CommonMark), so this one uses ASCII punctuation; the
// next one reads the Markdown with a CommonMark parser.
describe('#9660: export and import keep every character and its formats', () => {
  test(`${SEEDS} random paragraphs, this package's import`, () => {
    const chunks = ['a', 'Bc', '7', 'é', ',', '.', '(', ')', ':', '!', ' '];
    const failures: string[] = [];
    let checked = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const parts = paragraph(random(seed * 7919), chunks, FORMATS);
      if (skip(parts)) {
        continue;
      }
      checked++;
      const {after, markdown} = roundTrip(parts);
      if (JSON.stringify(after) !== JSON.stringify(characters(parts))) {
        failures.push(`seed ${seed} ${JSON.stringify(parts)} -> ${markdown}`);
      }
    }
    expect(checked).toBeGreaterThan(SEEDS / 4);
    expect(failures).toEqual([]);
  });
  test(`${SEEDS} random paragraphs, a CommonMark parser`, () => {
    const chunks = [
      ...['a', 'Bc', '7', 'é', ',', '.', '(', ')', ':', '!', ' '],
      ...['€', '—', '«', '±'],
    ];
    const formats: TextFormatType[] = [
      'bold',
      'italic',
      'strikethrough',
      'code',
    ];
    const failures: string[] = [];
    let checked = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const parts = paragraph(random(seed * 104729), chunks, formats);
      if (skipCommonMark(parts)) {
        continue;
      }
      checked++;
      const {markdown} = roundTrip(parts);
      const read = commonMark(markdown);
      if (JSON.stringify(read) !== JSON.stringify(characters(parts))) {
        failures.push(`seed ${seed} ${JSON.stringify(parts)} -> ${markdown}`);
      }
    }
    expect(checked).toBeGreaterThan(SEEDS / 8);
    expect(failures).toEqual([]);
  });
});
