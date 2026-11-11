/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDOMSlot,
  $getRoot,
  $isElementNode,
  DecoratorNode,
  type ElementNode,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test, vi} from 'vitest';

import {
  fixOffset,
  getPathFromNodeToEditor,
} from '../../plugins/TestRecorderPlugin';

// Render as WebKit does, with an img before the br of the managed line break
// after an inline decorator that ends a line. `vi.mock` is hoisted above all
// imports, so the reconciler sees WebKit.
vi.mock('lexical/src/environment', async importOriginal => ({
  ...(await importOriginal<typeof import('lexical/src/environment')>()),
  IS_APPLE_WEBKIT: true,
}));

class InlineDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_recorder_inline', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
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
    return this.config('test_recorder_block', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
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

// The recorder writes the selection as the e2e tests assert it, which leaves
// out the zero-size anchor the reconciler renders outside a leading or
// trailing block decorator (#8922), and puts a point at the br of an img+br
// managed line break at its img.

function parseRoot(markup: string): HTMLElement {
  const root = new DOMParser().parseFromString(
    `<div contenteditable="true">${markup}</div>`,
    'text/html',
  ).body.firstElementChild;
  assert(root instanceof HTMLElement, 'Expected the root element');
  return root;
}

const ANCHOR = '<img data-lexical-decorator-boundary="true">';
const BLOCK = '<div data-lexical-decorator="true"></div>';
const INLINE = '<span data-lexical-decorator="true"></span>';
const LINE_BREAK =
  '<img data-lexical-managed-linebreak="true"><br data-lexical-managed-linebreak="true">';

describe('TestRecorderPlugin selection offsets', () => {
  test('an element that starts with a block decorator and ends with an inline one', () => {
    const root = parseRoot(
      `<div>${ANCHOR}${BLOCK}<span>abc</span>${INLINE}${LINE_BREAK}</div>`,
    );
    const element = root.firstChild;
    assert(element !== null, 'Expected the element');
    const text = element.childNodes[2].firstChild;
    assert(text !== null, 'Expected the text');
    expect(getPathFromNodeToEditor(text, root)).toEqual([0, 1, 0]);
    // Before and after the block decorator.
    expect(fixOffset(element, 1)).toBe(0);
    expect(fixOffset(element, 2)).toBe(1);
    // After the inline decorator, and at the br of the line break after it,
    // which the tests assert at its img.
    expect(fixOffset(element, 4)).toBe(3);
    expect(fixOffset(element, 5)).toBe(3);
  });

  test('the root around a leading block decorator', () => {
    const root = parseRoot(`${ANCHOR}${BLOCK}<p><span>abc</span></p>`);
    const text = root.childNodes[2].firstChild?.firstChild;
    assert(text != null, 'Expected the text');
    expect(getPathFromNodeToEditor(text, root)).toEqual([1, 0, 0]);
    expect(fixOffset(root, 2)).toBe(1);
  });

  test('a text node is left as it is', () => {
    const root = parseRoot(`<p><span>abc</span></p>`);
    const text = root.firstChild?.firstChild?.firstChild;
    assert(text != null, 'Expected the text');
    expect(fixOffset(text, 2)).toBe(2);
  });
});

describe('TestRecorderPlugin offsets in the DOM the editor renders', () => {
  test('match the Lexical offsets at every DOM offset', () => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    const editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        $getRoot()
          .clear()
          .append(
            $create(BlockDecoratorNode),
            $createParagraphNode().append(
              $create(InlineDecoratorNode),
              $createTextNode('abc'),
              $create(InlineDecoratorNode),
            ),
            $createParagraphNode().append($create(InlineDecoratorNode)),
            $create(BlockDecoratorNode),
          );
      },
      dependencies: [RichTextExtension],
      name: '[test-recorder-offsets]',
      nodes: [InlineDecoratorNode, BlockDecoratorNode],
    });
    editor.setRootElement(root);
    onTestFinished(() => {
      editor.dispose();
      root.remove();
    });
    expect(
      root.querySelectorAll('[data-lexical-decorator-boundary]'),
    ).toHaveLength(2);
    editor.read('latest', () => {
      const elements: ElementNode[] = [$getRoot()];
      for (const child of $getRoot().getChildren()) {
        if ($isElementNode(child)) {
          elements.push(child);
        }
      }
      for (const element of elements) {
        const dom = editor.getElementByKey(element.getKey());
        assert(dom !== null, 'Expected the element DOM');
        const slot = $getDOMSlot(element, dom, editor);
        for (let i = 0; i < slot.element.childNodes.length; i++) {
          const [parent, index] = slot.resolveChildIndex(
            element,
            dom,
            slot.element,
            i,
          );
          expect(parent.is(element)).toBe(true);
          expect([element.getType(), i, fixOffset(slot.element, i)]).toEqual([
            element.getType(),
            i,
            index,
          ]);
        }
      }
    });
  });
});
