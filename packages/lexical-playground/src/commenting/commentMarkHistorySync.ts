/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {CommentStore} from './index';

import {$unwrapMarkNode, MarkNode} from '@lexical/mark';
import {
  $nodesOfType,
  HISTORIC_TAG,
  HISTORY_MERGE_TAG,
  type LexicalEditor,
} from 'lexical';

export function $pruneStaleMarkNodeIDs(
  markNode: MarkNode,
  hasThread: (id: string) => boolean,
): void {
  for (const id of markNode.getIDs()) {
    if (!hasThread(id)) {
      markNode.deleteID(id);
    }
  }
  if (markNode.getIDs().length === 0) {
    $unwrapMarkNode(markNode);
  }
}

function $collectMarkIDs(): Set<string> {
  const ids = new Set<string>();
  for (const node of $nodesOfType(MarkNode)) {
    for (const id of node.getIDs()) {
      ids.add(id);
    }
  }
  return ids;
}

export function registerCommentMarkHistorySync(
  editor: LexicalEditor,
  commentStore: CommentStore,
): () => void {
  return editor.registerUpdateListener(
    ({editorState, prevEditorState, tags}) => {
      if (!tags.has(HISTORIC_TAG)) {
        return;
      }
      const before = prevEditorState.read($collectMarkIDs);
      const after = editorState.read($collectMarkIDs);

      for (const id of after) {
        if (!before.has(id) && !commentStore.hasThread(id)) {
          commentStore.restoreThread(id);
        }
      }
      for (const id of before) {
        if (!after.has(id) && commentStore.hasThread(id)) {
          commentStore.retireThread(id);
        }
      }

      const hasDanglingID = Array.from(after).some(
        id => !commentStore.hasThread(id),
      );
      if (!hasDanglingID) {
        return;
      }
      editor.update(
        () => {
          for (const node of $nodesOfType(MarkNode)) {
            $pruneStaleMarkNodeIDs(node, id => commentStore.hasThread(id));
          }
        },
        {tag: HISTORY_MERGE_TAG},
      );
    },
  );
}
