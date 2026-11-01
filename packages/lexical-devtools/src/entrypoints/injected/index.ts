/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ITabIDService} from '../background/getTabIDService';

import {getRPCService} from '@webext-pegasus/rpc';
import {initPegasusTransport} from '@webext-pegasus/transport/window';

import {CHANNEL_NAMESPACE_PARAM} from '../../constants';
import {extensionStoreReady} from '../../store.ts';
import main from './main';

const EXTENSION_PROTOCOLS = new Set([
  'chrome-extension:',
  'moz-extension:',
  'safari-web-extension:',
]);

/**
 * Recover the per-page-load window messaging namespace that the content script
 * generated and handed to us on the `src` of the script tag it injected.
 *
 * Only script tags served from the extension itself are considered, since this
 * script runs in the main world. (`import.meta.url` is not usable here — the
 * bundler rewrites it to `self.location.href`.)
 */
function readChannelNamespace(): string | null {
  for (const script of Array.from(document.scripts)) {
    const src = script.src;
    if (src === '') {
      continue;
    }

    let url: URL;
    try {
      url = new URL(src);
    } catch {
      continue;
    }

    if (!EXTENSION_PROTOCOLS.has(url.protocol)) {
      continue;
    }

    const namespace = url.searchParams.get(CHANNEL_NAMESPACE_PARAM);
    if (namespace !== null && namespace !== '') {
      return namespace;
    }
  }

  return null;
}

export default defineUnlistedScript({
  main() {
    const namespace = readChannelNamespace();

    if (namespace === null) {
      // Without a namespace from the content script there is no channel to
      // talk on, so there is nothing to start.
      console.error(
        'Lexical DevTools: no messaging namespace was provided, not starting.',
      );
      return;
    }

    initPegasusTransport({namespace});
    getRPCService<ITabIDService>('getTabID', 'background')().then(tabID =>
      extensionStoreReady().then(extensionStore => main(tabID, extensionStore)),
    );
  },
});
