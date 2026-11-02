/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  LexicalNode,
  ParsableSerializedNode,
  SerializedLexicalNode,
  SerializedPartialNode,
} from './LexicalNode';

import createError from '@lexical/internal/createError';
import devInvariant from '@lexical/internal/devInvariant';
import invariant from '@lexical/internal/invariant';

import {
  $isElementNode,
  $isTextNode,
  SELECTION_CHANGE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
} from '.';
import {FULL_RECONCILE, NO_DIRTY_NODES} from './LexicalConstants';
import {
  type AnyLexicalCommand,
  type CommandPayloadType,
  type EditorUpdateOptions,
  LexicalEditor,
  type MapListeners,
  type MutatedNodes,
  type RegisteredNodes,
  resetEditor,
  type Transform,
} from './LexicalEditor';
import {
  cloneEditorState,
  type CompactSerializedEditorState,
  createEmptyEditorState,
  type EditorState,
  editorStateHasDirtySelection,
  type ParsableSerializedEditorState,
  type SerializedEditorState,
} from './LexicalEditorState';
import {
  $garbageCollectDetachedDecorators,
  $garbageCollectDetachedNodes,
} from './LexicalGC';
import {flushRootMutations, initMutationObserver} from './LexicalMutations';
import {$normalizeTextNode} from './LexicalNormalization';
import {$reconcileRoot} from './LexicalReconciler';
import {
  $clampRangeSelectionToSlotFrame,
  $internalCreateSelection,
  $isNodeSelection,
  $isRangeSelection,
  $updateDOMSelection,
  applySelectionTransforms,
  type BaseSelection,
} from './LexicalSelection';
import {$isSlotHost, $setSlot} from './LexicalSlot';
import {
  $getCompositionKey,
  $updateDOMBlockCursorElement,
  findAllLexicalElementsDeep,
  getDOMSelection,
  getEditorPropertyFromDOMNode,
  getEditorStateTextContent,
  getEditorsToPropagate,
  getRegisteredNodeOrThrow,
  getWindow,
  isLexicalEditor,
  removeDOMBlockCursorElement,
  scheduleMicroTask,
  setPendingNodeToClone,
} from './LexicalUtils';

const __DEV__ = process.env.NODE_ENV !== 'production';

let activeEditorState: null | EditorState = null;
let activeEditor: null | LexicalEditor = null;
let isReadOnlyMode = false;
let isAttemptingToRecoverFromReconcilerError = false;
// True for the duration of $commitPendingUpdates (including its listener
// phases and the enqueued update pump at its tail). Commands dispatched while
// this is set — the internal SELECTION_CHANGE_COMMAND dispatch, or user code
// dispatching from a mutation listener, both of which run with
// editor._updating === false — are part of the in-flight update machinery
// rather than a fresh external action, so they must not reset the
// infinite-update-loop budget in triggerCommandListeners.
let isCommittingPendingUpdates = false;
// Tracks editors that have a pending macrotask scheduled to reset their cascade
// budget. See `scheduleCascadeReset`.
const editorsWithPendingCascadeReset = new Set<LexicalEditor>();
const editorsWithPendingSelectionChange = new Set<LexicalEditor>();
// Editors that are notifying the listeners of a commit. See
// `isDispatchingCommitListeners`.
const editorsDispatchingCommitListeners = new Set<LexicalEditor>();
let infiniteTransformCount = 0;

const observerOptions = {
  characterData: true,
  childList: true,
  subtree: true,
};

/**
 * Returns true while the editor is notifying the mutation, decorator, text
 * content, and update listeners of a commit. Committing another update at that
 * point would notify the remaining listeners of the current commit after the
 * listeners of the newer one, with an editor state that is no longer current.
 */
export function isDispatchingCommitListeners(editor: LexicalEditor): boolean {
  return editorsDispatchingCommitListeners.has(editor);
}

/** Returns true if the current editor update context is read-only. */
export function isCurrentlyReadOnlyMode(): boolean {
  return (
    isReadOnlyMode ||
    (activeEditorState !== null && activeEditorState._readOnly)
  );
}

export function errorOnReadOnly(): void {
  if (isReadOnlyMode) {
    invariant(false, 'Cannot use method in read-only mode.');
  }
}

export function errorOnInfiniteTransforms(): void {
  if (infiniteTransformCount > 99) {
    invariant(
      false,
      'One or more transforms are endlessly triggering additional transforms. May have encountered infinite recursion caused by transforms that have their preconditions too lose and/or conflict with each other.',
    );
  }
}

export function getActiveEditorState(): EditorState {
  if (activeEditorState === null) {
    invariant(
      false,
      'Unable to find an active editor state. ' +
        'State helpers or node methods can only be used ' +
        'synchronously during the callback of ' +
        'editor.update(), editor.read(), or editorState.read().%s',
      collectBuildInformation(),
    );
  }

  return activeEditorState;
}

/** @internal */
export function $assumeActiveEditor(editor: LexicalEditor): void {
  // Throw if called outside of an update
  if (getActiveEditorState() !== null && activeEditor === null) {
    activeEditor = editor;
  }
  devInvariant(
    activeEditor === editor,
    'The given editor argument does not match $getEditor() in this context. Use editor.getEditorState().read(..., {editor}) if this cross-editor call is intentional.',
  );
}

export function getActiveEditor(): LexicalEditor {
  if (activeEditor === null) {
    invariant(
      false,
      'Unable to find an active editor. ' +
        'This method can only be used ' +
        'synchronously during the callback of ' +
        'editor.update(), editor.read(), or ' +
        'editor.getEditorState().read(..., {editor}).%s',
      collectBuildInformation(),
    );
  }
  return activeEditor;
}

/**
 * Schedule a full reconcile of the active editor, so that every node is
 * re-rendered through the current {@link EditorDOMRenderConfig} on the next
 * commit. Unlike {@link LexicalNode.markDirty}, this does not clone or
 * otherwise mutate the node map, so no mutation/collaboration listeners
 * observe a change. Must be called within an `editor.update`.
 *
 * @internal
 */
export function $fullReconcile(): void {
  getActiveEditor()._dirtyType = FULL_RECONCILE;
}

