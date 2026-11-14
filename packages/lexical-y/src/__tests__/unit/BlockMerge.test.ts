/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The rules of the block merge (internal/BlockMerge.ts, D133), one case
// each: what merges, what is a conflict and under which name, and what
// falls back because the merge does not read it. The corpus
// (BlockMergeCorpus.test.ts) checks the same rules over generated edits.

import type {SerializedLexicalNode} from 'lexical';

import {describe, expect, test} from 'vitest';

import {
  BLOCK_MERGE_MAX_TOKENS,
  type BlockMergeResult,
  describeBlocks,
  mergeBlock,
  type NodeKinds,
} from '../../internal/BlockMerge';

type Json = SerializedLexicalNode;

const KINDS: NodeKinds = new Map([
  ['code', 'block-element'],
  ['code-highlight', 'text'],
  ['equation', 'inline-leaf'],
  ['heading', 'block-element'],
  ['horizontalrule', 'block-leaf'],
  ['linebreak', 'linebreak'],
  ['link', 'inline-element'],
  ['list', 'block-element'],
  ['listitem', 'block-element'],
  ['mark', 'inline-element'],
  ['mention', 'text'],
  ['paragraph', 'block-element'],
  ['quote', 'block-element'],
  ['sometimes-inline', 'mixed'],
  ['tab', 'tab'],
  ['table', 'block-element'],
  ['tablecell', 'block-element'],
  ['tablerow', 'block-element'],
  ['text', 'text'],
]);

const BOLD = 1;
const ITALIC = 2;

const text = (value: string, format = 0, rest: object = {}) =>
  ({
    detail: 0,
    format,
    mode: 'normal',
    style: '',
    text: value,
    type: 'text',
    version: 1,
    ...rest,
  }) as unknown as Json;
const br = () => ({type: 'linebreak', version: 1}) as Json;
const element = (type: string, children: Json[], rest: object = {}) =>
  ({
    children,
    direction: null,
    format: '',
    indent: 0,
    type,
    version: 1,
    ...rest,
  }) as unknown as Json;
const link = (url: string, ...children: Json[]) =>
  element('link', children, {rel: null, target: null, title: null, url});
/** A paragraph with the block id `id`; a string child is a plain text node. */
const p = (id: string, ...children: (Json | string)[]) =>
  element(
    'paragraph',
    children.map(child => (typeof child === 'string' ? text(child) : child)),
    {$: {blockId: id}, textFormat: 0, textStyle: ''},
  );
const withProps = (node: Json, rest: object) => ({...node, ...rest}) as Json;

const merge = (base: Json, yours: Json, now: Json) =>
  mergeBlock(base, yours, now, KINDS);
const merged = (result: BlockMergeResult): Json => {
  if (!result.ok) {
    throw new Error(`conflict (${result.conflict}): ${result.detail}`);
  }
  return result.merged;
};
const conflict = (result: BlockMergeResult): string =>
  result.ok ? `merged: ${JSON.stringify(result.merged)}` : result.conflict;
/** The text of a block, with `[b]`, `[i]` and `<url>` around what is formatted or linked. */
const show = (node: Json): string => {
  const record = node as unknown as Record<string, unknown>;
  if (record.type === 'linebreak') {
    return '\\n';
  }
  if (record.type === 'link') {
    return `<${record.url}|${(record.children as Json[]).map(show).join('')}>`;
  }
  if (typeof record.text === 'string') {
    const format = record.format as number;
    const marks = `${format & BOLD ? 'b' : ''}${format & ITALIC ? 'i' : ''}`;
    return marks === '' ? record.text : `[${marks}:${record.text}]`;
  }
  return ((record.children as Json[]) || []).map(show).join('');
};

describe('text: changes that do not overlap merge', () => {
  test('the worked example: a word replaced by one side, text added at the end by the other', () => {
    const result = merge(
      p('b1', 'The quick brown fox jumps over the lazy dog'),
      p('b1', 'The quick red fox jumps over the lazy dog'),
      p('b1', 'The quick brown fox jumps over the sleepy dog!'),
    );
    expect(show(merged(result))).toBe(
      'The quick red fox jumps over the sleepy dog!',
    );
    expect(merged(result)).toEqual(
      p('b1', 'The quick red fox jumps over the sleepy dog!'),
    );
  });

  test('either side may be the user: the merge is the same', () => {
    const base = p('b1', 'one two three four five');
    const a = p('b1', 'one 2 three four five');
    const b = p('b1', 'one two three four 5 six');
    expect(merged(merge(base, a, b))).toEqual(merged(merge(base, b, a)));
    expect(show(merged(merge(base, a, b)))).toBe('one 2 three four 5 six');
  });

  test('a deletion by one side and an insertion by the other', () => {
    expect(
      show(
        merged(
          merge(
            p('b1', 'alpha beta gamma delta'),
            p('b1', 'alpha gamma delta'),
            p('b1', 'alpha beta gamma delta epsilon'),
          ),
        ),
      ),
    ).toBe('alpha gamma delta epsilon');
  });

  test('two letters typed into one word are a conflict', () => {
    // diff3 compares words: both sides changed the word `cat`.
    expect(
      conflict(
        merge(
          p('b1', 'a cat sat'),
          p('b1', 'a chat sat'),
          p('b1', 'a cats sat'),
        ),
      ),
    ).toBe('overlap');
    expect(
      conflict(
        merge(
          p('b1', 'a cat sat'),
          p('b1', 'a cart sat'),
          p('b1', 'a cats sat'),
        ),
      ),
    ).toBe('overlap');
  });

  test('a line break added by one side', () => {
    const result = merged(
      merge(
        p('b1', 'first line second line'),
        p('b1', 'first line', br(), 'second line'),
        p('b1', 'The first line second line'),
      ),
    );
    expect(show(result)).toBe('The first line\\nsecond line');
  });

  test('an accent or a joined emoji is one character', () => {
    const family = String.fromCodePoint(
      0x1f468,
      0x200d,
      0x1f469,
      0x200d,
      0x1f467,
    );
    const girl = String.fromCodePoint(0x1f467);
    const result = merged(
      merge(
        p('b1', `café ${family} end`),
        p('b1', `cafés ${family} end`),
        p('b1', `café ${family} ${girl} end`),
      ),
    );
    expect(show(result)).toBe(`cafés ${family} ${girl} end`);
    // One side swaps the accent, the other types after the letter: the
    // accented letter is one token, so the two touch.
    expect(
      conflict(
        merge(
          p('b1', 'café au lait'),
          p('b1', 'cafè au lait'),
          p('b1', 'cafés au lait'),
        ),
      ),
    ).toBe('overlap');
  });

  test('text nodes of the base that neither side touched come back as they were', () => {
    const base = p(
      'b1',
      text('bold', BOLD),
      ' and plain and ',
      text('italic', ITALIC),
    );
    const result = merged(
      merge(
        base,
        p(
          'b1',
          text('bold', BOLD),
          ' and very plain and ',
          text('italic', ITALIC),
        ),
        p(
          'b1',
          text('bold', BOLD),
          ' and plain and ',
          text('italic', ITALIC),
          ' end',
        ),
      ),
    );
    expect(result).toEqual(
      p(
        'b1',
        text('bold', BOLD),
        ' and very plain and ',
        text('italic', ITALIC),
        ' end',
      ),
    );
  });
});

