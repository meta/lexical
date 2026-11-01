/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {computed, EditorStateExtension} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {$isListNode} from '@lexical/list';
import {$isHeadingNode} from '@lexical/rich-text';
import {$getSelection, $isRangeSelection, defineExtension} from 'lexical';

import {MdastEditorExtension} from './MdastEditorExtension';

export type BlockType =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'number'
  | 'check';

interface ToolbarSelectionState {
  blockType: BlockType;
  isBold: boolean;
  isItalic: boolean;
  isCode: boolean;
}

const DEFAULT_SELECTION_STATE: ToolbarSelectionState = {
  blockType: 'paragraph',
  isBold: false,
  isCode: false,
  isItalic: false,
};

function $readSelectionState(): ToolbarSelectionState {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return DEFAULT_SELECTION_STATE;
  }
  const anchorNode = selection.anchor.getNode();
  // Deleting all content can leave the selection on the root, which has no
  // top-level element. Keep the paragraph default and the selection's formats.
  const topLevelElement = anchorNode.getTopLevelElement();
  let blockType: BlockType = 'paragraph';
  if ($isHeadingNode(topLevelElement)) {
    const tag = topLevelElement.getTag();
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      blockType = tag;
    }
  } else if ($isListNode(topLevelElement)) {
    blockType = topLevelElement.getListType();
  }
  return {
    blockType,
    isBold: selection.hasFormat('bold'),
    isCode: selection.hasFormat('code'),
    isItalic: selection.hasFormat('italic'),
  };
}

/**
 * Owns all of the reactive state the formatting toolbar reads, all
 * derived as `computed()` signals off the existing extension outputs:
 *
 * - The selection-derived signals (`blockType`, `isBold`, `isItalic`,
 *   `isCode`) are computed off the {@link EditorStateExtension} signal,
 *   so they recompute lazily whenever the editor state changes.
 * - `canUndo` / `canRedo` are computed off the {@link HistoryExtension}
 *   `historyState` signal. The history state object is mutated in
 *   place, so we also read the editor-state signal as a change
 *   trigger — every editor update is a chance for the stacks to have
 *   changed.
 *
 * The React `<ToolbarPlugin />` component only consumes these signals
 * via `useExtensionSignalValue` and otherwise dispatches commands.
 */
export const ToolbarStateExtension = defineExtension({
  build(editor, _config, state) {
    const editorState = state.getDependency(EditorStateExtension).output;
    const historyState =
      state.getDependency(HistoryExtension).output.historyState;
    const selection = computed(() =>
      editorState.value.read($readSelectionState, {editor}),
    );
    return {
      blockType: computed(() => selection.value.blockType),
      canRedo: computed(() => {
        // The HistoryState object the signal holds is mutated in
        // place by registerHistory (push/pop on the stack arrays,
        // field reassignments on the object), so the signal itself
        // never fires. Read the editor-state signal as a change
        // trigger — every editor update is when the stacks may have
        // changed.
        //
        // TODO: a future version of @lexical/history is expected to
        // expose `canUndo` / `canRedo` signals directly from
        // HistoryExtension, at which point this trigger and the
        // historyState read here can be replaced with a direct
        // dependency on those signals.
        void editorState.value;
        return historyState.value.redoStack.length > 0;
      }),
      canUndo: computed(() => {
        // See the comment on `canRedo` above.
        void editorState.value;
        return historyState.value.undoStack.length > 0;
      }),
      isBold: computed(() => selection.value.isBold),
      isCode: computed(() => selection.value.isCode),
      isItalic: computed(() => selection.value.isItalic),
    };
  },
  dependencies: [MdastEditorExtension, EditorStateExtension, HistoryExtension],
  name: '@lexical/dev-mdast-editor-example/ToolbarState',
});
