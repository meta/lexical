/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  batch,
  effect,
  getPeerDependencyFromEditor,
  type HMRExtension,
  namedSignals,
  type ReadonlySignal,
  type Signal,
  signal,
} from '@lexical/extension';
import {
  $isRangeSelection,
  $isRootNode,
  $isTextNode,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  CLEAR_EDITOR_COMMAND,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  COMPOSITION_END_TAG,
  COMPOSITION_START_TAG,
  configExtension,
  CUT_TAG,
  defineExtension,
  type EditorState,
  HISTORIC_TAG,
  HISTORY_MERGE_TAG,
  HISTORY_PUSH_TAG,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  type NodeKey,
  PASTE_TAG,
  REDO_COMMAND,
  safeCast,
  UNDO_COMMAND,
} from 'lexical';

type MergeAction = 0 | 1 | 2;
const HISTORY_MERGE = 0;
const HISTORY_PUSH = 1;
const DISCARD_HISTORY_CANDIDATE = 2;

type ChangeType = 0 | 1 | 2 | 3 | 4;
const OTHER = 0;
const COMPOSING_CHARACTER = 1;
const INSERT_CHARACTER_AFTER_SELECTION = 2;
const DELETE_CHARACTER_BEFORE_SELECTION = 3;
const DELETE_CHARACTER_AFTER_SELECTION = 4;

export type HistoryStateEntry = {
  editor: LexicalEditor;
  editorState: EditorState;
};
/**
 * The undo/redo history maintained by the history plugin: the `current` entry
 * plus the `undoStack` and `redoStack` of previous and future
 * {@link HistoryStateEntry}s. Create an empty one with
 * {@link createEmptyHistoryState} and pass it to the history plugin to share
 * history across editors.
 */
export type HistoryState = {
  current: null | HistoryStateEntry;
  redoStack: HistoryStateEntry[];
  undoStack: HistoryStateEntry[];
};

type IntentionallyMarkedAsDirtyElement = boolean;

function getDirtyNodes(
  editorState: EditorState,
  dirtyLeaves: Set<NodeKey>,
  dirtyElements: Map<NodeKey, IntentionallyMarkedAsDirtyElement>,
): LexicalNode[] {
  const nodeMap = editorState._nodeMap;
  const nodes = [];

  for (const dirtyLeafKey of dirtyLeaves) {
    const dirtyLeaf = nodeMap.get(dirtyLeafKey);

    if (dirtyLeaf !== undefined) {
      nodes.push(dirtyLeaf);
    }
  }

  for (const [dirtyElementKey, intentionallyMarkedAsDirty] of dirtyElements) {
    if (!intentionallyMarkedAsDirty) {
      continue;
    }

    const dirtyElement = nodeMap.get(dirtyElementKey);

    if (dirtyElement !== undefined && !$isRootNode(dirtyElement)) {
      nodes.push(dirtyElement);
    }
  }

  return nodes;
}

