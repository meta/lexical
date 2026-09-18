/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {InitialEditorStateType} from '../LexicalComposer';

import {
  type BaseBinding,
  type Binding,
  type BindingV2,
  CLEAR_DIFF_VERSIONS_COMMAND__EXPERIMENTAL,
  CONNECTED_COMMAND,
  createBindingV2__EXPERIMENTAL,
  createUndoManager,
  DIFF_VERSIONS_COMMAND__EXPERIMENTAL,
  type ExcludedProperties,
  initLocalState,
  type Provider,
  removeCursorHighlightRule,
  renderSnapshot__EXPERIMENTAL,
  setLocalStateFocus,
  syncCursorPositions,
  type SyncCursorPositionsFn,
  syncLexicalUpdateToYjs,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
  syncYjsChangesToLexical,
  syncYjsChangesToLexicalV2__EXPERIMENTAL,
  syncYjsStateToLexicalV2__EXPERIMENTAL,
  TOGGLE_CONNECT_COMMAND,
} from '@lexical/yjs';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  BLUR_COMMAND,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  FOCUS_COMMAND,
  getActiveElement,
  HISTORY_MERGE_TAG,
  type LexicalEditor,
  mergeRegister,
  REDO_COMMAND,
  registerEventListeners,
  SKIP_COLLAB_TAG,
  UNDO_COMMAND,
} from 'lexical';
import * as React from 'react';
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {createPortal} from 'react-dom';
import {
  type Doc,
  type Snapshot,
  type Transaction,
  UndoManager,
  type XmlElement,
  type YEvent,
} from 'yjs';

export type CursorsContainerRef = React.RefObject<HTMLElement | null>;

/**
 * Well-known key under which the active Yjs {@link UndoManager} is published on
 * the editor instance (mirroring how `@lexical/extension` attaches its builder
 * via a `Symbol.for` key). Collab disables `@lexical/history`, so this is the
 * handle tooling and e2e tests use to force a deterministic undo boundary via
 * `editor[COLLAB_UNDO_MANAGER]?.stopCapturing()` instead of waiting out the
 * UndoManager capture timeout.
 */
const COLLAB_UNDO_MANAGER = Symbol.for('@lexical/yjs/UndoManager');

type OnYjsTreeChanges = (
  // The below `any` type is taken directly from the vendor types for YJS.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events: YEvent<any>[],
  transaction: Transaction,
) => void;

export function useYjsCollaboration(
  editor: LexicalEditor,
  id: string,
  provider: Provider,
  docMap: Map<string, Doc>,
  name: string,
  color: string,
  shouldBootstrap: boolean,
  binding: Binding,
  setDoc: React.Dispatch<React.SetStateAction<Doc | undefined>>,
  cursorsContainerRef?: CursorsContainerRef,
  initialEditorState?: InitialEditorStateType,
  awarenessData?: object,
  syncCursorPositionsFn: SyncCursorPositionsFn = syncCursorPositions,
  selectionHighlight: boolean = false,
): JSX.Element {
  const isReloadingDoc = useRef(false);

  const onBootstrap = useCallback(() => {
    const {root} = binding;
    if (shouldBootstrap && root.isEmpty() && root._xmlText._length === 0) {
      bootstrapEditor(binding, editor, initialEditorState);
    }
  }, [binding, editor, initialEditorState, shouldBootstrap]);

  useEffect(() => {
    const {root} = binding;

    const onYjsTreeChanges: OnYjsTreeChanges = (events, transaction) => {
      const origin = transaction.origin;
      if (origin !== binding) {
        const isFromUndoManger = origin instanceof UndoManager;
        syncYjsChangesToLexical(
          binding,
          provider,
          events,
          isFromUndoManger,
          syncCursorPositionsFn,
        );
      }
    };

    // This updates the local editor state when we receive updates from other clients
    root.getSharedType().observeDeep(onYjsTreeChanges);
    const removeListener = editor.registerUpdateListener(
      ({
        prevEditorState,
        editorState,
        dirtyLeaves,
        dirtyElements,
        normalizedNodes,
        tags,
      }) => {
        if (!tags.has(SKIP_COLLAB_TAG)) {
          syncLexicalUpdateToYjs(
            binding,
            provider,
            prevEditorState,
            editorState,
            dirtyElements,
            dirtyLeaves,
            normalizedNodes,
            tags,
          );
        }
      },
    );

    return () => {
      root.getSharedType().unobserveDeep(onYjsTreeChanges);
      removeListener();
    };
  }, [binding, provider, editor, setDoc, docMap, id, syncCursorPositionsFn]);

  // Note: 'reload' is not an actual Yjs event type. Included here for legacy support (#1409).
  useEffect(() => {
    const onProviderDocReload = (ydoc: Doc) => {
      clearEditorSkipCollab(editor, binding);
      setDoc(ydoc);
      docMap.set(id, ydoc);
      isReloadingDoc.current = true;
    };

    const onSync = () => {
      isReloadingDoc.current = false;
    };

    provider.on('reload', onProviderDocReload);
    provider.on('sync', onSync);

    return () => {
      provider.off('reload', onProviderDocReload);
      provider.off('sync', onSync);
    };
  }, [binding, provider, editor, setDoc, docMap, id]);

  useProvider(
    editor,
    provider,
    name,
    color,
    isReloadingDoc,
    awarenessData,
    onBootstrap,
  );

  useAwareness(binding, provider, selectionHighlight);

  return useYjsCursors(binding, cursorsContainerRef);
}

