/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createQuoteNode,
  $isQuoteNode,
  QuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $setSelection,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension],
      name: 'quote-shadow-root-host',
    }),
  );
}

describe('QuoteNode shadow root opt-in', () => {
  test('isShadowRoot() defaults to false and serializes nothing', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const quoteNode = $createQuoteNode();
        expect(quoteNode.isShadowRoot()).toBe(false);
        expect('shadowRoot' in quoteNode.exportJSON()).toBe(false);
      },
      {discrete: true},
    );
  });

  test('opt-in with $createQuoteNode and setIsShadowRoot', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const quoteNode = $createQuoteNode({shadowRoot: true});
        expect(quoteNode.isShadowRoot()).toBe(true);
        expect(quoteNode.exportJSON().shadowRoot).toBe(true);
        quoteNode.setIsShadowRoot(false);
        expect(quoteNode.isShadowRoot()).toBe(false);
        expect('shadowRoot' in quoteNode.exportJSON()).toBe(false);
        quoteNode.setIsShadowRoot(true);
        expect(quoteNode.isShadowRoot()).toBe(true);
      },
      {discrete: true},
    );
  });

  test('shadow root round-trips through JSON', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const quoteNode = $createQuoteNode({shadowRoot: true});
        const imported = QuoteNode.importJSON(quoteNode.exportJSON());
        expect(imported.isShadowRoot()).toBe(true);
        const importedDefault = QuoteNode.importJSON(
          $createQuoteNode().exportJSON(),
        );
        expect(importedDefault.isShadowRoot()).toBe(false);
      },
      {discrete: true},
    );
  });

  test('collapseAtStart() lifts blocks out of a shadow root quote', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const quoteNode = $createQuoteNode({shadowRoot: true});
        quoteNode.append(
          $createParagraphNode().append($createTextNode('a')),
          $createParagraphNode().append($createTextNode('b')),
        );
        root.clear().append(quoteNode);
        quoteNode.collapseAtStart();
        const children = root.getChildren();
        expect(children.length).toBe(2);
        expect(children.every($isParagraphNode)).toBe(true);
        expect(children.map(node => node.getTextContent())).toEqual(['a', 'b']);
      },
      {discrete: true},
    );
  });

  test('getTopLevelElement() stops at a shadow root quote', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const quoteNode = $createQuoteNode({shadowRoot: true});
        const paragraph = $createParagraphNode().append($createTextNode('a'));
        quoteNode.append(paragraph);
        root.clear().append(quoteNode);
        expect(paragraph.getTopLevelElementOrThrow().is(paragraph)).toBe(true);
        quoteNode.setIsShadowRoot(false);
        expect(paragraph.getTopLevelElementOrThrow().is(quoteNode)).toBe(true);
      },
      {discrete: true},
    );
  });

  // A pasted <blockquote>text</blockquote> is a quote of inline content; an
  // app that makes every quote a shadow root leaves the wrapping to the
  // transform, with the caret where the paste left it, after the quote's text.
  test.each([
    ['at the end of', 16],
    ['inside', 6],
  ])(
    'the caret stays %s text the transform wraps in a paragraph',
    (_, offset) => {
      using editor = buildEditor();
      editor.update(
        () => {
          const text = $createTextNode('Quoted bare text');
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('Intro line.')),
              $createQuoteNode().append(text),
            );
          text.select(offset, offset);
        },
        {discrete: true},
      );
      editor.update(
        () => {
          const quote = $getRoot().getLastChild();
          assert($isQuoteNode(quote), 'Expected a QuoteNode');
          quote.setIsShadowRoot(true);
        },
        {discrete: true},
      );
      editor.read(() => {
        const quote = $getRoot().getLastChild();
        assert($isQuoteNode(quote), 'Expected a QuoteNode');
        const paragraph = quote.getFirstChildOrThrow();
        expect($isParagraphNode(paragraph)).toBe(true);
        expect(paragraph.getTextContent()).toBe('Quoted bare text');
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected a RangeSelection');
        expect(selection.isCollapsed()).toBe(true);
        expect(selection.anchor.type).toBe('text');
        expect(selection.anchor.getNode().getTextContent()).toBe(
          'Quoted bare text',
        );
        expect(selection.anchor.offset).toBe(offset);
      });
    },
  );

  test('a range from the first child of a run to a later child stays on the text', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const first = $createTextNode('aaa');
        const second = $createTextNode('bbb').toggleFormat('bold');
        $getRoot().clear().append($createQuoteNode().append(first, second));
        const selection = first.select(1, 1);
        selection.focus.set(second.getKey(), 2, 'text');
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const quote = $getRoot().getFirstChild();
        assert($isQuoteNode(quote), 'Expected a QuoteNode');
        quote.setIsShadowRoot(true);
      },
      {discrete: true},
    );
    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected a RangeSelection');
      const {anchor, focus} = selection;
      expect([
        anchor.type,
        anchor.getNode().getTextContent(),
        anchor.offset,
      ]).toEqual(['text', 'aaa', 1]);
      expect([
        focus.type,
        focus.getNode().getTextContent(),
        focus.offset,
      ]).toEqual(['text', 'bbb', 2]);
    });
  });

  test('the caret stays in the first child of a run that follows a block', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const text = $createTextNode('ddd');
        $getRoot()
          .clear()
          .append(
            $createQuoteNode()
              .setIsShadowRoot(true)
              .append(
                $createParagraphNode().append($createTextNode('ppp')),
                text,
              ),
          );
        text.select(2, 2);
      },
      {discrete: true},
    );
    editor.read(() => {
      const quote = $getRoot().getFirstChild();
      assert($isQuoteNode(quote), 'Expected a QuoteNode');
      expect(
        quote
          .getChildren()
          .map(child => [child.getType(), child.getTextContent()]),
      ).toEqual([
        ['paragraph', 'ppp'],
        ['paragraph', 'ddd'],
      ]);
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected a RangeSelection');
      const {anchor} = selection;
      expect([
        anchor.type,
        anchor.getNode().getTextContent(),
        anchor.offset,
      ]).toEqual(['text', 'ddd', 2]);
    });
  });

  // An element point on the quote counts its children, which the transform
  // regroups: it stays in the same gap, now inside the new paragraph.
  test.each([
    ['between two children of the run', 1],
    ['after the last child of the run', 3],
  ])('an element point on the quote %s stays in place', (_, offset) => {
    using editor = buildEditor();
    editor.update(
      () => {
        const quote = $createQuoteNode().append(
          $createTextNode('aaa'),
          $createTextNode('bbb').toggleFormat('bold'),
          $createTextNode('ccc').toggleFormat('italic'),
        );
        $getRoot().clear().append(quote);
        const selection = $createRangeSelection();
        selection.anchor.set(quote.getKey(), offset, 'element');
        selection.focus.set(quote.getKey(), offset, 'element');
        $setSelection(selection);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const quote = $getRoot().getFirstChild();
        assert($isQuoteNode(quote), 'Expected a QuoteNode');
        quote.setIsShadowRoot(true);
      },
      {discrete: true},
    );
    editor.read(() => {
      const quote = $getRoot().getFirstChild();
      assert($isQuoteNode(quote), 'Expected a QuoteNode');
      const paragraph = quote.getFirstChildOrThrow();
      expect($isParagraphNode(paragraph)).toBe(true);
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected a RangeSelection');
      for (const point of [selection.anchor, selection.focus]) {
        expect([point.type, point.key, point.offset]).toEqual([
          'element',
          paragraph.getKey(),
          offset,
        ]);
      }
    });
  });
});
