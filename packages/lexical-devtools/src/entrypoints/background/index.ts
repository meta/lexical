/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {registerRPCService} from '@webext-pegasus/rpc';
import {initPegasusTransport} from '@webext-pegasus/transport/background';

import {
  initExtensionStoreBackend,
  useExtensionStore as extensionStore,
} from '../../store.ts';
import ActionIconWatchdog from './ActionIconWatchdog.ts';
import {getTabIDService} from './getTabIDService';
import {createTabStateService} from './TabStateService.ts';

export default defineBackground(() => {
  initPegasusTransport();
  // Way for content script & injected scripts to get their tab ID
  registerRPCService('getTabID', getTabIDService);

  // What a page may report about itself. Editor state arrives here and is
  // routed to the panel inspecting the reporting tab; the background keeps
  // counts, not content.
  registerRPCService('TabStateService', createTabStateService(extensionStore));

  // Store initialization so other extension surfaces can use it
  // as all changes go through background SW
  initExtensionStoreBackend().catch(err =>
    console.error('Failed to initialize extension store', err),
  );

  ActionIconWatchdog.start(extensionStore).catch(console.error);
});
