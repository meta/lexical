/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {ChakraProvider, defaultSystem} from '@chakra-ui/react';
import {initPegasusTransport} from '@webext-pegasus/transport/devtools';
import React from 'react';
import ReactDOM from 'react-dom/client';

import {extensionStoreReady, useExtensionStore} from '../../store.ts';
import App from './App.tsx';

const tabID = browser.devtools.inspectedWindow.tabId;
initPegasusTransport();

extensionStoreReady().then(() => {
  // Tell the injected script that the user is looking at this tab, so that it
  // relays editor text unmasked.
  useExtensionStore.getState().setIsPanelOpen(tabID, true);

  const markClosed = () =>
    useExtensionStore.getState().setIsPanelOpen(tabID, false);
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
