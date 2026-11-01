/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $isCodeHighlightNode,
  $isCodeNode,
  CodeExtension,
} from '@lexical/code-core';
import {buildEditorFromExtensions, configExtension} from '@lexical/extension';
import {
  $generateNodesFromDOMViaExtension,
  type AnyDOMImportRule,
  defineImportRule,
  DOMImportExtension,
  sel,
} from '@lexical/html';
import {LinkExtension} from '@lexical/link';
import {ListExtension} from '@lexical/list';
import {$createQuoteNode, RichTextExtension} from '@lexical/rich-text';
import {TableExtension} from '@lexical/table';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $isLineBreakNode,
  $isTabNode,
  DecoratorNode,
  defineExtension,
  type LexicalNode,
  ParagraphNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

class SemanticParagraphNode extends ParagraphNode {
  $config() {
    return this.config('semantic-paragraph', {extends: ParagraphNode});
  }

  getTextContent(): string {
    return `[${super.getTextContent()}]`;
  }

  getTextContentSize(): number {
    return this.getTextContent().length;
  }
}

class InlineSemanticParagraphNode extends SemanticParagraphNode {
  $config() {
    return this.config('inline-semantic-paragraph', {
      extends: SemanticParagraphNode,
    });
  }

  isInline(): boolean {
    return true;
  }
}

class TextDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('text-decorator', {extends: DecoratorNode});
  }

  createDOM(): HTMLElement {
    return document.createElement('div');
  }

  isInline(): boolean {
    return false;
  }

  getTextContent(): string {
    return '[attachment]';
  }
}

function buildEditor(
  rules: AnyDOMImportRule[] = [],
  replaceParagraphs = false,
) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        RichTextExtension,
        TableExtension,
        ListExtension,
        LinkExtension,
        CodeExtension,
        configExtension(DOMImportExtension, {rules}),
      ],
      name: '[code-content-import]',
      nodes: () => [
        SemanticParagraphNode,
        InlineSemanticParagraphNode,
        TextDecoratorNode,
        ...(replaceParagraphs
          ? [
              {
                replace: ParagraphNode,
                with: () => new SemanticParagraphNode(),
                withKlass: SemanticParagraphNode,
              },
            ]
          : []),
      ],
      theme: {tableScrollableWrapper: 'table-wrapper'},
    }),
  );
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    'text/html',
  );
}

function githubTable(contents: string): string {
  return `<table class="js-file-line-container">${contents}</table>`;
}

function $expectCodeContent(node: LexicalNode, text: string): void {
  assert($isCodeNode(node));
  expect.soft(node.getTextContent()).toBe(text);
  expect
    .soft(
      node
        .getChildren()
        .every(
          child =>
            $isCodeHighlightNode(child) ||
            $isTabNode(child) ||
            $isLineBreakNode(child),
        ),
    )
    .toBe(true);
  for (const child of node.getChildren()) {
    if ($isCodeHighlightNode(child)) {
      expect.soft(child.getTextContent()).not.toMatch(/[\r\n\t]/);
    }
  }
}

const CASES: {name: string; html: string; text: string}[] = [
  {
    html: '<pre><div>alpha</div><div>beta</div></pre>',
    name: 'PRE with two nonempty DIV lines',
    text: 'alpha\nbeta',
  },
  {
    html: '<pre><p><br></p></pre>',
    name: 'PRE with an explicitly empty paragraph',
    text: '',
  },
  {
    html: '<pre><p><br></p><p><br></p><p><br></p></pre>',
    name: 'PRE with consecutive empty paragraphs',
    text: '\n\n',
  },
  {
    html: '<pre><p><br></p><p>alpha</p></pre>',
    name: 'PRE with a leading empty paragraph',
    text: '\nalpha',
  },
  {
    html: '<pre><p>alpha</p><p><br></p><p>beta</p></pre>',
    name: 'PRE with an empty paragraph between lines',
    text: 'alpha\n\nbeta',
  },
  {
    html: '<pre><p>alpha</p><p><br></p></pre>',
    name: 'PRE with a trailing empty paragraph',
    text: 'alpha\n',
  },
  {
    html: '<pre>alpha<p>beta</p>gamma</pre>',
    name: 'PRE with mixed inline and block segments',
    text: 'alpha\nbeta\ngamma',
  },
  {
    html: '<pre><section><div>alpha</div><div>beta</div></section><p>gamma</p></pre>',
    name: 'PRE with nested transparent block wrappers',
    text: 'alpha\nbeta\ngamma',
  },
  {
    html: '<code><div>alpha<br></div><div>beta</div></code>',
    name: 'multiline CODE with DIV lines',
    text: 'alpha\nbeta',
  },
  {
    html: '<code><p>alpha</p><p><br></p><p>beta</p></code>',
    name: 'multiline CODE with an empty paragraph',
    text: 'alpha\n\nbeta',
  },
  {
    html: '<div style="font-family: monospace"><section>alpha</section><section>beta</section></div>',
    name: 'monospace DIV with SECTION lines',
    text: 'alpha\nbeta',
  },
  {
    html: '<div style="font-family: monospace"><p>alpha</p><p><br></p><p>beta</p></div>',
    name: 'monospace DIV with an empty paragraph',
    text: 'alpha\n\nbeta',
  },
  {
    html: githubTable(
      '<tr><td class="js-file-line"><div>alpha</div></td></tr>' +
        '<tr><td class="js-file-line"><div>beta</div></td></tr>',
    ),
    name: 'GitHub code table with DIV lines in separate rows',
    text: 'alpha\nbeta',
  },
  {
    html: githubTable(
      '<tr><td class="js-file-line"><p>alpha</p><p><br></p><p>beta</p></td></tr>',
    ),
    name: 'GitHub code table with an empty paragraph between lines',
    text: 'alpha\n\nbeta',
  },
  {
    html: githubTable('<tr><td class="js-file-line"><p><br></p></td></tr>'),
    name: 'GitHub code table with an explicitly empty paragraph',
    text: '',
  },
  {
    html: '<pre>\talpha\nbeta</pre>',
    name: 'PRE with flat text tabs and linebreaks stays unchanged',
    text: '\talpha\nbeta',
  },
  {
    html: '<pre>a<code>alpha\nbeta</code><p>after</p>b</pre>',
    name: 'nested multiline CODE alongside paragraph and inline text',
    text: 'a\nalpha\nbeta\nafter\nb',
  },
  {
    html: '<pre><table><tr><td>alpha</td><td>beta</td></tr></table><p>after</p></pre>',
    name: 'table text preserves its own cell separators',
    text: 'alpha\n\nbeta\nafter',
  },
  {
    html: '<pre><h2>heading</h2><p>body</p></pre>',
    name: 'heading followed by a paragraph',
    text: 'heading\nbody',
  },
  {
    html: '<pre><a href="https://example.com/">alpha</a><p>beta</p></pre>',
    name: 'link text followed by a paragraph',
    text: 'alpha\nbeta',
  },
  {
    html: '<pre><ul><li>alpha</li><li>beta</li></ul><p>after</p></pre>',
    name: 'list text preserves its own item separators',
    text: 'alpha\n\nbeta\nafter',
  },
  {
    html: '<pre>alpha<br>beta\tgamma<br><br>delta</pre>',
    name: 'hard linebreaks and tabs',
    text: 'alpha\nbeta\tgamma\n\ndelta',
  },
  {
    html: '<div style="font-family:monospace;white-space:pre"><div>\talpha</div><br><div>beta</div></div>',
    name: 'VS Code Chrome wrapper',
    text: '\talpha\n\nbeta',
  },
  {
    html: '<div style="font-family:monospace;white-space:pre">\talpha</div><br style="font-family:monospace;white-space:pre"><div style="font-family:monospace;white-space:pre">beta</div>',
    name: 'VS Code Safari sibling run',
    text: '\talpha\n\nbeta',
  },
  {
    html: '<div style="font-family:monospace"><div>alpha</div><div>beta</div></div>',
    name: 'plain monospace DIV with nested DIV lines',
    text: 'alpha\nbeta',
  },
];