function collectBuildInformation(): string {
  let compatibleEditors = 0;
  const incompatibleEditors = new Set<string>();
  const thisVersion = LexicalEditor.version;
  if (typeof window !== 'undefined') {
    for (const node of findAllLexicalElementsDeep(document)) {
      const editor = getEditorPropertyFromDOMNode(node);
      if (isLexicalEditor(editor)) {
        compatibleEditors++;
      } else if (editor) {
        let version = String(
          (
            editor.constructor as (typeof editor)['constructor'] &
              Record<string, unknown>
          ).version || '<0.17.1',
        );
        if (version === thisVersion) {
          version +=
            ' (separately built, likely a bundler configuration issue)';
        }
        incompatibleEditors.add(version);
      }
    }
  }
  let output = ` Detected on the page: ${compatibleEditors} compatible editor(s) with version ${thisVersion}`;
  if (incompatibleEditors.size) {
    output += ` and incompatible editors with versions ${Array.from(
      incompatibleEditors,
    ).join(', ')}`;
  }
  return output;
}

export function internalGetActiveEditor(): LexicalEditor | null {
  return activeEditor;
}

export function internalGetActiveEditorState(): EditorState | null {
  return activeEditorState;
}

/**
 * The EditorState that the active read or update works on, or `null` outside
 * of one. A state whose `_readOnly` is true is frozen, so a package can cache
 * what it derives from it (keyed by the state) for as long as it holds it.
 *
 * @internal
 */
export function INTERNAL_getActiveEditorState(): EditorState | null {
  return activeEditorState;
}

export function $applyTransforms(
  editor: LexicalEditor,
  node: LexicalNode,
  transformsCache: Map<string, Transform<LexicalNode>[]>,
) {
  const type = node.__type;
  const registeredNode = getRegisteredNodeOrThrow(editor, type);
  let transformsArr = transformsCache.get(type);

  if (transformsArr === undefined) {
    transformsArr = Array.from(registeredNode.transforms);
    transformsCache.set(type, transformsArr);
  }

  const transformsArrLength = transformsArr.length;

  for (let i = 0; i < transformsArrLength; i++) {
    transformsArr[i](node);

    if (!node.isAttached()) {
      break;
    }
  }
}

function $isNodeValidForTransform(
  node: LexicalNode,
  compositionKey: null | string,
): boolean {
  return (
    node !== undefined &&
    // We don't want to transform nodes being composed
    node.__key !== compositionKey &&
    node.isAttached()
  );
}

function $normalizeAllDirtyTextNodes(
  editorState: EditorState,
  editor: LexicalEditor,
): void {
  const dirtyLeaves = editor._dirtyLeaves;
  const nodeMap = editorState._nodeMap;

  for (const nodeKey of dirtyLeaves) {
    const node = nodeMap.get(nodeKey);

    if (
      $isTextNode(node) &&
      node.isAttached() &&
      node.isSimpleText() &&
      !node.isUnmergeable()
    ) {
      $normalizeTextNode(node);
    }
  }
}

function addTags(editor: LexicalEditor, tags: undefined | string | string[]) {
  if (!tags) {
    return;
  }
  const updateTags = editor._updateTags;
  let tags_ = tags;
  if (!Array.isArray(tags)) {
    tags_ = [tags];
  }
  for (const tag of tags_) {
    updateTags.add(tag);
  }
}

/**
 * Transform heuristic:
 * 1. We transform leaves first. If transforms generate additional dirty nodes we repeat step 1.
 * The reasoning behind this is that marking a leaf as dirty marks all its parent elements as dirty too.
 * 2. We transform elements. If element transforms generate additional dirty nodes we repeat step 1.
 * If element transforms only generate additional dirty elements we only repeat step 2.
 *
 * Note that to keep track of newly dirty nodes and subtrees we leverage the editor._dirtyNodes and
 * editor._subtrees which we reset in every loop.
 */
function $applyAllTransforms(
  editorState: EditorState,
  editor: LexicalEditor,
): void {
  const dirtyLeaves = editor._dirtyLeaves;
  const dirtyElements = editor._dirtyElements;
  const nodeMap = editorState._nodeMap;
  const compositionKey = $getCompositionKey();
  const transformsCache = new Map();

  let untransformedDirtyLeaves = dirtyLeaves;
  let untransformedDirtyLeavesLength = untransformedDirtyLeaves.size;
  let untransformedDirtyElements = dirtyElements;
  let untransformedDirtyElementsLength = untransformedDirtyElements.size;

  while (
    untransformedDirtyLeavesLength > 0 ||
    untransformedDirtyElementsLength > 0
  ) {
    if (untransformedDirtyLeavesLength > 0) {
      // We leverage editor._dirtyLeaves to track the new dirty leaves after the transforms
      editor._dirtyLeaves = new Set();

      for (const nodeKey of untransformedDirtyLeaves) {
        const node = nodeMap.get(nodeKey);

        if (
          $isTextNode(node) &&
          node.isAttached() &&
          node.isSimpleText() &&
          !node.isUnmergeable()
        ) {
          $normalizeTextNode(node);
        }

        if (
          node !== undefined &&
          $isNodeValidForTransform(node, compositionKey)
        ) {
          $applyTransforms(editor, node, transformsCache);
        }

        dirtyLeaves.add(nodeKey);
      }

      untransformedDirtyLeaves = editor._dirtyLeaves;
      untransformedDirtyLeavesLength = untransformedDirtyLeaves.size;

      // We want to prioritize node transforms over element transforms
      if (untransformedDirtyLeavesLength > 0) {
        infiniteTransformCount++;
        continue;
      }
    }

    // All dirty leaves have been processed. Let's do elements!
    // We have previously processed dirty leaves, so let's restart the editor leaves Set to track
    // new ones caused by element transforms
    editor._dirtyLeaves = new Set();
    editor._dirtyElements = new Map();

    // The root is always considered intentionally dirty if any attached node
    // is dirty and by deleting and re-inserting we will apply its transforms
    // last (e.g. its transform can be used as a sort of "update finalizer")
    const rootDirty = untransformedDirtyElements.delete('root');
    if (rootDirty) {
      untransformedDirtyElements.set('root', true);
    }
    for (const currentUntransformedDirtyElement of untransformedDirtyElements) {
      const nodeKey = currentUntransformedDirtyElement[0];
      const intentionallyMarkedAsDirty = currentUntransformedDirtyElement[1];
      dirtyElements.set(nodeKey, intentionallyMarkedAsDirty);
      if (!intentionallyMarkedAsDirty) {
        continue;
      }

      const node = nodeMap.get(nodeKey);

      if (
        node !== undefined &&
        $isNodeValidForTransform(node, compositionKey)
      ) {
        $applyTransforms(editor, node, transformsCache);
      }
    }

    untransformedDirtyLeaves = editor._dirtyLeaves;
    untransformedDirtyLeavesLength = untransformedDirtyLeaves.size;
    untransformedDirtyElements = editor._dirtyElements;
    untransformedDirtyElementsLength = untransformedDirtyElements.size;
    infiniteTransformCount++;
  }

  editor._dirtyLeaves = dirtyLeaves;
  editor._dirtyElements = dirtyElements;
}

