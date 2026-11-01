/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createNodeSelection,
  $getNearestNodeFromDOMNode,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_BEFORE_EDITOR,
  getActiveElement,
  getDOMSelection,
  isHTMLElement,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  type NodeKey,
} from 'lexical';

/**
 * Promote a click on a slot host's chrome — the border / padding *outside* its
 * `data-lexical-slot` wrappers — to a whole-node NodeSelection, and suppress
 * the native caret the browser would otherwise drop at the mousedown point.
 * Shared by the Card and PullQuote demos: both are slot hosts whose chrome
 * selects the whole node, while a click inside a slot must enter that slot.
 *
 * Returns a cleanup function (it registers a CLICK_COMMAND handler and a root
 * mousedown listener), so add it to the host extension's `mergeRegister`.
 */
export function registerHostChromeSelection<T extends LexicalNode>(
  editor: LexicalEditor,
  $isHost: (node: LexicalNode | null | undefined) => node is T,
): () => void {
  let mouseDownHostKey: NodeKey | null = null;

  // Resolve a click / mousedown target to the host node a chrome interaction
  // should select, or null when the target is inside one of the host's editable
  // slots (where the caret must enter the slot normally). The slots ride in
  // keyless `<div data-lexical-slot="...">` reconciler wrappers, so without the
  // explicit guard $getNearestNodeFromDOMNode would walk past them to the host
  // and the CLICK_COMMAND would promote, dropping the caret out of the slot the
  // user just clicked into. Only a slot wrapper inside this host's own DOM
  // bails: when the host is itself nested in another host's slot, the OUTER
  // wrapper contains the whole host and must not turn its chrome into a dead
  // zone.
  const $resolveChromeTarget = (target: HTMLElement): T | null => {
    const node = $getNearestNodeFromDOMNode(target);
    if (!$isHost(node)) {
      return null;
    }
    const hostElement = editor.getElementByKey(node.getKey());
    if (hostElement === null || !hostElement.contains(target)) {
      return null;
    }
    const slotWrapper = target.closest('[data-lexical-slot]');
    if (slotWrapper !== null && hostElement.contains(slotWrapper)) {
      return null;
    }
    return node;
  };

  // Suppress the native caret the browser would place at the mousedown point
  // before the CLICK_COMMAND below promotes the chrome click to a whole-node
  // NodeSelection. Without this the caret flashes in the clicked region for a
  // frame, the slot keeps DOM focus (its `:focus-within` highlight stays lit
  // alongside the host's `[data-selected]` outline), and a follow-up Backspace
  // dispatches to the slot's range path instead of the host-delete path.
  // Editable-slot mousedowns fall through so the caret still enters the slot.
  const onChromeMouseDown = (event: MouseEvent) => {
    mouseDownHostKey = null;
    // Read-only mode: leave the reader's native selection alone.
    if (!editor.isEditable()) {
      return;
    }
    const target = event.target;
    if (!isHTMLElement(target)) {
      return;
    }
    const node = editor.read('latest', () => $resolveChromeTarget(target));
    if (node !== null) {
      mouseDownHostKey = node.getKey();
      event.preventDefault();
      const root = editor.getRootElement();
      if (root !== null && root !== getActiveElement(root)) {
        root.focus({preventScroll: true});
        const domSelection = getDOMSelection(root.ownerDocument.defaultView);
        if (domSelection !== null) {
          domSelection.removeAllRanges();
        }
      }
    }
  };

  return mergeRegister(
    // Route the promotion through CLICK_COMMAND (not a DOM onClick) so the
    // selectionchange flows on the same lexical pass and the freshly-set
    // NodeSelection isn't overwritten by the native click → focus → range
    // fallback. BEFORE_EDITOR so it wins the race with the default handlers.
    editor.registerCommand(
      CLICK_COMMAND,
      event => {
        const activeMouseDownKey = mouseDownHostKey;
        mouseDownHostKey = null;
        // Read-only mode never promotes — mirrors the mousedown gate.
        if (!editor.isEditable()) {
          return false;
        }
        const target = event.target;
        if (!isHTMLElement(target)) {
          return false;
        }
        const node = $resolveChromeTarget(target);
        if (node === null || node.getKey() !== activeMouseDownKey) {
          return false;
        }
        event.preventDefault();
        const ns = $createNodeSelection();
        ns.add(node.getKey());
        $setSelection(ns);
        return true;
      },
      COMMAND_PRIORITY_BEFORE_EDITOR,
    ),
    editor.registerRootListener((rootElement, prevRootElement) => {
      mouseDownHostKey = null;
      if (prevRootElement !== null) {
        prevRootElement.removeEventListener('mousedown', onChromeMouseDown);
      }
      if (rootElement !== null) {
        rootElement.addEventListener('mousedown', onChromeMouseDown);
      }
    }),
  );
}
