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

import {extensionStoreReady} from '../../store.ts';
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

extensionStoreReady().then(() => {
  // The page only sends editor state while a panel is open for it.
  injectedPegasusService.setPanelOpen(true).catch(console.error);

  const markClosed = () => {
    usePanelStore.getState().clear();
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