function getChangeType(
  prevEditorState: null | EditorState,
  nextEditorState: EditorState,
  dirtyLeavesSet: Set<NodeKey>,
  dirtyElementsSet: Map<NodeKey, IntentionallyMarkedAsDirtyElement>,
  isComposing: boolean,
): ChangeType {
  if (
    prevEditorState === null ||
    (dirtyLeavesSet.size === 0 && dirtyElementsSet.size === 0 && !isComposing)
  ) {
    return OTHER;
  }

  const nextSelection = nextEditorState._selection;
  const prevSelection = prevEditorState._selection;

  if (isComposing) {
    return COMPOSING_CHARACTER;
  }

  if (
    !$isRangeSelection(nextSelection) ||
    !$isRangeSelection(prevSelection) ||
    !prevSelection.isCollapsed() ||
    !nextSelection.isCollapsed()
  ) {
    return OTHER;
  }

  const dirtyNodes = getDirtyNodes(
    nextEditorState,
    dirtyLeavesSet,
    dirtyElementsSet,
  );

  if (dirtyNodes.length === 0) {
    return OTHER;
  }

  // Catching the case when inserting new text node into an element (e.g. first char in paragraph/list),
  // or after existing node.
  if (dirtyNodes.length > 1) {
    const nextNodeMap = nextEditorState._nodeMap;
    const nextAnchorNode = nextNodeMap.get(nextSelection.anchor.key);
    const prevAnchorNode = nextNodeMap.get(prevSelection.anchor.key);

    if (
      nextAnchorNode &&
      prevAnchorNode &&
      !prevEditorState._nodeMap.has(nextAnchorNode.__key) &&
      $isTextNode(nextAnchorNode) &&
      nextAnchorNode.__text.length === 1 &&
      nextSelection.anchor.offset === 1
    ) {
      return INSERT_CHARACTER_AFTER_SELECTION;
    }

    return OTHER;
  }

  const nextDirtyNode = dirtyNodes[0];

  const prevDirtyNode = prevEditorState._nodeMap.get(nextDirtyNode.__key);

  if (
    !$isTextNode(prevDirtyNode) ||
    !$isTextNode(nextDirtyNode) ||
    prevDirtyNode.__mode !== nextDirtyNode.__mode
  ) {
    return OTHER;
  }

  const prevText = prevDirtyNode.__text;
  const nextText = nextDirtyNode.__text;

  if (prevText === nextText) {
    return OTHER;
  }

  const nextAnchor = nextSelection.anchor;
  const prevAnchor = prevSelection.anchor;

  if (nextAnchor.key !== prevAnchor.key || nextAnchor.type !== 'text') {
    return OTHER;
  }

  const nextAnchorOffset = nextAnchor.offset;
  const prevAnchorOffset = prevAnchor.offset;
  const textDiff = nextText.length - prevText.length;

  if (textDiff === 1 && prevAnchorOffset === nextAnchorOffset - 1) {
    return INSERT_CHARACTER_AFTER_SELECTION;
  }

  if (textDiff === -1 && prevAnchorOffset === nextAnchorOffset + 1) {
    return DELETE_CHARACTER_BEFORE_SELECTION;
  }

  if (textDiff === -1 && prevAnchorOffset === nextAnchorOffset) {
    return DELETE_CHARACTER_AFTER_SELECTION;
  }

  return OTHER;
}

function isTextNodeUnchanged(
  key: NodeKey,
  prevEditorState: EditorState,
  nextEditorState: EditorState,
): boolean {
  const prevNode = prevEditorState._nodeMap.get(key);
  const nextNode = nextEditorState._nodeMap.get(key);

  const prevSelection = prevEditorState._selection;
  const nextSelection = nextEditorState._selection;
  const isDeletingLine =
    $isRangeSelection(prevSelection) &&
    $isRangeSelection(nextSelection) &&
    prevSelection.anchor.type === 'element' &&
    prevSelection.focus.type === 'element' &&
    nextSelection.anchor.type === 'text' &&
    nextSelection.focus.type === 'text';

  if (
    !isDeletingLine &&
    $isTextNode(prevNode) &&
    $isTextNode(nextNode) &&
    prevNode.__parent === nextNode.__parent
  ) {
    // This has the assumption that object key order won't change if the
    // content did not change, which should normally be safe given
    // the manner in which nodes and exportJSON are typically implemented.
    return (
      JSON.stringify(prevEditorState.read(() => prevNode.exportJSON())) ===
      JSON.stringify(nextEditorState.read(() => nextNode.exportJSON()))
    );
  }
  return false;
}

