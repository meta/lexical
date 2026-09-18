/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getRoot,
  $getSelection,
  $getSlotFrame,
  $getSlotHost,
  $isBlockFullySelected,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isRootNode,
  $selectAll,
  COMMAND_PRIORITY_LOW,
  defineExtension,
  type LexicalNode,
  mergeRegister,
  safeCast,
  SELECT_ALL_COMMAND,
} from 'lexical';

import {namedSignals} from './namedSignals';
import {PreventSelectAllExtension} from './PreventSelectAllExtension';
import {effect} from './signals';

function $hasCommonTopParent(
  nodes: readonly LexicalNode[],
  commonTopParent: LexicalNode,
): boolean {
  return nodes.every(node => commonTopParent.is(node.getTopLevelElement()));
}

export interface SelectBlockConfig {
  /** `true` to disable this extension */
  disabled: boolean;
  /** `true` to trigger selectAll if all content is selected in the nested editor */
  cascadeSelection: boolean;
}

/**
 * This extension includes block selection.
 * If you press Ctrl + A, the nearest block element, for example paragraph, is selected first.
 * Pressing Ctrl + A again selects all content in the document. A selection
 * that already spans multiple blocks expands directly to the whole document.
 */
export const SelectBlockExtension = defineExtension({
  build: (editor, config, state) => namedSignals(config),
  config: safeCast<SelectBlockConfig>({
    cascadeSelection: false,
    disabled: false,
  }),
  dependencies: [PreventSelectAllExtension],
  name: '@lexical/extension/SelectBlock',
  register: (editor, config, state) => {
    const stores = state.getOutput();
    const preventSelectAllStores = state.getDependency(
      PreventSelectAllExtension,
    ).output;
    return mergeRegister(
      // PreventSelectAllExtension is only a dependency in support of this
      // extension, so its disabled state is kept in sync
      effect(() => {
        preventSelectAllStores.disabled.value = stores.disabled.value;
      }),
      effect(() => {
        if (!stores.disabled.value) {
          return editor.registerCommand(
            SELECT_ALL_COMMAND,
            (event, triggerEditor) => {
              if (triggerEditor !== editor) {
                // The command bubbled up from a nested editor. Without
                // cascadeSelection it is ignored so that the nested editor's
                // own handlers (e.g. RichTextExtension) take care of it. With
                // cascadeSelection it is only handled when the nested
                // editor's content is already fully selected.
                if (!stores.cascadeSelection.peek()) {
                  return false;
                }
                // read('pending') reflects an update in progress or queued
                // in the nested editor (such as its initial state) without
                // flushing it, which would not be safe if its update is
                // still in progress
                const isAllSelected = triggerEditor.read('pending', () => {
                  const nestedSelection = $getSelection();
                  return (
                    $isRangeSelection(nestedSelection) &&
                    $isBlockFullySelected($getRoot(), nestedSelection)
                  );
                });

                if (!isAllSelected) {
                  return false;
                }

                $selectAll();
                return true;
              }

              const selection = $getSelection();
              if ($isNodeSelection(selection)) {
                const selectedNodes = selection.getNodes();
                const firstNode = selectedNodes[0];
                if (!firstNode) {
                  // An empty NodeSelection, defer to the default handlers
                  return false;
                }

                const topParent = firstNode.getTopLevelElement();
                if (
                  !topParent ||
                  $isRootNode(topParent) ||
                  topParent.is(firstNode) ||
                  // if multiple nodes are selected and they do not share a common ancestor
                  (selectedNodes.length > 1 &&
                    !$hasCommonTopParent(selectedNodes, topParent))
                ) {
                  $selectAll();
                  // This is type narrowing.
                  // If firstNode is a decorator, then it is equal to topParent
                } else if ($isElementNode(topParent)) {
                  topParent.select(0, topParent.getChildrenSize());
                }
                return true;
              }

              if (!$isRangeSelection(selection)) {
                return false;
              }

              const anchorNode = selection.anchor.getNode();
              const blockNode = anchorNode.getTopLevelElement();
              if (
                blockNode &&
                // A selection that crosses block boundaries expands to the
                // next enclosing scope instead of shrinking to the anchor's
                // block
                blockNode.is(selection.focus.getNode().getTopLevelElement()) &&
                // an empty block is fully selected by its caret
                !$isBlockFullySelected(blockNode, selection)
              ) {
                blockNode.select(0, blockNode.getChildrenSize());
                return true;
              }
              // Named slots are isolated sub-scopes between the block and
              // the document: expand to the innermost enclosing slot frame
              // that is not yet fully selected before escalating to the
              // whole document, walking outward through nested frames. A
              // frame whose single block is already fully selected counts
              // as fully selected itself, so a one-block slot escalates
              // straight to the next scope with no dead press.
              let frame = $getSlotFrame(anchorNode);
              while (frame !== null) {
                if (
                  $isElementNode(frame) &&
                  !$isBlockFullySelected(frame, selection)
                ) {
                  frame.select(0, frame.getChildrenSize());
                  return true;
                }
                const host = $getSlotHost(frame);
                frame = host === null ? null : $getSlotFrame(host);
              }
              if (!$isBlockFullySelected($getRoot(), selection)) {
                // don't trigger selectAll if the document is already
                // fully selected
                $selectAll();
              }
              return true;
            },
            // This must be in a higher priority bucket than
            // COMMAND_PRIORITY_EDITOR (e.g. not COMMAND_PRIORITY_BEFORE_EDITOR)
            // for cascadeSelection to work. Listeners run for all editors in
            // priority bucket order (nested editor first within each bucket),
            // so an EDITOR bucket listener here would run after the nested
            // editor's own RichTextExtension SELECT_ALL_COMMAND handler.
            COMMAND_PRIORITY_LOW,
          );
        }
      }),
    );
  },
});