describe('text: changes that overlap or touch are a conflict', () => {
  test.each([
    ['both add at one place', 'three', 'three, mine', 'three, theirs'],
    ['both replace one word', 'a red car', 'a blue car', 'a green car'],
    [
      'one adds inside what the other removed',
      'one two three',
      'one three',
      'one twenty-two three',
    ],
    [
      'one adds right after what the other removed',
      'one two three',
      'one three',
      'one two, three',
    ],
    [
      'two deletions that touch',
      'one two three four',
      'one three four',
      'one two four',
    ],
    [
      'both sides rewrite most of the line',
      'the quick brown fox',
      'a slow green cat',
      'that quick brown ox',
    ],
  ])('%s', (_name, base, yours, now) => {
    expect(conflict(merge(p('b1', base), p('b1', yours), p('b1', now)))).toBe(
      'overlap',
    );
  });

  test('changes with a word between them', () => {
    // A word between two typed words keeps them apart.
    expect(
      merged(
        merge(
          p('b1', 'see the ancient barn'),
          p('b1', 'see the fine ancient barn'),
          p('b1', 'see the ancient red wooden barn'),
        ),
      ),
    ).toEqual(p('b1', 'see the fine ancient red wooden barn'));
    // However short: a word both sides kept is not rewritten text.
    expect(
      show(
        merged(
          merge(
            p('b1', 'pack my box'),
            p('b1', 'pack tidy my box'),
            p('b1', 'pack my own box'),
          ),
        ),
      ),
    ).toBe('pack tidy my own box');
    // Nothing between them: they touch.
    expect(
      conflict(
        merge(
          p('b1', 'pack my box'),
          p('b1', 'pack my tidy box'),
          p('b1', 'pack my own box'),
        ),
      ),
    ).toBe('overlap');
  });
});

describe('text: the same change on both sides is one change', () => {
  test('an edit of the user that did reach the server, beside another edit', () => {
    const now = p('b1', 'hello brave world, again');
    const result = merged(
      merge(p('b1', 'hello world'), p('b1', 'hello brave world'), now),
    );
    expect(result).toEqual(now);
  });

  test('wherever the diff places it: a word typed beside the same word', () => {
    // `very very good`: the new `very ` may be read before or after the
    // old one, and each side is free to be read another way.
    const now = p('b1', 'it is very very good, really');
    expect(
      merged(
        merge(p('b1', 'it is very good'), p('b1', 'it is very very good'), now),
      ),
    ).toEqual(now);
  });

  test('the merge of a merge is the merge', () => {
    const base = p('b1', 'one two three four five six seven');
    const yours = p('b1', 'one two 3 four five six seven', text(' end', BOLD));
    const now = p('b1', 'zero one two three four 5 six seven');
    const first = merged(merge(base, yours, now));
    expect(show(first)).toBe('zero one two 3 four 5 six seven[b: end]');
    expect(merged(merge(base, yours, first))).toEqual(first);
  });
});

