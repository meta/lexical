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
  QuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  defineExtension,
} from 'lexical';
import {describe, expect, test} from 'vitest';

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
});
