/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$insertDataTransferForRichText} from '@lexical/clipboard';
import {CodeExtension} from '@lexical/code-core';
import {buildEditorFromExtensions} from '@lexical/extension';
import {$generateNodesFromDOM} from '@lexical/html';
import {LinkExtension} from '@lexical/link';
import {ListExtension} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {TableExtension} from '@lexical/table';
import {JSDOM} from 'jsdom';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        CodeExtension,
        LinkExtension,
        ListExtension,
        TableExtension,
      ],
      name: '[empty-block-import]',
      theme: {tableScrollableWrapper: 'table-scroll-wrapper'},
    }),
  );
}

function parse(html: string): Document {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window
    .document;
}

describe('$generateNodesFromDOM preserves empty blocks', () => {
  test.each([
    '<div>before</div><div><br></div><div>after</div>',
    '<div><div>before</div><div><br></div><div>after</div></div>',
    '<div>before</div><div>\n <br>\n </div><div>after</div>',
    '<section>before</section><section><br></section><section>after</section>',
    '<div style="white-space: pre-wrap">before</div><div style="white-space: pre-wrap"><br></div><div style="white-space: pre-wrap">after</div>',
  ])('preserves an empty block in %s', html => {
    using editor = buildEditor();
    editor.update(
      () => {
        const nodes = $generateNodesFromDOM(editor, parse(html));
        expect(nodes.map(node => node.getTextContent())).toEqual([
          'before',
          '',
          'after',
        ]);
        assert($isElementNode(nodes[1]));
        expect(nodes[1].getChildrenSize()).toBe(0);
      },
      {discrete: true},
    );
  });

  test('preserves consecutive blank lines and their alignment', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const nodes = $generateNodesFromDOM(
          editor,
          parse('<div><br></div><div style="text-align: right"><br></div>'),
        );
        expect(nodes).toHaveLength(2);
        assert($isElementNode(nodes[1]));
        expect(nodes[1].getTextContent()).toBe('');
        expect(nodes[1].getFormatType()).toBe('right');
      },
      {discrete: true},
    );
  });

  test.each([
    ['<p><br></p>', ['']],
    ['<pre><br></pre>', ['']],
    ['<p>text<br></p>', ['text']],
    ['<div>text<br></div>', ['text']],
    ['<div>text<br class="Apple-interchange-newline"></div>', ['text']],
    ['<div>text<br><br></div>', ['text\n']],
    ['<div></div>', []],
    ['<div> \n </div>', []],
    ['<div><!-- comment --></div>', []],
    ['<div><script>ignored</script></div>', []],
    ['<ul><li><br></li></ul>', ['']],
    ['<table><tr><td><br></td></tr></table>', ['']],
  ])('keeps existing line break behavior for %s', (html, expected) => {
    using editor = buildEditor();
    editor.update(
      () => {
        expect(
          $generateNodesFromDOM(editor, parse(html)).map(node =>
            node.getTextContent(),
          ),
        ).toEqual(expected);
      },
      {discrete: true},
    );
  });

  test.each([
    ['<ul><li>before<div><br></div>after</li></ul>', 'before\n\nafter'],
    ['<ul><li>before<div><br></div></li></ul>', 'before\n'],
    ['<ul><li><div><br></div>after</li></ul>', '\nafter'],
    ['<blockquote>before<div><br></div>after</blockquote>', 'before\n\nafter'],
  ])('preserves an empty block within %s', (html, text) => {
    using editor = buildEditor();
    editor.update(
      () => {
        const [node] = $generateNodesFromDOM(editor, parse(html));
        expect(node.getTextContent()).toBe(text);
      },
      {discrete: true},
    );
  });

  test.each([
    '<pre><div><br></div></pre>',
    '<code><div><br></div></code>',
    '<div style="font-family: monospace"><section><br></section></div>',
    '<table class="js-file-line-container"><tr><td class="js-file-line"><div><br></div></td></tr></table>',
  ])('does not add a paragraph inside a code node imported from %s', html => {
    using editor = buildEditor();
    editor.update(
      () => {
        const [node] = $generateNodesFromDOM(editor, parse(html));
        assert($isElementNode(node));
        expect(node.getType()).toBe('code');
        expect(node.getChildrenSize()).toBe(0);
      },
      {discrete: true},
    );
  });
});

test('respects a legacy conversion that removes the block contents', () => {
  using editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension],
      html: {
        import: {
          div: () => ({
            conversion: () => ({after: () => [], node: null}),
            priority: 4,
          }),
        },
      },
      name: '[drop-empty-block]',
    }),
  );
  editor.update(
    () => {
      expect($generateNodesFromDOM(editor, parse('<div><br></div>'))).toEqual(
        [],
      );
    },
    {discrete: true},
  );
});

test('does not restore a converted node removed by forChild', () => {
  using editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension],
      html: {
        import: {
          div: () => ({
            conversion: () => ({forChild: () => null, node: null}),
            priority: 4,
          }),
        },
      },
      name: '[drop-converted-child]',
    }),
  );
  editor.update(
    () => {
      expect(
        $generateNodesFromDOM(editor, parse('<div><p><br></p></div>')),
      ).toEqual([]);
    },
    {discrete: true},
  );
});

describe('Gmail clipboard paste', () => {
  test('preserves empty quoted lines and text formatting (#4830)', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().clear().append(paragraph);
        paragraph.select();
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        const dataTransfer = new DataTransfer();
        dataTransfer.setData(
          'text/html',
          '<div><b>before</b></div>' +
            '<div class="gmail_quote"><div><br></div><div><br></div>' +
            '<div><i>after</i></div></div>',
        );
        $insertDataTransferForRichText(dataTransfer, selection, editor);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect(
        $getRoot()
          .getChildren()
          .map(node => node.getTextContent()),
      ).toEqual(['before', '', '', 'after']);
      const [before, after] = $getRoot().getAllTextNodes();
      expect(before.hasFormat('bold')).toBe(true);
      expect(after.hasFormat('italic')).toBe(true);
    });
  });
});