/** Deserializes a SerializedLexicalNode JSON object into its corresponding LexicalNode instance. */
export function $parseSerializedNode(
  // The node's type is not known here — that is what it reads `type` to
  // discover — so this is `SerializedPartialNode`, which carries children and
  // leaves the node-specific properties `unknown`. Naming
  // `SerializedPartial<SerializedLexicalNode>` rejected any element subtree
  // written as a literal, since that type has no `children` at all.
  //
  // `SerializedLexicalNode` is in the union for the callers that hold a real
  // serialized type rather than a literal. An *interface* gets no implicit
  // index signature in TypeScript, so `interface SerializedCustomText extends
  // SerializedTextNode` was not assignable to `SerializedPartialNode` alone —
  // and the whole point of the index signature is that a document stays
  // writable as a literal, which a closed type took away. A union keeps both:
  // a literal is checked against the indexed member, a declared interface
  // against the structural one.
  //
  // `ParsableSerializedNode` is the third for an interface whose `version` is
  // optional, which is the honest shape here: this drops `version`, so
  // requiring it described the caller rather than the parameter — and because
  // `children` and `$slots` recurse, requiring it once rejected the whole
  // subtree.
  serializedNode:
    | SerializedPartialNode
    | SerializedLexicalNode
    | ParsableSerializedNode,
): LexicalNode {
  const internalSerializedNode: ParsableSerializedNode = serializedNode;
  return $parseSerializedNodeImpl(
    internalSerializedNode,
    getActiveEditor()._nodes,
  );
}

function $parseSerializedNodeImpl<
  SerializedNode extends ParsableSerializedNode,
>(
  serializedNode: SerializedNode,
  registeredNodes: RegisteredNodes,
): LexicalNode {
  const type = serializedNode.type;
  const registeredNode = registeredNodes.get(type);

  if (registeredNode === undefined) {
    invariant(false, 'parseEditorState: type "%s" + not found', type);
  }

  const nodeClass = registeredNode.klass;

  if (serializedNode.type !== nodeClass.getType()) {
    invariant(
      false,
      'LexicalNode: Node %s does not implement .importJSON().',
      nodeClass.name,
    );
  }

  const node = nodeClass.importJSON(serializedNode);
  const children = serializedNode.children;

  if ($isElementNode(node) && Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      const serializedJSONChildNode = children[i];
      const childNode = $parseSerializedNodeImpl(
        serializedJSONChildNode,
        registeredNodes,
      );
      node.append(childNode);
    }
  }

  // Slots live in a separate Map on every LexicalNode (an ElementNode or a
  // DecoratorNode host), so re-attach them outside the element branch.
  const slots = serializedNode.$slots;
  if (slots) {
    invariant(
      $isSlotHost(node),
      '$parseSerializedNode: node %s has slots but is not a valid slot host; only ElementNodes and DecoratorNodes can host slots.',
      nodeClass.name,
    );
    for (const name in slots) {
      const slotNode = $parseSerializedNodeImpl(slots[name], registeredNodes);
      $setSlot(node, name, slotNode);
    }
  }

  return node;
}

export function parseEditorState(
  serializedEditorState:
    | SerializedEditorState
    | CompactSerializedEditorState
    | ParsableSerializedEditorState,
  editor: LexicalEditor,
  updateFn: void | (() => void),
): EditorState {
  const editorState = createEmptyEditorState();
  const previousActiveEditorState = activeEditorState;
  const previousReadOnlyMode = isReadOnlyMode;
  const previousActiveEditor = activeEditor;
  const previousDirtyElements = editor._dirtyElements;
  const previousDirtyLeaves = editor._dirtyLeaves;
  const previousCloneNotNeeded = editor._cloneNotNeeded;
  const previousDirtyType = editor._dirtyType;
  editor._dirtyElements = new Map();
  editor._dirtyLeaves = new Set();
  editor._cloneNotNeeded = new Map();
  editor._dirtyType = NO_DIRTY_NODES;
  activeEditorState = editorState;
  isReadOnlyMode = false;
  activeEditor = editor;
  setPendingNodeToClone(null);

  try {
    const registeredNodes = editor._nodes;
    const serializedNode = serializedEditorState.root;
    $parseSerializedNodeImpl(serializedNode, registeredNodes);
    if (updateFn) {
      updateFn();
    }

    // Make the editorState immutable
    editorState._readOnly = true;
    editorState._parsed = true;

    if (__DEV__) {
      handleDEVOnlyPendingUpdateGuarantees(editorState);
    }
  } catch (error) {
    if (error instanceof Error) {
      editor._onError(error);
    }
  } finally {
    editor._dirtyElements = previousDirtyElements;
    editor._dirtyLeaves = previousDirtyLeaves;
    editor._cloneNotNeeded = previousCloneNotNeeded;
    editor._dirtyType = previousDirtyType;
    activeEditorState = previousActiveEditorState;
    isReadOnlyMode = previousReadOnlyMode;
    activeEditor = previousActiveEditor;
  }

  return editorState;
}

// This technically isn't an update but given we need
// exposure to the module's active bindings, we have this
// function here

export function readEditorState<V>(
  editor: LexicalEditor | null,
  editorState: EditorState,
  callbackFn: () => V,
): V {
  const previousActiveEditorState = activeEditorState;
  const previousReadOnlyMode = isReadOnlyMode;
  const previousActiveEditor = activeEditor;

  activeEditorState = editorState;
  isReadOnlyMode = true;
  activeEditor = editor;

  try {
    return callbackFn();
  } finally {
    activeEditorState = previousActiveEditorState;
    isReadOnlyMode = previousReadOnlyMode;
    activeEditor = previousActiveEditor;
  }
}

function handleDEVOnlyPendingUpdateGuarantees(
  pendingEditorState: EditorState,
): void {
  // Given we can't Object.freeze the nodeMap as it's a Map,
  // we instead replace its set, clear and delete methods.
  const nodeMap = pendingEditorState._nodeMap;

  nodeMap.set = () => {
    throw new Error('Cannot call set() on a frozen Lexical node map');
  };

  nodeMap.clear = () => {
    throw new Error('Cannot call clear() on a frozen Lexical node map');
  };

  nodeMap.delete = () => {
    throw new Error('Cannot call delete() on a frozen Lexical node map');
  };
}

