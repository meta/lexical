/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  buildEditorFromExtensions,
  configExtension,
  type LexicalEditorWithDispose,
  NodeStructureExtension,
} from '@lexical/extension';
import {
  $getImportContextValue,
  $getRenderContextValue,
  $withImportContext,
  contextValue,
  createImportState,
} from '@lexical/html';
import {$createLinkNode, $isLinkNode} from '@lexical/link';
import {$createListItemNode, $createListNode, $isListNode} from '@lexical/list';
import {
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getCaretRange,
  $getRoot,
  $getSelection,
  $getTextPointCaret,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelectionFromCaretRange,
  defineExtension,
  type LexicalNode,
  TEXT_TYPE_TO_FORMAT,
  type TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {defaultHandlers} from 'mdast-util-to-markdown';
import {assert, describe, expect, it} from 'vitest';

import {
  $convertFromMarkdownString,
  $convertFromMdast,
  $convertSelectionToMarkdownString,
  $convertToMarkdownString,
  $convertToMdast,
  $generateNodesFromMarkdownString,
  $generateNodesFromMdast,
  ImportContextMarkdown,
  MdastAutolinkLiteralExtension,
  MdastCommonMarkExtension,
  MdastExtension,
  MdastHeadingExtension,
  MdastShadowRootQuoteExtension,
  MdastStrikethroughExtension,
  MdastTaskListExtension,
  RenderContextMarkdownSelection,
} from '../../index';

function createEditor(): LexicalEditorWithDispose {
  // The caller is responsible for disposal (with `using`).
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        MdastCommonMarkExtension,
        // GFM constructs under test that aren't part of CommonMark.
        MdastStrikethroughExtension,
        MdastTaskListExtension,
        MdastExtension,
      ],
      name: '[root]',
    }),
  );
}

function importExport(markdown: string): string {
  using editor = createEditor();
  editor.update(
    () => {
      $convertFromMarkdownString(markdown);
    },
    {discrete: true},
  );
  return editor.read(() => $convertToMarkdownString());
}