describe('formatting, style and state on text', () => {
  test('a format one side gave applies to the text the other side edited around', () => {
    const result = merged(
      merge(
        p('b1', 'make this bold please'),
        p('b1', 'make ', text('this bold', BOLD), ' please'),
        p('b1', 'Now make this bold please!'),
      ),
    );
    expect(show(result)).toBe('Now make [b:this bold] please!');
  });

  test('two formats over the same text are both there', () => {
    const result = merged(
      merge(
        p('b1', 'one two three'),
        p('b1', 'one ', text('two', BOLD), ' three'),
        p('b1', 'one ', text('two three', ITALIC)),
      ),
    );
    expect(show(result)).toBe('one [bi:two][i: three]');
  });

  test('text typed inside a range the other side formatted has the format; at its edge it keeps its own', () => {
    const inside = merged(
      merge(
        p('b1', 'a long phrase here'),
        p('b1', 'a ', text('long phrase', BOLD), ' here'),
        p('b1', 'a long winding phrase here'),
      ),
    );
    expect(show(inside)).toBe('a [b:long winding phrase] here');
    const edge = merged(
      merge(
        p('b1', 'a long phrase here'),
        p('b1', 'a ', text('long phrase', BOLD), ' here'),
        p('b1', 'a long phrase, right here'),
      ),
    );
    expect(show(edge)).toBe('a [b:long phrase], right here');
  });

  test('subscript by one side and superscript by the other is a conflict, as two cases are', () => {
    for (const [mine, theirs] of [
      [32, 64],
      [256, 512],
      [512, 1024],
    ]) {
      expect(
        conflict(
          merge(
            p('b1', 'see the dog run'),
            p('b1', 'see the ', text('dog', mine), ' run'),
            p('b1', 'see the ', text('dog', theirs), ' run'),
          ),
        ),
      ).toBe('format');
    }
    // Bold by one side, subscript by the other: both.
    expect(
      merged(
        merge(
          p('b1', 'see the dog run'),
          p('b1', 'see the ', text('dog', BOLD), ' run'),
          p('b1', 'see the ', text('dog', 32), ' run'),
        ),
      ),
    ).toEqual(p('b1', 'see the ', text('dog', BOLD | 32), ' run'));
  });

  test('a style both sides changed differently is a conflict; alike, it is taken once', () => {
    const base = p('b1', 'colored text');
    const red = p('b1', text('colored text', 0, {style: 'color: red'}));
    const blue = p('b1', text('colored text', 0, {style: 'color: blue'}));
    expect(conflict(merge(base, red, blue))).toBe('format');
    expect(merged(merge(base, red, red))).toEqual(red);
  });

  test('NodeState on text merges key by key', () => {
    const base = p('b1', 'noted text');
    const result = merged(
      merge(
        base,
        p('b1', text('noted text', 0, {$: {tone: 'warm'}})),
        p('b1', text('noted text', 0, {$: {rank: 3}})),
      ),
    );
    expect(result).toEqual(
      p('b1', text('noted text', 0, {$: {rank: 3, tone: 'warm'}})),
    );
    expect(
      conflict(
        merge(
          base,
          p('b1', text('noted text', 0, {$: {tone: 'warm'}})),
          p('b1', text('noted text', 0, {$: {tone: 'cold'}})),
        ),
      ),
    ).toBe('format');
  });

  test('text one side removed, the other may not have reformatted', () => {
    // It may have moved to another block, where the format would be lost.
    expect(
      conflict(
        merge(
          p('b1', 'keep this, drop that'),
          p('b1', 'keep this'),
          p('b1', 'keep this, drop ', text('that', BOLD)),
        ),
      ),
    ).toBe('format');
  });

  test('a letter typed beside the same letter, one of which the other side reformatted', () => {
    // Which `l` of `hello` is the new one is not known.
    expect(
      conflict(
        merge(
          p('b1', 'helo there'),
          p('b1', 'hello there'),
          p('b1', 'he', text('l', BOLD), 'o there'),
        ),
      ),
    ).toBe('unverified');
  });
});

describe('text that reads more than one way', () => {
  // Found by the corpus: each of these is two edits that some alignment of
  // the text reads as other edits, with another result.
  test('one of two equal words removed, where the other side linked one of them', () => {
    // Which `brown` is left is not known.
    expect(
      merge(
        p('b1', 'a lazy brown brown fox still'),
        p(
          'b1',
          'a lazy ',
          link('https://a.example', text('brown')),
          ' brown fox still',
        ),
        p('b1', 'a lazy  brown  still'),
      ).ok,
    ).toBe(false);
  });

  test('a letter and its space kept, or the space and the next letter', () => {
    // `a a` to `onyx a `: the first `a` and the space, or the space and
    // the last `a`, which the other side made bold.
    expect(
      merge(p('b1', 'a a'), p('b1', 'a ', text('a', BOLD)), p('b1', 'onyx a '))
        .ok,
    ).toBe(false);
  });

  test('text added at the end that ends as the block did', () => {
    // The `dog` the other side made italic is the old one or the new one.
    expect(
      merge(
        p('b1', 'see the dog'),
        p('b1', 'see the ', text('dog', ITALIC)),
        p('b1', 'see the dog and then another dog'),
      ).ok,
    ).toBe(false);
  });

  test('two words typed around a space the other side reformatted', () => {
    expect(
      merge(
        p('b1', 'see the dog run'),
        p('b1', 'see the', text(' dog', ITALIC), ' run'),
        p('b1', 'see the jade  quartzdog run'),
      ).ok,
    ).toBe(false);
  });

  test('a word typed before a word the other side made bold', () => {
    // No letter of `big ` begins `dog`: one reading.
    expect(
      show(
        merged(
          merge(
            p('b1', 'see the dog run'),
            p('b1', 'see the ', text('dog', BOLD), ' run'),
            p('b1', 'see the big dog run'),
          ),
        ),
      ),
    ).toBe('see the big [b:dog] run');
    // `good ` holds the letters of `dog`: which `d`, `o` and `g` are the
    // bold ones could be read another way, so it is left to the panel.
    expect(
      conflict(
        merge(
          p('b1', 'see the dog run'),
          p('b1', 'see the ', text('dog', BOLD), ' run'),
          p('b1', 'see the good dog run'),
        ),
      ),
    ).toBe('unverified');
  });
});