function createMergeActionGetter(
  editor: LexicalEditor,
  delayOrStore: number | ReadonlySignal<number>,
  dateNow: () => number,
): (
  prevEditorState: null | EditorState,
  nextEditorState: EditorState,
  currentHistoryEntry: null | HistoryStateEntry,
  dirtyLeaves: Set<NodeKey>,
  dirtyElements: Map<NodeKey, IntentionallyMarkedAsDirtyElement>,
  tags: Set<string>,
) => MergeAction {
  let prevChangeTime = dateNow();
  let prevChangeType = OTHER;
  let compositionStartTime = prevChangeTime;
  let compositionStartChangeType = OTHER;
  let compositionStartState: EditorState | null = null;

  return (
    prevEditorState,
    nextEditorState,
    currentHistoryEntry,
    dirtyLeaves,
    dirtyElements,
    tags,
  ) => {
    const changeTime = dateNow();

    if (tags.has(COMPOSITION_START_TAG)) {
      compositionStartTime = prevChangeTime;
      compositionStartChangeType = prevChangeType;
      compositionStartState = prevEditorState;
    }

    // If applying changes from history stack there's no need
    // to run history logic again, as history entries already calculated
    if (tags.has(HISTORIC_TAG)) {
      prevChangeType = OTHER;
      prevChangeTime = changeTime;
      return DISCARD_HISTORY_CANDIDATE;
    }

    const isCompositionEnd = tags.has(COMPOSITION_END_TAG);
    if (isCompositionEnd && compositionStartState) {
      prevChangeTime = compositionStartTime;
      prevChangeType = compositionStartChangeType;
      prevEditorState = compositionStartState;
    }

    // A paste or cut is never a continuation of the surrounding typing, so
    // classify it as OTHER. This both prevents it from merging into the
    // preceding keystrokes and, because it becomes `prevChangeType`, stops the
    // following keystrokes from merging into it — giving the clipboard
    // operation its own undo entry (see #8609). Centralizing this here means any
    // update carrying these tags gets an undo boundary, regardless of which
    // handler produced it.
    const changeType =
      tags.has(PASTE_TAG) || tags.has(CUT_TAG)
        ? OTHER
        : getChangeType(
            prevEditorState,
            nextEditorState,
            dirtyLeaves,
            dirtyElements,
            editor.isComposing(),
          );

    const mergeAction = (() => {
      const isSameEditor =
        currentHistoryEntry === null || currentHistoryEntry.editor === editor;
      const shouldPushHistory = tags.has(HISTORY_PUSH_TAG);
      const shouldMergeHistory =
        !shouldPushHistory && isSameEditor && tags.has(HISTORY_MERGE_TAG);

      if (shouldMergeHistory) {
        return HISTORY_MERGE;
      }

      if (changeType === COMPOSING_CHARACTER) {
        return DISCARD_HISTORY_CANDIDATE;
      }

      if (prevEditorState === null) {
        return HISTORY_PUSH;
      }

      const selection = nextEditorState._selection;
      const hasDirtyNodes = dirtyLeaves.size > 0 || dirtyElements.size > 0;

      if (!hasDirtyNodes) {
        if (selection !== null) {
          return HISTORY_MERGE;
        }

        return DISCARD_HISTORY_CANDIDATE;
      }

      const delay =
        typeof delayOrStore === 'number' ? delayOrStore : delayOrStore.peek();
      if (
        shouldPushHistory === false &&
        changeType !== OTHER &&
        changeType === prevChangeType &&
        changeTime < prevChangeTime + delay &&
        isSameEditor
      ) {
        return HISTORY_MERGE;
      }

      // A single node might have been marked as dirty, but not have changed
      // due to some node transform reverting the change.
      if (dirtyLeaves.size === 1) {
        const dirtyLeafKey = Array.from(dirtyLeaves)[0];
        if (
          isTextNodeUnchanged(dirtyLeafKey, prevEditorState, nextEditorState)
        ) {
          return HISTORY_MERGE;
        }
      }

      return HISTORY_PUSH;
    })();

    prevChangeTime = changeTime;
    prevChangeType = changeType;

    return mergeAction;
  };
}

/**
 * Build the entry that reverses `historyStateEntry` and belongs on the
 * opposite stack.
 *
 * With a single editor this is always `current`, since `current` tracks the
 * live state of that editor. With a shared {@link HistoryState} the stacks
 * interleave entries from several editors, so `current` may belong to an
 * editor that is *not* about to change — pushing it would record a no-op and
 * lose the state we are about to overwrite. In that case read the live state
 * off the entry's own editor instead.
 */
