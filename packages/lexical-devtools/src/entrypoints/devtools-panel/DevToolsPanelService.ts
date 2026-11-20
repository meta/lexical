/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {SerializedRawEditorState} from '../../types';
import type {PanelStore} from './panelStore';
import type {PegasusRPCMessage} from '@webext-pegasus/rpc';

/**
 * Refuse anything that did not come from the background service worker.
 *
 * The background is the only context that may push editor state into a
 * panel: it is the one that can attribute a report to a tab, using the tab id
 * the browser attests on the sender. A page cannot label itself `background`.
 */
export function assertFromBackground(message: PegasusRPCMessage): void {
  const context = message?.sender?.context;

  if (context !== 'background') {
    throw new Error(
      `DevToolsPanelService: refusing call from untrusted context "${String(
        context,
      )}"`,
    );
  }
}

export function createDevToolsPanelService(store: PanelStore) {
  return {
    /**
     * Receive the editor state of the tab this panel is attached to.
     *
     * The background only ever routes a tab's state to the panel inspecting
     * that tab, so what arrives here describes this panel's page and no
     * other.
     */
    receiveStates(
      message: PegasusRPCMessage,
      states: {[editorKey: string]: SerializedRawEditorState},
    ): void {
      assertFromBackground(message);

      store.getState().setStates(states);
    },
  };
}

export type IDevToolsPanelService = ReturnType<
  typeof createDevToolsPanelService
>;