describe('links and other inline elements', () => {
  const base = p(
    'b1',
    'see ',
    link('https://a.example', text('the docs')),
    ' for more',
  );

  test('a URL one side changed, with text the other side typed inside the link', () => {
    const result = merged(
      merge(
        base,
        p(
          'b1',
          'see ',
          link('https://b.example', text('the docs')),
          ' for more',
        ),
        p(
          'b1',
          'see ',
          link('https://a.example', text('the new docs')),
          ' for more',
        ),
      ),
    );
    expect(show(result)).toBe('see <https://b.example|the new docs> for more');
  });

  test('a link one side made, around text the other side edited elsewhere', () => {
    const result = merged(
      merge(
        p('b1', 'read the manual first, please'),
        p(
          'b1',
          'read ',
          link('https://m.example', text('the manual')),
          ' first, please',
        ),
        p('b1', 'read the manual first, please do'),
      ),
    );
    expect(show(result)).toBe(
      'read <https://m.example|the manual> first, please do',
    );
  });

  test('a link removed by one side, with text the other side typed inside it', () => {
    const result = merged(
      merge(
        base,
        p('b1', 'see the docs for more'),
        p(
          'b1',
          'see ',
          link('https://a.example', text('the new docs')),
          ' for more',
        ),
      ),
    );
    expect(show(result)).toBe('see the new docs for more');
  });

  test('two URLs for one link are a conflict', () => {
    expect(
      conflict(
        merge(
          base,
          p(
            'b1',
            'see ',
            link('https://b.example', text('the docs')),
            ' for more',
          ),
          p(
            'b1',
            'see ',
            link('https://c.example', text('the docs')),
            ' for more',
          ),
        ),
      ),
    ).toBe('format');
  });

  test('text typed at the end of a link, inside it, while the other side changed the link', () => {
    // It would stay behind in a link of its own with the old URL.
    expect(
      merge(
        base,
        p(
          'b1',
          'see ',
          link('https://b.example', text('the docs')),
          ' for more',
        ),
        p(
          'b1',
          'see ',
          link('https://a.example', text('the docs here')),
          ' for more',
        ),
      ).ok,
    ).toBe(false);
    expect(
      conflict(
        merge(
          base,
          p(
            'b1',
            'see ',
            link('https://b.example', text('the docs')),
            ' for more',
          ),
          p(
            'b1',
            'see ',
            link('https://a.example', text('the docs!')),
            ' for more',
          ),
        ),
      ),
    ).toBe('format');
  });

  test('two links side by side stay two links', () => {
    const two = (tail: string) =>
      p(
        'b1',
        link('https://a.example', text('one')),
        link('https://a.example', text('two')),
        tail,
      );
    expect(merged(merge(two(' end'), two(' the end'), two(' end.')))).toEqual(
      two(' the end.'),
    );
  });
});

describe('nodes that are one token', () => {
  const equation = (source: string) =>
    ({
      equation: source,
      inline: true,
      type: 'equation',
      version: 1,
    }) as unknown as Json;
  const mention = (name: string) =>
    text(name, 0, {mode: 'token', type: 'mention'});

  test('a decorator one side changed, beside text the other side edited', () => {
    const result = merged(
      merge(
        p('b1', 'so ', equation('a+b'), ' holds for all'),
        p('b1', 'so ', equation('a+b+c'), ' holds for all'),
        p('b1', 'so ', equation('a+b'), ' holds for all of them'),
      ),
    );
    expect(result).toEqual(
      p('b1', 'so ', equation('a+b+c'), ' holds for all of them'),
    );
  });

  test('a decorator both sides changed is a conflict', () => {
    expect(
      conflict(
        merge(
          p('b1', 'so ', equation('a+b'), ' holds'),
          p('b1', 'so ', equation('a+c'), ' holds'),
          p('b1', 'so ', equation('a+d'), ' holds'),
        ),
      ),
    ).toBe('format');
  });

  test('a token-mode text node is never merged inside', () => {
    expect(
      conflict(
        merge(
          p('b1', 'hi ', mention('Ada Lovelace'), ' and all'),
          p('b1', 'hi ', mention('Ada King Lovelace'), ' and all'),
          p('b1', 'hi ', mention('Ada Lovelace, Countess'), ' and all'),
        ),
      ),
    ).toBe('overlap');
    const result = merged(
      merge(
        p('b1', 'hi ', mention('Ada Lovelace'), ' and all'),
        p('b1', 'hi ', mention('Ada Lovelace'), ' and all of you'),
        p('b1', 'oh hi ', mention('Ada Lovelace'), ' and all'),
      ),
    );
    expect(result).toEqual(
      p('b1', 'oh hi ', mention('Ada Lovelace'), ' and all of you'),
    );
  });

  test('a tab is one token with a format of its own', () => {
    const tab = (format = 0) => text('\t', format, {type: 'tab'});
    const result = merged(
      merge(
        p('b1', 'key', tab(), 'value here'),
        p('b1', 'key', tab(), tab(), 'value here'),
        p('b1', 'key', tab(), 'value here too'),
      ),
    );
    expect(result).toEqual(p('b1', 'key', tab(), tab(), 'value here too'));
  });
});

describe('two passes: content, then properties', () => {
  test('bold by one side, text typed near it by the other: the text aligns, the bold merges', () => {
    const bold = p('b1', 'the ', text('quick', BOLD), ' brown fox');
    expect(
      show(
        merged(
          merge(
            p('b1', 'the quick brown fox'),
            bold,
            p('b1', 'the quick very brown fox'),
          ),
        ),
      ),
    ).toBe('the [b:quick] very brown fox');
    // Typed right after the bold word: at the edge of the range, it keeps
    // its own format.
    expect(
      show(
        merged(
          merge(
            p('b1', 'the quick brown fox'),
            bold,
            p('b1', 'the quick, brown fox'),
          ),
        ),
      ),
    ).toBe('the [b:quick], brown fox');
    // Typed inside the bold word: it is bold too.
    expect(
      show(
        merged(
          merge(
            p('b1', 'the quick brown fox'),
            bold,
            p('b1', 'the quiick brown fox'),
          ),
        ),
      ),
    ).toBe('the [b:quiick] brown fox');
  });
});

