/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {PhrasingContent, Root} from 'mdast';

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  TEXT_TYPE_TO_FORMAT,
} from 'lexical';
import {gfmStrikethroughToMarkdown} from 'mdast-util-gfm-strikethrough';
import {
  defaultHandlers,
  type Options,
  type State,
  toMarkdown,
} from 'mdast-util-to-markdown';
import {expect, it, onTestFinished, vi} from 'vitest';

import {containerPhrasing} from '../../containerPhrasing';
import {
  $convertToMarkdownString,
  MdastExtension,
  MdastGfmExtension,
} from '../../index';

// Counts the calls that pairing and encoding make, without recording them.
const calls = vi.hoisted(() => ({count: 0}));
vi.mock('micromark-util-classify-character', async importOriginal => {
  const original =
    await importOriginal<typeof import('micromark-util-classify-character')>();
  return {
    ...original,
    classifyCharacter: (code: number) => {
      calls.count++;
      return original.classifyCharacter(code);
    },
  };
});

// Phrasing serialized by `containerPhrasing` here, and by
// mdast-util-to-markdown's own in the reference.
const LINEAR: Options = {
  handlers: {
    root(node, parent, state, info) {
      state.containerPhrasing = function (this: State, phrasing, at) {
        return containerPhrasing(phrasing, this, at);
      };
      return defaultHandlers.root(node, parent, state, info);
    },
  },
};

// Pieces of text that read differently beside a marker.
const TEXTS = ['a', '.', ' ', '\\', '你', '&', 'b c', '!a', 'a!', '\n'];
// Fixed cases run every time. Random ones are too slow for every run: they
// run with the number of cases in this variable, as in
// `MDAST_CONTAINER_PHRASING_CASES=100000 pnpm run test-unit MdastContainerPhrasing`.
const CASES = Number(process.env.MDAST_CONTAINER_PHRASING_CASES) || 0;

// mulberry32: a seeded generator with 32-bit state.
function createRandom(seed: number): (n: number) => number {
  return n => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

function generate(
  random: (n: number) => number,
  depth: number,
): PhrasingContent[] {
  const children: PhrasingContent[] = [];
  for (let i = 1 + random(5); i > 0; i--) {
    const kind = depth > 2 ? 0 : random(6);
    if (kind < 2) {
      children.push({type: 'text', value: TEXTS[random(TEXTS.length)]});
    } else if (kind === 5) {
      children.push(
        random(2)
          ? {type: 'inlineCode', value: 'x'}
          : {type: 'html', value: '<div>'},
      );
    } else {
      children.push({
        children: generate(random, depth + 1),
        type: kind === 2 ? 'emphasis' : kind === 3 ? 'strong' : 'delete',
      });
    }
  }
  return children;
}

function paragraph(children: PhrasingContent[]): Root {
  return {children: [{children, type: 'paragraph'}], type: 'root'};
}

// Emphasis and strong touching in the shape that has a mistake every few
// runs, which mdast-util-to-markdown takes quadratic time to fix.
function touching(pairs: number): PhrasingContent[] {
  const children: PhrasingContent[] = [];
  for (let index = 0; index < pairs; index++) {
    const a = index % 2 ? '.' : 'a';
    const b = index % 2 ? 'a' : '.';
    children.push(
      {children: [{type: 'text', value: a}], type: 'strong'},
      {
        children: [
          {type: 'text', value: b},
          {children: [{type: 'text', value: a}], type: 'strong'},
        ],
        type: 'emphasis',
      },
    );
  }
  return children;
}

it('serializes phrasing as mdast-util-to-markdown does', () => {
  const random = createRandom(1);
  const trees = [
    paragraph(touching(12)),
    paragraph([
      {type: 'text', value: 'a\n'},
      {type: 'html', value: '<div>'},
      {children: [{type: 'text', value: 'b'}], type: 'emphasis'},
    ]),
    paragraph([
      {type: 'text', value: 'a\\'},
      {children: [{type: 'text', value: ' b'}], type: 'strong'},
      {type: 'text', value: 'c'},
    ]),
    ...Array.from({length: 200 + CASES}, () => paragraph(generate(random, 0))),
  ];
  const extensions = [gfmStrikethroughToMarkdown()];
  for (const tree of trees) {
    expect(toMarkdown(tree, {extensions: [...extensions, LINEAR]})).toBe(
      toMarkdown(tree, {extensions}),
    );
  }
});

it('exports many touching runs of formatting in linear time', () => {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [MdastGfmExtension, MdastExtension],
      name: '[root]',
    }),
  );
  onTestFinished(() => editor.dispose());
  const {bold, italic} = TEXT_TYPE_TO_FORMAT;
  // The calls that pairing and encoding make for some number of runs.
  const count = (runs: number): number => {
    editor.update(
      () => {
        const block = $createParagraphNode();
        for (let index = 0; index < runs; index++) {
          const text = index % 2 ? 'a' : '.';
          const format = [bold, italic, bold | italic][index % 3];
          block.append($createTextNode(text).setFormat(format));
        }
        $getRoot().clear().append(block);
      },
      {discrete: true},
    );
    calls.count = 0;
    editor.read('latest', () => $convertToMarkdownString());
    return calls.count;
  };
  const once = count(600);
  expect(once).toBeGreaterThan(0);
  // Twice the runs take about twice the calls, where they took four times
  // as many in mdast-util-to-markdown.
  expect(count(1200)).toBeLessThan(once * 2.5);
});
