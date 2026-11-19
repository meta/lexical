/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * A listener can take a mouse press from the browser by cancelling it, and
 * put the caret itself, which the browser then leaves alone. The editor
 * takes what the selectionchange during the press reports for the press's
 * selection, as it does for a press that the browser selects from, so the
 * caret replaces a node selection, which an ordinary selectionchange leaves
 * in place.
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  DecoratorNode,
  isDOMTextNode,
  registerEventListener,
} from 'lexical';
import {assert, onTestFinished, test} from 'vitest';
import {commands} from 'vitest/browser';

class BoxNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_cancelled_press_box', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    const div = document.createElement('div');
    div.style.cssText = 'height:30px;background:#888';
    return div;
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

test.each(['pointerdown', 'mousedown'])(
  "a DOM selection made during a press whose %s a listener cancelled is taken as the press's selection",
  async type => {
    const root = document.createElement('div');
    root.id = 'cancelled-press-root';
    root.contentEditable = 'true';
    root.style.cssText = 'width:380px;padding:10px;font-size:16px';
    document.body.appendChild(root);
    let boxKey = '';
    let textKey = '';
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          const text = $createTextNode('hello world');
          const box = $create(BoxNode);
          boxKey = box.getKey();
          textKey = text.getKey();
          $getRoot().clear().append($createParagraphNode().append(text), box);
        },
        dependencies: [RichTextExtension],
        name: '[cancelled-press-selection]',
        nodes: [BoxNode],
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
        const selection = $createNodeSelection();
        selection.add(boxKey);
        $setSelection(selection);
      },
      {discrete: true},
    );
    const span = editor.getElementByKey(textKey);
    assert(span !== null, 'expected the text element');
    const textDOM = span.firstChild;
    assert(isDOMTextNode(textDOM), 'expected the text');
    // The listener puts the caret after "hel" itself, where the press, at the
    // end of the text, would not.
    onTestFinished(
      registerEventListener(
        root,
        type,
        event => {
          event.preventDefault();
          const domSelection = window.getSelection();
          assert(domSelection !== null, 'expected a DOM selection');
          domSelection.collapse(textDOM, 3);
        },
        true,
      ),
    );
    const rootRect = root.getBoundingClientRect();
    const textRect = span.getBoundingClientRect();
    await commands.mouseDrag('#cancelled-press-root', [
      [
        textRect.right - rootRect.left - 2,
        (textRect.top + textRect.bottom) / 2 - rootRect.top,
      ],
    ]);
    const caret = editor.read(() => {
      const selection = $getSelection();
      return $isRangeSelection(selection) && selection.isCollapsed()
        ? `${selection.anchor.key}:${selection.anchor.offset}`
        : `${selection && selection.constructor.name}`;
    });
    assert(
      caret === `${textKey}:3`,
      `expected the caret at ${textKey}:3, got ${caret}`,
    );
    const domSelection = window.getSelection();
    assert(
      domSelection !== null &&
        domSelection.anchorNode === textDOM &&
        domSelection.anchorOffset === 3 &&
        domSelection.isCollapsed,
      'expected the caret to stay in the DOM',
    );
  },
);