export function $commitPendingUpdates(
  editor: LexicalEditor,
  recoveryEditorState?: EditorState,
): void {
  // Not in the recovery from a failed update, which commits inside it, where
  // the flush would run against the failed editor state.
  if (editor._pendingEditorState !== null && activeEditor !== editor) {
    // The commit disconnects the observer, which drops the DOM changes it has
    // recorded but not reported yet, so they are reverted first.
    flushRootMutations(editor, false, true);
  }
  // Save and restore rather than set and clear because the reconciler error
  // recovery path re-enters $commitPendingUpdates, and the enqueued update
  // pump at the tail of a commit can commit discrete updates synchronously.
  const previouslyCommitting = isCommittingPendingUpdates;
  isCommittingPendingUpdates = true;
  try {
    const notificationResult = $notifyPendingSelectionChange(editor);
    $commitPendingUpdatesImpl(editor, recoveryEditorState);
    if (notificationResult) {
      // Report only after preserving the pending edit. Update error recovery
      // would otherwise roll it back, even with a non-throwing error handler.
      editor._onWarn(
        createError(
          'Selection change listeners are endlessly changing the selection.',
        ),
      );
    }
  } finally {
    isCommittingPendingUpdates = previouslyCommitting;
  }
}

function $commitPendingUpdatesImpl(
  editor: LexicalEditor,
  recoveryEditorState?: EditorState,
): void {
  const pendingEditorState = editor._pendingEditorState;
  const rootElement = editor._rootElement;
  const shouldSkipDOM = editor._headless || rootElement === null;

  if (pendingEditorState === null) {
    // Even without a pending state, flush any deferred callbacks that
    // may have been added by a prior update (e.g. via $onUpdate inside
    // editor.focus()). This can happen when another commit consumed
    // the pending editor state before this scheduled commit ran.
    if (!editor._updating && editor._deferred.length > 0) {
      triggerDeferredUpdateCallbacks(editor, editor._deferred);
    }
    return;
  }

  // ======
  // Reconciliation has started.
  // ======

  const currentEditorState = editor._editorState;
  const currentSelection = currentEditorState._selection;
  const pendingSelection = pendingEditorState._selection;
  const needsUpdate = editor._dirtyType !== NO_DIRTY_NODES;
  const previousActiveEditorState = activeEditorState;
  const previousReadOnlyMode = isReadOnlyMode;
  const previousActiveEditor = activeEditor;
  const previouslyUpdating = editor._updating;
  const observer = editor._observer;
  let mutatedNodes = null;
  editor._pendingEditorState = null;
  editor._editorState = pendingEditorState;

  if (!shouldSkipDOM && needsUpdate && observer !== null) {
    activeEditor = editor;
    activeEditorState = pendingEditorState;
    isReadOnlyMode = false;
    // We don't want updates to sync block the reconciliation.
    editor._updating = true;
    try {
      const dirtyType = editor._dirtyType;
      const dirtyElements = editor._dirtyElements;
      const dirtyLeaves = editor._dirtyLeaves;
      observer.disconnect();

      mutatedNodes = $reconcileRoot(
        currentEditorState,
        pendingEditorState,
        editor,
        dirtyType,
        dirtyElements,
        dirtyLeaves,
      );
    } catch (error) {
      // Report errors
      if (error instanceof Error) {
        editor._onError(error);
      }

      // Reset editor and restore incoming editor state to the DOM
      if (!isAttemptingToRecoverFromReconcilerError) {
        resetEditor(editor, null, rootElement, pendingEditorState);
        initMutationObserver(editor);
        editor._dirtyType = FULL_RECONCILE;
        isAttemptingToRecoverFromReconcilerError = true;
        $commitPendingUpdates(editor, currentEditorState);
        isAttemptingToRecoverFromReconcilerError = false;
      } else {
        // To avoid a possible situation of infinite loops, lets throw
        throw error;
      }

      return;
    } finally {
      observer.observe(rootElement, observerOptions);
      editor._updating = previouslyUpdating;
      activeEditorState = previousActiveEditorState;
      isReadOnlyMode = previousReadOnlyMode;
      activeEditor = previousActiveEditor;
    }
  }

  if (!pendingEditorState._readOnly) {
    pendingEditorState._readOnly = true;
    if (__DEV__) {
      handleDEVOnlyPendingUpdateGuarantees(pendingEditorState);
      if ($isRangeSelection(pendingSelection)) {
        Object.freeze(pendingSelection.anchor);
        Object.freeze(pendingSelection.focus);
      }
      Object.freeze(pendingSelection);
    }
  }

  const dirtyLeaves = editor._dirtyLeaves;
  const dirtyElements = editor._dirtyElements;
  const normalizedNodes = editor._normalizedNodes;
  const tags = editor._updateTags;

  if (needsUpdate) {
    editor._dirtyType = NO_DIRTY_NODES;
    editor._cloneNotNeeded.clear();
    editor._dirtyLeaves = new Set();
    editor._dirtyElements = new Map();
    editor._normalizedNodes = new Set();
  }
  // Always reset the accumulated update tags, even when this commit produced no
  // dirty nodes (needsUpdate === false). Tags are added from the `tag` update
  // option independently of whether any node is dirtied, and the 'update'
  // listener below fires for every commit (including no-op ones) with these
  // tags. If we only cleared them when needsUpdate is true, the tags of a no-op
  // update would leak into the *next* update. For collaboration this is a
  // correctness bug: a local edit that immediately follows a remote sync which
  // happened to be a no-op (e.g. a concurrently-deleted node, so nothing
  // reconciles) would inherit the COLLABORATION tag and be skipped by
  // syncLexicalUpdateToYjs, desyncing the peers.
  editor._updateTags = new Set();
  // These callbacks belong to this commit. Commands dispatched by commit
  // listeners may start another update, which must not inherit them and
  // schedule an otherwise empty commit (breaking typing history merging).
  // An outer update still owns its callbacks when it forces an early commit.
  const deferred = editor._deferred;
  if (!previouslyUpdating) {
    editor._deferred = [];
  }
  $garbageCollectDetachedDecorators(editor, pendingEditorState);

  // ======
  // Reconciliation has finished. Now update selection and trigger listeners.
  // ======

  const domSelection = shouldSkipDOM
    ? null
    : getDOMSelection(getWindow(editor));

  // Attempt to update the DOM selection, including focusing of the root element,
  // and scroll into view if needed.
  if (
    editor._editable &&
    // domSelection will be null in headless
    domSelection !== null &&
    (needsUpdate ||
      pendingSelection === null ||
      pendingSelection.dirty ||
      !pendingSelection.is(currentSelection)) &&
    rootElement !== null &&
    !tags.has(SKIP_DOM_SELECTION_TAG)
  ) {
    activeEditor = editor;
    activeEditorState = pendingEditorState;
    try {
      if (observer !== null) {
        observer.disconnect();
      }
      if (needsUpdate || pendingSelection === null || pendingSelection.dirty) {
        const blockCursorElement = editor._blockCursorElement;
        if (blockCursorElement !== null) {
          removeDOMBlockCursorElement(blockCursorElement, editor, rootElement);
        }
        $updateDOMSelection(
          currentSelection,
          pendingSelection,
          editor,
          domSelection,
          tags,
          rootElement,
        );
      }
      $updateDOMBlockCursorElement(editor, rootElement, pendingSelection);
    } finally {
      if (observer !== null) {
        observer.observe(rootElement, observerOptions);
      }
      activeEditor = previousActiveEditor;
      activeEditorState = previousActiveEditorState;
    }
  }

  // Save and restore because a listener can force a nested commit of this
  // editor (e.g. a discrete update), whose listeners run inside this block.
  const previouslyDispatching = editorsDispatchingCommitListeners.has(editor);
  editorsDispatchingCommitListeners.add(editor);
  try {
    if (mutatedNodes !== null) {
      triggerMutationListeners(
        editor,
        mutatedNodes,
        tags,
        dirtyLeaves,
        currentEditorState,
      );
    }
    /**
     * Capture pendingDecorators after garbage collecting detached decorators
     */
    const pendingDecorators = editor._pendingDecorators;
    if (pendingDecorators !== null) {
      editor._decorators = pendingDecorators;
      editor._pendingDecorators = null;
      triggerListeners('decorator', editor, true, pendingDecorators);
    }

    // If reconciler fails, we reset whole editor (so current editor state becomes empty)
    // and attempt to re-render pendingEditorState. If that goes through we trigger
    // listeners, but instead use recoverEditorState which is current editor state before reset
    // This specifically important for collab that relies on prevEditorState from update
    // listener to calculate delta of changed nodes/properties
    triggerTextContentListeners(
      editor,
      recoveryEditorState || currentEditorState,
      pendingEditorState,
    );
    triggerListeners('update', editor, true, {
      dirtyElements,
      dirtyLeaves,
      editorState: pendingEditorState,
      mutatedNodes,
      normalizedNodes,
      prevEditorState: recoveryEditorState || currentEditorState,
      tags,
    });
  } finally {
    if (!previouslyDispatching) {
      editorsDispatchingCommitListeners.delete(editor);
    }
  }
  // A commit can be forced while an outer update is still running (for
  // example, setEditorState() inside editor.update()). Keep $onUpdate
  // callbacks queued so the outer update drains them after updateFn returns.
  if (!previouslyUpdating) {
    triggerDeferredUpdateCallbacks(editor, deferred);
  }
  $triggerEnqueuedUpdates(editor);
}