function getInverseEntry(
  historyStateEntry: HistoryStateEntry,
  current: null | HistoryStateEntry,
): null | HistoryStateEntry {
  if (current !== null && current.editor === historyStateEntry.editor) {
    return current;
  }
  const {editor} = historyStateEntry;
  const editorState = editor.getEditorState();
  // An empty EditorState can not be restored (setEditorState throws), so
  // there is nothing to reverse to.
  return editorState.isEmpty() ? null : {editor, editorState};
}

/**
 * Build the entry that an update from `editor` pushes onto the undo stack.
 *
 * `current` is the state to restore when this update is undone, but with a
 * shared {@link HistoryState} it may belong to a different editor — one that
 * is not changing here, so restoring it would be a no-op and the state that is
 * about to be overwritten would never make it onto the stack. Record this
 * editor's own pre-update state in that case.
 */
function getUndoEntry(
  editor: LexicalEditor,
  prevEditorState: EditorState,
  current: null | HistoryStateEntry,
): null | HistoryStateEntry {
  if (current === null) {
    return null;
  }
  if (current.editor === editor) {
    return {...current};
  }
  // An empty EditorState can not be restored (setEditorState throws). Skipping
  // it mirrors the way the first update of an editor is not undoable.
  return prevEditorState.isEmpty()
    ? null
    : {editor, editorState: prevEditorState};
}

function redo(
  editor: LexicalEditor,
  historyState: HistoryState,
  onChange?: (state: HistoryState) => void,
): void {
  const redoStack = historyState.redoStack;
  const undoStack = historyState.undoStack;

  if (redoStack.length !== 0) {
    const current = historyState.current;
    const historyStateEntry = redoStack.pop();

    if (historyStateEntry) {
      const inverseEntry = getInverseEntry(historyStateEntry, current);

      if (inverseEntry !== null) {
        undoStack.push(inverseEntry);
        editor.dispatchCommand(CAN_UNDO_COMMAND, true);
      }
    }

    if (redoStack.length === 0) {
      editor.dispatchCommand(CAN_REDO_COMMAND, false);
    }

    historyState.current = historyStateEntry || null;

    if (onChange) {
      onChange(historyState);
    }

    if (historyStateEntry) {
      historyStateEntry.editor.setEditorState(historyStateEntry.editorState, {
        tag: HISTORIC_TAG,
      });
    }
  }
}

function undo(
  editor: LexicalEditor,
  historyState: HistoryState,
  onChange?: (state: HistoryState) => void,
): void {
  const redoStack = historyState.redoStack;
  const undoStack = historyState.undoStack;
  const undoStackLength = undoStack.length;

  if (undoStackLength !== 0) {
    const current = historyState.current;
    const historyStateEntry = undoStack.pop();

    if (historyStateEntry) {
      const inverseEntry = getInverseEntry(historyStateEntry, current);

      if (inverseEntry !== null) {
        redoStack.push(inverseEntry);
        editor.dispatchCommand(CAN_REDO_COMMAND, true);
      }
    }

    if (undoStack.length === 0) {
      editor.dispatchCommand(CAN_UNDO_COMMAND, false);
    }

    historyState.current = historyStateEntry || null;

    if (onChange) {
      onChange(historyState);
    }

    if (historyStateEntry) {
      historyStateEntry.editor.setEditorState(historyStateEntry.editorState, {
        tag: HISTORIC_TAG,
      });
    }
  }
}

function clearHistory(
  historyState: HistoryState,
  onChange?: (state: HistoryState) => void,
): void {
  historyState.undoStack = [];
  historyState.redoStack = [];
  historyState.current = null;
  if (onChange) {
    onChange(historyState);
  }
}

