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
import {$createLinkNode, LinkExtension} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {JSDOM} from 'jsdom';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// A `<br>` that is the last (or only) child of a block element is not
// rendered by browsers, so both HTML importers drop it. The reconciler
// compensates in the live DOM with a managed terminator `<br>`, but the HTML
// exporter did not, so a trailing LineBreakNode exported as `<p>a<br></p>` —
// which renders as one line and re-imports without the break at all.

const extension = defineExtension({
  $initialEditorState: null,
  dependencies: [RichTextExtension, LinkExtension],
  name: '[linebreak-round-trip]',
});

function buildEditor() {
  return buildEditorFromExtensions(extension);
}

function $seed(...$children: (() => LexicalNode)[]): void {
  $getRoot()
    .clear()
    .append($createParagraphNode().append(...$children.map($fn => $fn())));
}

function exportHtml(editor: LexicalEditor): string {
  return editor.read(() => $generateHtmlFromNodes(editor, null));
}

function parse(html: string): Document {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window
    .document;
}

/** The node types of the first paragraph's children, e.g. `['text', 'linebreak']`. */
function childTypes(nodes: LexicalNode[]): string[] {
  const [first] = nodes;
  return $isElementNode(first)
    ? first.getChildren().map(child => child.getType())
    : [];
}

const IMPORTERS = [
  [
    '$generateNodesFromDOM',
    (editor: LexicalEditor, html: string) =>
      $generateNodesFromDOM(editor, parse(html)),
  ],
  [
    '$generateNodesFromDOMViaExtension',
    (_editor: LexicalEditor, html: string) =>
      $generateNodesFromDOMViaExtension(parse(html)),
  ],
] as const;

describe('trailing LineBreakNode survives an HTML round trip', () => {
  test('a trailing line break exports with a terminating <br>', () => {
    using editor = buildEditor();
    editor.update(
      () => $seed(() => $createTextNode('a'), $createLineBreakNode),
      {discrete: true},
    );
    expect(exportHtml(editor)).toBe(
      '<p><span style="white-space: pre-wrap;">a</span><br>' +
        '<br data-lexical-managed-linebreak="true"></p>',
    );
  });

  test('a lone line break exports with a terminating <br>', () => {
    using editor = buildEditor();
    editor.update(() => $seed($createLineBreakNode), {discrete: true});
    expect(exportHtml(editor)).toBe(
      '<p><br><br data-lexical-managed-linebreak="true"></p>',
    );
  });

  test('the exported terminator carries the reconciler marker', () => {
    // Same attribute ElementDOMSlot.insertManagedLineBreak writes in the live
    // DOM, so an export and a scrape of the live DOM agree.
    using editor = buildEditor();
    editor.update(
      () => $seed(() => $createTextNode('a'), $createLineBreakNode),
      {discrete: true},
    );
    const brs = parse(exportHtml(editor)).querySelectorAll('br');
    expect(brs).toHaveLength(2);
    expect(brs[0].hasAttribute('data-lexical-managed-linebreak')).toBe(false);
    expect(brs[1].getAttribute('data-lexical-managed-linebreak')).toBe('true');
  });

  test('an interior line break exports unchanged', () => {
    using editor = buildEditor();
    editor.update(
      () =>
        $seed(
          () => $createTextNode('a'),
          $createLineBreakNode,
          () => $createTextNode('b'),
        ),
      {discrete: true},
    );
    expect(exportHtml(editor)).toBe(
      '<p><span style="white-space: pre-wrap;">a</span><br>' +
        '<span style="white-space: pre-wrap;">b</span></p>',
    );
  });

  test('a line break trailing an inline element exports unchanged', () => {
    // The `<br>` ends an inline `<a>`, not a block, so no importer would drop
    // it and a terminator would import as a second LineBreakNode.
    using editor = buildEditor();
    editor.update(
      () =>
        $seed(() =>
          $createLinkNode('https://lexical.dev/').append(
            $createTextNode('a'),
            $createLineBreakNode(),
          ),
        ),
      {discrete: true},
    );
    expect(exportHtml(editor)).toBe(
      '<p><a href="https://lexical.dev/">' +
        '<span style="white-space: pre-wrap;">a</span><br></a></p>',
    );
  });

  describe.each(IMPORTERS)('%s', (_name, $import) => {
    test('restores a trailing line break', () => {
      using editor = buildEditor();
      editor.update(
        () => $seed(() => $createTextNode('a'), $createLineBreakNode),
        {discrete: true},
      );
      const html = exportHtml(editor);

      editor.update(
        () => {
          expect(childTypes($import(editor, html))).toEqual([
            'text',
            'linebreak',
          ]);
        },
        {discrete: true},
      );
    });

    test('restores a lone line break', () => {
      using editor = buildEditor();
      editor.update(() => $seed($createLineBreakNode), {discrete: true});
      const html = exportHtml(editor);

      editor.update(
        () => {
          expect(childTypes($import(editor, html))).toEqual(['linebreak']);
        },
        {discrete: true},
      );
    });

    test('restores consecutive trailing line breaks', () => {
      using editor = buildEditor();
      editor.update(
        () =>
          $seed(
            () => $createTextNode('a'),
            $createLineBreakNode,
            $createLineBreakNode,
          ),
        {discrete: true},
      );
      const html = exportHtml(editor);

      editor.update(
        () => {
          expect(childTypes($import(editor, html))).toEqual([
            'text',
            'linebreak',
            'linebreak',
          ]);
        },
        {discrete: true},
      );
    });

    test('restores a trailing line break with the marker stripped', () => {
      // The marker is metadata; the importers match on position, so a
      // sanitizer that drops unknown data-* attributes changes nothing.
      using editor = buildEditor();
      editor.update(
        () => $seed(() => $createTextNode('a'), $createLineBreakNode),
        {discrete: true},
      );
      const html = exportHtml(editor).replaceAll(
        ' data-lexical-managed-linebreak="true"',
        '',
      );
      expect(html).not.toContain('data-lexical-managed-linebreak');

      editor.update(
        () => {
          expect(childTypes($import(editor, html))).toEqual([
            'text',
            'linebreak',
          ]);
        },
        {discrete: true},
      );
    });

    test('still drops an unmarked trailing <br> from external HTML', () => {
      // The rendering-faithful import rules are unchanged: HTML that a
      // browser renders as a single line must not gain a blank line.
      using editor = buildEditor();
      editor.update(
        () => {
          expect(childTypes($import(editor, '<p>a<br></p>'))).toEqual(['text']);
        },
        {discrete: true},
      );
    });
  });
});
