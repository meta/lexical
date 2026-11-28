/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {$createLinkNode, LinkExtension} from '@lexical/link';
import {$createMarkNode, MarkNode} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  ElementNode,
  type LexicalNode,
  type ParagraphNode,
  type TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test, vi} from 'vitest';
import {userEvent} from 'vitest/browser';

// Regression tests for #9280. A character typed at a link's edge goes outside
// the link, since a LinkNode takes no text at its edges, and that holds where
// the caret's text is in an inline element inside the link too. Lexical has to
// write such a character itself: left to the browser, Chromium writes an
// insertion at an <a>'s edge outside the <a>, as a text node Lexical doesn't
// know and removes.

// Any custom inline element. Like ElementNode by default, it takes text at
// its edges.
class InlineNode extends ElementNode {
  $config() {
    return this.config('test_inline', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): boolean {
    return false;
  }
  isInline(): true {
    return true;
  }
}

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 50));
}

function $shape(node: LexicalNode): string {
  if ($isTextNode(node)) {
    return JSON.stringify(node.getTextContent());
  }
  if ($isElementNode(node)) {
    return `${node.getType()}[${node.getChildren().map($shape).join(', ')}]`;
  }
  return node.getType();
}

const $link = (...children: LexicalNode[]) =>
  $createLinkNode('https://example.com/').append(...children);
const $mark = (...children: LexicalNode[]) =>
  $createMarkNode(['id']).append(...children);
const $inline = (...children: LexicalNode[]) =>
  $create(InlineNode).append(...children);

/**
 * Writes the paragraph `$build` returns, puts the caret at the given edge of
 * the text it names, types `X` with a real key press, and waits for the
 * paragraph to take the `expected` shape.
 */
async function typeX(
  $build: () => [ParagraphNode, TextNode],
  edge: 'start' | 'end',
  expected: string,
): Promise<void> {
  const contentEditable = document.createElement('div');
  contentEditable.contentEditable = 'true';
  document.body.appendChild(contentEditable);
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension, LinkExtension],
      name: '[9280-typing-at-link-edge]',
      nodes: () => [MarkNode, InlineNode],
    }),
  );
  editor.setRootElement(contentEditable);
  onTestFinished(() => {
    editor.dispose();
    contentEditable.remove();
  });

  contentEditable.focus();
  editor.update(
    () => {
      const [paragraph, caret] = $build();
      $getRoot().clear().append(paragraph);
      const offset = edge === 'start' ? 0 : caret.getTextContentSize();
      caret.select(offset, offset);
    },
    {discrete: true},
  );
  await settle();

  // Focus the test iframe as well as the editor. In Firefox, an editor can
  // remain document.activeElement while its iframe is inactive, in which
  // case Playwright's keyboard events never reach the contenteditable.
  window.focus();
  await userEvent.keyboard('X');
  await vi.waitFor(() => {
    expect(editor.read(() => $shape($getRoot().getFirstChildOrThrow()))).toBe(
      expected,
    );
  });
}

describe("typing at a link's edge, in an inline element inside it (#9280)", () => {
  test('writes after the link, at the end of an inline element that ends it', async () => {
    await typeX(
      () => {
        const caret = $createTextNode('xy');
        return [
          $createParagraphNode().append(
            $createTextNode('ab '),
            $link($createTextNode('cd '), $inline(caret)),
          ),
          caret,
        ];
      },
      'end',
      'paragraph["ab ", link["cd ", test_inline["xy"]], "X"]',
    );
  });

  test('writes into the text after the link, at the end of an inline element that ends it', async () => {
    await typeX(
      () => {
        const caret = $createTextNode('xy');
        return [
          $createParagraphNode().append(
            $createTextNode('ab '),
            $link($createTextNode('cd '), $inline(caret)),
            $createTextNode(' ef'),
          ),
          caret,
        ];
      },
      'end',
      'paragraph["ab ", link["cd ", test_inline["xy"]], "X ef"]',
    );
  });

  test('writes before the link, at the start of an inline element that starts it', async () => {
    await typeX(
      () => {
        const caret = $createTextNode('xy');
        return [
          $createParagraphNode().append(
            $link($inline(caret), $createTextNode(' cd')),
            $createTextNode(' ef'),
          ),
          caret,
        ];
      },
      'start',
      'paragraph["X", link[test_inline["xy"], " cd"], " ef"]',
    );
  });

  test('writes after the link, at the end of a MarkNode that ends it', async () => {
    await typeX(
      () => {
        const caret = $createTextNode('xy');
        return [
          $createParagraphNode().append(
            $createTextNode('ab '),
            $link($createTextNode('cd '), $mark(caret)),
          ),
          caret,
        ];
      },
      'end',
      'paragraph["ab ", link["cd ", mark["xy"]], "X"]',
    );
  });

  test('writes after the MarkNode, at the end of an inline element that ends it', async () => {
    await typeX(
      () => {
        const caret = $createTextNode('xy');
        return [
          $createParagraphNode().append(
            $createTextNode('ab '),
            $mark($createTextNode('cd '), $inline(caret)),
            $createTextNode(' ef'),
          ),
          caret,
        ];
      },
      'end',
      'paragraph["ab ", mark["cd ", test_inline["xy"]], "X ef"]',
    );
  });

  test('writes after the link, at the end of its own text', async () => {
    await typeX(
      () => {
        const caret = $createTextNode('cd');
        return [
          $createParagraphNode().append($createTextNode('ab '), $link(caret)),
          caret,
        ];
      },
      'end',
      'paragraph["ab ", link["cd"], "X"]',
    );
  });

  test("writes inside an inline element away from the link's edge", async () => {
    await typeX(
      () => {
        const caret = $createTextNode('xy');
        return [
          $createParagraphNode().append(
            $createTextNode('ab '),
            $link($inline(caret), $createTextNode(' cd')),
          ),
          caret,
        ];
      },
      'end',
      'paragraph["ab ", link[test_inline["xyX"], " cd"]]',
    );
  });
});
