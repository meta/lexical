/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {BlockContent} from 'mdast';

import {
  $createHorizontalRuleNode,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  HorizontalRuleNode,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {
  $distributeInlineWrapper,
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
  $getRenderContextValue,
  $withImportContext,
  BlockSchema,
  contextValue,
  createImportState,
  defineImportRule,
  DOMImportExtension,
  ImportTextStyle,
  sel,
} from '@lexical/html';
import {LinkExtension} from '@lexical/link';
import {ListExtension, ListNode} from '@lexical/list';
import {
  $createQuoteNode,
  $isQuoteNode,
  HeadingNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSlot,
  $isElementNode,
  $isTextNode,
  $setSlot,
  configExtension,
  defineExtension,
  type DOMExportOutput,
  ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {fromMarkdown} from 'mdast-util-from-markdown';
import {describe, expect, it} from 'vitest';

import {
  $convertFromMarkdownString,
  $convertFromMdast,
  $convertSelectionToMarkdownString,
  $convertToMarkdownString,
  $exportViaDOM,
  ImportContextMarkdown,
  MdastCommonMarkExtension,
  type MdastExportHandler,
  MdastExtension,
  MdastHtmlExtension,
  MdastShadowRootQuoteExtension,
  MdastStrikethroughExtension,
  MdastTableExtension,
  rawHtmlBlock,
  RenderContextMarkdownExport,
} from '../../index';

// Probes ImportContextMarkdown: the same markup imports differently from
// Markdown vs. a direct DOM/HTML import.
const CiteProbeRule = defineImportRule({
  $import: ctx => [
    $createTextNode(ctx.get(ImportContextMarkdown) ? 'FROM-MD' : 'FROM-HTML'),
  ],
  match: sel.tag('cite'),
  name: 'test/cite-probe',
});

// A slot-hosting construct standing in for an app's node (the collapsible
// pattern), whose exportDOM shell is the single source of truth for BOTH
// the HTML clipboard and (via $exportViaDOM) the Markdown encoding: the
// `data-lexical-slot` marker is where the title embeds, the children
// position is where the body embeds.
class CalloutNode extends ElementNode {
  $config() {
    return this.config('x-callout', {
      extends: ElementNode,
      slots: ['title'],
    });
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isShadowRoot(): true {
    return true;
  }
  exportDOM(): DOMExportOutput {
    const element = document.createElement('x-callout');
    element.setAttribute('open', '');
    // The Markdown analog of RenderContextExport: the shell can diverge per
    // destination (e.g. clipboard-only attributes, or skipping slot HTML
    // that the Markdown embedding replaces anyway).
    if (!$getRenderContextValue(RenderContextMarkdownExport)) {
      element.setAttribute('data-clipboard-only', 'true');
    }
    const title = document.createElement('header');
    title.setAttribute('data-lexical-slot', 'title');
    element.append(title);
    return {element};
  }
}

const CalloutRule = defineImportRule({
  $import: (ctx, el) => {
    const callout = $create(CalloutNode);
    const title = $createParagraphNode();
    $setSlot(callout, 'title', title);
    // Pull the header's inline content into the title slot, then drop it
    // from the DOM so the body walk below doesn't see it.
    const header = el.querySelector(':scope > header');
    if (header !== null) {
      for (const imported of ctx.$importChildren(header)) {
        // Flatten to the single-line field, like the collapsible summary.
        if ($isElementNode(imported) && !imported.isInline()) {
          title.append(...imported.getChildren());
        } else {
          title.append(imported);
        }
      }
      header.remove();
    }
    return [callout.append(...ctx.$importChildren(el, {schema: BlockSchema}))];
  },
  match: sel.tag('x-callout'),
  name: 'test/x-callout',
});

// A custom DOM import rule standing in for an app's node (the collapsible
// pattern): `<aside>` maps to a shadow-root QuoteNode holding the imported
// block children. Registering ONLY a DOM rule — no mdast import rule — is
// the point under test.
const AsideRule = defineImportRule({
  $import: (ctx, el) => [
    $createQuoteNode({shadowRoot: true}).splice(
      0,
      0,
      ctx.$importChildren(el, {schema: BlockSchema}),
    ),
  ],
  match: sel.tag('aside'),
  name: 'test/aside',
});

// The export counterpart, standing in for an app's HTML-encoded construct:
// a rawHtmlBlock template with the first paragraph's phrasing on the tag
// line (the <summary> shape) and the remaining blocks as flow.
const $exportAsideViaRawHtml: MdastExportHandler = (node, ctx) => {
  if (!$isQuoteNode(node)) {
    return null;
  }
  const [first, ...rest] = ctx.exportChildren(node) as BlockContent[];
  return rawHtmlBlock(
    '<aside>\n',
    first !== undefined && first.type === 'paragraph' ? first.children : [],
    ...(rest.length > 0 ? ['\n\n' as const, {flow: rest}] : []),
    '\n</aside>',
  );
};

// A node whose exportDOM overrides the children channel with $getChildNodes
// (the DOMExportOutput contract: "used instead of node.getChildren()"): only
// the first body block is exported. The Markdown embedding must follow the
// override just like the HTML exporter does.
class RedactedNode extends ElementNode {
  $config() {
    return this.config('x-redacted', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isShadowRoot(): true {
    return true;
  }
  exportDOM(): DOMExportOutput {
    return {
      $getChildNodes: () => this.getChildren().slice(0, 1),
      element: document.createElement('x-redacted'),
    };
  }
}

const RedactedRule = defineImportRule({
  $import: (ctx, el) => [
    $create(RedactedNode).splice(
      0,
      0,
      ctx.$importChildren(el, {schema: BlockSchema}),
    ),
  ],
  match: sel.tag('x-redacted'),
  name: 'test/x-redacted',
});

// An inline custom element standing in for an app's inline node (the <kbd>
// pattern): the block path's counterpart at the phrasing level. One DOM
// rule serves Markdown and HTML paste; export emits the raw open/close
// tags around the children serialized as ordinary Markdown phrasing.
class KeyNode extends ElementNode {
  $config() {
    return this.config('x-key', {extends: ElementNode});
  }
  isInline(): true {
    return true;
  }
  createDOM(): HTMLElement {
    return document.createElement('kbd');
  }
  updateDOM(): boolean {
    return false;
  }
  exportDOM(): DOMExportOutput {
    return {element: document.createElement('kbd')};
  }
}

const KeyRule = defineImportRule({
  $import: (ctx, el) =>
    $distributeInlineWrapper(ctx.$importChildren(el), () => $create(KeyNode)),
  match: sel.tag('kbd'),
  name: 'test/key',
});

const $exportKey: MdastExportHandler = (node, ctx) =>
  node instanceof KeyNode
    ? [
        {type: 'html', value: '<kbd>'},
        ...ctx.exportInline(node),
        {type: 'html', value: '</kbd>'},
      ]
    : null;

// A rule that branches ImportTextStyle for its subtree, standing in for an
// app's styled-span rule (the core rules only propagate format bits today).
const MarkColorRule = defineImportRule({
  $import: (ctx, el) =>
    ctx.$importChildren(el, {
      context: [contextValue(ImportTextStyle, {color: 'red'})],
    }),
  match: sel.tag('mark'),
  name: 'test/mark-color',
});

function createEditor(withAsideExport = false): LexicalEditorWithDispose {
  // The caller is responsible for disposal (with `using`).
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        MdastCommonMarkExtension,
        MdastStrikethroughExtension,
        MdastShadowRootQuoteExtension,
        MdastExtension,
        MdastHtmlExtension,
        // Node packages whose DOM import rules the raw HTML should reach.
        RichTextExtension,
        ListExtension,
        LinkExtension,
        configExtension(DOMImportExtension, {
          rules: [
            AsideRule,
            MarkColorRule,
            CalloutRule,
            CiteProbeRule,
            KeyRule,
            RedactedRule,
          ],
        }),
        configExtension(MdastExtension, {
          exportRules: [
            {$export: $exportViaDOM, type: 'x-callout'},
            {$export: $exportViaDOM, type: 'x-redacted'},
            {$export: $exportKey, type: 'x-key'},
          ],
        }),
        ...(withAsideExport
          ? [
              configExtension(MdastExtension, {
                exportRules: [{$export: $exportAsideViaRawHtml, type: 'quote'}],
              }),
            ]
          : []),
      ],
      name: '[root]',
      nodes: [CalloutNode, KeyNode, RedactedNode],
    }),
  );
}

function importExport(markdown: string, withAsideExport = false): string {
  using editor = createEditor(withAsideExport);
  editor.update(
    () => {
      $convertFromMarkdownString(markdown);
    },
    {discrete: true},
  );
  return editor.read(() => $convertToMarkdownString());
}

function $collectTextNodes(): TextNode[] {
  const out: TextNode[] = [];
  const visit = (node: LexicalNode): void => {
    if ($isTextNode(node)) {
      out.push(node);
    }
    if ('getChildren' in node) {
      for (const child of (
        node as {getChildren(): LexicalNode[]}
      ).getChildren()) {
        visit(child);
      }
    }
  };
  visit($getRoot());
  return out;
}

describe('MdastHtmlExtension', () => {
  describe('routing raw HTML through the DOM import rules', () => {
    it('imports a custom element with only a DOM rule registered', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('<aside>\n\nquoted *text*\n\n</aside>');
        },
        {discrete: true},
      );
      editor.read(() => {
        const first = $getRoot().getFirstChild();
        expect($isQuoteNode(first)).toBe(true);
      });
      expect(editor.read(() => $convertToMarkdownString())).toBe(
        '> quoted *text*',
      );
    });

    it('imports node-package DOM rules (headings, lists, links)', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString(
            '<h2>Title</h2>\n\n<ul><li>one</li><li>two</li></ul>\n\n<div><a href="https://lexical.dev">lexical</a></div>',
          );
        },
        {discrete: true},
      );
      editor.read(() => {
        const children = $getRoot().getChildren();
        expect(children[0]).toBeInstanceOf(HeadingNode);
        expect(children[1]).toBeInstanceOf(ListNode);
      });
      expect(editor.read(() => $convertToMarkdownString())).toBe(
        '## Title\n\n- one\n- two\n\n[lexical](https://lexical.dev)',
      );
    });

    it('hoists unknown wrappers to their imported children', () => {
      expect(importExport('<div>\n\nSome *markdown*\n\n</div>')).toBe(
        'Some *markdown*',
      );
    });

    it('leaves unclosed raw HTML as literal text', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('<div>\n\nAfter the orphan tag');
        },
        {discrete: true},
      );
      const text = editor.read(() => $getRoot().getTextContent());
      expect(text).toContain('<div>');
      expect(text).toContain('After the orphan tag');
    });

    it('keeps unclosed inline raw HTML literal', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('before <u>oops and no close tag');
        },
        {discrete: true},
      );
      expect(editor.read(() => $getRoot().getTextContent())).toBe(
        'before <u>oops and no close tag',
      );
    });

    it('drops HTML comments like GitHub does', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('<div><!-- secret -->visible</div>');
        },
        {discrete: true},
      );
      const text = editor.read(() => $getRoot().getTextContent());
      expect(text).toBe('visible');
    });

    it('drops a comment-only html block', () => {
      expect(importExport('<!-- just a comment -->')).toBe('');
    });

    it('keeps an unclosed tag prefix as literal text', () => {
      // CommonMark opens an html block for a bare `<p` / `<details` — the
      // state the source pane passes through on every keystroke while
      // typing a tag. With no complete tag there is nothing for the DOM
      // rules to import; it must stay literal text (and must not recurse
      // through the embedded-Markdown segment parser — regression test for
      // a stack overflow).
      for (const source of ['<p', '<details', '<details x=']) {
        using editor = createEditor();
        editor.update(
          () => {
            $convertFromMarkdownString(source);
          },
          {discrete: true},
        );
        expect(editor.read(() => $getRoot().getTextContent())).toBe(source);
      }
    });

    it('imports every typing prefix of a details block without crashing', () => {
      // Simulates typing the construct into the example's Markdown source
      // pane, which re-imports the document on every keystroke.
      using editor = createEditor();
      const source =
        '<aside x="1">\nThe *summary* line\n</aside>\n\nBody *text*\n\n<details><summary>hi</summary>ok</details>';
      for (let i = 1; i <= source.length; i++) {
        editor.update(
          () => {
            $convertFromMarkdownString(source.slice(0, i));
          },
          {discrete: true},
        );
      }
      expect(editor.read(() => $getRoot().getTextContent())).toContain(
        'The summary line',
      );
    });
  });

  describe('sequence reassembly (tag balance)', () => {
    it('reassembles interleaved Markdown blocks in order', () => {
      expect(importExport('<div>\n\n*a*\n\nplain\n\n</div>')).toBe(
        '*a*\n\nplain',
      );
    });

    it('handles nested elements split across fragments', () => {
      expect(
        importExport(
          '<aside>\n\n*outer*\n\n<aside>\n\n*inner*\n\n</aside>\n\n</aside>',
        ),
      ).toBe('> *outer*\n>\n> > *inner*');
    });

    it('counts balance across a fragment with both open and close tags', () => {
      // The middle fragment closes one element and opens another.
      expect(importExport('<div>\n\n*a*\n\n</div><div>\n\n*b*\n\n</div>')).toBe(
        '*a*\n\n*b*',
      );
    });

    it('ignores void tags for balance', () => {
      // The <br> must not count as an unclosed element; the <div> still
      // reassembles, and the break imports through the core br rule.
      expect(importExport('<div>\na<br>b\n</div>')).toBe('a\nb');
    });

    it('reassembles sequences nested in Markdown containers', () => {
      expect(importExport('> <div>\n>\n> *inner*\n>\n> </div>')).toBe(
        '> *inner*',
      );
    });
  });

  describe('Markdown text embedded in the raw HTML', () => {
    it('parses Markdown on the tag line (the <summary> idiom)', () => {
      // No blank line: the text rides inside the raw html block itself.
      expect(importExport('<aside>\nquoted *text*\n</aside>')).toBe(
        '> quoted *text*',
      );
    });

    it('parses a fully inline construct', () => {
      expect(importExport('<div>inline *markdown*</div>')).toBe(
        'inline *markdown*',
      );
    });

    it('uses the registry grammar (GFM strikethrough)', () => {
      expect(importExport('<div>~~gone~~</div>')).toBe('~~gone~~');
    });

    it('preserves spacing around inline HTML neighbors', () => {
      expect(importExport('<div>x *y* <strong>z</strong> w</div>')).toBe(
        'x *y* **z** w',
      );
    });

    it('applies inline HTML formatting to its raw text', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString(
            '<div>a <strong>b *not md*</strong></div>',
          );
        },
        {discrete: true},
      );
      editor.read(() => {
        const bold = $collectTextNodes().filter(node => node.hasFormat('bold'));
        // Text inside an inline element is raw: the DOM rule's bold applies
        // and the Markdown syntax within it stays literal.
        expect(bold.map(node => node.getTextContent())).toEqual(['b *not md*']);
      });
    });

    it('never parses Markdown inside raw-content elements', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('<div><code>*not emphasis*</code></div>');
        },
        {discrete: true},
      );
      editor.read(() => {
        const [code] = $collectTextNodes();
        expect(code.getTextContent()).toBe('*not emphasis*');
        expect(code.hasFormat('code')).toBe(true);
        expect(code.hasFormat('italic')).toBe(false);
      });
    });

    it('collapses formatting whitespace at element boundaries', () => {
      // The newlines around the text are layout, not content.
      expect(importExport('<aside>\n   quoted\n</aside>')).toBe('> quoted');
    });
  });

  describe('inline raw HTML inside phrasing content', () => {
    it('imports an inline tag run through the DOM rules', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('before <u>inline</u> after');
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('before inline after');
        const underlined = $collectTextNodes().filter(node =>
          node.hasFormat('underline'),
        );
        expect(underlined.map(node => node.getTextContent())).toEqual([
          'inline',
        ]);
      });
    });

    it('imports a span with attributes as its content', () => {
      // The reported repro: attributes with no import semantics drop, but
      // the content must import instead of staying literal tags.
      for (const source of [
        '<span color="red">text</span>',
        '<span style="color: red">text</span>',
      ]) {
        using editor = createEditor();
        editor.update(
          () => {
            $convertFromMarkdownString(source);
          },
          {discrete: true},
        );
        expect(editor.read(() => $getRoot().getTextContent())).toBe('text');
      }
    });

    it('inherits an ImportTextStyle context onto the wrapped Markdown', () => {
      // A rule that contributes a text style for its subtree (the way an
      // app's styled-span rule would); the placeholder must apply it to the
      // pre-imported Markdown content like the core #text rule would have
      // applied it to raw text.
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('a <mark>colored *text*</mark> b');
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('a colored text b');
        const styled = $collectTextNodes().filter(node =>
          node.getStyle().includes('color: red'),
        );
        expect(styled.map(node => node.getTextContent())).toEqual([
          'colored ',
          'text',
        ]);
        expect(styled[1].hasFormat('italic')).toBe(true);
      });
    });

    it('composes html formatting with Markdown formatting', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('x <strong>*both*</strong> y');
        },
        {discrete: true},
      );
      editor.read(() => {
        const [both] = $collectTextNodes().filter(node =>
          node.hasFormat('bold'),
        );
        expect(both.getTextContent()).toBe('both');
        expect(both.hasFormat('italic')).toBe(true);
      });
    });

    it('imports an inline <br> as a line break', () => {
      expect(importExport('a<br>b')).toBe('a\nb');
    });

    it('drops an inline comment', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('a <!-- note --> b');
        },
        {discrete: true},
      );
      expect(editor.read(() => $getRoot().getTextContent())).not.toContain(
        'note',
      );
    });

    it('handles inline runs inside headings and emphasis', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('# Title <u>u</u>\n\n*em <u>deep</u>*');
        },
        {discrete: true},
      );
      editor.read(() => {
        const underlined = $collectTextNodes().filter(node =>
          node.hasFormat('underline'),
        );
        expect(underlined.map(node => node.getTextContent())).toEqual([
          'u',
          'deep',
        ]);
      });
    });

    it('imports an inline custom element with only a DOM rule registered', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('Press <kbd>Ctrl</kbd>+<kbd>C</kbd>.');
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('Press Ctrl+C.');
        const paragraph = $getRoot().getFirstChild();
        expect($isElementNode(paragraph)).toBe(true);
        const keys = ($isElementNode(paragraph) ? paragraph.getChildren() : [])
          .filter((node): node is KeyNode => node instanceof KeyNode)
          .map(node => node.getTextContent());
        expect(keys).toEqual(['Ctrl', 'C']);
      });
    });

    it('round-trips an inline custom element as phrasing', () => {
      const source = 'Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to copy.';
      expect(importExport(source)).toBe(source);
    });

    it('serializes Markdown formatting inside the inline wrapper', () => {
      using editor = createEditor();
      editor.update(
        () => {
          const key = $create(KeyNode).append(
            $createTextNode('Ctrl').toggleFormat('bold'),
          );
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('press '), key),
            );
        },
        {discrete: true},
      );
      const out = editor.read(() => $convertToMarkdownString());
      // Phrasing-level HTML is tokenized tag by tag, so the Markdown between
      // the raw tags parses on re-import: the encoding is a fixed point.
      expect(out).toBe('press <kbd>**Ctrl**</kbd>');
      expect(importExport(out)).toBe(out);
    });
  });

  describe('interaction with plain spans and templates', () => {
    it('does not treat ordinary spans/templates as placeholders', () => {
      // A span without the placeholder attribute imports through the core
      // inline rules; template content is inert and drops.
      expect(
        importExport('<div><span>plain</span><template>x</template></div>'),
      ).toBe('plain');
    });
  });

  describe('rawHtmlBlock export templates', () => {
    it('round-trips a phrasing template verbatim', () => {
      // The <summary> shape: Markdown phrasing embedded on the tag line.
      const source = '<aside>\nquoted *text*\n</aside>';
      expect(importExport(source, true)).toBe(source);
    });

    it('serializes flow blocks with blank-line joins', () => {
      const out = importExport(
        '<aside>\ntitle *line*\n\nbody **bold**\n\n- one\n- two\n\n</aside>',
        true,
      );
      expect(out).toBe(
        '<aside>\ntitle *line*\n\nbody **bold**\n\n- one\n- two\n</aside>',
      );
      // The serialized form is a fixed point of the round trip.
      expect(importExport(out, true)).toBe(out);
    });

    it('escapes the embedded Markdown edges', () => {
      // Unescaped, the "-" at line start would re-parse as a list marker.
      const source = '<aside>\n\\- not a list\n</aside>';
      expect(importExport(source, true)).toBe(source);
    });
  });

  describe('$exportViaDOM', () => {
    it('derives the Markdown encoding from the exportDOM shell', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString(
            '<x-callout open>\n<header>\nThe *title* line\n</header>\n\nBody **bold**\n\n- one\n- two\n\n</x-callout>',
          );
        },
        {discrete: true},
      );
      editor.read(() => {
        const callout = $getRoot().getFirstChild();
        expect(callout).toBeInstanceOf(CalloutNode);
        const title = $getSlot(callout as CalloutNode, 'title');
        expect(title?.getTextContent()).toBe('The title line');
      });
      // The custom element's tags stand alone on their lines (CommonMark's
      // condition 7 requires it for unknown tag names), so the output
      // re-imports; a known name like <details> stays compact.
      expect(editor.read(() => $convertToMarkdownString())).toBe(
        '<x-callout open>\n<header>\nThe *title* line\n</header>\n\nBody **bold**\n\n- one\n- two\n\n</x-callout>',
      );
    });

    it('is a fixed point of the round trip', () => {
      const out = importExport(
        '<x-callout open>\n<header>t</header>\n\nbody *text*\n\n</x-callout>',
      );
      expect(importExport(out)).toBe(out);
    });

    it('follows the $getChildNodes override of the exportDOM shell', () => {
      const out = importExport(
        '<x-redacted>\n\nkeep *this*\n\ndrop this\n\n</x-redacted>',
      );
      expect(out).toContain('keep *this*');
      expect(out).not.toContain('drop this');
      expect(importExport(out)).toBe(out);
    });

    it('normalizes boolean attributes and strips the slot markers', () => {
      const out = importExport(
        '<x-callout open>\n<header>t</header>\n\nb\n\n</x-callout>',
      );
      expect(out).toContain('<x-callout open>\n<header>');
      expect(out).not.toContain('=""');
      expect(out).not.toContain('data-lexical-slot');
    });

    it('sets RenderContextMarkdownExport so exportDOM can diverge', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString(
            '<x-callout open>\n<header>t</header>\n\nb\n\n</x-callout>',
          );
        },
        {discrete: true},
      );
      // The HTML clipboard export keeps the clipboard-only attribute...
      expect(editor.read(() => $generateHtmlFromNodes(editor))).toContain(
        'data-clipboard-only',
      );
      // ...and the Markdown export sees the divergent (clean) shell.
      expect(editor.read(() => $convertToMarkdownString())).not.toContain(
        'data-clipboard-only',
      );
    });
  });

  describe('ImportContextMarkdown', () => {
    it('distinguishes Markdown import from a direct DOM import', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('<div><cite></cite></div>');
        },
        {discrete: true},
      );
      expect(editor.read(() => $getRoot().getTextContent())).toBe('FROM-MD');
      editor.update(
        () => {
          const dom = new DOMParser().parseFromString(
            '<cite></cite>',
            'text/html',
          );
          const [imported] = $generateNodesFromDOMViaExtension(dom);
          expect(imported.getTextContent()).toBe('FROM-HTML');
        },
        {discrete: true},
      );
    });

    it('context layered by an mdast handler reaches DOM rules in raw HTML', () => {
      // The full nesting story: an mdast import handler layers a state for
      // its subtree ($withImportContext, the same technique DOM rules use),
      // and a DOM rule running for raw HTML *inside that subtree* reads it —
      // the DOM session chains to the ambient import context.
      const bridgeProbe = createImportState('bridgeProbe', () => 'default');
      const ProbeRule = defineImportRule({
        $import: ctx => [$createTextNode(`saw:${ctx.get(bridgeProbe)}`)],
        match: sel.tag('cite'),
        name: 'test/cite-bridge-probe',
      });
      using editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            MdastCommonMarkExtension,
            MdastExtension,
            MdastHtmlExtension,
            configExtension(DOMImportExtension, {rules: [ProbeRule]}),
            configExtension(MdastExtension, {
              importRules: [
                {
                  $import: (node, ctx) =>
                    $withImportContext([
                      contextValue(bridgeProbe, 'from-emphasis'),
                    ])(() => ctx.importChildren(node)),
                  type: 'emphasis',
                },
              ],
            }),
          ],
          name: '[bridge-probe]',
        }),
      );
      editor.update(
        () => {
          $convertFromMarkdownString('*a <cite></cite>* b <cite></cite>');
        },
        {discrete: true},
      );
      // Inside the emphasis subtree the DOM rule sees the layered value;
      // the sibling outside it sees the default.
      expect(editor.read(() => $getRoot().getTextContent())).toBe(
        'a saw:from-emphasis b saw:default',
      );
    });
  });

  it('writes a block raw HTML imports as in a cell after the table', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastCommonMarkExtension,
          MdastExtension,
          MdastHtmlExtension,
          MdastTableExtension,
        ],
        name: '[root]',
      }),
    );
    editor.update(() => $convertFromMarkdownString('| a |\n| - |\n| <hr> |'), {
      discrete: true,
    });
    editor.read(() => {
      expect($convertToMarkdownString()).toBe('| a |\n| - |\n|   |\n\n***');
    });
  });

  it('writes raw HTML embedding Markdown in a cell after the table', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastCommonMarkExtension,
          MdastExtension,
          MdastHtmlExtension,
          MdastTableExtension,
          configExtension(MdastExtension, {
            exportRules: [
              {
                $export: () => [rawHtmlBlock('<hr class="x">')],
                type: HorizontalRuleNode,
              },
            ],
          }),
        ],
        name: '[root]',
      }),
    );
    editor.update(
      () => {
        $convertFromMarkdownString('| a |\n| - |\n| 1 |');
        const table = $assertNodeType(
          $getRoot().getFirstChildOrThrow(),
          $isElementNode,
        );
        const row = $assertNodeType(
          table.getLastChildOrThrow(),
          $isElementNode,
        );
        const cell = $assertNodeType(
          row.getFirstChildOrThrow(),
          $isElementNode,
        );
        cell.append($createHorizontalRuleNode());
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertToMarkdownString()).toBe(
        '| a |\n| - |\n| 1 |\n\n<hr class="x">',
      );
    });
  });

  it('writes raw HTML embedding Markdown in a cell paragraph after the table', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastCommonMarkExtension,
          MdastExtension,
          MdastHtmlExtension,
          MdastTableExtension,
          configExtension(MdastExtension, {
            exportRules: [
              {
                $export: () => [rawHtmlBlock('<hr class="x">')],
                type: HorizontalRuleNode,
              },
            ],
          }),
        ],
        name: '[root]',
      }),
    );
    editor.update(
      () => {
        $convertFromMarkdownString('| a |\n| - |\n| 1 |');
        const table = $assertNodeType(
          $getRoot().getFirstChildOrThrow(),
          $isElementNode,
        );
        const row = $assertNodeType(
          table.getLastChildOrThrow(),
          $isElementNode,
        );
        const cell = $assertNodeType(
          row.getFirstChildOrThrow(),
          $isElementNode,
        );
        $assertNodeType(cell.getFirstChildOrThrow(), $isElementNode).append(
          $createHorizontalRuleNode(),
          $createTextNode('2'),
        );
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertToMarkdownString()).toBe(
        '| a      |\n| ------ |\n| 1<br>2 |\n\n<hr class="x">',
      );
    });
  });

  it('keeps a block raw HTML imports as in its aligned cell paragraph', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastCommonMarkExtension,
          MdastExtension,
          MdastHtmlExtension,
          MdastTableExtension,
        ],
        name: '[root]',
      }),
    );
    editor.update(
      () => $convertFromMarkdownString('| <hr> | b |\n| :-: | - |\n| x | y |'),
      {discrete: true},
    );
    editor.read(() => {
      expect($convertToMarkdownString()).toBe(
        '|     | b |\n| :-: | - |\n|  x  | y |\n\n***',
      );
    });
  });

  it('reads the pipes in raw HTML in a cell of a tree parsed with the editor’s grammar', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastCommonMarkExtension,
          MdastExtension,
          MdastHtmlExtension,
          MdastTableExtension,
          LinkExtension,
        ],
        name: '[root]',
      }),
    );
    const markdown = '| a |\n| - |\n| <a href="x\\|y">q</a> |';
    const {registry} = getExtensionDependencyFromEditor(
      editor,
      MdastExtension,
    ).output;
    const tree = fromMarkdown(markdown, {
      extensions: registry.micromarkExtensions,
      mdastExtensions: registry.mdastExtensions,
    });
    for (const $convert of [
      () => $convertFromMarkdownString(markdown),
      () => $convertFromMdast(tree),
    ]) {
      editor.update($convert, {discrete: true});
      editor.read(() => {
        expect($convertToMarkdownString()).toBe(
          '| a         |\n| --------- |\n| [q](x\\|y) |',
        );
      });
    }
  });

  it('keeps the inline content of a block without a rule in its cell', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastCommonMarkExtension,
          MdastExtension,
          MdastTableExtension,
        ],
        name: '[root]',
        nodes: [CalloutNode],
      }),
    );
    editor.update(
      () => {
        $convertFromMarkdownString('# T\n\n| a |\n| - |\n| 1 |\n\nend');
        const table = $assertNodeType(
          $getRoot().getChildAtIndex(1),
          $isElementNode,
        );
        const row = $assertNodeType(
          table.getLastChildOrThrow(),
          $isElementNode,
        );
        const cell = $assertNodeType(
          row.getFirstChildOrThrow(),
          $isElementNode,
        );
        cell
          .clear()
          .append(
            $create(CalloutNode).append(
              $createTextNode('a'),
              $createTextNode('b').toggleFormat('bold'),
              $createLineBreakNode(),
              $createTextNode('c'),
            ),
          );
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertToMarkdownString()).toBe(
        '# T\n\n| a           |\n| ----------- |\n| a**b**<br>c |\n\nend',
      );
    });
  });

  it('writes a block in a cell as its export rule does', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastExtension,
          MdastTableExtension,
          configExtension(MdastExtension, {
            exportRules: [
              {
                // The rule writes the title slot, then the body.
                $export: (node, ctx) => [
                  {
                    children: ctx.exportInline(
                      $assertNodeType($getSlot(node, 'title'), $isElementNode),
                    ),
                    type: 'paragraph',
                  },
                  ...ctx.exportBlocks($assertNodeType(node, $isElementNode)),
                ],
                type: 'x-callout',
              },
            ],
          }),
        ],
        name: '[root]',
        nodes: [CalloutNode],
      }),
    );
    editor.update(
      () => {
        $convertFromMarkdownString('| a |\n| - |\n| b |');
        const callout = $create(CalloutNode).append(
          $createParagraphNode().append($createTextNode('body')),
        );
        $setSlot(
          callout,
          'title',
          $createParagraphNode().append($createTextNode('title')),
        );
        const table = $assertNodeType(
          $getRoot().getFirstChildOrThrow(),
          $isElementNode,
        );
        const row = $assertNodeType(
          table.getFirstChildOrThrow(),
          $isElementNode,
        );
        const cell = $assertNodeType(
          row.getFirstChildOrThrow(),
          $isElementNode,
        );
        cell.clear().append(callout);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertToMarkdownString()).toBe(
        '| title<br>body |\n| ------------- |\n| b             |',
      );
    });
  });

  it('writes a selection in a named slot of a block in a cell as copied in the cell', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastExtension,
          MdastHtmlExtension,
          MdastTableExtension,
          configExtension(MdastExtension, {
            exportRules: [{$export: $exportViaDOM, type: 'x-callout'}],
          }),
        ],
        name: '[root]',
        nodes: [CalloutNode],
      }),
    );
    editor.update(
      () => {
        $convertFromMarkdownString('| a |\n| - |\n| b |');
        const title = $createTextNode('title');
        const callout = $create(CalloutNode).append($createParagraphNode());
        $setSlot(callout, 'title', $createParagraphNode().append(title));
        const table = $assertNodeType(
          $getRoot().getFirstChildOrThrow(),
          $isElementNode,
        );
        const row = $assertNodeType(
          table.getLastChildOrThrow(),
          $isElementNode,
        );
        const cell = $assertNodeType(
          row.getFirstChildOrThrow(),
          $isElementNode,
        );
        cell.append(callout);
        title.select(1, 4);
      },
      {discrete: true},
    );
    editor.read(() => {
      // As copied from a callout outside a table.
      expect($convertSelectionToMarkdownString()).toBe(
        '<x-callout open>\n<header>\nitl\n</header>\n\n\n\n</x-callout>',
      );
    });
  });

  it('keeps the column of a cell whose reached content goes after the table', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastExtension,
          MdastHtmlExtension,
          MdastTableExtension,
          configExtension(MdastExtension, {
            exportRules: [{$export: $exportViaDOM, type: 'x-callout'}],
          }),
        ],
        name: '[root]',
        nodes: [CalloutNode],
      }),
    );
    editor.update(
      () => {
        $convertFromMarkdownString('| a | b |\n| - | - |\n| x | 2 |\n\nend');
        const body = $createTextNode('body');
        const callout = $create(CalloutNode).append(
          $createParagraphNode().append(body),
        );
        $setSlot(callout, 'title', $createParagraphNode());
        const table = $assertNodeType(
          $getRoot().getFirstChildOrThrow(),
          $isElementNode,
        );
        const row = $assertNodeType(
          table.getLastChildOrThrow(),
          $isElementNode,
        );
        const cell = $assertNodeType(
          row.getFirstChildOrThrow(),
          $isElementNode,
        );
        cell.append(callout);
        const selection = body.select(1, 1);
        selection.focus.set(
          $getRoot().getLastChildOrThrow().getKey(),
          0,
          'element',
        );
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toMatch(
        /^\| {3}\| 2 \|\n\| - \| - \|\n\n<x-callout open>/,
      );
    });
  });
});