function triggerTextContentListeners(
  editor: LexicalEditor,
  currentEditorState: EditorState,
  pendingEditorState: EditorState,
): void {
  // Computing the text walks the whole document where no reconcile cached
  // it (a headless editor never has it cached): skipped when nothing
  // listens.
  if (editor._listeners.textcontent.size === 0) {
    return;
  }
  const currentTextContent = getEditorStateTextContent(currentEditorState);
  const latestTextContent = getEditorStateTextContent(pendingEditorState);

  if (currentTextContent !== latestTextContent) {
    triggerListeners('textcontent', editor, true, latestTextContent);
  }
}

function triggerMutationListeners(
  editor: LexicalEditor,
  mutatedNodes: MutatedNodes,
  updateTags: Set<string>,
  dirtyLeaves: Set<string>,
  prevEditorState: EditorState,
): void {
  const listeners = Array.from(editor._listeners.mutation);
  const listenersLength = listeners.length;

  for (let i = 0; i < listenersLength; i++) {
    const [listener, klassSet] = listeners[i];
    for (const klass of klassSet) {
      const mutatedNodesByType = mutatedNodes.get(klass);
      if (mutatedNodesByType !== undefined) {
        listener(mutatedNodesByType, {
          dirtyLeaves,
          prevEditorState,
          updateTags,
        });
      }
    }
  }
}

export function triggerListeners<T extends keyof MapListeners>(
  type: T,
  editor: LexicalEditor,
  isCurrentlyEnqueuingUpdates: boolean,
  ...payload: MapListeners[T]
): void {
  const previouslyUpdating = editor._updating;
  editor._updating = isCurrentlyEnqueuingUpdates;

  try {
    const listenerMap = editor._listeners[type] as Map<
      (...args: MapListeners[T]) => void | undefined | (() => void),
      void | undefined | (() => void)
    >;
    const listeners = Array.from(listenerMap);
    for (const [listener, unregister] of listeners) {
      if (unregister) {
        unregister();
      }
      // TypeScript's void-return rule lets a `=> void` callback return any value,
      // so a listener like `() => arr.push(x)` hands back a number. Only a
      // function is an unregister callback.
      const result = listener(...payload);
      const nextUnregister = typeof result === 'function' ? result : undefined;
      if (listenerMap.has(listener)) {
        listenerMap.set(listener, nextUnregister);
      } else if (nextUnregister) {
        nextUnregister();
      }
    }
  } finally {
    editor._updating = previouslyUpdating;
  }
}

function hasSelectionChanged(
  editor: LexicalEditor,
  selection: null | BaseSelection,
): boolean {
  const previous = editor._lastNotifiedSelection;
  return selection === null ? previous !== null : !selection.is(previous);
}

/** @internal Must run in the editor's pending update. */
export function $dispatchSelectionChangeCommand(
  editor: LexicalEditor,
  selection: null | BaseSelection,
  force = false,
): void {
  if (!force && !hasSelectionChanged(editor, selection)) {
    return;
  }
  editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
}

