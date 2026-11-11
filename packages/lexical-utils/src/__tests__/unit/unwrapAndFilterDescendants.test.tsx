/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$unwrapAndFilterDescendants} from '@lexical/utils';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  $isTextNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
} from 'lexical';
import {createTestEditor} from 'lexical/src/__tests__/utils';
import {beforeEach, describe, expect, it} from 'vitest';

function assertClass<T extends LexicalNode>(v: unknown, klass: Klass<T>): T {
  if (v instanceof klass) {
    return v as T;
  }
  throw new Error(`Value does not extend ${klass.name}`);
}

function $createTextAndParagraphWithDepth(depth: number): LexicalNode[] {
  if (depth <= 0) {
    return [$createTextNode(`<${depth} />`)];
  }
  return [
    $createTextNode(`<${depth}>`),
    $createParagraphNode().append(
      ...$createTextAndParagraphWithDepth(depth - 1),
    ),
    $createTextNode(`</${depth}>`),
  ];
}

function textContentForDepth(i: number): string {
  return i > 0 ? `<${i}>${textContentForDepth(i - 1)}</${i}>` : `<${i} />`;
}

describe('$unwrapAndFilterDescendants', () => {
  let editor: LexicalEditor;

  beforeEach(async () => {
    editor = createTestEditor();
    editor._headless = true;
  });

  it('Is a no-op with valid children', () => {
    editor.update(
      () => {
        $getRoot().clear().append($createParagraphNode());
      },
      {discrete: true},
    );
    editor.update(
      () => {
        expect($unwrapAndFilterDescendants($getRoot(), $isParagraphNode)).toBe(
          false,
        );
        expect($getRoot().getChildrenSize()).toBe(1);
        expect($isParagraphNode($getRoot().getFirstChild())).toBe(true);
      },
      {discrete: true},
    );
  });
  [0, 1, 2].forEach(depth =>
    it(`Can un-nest children at depth ${depth}`, () => {
      editor.update(
        () => {
          const firstNode = $createParagraphNode();
          $getRoot()
            .clear()
            .append(
              firstNode.append(...$createTextAndParagraphWithDepth(depth)),
            );
        },
        {discrete: true},
      );
      editor.update(
        () => {
          const firstNode = assertClass(
            $getRoot().getFirstChildOrThrow(),
            ParagraphNode,
          );
          expect(firstNode.getChildren().every($isTextNode)).toBe(depth === 0);
          expect($unwrapAndFilterDescendants(firstNode, $isTextNode)).toBe(
            depth > 0,
          );
          expect(firstNode.getChildren().every($isTextNode)).toBe(true);
          expect(firstNode.getTextContent()).toBe(textContentForDepth(depth));
        },
        {discrete: true},
      );
    }),
  );
});
