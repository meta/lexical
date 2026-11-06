/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * A style set at a caret is kept for the text typed next, across the
 * selectionchange that writing the caret to the DOM causes. The editor
 * matches that selectionchange to the caret by its Lexical offset, which for
 * an element point differs from the DOM offset when the element renders DOM
 * ahead of its children.
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {$patchStyleText} from '@lexical/selection';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  DecoratorNode,
  type ElementDOMSlot,
  ElementNode,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

class InlineDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_collapsed_style_inline', {
      extends: DecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.cssText = 'display:inline-block;width:20px;height:20px';
    return span;
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

/**
 * A block that renders a non-editable marker ahead of its children, which its
 * DOM slot keeps them after.
 */
class LeadingMarkerElementNode extends ElementNode {
  $config() {
    return this.config('test_collapsed_style_leading_marker', {
      extends: ElementNode,
    });
  }
  createDOM(): HTMLElement {
    const div = document.createElement('div');
    const marker = document.createElement('span');
    marker.setAttribute('data-marker', 'true');
    marker.contentEditable = 'false';
    marker.textContent = '§';
    div.appendChild(marker);
    return div;
  }
  updateDOM(): false {
    return false;
  }
  getDOMSlot(dom: HTMLElement): ElementDOMSlot<HTMLElement> {
    const marker = dom.querySelector(':scope > [data-marker]');
    assert(marker !== null, 'Expected the marker');
    return super.getDOMSlot(dom).withAfter(marker);
  }
}

test('a style set at the caret after a decorator in an element with a leading marker is typed with', async () => {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        $getRoot()
          .clear()
          .append(
            $create(LeadingMarkerElementNode).append(
              $create(InlineDecoratorNode),
            ),
            $createParagraphNode().append($createTextNode('abc')),
          );
      },
      dependencies: [RichTextExtension],
      name: '[collapsed-style-beside-decorator]',
      nodes: [InlineDecoratorNode, LeadingMarkerElementNode],
    }),
  );
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  root.focus();
  editor.update(
    () => {
      const element = $getRoot().getFirstChild();
      assert($isElementNode(element), 'Expected the element');
      element.select(1, 1);
    },
    {discrete: true},
  );
  editor.update(
    () => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected a RangeSelection');
      $patchStyleText(selection, {color: 'red'});
    },
    {discrete: true},
  );
  await userEvent.keyboard('x');
  await expect
    .poll(() =>
      editor.read('latest', () =>
        $getRoot()
          .getAllTextNodes()
          .map(node => [node.getTextContent(), node.getStyle()]),
      ),
    )
    .toEqual([
      ['x', 'color: red;'],
      ['abc', ''],
    ]);
});
