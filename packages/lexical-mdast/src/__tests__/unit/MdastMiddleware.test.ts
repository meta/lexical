/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {Emphasis, PhrasingContent, Strong, Text} from 'mdast';

import {
  $createHorizontalRuleNode,
  buildEditorFromExtensions,
} from '@lexical/extension';
import {$createLinkNode} from '@lexical/link';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createHeadingNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  TableCellHeaderStates,
} from '@lexical/table';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setState,
  configExtension,
  DecoratorNode,
  defineExtension,
  type ElementNode,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  type LexicalNode,
  ParagraphNode,
  TextNode,
} from 'lexical';
import {defaultHandlers} from 'mdast-util-to-markdown';
import {assert, describe, expect, it} from 'vitest';

import {
  $convertFromMarkdownString,
  $convertSelectionToMarkdownString,
  $convertToMarkdownString,
  $convertToMdast,
  type MdastConfig,
  type MdastExportHandler,
  MdastExtension,
  MdastGfmExtension,
  MdastHeadingExtension,
  MdastHorizontalRuleExtension,
  MdastLinkExtension,
  MdastListExtension,
  MdastTableExtension,
} from '../../index';
import {paragraphBreakState} from '../../state';

class CustomTextNode extends TextNode {
  $config() {
    return this.config('middleware-text', {extends: TextNode});
  }
}

class DerivedTextNode extends CustomTextNode {
  $config() {
    return this.config('middleware-derived-text', {extends: CustomTextNode});
  }
}

class LiteralNode extends DecoratorNode<null> {
  $config() {
    return this.config('middleware-literal', {extends: DecoratorNode});
  }
  getTextContent() {
    return 'literal';
  }
  decorate() {
    return null;
  }
}

function createEditor(config: Partial<MdastConfig>) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [configExtension(MdastExtension, config)],
      name: '[middleware]',
      nodes: [DerivedTextNode, LiteralNode],
    }),
  );
}

// Writes a paragraph as a quote, so that its text goes through the block walk.
const $exportAsQuote: MdastExportHandler<ParagraphNode> = (node, context) => ({
  children: context.exportBlocks(node),
  type: 'blockquote',
});

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Run = [text: string, format: number];

const FORMAT_OF = {
  delete: IS_STRIKETHROUGH,
  emphasis: IS_ITALIC,
  strong: IS_BOLD,
};
const CONTAINERS = ['strong', 'emphasis', 'delete'] as const;

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)];
}

function randomWord(rand: () => number, chars: readonly string[]): string {
  let word = '';
  for (let n = 1 + Math.floor(rand() * 3); n > 0; n--) {
    word += pick(rand, chars);
  }
  return word;
}

/**
 * Formatted text and code without `data`, which the export takes apart into
 * runs and groups again. No text, code or container is empty:
 * mdast-util-to-markdown writes empty inline code as two backticks, and before
 * 2.2.3 an empty strong, emphasis or delete as its markers, which read back as
 * text even when nothing groups them.
 */
function randomPhrasing(rand: () => number, depth: number): PhrasingContent {
  const r = rand();
  if (depth >= 3 || r < 0.4) {
    return {type: 'text', value: randomWord(rand, ['a', 'b', ' ', '\\'])};
  }
  if (r < 0.5) {
    return {type: 'inlineCode', value: randomWord(rand, ['a', 'b', ' '])};
  }
  const children: PhrasingContent[] = [];
  for (let n = 1 + Math.floor(rand() * 3); n > 0; n--) {
    children.push(randomPhrasing(rand, depth + 1));
  }
  return {children, type: pick(rand, CONTAINERS)};
}

/**
 * A container with `data`, which the export keeps and only joins the texts in.
 * Kept as it is, it is written as it is, so it holds what Markdown can read
 * back: only texts and code, never code next to code. The test returns it as
 * the whole output.
 */
function randomKeptContainer(rand: () => number): PhrasingContent {
  const children: PhrasingContent[] = [];
  for (let n = 2 + Math.floor(rand() * 3); n > 0; n--) {
    const last = children[children.length - 1];
    children.push(
      last?.type !== 'inlineCode' && rand() < 0.3
        ? {type: 'inlineCode', value: randomWord(rand, ['a', 'b', ' '])}
        : {type: 'text', value: randomWord(rand, ['a', 'b', ' ', '\\'])},
    );
  }
  return {children, data: {}, type: pick(rand, CONTAINERS)};
}

/** The text runs of `node`, with the formats of the containers around them. */
function runsOf(node: PhrasingContent, format: number, runs: Run[]): void {
  if (node.type === 'text') {
    runs.push([node.value, format]);
  } else if (node.type === 'inlineCode') {
    runs.push([node.value, format | IS_CODE]);
  } else if (
    node.type === 'strong' ||
    node.type === 'emphasis' ||
    node.type === 'delete'
  ) {
    for (const child of node.children) {
      runsOf(child, format | FORMAT_OF[node.type], runs);
    }
  }
}