export function useYjsCollaborationV2__EXPERIMENTAL(
  editor: LexicalEditor,
  id: string,
  doc: Doc,
  provider: Provider,
  docMap: Map<string, Doc>,
  name: string,
  color: string,
  options: {
    awarenessData?: object;
    excludedProperties?: ExcludedProperties;
    rootName?: string;
    getXmlElement?: (ydoc: Doc) => XmlElement;
    selectionHighlight?: boolean;
    __shouldBootstrapUnsafe?: boolean;
  } = {},
): BindingV2 {
  const {
    awarenessData,
    excludedProperties,
    rootName,
    getXmlElement,
    selectionHighlight = false,
    __shouldBootstrapUnsafe: shouldBootstrap,
  } = options;

  // Note: v2 does not support 'reload' event, which is not an actual Yjs event type.
  const isReloadingDoc = useMemo(() => ({current: false}), []);

  // Built once for this mount, in state rather than a memo: `useMemo` is a
  // hint React may discard, and its inputs include values (an inline
  // `excludedProperties` map, an inline root resolver) whose identity changes
  // on every render. Rebuilding would re-run `getXmlElement` -- which the
  // caller may use to create shared types -- and hand the editor a binding on
  // another root, which the next local update would then overwrite with this
  // editor's current content. Remount to edit a different document.
  const [binding] = useState(() =>
    createBindingV2__EXPERIMENTAL(editor, id, doc, docMap, {
      excludedProperties,
      getXmlElement,
      rootName,
    }),
  );

  useEffect(() => {
    docMap.set(id, doc);
    return () => {
      docMap.delete(id);
    };
  }, [doc, docMap, id]);

  const onBootstrap = useCallback(() => {
    const {root} = binding;
    if (shouldBootstrap && root._length === 0) {
      bootstrapEditor(binding, editor);
    }
  }, [binding, editor, shouldBootstrap]);

  const [diffSnapshots, setDiffSnapshots] = useState<{
    prevSnapshot?: Snapshot;
    snapshot?: Snapshot;
  } | null>();

  useEffect(() => {
    mergeRegister(
      editor.registerCommand(
        CLEAR_DIFF_VERSIONS_COMMAND__EXPERIMENTAL,
        () => {
          setDiffSnapshots(null);
          // Ensure that any state already in Yjs is loaded into the editor (eg: after clearing diff view).
          syncYjsStateToLexicalV2__EXPERIMENTAL(binding, provider);
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      editor.registerCommand(
        DIFF_VERSIONS_COMMAND__EXPERIMENTAL,
        ({prevSnapshot, snapshot}) => {
          setDiffSnapshots({prevSnapshot, snapshot});
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    );
  }, [editor, binding, provider]);

  useEffect(() => {
    const {root} = binding;

    if (diffSnapshots) {
      renderSnapshot__EXPERIMENTAL(
        binding,
        diffSnapshots.snapshot,
        diffSnapshots.prevSnapshot,
      );
      return;
    }

    const onYjsTreeChanges: OnYjsTreeChanges = (events, transaction) => {
      const origin = transaction.origin;
      if (origin !== binding) {
        const isFromUndoManger = origin instanceof UndoManager;
        syncYjsChangesToLexicalV2__EXPERIMENTAL(
          binding,
          provider,
          events,
          transaction,
          isFromUndoManger,
        );
      }
    };

    // This updates the local editor state when we receive updates from other clients
    root.observeDeep(onYjsTreeChanges);
    const removeListener = editor.registerUpdateListener(
      ({
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      }) => {
        if (!tags.has(SKIP_COLLAB_TAG)) {
          syncLexicalUpdateToYjsV2__EXPERIMENTAL(
            binding,
            provider,
            prevEditorState,
            editorState,
            dirtyElements,
            dirtyLeaves,
            normalizedNodes,
            tags,
          );
        }
      },
    );

    return () => {
      root.unobserveDeep(onYjsTreeChanges);
      removeListener();
    };
  }, [binding, provider, editor, diffSnapshots]);

  useProvider(
    editor,
    provider,
    name,
    color,
    isReloadingDoc,
    awarenessData,
    onBootstrap,
  );

  useAwareness(binding, provider, selectionHighlight);

  return binding;
}

function useProvider(
  editor: LexicalEditor,
  provider: Provider,
  name: string,
  color: string,
  isReloadingDoc: React.RefObject<boolean>,
  awarenessData?: object,
  onBootstrap?: () => void,
): void {
  const connect = useCallback(() => provider.connect(), [provider]);

  const disconnect = useCallback(() => {
    try {
      provider.disconnect();
    } catch (_e) {
      // Do nothing
    }
  }, [provider]);

  useEffect(() => {
    const onStatus = ({status}: {status: string}) => {
      editor.dispatchCommand(CONNECTED_COMMAND, status === 'connected');
    };

    const onSync = (isSynced: boolean) => {
      if (isSynced && isReloadingDoc.current === false && onBootstrap) {
        onBootstrap();
      }
    };

    const rootElement = editor.getRootElement();
    initLocalState(
      provider,
      name,
      color,
      // getActiveElement rather than document.activeElement, which reports the
      // shadow host when the editor is in a shadow root.
      rootElement !== null && getActiveElement(rootElement) === rootElement,
      awarenessData || {},
    );

    provider.on('status', onStatus);
    provider.on('sync', onSync);

    const connectionPromise = connect();

    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- expected that isReloadingDoc.current may change
      if (isReloadingDoc.current === false) {
        if (connectionPromise) {
          connectionPromise.then(disconnect);
        } else {
          // Workaround for race condition in StrictMode. It's possible there
          // is a different race for the above case where connect returns a
          // promise, but we don't have an example of that in-repo.
          // It's possible that there is a similar issue with
          // TOGGLE_CONNECT_COMMAND below when the provider connect returns a
          // promise.
          // https://github.com/facebook/lexical/issues/6640
          disconnect();
        }
      }

      provider.off('sync', onSync);
      provider.off('status', onStatus);
    };
  }, [
    editor,
    provider,
    name,
    color,
    isReloadingDoc,
    awarenessData,
    onBootstrap,
    connect,
    disconnect,
  ]);

  useEffect(() => {
    return editor.registerCommand(
      TOGGLE_CONNECT_COMMAND,
      payload => {
        const shouldConnect = payload;

        if (shouldConnect) {
          // eslint-disable-next-line no-console
          console.log('Collaboration connected!');
          connect();
        } else {
          // eslint-disable-next-line no-console
          console.log('Collaboration disconnected!');
          disconnect();
        }

        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [connect, disconnect, editor]);

  // Clear awareness state immediately when tab is refreshed or closed
  // This prevents ghost cursors from appearing for several seconds after disconnect
  // See: https://github.com/facebook/lexical/issues/8061
  useEffect(() => {
    const clearAwarenessState = () => {
      // Immediately clear local awareness state to signal disconnection
      // This broadcasts to other clients that this client has disconnected,
      // causing them to remove the cursor immediately instead of waiting for timeout
      try {
        provider.awareness.setLocalState(null);
      } catch (_e) {
        // Ignore errors during cleanup (e.g., if provider is already disconnected)
      }
    };

    // Use both beforeunload and pagehide for maximum browser compatibility
    // beforeunload: fires before page unloads (may be cancelable)
    // pagehide: fires when page is being unloaded (more reliable, especially on mobile)
    return registerEventListeners(window, {
      beforeunload: clearAwarenessState,
      pagehide: clearAwarenessState,
    });
  }, [provider]);
}

function useAwareness(
  binding: Binding | BindingV2,
  provider: Provider,
  selectionHighlight: boolean,
) {
  useEffect(() => {
    const {awareness} = provider;
    const onAwarenessUpdate = () => {
      syncCursorPositions(binding, provider, {selectionHighlight});
    };
    awareness.on('update', onAwarenessUpdate);

    return () => {
      awareness.off('update', onAwarenessUpdate);
    };
  }, [binding, provider, selectionHighlight]);
}

export function useYjsCursors(
  binding: BaseBinding,
  cursorsContainerRef?: CursorsContainerRef,
): JSX.Element {
  return useMemo(() => {
    const ref = (element: null | HTMLElement) => {
      // eslint-disable-next-line react-hooks/immutability
      binding.cursorsContainer = element;
    };

    return createPortal(
      <div ref={ref} />,
      // eslint-disable-next-line no-restricted-syntax
      (cursorsContainerRef && cursorsContainerRef.current) || document.body,
    );
  }, [binding, cursorsContainerRef]);
}

export function useYjsFocusTracking(
  editor: LexicalEditor,
  provider: Provider,
  name: string,
  color: string,
  awarenessData?: object,
) {
  useEffect(() => {
    return mergeRegister(
      editor.registerCommand(
        FOCUS_COMMAND,
        () => {
          setLocalStateFocus(provider, name, color, true, awarenessData || {});
          return false;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      editor.registerCommand(
        BLUR_COMMAND,
        () => {
          setLocalStateFocus(provider, name, color, false, awarenessData || {});
          return false;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    );
  }, [color, editor, name, provider, awarenessData]);
}

export function useYjsHistory(
  editor: LexicalEditor,
  binding: Binding,
): () => void {
  const undoManager = useMemo(
    () => createUndoManager(binding, binding.root.getSharedType()),
    [binding],
  );

  return useYjsUndoManager(editor, undoManager);
}

export function useYjsHistoryV2(
  editor: LexicalEditor,
  binding: BindingV2,
): () => void {
  const undoManager = useMemo(
    () => createUndoManager(binding, binding.root),
    [binding],
  );

  return useYjsUndoManager(editor, undoManager);
}

function useYjsUndoManager(editor: LexicalEditor, undoManager: UndoManager) {
  useEffect(() => {
    const undo = () => {
      undoManager.undo();
    };

    const redo = () => {
      undoManager.redo();
    };

    return mergeRegister(
      editor.registerCommand(
        UNDO_COMMAND,
        () => {
          undo();
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      editor.registerCommand(
        REDO_COMMAND,
        () => {
          redo();
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    );
  });
  // Publish the UndoManager on the editor (see COLLAB_UNDO_MANAGER) so tooling
  // and e2e tests can reach it; remove it again when it changes or unmounts.
  useEffect(() => {
    const withManager = editor as LexicalEditor &
      Record<symbol, UndoManager | undefined>;
    // eslint-disable-next-line react-hooks/immutability
    withManager[COLLAB_UNDO_MANAGER] = undoManager;
    return () => {
      if (withManager[COLLAB_UNDO_MANAGER] === undoManager) {
        delete withManager[COLLAB_UNDO_MANAGER];
      }
    };
  }, [editor, undoManager]);

  const clearHistory = useCallback(() => {
    undoManager.clear();
  }, [undoManager]);

  // Exposing undo and redo states
  React.useEffect(() => {
    const updateUndoRedoStates = () => {
      editor.dispatchCommand(
        CAN_UNDO_COMMAND,
        undoManager.undoStack.length > 0,
      );
      editor.dispatchCommand(
        CAN_REDO_COMMAND,
        undoManager.redoStack.length > 0,
      );
    };
    undoManager.on('stack-item-added', updateUndoRedoStates);
    undoManager.on('stack-item-popped', updateUndoRedoStates);
    undoManager.on('stack-cleared', updateUndoRedoStates);
    return () => {
      undoManager.off('stack-item-added', updateUndoRedoStates);
      undoManager.off('stack-item-popped', updateUndoRedoStates);
      undoManager.off('stack-cleared', updateUndoRedoStates);
    };
  }, [editor, undoManager]);

  return clearHistory;
}

/**
 * Write the initial editor state into an empty shared document. The write is
 * flagged on the binding so that the Yjs UndoManager created by
 * `createUndoManager` skips the resulting transaction: bootstrapping is not a
 * user edit and must not be undoable, which matches a non-collab editor where
 * the initial state is applied with HISTORY_MERGE_TAG (#7110).
 */
function bootstrapEditor(
  binding: BaseBinding,
  editor: LexicalEditor,
  initialEditorState?: InitialEditorStateType,
): void {
  binding.isBootstrapping = true;
  try {
    // The Yjs write happens in the update listener during the commit, which is
    // not necessarily synchronous with this call, so the flag has to outlive
    // it. An `onUpdate` callback is the boundary that matches the write:
    // Lexical queues it on `editor._deferred` before the update body runs and
    // flushes it at the tail of the same commit that ran the update listeners,
    // so it lands after the write and never before it. A queued deferred
    // callback also forces a commit on its own, so this still runs when the
    // update turns out to be a no-op.
    initializeEditor(editor, initialEditorState, () => {
      binding.isBootstrapping = false;
    });
  } finally {
    // `onUpdate` alone is not enough: when the update body throws, Lexical
    // reports the error, commits (running the update listeners, so the Yjs
    // write still happens), and skips that commit's deferred callbacks. The
    // reset would then be left queued until the tail of the *next* commit,
    // by which point that commit's listener has already written to Yjs with
    // the flag set — silently keeping the user's first edit after a failed
    // bootstrap out of the undo stack. This bounds the flag's lifetime to a
    // microtask no matter how the update ends. It cannot fire early: the
    // commit is scheduled from inside `editor.update` above, so its microtask
    // is queued ahead of this one.
    queueMicrotask(() => {
      binding.isBootstrapping = false;
    });
  }
}

function initializeEditor(
  editor: LexicalEditor,
  initialEditorState?: InitialEditorStateType,
  onUpdate?: () => void,
): void {
  editor.update(
    () => {
      const root = $getRoot();

      if (root.isEmpty()) {
        if (initialEditorState) {
          switch (typeof initialEditorState) {
            case 'string': {
              const parsedEditorState =
                editor.parseEditorState(initialEditorState);
              editor.setEditorState(parsedEditorState, {
                tag: HISTORY_MERGE_TAG,
              });
              break;
            }
            case 'object': {
              editor.setEditorState(initialEditorState, {
                tag: HISTORY_MERGE_TAG,
              });
              break;
            }
            case 'function': {
              editor.update(
                () => {
                  const root1 = $getRoot();
                  if (root1.isEmpty()) {
                    initialEditorState(editor);
                  }
                },
                {tag: HISTORY_MERGE_TAG},
              );
              break;
            }
          }
        } else {
          const paragraph = $createParagraphNode();
          root.append(paragraph);
          const rootElement = editor.getRootElement();

          if (
            $getSelection() !== null ||
            (rootElement !== null &&
              getActiveElement(rootElement) === rootElement)
          ) {
            paragraph.select();
          }
        }
      }
    },
    {
      onUpdate,
      tag: HISTORY_MERGE_TAG,
    },
  );
}

function clearEditorSkipCollab(editor: LexicalEditor, binding: BaseBinding) {
  // reset editor state
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      root.select();
    },
    {
      tag: SKIP_COLLAB_TAG,
    },
  );

  if (binding.cursors == null) {
    return;
  }

  const cursors = binding.cursors;

  if (cursors == null) {
    return;
  }
  const cursorsContainer = binding.cursorsContainer;

  if (cursorsContainer == null) {
    return;
  }

  for (const cursor of cursors.values()) {
    const selection = cursor.selection;
    if (selection === null) {
      continue;
    }
    if (selection.highlight !== null) {
      CSS.highlights.delete(selection.highlightName);
      removeCursorHighlightRule(binding, selection.highlightName);
    }
    if (selection.caret.parentNode === cursorsContainer) {
      cursorsContainer.removeChild(selection.caret);
    }
    for (const span of selection.selections) {
      if (span.parentNode === cursorsContainer) {
        cursorsContainer.removeChild(span);
      }
    }
    cursor.selection = null;
  }
}