/** Returns true when listeners exceed the notification limit. */
function $notifyPendingSelectionChange(editor: LexicalEditor): boolean {
  if (editorsWithPendingSelectionChange.has(editor)) {
    return false;
  }
  editorsWithPendingSelectionChange.add(editor);
  try {
    for (let count = 0; editor._pendingEditorState !== null; count++) {
      const pending = editor._pendingEditorState;
      const selection = pending._selection;
      const root = editor._rootElement;
      if (!hasSelectionChanged(editor, selection)) {
        return false;
      }
      const skipNotification =
        (selection === null || $isRangeSelection(selection)) &&
        (editor._headless || root === null || !root.isConnected);
      if (skipNotification || count === 100) {
        // Do not replay skipped notifications after reconnecting the root or
        // after stopping a listener loop.
        editor._lastNotifiedSelection =
          selection === null ? null : selection.clone();
        return !skipNotification;
      }
      // Extend the pending update, including its normal error handling. The
      // caller owns the commit, so listener edits and transforms join it.
      $beginUpdate(
        editor,
        () => editor.dispatchCommand(SELECTION_CHANGE_COMMAND),
        undefined,
        true,
      );
    }
    return false;
  } finally {
    editorsWithPendingSelectionChange.delete(editor);
  }
}

export function triggerCommandListeners<TCommand extends AnyLexicalCommand>(
  editor: LexicalEditor,
  type: TCommand,
  payload: CommandPayloadType<TCommand>,
  fromEditor: LexicalEditor,
): boolean {
  const editors = getEditorsToPropagate(editor);
  let updatingParentEditor: undefined | LexicalEditor;

  // A dispatched command is a fresh, externally-triggered action (a keystroke,
  // paste, selection change, etc.), not part of an in-flight update-listener
  // cascade. Reset the cascade budget for the editors it touches so the
  // infinite-update-loop detector measures recursion depth *within a single
  // action* rather than accumulating across many independent actions. This
  // makes the guard robust to fast/synchronous input bursts (rapid typing, key
  // repeat) that don't yield to the event loop between keystrokes.
  //
  // Two guards keep cascade-internal dispatches from resetting the budget,
  // which would otherwise let a runaway loop that dispatches a command each
  // cycle defeat the detector entirely:
  // - editor._updating is true while update/textcontent/decorator listeners
  //   and deferred callbacks run (see triggerListeners), covering commands
  //   dispatched from those contexts.
  // - isCommittingPendingUpdates is true for the whole of
  //   $commitPendingUpdates, covering the internal SELECTION_CHANGE_COMMAND
  //   dispatch (inside an update) as well as commands dispatched from mutation
  //   listeners, which can run with editor._updating === false.
  // Genuine external input can never arrive in the middle of a commit because
  // the commit is synchronous, so neither guard weakens the per-action reset.
  if (!isCommittingPendingUpdates) {
    for (let e = 0; e < editors.length; e++) {
      if (!editors[e]._updating) {
        editors[e]._cascadeCount = 0;
      }
    }
  }

  if (type === SELECTION_CHANGE_COMMAND) {
    if (activeEditor !== editor || isReadOnlyMode) {
      let handled = false;
      updateEditorSync(editor, () => {
        handled = triggerCommandListeners(editor, type, payload, fromEditor);
      });
      return handled;
    }
    // Count every dispatch, including explicit calls by applications. Capture
    // before listeners run so their selection changes can notify in turn.
    const selection = getActiveEditorState()._selection;
    editor._lastNotifiedSelection =
      selection === null ? null : selection.clone();
  }

  for (let i = 4; i >= 0; i--) {
    for (let e = 0; e < editors.length; e++) {
      const currentEditor = editors[e];
      if (e > 0 && currentEditor._updating) {
        // We can't synchronously update an already updating editor without
        // creating an early commit that will potentially corrupt the
        // nodeMap by doing GC too early.
        updatingParentEditor = currentEditor;
        break;
      }
      const commandListeners = currentEditor._commands;
      const listenerInPriorityOrder = commandListeners.get(type);

      if (listenerInPriorityOrder !== undefined) {
        const listenersSet = listenerInPriorityOrder[i];
        if (listenersSet.size > 0) {
          let returnVal = false;
          updateEditorSync(currentEditor, () => {
            for (const listener of listenersSet) {
              if (listener(payload, fromEditor)) {
                returnVal = true;
                return;
              }
            }
          });
          if (returnVal) {
            return returnVal;
          }
        }
      }
    }
  }
  if (updatingParentEditor) {
    // Preserve the fairly broken legacy semantics of command delegation to fix
    // https://github.com/meta/lexical/issues/8306
    updatingParentEditor.update(() => {
      // This will be async so we can't know the result
      triggerCommandListeners(updatingParentEditor, type, payload, fromEditor);
    });
  }

  return false;
}

function scheduleCascadeReset(editor: LexicalEditor): void {
  // The cascade budget (`_cascadeCount`) is meant to catch *non-terminating*
  // recursion — an update listener that synchronously re-enqueues more work
  // without a stop condition. Such a runaway is a microtask storm: it never
  // yields control back to the event loop, so a macrotask scheduled here is
  // starved and never runs before the budget is exhausted and the guard trips.
  //
  // By contrast, heavy-but-bounded activity (e.g. fast typing while an
  // autocomplete listener re-enqueues one ghost-sync update per commit) is
  // driven by separate user input events. The queue stays bounded and control
  // returns to the event loop between actions, which lets this macrotask run
  // and reset the budget — so legitimate sustained activity never accumulates
  // toward the limit. This is what distinguishes throughput from recursion.
  if (editorsWithPendingCascadeReset.has(editor)) {
    return;
  }
  editorsWithPendingCascadeReset.add(editor);
  setTimeout(() => {
    editorsWithPendingCascadeReset.delete(editor);
    editor._cascadeCount = 0;
  }, 0);
}