describe('@lexical/mdast import/export', () => {
  it('omits a node and its children when its import handler returns null', () => {
    using editor = buildEditorFromExtensions(
      configExtension(MdastExtension, {
        importRules: [
          {$import: () => null, type: 'strong'},
          {
            $import: (_node, context) => context.createText('lower-priority'),
            type: 'strong',
          },
        ],
      }),
    );
    editor.update(() => $convertFromMarkdownString('a **b** c'), {
      discrete: true,
    });
    expect(editor.read(() => $getRoot().getTextContent())).toBe('a  c');
  });

  describe('round-trips simple constructs', () => {
    const cases: [string, string][] = [
      ['paragraph', 'Hello world'],
      ['heading h1', '# Heading one'],
      ['heading h3', '### Heading three'],
      ['bold', '**bold**'],
      ['italic', '*italic*'],
      ['bold italic', '***both***'],
      ['inline code', '`code()`'],
      ['strikethrough (gfm)', '~~gone~~'],
      ['mixed inline', 'a **b** c *d* e `f`'],
      ['link', '[lexical](https://lexical.dev)'],
      ['link with title', '[lexical](https://lexical.dev "the title")'],
      ['blockquote', '> quoted text'],
      ['unordered list', '- one\n- two\n- three'],
      ['ordered list', '1. one\n2. two\n3. three'],
      ['task list', '- [x] done\n- [ ] todo'],
      ['soft line break in a paragraph', 'line one\nline two'],
      ['soft line break in a blockquote', '> line one\n> line two'],
      ['soft line break in a list item', '- line one\n  line two'],
      ['thematic break (dashes)', '---'],
      ['thematic break (stars)', '***'],
      ['thematic break (underscores)', '___'],
      ['autolink', '<https://example.com>'],
    ];
    for (const [name, markdown] of cases) {
      it(name, () => {
        expect(importExport(markdown)).toBe(markdown);
      });
    }
  });

  describe('overlapping inline formats (#4895)', () => {
    type Run = [text: string, format: number];

    /** Builds a one-paragraph document from explicit text-node format runs. */
    function overlapEditor(runs: Run[]): LexicalEditorWithDispose {
      // The caller is responsible for disposal (with `using`).
      const editor = createEditor();
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          for (const [text, format] of runs) {
            paragraph.append($createTextNode(text).setFormat(format));
          }
          $getRoot().clear().append(paragraph);
        },
        {discrete: true},
      );
      return editor;
    }

    /** Reads the document back as merged (text, format) runs. */
    function $textRuns(): Run[] {
      const out: Run[] = [];
      for (const node of $getRoot().getAllTextNodes()) {
        const format = node.getFormat();
        const text = node.getTextContent();
        const last = out[out.length - 1];
        if (last && last[1] === format) {
          last[0] += text;
        } else {
          out.push([text, format]);
        }
      }
      return out;
    }

    /**
     * Exports `runs`, asserts the serialized markdown, and verifies that
     * re-importing the export restores the same formatting.
     */
    function expectRoundTrip(runs: Run[], expected: string): void {
      using editor = overlapEditor(runs);
      const markdown = editor.read(() => $convertToMarkdownString());
      expect(markdown).toBe(expected);
      using reimported = createEditor();
      reimported.update(
        () => {
          $convertFromMarkdownString(markdown);
        },
        {discrete: true},
      );
      expect(reimported.read($textRuns)).toEqual(runs);
    }

    const BOLD = TEXT_TYPE_TO_FORMAT.bold;
    const ITALIC = TEXT_TYPE_TO_FORMAT.italic;
    const STRIKE = TEXT_TYPE_TO_FORMAT.strikethrough;
    const CODE = TEXT_TYPE_TO_FORMAT.code;

    it('round-trips bold overlapping italic (the issue example)', () => {
      expectRoundTrip(
        [
          ['he', 0],
          ['llo', BOLD],
          ['wor', BOLD | ITALIC],
          ['ld', ITALIC],
          ['!', 0],
        ],
        'he**llo*wor****ld*!',
      );
    });

    it('round-trips italic overlapping bold', () => {
      expectRoundTrip(
        [
          ['a', 0],
          ['b', ITALIC],
          ['c', ITALIC | BOLD],
          ['d', BOLD],
          ['e', 0],
        ],
        'a*b**c*****d**e',
      );
    });

    it('round-trips strikethrough overlapping bold', () => {
      expectRoundTrip(
        [
          ['a', STRIKE],
          ['b', STRIKE | BOLD],
          ['c', BOLD],
        ],
        '~~a**b**~~**c**',
      );
    });

    it('round-trips a code span inside a bold run', () => {
      expectRoundTrip(
        [
          ['a', BOLD],
          ['b', BOLD | CODE],
          ['c', BOLD],
        ],
        '**a`b`c**',
      );
    });
  });

  it('with NodeStructureExtension, leaves no break where a nested block is lifted out', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [MdastCommonMarkExtension, NodeStructureExtension],
        name: '[root]',
      }),
    );
    const shapeOf = (node: LexicalNode): unknown => {
      if (!$isElementNode(node)) {
        return $isTextNode(node) ? node.getTextContent() : node.getType();
      }
      const children = node.getChildren().map(shapeOf);
      return $isListNode(node)
        ? [`list ${node.getStart()}`, ...children]
        : [node.getType(), ...children];
    };
    const shapes = (markdown: string) => {
      editor.update(() => $convertFromMarkdownString(markdown), {
        discrete: true,
      });
      return editor.read(() => $getRoot().getChildren().map(shapeOf));
    };
    expect(shapes('> a\n>\n> ```\n> c\n> ```\n>\n> b')).toEqual([
      ['quote', 'a'],
      ['code', 'c'],
      ['quote', 'b'],
    ]);
    expect(shapes('1. x\n2. a\n\n   ---\n\n   b\n3. y')).toEqual([
      ['list 1', ['listitem', 'x'], ['listitem', 'a']],
      'horizontalrule',
      // The second list continues the numbering.
      ['list 3', ['listitem', 'b'], ['listitem', 'y']],
    ]);
    // Paragraphs of one quote stay one quote, as without the extension.
    expect(shapes('> a\n>\n> b')).toEqual([['quote', 'a', 'linebreak', 'b']]);
  });

  it('round-trips an ordered list with a custom start', () => {
    expect(importExport('5. five\n6. six')).toBe('5. five\n6. six');
  });

  it('round-trips a fenced code block with a language', () => {
    const markdown = '```js\nconst x = 1;\n```';
    expect(importExport(markdown)).toBe(markdown);
  });

  it('round-trips a multi-line fenced code block', () => {
    const markdown = '```\nline 1\nline 2\nline 3\n```';
    expect(importExport(markdown)).toBe(markdown);
  });

  it('imports a heading with inline formatting into the right structure', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('# Hello *world*');
      },
      {discrete: true},
    );
    editor.read(() => {
      const heading = $assertNodeType(
        $getRoot().getFirstChild(),
        $isHeadingNode,
      );
      expect(heading.getTag()).toBe('h1');
      expect(heading.getTextContent()).toBe('Hello world');
      const children = heading.getChildren();
      // "Hello " (plain) + "world" (italic)
      expect(children).toHaveLength(2);
      expect($assertNodeType(children[1], $isTextNode).getFormat()).not.toBe(0);
    });
  });

  it('imports nested unordered lists', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('- a\n- b\n  - b1\n  - b2\n- c');
      },
      {discrete: true},
    );
    editor.read(() => {
      const list = $assertNodeType($getRoot().getFirstChild(), $isListNode);
      expect(list.getListType()).toBe('bullet');
      // a, b, (nested list wrapper), c
      expect(list.getChildrenSize()).toBe(4);
    });
  });

  it('keeps blank lines as paragraph separators (not empty paragraphs)', () => {
    expect(importExport('first\n\nsecond')).toBe('first\n\nsecond');
  });

  describe('editor-created line breaks', () => {
    function exportBlock($block: () => LexicalNode): string {
      using editor = createEditor();
      editor.update(() => $getRoot().clear().append($block()), {
        discrete: true,
      });
      return editor.read(() => $convertToMarkdownString());
    }

    function exportParagraph($children: () => LexicalNode[]): string {
      return exportBlock(() => $createParagraphNode().append(...$children()));
    }

    function importText(markdown: string): string[] {
      using editor = createEditor();
      let text: string[] = [];
      editor.update(
        () => {
          text = $generateNodesFromMarkdownString(markdown).map(node =>
            node.getTextContent(),
          );
        },
        {discrete: true},
      );
      return text;
    }

    const cases: [string, () => LexicalNode[], string, string][] = [
      [
        'a single break stays a soft newline',
        () => [
          $createTextNode('a'),
          $createLineBreakNode(),
          $createTextNode('b'),
        ],
        'a\nb',
        'a\nb',
      ],
      [
        'consecutive breaks use hard breaks',
        () => [
          $createTextNode('a'),
          $createLineBreakNode(),
          $createLineBreakNode(),
          $createTextNode('b'),
        ],
        'a\\\n\\\nb',
        'a\n\nb',
      ],
      [
        'a leading break uses a hard break',
        () => [$createLineBreakNode(), $createTextNode('a')],
        '\\\na',
        '\na',
      ],
      [
        'only the breaks next to another break are hard',
        () => [
          $createTextNode('a'),
          $createLineBreakNode(),
          $createTextNode('b'),
          $createLineBreakNode(),
          $createLineBreakNode(),
          $createTextNode('c'),
        ],
        'a\nb\\\n\\\nc',
        'a\nb\n\nc',
      ],
    ];
    for (const [name, $children, markdown, text] of cases) {
      it(name, () => {
        expect(exportParagraph($children)).toBe(markdown);
        expect(importText(markdown)).toEqual([text]);
      });
    }

    it('does not add a backslash for trailing breaks', () => {
      expect(
        exportParagraph(() => [
          $createTextNode('a'),
          $createLineBreakNode(),
          $createLineBreakNode(),
        ]),
      ).not.toContain('\\');
    });

    const blockCases: [string, () => LexicalNode, string, string][] = [
      [
        'a break at the start of a link after text stays soft',
        () =>
          $createParagraphNode().append(
            $createTextNode('x'),
            $createLinkNode('https://e.com').append(
              $createLineBreakNode(),
              $createTextNode('y'),
            ),
          ),
        'x[\ny](https://e.com)',
        'x\ny',
      ],
      [
        'breaks at the end of a link with text after it are hard',
        () =>
          $createParagraphNode().append(
            $createLinkNode('https://e.com').append(
              $createTextNode('y'),
              $createLineBreakNode(),
              $createLineBreakNode(),
            ),
            $createTextNode('z'),
          ),
        '[y\\\n\\\n](https://e.com)z',
        'y\n\nz',
      ],
      [
        'leading and consecutive breaks in a quote are hard',
        () =>
          $createQuoteNode().append(
            $createLineBreakNode(),
            $createTextNode('a'),
            $createLineBreakNode(),
            $createLineBreakNode(),
            $createTextNode('b'),
          ),
        '> \\\n> a\\\n> \\\n> b',
        '\na\n\nb',
      ],
      [
        'consecutive breaks in a list item are hard',
        () =>
          $createListNode('bullet').append(
            $createListItemNode().append(
              $createTextNode('a'),
              $createLineBreakNode(),
              $createLineBreakNode(),
              $createTextNode('b'),
            ),
          ),
        '- a\\\n  \\\n  b',
        'a\n\nb',
      ],
    ];
    for (const [name, $block, markdown, text] of blockCases) {
      it(name, () => {
        expect(exportBlock($block)).toBe(markdown);
        expect(importText(markdown)).toEqual([text]);
      });
    }
  });

  describe('imported line breaks that end up first or next to another break', () => {
    const cases: [string, string, string][] = [
      ['two-space breaks around a deleted line', 'a  \nb  \nc', 'a\\\n\\\nc'],
      ['a two-space break whose line is deleted', 'a  \nb', '\\\nb'],
      ['soft breaks around a deleted line', 'a\nb\nc', 'a\\\n\\\nc'],
    ];
    for (const [name, source, markdown] of cases) {
      it(name, () => {
        using editor = createEditor();
        editor.update(() => $convertFromMarkdownString(source), {
          discrete: true,
        });
        editor.update(
          () => {
            const paragraph = $assertNodeType(
              $getRoot().getFirstChildOrThrow(),
              $isElementNode,
            );
            const lines = paragraph
              .getChildren()
              .filter(node => !$isLineBreakNode(node));
            lines[lines.length === 3 ? 1 : 0].remove();
          },
          {discrete: true},
        );
        const text = editor.read(() => $getRoot().getTextContent());
        const exported = editor.read(() => $convertToMarkdownString());
        expect(exported).toBe(markdown);
        editor.update(() => $convertFromMarkdownString(exported), {
          discrete: true,
        });
        expect(editor.read(() => $getRoot().getTextContent())).toBe(text);
      });
    }
  });

  describe('preserves the original Markdown syntax', () => {
    const cases: [string, string][] = [
      ['star bullets', '* one\n* two'],
      ['plus bullets', '+ one\n+ two'],
      ['ordered list with ) delimiter', '1) one\n2) two'],
      ['tilde code fence', '~~~\ncode\n~~~'],
      ['tilde fence with language', '~~~js\nconst x = 1;\n~~~'],
      ['fence info-string meta', '```js title=x\nconst x = 1;\n```'],
      ['tilde fence with meta', '~~~python linenos\nprint(1)\n~~~'],
      ['backslash hard break', 'line one\\\nline two'],
      ['two-space hard break', 'line one  \nline two'],
      ['underscore italic', '_em_'],
      ['underscore bold', '__strong__'],
      ['underscore bold italic', '___both___'],
      ['underscore emphasis throughout', '_a_ and __b__ and _c_'],
      ['inline link whose text is its URL', '[https://a.dev](https://a.dev)'],
      ['setext h1', 'Title\n====='],
      ['setext h2', 'Title\n-----'],
      ['hard break inside a blockquote', '> line one\\\n> line two'],
      ['paragraph boundary inside a blockquote', '> para one\n>\n> para two'],
      ['hard break inside a list item', '- line one\\\n  line two'],
    ];
    for (const [name, markdown] of cases) {
      it(name, () => {
        expect(importExport(markdown)).toBe(markdown);
      });
    }

    it('keeps distinct bullet styles on different lists', () => {
      const markdown = '* a\n* b\n\n1. c\n\n- d\n- e';
      expect(importExport(markdown)).toBe(markdown);
    });

    it('keeps setext style when the content starts with #', () => {
      // `#foo\n====` is a setext h1 (no space after `#`, so not ATX). The
      // exporter escapes the leading `#` to keep it unambiguous, but the
      // heading must stay setext and the round-trip must be stable.
      const out = importExport('#foo\n====');
      expect(out).toMatch(/^\\?#foo\n=+$/);
      expect(importExport(out)).toBe(out);
    });

    it('normalizes mixed emphasis markers to the document delimiter', () => {
      // Emphasis/strong delimiters are document-level, so the first one wins.
      expect(importExport('_a_ and *b*')).toBe('_a_ and _b_');
      const out = importExport('_a_ and *b*');
      expect(importExport(out)).toBe(out); // and is stable
    });
  });

  it('round-trips autolink literals without normalizing to <...>', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastCommonMarkExtension,
          MdastAutolinkLiteralExtension,
          MdastExtension,
        ],
        name: '[root]',
      }),
    );
    const roundTrip = (markdown: string): string => {
      editor.update(
        () => {
          $convertFromMarkdownString(markdown);
        },
        {discrete: true},
      );
      return editor.read(() => $convertToMarkdownString());
    };
    for (const markdown of [
      'see https://lexical.dev today',
      'visit www.example.com now',
      // A CommonMark autolink stays wrapped even with the literal grammar on.
      'wrapped <https://lexical.dev> stays',
    ]) {
      expect(roundTrip(markdown)).toBe(markdown);
    }
  });

  it('reuses literal validation during lookahead and repeated exports', () => {
    let parses = 0;
    using editor = buildEditorFromExtensions(
      MdastCommonMarkExtension,
      MdastAutolinkLiteralExtension,
      configExtension(MdastExtension, {
        mdastExtensions: [
          {
            transforms: [
              () => {
                parses++;
              },
            ],
          },
        ],
      }),
    );
    const markdown = 'https://lexical.dev www.example.com';
    editor.update(() => $convertFromMarkdownString(markdown), {
      discrete: true,
    });
    parses = 0;
    expect(editor.read(() => $convertToMarkdownString())).toBe(markdown);
    expect(parses).toBeLessThanOrEqual(2);
    const firstExportParses = parses;
    expect(editor.read(() => $convertToMarkdownString())).toBe(markdown);
    expect(parses).toBe(firstExportParses);
    editor.update(
      () => $getRoot().getAllTextNodes()[0].setTextContent('caption'),
      {discrete: true},
    );
    const edited = '[caption](https://lexical.dev) www.example.com';
    expect(editor.read(() => $convertToMarkdownString())).toBe(edited);
    expect(parses).toBeLessThanOrEqual(firstExportParses + 1);
    const editedExportParses = parses;
    expect(editor.read(() => $convertToMarkdownString())).toBe(edited);
    expect(parses).toBe(editedExportParses);
  });

  it('reuses literal validation across subtree and selection exports', () => {
    let parses = 0;
    using editor = buildEditorFromExtensions(
      MdastCommonMarkExtension,
      MdastAutolinkLiteralExtension,
      configExtension(MdastExtension, {
        mdastExtensions: [
          {
            transforms: [
              () => {
                parses++;
              },
            ],
          },
        ],
      }),
    );
    const markdown = 'https://one.example\n\nhttps://two.example';
    editor.update(() => $convertFromMarkdownString(markdown), {
      discrete: true,
    });
    parses = 0;
    editor.read(() => {
      const first = $assertNodeType(
        $getRoot().getFirstChildOrThrow(),
        $isElementNode,
      );
      const last = $assertNodeType(
        $getRoot().getLastChildOrThrow(),
        $isElementNode,
      );
      expect($convertToMarkdownString(first)).toBe('https://one.example');
      expect($convertToMarkdownString(last)).toBe('https://two.example');
      const warmedParses = parses;
      expect($convertToMarkdownString(first)).toBe('https://one.example');
      expect($convertToMarkdownString(last)).toBe('https://two.example');
      expect($convertToMarkdownString()).toBe(markdown);
      expect(parses).toBe(warmedParses);
    });
    editor.update(() => $getRoot().getAllTextNodes()[0].select(0), {
      discrete: true,
    });
    const warmedParses = parses;
    expect(editor.read(() => $convertSelectionToMarkdownString())).toBe(
      'https://one.example',
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe(markdown);
    expect(parses).toBe(warmedParses);
  });

  it('keeps edits to imported autolink literals', () => {
    using editor = buildEditorFromExtensions(
      MdastCommonMarkExtension,
      MdastAutolinkLiteralExtension,
      MdastExtension,
    );
    editor.update(
      () =>
        $convertFromMarkdownString(
          'https://one.example https://two.example https://three.example',
        ),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      'https://one.example https://two.example https://three.example',
    );
    const $links = () =>
      $assertNodeType($getRoot().getFirstChildOrThrow(), $isElementNode)
        .getChildren()
        .filter($isLinkNode);
    editor.update(
      () => {
        const [destination, label, formatted] = $links();
        destination.setURL('https://changed.example');
        $assertNodeType(
          label.getFirstChildOrThrow(),
          $isTextNode,
        ).setTextContent('caption');
        $assertNodeType(
          formatted.getFirstChildOrThrow(),
          $isTextNode,
        ).setFormat('bold');
      },
      {discrete: true},
    );
    const markdown = editor.read(() => $convertToMarkdownString());
    expect(markdown).toBe(
      '[https://one.example](https://changed.example) ' +
        '[caption](https://two.example) ' +
        '[**https://three.example**](https://three.example)',
    );
    editor.update(() => $convertFromMarkdownString(markdown), {
      discrete: true,
    });
    editor.read(() => {
      expect(
        $links().map(link => [link.getURL(), link.getTextContent()]),
      ).toEqual([
        ['https://changed.example', 'https://one.example'],
        ['https://two.example', 'caption'],
        ['https://three.example', 'https://three.example'],
      ]);
      expect(
        $assertNodeType(
          $links()[2].getFirstChildOrThrow(),
          $isTextNode,
        ).hasFormat('bold'),
      ).toBe(true);
      expect($convertToMarkdownString()).toBe(markdown);
    });
  });

  describe('mdast tree interop', () => {
    it('$convertToMdast exposes the mdast tree before serialization', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('# Title\n\nSome *emphasis* here');
        },
        {discrete: true},
      );
      const tree = editor.read(() => $convertToMdast());
      expect(tree.type).toBe('root');
      expect(tree.children.map(child => child.type)).toEqual([
        'heading',
        'paragraph',
      ]);
      const heading = tree.children[0] as {depth: number};
      expect(heading.depth).toBe(1);
      const paragraph = tree.children[1] as {
        children: {type: string}[];
      };
      expect(paragraph.children.map(child => child.type)).toEqual([
        'text',
        'emphasis',
        'text',
      ]);
    });

    it('$convertFromMdast imports a programmatically-built tree', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMdast({
            children: [
              {
                children: [{type: 'text', value: 'Built'}],
                depth: 2,
                type: 'heading',
              },
              {
                children: [{type: 'text', value: 'by hand'}],
                type: 'paragraph',
              },
            ],
            type: 'root',
          });
        },
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString())).toBe(
        '## Built\n\nby hand',
      );
    });

    it('round-trips editor -> tree -> editor', () => {
      const markdown = '# Title\n\n- one\n- two\n\n> quoted';
      using source = createEditor();
      source.update(
        () => {
          $convertFromMarkdownString(markdown);
        },
        {discrete: true},
      );
      const tree = source.read(() => $convertToMdast());
      using target = createEditor();
      target.update(
        () => {
          $convertFromMdast(tree);
        },
        {discrete: true},
      );
      expect(target.read(() => $convertToMarkdownString())).toBe(markdown);
    });
  });

  it('applies contributed document-level toMarkdown options', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastCommonMarkExtension,
          configExtension(MdastExtension, {
            toMarkdownExtensions: [{bullet: '+'}],
          }),
        ],
        name: '[root]',
      }),
    );
    editor.update(
      () => {
        // Imported via tree (no source), so no per-node bullet is recorded
        // and the document-level option decides.
        $convertFromMdast({
          children: [
            {
              children: [
                {
                  checked: null,
                  children: [
                    {
                      children: [{type: 'text', value: 'one'}],
                      type: 'paragraph',
                    },
                  ],
                  spread: false,
                  type: 'listItem',
                },
              ],
              ordered: false,
              spread: false,
              type: 'list',
            },
          ],
          type: 'root',
        });
      },
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe('+ one');
  });

  it('$generateNodesFromMarkdownString returns detached nodes without touching the document', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('existing content');
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const nodes = $generateNodesFromMarkdownString('# Title\n\n- a\n- b');
        expect(nodes).toHaveLength(2);
        $assertNodeType(nodes[0], $isHeadingNode);
        $assertNodeType(nodes[1], $isListNode);
        expect(nodes[0].isAttached()).toBe(false);
        // The document is untouched by generation.
        expect($getRoot().getTextContent()).toBe('existing content');
      },
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      'existing content',
    );
  });

  it('generated nodes can be inserted at an arbitrary position', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('before\n\nafter');
      },
      {discrete: true},
    );
    editor.update(
      () => {
        // Insert at an empty paragraph between the two existing blocks
        // (insertNodes at a text caret would merge inline content instead).
        const first = $assertNodeType(
          $getRoot().getFirstChild(),
          $isElementNode,
        );
        const target = $createParagraphNode();
        first.insertAfter(target);
        target.select();
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        selection.insertNodes(
          $generateNodesFromMarkdownString('> quoted **insert**'),
        );
      },
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      'before\n\n> quoted **insert**\n\nafter',
    );
  });

  it('$generateNodesFromMdast returns detached nodes for a pre-parsed tree', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const nodes = $generateNodesFromMdast({
          children: [
            {
              children: [{type: 'text', value: 'Tree'}],
              depth: 2,
              type: 'heading',
            },
          ],
          type: 'root',
        });
        expect(nodes).toHaveLength(1);
        const heading = $assertNodeType(nodes[0], $isHeadingNode);
        expect(heading.isAttached()).toBe(false);
        expect(heading.getTextContent()).toBe('Tree');
      },
      {discrete: true},
    );
  });

  describe('$convertSelectionToMarkdownString', () => {
    /**
     * Imports `markdown`, selects from `anchor` to `focus` (offsets into the
     * document's text nodes, in order), and exports the selection.
     */
    function selectionExport(
      markdown: string,
      $select: (textNodes: TextNode[]) => void,
    ): string {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString(markdown);
          $select($getRoot().getAllTextNodes());
        },
        {discrete: true},
      );
      return editor.read(() => $convertSelectionToMarkdownString());
    }

    function $selectSpan(
      anchorNode: TextNode,
      anchorOffset: number,
      focusNode: TextNode,
      focusOffset?: number,
    ): void {
      $setSelectionFromCaretRange(
        $getCaretRange(
          $getTextPointCaret(anchorNode, 'next', anchorOffset),
          $getTextPointCaret(
            focusNode,
            'next',
            focusOffset === undefined ? 'next' : focusOffset,
          ),
        ),
      );
    }

    it('exports a partial text selection', () => {
      expect(
        selectionExport('Hello World', ([text]) => text.select(6, 11)),
      ).toBe('World');
    });

    it('keeps formatting on a selection spanning formatted text', () => {
      expect(
        selectionExport('Hello **Bold** World', ([plain, bold]) =>
          $selectSpan(plain, 0, bold),
        ),
      ).toBe('Hello **Bold**');
    });

    it('returns an empty string for a null or collapsed selection', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('Hello World');
          $getRoot().getAllTextNodes()[0].select(5, 5);
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($convertSelectionToMarkdownString()).toBe('');
        expect($convertSelectionToMarkdownString(null)).toBe('');
      });
    });

    it('exports a multi-paragraph selection and skips unselected blocks', () => {
      expect(
        selectionExport('One\n\nTwo\n\nThree', ([, two]) => two.select(0, 3)),
      ).toBe('Two');
      expect(
        selectionExport('One\n\nTwo\n\nThree', ([one, , three]) =>
          $selectSpan(one, 0, three),
        ),
      ).toBe('One\n\nTwo\n\nThree');
    });

    it('exports only the selected list items', () => {
      expect(
        selectionExport('- one\n- two\n- three', ([one, two]) =>
          $selectSpan(one, 0, two),
        ),
      ).toBe('- one\n- two');
    });

    it('keeps the heading structure for a partial heading selection', () => {
      expect(selectionExport('# Heading', ([text]) => text.select(0, 4))).toBe(
        '# Head',
      );
    });

    it('keeps the link wrapper when link text is partially selected', () => {
      expect(
        selectionExport(
          'before [link text](https://example.com) after',
          textNodes => textNodes[1].select(0, 4),
        ),
      ).toBe('[link](https://example.com)');
    });

    it('exposes the selection to contributed to-markdown handlers', () => {
      // A contributed root handler whose output depends on the export's
      // scope (e.g. appending end-of-document data like footnote
      // definitions) reads the selection through the render context:
      // null on a whole-document export, the BaseSelection on a selection
      // export.
      const probe: boolean[] = [];
      using editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            MdastCommonMarkExtension,
            configExtension(MdastExtension, {
              toMarkdownExtensions: [
                {
                  handlers: {
                    root: (node, parent, state, info) => {
                      probe.push(
                        $getRenderContextValue(
                          RenderContextMarkdownSelection,
                        ) !== null,
                      );
                      return defaultHandlers.root(node, parent, state, info);
                    },
                  },
                },
              ],
            }),
          ],
          name: '[selection-option]',
        }),
      );
      editor.update(
        () => {
          $convertFromMarkdownString('hello world');
          $getRoot().getAllTextNodes()[0].select(0, 5);
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($convertToMarkdownString()).toBe('hello world');
        expect($convertSelectionToMarkdownString()).toBe('hello');
      });
      expect(probe).toEqual([false, true]);
    });
  });

  describe('import context', () => {
    // The mdast walk runs under the same import-context mechanism the DOM
    // rules use: handlers read ambient state with $getImportContextValue
    // and layer state for their subtree with $withImportContext — nested
    // handlers (and DOM-rule sessions opened for raw HTML) see the layer,
    // siblings outside it do not.
    const probeState = createImportState('mdastProbe', () => 'default');

    it('runs handlers under ImportContextMarkdown with nested layering', () => {
      const seen: [string, boolean, string][] = [];
      using editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            MdastCommonMarkExtension,
            configExtension(MdastExtension, {
              importRules: [
                {
                  $import: (node, ctx) => {
                    seen.push([
                      'emphasis',
                      $getImportContextValue(ImportContextMarkdown),
                      $getImportContextValue(probeState),
                    ]);
                    return $withImportContext([
                      contextValue(probeState, 'layered'),
                    ])(() => ctx.importChildren(node));
                  },
                  type: 'emphasis',
                },
                {
                  $import: (node, ctx) => {
                    seen.push([
                      'strong',
                      $getImportContextValue(ImportContextMarkdown),
                      $getImportContextValue(probeState),
                    ]);
                    return ctx.importChildren(node);
                  },
                  type: 'strong',
                },
              ],
            }),
          ],
          name: '[import-context]',
        }),
      );
      editor.update(
        () => {
          $convertFromMarkdownString('*em **inner*** and **outer**');
        },
        {discrete: true},
      );
      expect(seen).toEqual([
        // Every handler sees ImportContextMarkdown; the probe layer applies
        // to the emphasis subtree only.
        ['emphasis', true, 'default'],
        ['strong', true, 'layered'],
        ['strong', true, 'default'],
      ]);
      // The context does not leak outside the import operation.
      editor.read(() => {
        expect($getImportContextValue(ImportContextMarkdown)).toBe(false);
        expect($getImportContextValue(probeState)).toBe('default');
      });
    });
  });

  it('unwraps constructs the editor has no extension for', () => {
    // Headings only — no blockquote extension. `> quote` imports as its
    // children (a paragraph) instead of corrupting or dropping content.
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [MdastHeadingExtension, MdastExtension],
        name: '[root]',
      }),
    );
    editor.update(
      () => {
        $convertFromMarkdownString('# Title\n\n> quoted text');
      },
      {discrete: true},
    );
    editor.read(() => {
      const types = $getRoot()
        .getChildren()
        .map(n => n.getType());
      expect(types).toEqual(['heading', 'paragraph']);
    });
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      '# Title\n\nquoted text',
    );
  });

  it('imports an autolink literal (gfm) as a link', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [MdastCommonMarkExtension, MdastAutolinkLiteralExtension],
        name: '[root]',
      }),
    );
    editor.update(
      () => {
        $convertFromMarkdownString('see https://lexical.dev today');
      },
      {discrete: true},
    );
    editor.read(() => {
      const paragraph = $assertNodeType(
        $getRoot().getFirstChild(),
        $isElementNode,
      );
      const links = paragraph.getChildren().filter($isLinkNode);
      expect(links).toHaveLength(1);
      expect(links[0].getURL()).toBe('https://lexical.dev');
    });
  });

  it('is idempotent for a complex document', () => {
    const markdown = [
      '# Title',
      '',
      'A paragraph with **bold**, *italic* and `code`.',
      '',
      '> A quote',
      '',
      '- list a',
      '- list b',
      '',
      '1. one',
      '2. two',
      '',
      '```ts',
      'type X = number;',
      '```',
    ].join('\n');
    const once = importExport(markdown);
    const twice = importExport(once);
    expect(twice).toBe(once);
  });

  describe('with MdastShadowRootQuoteExtension', () => {
    function shadowQuoteEditor(): LexicalEditorWithDispose {
      // The caller is responsible for disposal (with `using`).
      return buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            MdastCommonMarkExtension,
            MdastExtension,
            MdastShadowRootQuoteExtension,
          ],
          name: '[root]',
        }),
      );
    }

    function shadowImportExport(markdown: string): string {
      using editor = shadowQuoteEditor();
      editor.update(
        () => {
          $convertFromMarkdownString(markdown);
        },
        {discrete: true},
      );
      return editor.read(() => $convertToMarkdownString());
    }

    const cases: [string, string][] = [
      ['simple quote', '> quoted text'],
      ['multi-paragraph quote', '> para one\n>\n> para two'],
      ['quote with a nested list', '> intro\n>\n> - a\n> - b'],
      ['quote with a code block', '> before\n>\n> ```\n> code\n> ```'],
      ['nested quote', '> outer\n>\n> > inner'],
      ['quote with a heading', '> # Title\n>\n> body'],
      ['soft break stays soft', '> line one\n> line two'],
      ['hard break stays hard', '> line one\\\n> line two'],
    ];
    for (const [name, markdown] of cases) {
      it(name, () => {
        expect(shadowImportExport(markdown)).toBe(markdown);
      });
    }

    it('imports the quote as a shadow root with block children', () => {
      using editor = shadowQuoteEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('> para one\n>\n> - a\n> - b');
        },
        {discrete: true},
      );
      editor.read(() => {
        const quote = $assertNodeType($getRoot().getFirstChild(), $isQuoteNode);
        expect(quote.isShadowRoot()).toBe(true);
        const types = quote.getChildren().map(n => n.getType());
        expect(types).toEqual(['paragraph', 'list']);
      });
    });
  });

  describe('reference links', () => {
    it('resolves full references against definitions', () => {
      expect(importExport('[foo][bar]\n\n[bar]: https://example.com')).toBe(
        '[foo](https://example.com)',
      );
    });

    it('resolves collapsed and shortcut references', () => {
      expect(importExport('[foo][]\n\n[foo]: https://example.com')).toBe(
        '[foo](https://example.com)',
      );
      expect(importExport('[foo]\n\n[foo]: https://example.com')).toBe(
        '[foo](https://example.com)',
      );
    });

    it('resolves references with titles', () => {
      expect(
        importExport('[foo][bar]\n\n[bar]: https://example.com "the title"'),
      ).toBe('[foo](https://example.com "the title")');
    });

    it('keeps unresolved references as literal text', () => {
      const out = importExport('[foo][nope]');
      expect(out).toContain('foo');
      expect(out).not.toContain('](');
    });
  });

  it.each(['foo\tbar', '**foo\tbar**'])(
    'round-trips tabs with their text format: %s',
    markdown => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString(markdown);
        },
        {discrete: true},
      );
      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isElementNode,
        );
        const types = paragraph.getChildren().map(n => n.getType());
        expect(types).toEqual(['text', 'tab', 'text']);
        for (const child of paragraph.getChildren()) {
          expect($assertNodeType(child, $isTextNode).hasFormat('bold')).toBe(
            markdown.startsWith('**'),
          );
        }
        expect($convertToMarkdownString()).toBe(markdown);
      });
    },
  );

  it('tolerates explicitly-undefined config keys in configExtension', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastCommonMarkExtension,
          configExtension(MdastExtension, {
            importRules: undefined,
            mdastExtensions: undefined,
          }),
        ],
        name: '[root]',
      }),
    );
    editor.update(
      () => {
        $convertFromMarkdownString('# Still works');
      },
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe('# Still works');
  });
});
