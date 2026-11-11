/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {BaseBinding} from './Bindings';

import './types';

import {createCommand, type LexicalCommand} from 'lexical';
import {
  type Doc,
  type RelativePosition,
  type Snapshot,
  type UndoManager,
  UndoManager as YjsUndoManager,
  type XmlElement,
  type XmlText,
} from 'yjs';

export type UserState = {
  anchorPos: null | RelativePosition;
  color: string;
  focusing: boolean;
  focusPos: null | RelativePosition;
  name: string;
  awarenessData: object;
  [key: string]: unknown;
};
export const CONNECTED_COMMAND: LexicalCommand<boolean> =
  createCommand('CONNECTED_COMMAND');
export const TOGGLE_CONNECT_COMMAND: LexicalCommand<boolean> = createCommand(
  'TOGGLE_CONNECT_COMMAND',
);

export const DIFF_VERSIONS_COMMAND__EXPERIMENTAL: LexicalCommand<{
  // Starting snapshot if defined, otherwise compare since start of time.
  prevSnapshot?: Snapshot;
  // Ending snapshot if defined, otherwise compare against current state of the Yjs document.
  snapshot?: Snapshot;
}> = createCommand('DIFF_VERSIONS_COMMAND');
export const CLEAR_DIFF_VERSIONS_COMMAND__EXPERIMENTAL: LexicalCommand<void> =
  createCommand('CLEAR_DIFF_VERSIONS_COMMAND');
export {$getYChangeState, renderSnapshot__EXPERIMENTAL} from './RenderSnapshot';

export type ProviderAwareness = {
  getLocalState: () => UserState | null;
  getStates: () => Map<number, UserState>;
  off: (type: 'update', cb: () => void) => void;
  on: (type: 'update', cb: () => void) => void;
  setLocalState: (arg0: UserState | null) => void;
  setLocalStateField: (field: string, value: unknown) => void;
};
declare interface Provider {
  awareness: ProviderAwareness;
  connect(): void | Promise<void>;
  disconnect(): void;
  off(type: 'sync', cb: (isSynced: boolean) => void): void;
  off(type: 'update', cb: (arg0: unknown) => void): void;
  off(type: 'status', cb: (arg0: {status: string}) => void): void;
  off(type: 'reload', cb: (doc: Doc) => void): void;
  on(type: 'sync', cb: (isSynced: boolean) => void): void;
  on(type: 'status', cb: (arg0: {status: string}) => void): void;
  on(type: 'update', cb: (arg0: unknown) => void): void;
  on(type: 'reload', cb: (doc: Doc) => void): void;
}
export type Operation = {
  attributes: {
    __type: string;
  };
  insert: string | Record<string, unknown>;
};
export type Delta = Operation[];
export type YjsNode = Record<string, unknown>;
export type YjsEvent = Record<string, unknown>;
export type {Provider};
export type {
  BaseBinding,
  Binding,
  BindingV2,
  ClientID,
  CreateBindingV2Options__EXPERIMENTAL,
  CreateYjsBindingOptions,
  ExcludedProperties,
} from './Bindings';
export {
  createBinding,
  createBindingV2__EXPERIMENTAL,
  createYjsBinding,
} from './Bindings';

export function createUndoManager(
  binding: BaseBinding,
  root: XmlText | XmlElement,
): UndoManager {
  return new YjsUndoManager(root, {
    // Bootstrapping the initial editor state is not a user edit, so it must not
    // become an undo entry (matching a non-collab editor, where the initial
    // state is applied with HISTORY_MERGE_TAG). See #7110.
    captureTransaction: () => !binding.isBootstrapping,
    trackedOrigins: new Set([binding, null]),
  });
}

export function initLocalState(
  provider: Provider,
  name: string,
  color: string,
  focusing: boolean,
  awarenessData: object,
): void {
  provider.awareness.setLocalState({
    anchorPos: null,
    awarenessData,
    color,
    focusPos: null,
    focusing: focusing,
    name,
  });
}

export function setLocalStateFocus(
  provider: Provider,
  name: string,
  color: string,
  focusing: boolean,
  awarenessData: object,
): void {
  const {awareness} = provider;
  let localState = awareness.getLocalState();

  if (localState === null) {
    localState = {
      anchorPos: null,
      awarenessData,
      color,
      focusPos: null,
      focusing: focusing,
      name,
    };
  }

  localState.focusing = focusing;
  awareness.setLocalState(localState);
}
export {
  $getAnchorAndFocusForUserState,
  getAnchorAndFocusCollabNodesForUserState,
  removeCursorHighlightRule,
  syncCursorPositions,
  type SyncCursorPositionsFn,
} from './SyncCursors';
export {
  syncLexicalUpdateToYjs,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
  syncYjsChangesToLexical,
  syncYjsChangesToLexicalV2__EXPERIMENTAL,
  syncYjsStateToLexicalV2__EXPERIMENTAL,
} from './SyncEditorStates';