/**
 * Registers necessary listeners to manage undo/redo history stack and related editor commands.
 * It returns `unregister` callback that cleans up all listeners and should be called on editor unmount.
 * @param editor - The lexical editor.
 * @param historyState - The history state, containing the current state and the undo/redo stack.
 * @param delay - The time (in milliseconds) the editor should delay generating a new history stack,
 * instead of merging the current changes with the current stack.
 * @param dateNow - The clock function used for delay-based merging.
 * @param onHistoryStateChange - Optional callback invoked once on registration
 * and again any time `historyState` is mutated (push, pop, clear, etc.). It is
 * NOT invoked when a candidate update is discarded without changing the
 * stacks. Useful for keeping derived values (e.g. signals) in sync with the
 * current `HistoryState`.
 * @param maxDepth - The maximum number of entries the undo stack may hold.
 * When the cap is exceeded a new history event has been pushed the oldest
 * entries are dropped from the front of the stack until the stack length is
 * `maxDepth`. Pass `null` (the default) to keep the stack unbounded — the
 * historical behavior. May be a plain number or a `ReadonlySignal<number | null>`
 * for reactive reconfiguration.
 * @returns The listeners cleanup callback function.
 */
export function registerHistory(
  editor: LexicalEditor,
  historyState: HistoryState,
  delay: number | ReadonlySignal<number>,
  dateNow: () => number = Date.now,
  onHistoryStateChange?: (state: HistoryState) => void,
  maxDepth: number | null | ReadonlySignal<number | null> = null,
): () => void {
  const getMergeAction = createMergeActionGetter(editor, delay, dateNow);
  const readMaxDepth = (): number | null =>
    typeof maxDepth === 'number' || maxDepth === null
      ? maxDepth
      : maxDepth.peek();

  const notifyChange = () => {
    if (onHistoryStateChange) {
      onHistoryStateChange(historyState);
    }
  };

  const applyChange = ({
    editorState,
    prevEditorState,
    dirtyLeaves,
    dirtyElements,
    tags,
  }: {
    editorState: EditorState;
    prevEditorState: EditorState;
    dirtyElements: Map<NodeKey, IntentionallyMarkedAsDirtyElement>;
    dirtyLeaves: Set<NodeKey>;
    tags: Set<string>;
  }): void => {
    const current = historyState.current;
    const redoStack = historyState.redoStack;
    const undoStack = historyState.undoStack;
    const currentEditorState = current === null ? null : current.editorState;

    if (current !== null && editorState === currentEditorState) {
      return;
    }

    const mergeAction = getMergeAction(
      prevEditorState,
      editorState,
      current,
      dirtyLeaves,
      dirtyElements,
      tags,
    );

    if (mergeAction === HISTORY_PUSH) {
      if (redoStack.length !== 0) {
        historyState.redoStack = [];
        editor.dispatchCommand(CAN_REDO_COMMAND, false);
      }

      const undoEntry = getUndoEntry(editor, prevEditorState, current);

      if (undoEntry !== null) {
        undoStack.push(undoEntry);
        const cap = readMaxDepth();
        if (cap !== null && undoStack.length > cap) {
          // FIFO-evict the oldest entries so the stack stays at `cap`.
          // Editing the array in place keeps the same `historyState.undoStack`
          // reference that callers (e.g. SharedHistoryExtension) may hold on
          // to.
          undoStack.splice(0, undoStack.length - cap);
        }
        editor.dispatchCommand(CAN_UNDO_COMMAND, true);
      }
    } else if (mergeAction === DISCARD_HISTORY_CANDIDATE) {
      return;
    }

    // Else we merge
    historyState.current = {
      editor,
      editorState,
    };
    notifyChange();
  };

  // Allow consumers (e.g. HistoryExtension) to read pre-populated stacks
  // immediately, without waiting for the first edit.
  notifyChange();

  return mergeRegister(
    editor.registerCommand(
      UNDO_COMMAND,
      () => {
        undo(editor, historyState, onHistoryStateChange);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      REDO_COMMAND,
      () => {
        redo(editor, historyState, onHistoryStateChange);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      CLEAR_EDITOR_COMMAND,
      () => {
        clearHistory(historyState, onHistoryStateChange);
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      CLEAR_HISTORY_COMMAND,
      () => {
        clearHistory(historyState, onHistoryStateChange);
        editor.dispatchCommand(CAN_REDO_COMMAND, false);
        editor.dispatchCommand(CAN_UNDO_COMMAND, false);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerUpdateListener(applyChange),
  );
}

/**
 * Creates an empty history state.
 * @returns - The empty history state, as an object.
 */
export function createEmptyHistoryState(): HistoryState {
  return {
    current: null,
    redoStack: [],
    undoStack: [],
  };
}

export interface HistoryConfig {
  /**
   * The time (in milliseconds) the editor should delay generating a new history stack,
   * instead of merging the current changes with the current stack. The default is 300ms.
   */
  delay: number;
  /**
   * The initial history state, the default is {@link createEmptyHistoryState}.
   */
  createInitialHistoryState: (editor: LexicalEditor) => HistoryState;
  /**
   * Whether history is disabled or not
   */
  disabled: boolean;
  /**
   * The now() function, defaults to Date.now.
   */
  now: () => number;
  /**
   * The maximum number of entries the undo stack may hold. When the cap is
   * exceeded the oldest entries are dropped (FIFO) so the stack stays at this
   * length. Defaults to `null`, which keeps the stack unbounded — the
   * historical behavior. Setting a finite cap is recommended for editors that
   * may receive a very large number of distinct history events (long writing
   * sessions, automated input, etc.) since each entry retains a full
   * `EditorState` snapshot.
   *
   * For reference, ProseMirror's `history()` plugin defaults to `depth: 100`.
   */
  maxDepth: number | null;
}

/** Internal writable signals created during the init phase. */
interface HistoryExtensionInit {
  canRedo: Signal<boolean>;
  canUndo: Signal<boolean>;
}

/**
 * The output signals exposed by {@link HistoryExtension}.
 *
 * Config-derived signals (`delay`, `disabled`, `historyState`, `maxDepth`,
 * `now`) are writable so that peer extensions such as
 * {@link SharedHistoryExtension} can redirect them at runtime.
 * The `canUndo` / `canRedo` signals are **readonly** for
 * consumers — they are derived from the current
 * {@link HistoryState} and kept in sync automatically.
 */
export interface HistoryExtensionOutput {
  /**
   * `true` when there is at least one entry in the redo stack, i.e. the
   * editor can perform a redo.
   */
  canRedo: ReadonlySignal<boolean>;
  /**
   * `true` when there is at least one entry in the undo stack, i.e. the
   * editor can perform an undo.
   */
  canUndo: ReadonlySignal<boolean>;
  /** The merge-delay in milliseconds forwarded to {@link registerHistory}. */
  delay: Signal<number>;
  /** When `true` the history listener is not registered. */
  disabled: Signal<boolean>;
  /** The active {@link HistoryState} instance. */
  historyState: Signal<HistoryState>;
  /**
   * Maximum number of entries the undo stack may hold. `null` disables the
   * cap. Changes apply to the next history event — the current undo stack is
   * not retroactively trimmed when the value is lowered.
   */
  maxDepth: Signal<number | null>;
  /** The clock function forwarded to {@link registerHistory}. */
  now: Signal<() => number>;
}

/**
 * Registers necessary listeners to manage undo/redo history stack and related
 * editor commands, via the \@lexical/history module.
 */
export const HistoryExtension = defineExtension({
  build: (
    editor,
    {delay, createInitialHistoryState, disabled, maxDepth, now},
    state,
  ): HistoryExtensionOutput => {
    // The init phase already created writable Signal<boolean> instances for
    // canUndo/canRedo. Signal<T> extends ReadonlySignal<T>, so exposing them
    // through the HistoryExtensionOutput type (which declares them as
    // ReadonlySignal<boolean>) is sufficient to prevent consumers from
    // mutating them — no computed() wrapper required.
    return {
      ...namedSignals({
        delay,
        disabled,
        historyState: createInitialHistoryState(editor),
        maxDepth,
        now,
      }),
      ...state.getInitResult(),
    };
  },
  config: safeCast<HistoryConfig>({
    createInitialHistoryState: createEmptyHistoryState,
    delay: 300,
    disabled: typeof window === 'undefined',
    maxDepth: null,
    now: Date.now,
  }),
  init: (): HistoryExtensionInit => ({
    canRedo: signal(false),
    canUndo: signal(false),
  }),
  name: '@lexical/history/History',
  register: (editor, config, state) => {
    const {canUndo, canRedo} = state.getInitResult();
    const stores = state.getOutput();
    // Single update path: passing `null` resets both signals (used for the
    // disabled state); passing a HistoryState derives them from its stacks
    // (used by registerHistory on init and after every mutation). The batch
    // ensures subscribers to both signals are only notified once per change.
    const syncFromHistoryState = (historyState: HistoryState | null) =>
      batch(() => {
        canUndo.value =
          historyState != null && historyState.undoStack.length > 0;
        canRedo.value =
          historyState != null && historyState.redoStack.length > 0;
      });
    return effect(() => {
      if (stores.disabled.value) {
        syncFromHistoryState(null);
        return undefined;
      }
      return registerHistory(
        editor,
        stores.historyState.value,
        stores.delay,
        () => stores.now.peek()(),
        syncFromHistoryState,
        stores.maxDepth,
      );
    });
  },
});

const HMR_EXTENSION_NAME = '@lexical/extension/HMR';

function getHistoryPeer(editor: LexicalEditor | null | undefined) {
  return editor
    ? getPeerDependencyFromEditor<typeof HistoryExtension>(
        editor,
        HistoryExtension.name,
      )
    : null;
}

/**
 * Reads `editor`'s HMR restore counter, subscribing the calling effect to it.
 *
 * `HMRExtension` restores an editor's `HistoryState` by assigning a rebuilt
 * one to that editor's signal, which for a shared history would leave this
 * editor and its parent holding two different histories — this editor's own
 * restore replacing the shared object, or the parent's leaving this one
 * pointing at the object the parent no longer uses. Depending on the counter
 * re-runs the sync below after either, which re-links them.
 *
 * A peer lookup by name rather than a dependency: HMRExtension is a
 * development-time extension that most editors do not have.
 */
function hmrRestoreCount(editor: LexicalEditor | null | undefined): number {
  const peer = editor
    ? getPeerDependencyFromEditor<typeof HMRExtension>(
        editor,
        HMR_EXTENSION_NAME,
      )
    : undefined;
  return peer ? peer.output.restoreCount.value : 0;
}

export interface SharedHistoryConfig {
  /**
   * Whether shared history is disabled or not
   */
  disabled: boolean;
  /**
   * The parentEditor to use, by default it is derived from
   * `config.parentEditor` which can be provided by
   * NestedEditorExtension
   */
  parentEditor: LexicalEditor | null;
}

/**
 * Registers necessary listeners to manage undo/redo history stack and related
 * editor commands, via the \@lexical/history module, only if the parent editor
 * has a history plugin implementation.
 */
export const SharedHistoryExtension = defineExtension({
  build: (editor, {disabled, parentEditor}) =>
    namedSignals({
      disabled,
      parentEditor: parentEditor || editor._parentEditor,
    }),
  config: safeCast<SharedHistoryConfig>({
    disabled: false,
    parentEditor: null,
  }),
  dependencies: [
    configExtension(HistoryExtension, {
      disabled: true,
    }),
  ],
  name: '@lexical/history/SharedHistory',
  register(editor, _config, state) {
    return effect(() => {
      const {disabled, parentEditor} = state.getOutput();
      if (!disabled.value) {
        const {output} = state.getDependency(HistoryExtension);
        // Subscribe to both restore counters, so that an HMR reload that
        // rebuilds either editor's history re-links the two.
        hmrRestoreCount(editor);
        hmrRestoreCount(parentEditor.value);
        const parentPeer = getHistoryPeer(parentEditor.value);
        if (!parentPeer) {
          return;
        }
        const parentOutput = parentPeer.output;
        batch(() => {
          output.delay.value = parentOutput.delay.value;
          output.historyState.value = parentOutput.historyState.value;
          output.now.value = parentOutput.now.value;
          // The cap must come from the parent too: the child pushes onto the
          // parent's shared undoStack, so applying the child's own (default
          // null) maxDepth would silently void the limit the app configured.
          output.maxDepth.value = parentOutput.maxDepth.value;
          // Note that toggling the parent history will force this to be changed
          output.disabled.value = parentOutput.disabled.value;
        });
      }
    });
  },
});
