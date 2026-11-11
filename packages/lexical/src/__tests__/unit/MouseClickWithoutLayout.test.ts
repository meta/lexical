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
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  getDOMSelection,
  isDOMTextNode,
  registerEventListener,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';

// jsdom has no hit testing (document.elementFromPoint), so the editor follows
// a mouse press there as the browser selects it, as testing libraries' clicks
// expect, whether the release comes after the selectionchange of the press or
// before it.
test.each([
  ['after', true],
  ['before', false],
])(
  'a mouse click released %s its selectionchange in a document without hit testing selects where the DOM selection is',
  async (_name, isReleaseLast) => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    const errors: Error[] = [];
    const editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('abc')));
      },
      dependencies: [RichTextExtension],
      name: '[mouse-click-without-layout]',
      onError: error => {
        errors.push(error);
      },
    });
    editor.setRootElement(root);
    onTestFinished(() => {
      editor.dispose();
      root.remove();
    });
    const span = root.querySelector('[data-lexical-text]');
    assert(span !== null, 'Expected the span of "abc"');
    const textDOM = span.firstChild;
    assert(isDOMTextNode(textDOM), 'Expected the text node of "abc"');
    const domSelection = getDOMSelection(window);
    assert(domSelection !== null, 'Expected a DOM selection');
    // The events of a click, as testing libraries send them.
    const init = {bubbles: true, button: 0, buttons: 1, composed: true};
    span.dispatchEvent(
      new PointerEvent('pointerdown', {...init, pointerType: 'mouse'}),
    );
    span.dispatchEvent(new MouseEvent('mousedown', {...init, detail: 1}));
    root.focus();
    domSelection.setBaseAndExtent(textDOM, 2, textDOM, 2);
    const release = () =>
      span.dispatchEvent(
        new PointerEvent('pointerup', {
          ...init,
          buttons: 0,
          pointerType: 'mouse',
        }),
      );
    if (!isReleaseLast) {
      release();
    }
    await new Promise<void>(resolve =>
      onTestFinished(
        registerEventListener(document, 'selectionchange', () => resolve()),
      ),
    );
    if (isReleaseLast) {
      release();
    }
    expect(errors).toEqual([]);
    expect(
      editor.read(() => {
        const selection = $getSelection();
        return $isRangeSelection(selection)
          ? [selection.anchor.offset, selection.focus.offset]
          : null;
      }),
    ).toEqual([2, 2]);
  },
);
