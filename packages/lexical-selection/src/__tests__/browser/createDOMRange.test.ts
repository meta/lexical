/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {createDOMRange} from '@lexical/selection';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  DecoratorNode,
  type ElementDOMSlot,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';

// The editor renders DOM of its own between an element's children, such as a
// zero-size anchor before a block decorator at the edge of the root (#8922),
// and an element can render DOM of its own ahead of its children. Element
// points must count it, as the editor's own DOM selection does, so that ranges
// for remote carets, comments and the like cover the nodes they name.

class InlineDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_create_dom_range_inline', {
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

class BlockDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_create_dom_range_block', {
      extends: DecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const div = document.createElement('div');
    div.style.cssText = 'height:20px';
    return div;
  }
  updateDOM(): false {
    return false;
  }
  isInline(): false {
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
    return this.config('test_create_dom_range_leading_marker', {
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

function mount($children: () => LexicalNode[]): LexicalEditor {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        $getRoot()
          .clear()
          .append(...$children());
      },
      dependencies: [RichTextExtension],
      name: '[create-dom-range]',
      nodes: [
        InlineDecoratorNode,
        BlockDecoratorNode,
        LeadingMarkerElementNode,
      ],
    }),
  );
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  return editor;
}

/** The range for `offset` in `element`, collapsed. */
function rangeAt(
  editor: LexicalEditor,
  element: LexicalNode,
  offset: number,
): Range {
  const range = createDOMRange(editor, element, offset, element, offset);
  assert(range !== null, 'Expected a range');
  return range;
}

/** The DOM child right after the start of `range`. */
function childAfterStart(range: Range): Node | null {
  return range.startContainer.childNodes[range.startOffset] || null;
}

describe('createDOMRange element points', () => {
  test('in an element whose children follow a marker of its own', () => {
    const editor = mount(() => [
      $create(LeadingMarkerElementNode).append(
        $create(InlineDecoratorNode),
        $createTextNode('abc'),
        $create(InlineDecoratorNode),
      ),
    ]);
    editor.read('latest', () => {
      const element = $getRoot().getFirstChild();
      assert($isElementNode(element), 'Expected the element');
      const [first, text, last] = element.getChildren();
      const firstDOM = editor.getElementByKey(first.getKey());
      const textDOM = editor.getElementByKey(text.getKey());
      const lastDOM = editor.getElementByKey(last.getKey());
      assert(firstDOM !== null && textDOM !== null && lastDOM !== null);
      expect(childAfterStart(rangeAt(editor, element, 0))).toBe(firstDOM);
      expect(childAfterStart(rangeAt(editor, element, 1))).toBe(textDOM);
      const range = createDOMRange(editor, element, 0, element, 3);
      assert(range !== null, 'Expected a range');
      expect(range.intersectsNode(firstDOM)).toBe(true);
      expect(range.endContainer.childNodes[range.endOffset - 1]).toBe(lastDOM);
    });
  });

  test('in the root after a leading block decorator', () => {
    const editor = mount(() => [
      $create(BlockDecoratorNode),
      $createParagraphNode().append($createTextNode('abc')),
    ]);
    const [root, paragraphDOM] = editor.read('latest', () => {
      const rootNode = $getRoot();
      return [
        rootNode,
        editor.getElementByKey(rootNode.getLastChildOrThrow().getKey()),
      ] as const;
    });
    assert(paragraphDOM !== null);
    // Outside a read, as collaboration cursors call it.
    expect(childAfterStart(rangeAt(editor, root, 1))).toBe(paragraphDOM);
  });
});
