/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {namedSignals, type NamedSignalsOutput} from '@lexical/extension';
import {
  $findMatchingParent,
  $getNearestNodeFromDOMNode,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  defineExtension,
  getNearestEditorFromDOMNode,
  isDOMNode,
  isHTMLAnchorElement,
  type LexicalEditor,
  registerEventListeners,
  safeCast,
} from 'lexical';

import {LinkExtension} from './LexicalLinkExtension';
import {$isAutoLinkNode, $isLinkNode} from './LexicalLinkNode';

function findMatchingDOM<T extends Node>(
  startNode: Node,
  predicate: (node: Node) => node is T,
): T | null {
  let node: Node | null = startNode;
  while (node != null) {
    if (predicate(node)) {
      return node;
    }
    node = node.parentNode;
  }
  return null;
}

export interface ClickableLinkConfig {
  /** Open clicked links in a new tab when true (default false) */
  newTab: boolean;
  /** Disable this extension when true (default false) */
  disabled: boolean;
}

export function registerClickableLink(
  editor: LexicalEditor,
  stores: NamedSignalsOutput<ClickableLinkConfig>,
  eventOptions: Pick<AddEventListenerOptions, 'signal'> = {},
): () => void {
  const onClick = (event: MouseEvent) => {
    // `click` only fires for the primary button; every other button arrives
    // as `auxclick` (middle, right, and the back / forward buttons). Only the
    // middle button follows the link -- a right click belongs to the context
    // menu, and the history buttons belong to the browser.
    const isMiddle = event.button === 1;
    if (event.type === 'auxclick' && !isMiddle) {
      return;
    }
    const target = event.target;
    if (!isDOMNode(target)) {
      return;
    }
    const nearestEditor = getNearestEditorFromDOMNode(target);

    if (nearestEditor === null) {
      return;
    }

    let url = null;
    let urlTarget = null;
    let isUnlinkedAutolink = false;
    nearestEditor.update(() => {
      const clickedNode = $getNearestNodeFromDOMNode(target);
      if (clickedNode !== null) {
        const maybeLinkNode = $findMatchingParent(clickedNode, $isElementNode);
        if (!stores.disabled.peek()) {
          if ($isLinkNode(maybeLinkNode)) {
            isUnlinkedAutolink =
              $isAutoLinkNode(maybeLinkNode) && maybeLinkNode.getIsUnlinked();
            url = maybeLinkNode.sanitizeUrl(maybeLinkNode.getURL());
            urlTarget = maybeLinkNode.getTarget();
          } else {
            const a = findMatchingDOM(target, isHTMLAnchorElement);
            if (a !== null) {
              url = a.href;
              urlTarget = a.target;
            }
          }
        }
      }
    });

    if (url === null || url === '' || isUnlinkedAutolink) {
      return;
    }

    // Allow user to select link text without following url
    const selection = editor.read('latest', $getSelection);
    if ($isRangeSelection(selection) && !selection.isCollapsed()) {
      event.preventDefault();
      return;
    }

    // eslint-disable-next-line no-restricted-syntax
    window.open(
      url,
      stores.newTab.peek() ||
        isMiddle ||
        event.metaKey ||
        event.ctrlKey ||
        urlTarget === '_blank'
        ? '_blank'
        : '_self',
    );
    event.preventDefault();
  };

  return editor.registerRootListener(rootElement => {
    if (rootElement) {
      // `auxclick` rather than `mouseup`: canceling `mouseup` does not stop
      // the browser from also opening a middle-clicked link in a new tab, so
      // handling the middle button there opened the URL twice. Safari below
      // 18.2 has no `auxclick` at all; there a middle click is left to the
      // browser, which opens the anchor's href -- already sanitized by
      // LinkNode, and absent entirely on an unlinked AutoLinkNode -- in a new
      // tab, for the same result minus the `window.open` call.
      return registerEventListeners(
        rootElement,
        {auxclick: onClick, click: onClick},
        eventOptions,
      );
    }
  });
}

/**
 * Normally in a Lexical editor the `CLICK_COMMAND` on a LinkNode will cause the
 * selection to change instead of opening a link. This extension can be used to
 * restore the default behavior, e.g. when the editor is not editable.
 */
export const ClickableLinkExtension = defineExtension({
  build(editor, config, state) {
    return namedSignals(config);
  },
  config: safeCast<ClickableLinkConfig>({
    disabled: false,
    newTab: false,
  }),
  dependencies: [LinkExtension],
  name: '@lexical/link/ClickableLink',
  register(editor, config, state) {
    return registerClickableLink(editor, state.getOutput());
  },
});
