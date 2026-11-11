/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  defineExtension,
  type NodeKey,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {CollapsibleExtension} from '../../src/plugins/CollapsibleExtension';
import {
  $createCollapsibleContainerNode,
  $isCollapsibleContainerNode,
} from '../../src/plugins/CollapsibleExtension/CollapsibleContainerNode';
import {$createCollapsibleContentNode} from '../../src/plugins/CollapsibleExtension/CollapsibleContentNode';
import {$createCollapsibleTitleNode} from '../../src/plugins/CollapsibleExtension/CollapsibleTitleNode';

// A <details> container (outside Chrome and Firefox) syncs its open state from
// the element's async `toggle` event. The event can arrive after the node was
// removed or replaced.
describe('CollapsibleContainerNode toggle event', () => {
  for (const change of [
    'removed',
    'removed and the toggle is a real change',
  ] as const) {
    it(`does not throw when the node was ${change}`, () => {
      const errors: unknown[] = [];
      using editor = buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: null,
          dependencies: [CollapsibleExtension],
          name: '[test-collapsible-toggle-removed]',
          onError: (error: Error) => {
            errors.push(error);
          },
        }),
      );
      const root = document.createElement('div');
      root.contentEditable = 'true';
      document.body.appendChild(root);
      editor.setRootElement(root);
      let key: NodeKey = '';
      editor.update(
        () => {
          const container = $createCollapsibleContainerNode(true).append(
            $createCollapsibleTitleNode().append(
              $createParagraphNode().append($createTextNode('title')),
            ),
            $createCollapsibleContentNode().append(
              $createParagraphNode().append($createTextNode('body')),
            ),
          );
          key = container.getKey();
          $getRoot().clear().append(container, $createParagraphNode());
        },
        {discrete: true},
      );
      const dom = editor.getElementByKey(key);
      expect(dom).not.toBe(null);
      editor.update(
        () => {
          $getNodeByKey(key)!.remove();
        },
        {discrete: true},
      );
      if (change !== 'removed' && dom instanceof HTMLDetailsElement) {
        dom.open = false;
      }
      const uncaught: unknown[] = [];
      const listener = (event: ErrorEvent) => {
        uncaught.push(event.error);
        event.preventDefault();
      };
      window.addEventListener('error', listener);
      try {
        dom!.dispatchEvent(new Event('toggle'));
      } catch (error) {
        uncaught.push(error);
      } finally {
        window.removeEventListener('error', listener);
      }
      expect(uncaught).toEqual([]);
      expect(errors).toEqual([]);
      expect(
        editor.read(() =>
          $getRoot().getChildren().some($isCollapsibleContainerNode),
        ),
      ).toBe(false);
      root.remove();
    });
  }

  it('still takes the open state of a container that is in the document', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [CollapsibleExtension],
        name: '[test-collapsible-toggle-live]',
      }),
    );
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    editor.setRootElement(root);
    let key: NodeKey = '';
    editor.update(
      () => {
        const container = $createCollapsibleContainerNode(true).append(
          $createCollapsibleTitleNode().append(
            $createParagraphNode().append($createTextNode('title')),
          ),
          $createCollapsibleContentNode().append(
            $createParagraphNode().append($createTextNode('body')),
          ),
        );
        key = container.getKey();
        $getRoot().clear().append(container, $createParagraphNode());
      },
      {discrete: true},
    );
    const dom = editor.getElementByKey(key);
    if (!(dom instanceof HTMLDetailsElement)) {
      // Chrome and Firefox render a <div> without a toggle listener.
      root.remove();
      return;
    }
    dom.open = false;
    dom.dispatchEvent(new Event('toggle'));
    expect(
      editor.read(() => {
        const node = $getNodeByKey(key);
        return $isCollapsibleContainerNode(node) && node.getOpen();
      }),
    ).toBe(false);
    root.remove();
  });
});