function $triggerEnqueuedUpdates(editor: LexicalEditor): void {
  const queuedUpdates = editor._updates;

  if (queuedUpdates.length === 0) {
    editor._cascadeCount = 0;
    return;
  }
  // Arrange for the cascade budget to be reset once control returns to the
  // event loop. Genuine non-terminating recursion is a synchronous microtask
  // storm that starves this macrotask and still trips below; bounded activity
  // spread across user input events lets it run and prevents false positives.
  scheduleCascadeReset(editor);
  if (editor._cascadeCount++ > 99) {
    // The budget resets (the macrotask reset above and the command-dispatch
    // reset in triggerCommandListeners) rule out bounded bursts of legitimate
    // activity, so exhausting the budget means update listeners are
    // re-enqueueing work in a loop that never yields to the event loop. Clear
    // the whole queue: by now it is dominated by cascade-generated updates,
    // and dropping only the head would strand the remainder with no scheduled
    // drain — re-igniting the loop on the next external update, and growing
    // the queue without bound when a cycle enqueues more than one update per
    // commit.
    editor._updates = [];
    editor._cascadeCount = 0;
    // Report the recoverable guard through onWarn after breaking the cascade.
    editor._onWarn(
      createError(
        'One or more update listeners are endlessly enqueueing more updates. ' +
          'May have encountered infinite recursion caused by update listeners ' +
          'that trigger additional updates without a stop condition. ' +
          'Editor namespace: %s',
        editor._config.namespace,
      ),
    );
    return;
  }
  const queuedUpdate = queuedUpdates.shift();
  if (queuedUpdate) {
    const [updateFn, options] = queuedUpdate;
    $beginUpdate(editor, updateFn, options);
  }
}

function triggerDeferredUpdateCallbacks(
  editor: LexicalEditor,
  deferred: (() => void)[],
): void {
  if (editor._deferred === deferred) {
    editor._deferred = [];
  }

  if (deferred.length !== 0) {
    const previouslyUpdating = editor._updating;
    editor._updating = true;

    try {
      for (let i = 0; i < deferred.length; i++) {
        deferred[i]();
      }
    } finally {
      editor._updating = previouslyUpdating;
    }
  }
}

function $processNestedUpdates(
  editor: LexicalEditor,
  initialSkipTransforms?: boolean,
): boolean {
  const queuedUpdates = editor._updates;
  let skipTransforms = initialSkipTransforms || false;

  // Updates might grow as we process them, we so we'll need
  // to handle each update as we go until the updates array is
  // empty.
  while (queuedUpdates.length !== 0) {
    const queuedUpdate = queuedUpdates.shift();
    if (queuedUpdate) {
      const [nextUpdateFn, options] = queuedUpdate;
      const pendingEditorState = editor._pendingEditorState;

      let onUpdate;

      if (options !== undefined) {
        onUpdate = options.onUpdate;

        if (options.skipTransforms) {
          skipTransforms = true;
        }
        if (options.discrete) {
          invariant(
            pendingEditorState !== null,
            'Unexpected empty pending editor state on discrete nested update',
          );
          pendingEditorState._flushSync = true;
        }

        if (onUpdate) {
          editor._deferred.push(onUpdate);
        }

        addTags(editor, options.tag);
      }

      if (pendingEditorState == null) {
        $beginUpdate(editor, nextUpdateFn, options);
      } else {
        nextUpdateFn();
      }
    }
  }

  return skipTransforms;
}

/**
 * Equivalent to setting `{discrete: true}` on the containing `editor.update`,
 * generally used to ensure that the DOM is updated before returning from
 * an event listener where the browser is expected to natively finish handling
 * the event.
 */
export function $flushSyncAfterUpdate() {
  const editorState = getActiveEditorState();
  errorOnReadOnly();
  editorState._flushSync = true;
}

/**
 * Discard a failed update: the editor goes back to its committed state, which
 * is committed again to restore the DOM (by the caller). A commit made during
 * the failed update (setEditorState, a read that commits) stays: its
 * listeners have run. The updates the failed one queued (nested updates not
 * run yet) are dropped with it; those queued before it stay.
 */
function $discardPendingUpdate(
  editor: LexicalEditor,
  queuedBefore: null | Set<LexicalEditor['_updates'][number]>,
): void {
  const committedEditorState = editor._editorState;
  editor._pendingEditorState = committedEditorState;
  // A notification in the rejected update must not suppress a later retry
  // or manufacture a selection change while recovering the committed state.
  const selection = committedEditorState._selection;
  editor._lastNotifiedSelection = selection === null ? null : selection.clone();
  editor._dirtyType = FULL_RECONCILE;
  editor._cloneNotNeeded.clear();
  editor._dirtyLeaves = new Set();
  editor._dirtyElements.clear();
  const updates = editor._updates;
  let kept = 0;
  for (const update of updates) {
    if (queuedBefore !== null && queuedBefore.has(update)) {
      updates[kept++] = update;
    }
  }
  updates.length = kept;
}

