/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$dfsWithSlots} from '@lexical/utils';
import {
  $getRoot,
  $getState,
  $isElementNode,
  $isRootNode,
  $setState,
  COMMAND_PRIORITY_HIGH,
  createState,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  RootNode,
  SELECTION_INSERT_CLIPBOARD_NODES_COMMAND,
} from 'lexical';

export const externalIdState = createState('externalId', {
  parse: value => (typeof value === 'string' ? value : ''),
  resetOnCopyNode: true,
});

/** Application addressing policy: elements, including custom nodes and slots. */
export function $isAddressable(node: LexicalNode): boolean {
  return $isElementNode(node) && !$isRootNode(node);
}

/**
 * Give addressable nodes an application ID. allocateId must return a fresh,
 * nonempty ID across the application's identity domain, including saved data.
 * New addressable nodes get fresh identity on paste, even after a cut.
 * Slots are included through the public, experimental traversal helper.
 */
export function registerApplicationIdentity(
  editor: LexicalEditor,
  allocateId: () => string,
): () => void {
  return mergeRegister(
    editor.registerCommand(
      SELECTION_INSERT_CLIPBOARD_NODES_COMMAND,
      ({nodes}, dispatchEditor) => {
        if (dispatchEditor !== editor) {
          return false;
        }
        for (const subtree of nodes) {
          for (const {node} of $dfsWithSlots(subtree)) {
            // Also clear IDs from a source with broader eligibility (e.g. text).
            $setState(node, externalIdState, externalIdState.defaultValue);
          }
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    ),
    editor.registerNodeTransform(RootNode, root => {
      // Root transforms also run after ordinary edits. This O(N) sweep covers
      // custom nodes and insertion-created wrappers without a node-class list.
      for (const {node} of $dfsWithSlots(root)) {
        if ($isAddressable(node) && $getState(node, externalIdState) === '') {
          $setState(node, externalIdState, allocateId());
        }
      }
    }),
  );
}

/** Preserve saved IDs and register the app's ad hoc config before $copyNode. */
export function loadApplicationDocument(
  editor: LexicalEditor,
  json: string,
): void {
  const state = editor.parseEditorState(json, () => {
    for (const {node} of $dfsWithSlots($getRoot())) {
      $getState(node, externalIdState);
    }
  });
  editor.setEditorState(state);
}