describe('comment marks', () => {
  const mark = (ids: string[], ...children: Json[]) =>
    element('mark', children, {ids});

  test('a comment one side added, beside text the other side edited', () => {
    expect(
      merged(
        merge(
          p('b1', 'the quick brown fox'),
          p('b1', 'the ', mark(['c1'], text('quick')), ' brown fox'),
          p('b1', 'the quick brown fox jumps'),
        ),
      ),
    ).toEqual(p('b1', 'the ', mark(['c1'], text('quick')), ' brown fox jumps'));
  });

  test('comments both sides added over the same text are a conflict', () => {
    expect(
      conflict(
        merge(
          p('b1', 'the quick brown fox'),
          p('b1', 'the ', mark(['c1'], text('quick brown')), ' fox'),
          p('b1', 'the quick ', mark(['c2'], text('brown fox'))),
        ),
      ),
    ).toBe('format');
  });

  test('a reply added to a comment, with text the other side typed inside it', () => {
    expect(
      merged(
        merge(
          p('b1', 'the ', mark(['c1'], text('quick brown')), ' fox'),
          p('b1', 'the ', mark(['c1', 'c2'], text('quick brown')), ' fox'),
          p('b1', 'the ', mark(['c1'], text('quick, brown')), ' fox'),
        ),
      ),
    ).toEqual(
      p('b1', 'the ', mark(['c1', 'c2'], text('quick, brown')), ' fox'),
    );
  });

  test('two comments side by side stay two', () => {
    const two = (tail: string) =>
      p('b1', mark(['c1'], text('one')), mark(['c1'], text('two')), tail);
    expect(merged(merge(two(' end'), two(' the end'), two(' end.')))).toEqual(
      two(' the end.'),
    );
  });
});

describe('code', () => {
  const token = (value: string, highlightType?: string) =>
    text(value, 0, {
      type: 'code-highlight',
      ...(highlightType === undefined ? {} : {highlightType}),
    });
  const tab = () => text('\t', 0, {type: 'tab'});
  const code = (...children: Json[]) =>
    element('code', children, {$: {blockId: 'k1'}, language: 'js'});
  const line1 = (n: string) => [
    token('let', 'keyword'),
    token(' a '),
    token('=', 'operator'),
    token(' '),
    token(n, 'number'),
  ];

  test('two lines of a code block, one edited by each side, with their own highlighting', () => {
    const base = code(
      ...line1('1'),
      br(),
      tab(),
      token('return', 'keyword'),
      token(' a'),
    );
    const yours = code(
      ...line1('2'),
      br(),
      tab(),
      token('return', 'keyword'),
      token(' a'),
    );
    const now = code(
      ...line1('1'),
      br(),
      tab(),
      token('return', 'keyword'),
      token(' a '),
      token('+', 'operator'),
      token(' '),
      token('1', 'number'),
    );
    expect(merged(merge(base, yours, now))).toEqual(
      code(
        ...line1('2'),
        br(),
        tab(),
        token('return', 'keyword'),
        token(' a '),
        token('+', 'operator'),
        token(' '),
        token('1', 'number'),
      ),
    );
  });

  test('one token both sides changed is a conflict', () => {
    const base = code(...line1('1'));
    expect(
      conflict(merge(base, code(...line1('2')), code(...line1('3')))),
    ).toBe('overlap');
  });
});

