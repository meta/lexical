/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {SerializedRawEditorState} from '../../types';
import type {StoreApi} from 'zustand';

import {create} from 'zustand';

/**
 * Editor state held by one DevTools panel, for the one tab it inspects.
 *
 * This store is local to the panel document: it is not the shared extension
 * store and is never mirrored into another surface, so no page's content and
 * no other tab's content can reach it. The background pushes this panel's tab
 * into it (see `DevToolsPanelService`), and closing the panel discards it.
 */
export interface PanelState {
  states: {[editorKey: string]: SerializedRawEditorState};
  setStates: (states: {[editorKey: string]: SerializedRawEditorState}) => void;
  clear: () => void;
}

export type PanelStore = StoreApi<PanelState>;

export const usePanelStore = create<PanelState>()(set => ({
  clear: () => set({states: {}}),
  setStates: states => set({states}),
  states: {},
}));
