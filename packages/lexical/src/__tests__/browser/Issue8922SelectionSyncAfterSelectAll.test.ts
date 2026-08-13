/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Regression test for a WebKit-only follow-up to #8922 — after select-all is
 * applied twice in a row, moving the DOM selection back into text (e.g. by
 * clicking) must still update the Lexical selection.
 *
 * The second select-all re-applies a DOM selection the DOM already has.
 * `$updateDOMSelection` deliberately re-sets element-anchored selections (the
 * shape select-all produces when the document starts with a block decorator)
 * and then marks `isSelectionChangeFromDOMUpdate`, expecting the browser to
 * deliver one selectionchange event for it. WebKit fires no selectionchange
 * for a no-op re-set, so the flag went stale and swallowed the *next* real
 * selectionchange: the DOM caret moved into the text but the Lexical
 * selection stayed frozen on the select-all range. Chromium and Firefox
 * deliver an event either way, which is why only Safari users saw it.
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $selectAll,
  DecoratorNode,
  type NodeKey,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

class TestBlockDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_block_decorator', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.style.height = '30px';
    dom.textContent = 'DECORATOR';
    return dom;
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

const ext = defineExtension({
  dependencies: [RichTextExtension],
  name: '[8922-selection-sync-browser]',
  nodes: [TestBlockDecoratorNode],
});

/**
 * selectionchange is dispatched as a task after the selection mutation; give
 * the browser a beat to deliver (or, in the WebKit no-op case, to not
 * deliver) it before the next step.
 */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 50));
}

describe('selection sync after repeated select-all (#8922)', () => {
  test('moving the DOM selection into text still updates the Lexical selection', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const contentEditable = document.createElement('div');
    contentEditable.contentEditable = 'true';
    container.appendChild(contentEditable);

    const editor = buildEditorFromExtensions(ext);
    editor.setRootElement(contentEditable);
    onTestFinished(() => {
      editor.setRootElement(null);
      document.body.removeChild(container);
      editor.dispose();
    });

    let textKey: NodeKey = '';
    editor.update(
      () => {
        const text = $createTextNode('hello');
        textKey = text.getKey();
        $getRoot()
          .clear()
          .append(
            new TestBlockDecoratorNode(),
            $createParagraphNode().append(text),
            $createParagraphNode().append($createTextNode('world')),
          );
        // The user's first click: a caret in the middle of the text.
        text.select(2, 2);
      },
      {discrete: true},
    );
    await settle();

    // Cmd-A twice. The second application re-sets a DOM selection the DOM
    // already has; WebKit fires no selectionchange for that no-op, leaving
    // isSelectionChangeFromDOMUpdate stale.
    editor.update(() => void $selectAll(), {discrete: true});
    await settle();
    editor.update(() => void $selectAll(), {discrete: true});
    await settle();

    // The DOM-level effect of clicking back into the text: the browser
    // collapses the DOM selection to a caret mid-text and fires one real
    // selectionchange, which must not be swallowed by the stale flag.
    const textDOM = editor.getElementByKey(textKey);
    expect(textDOM).not.toBeNull();
    const domTextNode = textDOM!.firstChild as Text;
    document.getSelection()!.setBaseAndExtent(domTextNode, 3, domTextNode, 3);
    await settle();

    const selectionState = editor.read(() => {
      const selection = $getSelection();
      return $isRangeSelection(selection)
        ? {
            anchorKey: selection.anchor.key,
            anchorOffset: selection.anchor.offset,
            anchorType: selection.anchor.type,
            collapsed: selection.isCollapsed(),
          }
        : null;
    });
    expect(selectionState).toEqual({
      anchorKey: textKey,
      anchorOffset: 3,
      anchorType: 'text',
      collapsed: true,
    });
  });
});