describe('review cases', () => {
  const mark = (ids: string[], ...children: Json[]) =>
    element('mark', children, {ids});
  const stated = (value: string, state: object) => text(value, 0, {$: state});

  test('text typed between two text runs the other side put in two links stays out of both', () => {
    for (const wrap of [
      (value: string) => link('https://a.example', text(value)),
      (value: string) => mark(['c1'], text(value)),
    ]) {
      expect(
        merged(
          merge(p('b1', 'ab'), p('b1', 'a!b'), p('b1', wrap('a'), wrap('b'))),
        ),
      ).toEqual(p('b1', wrap('a'), '!', wrap('b')));
    }
  });

  test('typed text takes a NodeState key both neighbours changed alike, and keeps its own', () => {
    expect(
      merged(
        merge(
          p('b1', stated('ab', {tone: 'plain'})),
          p(
            'b1',
            stated('a', {tone: 'plain'}),
            stated('!', {note: 'mine', tone: 'plain'}),
            stated('b', {tone: 'plain'}),
          ),
          p('b1', stated('ab', {tone: 'red'})),
        ),
      ),
    ).toEqual(
      p(
        'b1',
        stated('a', {tone: 'red'}),
        stated('!', {note: 'mine', tone: 'red'}),
        stated('b', {tone: 'red'}),
      ),
    );
    // A key only one neighbour changed is not taken.
    expect(
      merged(
        merge(
          p(
            'b1',
            stated('a', {note: 'mine', tone: 'plain'}),
            stated('b', {tone: 'plain'}),
          ),
          p(
            'b1',
            stated('a!', {note: 'mine', tone: 'plain'}),
            stated('b', {tone: 'plain'}),
          ),
          p('b1', stated('ab', {tone: 'red'})),
        ),
      ),
    ).toEqual(
      p(
        'b1',
        stated('a', {tone: 'red'}),
        stated('!', {note: 'mine', tone: 'red'}),
        stated('b', {tone: 'red'}),
      ),
    );
  });

  test('NodeState keys named like node properties are plain keys', () => {
    for (const [was, is] of [
      [{text: 'old'}, {text: 'new'}],
      [{format: 'old'}, {format: 'new'}],
    ]) {
      expect(
        merged(
          merge(
            p('b1', stated('ab', was)),
            p('b1', stated('a', was), stated('!', was), stated('b', was)),
            p('b1', stated('ab', is)),
          ),
        ),
      ).toEqual(p('b1', stated('a', is), stated('!', is), stated('b', is)));
    }
    // Keys named like Object.prototype members are kept too.
    const block = (state: object) =>
      withProps(p('b1', 'ab'), {$: {blockId: 'b1', ...state}});
    expect(
      merged(
        merge(
          block({}),
          block({valueOf: 'mine'}),
          withProps(p('b1', 'ab!'), {$: {blockId: 'b1', color: 'red'}}),
        ),
      ),
    ).toEqual(
      withProps(p('b1', 'ab!'), {
        $: {blockId: 'b1', color: 'red', valueOf: 'mine'},
      }),
    );
    // Two values for one NodeState key named `format` are a conflict, not
    // bits to combine.
    for (const key of ['format', 'textFormat']) {
      expect(
        conflict(
          merge(
            p('b1', stated('ab', {[key]: 1})),
            p('b1', stated('ab', {[key]: 2})),
            p('b1', stated('ab', {[key]: 4})),
          ),
        ),
      ).toBe('format');
    }
    // A number under `format` in NodeState is a value, not format bits.
    expect(
      merged(
        merge(
          p('b1', stated('a', {format: 1}), stated('b', {format: 4})),
          p('b1', stated('a!', {format: 1}), stated('b', {format: 4})),
          p('b1', stated('a', {format: 2}), stated('b', {format: 2})),
        ),
      ),
    ).toEqual(p('b1', stated('a!b', {format: 2})));
  });

  test('a NodeState value with a "__proto__" key is a value like any other', () => {
    const special = JSON.parse('{"value":0,"__proto__":"mine"}');
    const withMeta = (value: string, meta: object) =>
      withProps(p('b1', value), {$: {blockId: 'b1', meta}});
    expect(
      merged(
        merge(
          withMeta('ab', {value: 0}),
          withMeta('ab', special),
          withMeta('ab!', {value: 0}),
        ),
      ),
    ).toEqual(withMeta('ab!', special));
  });

  test('text without spaces between words merges by character', () => {
    expect(
      show(
        merged(
          merge(
            p('b1', '我们今天去公园散步然后回家吃饭'),
            p('b1', '我们明天去公园散步然后回家吃饭'),
            p('b1', '我们今天去公园散步然后回家吃晚饭'),
          ),
        ),
      ),
    ).toBe('我们明天去公园散步然后回家吃晚饭');
  });

  test('an accent in a text node of its own is not the same character as an accented letter', () => {
    const result = merge(
      p('b1', text('e', BOLD), '\u0301', ' x'),
      p('b1', text('e\u0301', BOLD), ' x'),
      p('b1', text('e', BOLD), '\u0301', ' x!'),
    );
    // A merge or a conflict, never a throw.
    expect(typeof result.ok).toBe('boolean');
  });

  test('a long block both sides rewrote is a conflict, in bounded time', () => {
    let seed = 5432;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const letters = (n: number) =>
      Array.from({length: n}, () => 'abcd'[random() % 4]).join('');
    const base = letters(40000);
    const started = Date.now();
    const result = merge(
      p('b1', base),
      p('b1', letters(40000)),
      p('b1', `${base}!`),
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(conflict(result)).toBe('unsupported');
  });
});

describe('element properties merge one by one', () => {
  const base = p('b1', 'a line of text');

  test('a block type one side changed, with text the other side edited', () => {
    const heading = element('heading', [text('a line of text')], {
      $: {blockId: 'b1'},
      tag: 'h2',
    });
    const result = merged(
      merge(base, heading, p('b1', 'a longer line of text')),
    );
    expect(result).toEqual(
      element('heading', [text('a longer line of text')], {
        $: {blockId: 'b1'},
        tag: 'h2',
      }),
    );
  });

  test('alignment by one side and indent by the other', () => {
    const result = merged(
      merge(
        base,
        withProps(base, {format: 'center'}),
        withProps(base, {indent: 2}),
      ),
    );
    expect(result).toEqual(withProps(base, {format: 'center', indent: 2}));
  });

  test('one property changed two ways is a conflict; alike, it is taken once', () => {
    expect(
      conflict(
        merge(
          base,
          withProps(base, {format: 'center'}),
          withProps(base, {format: 'right'}),
        ),
      ),
    ).toBe('property');
    expect(
      merged(
        merge(
          base,
          withProps(p('b1', 'a line of text!'), {format: 'center'}),
          withProps(p('b1', 'A line of text'), {format: 'center'}),
        ),
      ),
    ).toEqual(withProps(p('b1', 'A line of text!'), {format: 'center'}));
  });

  test('a type changed by one side and another property by the other is a conflict', () => {
    const quote = element('quote', [text('a line of text')], {
      $: {blockId: 'b1'},
    });
    expect(conflict(merge(base, quote, withProps(base, {indent: 1})))).toBe(
      'property',
    );
  });

  test('element NodeState merges key by key, and the block id stays', () => {
    const state = (extra: object) =>
      withProps(base, {$: {blockId: 'b1', ...extra}});
    expect(
      merged(merge(base, state({tone: 'warm'}), state({rank: 1}))),
    ).toEqual(state({rank: 1, tone: 'warm'}));
    expect(
      conflict(merge(base, state({tone: 'warm'}), state({tone: 'cold'}))),
    ).toBe('property');
  });
});

describe('blocks that hold blocks', () => {
  const li = (id: string, value: string, n: number) =>
    element('listitem', [text(value)], {$: {blockId: id}, value: n});
  const list = (...items: Json[]) =>
    element('list', items, {
      $: {blockId: 'l1'},
      listType: 'bullet',
      start: 1,
      tag: 'ul',
    });
  const cell = (id: string, value: string, rest: object = {}) =>
    element('tablecell', [p(id, value)], {
      backgroundColor: null,
      colSpan: 1,
      headerState: 0,
      rowSpan: 1,
      ...rest,
    });
  const row = (...cells: Json[]) => element('tablerow', cells);
  const table = (...rows: Json[]) =>
    element('table', rows, {$: {blockId: 't1'}});

  test('two items of a list, one edited by each side', () => {
    const result = merged(
      merge(
        list(li('i1', 'milk', 1), li('i2', 'eggs', 2)),
        list(li('i1', 'oat milk', 1), li('i2', 'eggs', 2)),
        list(li('i1', 'milk', 1), li('i2', 'six eggs', 2)),
      ),
    );
    expect(result).toEqual(
      list(li('i1', 'oat milk', 1), li('i2', 'six eggs', 2)),
    );
  });

  test('one item edited by both sides merges as text does', () => {
    const base = list(li('i1', 'buy milk and eggs today', 1));
    expect(
      merged(
        merge(
          base,
          list(li('i1', 'buy oat milk and eggs today', 1)),
          list(li('i1', 'buy milk and eggs tomorrow', 1)),
        ),
      ),
    ).toEqual(list(li('i1', 'buy oat milk and eggs tomorrow', 1)));
    expect(
      conflict(
        merge(
          base,
          list(li('i1', 'buy tea', 1)),
          list(li('i1', 'buy coffee', 1)),
        ),
      ),
    ).toBe('overlap');
  });

  test('an item added by one side, another edited by the other', () => {
    const result = merged(
      merge(
        list(li('i1', 'milk', 1), li('i2', 'eggs', 2)),
        list(li('i1', 'milk', 1), li('new', 'bread', 2), li('i2', 'eggs', 3)),
        list(li('i1', 'milk', 1), li('i2', 'six eggs', 2)),
      ),
    );
    // The added item's place, and the numbering it gave the items after it.
    expect(result).toEqual(
      list(li('i1', 'milk', 1), li('new', 'bread', 2), li('i2', 'six eggs', 3)),
    );
  });

  test('items added by both sides at one place, or removed by one and changed by the other, are a conflict', () => {
    const base = list(li('i1', 'milk', 1), li('i2', 'eggs', 2));
    // At two places they merge, as diff3 merges lines.
    expect(
      merged(
        merge(
          base,
          list(li('i1', 'milk', 1), li('i2', 'eggs', 2), li('y', 'tea', 3)),
          list(li('n', 'jam', 1), li('i1', 'milk', 2), li('i2', 'eggs', 3)),
        ),
      ),
    ).toEqual(
      list(
        li('n', 'jam', 1),
        li('i1', 'milk', 2),
        li('i2', 'eggs', 3),
        li('y', 'tea', 3),
      ),
    );
    expect(
      conflict(
        merge(
          base,
          list(li('i1', 'milk', 1), li('y', 'tea', 2), li('i2', 'eggs', 3)),
          list(li('i1', 'milk', 1), li('n', 'jam', 2), li('i2', 'eggs', 3)),
        ),
      ),
    ).toBe('structure');
    expect(
      conflict(
        merge(
          base,
          list(li('i1', 'milk', 1)),
          list(li('i1', 'milk', 1), li('i2', 'six eggs', 2)),
        ),
      ),
    ).toBe('structure');
  });

  test('cells of a table: rows and cells have no id and are read through', () => {
    const base = table(row(cell('c1', 'north'), cell('c2', 'south')));
    const result = merged(
      merge(
        base,
        table(row(cell('c1', 'far north'), cell('c2', 'south'))),
        table(
          row(
            cell('c1', 'north'),
            cell('c2', 'south', {backgroundColor: '#eee'}),
          ),
        ),
      ),
    );
    expect(result).toEqual(
      table(
        row(
          cell('c1', 'far north'),
          cell('c2', 'south', {backgroundColor: '#eee'}),
        ),
      ),
    );
  });

  test('a row added by one side, a cell edited by the other', () => {
    const base = table(row(cell('c1', 'north'), cell('c2', 'south')));
    const added = row(cell('c3', 'east'), cell('c4', 'west'));
    const result = merged(
      merge(
        base,
        table(row(cell('c1', 'north'), cell('c2', 'south')), added),
        table(row(cell('c1', 'north'), cell('c2', 'deep south'))),
      ),
    );
    expect(result).toEqual(
      table(row(cell('c1', 'north'), cell('c2', 'deep south')), added),
    );
    // A row or cell without an id is followed by the first block with an
    // id inside it, so a cell's own property merges too.
    expect(
      merged(
        merge(
          base,
          table(row(cell('c1', 'north'), cell('c2', 'south')), added),
          table(
            row(
              cell('c1', 'north', {backgroundColor: '#eee'}),
              cell('c2', 'south'),
            ),
          ),
        ),
      ),
    ).toEqual(
      table(
        row(
          cell('c1', 'north', {backgroundColor: '#eee'}),
          cell('c2', 'south'),
        ),
        added,
      ),
    );
  });

  test('a block without an id that both sides changed is a conflict', () => {
    const anonymous = (value: string) =>
      element('quote', [element('paragraph', [text(value)])], {
        $: {blockId: 'q1'},
      });
    expect(
      conflict(
        merge(
          anonymous('one two three'),
          anonymous('one 2 three'),
          anonymous('one two 3'),
        ),
      ),
    ).toBe('structure');
  });

  test('a block decorator both sides changed is a conflict', () => {
    const rule = (color: string) =>
      ({
        $: {blockId: 'h1'},
        color,
        type: 'horizontalrule',
        version: 1,
      }) as unknown as Json;
    expect(conflict(merge(rule('a'), rule('b'), rule('c')))).toBe('overlap');
  });

  test('a merge that would hold one block id twice is dropped', () => {
    // One side moves `c2` into a new row; the other side's `c1` turns into
    // a container that holds a block with that id.
    const base = table(row(cell('c1', 'north')));
    const nested = element('quote', [p('dup', 'nested'), p('other', 'more')], {
      $: {blockId: 'c1'},
    });
    const result = merge(
      base,
      table(row(cell('c1', 'north')), row(cell('dup', 'east'))),
      table(row(element('tablecell', [nested]))),
    );
    expect(result.ok).toBe(false);
  });
});

describe('what the merge does not read falls back to a conflict', () => {
  test.each([
    [
      'a node type the editor did not report',
      p('b1', 'one two', {type: 'mystery', version: 1} as Json),
    ],
    [
      'a type whose nodes are sometimes inline',
      p('b1', 'one two', {type: 'sometimes-inline', version: 1} as Json),
    ],
    ['an empty text node', p('b1', 'one two', text(''))],
    ['an empty link', p('b1', 'one two', link('https://a.example'))],
    [
      'text beside a block',
      p('b1', 'one two', element('paragraph', [text('inner')])),
    ],
  ])('%s', (_name, base) => {
    const record = base as unknown as {children: Json[]};
    const edit = (first: string) =>
      ({...base, children: [text(first), ...record.children.slice(1)]}) as Json;
    const result = merge(base, edit('one 2'), edit('1 two'));
    expect(conflict(result)).toBe('unsupported');
  });

  test('a block longer than the merge reads', () => {
    const long = 'word '.repeat(BLOCK_MERGE_MAX_TOKENS / 5 + 1);
    expect(
      conflict(
        merge(p('b1', long), p('b1', `A ${long}`), p('b1', `${long} Z`)),
      ),
    ).toBe('unsupported');
  });

  test('repeated text at the size limit merges in bounded time', () => {
    // The worst case for an LCS: every word the same.
    const words = Math.floor(BLOCK_MERGE_MAX_TOKENS / 4);
    const same = Array.from({length: words}, () => 'aa').join(' ');
    const started = Date.now();
    const result = merge(
      p('b1', `${same} end`),
      p('b1', `start ${same} end`),
      p('b1', `${same} end!`),
    );
    expect(Date.now() - started).toBeLessThan(10000);
    expect(result.ok).toBe(true);
  });

  test('a long block with a few edits merges', () => {
    const long = 'lorem ipsum dolor sit amet '.repeat(300);
    const result = merged(
      merge(
        p('b1', long),
        p('b1', `Start: ${long}`),
        p('b1', `${long}The end.`),
      ),
    );
    expect(show(result)).toBe(`Start: ${long}The end.`);
  });
});

describe("the report's blocks", () => {
  const base = [p('b1', 'one'), p('b2', 'two words here'), p('b3', 'three')];
  const describe3 = (yours: Json[], now: Json[], blockMerge = true) =>
    describeBlocks({base, blockMerge, kinds: KINDS, now, yours});

  test('whole, merged and conflict, with why', () => {
    const blocks = describe3(
      [
        p('b1', 'one, mine'),
        p('b2', 'two more words here'),
        p('b3', 'three, mine'),
      ],
      [
        p('b1', 'one'),
        p('b2', 'two words here, too'),
        p('b3', 'three, theirs'),
      ],
    );
    expect(
      blocks.map(block => [
        block.id,
        block.resolution,
        block.replayable,
        block.conflict,
      ]),
    ).toEqual([
      ['b1', 'whole', true, undefined],
      ['b2', 'merged', false, undefined],
      ['b3', 'conflict', false, 'overlap'],
    ]);
    expect(blocks[1].merged).toEqual(p('b2', 'two more words here, too'));
    expect(blocks[0].merged).toBeNull();
    expect(blocks[2].merged).toBeNull();
    expect(typeof blocks[2].conflictDetail).toBe('string');
  });

  test('blockMerge: false leaves every block both sides changed a conflict', () => {
    const blocks = describe3(
      [p('b1', 'one'), p('b2', 'two more words here'), p('b3', 'three')],
      [p('b1', 'one'), p('b2', 'two words here, too'), p('b3', 'three')],
      false,
    );
    expect(blocks.map(block => [block.resolution, block.conflict])).toEqual([
      ['conflict', 'block-merge-off'],
    ]);
  });

  test('a block the document holds as the user had it is merged, with nothing to write', () => {
    const now = [
      p('b1', 'one'),
      p('b2', 'two new words here'),
      p('b3', 'three'),
    ];
    const blocks = describe3(now, now, false);
    expect(blocks.map(block => block.resolution)).toEqual(['merged']);
    expect(blocks[0].merged).toBe(blocks[0].now);
  });

  test('a block one side deleted and the other changed is a conflict', () => {
    const blocks = describe3(
      [p('b1', 'one'), p('b3', 'three')],
      [p('b1', 'one'), p('b2', 'two words, changed'), p('b3', 'three')],
    );
    expect(
      blocks.map(block => [block.change, block.resolution, block.conflict]),
    ).toEqual([['deleted', 'conflict', 'added-or-deleted']]);
  });

  test('without a base, and without block ids', () => {
    const yours = [
      p('b1', 'one'),
      p('b2', 'two more words here'),
      p('b3', 'three'),
    ];
    expect(
      describeBlocks({
        base: null,
        blockMerge: true,
        kinds: KINDS,
        now: base,
        yours,
      }).map(block => block.conflict),
    ).toEqual(['no-base']);
    const bare = (blocks: Json[]) =>
      blocks.map(block => {
        const {$: _state, ...rest} = block as unknown as Record<
          string,
          unknown
        >;
        return rest as unknown as Json;
      });
    expect(
      describeBlocks({
        base: bare(base),
        blockMerge: true,
        kinds: KINDS,
        now: bare(base),
        yours: bare(yours),
      }).map(block => [block.id, block.conflict]),
    ).toEqual([['#1', 'no-block-ids']]);
  });
});
