/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  buildEditorFromExtensions,
  HorizontalRuleExtension,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  type LexicalNode,
} from 'lexical';
import {expect, onTestFinished, test, vi} from 'vitest';

import {
  $isPageNode,
  $setPageSetup,
  DEFAULT_PAGE_SETUP,
  PagesExtension,
} from '../../plugins/PagesExtension';

const LINES = 120;

/** Each page's children, a horizontal rule as `<hr>`. */
function $pages(): string[][] {
  const describe = (node: LexicalNode) =>
    $isHorizontalRuleNode(node) ? '<hr>' : node.getTextContent();
  return $getRoot()
    .getChildren()
    .filter($isPageNode)
    .map(page => page.getContentNode().getChildren().map(describe));
}

// A page whose content starts or ends with a block decorator has a decorator
// boundary anchor beside it, so its DOM holds one more node than it has
// children. Splitting such a page used to recurse until the stack overflowed.
test.each(['starts', 'ends'])(
  'a page that %s with a horizontal rule is split when it overflows',
  async edge => {
    const errors: string[] = [];
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          HorizontalRuleExtension,
          PagesExtension,
        ],
        name: '[pages-block-decorator-overflow]',
        onError: error => {
          errors.push(error.message);
        },
      }),
    );
    onTestFinished(() => {
      editor.dispose();
      root.remove();
    });
    editor.setRootElement(root);
    const lines = Array.from({length: LINES}, (_, i) => `line ${i}`);
    const expected =
      edge === 'starts' ? ['<hr>', ...lines] : [...lines, '<hr>'];
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            ...expected.map(line =>
              line === '<hr>'
                ? $createHorizontalRuleNode()
                : $createParagraphNode().append($createTextNode(line)),
            ),
          );
        $setPageSetup(DEFAULT_PAGE_SETUP);
      },
      {discrete: true},
    );
    // The pages are measured and split one animation frame at a time.
    await vi.waitFor(() => {
      expect(errors).toEqual([]);
      expect(editor.read($pages).length).toBeGreaterThan(1);
    });
    const pages = editor.read($pages);
    expect(errors).toEqual([]);
    // Every page has content, and no child was lost or reordered.
    expect(pages.filter(children => children.length === 0)).toEqual([]);
    expect(pages.flat()).toEqual(expected);
  },
);
