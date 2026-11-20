/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {DOMImportExtension} from '@lexical/html';
import {
  $isHeadingNode,
  $isQuoteNode,
  RichTextExtension,
  ShadowRootQuoteRule,
} from '@lexical/rich-text';
import {
  $getEditor,
  $getRoot,
  $isParagraphNode,
  configExtension,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      // RichTextExtension registers its own import rules (and the
      // shared CoreImportExtension baseline) — no dedicated import
      // extension required.
      dependencies: [RichTextExtension],
      name: 'rich-text-host',
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

describe('RichTextImportExtension', () => {
  test.each([
    ['<h1>x</h1>', 'h1'],
    ['<h2>x</h2>', 'h2'],
    ['<h3>x</h3>', 'h3'],
    ['<h4>x</h4>', 'h4'],
    ['<h5>x</h5>', 'h5'],
    ['<h6>x</h6>', 'h6'],
  ])('%s imports as heading %s', (html, tag) => {
    using editor = buildEditor();
    importInto(editor, html);
    editor.read(() => {
      const node = $getRoot().getFirstChild();
      assert($isHeadingNode(node), 'expected HeadingNode');
      expect(node.getTag()).toBe(tag);
    });
  });

  test('blockquote imports as quote', () => {
    using editor = buildEditor();
    importInto(editor, '<blockquote>quoted</blockquote>');
    editor.read(() => {
      const node = $getRoot().getFirstChild();
      assert($isQuoteNode(node), 'expected QuoteNode');
      expect(node.getTextContent()).toBe('quoted');
    });
  });

  test('blockquote does not import as a shadow root by default', () => {
    using editor = buildEditor();
    importInto(editor, '<blockquote><p>a</p><p>b</p></blockquote>');
    editor.read(() => {
      const node = $getRoot().getFirstChild();
      assert($isQuoteNode(node), 'expected QuoteNode');
      expect(node.isShadowRoot()).toBe(false);
    });
  });

  test('ShadowRootQuoteRule imports blockquote as a shadow root quote', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          // Registered after RichTextExtension's own rules, so it takes
          // priority over the default blockquote rule.
          configExtension(DOMImportExtension, {rules: [ShadowRootQuoteRule]}),
        ],
        name: 'rich-text-shadow-root-quote-host',
      }),
    );
    importInto(editor, '<blockquote><p>a</p><p>b</p></blockquote>');
    editor.read(() => {
      const node = $getRoot().getFirstChild();
      assert($isQuoteNode(node), 'expected QuoteNode');
      expect(node.isShadowRoot()).toBe(true);
      const children = node.getChildren();
      expect(children.length).toBe(2);
      expect(children.every($isParagraphNode)).toBe(true);
      expect(children.map(child => child.getTextContent())).toEqual(['a', 'b']);
    });
  });

  test('ShadowRootQuoteRule wraps bare inline content in a paragraph', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          configExtension(DOMImportExtension, {rules: [ShadowRootQuoteRule]}),
        ],
        name: 'rich-text-shadow-root-quote-host',
      }),
    );
    importInto(editor, '<blockquote>quoted</blockquote>');
    editor.read(() => {
      const node = $getRoot().getFirstChild();
      assert($isQuoteNode(node), 'expected QuoteNode');
      expect(node.isShadowRoot()).toBe(true);
      const children = node.getChildren();
      expect(children.length).toBe(1);
      assert($isParagraphNode(children[0]), 'expected ParagraphNode');
      expect(children[0].getTextContent()).toBe('quoted');
    });
  });

  test('Google Docs title (26pt span) promoted to h1', () => {
    using editor = buildEditor();
    importInto(editor, '<p><span style="font-size:26pt">Title</span></p>');
    editor.read(() => {
      const node = $getRoot().getFirstChild();
      assert($isHeadingNode(node), 'expected HeadingNode');
      expect(node.getTag()).toBe('h1');
      expect(node.getTextContent()).toBe('Title');
    });
  });
});
