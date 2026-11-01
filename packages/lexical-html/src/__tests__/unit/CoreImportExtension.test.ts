/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  configExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  contextValue,
  CoreImportExtension,
  createImportState,
  defaultIsInline,
  defaultPreservesWhitespace,
  defineImportRule,
  DOMImportExtension,
  ImportWhitespaceConfig,
  sel,
} from '@lexical/html';
import {
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  defineExtension,
  isHTMLElement,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [CoreImportExtension],
      name: 'core-host',
    }),
  );
}

function $generate(html: string): LexicalNode[] {
  const editor = $getEditor();
  const dep = getExtensionDependencyFromEditor(editor, DOMImportExtension);
  const dom = new DOMParser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    'text/html',
  );
  return dep.output.$generateNodesFromDOM(dom);
}

function importInto(editor: LexicalEditor, html: string): void {
  editor.update(
    () => {
      const nodes = $generate(html);
      $getRoot()
        .clear()
        .append(...nodes);
    },
    {discrete: true},
  );
}

function $findTextByContent(content: string) {
  const all = $getRoot().getAllTextNodes();
  const t = all.find(n => n.getTextContent() === content);
  assert(
    t !== undefined,
    `No TextNode with text ${JSON.stringify(content)} found`,
  );
  return t;
}

