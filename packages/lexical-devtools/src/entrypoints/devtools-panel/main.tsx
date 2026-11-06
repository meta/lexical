/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {IInjectedPegasusService} from '../injected/InjectedPegasusService';

import {ChakraProvider, defaultSystem} from '@chakra-ui/react';
import {getRPCService, registerRPCService} from '@webext-pegasus/rpc';
import {initPegasusTransport} from '@webext-pegasus/transport/devtools';
import React from 'react';
import ReactDOM from 'react-dom/client';

import {extensionStoreReady, useExtensionStore} from '../../store.ts';
import App from './App.tsx';
import {createDevToolsPanelService} from './DevToolsPanelService.ts';
import {usePanelStore} from './panelStore.ts';

const tabID = browser.devtools.inspectedWindow.tabId;
initPegasusTransport();

// Where this tab's editor state arrives. Registered before the page is told
// the panel is open, so nothing is pushed into a service that is not there.
registerRPCService(
  'DevToolsPanelService',
  createDevToolsPanelService(usePanelStore),
);

const injectedPegasusService = getRPCService<IInjectedPegasusService>(
  'InjectedPegasusService',
  {context: 'window', tabId: tabID},
);

/**
 * Announce this panel to the page currently in the inspected tab.
 *
 * Both halves matter: the flag in the shared store is what a page reads when
 * it starts (see `TabStateService.isPanelOpenForMyTab`), and the direct call
 * starts the flow for the page that is already running.
 */
function attachToPage() {
  // Whatever the previous page sent describes editors that no longer exist.
  usePanelStore.getState().clear();
  useExtensionStore.getState().setIsPanelOpen(tabID, true);
  injectedPegasusService.setPanelOpen(true).catch(console.error);
}

extensionStoreReady().then(() => {
  attachToPage();

  // This document outlives the page it inspects, so every navigation brings
  // a new page that has to be told the panel is here.
  browser.devtools.network.onNavigated.addListener(attachToPage);

  const markClosed = () => {
    usePanelStore.getState().clear();
    useExtensionStore.getState().setIsPanelOpen(tabID, false);
    injectedPegasusService.setPanelOpen(false).catch(console.error);
  };
  window.addEventListener('pagehide', markClosed);
  window.addEventListener('beforeunload', markClosed);

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ChakraProvider value={defaultSystem}>
        <App tabID={tabID} />
      </ChakraProvider>
    </React.StrictMode>,
  );
});
