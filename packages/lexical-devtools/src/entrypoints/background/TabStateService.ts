/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ExtensionState} from '../../store';
import type {SerializedRawEditorState} from '../../types';
import type {IDevToolsPanelService} from '../devtools-panel/DevToolsPanelService';
import type {PegasusRPCMessage} from '@webext-pegasus/rpc';
import type {StoreApi} from 'zustand';

import {getRPCService} from '@webext-pegasus/rpc';

/**
 * Where a report about a tab is sent.
 *
 * The panel's service as its caller sees it: the RPC proxy drops the message
 * argument and answers with a promise. Injectable so the routing can be
 * asserted in tests without a browser.
 */
export interface PanelServiceClient {
  receiveStates(states: {
    [editorKey: string]: SerializedRawEditorState;
  }): Promise<void>;
}

export type PanelServiceFactory = (tabID: number) => PanelServiceClient;

const defaultPanelServiceFactory: PanelServiceFactory = (tabID: number) =>
  getRPCService<IDevToolsPanelService>('DevToolsPanelService', {
    context: 'devtools',
    tabId: tabID,
  });

/**
 * The tab a message came from, as the browser attests it.
 *
 * A caller cannot choose this value: it is stamped by the extension
 * messaging layer from the sender of the message, which is why a page can
 * only ever report about the tab it is running in.
 */
function senderTabID(message: PegasusRPCMessage): number {
  const tabID = message?.sender?.tabId;

  if (typeof tabID !== 'number') {
    throw new Error(
      'TabStateService: refusing a report with no attested tab id',
    );
  }

  return tabID;
}

/**
 * What the page-world script of a tab may tell the extension about itself.
 *
 * Editor state arrives here and is forwarded straight to the DevTools panel
 * attached to the reporting tab. The background keeps a count per tab, for
 * the action icon and the popup, and no editor content at all -- so no
 * object anywhere in the extension holds the content of two pages.
 */
export function createTabStateService(
  store: StoreApi<ExtensionState>,
  panelServiceFactory: PanelServiceFactory = defaultPanelServiceFactory,
) {
  return {
    reportEditorCount(message: PegasusRPCMessage, count: number): void {
      store.getState().setEditorCount(senderTabID(message), count);
    },

    reportIsSelecting(message: PegasusRPCMessage, isSelecting: boolean): void {
      store.getState().setIsSelecting(senderTabID(message), isSelecting);
    },

    reportSelectedEditorKey(
      message: PegasusRPCMessage,
      editorKey: string | null,
    ): void {
      store.getState().setSelectedEditorKey(senderTabID(message), editorKey);
    },

    /**
     * Forward a tab's editor state to the panel inspecting that tab.
     *
     * The injected script only sends this while a panel is open for its tab,
     * and the destination is derived from the attested sender, never from
     * anything the caller passes.
     */
    reportStates(
      message: PegasusRPCMessage,
      states: {[editorKey: string]: SerializedRawEditorState},
    ): void {
      const tabID = senderTabID(message);

      panelServiceFactory(tabID)
        .receiveStates(states)
        .catch((err: unknown) => {
          // The panel may have closed between the page's scan and this
          // delivery; nothing is retained for a later retry.
          console.warn('No DevTools panel to receive state', err);
        });
    },
  };
}

export type ITabStateService = ReturnType<typeof createTabStateService>;