describe('code import normalizes content to supported code children', () => {
  test.each(CASES)('$name', ({html, text}) => {
    using editor = buildEditor();
    editor.update(
      () => {
        const nodes = $generateNodesFromDOMViaExtension(parse(html));
        expect(nodes).toHaveLength(1);
        $expectCodeContent(nodes[0], text);
      },
      {discrete: true},
    );
  });

  test.each(['quote', 'semantic-paragraph', 'inline-semantic-paragraph'])(
    'preserves text semantics from a custom %s node',
    type => {
      using editor = buildEditor([
        defineImportRule({
          $import: () => {
            const custom = (
              type === 'quote'
                ? $createQuoteNode()
                : type === 'semantic-paragraph'
                  ? $create(SemanticParagraphNode)
                  : $create(InlineSemanticParagraphNode)
            ).append($createTextNode('kept'));
            return type === 'inline-semantic-paragraph'
              ? [$createTextNode('before'), custom, $createTextNode('after')]
              : [
                  custom,
                  $createParagraphNode().append($createTextNode('plain')),
                ];
          },
          match: sel.tag('div').classAll('custom-block'),
          name: 'custom-code-child',
        }),
      ]);
      editor.update(
        () => {
          const [node] = $generateNodesFromDOMViaExtension(
            parse('<pre><div class="custom-block">ignored</div></pre>'),
          );
          $expectCodeContent(
            node,
            type === 'quote'
              ? 'kept\nplain'
              : type === 'semantic-paragraph'
                ? '[kept]\nplain'
                : 'before[kept]after',
          );
        },
        {discrete: true},
      );
    },
  );

  test('uses configured paragraph replacements for their text semantics', () => {
    using editor = buildEditor([], true);
    editor.update(
      () => {
        const [node] = $generateNodesFromDOMViaExtension(
          parse('<pre><p>alpha</p><p><br></p><p>beta</p></pre>'),
        );
        $expectCodeContent(node, '[alpha]\n[]\n[beta]');
      },
      {discrete: true},
    );
  });

  test('normalizes raw CRLF and tabs returned by a custom importer', () => {
    using editor = buildEditor([
      defineImportRule({
        $import: () => [$createTextNode('alpha\r\n\tbeta')],
        match: sel.tag('span').classAll('custom-text'),
        name: 'custom-raw-code-text',
      }),
    ]);
    editor.update(
      () => {
        const [node] = $generateNodesFromDOMViaExtension(
          parse('<pre><span class="custom-text">ignored</span></pre>'),
        );
        $expectCodeContent(node, 'alpha\n\tbeta');
      },
      {discrete: true},
    );
  });

  test('uses a block decorator text fallback between inline runs', () => {
    using editor = buildEditor([
      defineImportRule({
        $import: () => [$create(TextDecoratorNode)],
        match: sel.tag('span').classAll('attachment'),
        name: 'custom-code-attachment',
      }),
    ]);
    editor.update(
      () => {
        const [node] = $generateNodesFromDOMViaExtension(
          parse('<pre>before<span class="attachment"></span>after</pre>'),
        );
        $expectCodeContent(node, 'before\n[attachment]\nafter');
      },
      {discrete: true},
    );
  });
});
