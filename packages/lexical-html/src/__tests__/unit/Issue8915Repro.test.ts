/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOM,
  $generateNodesFromDOMViaExtension,
} from '@lexical/html';
import {RichTextExtension} from '@lexical/rich-text';
import {JSDOM} from 'jsdom';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  type LexicalEditor,
  type LexicalNode,
  type TextFormatType,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

// Reproduction for https://github.com/facebook/lexical/issues/8915
//
// TextNode.exportDOM writes `text-transform: uppercase|lowercase|capitalize`
// for the three capitalization formats, but no importer read it back, so the
// format was dropped on every HTML round trip.

const CAPITALIZATION_FORMATS: TextFormatType[] = [
  'lowercase',
  'uppercase',
  'capitalize',
];

const extension = defineExtension({
  $initialEditorState: null,
  dependencies: [RichTextExtension],
  name: '[issue-8915]',
});

function buildEditor() {
  return buildEditorFromExtensions(extension);
}

function $seed(format: TextFormatType) {
  $getRoot()
    .clear()
    .append(
      $createParagraphNode().append(
        $createTextNode('Hello').toggleFormat(format),
      ),
    );
}

function exportHtml(editor: LexicalEditor): string {
  return editor.read(() => $generateHtmlFromNodes(editor, null));
}

function parse(html: string): Document {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window
    .document;
}

function firstTextNode(nodes: LexicalNode[]): LexicalNode {
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if ($isTextNode(node)) {
      return node;
    }
    const children = (node as {getChildren?: () => LexicalNode[]}).getChildren;
    if (typeof children === 'function') {
      stack.unshift(...children.call(node));
    }
  }
  assert(false, 'expected a TextNode');
}

describe('Issue #8915: text-transform survives an HTML round trip', () => {
  test.each(CAPITALIZATION_FORMATS)(
    'exportDOM writes text-transform for %s',
    format => {
      using editor = buildEditor();
      editor.update(() => $seed(format), {discrete: true});
      expect(exportHtml(editor)).toContain(`text-transform: ${format}`);
    },
  );

  test.each(CAPITALIZATION_FORMATS)(
    '$generateNodesFromDOM restores %s',
    format => {
      using editor = buildEditor();
      editor.update(() => $seed(format), {discrete: true});
      const html = exportHtml(editor);

      editor.update(
        () => {
          const textNode = firstTextNode(
            $generateNodesFromDOM(editor, parse(html)),
          );
          assert($isTextNode(textNode), 'expected a TextNode');
          expect(textNode.hasFormat(format)).toBe(true);
        },
        {discrete: true},
      );
    },
  );

  test.each(CAPITALIZATION_FORMATS)(
    '$generateNodesFromDOMViaExtension restores %s',
    format => {
      using editor = buildEditor();
      editor.update(() => $seed(format), {discrete: true});
      const html = exportHtml(editor);

      editor.update(
        () => {
          const textNode = firstTextNode(
            $generateNodesFromDOMViaExtension(parse(html)),
          );
          assert($isTextNode(textNode), 'expected a TextNode');
          expect(textNode.hasFormat(format)).toBe(true);
        },
        {discrete: true},
      );
    },
  );

  test('text-transform: none clears an inherited capitalization format', () => {
    // The clear half of the rule, on the @lexical/html import path — the
    // same "explicit non-decorating value clears the bit" behaviour that
    // `font-weight: normal` and `vertical-align: baseline` already have.
    // The legacy `$generateNodesFromDOM` path has no ancestor format
    // inheritance to clear, so only the extension path exercises this.
    using editor = buildEditor();
    editor.update(
      () => {
        const textNode = firstTextNode(
          $generateNodesFromDOMViaExtension(
            parse(
              '<p><span style="text-transform: uppercase">' +
                '<span style="text-transform: none">Hello</span>' +
                '</span></p>',
            ),
          ),
        );
        assert($isTextNode(textNode), 'expected a TextNode');
        expect(textNode.hasFormat('uppercase')).toBe(false);
      },
      {discrete: true},
    );
  });

  test('an unrelated text-transform: none does not clear other formats', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const nodes = $generateNodesFromDOM(
          editor,
          parse(
            '<p><span style="font-weight: bold; text-transform: none;">Hello</span></p>',
          ),
        );
        const textNode = firstTextNode(nodes);
        assert($isTextNode(textNode), 'expected a TextNode');
        expect(textNode.hasFormat('bold')).toBe(true);
        expect(textNode.hasFormat('uppercase')).toBe(false);
      },
      {discrete: true},
    );
  });
});