function $beginUpdate(
  editor: LexicalEditor,
  updateFn: () => void,
  options?: EditorUpdateOptions,
  skipCommit = false,
): void {
  const updateTags = editor._updateTags;
  let onUpdate;
  let skipTransforms = false;
  let discrete = false;

  if (options !== undefined) {
    onUpdate = options.onUpdate;
    addTags(editor, options.tag);

    skipTransforms = options.skipTransforms || false;
    discrete = options.discrete || false;
  }

  if (onUpdate) {
    editor._deferred.push(onUpdate);
  }

  const currentEditorState = editor._editorState;
  let pendingEditorState = editor._pendingEditorState;
  let editorStateWasCloned = false;

  if (pendingEditorState === null || pendingEditorState._readOnly) {
    pendingEditorState = editor._pendingEditorState = cloneEditorState(
      pendingEditorState || currentEditorState,
    );
    editorStateWasCloned = true;
  }
  pendingEditorState._flushSync = discrete;
  // The updates queued before this one (see $discardPendingUpdate).
  const queuedBefore =
    editor._updates.length === 0 ? null : new Set(editor._updates);

  const previousActiveEditorState = activeEditorState;
  const previousReadOnlyMode = isReadOnlyMode;
  const previousActiveEditor = activeEditor;
  const previouslyUpdating = editor._updating;
  const previouslyNotifiedSelection = editor._lastNotifiedSelection;
  activeEditorState = pendingEditorState;
  isReadOnlyMode = false;
  editor._updating = true;
  activeEditor = editor;
  const headless = editor._headless || editor.getRootElement() === null;
  setPendingNodeToClone(null);

  try {
    if (editorStateWasCloned) {
      if (headless) {
        if (currentEditorState._selection !== null) {
          pendingEditorState._selection = currentEditorState._selection.clone();
        }
      } else {
        pendingEditorState._selection = $internalCreateSelection(
          editor,
          (options && options.event) || null,
        );
      }
    }

    const startingCompositionKey = editor._compositionKey;
    updateFn();
    skipTransforms = $processNestedUpdates(editor, skipTransforms);
    applySelectionTransforms(pendingEditorState, editor);

    if (editor._dirtyType !== NO_DIRTY_NODES) {
      if (skipTransforms) {
        $normalizeAllDirtyTextNodes(pendingEditorState, editor);
      } else {
        $applyAllTransforms(pendingEditorState, editor);
      }

      $processNestedUpdates(editor);
      $garbageCollectDetachedNodes(
        currentEditorState,
        pendingEditorState,
        editor._dirtyLeaves,
        editor._dirtyElements,
      );
    }

    const endingCompositionKey = editor._compositionKey;

    if (startingCompositionKey !== endingCompositionKey) {
      pendingEditorState._flushSync = true;
    }

    const pendingSelection = pendingEditorState._selection;

    if ($isRangeSelection(pendingSelection)) {
      // Slot containment: a RangeSelection must not straddle a slot boundary.
      // Every committed selection passes here, including ones produced by an
      // in-place point mutation that bypassed `$setSelection`. Gated on
      // `_slotsUsed` so editors that never slot anything skip the frame walk.
      if (editor._slotsUsed) {
        $clampRangeSelectionToSlotFrame(pendingSelection);
      }
      const pendingNodeMap = pendingEditorState._nodeMap;
      const anchorKey = pendingSelection.anchor.key;
      const focusKey = pendingSelection.focus.key;

      if (
        pendingNodeMap.get(anchorKey) === undefined ||
        pendingNodeMap.get(focusKey) === undefined
      ) {
        invariant(
          false,
          'updateEditor: selection has been lost because the previously selected nodes have been removed and ' +
            "selection wasn't moved to another node. Ensure selection changes after removing/replacing a selected node.",
        );
      }
    } else if ($isNodeSelection(pendingSelection)) {
      // TODO: we should also validate node selection?
      if (pendingSelection._nodes.size === 0) {
        pendingEditorState._selection = null;
      }
    }
  } catch (error) {
    // An update nested in the running update whose pending state it shares
    // leaves the error to that update, which owns the state: it is reported
    // once, and the update is discarded as a whole.
    if (
      !editorStateWasCloned &&
      previousActiveEditorState === pendingEditorState
    ) {
      throw error;
    }
    $discardPendingUpdate(editor, queuedBefore);
    // The failed update is discarded before onError runs, and whether or not
    // it rethrows: a pending state left behind would be committed with the
    // next update (or by a read in onError), mixing the two updates' changes
    // and tags.
    let rethrown: null | {error: unknown} = null;
    try {
      if (error instanceof Error) {
        editor._onError(error);
      }
    } catch (reportedError) {
      rethrown = {error: reportedError};
    }
    try {
      $commitPendingUpdates(editor);
    } catch (commitError) {
      // A listener threw before the commit ran the updates queued meanwhile
      // (by onError, for one): they run once the editor is idle.
      scheduleMicroTask(() => $triggerEnqueuedUpdates(editor));
      if (rethrown === null) {
        throw commitError;
      }
      // The caller gets the error onError rethrew; this one is reported too.
      if (commitError instanceof Error) {
        try {
          editor._onError(commitError);
        } catch (_e) {
          // Already reported.
        }
      }
    }
    if (rethrown !== null) {
      throw rethrown.error;
    }
    return;
  } finally {
    activeEditorState = previousActiveEditorState;
    isReadOnlyMode = previousReadOnlyMode;
    activeEditor = previousActiveEditor;
    editor._updating = previouslyUpdating;
    infiniteTransformCount = 0;
  }

  // Selection notifications extend an update that is already about to commit.
  // Its caller owns the commit, including any deferred callbacks.
  if (skipCommit) {
    return;
  }

  const shouldUpdate =
    editor._dirtyType !== NO_DIRTY_NODES ||
    editor._deferred.length > 0 ||
    editorStateHasDirtySelection(pendingEditorState, editor);

  if (shouldUpdate) {
    if (pendingEditorState._flushSync) {
      pendingEditorState._flushSync = false;
      $commitPendingUpdates(editor);
    } else if (editorStateWasCloned) {
      scheduleMicroTask(() => {
        $commitPendingUpdates(editor);
      });
    }
  } else {
    pendingEditorState._flushSync = false;

    if (editorStateWasCloned) {
      updateTags.clear();
      editor._deferred = [];
      editor._pendingEditorState = null;
      // A notification in the dropped update recorded a selection that never
      // commits. Left in place, it would suppress the next notification of
      // that selection, so a listener that restated it would never run again.
      editor._lastNotifiedSelection = previouslyNotifiedSelection;
    }
  }
}

/**
 * A variant of updateEditor that will not defer if it is nested in an update
 * to the same editor, much like if it was an editor.dispatchCommand issued
 * within an update
 */
export function updateEditorSync(
  editor: LexicalEditor,
  updateFn: () => void,
  options?: EditorUpdateOptions,
): void {
  if (activeEditor === editor && options === undefined) {
    if (isCurrentlyReadOnlyMode()) {
      // We are nominally "inside an update" for this editor, but the active
      // context is read-only (e.g. a command dispatched from inside
      // editor.read(), or a force-commit read on the stack). Running updateFn
      // inline here would mutate the frozen active editor state and throw
      // "Cannot call set() on a frozen Lexical node map" — an error that gets
      // routed to editor._onError rather than rethrown, so the mutation is
      // silently dropped. Route through $beginUpdate instead, which starts a
      // fresh writable update, so the work actually applies.
      // DOM selection updates during commit can synchronously dispatch focus
      // commands against the frozen state. This is internal bookkeeping, not
      // an application read. Explicit reads set isReadOnlyMode and should
      // still warn, even when entered from a callback during a commit.
      if (__DEV__ && (!isCommittingPendingUpdates || isReadOnlyMode)) {
        console.warn(
          `updateEditorSync: an editor update (e.g. a command listener that ` +
            `mutates the editor) ran while a read-only context was on the ` +
            `stack. This most commonly happens when a command is dispatched ` +
            `from inside editor.read(). The update has been deferred to a ` +
            `fresh writable update so it still applies, but dispatching ` +
            `mutations from a read-only context is an anti-pattern — dispatch ` +
            `after editor.read() returns, or via queueMicrotask.`,
        );
      }
      $beginUpdate(editor, updateFn, options);
    } else {
      updateFn();
    }
  } else {
    $beginUpdate(editor, updateFn, options);
  }
}

export function updateEditor(
  editor: LexicalEditor,
  updateFn: () => void,
  options?: EditorUpdateOptions,
): void {
  if (editor._updating) {
    editor._updates.push([updateFn, options]);
  } else {
    $beginUpdate(editor, updateFn, options);
  }
}
