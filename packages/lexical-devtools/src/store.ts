/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {SerializedRawEditorState} from './types';

import {
  initPegasusZustandStoreBackend,
  pegasusZustandStoreReady,
} from '@webext-pegasus/store-zustand';
import {create} from 'zustand';
import {subscribeWithSelector} from 'zustand/middleware';

/**
 * Upper bound on the editors retained per tab.
 *
 * Serialized editor state is held for the lifetime of the background service
 * worker, so without a cap a long-lived tab that creates editors dynamically
 * grows this map without limit -- keeping the contents of editors the user
 * has long since navigated away from. Pages realistically carry a handful of
 * editors; the excess is dropped oldest-first.
 */
export const MAX_RETAINED_EDITORS_PER_TAB = 50;

function capRetainedEditors(states: {
  [editorKey: string]: SerializedRawEditorState;
}): {[editorKey: string]: SerializedRawEditorState} {
  const keys = Object.keys(states);
  if (keys.length <= MAX_RETAINED_EDITORS_PER_TAB) {
    return states;
  }

  return Object.fromEntries(
    keys
      .slice(keys.length - MAX_RETAINED_EDITORS_PER_TAB)
      .map(key => [key, states[key]]),
  );
}

function withoutTab<T>(
  collection: {[tabID: number]: T},
  tabID: number,
): {[tabID: number]: T} {
  if (!(tabID in collection)) {
    return collection;
  }

  const next = {...collection};
  delete next[tabID];
  return next;
}

export interface ExtensionState {
  lexicalState: {
    [tabID: number]: {[editorKey: string]: SerializedRawEditorState} | null;
  };
  selectedEditorKey: {
    [tabID: number]: string | null;
  };
  isSelecting: {
    [tabID: number]: boolean;
  };
  /**
   * Whether the user currently has the Lexical DevTools panel open for a tab.
   *
   * Editor text is only serialized into this store in full while a panel is
   * open for that tab; see `scanAndListenForEditors`.
   */
  isPanelOpen: {
    [tabID: number]: boolean;
  };
  markTabAsRestricted: (tabID: number) => void;
  setStatesForTab: (
    id: number,
    states: {[editorKey: string]: SerializedRawEditorState},
  ) => void;
  setSelectedEditorKey: (tabID: number, editorKey: string | null) => void;
  setIsSelecting: (tadID: number, isSelecting: boolean) => void;
  setIsPanelOpen: (tabID: number, isPanelOpen: boolean) => void;
  /**
   * Drop everything retained for a tab.
   *
   * Called when the tab is closed or navigates: the editors it described no
   * longer exist, so their contents should not be kept.
   */
  clearTab: (tabID: number) => void;
}

export const useExtensionStore = create<ExtensionState>()(
  subscribeWithSelector(set => ({
    clearTab: (tabID: number) =>
      set(state => ({
        isPanelOpen: withoutTab(state.isPanelOpen, tabID),
        isSelecting: withoutTab(state.isSelecting, tabID),
        lexicalState: withoutTab(state.lexicalState, tabID),
        selectedEditorKey: withoutTab(state.selectedEditorKey, tabID),
      })),
    isPanelOpen: {},
    isSelecting: {},
    lexicalState: {},
    markTabAsRestricted: (tabID: number) =>
      set(state => ({
        lexicalState: {
          ...state.lexicalState,
          [tabID]: null,
        },
      })),
    selectedEditorKey: {},
    setIsPanelOpen: (tabID: number, isPanelOpen: boolean) =>
      set(state => ({
        isPanelOpen: {
          ...state.isPanelOpen,
          [tabID]: isPanelOpen,
        },
      })),
    setIsSelecting: (tabID: number, isSelecting: boolean) =>
      set(state => ({
        isSelecting: {
          ...state.isSelecting,
          [tabID]: isSelecting,
        },
      })),
    setSelectedEditorKey: (tabID: number, editorKey: string | null) =>
      set(state => ({
        selectedEditorKey: {
          ...state.selectedEditorKey,
          [tabID]: editorKey,
        },
      })),
    setStatesForTab: (
      id: number,
      states: {[editorKey: string]: SerializedRawEditorState},
    ) =>
      set(state => ({
        lexicalState: {
          ...state.lexicalState,
          [id]: capRetainedEditors(states),
        },
      })),
  })),
);

const STORE_NAME = 'ExtensionStore';

export const initExtensionStoreBackend = () =>
  initPegasusZustandStoreBackend(STORE_NAME, useExtensionStore, {
    storageStrategy: 'session',
  });
export const extensionStoreReady = () =>
  pegasusZustandStoreReady(STORE_NAME, useExtensionStore);
