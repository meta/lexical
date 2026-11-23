/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {Strong} from 'mdast';

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $create,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  configExtension,
  DecoratorNode,
  defineExtension,
  IS_BOLD,
  IS_ITALIC,
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
} from '../../index';

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