describe('CoreImportExtension', () => {
  test('paragraph + text', () => {
    using editor = buildEditor();
    importInto(editor, '<p>Hello world</p>');
    editor.read(() => {
      const para = $getRoot().getFirstChild();
      assert($isParagraphNode(para), 'expected paragraph');
      expect(para.getTextContent()).toBe('Hello world');
    });
  });

  test('inline format tags propagate via ImportTextFormat', () => {
    using editor = buildEditor();
    importInto(editor, '<p>a <strong>b <em>c</em></strong> <code>d</code></p>');
    editor.read(() => {
      expect($findTextByContent('a ').getFormat()).toBe(0);
      expect($findTextByContent('b ').hasFormat('bold')).toBe(true);
      expect($findTextByContent('b ').hasFormat('italic')).toBe(false);
      expect($findTextByContent('c').hasFormat('bold')).toBe(true);
      expect($findTextByContent('c').hasFormat('italic')).toBe(true);
      expect($findTextByContent('d').hasFormat('code')).toBe(true);
    });
  });

  test('span with Google-Docs-style CSS pushes formats into context', () => {
    using editor = buildEditor();
    importInto(
      editor,
      '<p><span style="font-weight:700">bold</span> <span style="font-style:italic">italic</span> <span style="text-decoration:underline line-through">both</span></p>',
    );
    editor.read(() => {
      expect($findTextByContent('bold').hasFormat('bold')).toBe(true);
      expect($findTextByContent('italic').hasFormat('italic')).toBe(true);
      expect($findTextByContent('both').hasFormat('underline')).toBe(true);
      expect($findTextByContent('both').hasFormat('strikethrough')).toBe(true);
    });
  });

  test('<b style="font-weight:normal"> (Google Docs wrapper) does NOT add bold', () => {
    using editor = buildEditor();
    importInto(editor, '<b style="font-weight:normal"><p>plain</p></b>');
    editor.read(() => {
      const text = $findTextByContent('plain');
      expect(text.hasFormat('bold')).toBe(false);
    });
  });

  test('<pre> preserves whitespace, splits on \\n into LineBreakNode', () => {
    using editor = buildEditor();
    importInto(editor, '<pre>line1\nline2</pre>');
    editor.read(() => {
      // <pre> isn't matched by any specific rule so the framework hoists its
      // children. Result: text "line1", linebreak, text "line2" wrapped by
      // RootSchema into a paragraph.
      const para = $getRoot().getFirstChild();
      assert($isParagraphNode(para), 'expected paragraph');
      const children = para.getChildren();
      expect(children).toHaveLength(3);
      assert($isTextNode(children[0]), 'expected text');
      expect(children[0].getTextContent()).toBe('line1');
      assert($isLineBreakNode(children[1]), 'expected linebreak');
      assert($isTextNode(children[2]), 'expected text');
      expect(children[2].getTextContent()).toBe('line2');
    });
  });

  test('whitespace collapsing matches legacy behavior', () => {
    using editor = buildEditor();
    importInto(editor, '<p>  hello   world  </p>');
    editor.read(() => {
      const para = $getRoot().getFirstChild();
      assert($isParagraphNode(para), 'expected paragraph');
      expect(para.getTextContent()).toBe('hello world');
    });
  });

  test('<br> creates a LineBreakNode', () => {
    using editor = buildEditor();
    importInto(editor, '<p>a<br>b</p>');
    editor.read(() => {
      const para = $getRoot().getFirstChild();
      assert($isParagraphNode(para), 'expected paragraph');
      const children = para.getChildren();
      expect(children).toHaveLength(3);
      assert($isLineBreakNode(children[1]), 'expected linebreak');
    });
  });

  test('paragraph align attribute fallback', () => {
    using editor = buildEditor();
    importInto(editor, '<p align="center">center</p>');
    editor.read(() => {
      const p = $getRoot().getFirstChild();
      assert($isParagraphNode(p), 'expected paragraph');
      expect(p.getFormatType()).toBe('center');
    });
  });

  test('inline style with font-weight:normal clears inherited bold', () => {
    using editor = buildEditor();
    importInto(
      editor,
      '<p><strong>bold <span style="font-weight: normal">plain</span> bold</strong></p>',
    );
    editor.read(() => {
      const all = $getRoot().getAllTextNodes();
      const bold1 = all.find(t => t.getTextContent() === 'bold ');
      const plain = all.find(t => t.getTextContent() === 'plain');
      const bold2 = all.find(t => t.getTextContent() === ' bold');
      assert(
        bold1 !== undefined && plain !== undefined && bold2 !== undefined,
        `expected text nodes; got: ${all
          .map(
            n => `${JSON.stringify(n.getTextContent())}/fmt=${n.getFormat()}`,
          )
          .join(', ')}`,
      );
      expect(bold1.hasFormat('bold')).toBe(true);
      expect(plain.hasFormat('bold')).toBe(false);
      expect(bold2.hasFormat('bold')).toBe(true);
    });
  });

  test('sub/sup mutex: <sub><sup>x</sup></sub> ⇒ superscript only', () => {
    using editor = buildEditor();
    importInto(editor, '<p><sub><sup>x</sup></sub></p>');
    editor.read(() => {
      const text = $getRoot().getAllTextNodes()[0];
      expect(text.hasFormat('superscript')).toBe(true);
      expect(text.hasFormat('subscript')).toBe(false);
    });
  });

  test('text-decoration:none clears inherited underline/strikethrough', () => {
    using editor = buildEditor();
    importInto(
      editor,
      '<p><u><s>both <span style="text-decoration: none">neither</span></s></u></p>',
    );
    editor.read(() => {
      const all = $getRoot().getAllTextNodes();
      const both = all.find(t => t.getTextContent() === 'both ');
      const neither = all.find(t => t.getTextContent() === 'neither');
      assert(
        both !== undefined && neither !== undefined,
        'expected text nodes',
      );
      expect(both.hasFormat('underline')).toBe(true);
      expect(both.hasFormat('strikethrough')).toBe(true);
      expect(neither.hasFormat('underline')).toBe(false);
      expect(neither.hasFormat('strikethrough')).toBe(false);
    });
  });

  test('whitespace config can override what counts as preserving whitespace', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          CoreImportExtension,
          configExtension(DOMImportExtension, {
            contextDefaults: [
              contextValue(ImportWhitespaceConfig, {
                isInline: defaultIsInline,
                preservesWhitespace: node =>
                  defaultPreservesWhitespace(node) ||
                  (isHTMLElement(node) && node.classList.contains('keep-ws')),
              }),
            ],
          }),
        ],
        name: 'host',
      }),
    );
    importInto(editor, '<div class="keep-ws">a   b\nc</div>');
    editor.read(() => {
      const para = $getRoot().getFirstChild();
      assert($isParagraphNode(para), 'expected paragraph');
      const children = para.getChildren();
      // Whitespace preserved: 'a   b', LineBreak, 'c'
      assert($isTextNode(children[0]), 'expected text');
      expect(children[0].getTextContent()).toBe('a   b');
      assert($isLineBreakNode(children[1]), 'expected linebreak');
      assert($isTextNode(children[2]), 'expected text');
      expect(children[2].getTextContent()).toBe('c');
    });
  });

  test('whitespace config can override what counts as an inline sibling', () => {
    // With a custom isInline that treats <hr> as inline, the trailing space
    // before <hr> is preserved instead of being trimmed against a block.
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          CoreImportExtension,
          configExtension(DOMImportExtension, {
            contextDefaults: [
              contextValue(ImportWhitespaceConfig, {
                isInline: node =>
                  (isHTMLElement(node) && node.nodeName === 'HR') ||
                  defaultIsInline(node),
                preservesWhitespace: defaultPreservesWhitespace,
              }),
            ],
          }),
        ],
        name: 'host',
      }),
    );
    importInto(editor, '<p>a <hr>b</p>');
    editor.read(() => {
      const all = $getRoot().getAllTextNodes();
      // With <hr> treated as inline, the trailing space after "a" is kept.
      const a = all.find(t => t.getTextContent() === 'a ');
      assert(a !== undefined, 'expected "a " (with trailing space)');
    });
  });

  test('session can be written by an early rule and read by a later one', () => {
    const StyleSheets = createImportState<string[]>(
      'collected-styles',
      () => [],
    );
    const CollectedStylesRule = defineImportRule({
      $import: (ctx, el) => {
        ctx.session.update(StyleSheets, prev => [
          ...prev,
          el.textContent || '',
        ]);
        return [];
      },
      match: sel.tag('style'),
      name: 'test/collect-style',
    });
    const StyleAwareRule = defineImportRule({
      $import: (ctx, el) => {
        const sheets = ctx.session.get(StyleSheets);
        const p = $createParagraphNode();
        p.append(
          $createTextNode(`[saw ${sheets.length} sheets] ${el.textContent}`),
        );
        return [p];
      },
      match: sel.tag('article'),
      name: 'test/style-aware',
    });
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          CoreImportExtension,
          configExtension(DOMImportExtension, {
            rules: [CollectedStylesRule, StyleAwareRule],
          }),
        ],
        name: 'host',
      }),
    );
    importInto(
      editor,
      '<style>.a{}</style><style>.b{}</style><article>body</article>',
    );
    editor.read(() => {
      const text = $getRoot().getAllTextNodes()[0];
      expect(text.getTextContent()).toBe('[saw 2 sheets] body');
    });
  });

  test('<style> can be overridden by an app-specific rule (default is now a rule, not a framework skip)', () => {
    let captured: string | null = null;
    const StyleCaptureRule = defineImportRule({
      $import: (_ctx, el) => {
        captured = el.textContent;
        return [];
      },
      match: sel.tag('style'),
      name: 'test/style-capture',
    });
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          CoreImportExtension,
          configExtension(DOMImportExtension, {
            rules: [StyleCaptureRule],
          }),
        ],
        name: 'host',
      }),
    );
    importInto(editor, '<style>.foo{color:red}</style><p>x</p>');
    expect(captured).toBe('.foo{color:red}');
    editor.read(() => {
      const para = $getRoot().getFirstChild();
      assert($isParagraphNode(para), 'expected paragraph');
      expect(para.getTextContent()).toBe('x');
    });
  });

  test('unconverted block elements (not just <div>) preserve block boundaries', () => {
    using editor = buildEditor();
    // The legacy $generateNodesFromDOM treated every isBlockDomNode the
    // same; sibling block containers must not collapse into one paragraph.
    importInto(editor, '<section>a</section><article>b</article>');
    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children.map(n => n.getTextContent())).toEqual(['a', 'b']);
      expect(children.every($isParagraphNode)).toBe(true);
    });
  });

  test('text-align on a non-<div> block element is propagated to its paragraph', () => {
    using editor = buildEditor();
    importInto(editor, '<header style="text-align: right">x</header>');
    editor.read(() => {
      const para = $getRoot().getFirstChild();
      assert($isParagraphNode(para), 'expected paragraph');
      expect(para.getFormatType()).toBe('right');
    });
  });
});
