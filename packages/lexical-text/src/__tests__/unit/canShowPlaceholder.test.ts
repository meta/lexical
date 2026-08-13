/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {$canShowPlaceholder} from '@lexical/text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  DecoratorNode,
  defineExtension,
  type TextModeType,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

// An inline decorator that contributes no text, e.g. an inline image or
// equation chip. Its emptiness keeps the root's text content empty while the
// document plainly is not empty.
class InlineDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('inline_decorator_placeholder', {
      extends: DecoratorNode,
    });
  }
  isInline(): boolean {
    return true;
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): boolean {
    return false;
  }
  decorate(): null {
    return null;
  }
}

function $createInlineDecoratorNode(): InlineDecoratorNode {
  return $create(InlineDecoratorNode);
}

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      name: '[can-show-placeholder]',
      nodes: [InlineDecoratorNode],
    }),
  );
}

// A simple empty TextNode is removed during reconciliation, which would move
// the decorator to index 0. `token` and `segmented` nodes are not simple text,
// so they survive and keep a TextNode at index 0 — the shape that exercises
// the scan of the remaining children.
const NON_SIMPLE_MODES: TextModeType[] = ['token', 'segmented'];

describe('$canShowPlaceholder', () => {
  for (const mode of NON_SIMPLE_MODES) {
    test(`is false when a decorator follows an empty ${mode} text node`, () => {
      using editor = buildEditor();
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          paragraph.append(
            $createTextNode('').setMode(mode),
            $createInlineDecoratorNode(),
          );
          $getRoot().clear().append(paragraph);
        },
        {discrete: true},
      );

      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        // Guard the premise: the text node must have survived, otherwise the
        // decorator would sit at index 0 and the scan would be trivial.
        expect(paragraph.getChildrenSize()).toBe(2);
        expect($getRoot().getTextContent()).toBe('');
        expect($canShowPlaceholder(false)).toBe(false);
      });
    });
  }

  test('is false when the decorator is several positions along', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append(
          $createTextNode('').setMode('token'),
          $createTextNode('').setMode('token'),
          $createInlineDecoratorNode(),
        );
        $getRoot().clear().append(paragraph);
      },
      {discrete: true},
    );

    expect(editor.read(() => $canShowPlaceholder(false))).toBe(false);
  });

  test('is still false when the decorator is first', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append(
          $createInlineDecoratorNode(),
          $createTextNode('').setMode('token'),
        );
        $getRoot().clear().append(paragraph);
      },
      {discrete: true},
    );

    expect(editor.read(() => $canShowPlaceholder(false))).toBe(false);
  });

  test('is still true for an empty paragraph', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        $getRoot().clear().append($createParagraphNode());
      },
      {discrete: true},
    );

    expect(editor.read(() => $canShowPlaceholder(false))).toBe(true);
  });

  test('is still true for a paragraph of empty text nodes', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append(
          $createTextNode('').setMode('token'),
          $createTextNode('').setMode('token'),
        );
        $getRoot().clear().append(paragraph);
      },
      {discrete: true},
    );

    expect(editor.read(() => $canShowPlaceholder(false))).toBe(true);
  });
});
