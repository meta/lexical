/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, configExtension} from '@lexical/extension';
import {$createLinkNode, ClickableLinkExtension} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  DecoratorNode,
  defineExtension,
} from 'lexical';
import {expect, onTestFinished, test, vi} from 'vitest';

class EditorHostNode extends DecoratorNode<null> {
  $config() {
    return this.config('editor-host', {extends: DecoratorNode});
  }
  createDOM() {
    const element = $getDocument().createElement('div');
    element.contentEditable = 'false';
    return element;
  }
  updateDOM() {
    return false;
  }
  isInline() {
    return false;
  }
  decorate() {
    return null;
  }
}

test.each([false, true])(
  'parent leaves a nested link to its editor (disabled: %s)',
  disabled => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const parent = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          configExtension(ClickableLinkExtension, {newTab: true}),
        ],
        name: 'ParentClickableLink',
        nodes: () => [EditorHostNode],
      }),
    );
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    parent.setRootElement(root);
    let hostKey = '';
    parent.update(
      () => {
        const host = $create(EditorHostNode);
        hostKey = host.getKey();
        $getRoot().append(host);
      },
      {discrete: true},
    );

    const nested = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          configExtension(ClickableLinkExtension, {disabled, newTab: false}),
        ],
        name: 'NestedClickableLink',
        parentEditor: parent,
      }),
    );
    onTestFinished(() => {
      nested.dispose();
      parent.dispose();
      open.mockRestore();
      root.remove();
    });
    const nestedRoot = document.createElement('div');
    nestedRoot.contentEditable = 'true';
    parent.getElementByKey(hostKey)!.append(nestedRoot);
    nested.setRootElement(nestedRoot);
    nested.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createLinkNode('https://lexical.dev/').append(
              $createTextNode('Link'),
            ),
          ),
        );
      },
      {discrete: true},
    );

    const event = new MouseEvent('click', {bubbles: true, cancelable: true});
    nestedRoot.querySelector('a')!.dispatchEvent(event);

    if (disabled) {
      expect(open).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } else {
      expect(open).toHaveBeenCalledExactlyOnceWith(
        'https://lexical.dev/',
        '_self',
      );
      expect(event.defaultPrevented).toBe(true);
    }
  },
);
