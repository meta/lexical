/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Regression test for #8885 — Safari/WebKit fires redundant `selectionchange`
 * events on interactions outside the editor (such as clicking the floating link
 * menu). Lexical must only dispatch SELECTION_CHANGE_COMMAND when the selection
 * has actually changed.
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  COMMAND_PRIORITY_CRITICAL,
  isDOMTextNode,
  type NodeKey,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test, vi} from 'vitest';

/**
 * Give the browser a beat to deliver any native selectionchange task from focus
 * before registering the listener.
 */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 50));
}

function mountEditor() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const contentEditable = document.createElement('div');
  contentEditable.contentEditable = 'true';
  container.appendChild(contentEditable);

  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension],
      name: '[8885-selection-change-browser]',
    }),
  );
  editor.setRootElement(contentEditable);

  onTestFinished(() => {
    editor.setRootElement(null);
    document.body.removeChild(container);
    editor.dispose();
  });

  return {contentEditable, editor};
}

describe('Issue #8885: SELECTION_CHANGE_COMMAND on redundant selectionchange', () => {
  test('suppresses redundant selectionchange without suppressing legitimate selection changes', async () => {
    const {contentEditable, editor} = mountEditor();

    let textKey: NodeKey = '';
    editor.update(
      () => {
        const text = $createTextNode('Hello world');
        textKey = text.getKey();
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(5, 5);
      },
      {discrete: true},
    );

    contentEditable.focus();
    await settle();

    const onSelectionChange = vi.fn(() => false);
    const unregister = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      onSelectionChange,
      COMMAND_PRIORITY_CRITICAL,
    );
    onTestFinished(() => {
      unregister();
    });

    // 1. A redundant selectionchange event where the selection did not change.
    // On unmodified base, onSelectionChange blindly dispatches SELECTION_CHANGE_COMMAND.
    document.dispatchEvent(new Event('selectionchange'));
    expect(onSelectionChange).not.toHaveBeenCalled();

    // 2. Legitimate caret movement within the node must still dispatch.
    const textDOM = editor.getElementByKey(textKey);
    const domTextNode = textDOM?.firstChild;
    assert(isDOMTextNode(domTextNode));
    let domSelection = document.getSelection();
    assert(domSelection !== null);
    domSelection.setBaseAndExtent(domTextNode, 2, domTextNode, 2);
    await vi.waitFor(() => expect(onSelectionChange).toHaveBeenCalledTimes(1));

    // Another redundant selectionchange at the new position must not dispatch.
    document.dispatchEvent(new Event('selectionchange'));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);

    // 3. Legitimate range expansion must still dispatch.
    domSelection = document.getSelection();
    assert(domSelection !== null);
    domSelection.setBaseAndExtent(domTextNode, 2, domTextNode, 8);
    await vi.waitFor(() => expect(onSelectionChange).toHaveBeenCalledTimes(2));

    // Redundant selectionchange with range selection must not dispatch.
    document.dispatchEvent(new Event('selectionchange'));
    expect(onSelectionChange).toHaveBeenCalledTimes(2);

    // Changing the range on text outside the editor does not trigger SELECTION_CHANGE_COMMAND
    const outsideText = document.createTextNode('Foo');
    document.body.appendChild(outsideText);
    domSelection.setBaseAndExtent(outsideText, 1, outsideText, 1);
    await settle();
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
  });
});