/** Joins neighbouring runs of one format, as the editor does with texts. */
function joinRuns(runs: readonly Run[]): Run[] {
  const joined: Run[] = [];
  for (const [text, format] of runs) {
    const last = joined[joined.length - 1];
    if (last !== undefined && last[1] === format) {
      last[0] += text;
    } else {
      joined.push([text, format]);
    }
  }
  return joined;
}

describe('mdast middleware', () => {
  it.each([false, true])(
    'orders export rules by specificity then contribution priority (strings: %s)',
    strings => {
      const calls: string[] = [];
      const wrap =
        (label: string): MdastExportHandler =>
        (_node, context) => {
          calls.push(`${label}:before`);
          const result = context.next();
          calls.push(`${label}:after`);
          return result.map(node =>
            node.type === 'text' ? {...node, value: label + node.value} : node,
          );
        };
      using editor = createEditor({
        exportRules: [
          {$export: wrap('T'), type: strings ? 'text' : TextNode},
          {$export: wrap('D1'), type: DerivedTextNode},
          {
            $export: wrap('P'),
            type: strings ? 'middleware-text' : CustomTextNode,
          },
          {$export: wrap('D2'), type: 'middleware-derived-text'},
        ],
      });
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $create(DerivedTextNode).setTextContent('b'),
              ),
            ),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString())).toBe('D1D2PTb');
      expect(calls).toEqual([
        'D1:before',
        'D2:before',
        'P:before',
        'T:before',
        'T:after',
        'P:after',
        'D2:after',
        'D1:after',
      ]);
    },
  );

  it('keeps the export continuation bound to its node during nested dispatch', () => {
    using editor = createEditor({
      exportRules: [
        {
          $export: (node: ParagraphNode, context) => {
            expect(context.exportInline(node)).toEqual([
              {type: 'text', value: 'B'},
            ]);
            return context.next();
          },
          type: ParagraphNode,
        },
        {
          $export: (_node, context) =>
            context
              .next()
              .map(node =>
                node.type === 'text'
                  ? {...node, value: node.value.toUpperCase()}
                  : node,
              ),
          type: TextNode,
        },
      ],
    });
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('b'))),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe('B');
  });

  it('reaches the generic export fallback after the last handler', () => {
    using editor = createEditor({
      exportRules: [
        {$export: (_node, context) => context.next(), type: LiteralNode},
      ],
    });
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append($createParagraphNode().append($create(LiteralNode))),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe('literal');
  });

  it('passes the sliced node through middleware during selection export', () => {
    using editor = createEditor({
      exportRules: [
        {$export: (_node, context) => context.next(), type: DerivedTextNode},
        {
          $export: (_node, context) =>
            context
              .next()
              .map(node =>
                node.type === 'text'
                  ? {...node, value: node.value.toUpperCase()}
                  : node,
              ),
          type: TextNode,
        },
      ],
    });
    editor.update(
      () => {
        const node = $create(DerivedTextNode).setTextContent('abcde');
        $getRoot().clear().append($createParagraphNode().append(node));
        node.select(1, 4);
      },
      {discrete: true},
    );
    expect(editor.read(() => $convertSelectionToMarkdownString())).toBe('BCD');
  });

  it('resolves middleware against registered replacement classes', () => {
    const calls: string[] = [];
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          configExtension(MdastExtension, {
            exportRules: [
              {
                $export: (_node, context) => {
                  calls.push('derived');
                  return context.next();
                },
                type: DerivedTextNode,
              },
              {
                $export: (_node, context) => {
                  calls.push('text');
                  return context.next();
                },
                type: TextNode,
              },
            ],
          }),
        ],
        name: '[replacement-middleware]',
        nodes: [
          DerivedTextNode,
          {
            replace: TextNode,
            with: node => new DerivedTextNode(node.getTextContent()),
            withKlass: DerivedTextNode,
          },
        ],
      }),
    );
    editor.update(
      () => {
        const node = $createTextNode('b');
        expect(node).toBeInstanceOf(DerivedTextNode);
        $getRoot().clear().append($createParagraphNode().append(node));
      },
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe('b');
    expect(calls).toEqual(['derived', 'text']);
  });

  it.each(['inline', 'blocks'])(
    'keeps custom middleware active for formatted text and tabs in %s',
    mode => {
      const calls: string[] = [];
      using editor = createEditor({
        exportRules: [
          {
            $export: (node: ParagraphNode, context) =>
              mode === 'blocks'
                ? {children: context.exportBlocks(node), type: 'blockquote'}
                : context.next(),
            type: ParagraphNode,
          },
          {
            $export: (node, context) => {
              calls.push(node.getTextContent());
              return context.next();
            },
            type: TextNode,
          },
        ],
      });
      editor.update(
        () => {
          const nodes = [
            $createTextNode('a'),
            $createTabNode(),
            $createTextNode('b'),
          ];
          nodes.forEach(node => node.toggleFormat('bold'));
          $getRoot()
            .clear()
            .append($createParagraphNode().append(...nodes));
        },
        {discrete: true},
      );
      const markdown = editor.read(() => $convertToMarkdownString());
      expect(calls).toEqual(['a', '\t', 'b']);
      editor.update(() => $convertFromMarkdownString(markdown), {
        discrete: true,
      });
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('a\tb');
        expect(
          $getRoot()
            .getAllTextNodes()
            .every(node => node.hasFormat('bold')),
        ).toBe(true);
      });
    },
  );

  it('groups overlapping formats after text middleware delegates', () => {
    const expected: [string, number][] = [
      ['he', 0],
      ['llo', IS_BOLD],
      ['wor', IS_BOLD | IS_ITALIC],
      ['ld', IS_ITALIC],
    ];
    using editor = createEditor({
      exportRules: [
        {$export: (_node, context) => context.next(), type: TextNode},
      ],
    });
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              ...expected.map(([value, format]) =>
                $createTextNode(value).setFormat(format),
              ),
            ),
          ),
      {discrete: true},
    );
    const markdown = editor.read(() => $convertToMarkdownString());
    editor.update(() => $convertFromMarkdownString(markdown), {discrete: true});
    expect(
      editor.read(() =>
        $getRoot()
          .getAllTextNodes()
          .map(node => [node.getTextContent(), node.getFormat()]),
      ),
    ).toEqual(expected);
  });

  it.each<
    [
      string,
      boolean,
      MdastExportHandler,
      () => LexicalNode[],
      string,
      [string, number][],
    ]
  >([
    [
      'bold text around a strong with italic text between two texts in it',
      false,
      (node, context) =>
        node.getTextContent() !== 'abc'
          ? context.next()
          : [
              {
                children: [
                  {type: 'text', value: 'a'},
                  {
                    children: [{type: 'text', value: 'c'}],
                    type: 'emphasis',
                  },
                  {type: 'text', value: 'b'},
                ],
                type: 'strong',
              },
            ],
      () => [
        $createTextNode('z').toggleFormat('bold'),
        $createTextNode('abc'),
        $createTextNode('y').toggleFormat('bold'),
      ],
      '**za*c*by**',
      [
        ['za', IS_BOLD],
        ['c', IS_BOLD | IS_ITALIC],
        ['by', IS_BOLD],
      ],
    ],
    [
      'a strong around bold text',
      false,
      (_node, context) =>
        context.next().map((node): Strong => {
          assert(node.type === 'strong');
          return {children: [node], type: 'strong'};
        }),
      () => [$createTextNode('b').toggleFormat('bold')],
      '**b**',
      [['b', IS_BOLD]],
    ],
    [
      'a text before the output',
      false,
      (_node, context) => [{type: 'text', value: 'x'}, ...context.next()],
      () => [$createTextNode('b')],
      'xb',
      [['xb', 0]],
    ],
    [
      'inline code in two pieces',
      false,
      () => [
        {type: 'inlineCode', value: 'a'},
        {type: 'inlineCode', value: 'b'},
      ],
      () => [$createTextNode('ab')],
      '`ab`',
      [['ab', IS_CODE]],
    ],
    [
      'inline code in two pieces inside a strong',
      false,
      () => [
        {
          children: [
            {type: 'inlineCode', value: 'a'},
            {type: 'inlineCode', value: 'b'},
          ],
          type: 'strong',
        },
      ],
      () => [$createTextNode('ab')],
      '**`ab`**',
      [['ab', IS_BOLD | IS_CODE]],
    ],
    [
      'an empty strong between texts',
      false,
      (node, context) =>
        node.getTextContent() === 'x'
          ? [{children: [], type: 'strong'}]
          : context.next(),
      () => [
        $createTextNode('a'),
        $createTextNode('x').toggleFormat('italic'),
        $createTextNode('b'),
      ],
      'ab',
      [['ab', 0]],
    ],
    [
      'nothing between bold texts',
      false,
      (node, context) => (node.getTextContent() === 'x' ? [] : context.next()),
      () => [
        $createTextNode('a').toggleFormat('bold'),
        $createTextNode('x'),
        $createTextNode('b').toggleFormat('bold'),
      ],
      '**ab**',
      [['ab', IS_BOLD]],
    ],
    // Written apart, the two texts read back the same, so only the Markdown
    // tells whether the quote grouped them.
    [
      'bold then bold italic text in a quote',
      true,
      (_node, context) => context.next(),
      () => [
        $createTextNode('ab').toggleFormat('bold'),
        $createTextNode('cd').toggleFormat('bold').toggleFormat('italic'),
      ],
      '> **ab*cd***',
      [
        ['ab', IS_BOLD],
        ['cd', IS_BOLD | IS_ITALIC],
      ],
    ],
  ])(
    'writes the text an export rule returns: %s',
    (_name, inQuote, $export, $build, expectedMarkdown, expectedRuns) => {
      using editor = createEditor({
        exportRules: [
          ...(inQuote ? [{$export: $exportAsQuote, type: ParagraphNode}] : []),
          {$export, type: TextNode},
        ],
      });
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append($createParagraphNode().append(...$build())),
        {discrete: true},
      );
      const markdown = editor.read(() => $convertToMarkdownString());
      expect(markdown).toBe(expectedMarkdown);
      editor.update(() => $convertFromMarkdownString(markdown), {
        discrete: true,
      });
      expect(
        editor.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(node => [node.getTextContent(), node.getFormat()]),
        ),
      ).toEqual(expectedRuns);
    },
  );

  it('keeps text an export rule returns before a paragraph boundary in a quote', () => {
    using editor = createEditor({
      exportRules: [
        {$export: $exportAsQuote, type: ParagraphNode},
        {
          $export: (_node, context) =>
            context.next().map(node => ({...node, data: {}})),
          type: TextNode,
        },
      ],
    });
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('a').toggleFormat('bold'),
              $setState($createLineBreakNode(), paragraphBreakState, true),
              $createTextNode('b'),
            ),
          ),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      '> **a**\n>\n> b',
    );
  });

  it('writes an empty quote as >', () => {
    using editor = createEditor({
      exportRules: [{$export: $exportAsQuote, type: ParagraphNode}],
    });
    editor.update(() => $getRoot().clear().append($createParagraphNode()), {
      discrete: true,
    });
    expect(editor.read(() => $convertToMarkdownString())).toBe('>');
  });

  it('joins the texts an export rule returns in one format into one text', () => {
    using editor = createEditor({
      exportRules: [
        {
          $export: () => [
            {
              children: [
                {type: 'text', value: 'a'},
                {type: 'text', value: 'b'},
              ],
              type: 'strong',
            },
          ],
          type: TextNode,
        },
      ],
    });
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('ab'))),
      {discrete: true},
    );
    const [paragraph] = editor.read(() => $convertToMdast()).children;
    assert(paragraph.type === 'paragraph');
    expect(paragraph.children).toEqual([
      {children: [{type: 'text', value: 'ab'}], type: 'strong'},
    ]);
  });

  it('writes strikethrough text an export rule returns', () => {
    const expected: [string, number][] = [
      ['a', IS_STRIKETHROUGH],
      ['b', IS_STRIKETHROUGH | IS_BOLD],
    ];
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastGfmExtension,
          configExtension(MdastExtension, {
            exportRules: [
              {$export: (_node, context) => context.next(), type: TextNode},
            ],
          }),
        ],
        name: '[middleware-strikethrough]',
      }),
    );
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              ...expected.map(([value, format]) =>
                $createTextNode(value).setFormat(format),
              ),
            ),
          ),
      {discrete: true},
    );
    const markdown = editor.read(() => $convertToMarkdownString());
    expect(markdown).toBe('~~a**b**~~');
    editor.update(() => $convertFromMarkdownString(markdown), {discrete: true});
    expect(
      editor.read(() =>
        $getRoot()
          .getAllTextNodes()
          .map(node => [node.getTextContent(), node.getFormat()]),
      ),
    ).toEqual(expected);
  });

  it.each<[string, () => LexicalNode, string]>([
    [
      'bold text with data',
      () => $createTextNode('ab').toggleFormat('bold'),
      '> x**ab**y',
    ],
    [
      'a link',
      () =>
        $createLinkNode('https://example.com').append($createTextNode('ab')),
      '> x[ab](https://example.com)y',
    ],
    ['an inline decorator', () => $create(LiteralNode), '> xliteraly'],
    [
      'a horizontal rule',
      () => $createHorizontalRuleNode(),
      '> x\n>\n> ***\n>\n> y',
    ],
    [
      'a heading',
      () => $createHeadingNode('h2').append($createTextNode('ab')),
      '> x\n>\n> ## ab\n>\n> y',
    ],
  ])(
    'keeps the texts around %s in place in a quote',
    (_name, $after, expected) => {
      using editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            MdastHeadingExtension,
            MdastHorizontalRuleExtension,
            MdastLinkExtension,
            configExtension(MdastExtension, {
              exportRules: [
                {$export: $exportAsQuote, type: ParagraphNode},
                {
                  $export: (_node, context) =>
                    context
                      .next()
                      .map(node =>
                        node.type === 'strong' ? {...node, data: {}} : node,
                      ),
                  type: TextNode,
                },
              ],
            }),
          ],
          name: '[middleware-quote-order]',
          nodes: [LiteralNode],
        }),
      );
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode('x'),
                $after(),
                $createTextNode('y'),
              ),
            ),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString())).toBe(expected);
    },
  );

  it.each<[string, () => PhrasingContent]>([
    [
      'data on the text inside bold italic text',
      () => ({
        children: [
          {
            children: [{data: {marker: true}, type: 'text', value: 'b'}],
            type: 'strong',
          },
        ],
        type: 'emphasis',
      }),
    ],
    [
      'data on italic text',
      () => ({
        children: [{type: 'text', value: 'b'}],
        data: {marker: true},
        type: 'emphasis',
      }),
    ],
    [
      'data on strikethrough text',
      () => ({
        children: [{type: 'text', value: 'b'}],
        data: {marker: true},
        type: 'delete',
      }),
    ],
    [
      'data on inline code',
      () => ({data: {marker: true}, type: 'inlineCode', value: 'b'}),
    ],
    [
      'a node of a type it does not group',
      () => ({
        children: [{type: 'text', value: 'b'}],
        type: 'htmlInline',
        value: '<u><span data-mdast-child="0"></span></u>',
      }),
    ],
  ])('keeps what an export rule returns: %s', (_name, output) => {
    using editor = createEditor({
      exportRules: [{$export: () => [output()], type: TextNode}],
    });
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('b'))),
      {discrete: true},
    );
    const [paragraph] = editor.read(() => $convertToMdast()).children;
    assert(paragraph.type === 'paragraph');
    expect(paragraph.children).toEqual([output()]);
  });

  it('leaves the node an export rule returns unchanged', () => {
    // With `data` the node is not taken apart into text, so the Markdown
    // writer reaches it and joins the two texts in the strong inside it.
    const emphasis = (): PhrasingContent => ({
      children: [
        {
          children: [
            {type: 'text', value: 'a'},
            {type: 'text', value: 'b'},
          ],
          type: 'strong',
        },
      ],
      data: {},
      type: 'emphasis',
    });
    const cached = emphasis();
    using editor = createEditor({
      exportRules: [{$export: () => [cached], type: TextNode}],
    });
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('ab'))),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe('***ab***');
    expect(cached).toEqual(emphasis());
  });

  it.each([
    ['a paragraph', false, '**a**__x__**b**'],
    ['a quote', true, '> **a**__x__**b**'],
  ])(
    'keeps what an export rule returns for an inline decorator apart from the bold text around it in %s',
    (_name, inQuote, expected) => {
      using editor = createEditor({
        exportRules: [
          ...(inQuote ? [{$export: $exportAsQuote, type: ParagraphNode}] : []),
          {
            $export: () => [
              {children: [{type: 'text', value: 'x'}], type: 'strong'},
            ],
            type: LiteralNode,
          },
        ],
      });
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode('a').toggleFormat('bold'),
                $create(LiteralNode),
                $createTextNode('b').toggleFormat('bold'),
              ),
            ),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString())).toBe(expected);
    },
  );

  it('joins the texts in a link that an export rule returns', () => {
    using editor = createEditor({
      exportRules: [
        {
          $export: () => [
            {
              children: [
                {type: 'text', value: 'rain'},
                {type: 'text', value: 'bow'},
              ],
              type: 'link',
              url: 'https://example.com',
            },
          ],
          type: TextNode,
        },
      ],
      toMarkdownExtensions: [
        {
          handlers: {
            text: (node: Text) => node.value.replace('rainbow', 'arc'),
          },
        },
      ],
    });
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('ab'))),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      '[arc](https://example.com)',
    );
  });

  it.each([false, 0, '', null])(
    'keeps texts apart when a key in them is %j',
    marker => {
      using editor = createEditor({
        exportRules: [
          {
            $export: () => [
              Object.assign({type: 'text' as const, value: 'a'}, {marker}),
              Object.assign({type: 'text' as const, value: 'b'}, {marker}),
            ],
            type: TextNode,
          },
        ],
        toMarkdownExtensions: [
          {
            handlers: {
              text: (node: Text) =>
                Reflect.has(node, 'marker')
                  ? `[${node.value}]`
                  : `<${node.value}>`,
            },
          },
        ],
      });
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('ab'))),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString())).toBe('[a][b]');
    },
  );

  it('keeps output with data as it is, next to output it groups', () => {
    using editor = createEditor({
      exportRules: [
        {
          $export: (node, context) =>
            node.hasFormat('highlight')
              ? [
                  {children: [{type: 'text', value: 'a'}], type: 'strong'},
                  {
                    children: [{type: 'text', value: 'b'}],
                    data: {},
                    type: 'emphasis',
                  },
                  {children: [{type: 'text', value: 'c'}], type: 'strong'},
                ]
              : context.next(),
          type: TextNode,
        },
      ],
    });
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('xy').toggleFormat('bold'),
              $createTextNode('rule').toggleFormat('highlight'),
              $createTextNode('yz').toggleFormat('bold'),
            ),
          ),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      '**xy**__a__*b***c**__yz__',
    );
  });

  it('passes data on a node an export rule returns to a toMarkdownExtensions handler after joining its texts', () => {
    using editor = createEditor({
      exportRules: [
        {
          $export: () => [
            {
              children: [
                {type: 'text', value: 'a'},
                {type: 'text', value: 'b'},
              ],
              data: {marker: true},
              type: 'emphasis',
            },
          ],
          type: TextNode,
        },
      ],
      toMarkdownExtensions: [
        {
          handlers: {
            emphasis: (node: Emphasis, parent, state, info) =>
              (node.data && 'marker' in node.data && node.data.marker === true
                ? 'marked: '
                : '') + defaultHandlers.emphasis(node, parent, state, info),
          },
        },
      ],
    });
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('ab'))),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe('marked: *ab*');
  });

  it.each<[string, boolean, (text: TextNode) => ElementNode, string, string]>([
    ['a quote', true, text => $createParagraphNode().append(text), '> ', ''],
    [
      'a heading',
      false,
      text => $createHeadingNode('h1').append(text),
      '# ',
      '',
    ],
    [
      'a list item',
      false,
      text =>
        $createListNode('bullet').append($createListItemNode().append(text)),
      '- ',
      '',
    ],
    [
      'a table cell',
      false,
      text =>
        $createTableNode().append(
          $createTableRowNode().append(
            $createTableCellNode(TableCellHeaderStates.ROW).append(
              $createParagraphNode().append(text),
            ),
          ),
        ),
      '| ',
      ' |',
    ],
  ])(
    'joins the texts before a node whose own texts it joins in %s',
    (_name, inQuote, $block, prefix, suffix) => {
      using editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            MdastGfmExtension,
            MdastHeadingExtension,
            MdastListExtension,
            MdastTableExtension,
            configExtension(MdastExtension, {
              exportRules: [
                ...(inQuote
                  ? [{$export: $exportAsQuote, type: ParagraphNode}]
                  : []),
                {
                  $export: () => [
                    {type: 'text', value: 'see ww'},
                    {type: 'text', value: 'w.世'},
                    {
                      children: [
                        {type: 'text', value: 'ww'},
                        {type: 'text', value: 'w.世'},
                        {
                          children: [
                            {type: 'text', value: 'ww'},
                            {type: 'text', value: 'w.世'},
                          ],
                          type: 'strong',
                        },
                      ],
                      data: {},
                      type: 'emphasis',
                    },
                  ],
                  type: TextNode,
                },
              ],
            }),
          ],
          name: '[middleware-join]',
        }),
      );
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append($block($createTextNode('q'))),
        {discrete: true},
      );
      // Written apart, `w.世` does not see the `ww` before it, so `www.` goes
      // out unescaped and the link it reads back as takes in the `*`. In the
      // strong, the `*` after it ends the link anyway, so only the escape shows
      // that the join reaches it.
      // The first line: a table writes its delimiter row after it.
      expect(editor.read(() => $convertToMarkdownString()).split('\n')[0]).toBe(
        prefix + 'see www\\.世*www\\.世**www\\.世***' + suffix,
      );
    },
  );

  it.each([
    ['a paragraph', false, 'a'],
    ['a quote', true, '> a'],
  ])(
    'leaves what is outside the selection out of %s',
    (_name, inQuote, expected) => {
      using editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            MdastLinkExtension,
            configExtension(MdastExtension, {
              exportRules: inQuote
                ? [{$export: $exportAsQuote, type: ParagraphNode}]
                : [],
            }),
          ],
          name: '[middleware-selection]',
        }),
      );
      editor.update(
        () => {
          const text = $createTextNode('ab');
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                // Bold, so that the editor does not merge it into the selected
                // text.
                $createTextNode('x').toggleFormat('bold'),
                text,
                $createLinkNode('https://example.com').append(
                  $createTextNode('cd'),
                ),
              ),
            );
          text.select(0, 1);
        },
        {discrete: true},
      );
      expect(editor.read(() => $convertSelectionToMarkdownString())).toBe(
        expected,
      );
    },
  );

  it('passes the sliced node through middleware during selection export in a quote', () => {
    using editor = createEditor({
      exportRules: [
        {$export: $exportAsQuote, type: ParagraphNode},
        {
          $export: (_node, context) =>
            context
              .next()
              .map(node =>
                node.type === 'text'
                  ? {...node, value: node.value.toUpperCase()}
                  : node,
              ),
          type: TextNode,
        },
      ],
    });
    editor.update(
      () => {
        const node = $createTextNode('abcde');
        $getRoot().clear().append($createParagraphNode().append(node));
        node.select(1, 4);
      },
      {discrete: true},
    );
    expect(editor.read(() => $convertSelectionToMarkdownString())).toBe(
      '> BCD',
    );
  });

  // 1,000 random outputs: about a second alone, more when the whole suite runs.
  it(
    'reads back the texts and formats an export rule returns',
    {timeout: 30_000},
    () => {
      const rand = mulberry32(1);
      for (let trial = 0; trial < 1000; trial++) {
        const output: PhrasingContent[] = [];
        if (rand() < 0.5) {
          output.push(randomKeptContainer(rand));
        } else {
          for (let n = 1 + Math.floor(rand() * 3); n > 0; n--) {
            output.push(randomPhrasing(rand, 0));
          }
        }
        const before: Run | null =
          rand() < 0.5 ? ['xy', pick(rand, [0, IS_BOLD, IS_ITALIC])] : null;
        const after: Run | null =
          rand() < 0.5 ? ['yz', pick(rand, [0, IS_BOLD, IS_ITALIC])] : null;
        const inQuote = rand() < 0.3;
        const runs: Run[] = before ? [before] : [];
        for (const node of output) {
          runsOf(node, 0, runs);
        }
        if (after) {
          runs.push(after);
        }
        using editor = buildEditorFromExtensions(
          defineExtension({
            dependencies: [
              MdastGfmExtension,
              configExtension(MdastExtension, {
                exportRules: [
                  ...(inQuote
                    ? [{$export: $exportAsQuote, type: ParagraphNode}]
                    : []),
                  {
                    $export: (node, context) =>
                      node.hasFormat('highlight') ? output : context.next(),
                    type: TextNode,
                  },
                ],
              }),
            ],
            name: '[middleware-round-trip]',
          }),
        );
        editor.update(
          () => {
            const paragraph = $createParagraphNode();
            if (before) {
              paragraph.append($createTextNode(before[0]).setFormat(before[1]));
            }
            paragraph.append($createTextNode('rule').toggleFormat('highlight'));
            if (after) {
              paragraph.append($createTextNode(after[0]).setFormat(after[1]));
            }
            $getRoot().clear().append(paragraph);
          },
          {discrete: true},
        );
        const markdown = editor.read(() => $convertToMarkdownString());
        editor.update(() => $convertFromMarkdownString(markdown), {
          discrete: true,
        });
        expect(
          joinRuns(
            editor.read(() =>
              $getRoot()
                .getAllTextNodes()
                .map((node): Run => [node.getTextContent(), node.getFormat()]),
            ),
          ),
          `trial ${trial}: ${JSON.stringify(output)} -> ${JSON.stringify(markdown)}`,
        ).toEqual(joinRuns(runs));
      }
    },
  );

  it.each([false, true])(
    'preserves custom output when grouping text (metadata: %s)',
    metadata => {
      using editor = createEditor({
        exportRules: [
          {
            $export: (_node, context) => {
              const nodes = context.next();
              if (metadata) {
                return nodes.map(node =>
                  node.type === 'strong'
                    ? {...node, data: {...node.data, marker: true}}
                    : node,
                );
              }
              return [...nodes, {type: 'html', value: '<!--marker-->'}];
            },
            type: TextNode,
          },
        ],
      });
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode('b').toggleFormat('bold'),
              ),
            ),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMdast())).toEqual({
        children: [
          {
            children: metadata
              ? [
                  {
                    children: [{type: 'text', value: 'b'}],
                    data: {marker: true},
                    type: 'strong',
                  },
                ]
              : [
                  {children: [{type: 'text', value: 'b'}], type: 'strong'},
                  {type: 'html', value: '<!--marker-->'},
                ],
            type: 'paragraph',
          },
        ],
        type: 'root',
      });
    },
  );

  it.each([
    ['a symbol key', Symbol('marker'), {enumerable: true, value: true}],
    ['a key set to undefined', 'data', {enumerable: true, value: undefined}],
    [
      'a symbol key set to undefined',
      Symbol('marker'),
      {enumerable: true, value: undefined},
    ],
  ])(
    'keeps custom output with %s when grouping text',
    (_name, key, descriptor) => {
      using editor = createEditor({
        exportRules: [
          {
            $export: (_node, context) =>
              context
                .next()
                .map(node =>
                  node.type === 'strong'
                    ? Object.defineProperty({...node}, key, descriptor)
                    : node,
                ),
            type: TextNode,
          },
        ],
      });
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode('b').toggleFormat('bold'),
              ),
            ),
        {discrete: true},
      );
      const [paragraph] = editor.read(() => $convertToMdast()).children;
      assert(paragraph.type === 'paragraph');
      expect(
        Reflect.getOwnPropertyDescriptor(paragraph.children[0], key),
      ).toBeDefined();
    },
  );

  it.each(['strong', 'text'])(
    'writes formatted text with a symbol key on its %s node on its own',
    keyedType => {
      const expected: [string, number][] = [
        ['ab', IS_BOLD],
        ['cd', IS_BOLD | IS_ITALIC],
      ];
      using editor = createEditor({
        exportRules: [
          {
            $export: (node, context) =>
              context.next().map(mdastNode => {
                if (
                  mdastNode.type !== 'strong' ||
                  node.getTextContent() !== 'ab'
                ) {
                  return mdastNode;
                }
                const marker = Symbol('marker');
                return keyedType === 'strong'
                  ? {...mdastNode, [marker]: true}
                  : {
                      ...mdastNode,
                      children: mdastNode.children.map(child => ({
                        ...child,
                        [marker]: true,
                      })),
                    };
              }),
            type: TextNode,
          },
        ],
      });
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                ...expected.map(([value, format]) =>
                  $createTextNode(value).setFormat(format),
                ),
              ),
            ),
        {discrete: true},
      );
      const markdown = editor.read(() => $convertToMarkdownString());
      expect(markdown).toBe('**ab*****cd***');
      editor.update(() => $convertFromMarkdownString(markdown), {
        discrete: true,
      });
      expect(
        editor.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(node => [node.getTextContent(), node.getFormat()]),
        ),
      ).toEqual(expected);
    },
  );

  it.each([
    ['data', 'data'],
    ['a symbol key', Symbol('marker')],
  ])('writes the text before custom output with %s first', (_name, key) => {
    using editor = createEditor({
      exportRules: [
        {
          $export: (_node, context) =>
            context
              .next()
              .map(node =>
                node.type === 'strong' ? {...node, [key]: {}} : node,
              ),
          type: TextNode,
        },
      ],
    });
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('x'),
              $createTextNode('ab').toggleFormat('bold'),
            ),
          ),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe('x**ab**');
  });

  it.each([
    ['one text child', '', 'marked: **b**'],
    ['two text children, which are joined', 'c', 'marked: **bc**'],
  ])(
    'passes a symbol key from export rule output to a toMarkdownExtensions handler (%s)',
    (_name, added, expected) => {
      const marker = Symbol('marker');
      using editor = createEditor({
        exportRules: [
          {
            $export: (_node, context) =>
              context.next().map(node =>
                node.type === 'strong'
                  ? {
                      ...node,
                      children:
                        added === ''
                          ? node.children
                          : [...node.children, {type: 'text', value: added}],
                      [marker]: true,
                    }
                  : node,
              ),
            type: TextNode,
          },
        ],
        toMarkdownExtensions: [
          {
            handlers: {
              strong: (node: Strong, parent, state, info) =>
                (marker in node ? 'marked: ' : '') +
                defaultHandlers.strong(node, parent, state, info),
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
                $createTextNode('b').toggleFormat('bold'),
              ),
            ),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString())).toBe(expected);
    },
  );

  it.each([
    ['string', 'marker'],
    ['symbol', Symbol('marker')],
  ])(
    'groups text whose only other key is a non-enumerable %s, as a copy drops it',
    (_name, key) => {
      using editor = createEditor({
        exportRules: [
          {
            $export: (_node, context) =>
              context
                .next()
                .map(node =>
                  Object.defineProperty({...node}, key, {value: true}),
                ),
            type: TextNode,
          },
        ],
      });
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode('ab').toggleFormat('bold'),
                $createTextNode('cd')
                  .toggleFormat('bold')
                  .toggleFormat('italic'),
              ),
            ),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString())).toBe('**ab*cd***');
    },
  );

  it('wraps lower-priority import handlers and preserves the format context', () => {
    const calls: string[] = [];
    using editor = createEditor({
      importRules: [
        {
          $import: (_node, context) => {
            calls.push('outer:before');
            const result = context.next();
            calls.push('outer:after');
            for (const node of result) {
              if ($isTextNode(node))
                node.setTextContent(node.getTextContent().toUpperCase());
            }
            return result;
          },
          type: 'text',
        },
        {
          $import: (_node, context) => {
            calls.push('inner');
            return context.next();
          },
          type: 'text',
        },
      ],
    });
    editor.update(() => $convertFromMarkdownString('**b**'), {discrete: true});
    expect(editor.read(() => $convertToMarkdownString())).toBe('**B**');
    expect(calls).toEqual(['outer:before', 'inner', 'outer:after']);
  });

  it('keeps the import continuation bound to its node during nested dispatch', () => {
    using editor = createEditor({
      importRules: [
        {
          $import: (_node, context) => {
            expect(
              context
                .importNode({type: 'text', value: 'nested'})[0]
                .getTextContent(),
            ).toBe('nested');
            return context.next();
          },
          type: 'strong',
        },
        {$import: (_node, context) => context.next(), type: 'text'},
      ],
    });
    editor.update(() => $convertFromMarkdownString('**b**'), {discrete: true});
    expect(editor.read(() => $convertToMarkdownString())).toBe('**b**');
  });

  it('reaches the generic import fallback after the last handler', () => {
    using editor = createEditor({
      importRules: [
        {$import: (_node, context) => context.next(), type: 'blockquote'},
        {$import: (_node, context) => context.next(), type: 'code'},
        {$import: (_node, context) => context.next(), type: 'thematicBreak'},
      ],
    });
    editor.update(
      () => $convertFromMarkdownString('> quoted\n\n```\nliteral\n```\n\n---'),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      'quoted\n\nliteral',
    );
  });

  it('can omit content with an empty array without calling the next handler', () => {
    using editor = createEditor({
      exportRules: [
        {$export: () => [], type: TextNode},
        {
          $export: () => {
            throw new Error('unreachable export');
          },
          type: TextNode,
        },
      ],
      importRules: [
        {$import: () => [], type: 'strong'},
        {
          $import: () => {
            throw new Error('unreachable import');
          },
          type: 'strong',
        },
      ],
    });
    editor.update(() => $convertFromMarkdownString('a **b** c'), {
      discrete: true,
    });
    expect(editor.read(() => $getRoot().getTextContent())).toBe('a  c');
    expect(editor.read(() => $convertToMarkdownString())).toBe('');
  });

  it('preserves null semantics when a delegated handler returns null', () => {
    using editor = createEditor({
      exportRules: [
        {$export: (_node, context) => context.next(), type: DerivedTextNode},
        {$export: () => null, type: DerivedTextNode},
        {
          $export: () => {
            throw new Error('unreachable ancestor');
          },
          type: TextNode,
        },
      ],
      importRules: [
        {$import: (_node, context) => context.next(), type: 'strong'},
        {$import: () => null, type: 'strong'},
        {
          $import: () => {
            throw new Error('unreachable import');
          },
          type: 'strong',
        },
      ],
    });
    editor.update(() => $convertFromMarkdownString('a **b** c'), {
      discrete: true,
    });
    expect(editor.read(() => $getRoot().getTextContent())).toBe('a  c');
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $create(DerivedTextNode).setTextContent('b'),
            ),
          ),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe('b');
  });
});
