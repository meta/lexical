/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  initPegasusZustandStoreBackend,
  pegasusZustandStoreReady,
} from '@webext-pegasus/store-zustand';
import {create} from 'zustand';
import {subscribeWithSelector} from 'zustand/middleware';

/**
 * State shared between the extension's own surfaces (background, popup and
 * DevTools panel).
 *
 * This store is mirrored into every surface that connects to it, so it holds
 * no editor content: only facts about a tab that any surface may see, such as
 * how many editors a page has. Editor state itself travels from the page that
 * owns it to the panel attached to that page and is never collected here --
 * see `entrypoints/background/TabStateService.ts`.
 */
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
  /**
   * Number of Lexical editors found on a tab, or `null` when the tab is a
   * restricted browser page the extension cannot run on.
   *
   * A count, never content: the popup reports "found N editors" without any
   * surface having to hold what those editors contain.
   */
  editorCount: {
    [tabID: number]: number | null;
  };
  selectedEditorKey: {
    [tabID: number]: string | null;
  };
  isSelecting: {
    [tabID: number]: boolean;
  };
  markTabAsRestricted: (tabID: number) => void;
  setEditorCount: (tabID: number, count: number) => void;
  setSelectedEditorKey: (tabID: number, editorKey: string | null) => void;
  setIsSelecting: (tadID: number, isSelecting: boolean) => void;
  /**
   * Drop everything retained for a tab.
   *
   * Called when the tab is closed or navigates: whatever was true of the
   * page it used to show no longer is.
   */
  clearTab: (tabID: number) => void;
}

export const useExtensionStore = create<ExtensionState>()(
  subscribeWithSelector(set => ({
    clearTab: (tabID: number) =>
      set(state => ({
        editorCount: withoutTab(state.editorCount, tabID),
        isSelecting: withoutTab(state.isSelecting, tabID),
        selectedEditorKey: withoutTab(state.selectedEditorKey, tabID),
      })),
    editorCount: {},
    isSelecting: {},
    markTabAsRestricted: (tabID: number) =>
      set(state => ({
        editorCount: {
          ...state.editorCount,
          [tabID]: null,
        },
      })),
    selectedEditorKey: {},
    setEditorCount: (tabID: number, count: number) =>
      set(state => ({
        editorCount: {
          ...state.editorCount,
          [tabID]: count,
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
  })),
);

const STORE_NAME = 'ExtensionStore';

export const initExtensionStoreBackend = () =>
  initPegasusZustandStoreBackend(STORE_NAME, useExtensionStore, {
    storageStrategy: 'session',
  });
export const extensionStoreReady = () =>
  pegasusZustandStoreReady(STORE_NAME, useExtensionStore);
