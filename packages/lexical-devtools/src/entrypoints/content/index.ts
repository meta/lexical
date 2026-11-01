/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {initPegasusTransport} from '@webext-pegasus/transport/content-script';

import {CHANNEL_NAMESPACE_PARAM} from '../../constants';
import {isContentScriptPing} from '../../contentScriptPing';
import {extensionStoreReady} from '../../store.ts';
import injectScript from './injectScript';

/**
 * Generate the window messaging namespace shared by this content script and
 * the injected (main world) script.
 *
 * The namespace is scoped to a single page load rather than being a shared
 * constant, so the two halves of the extension agree on a name that is
 * specific to this page.
 */
function generateChannelNamespace(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export default defineContentScript({
  main(_ctx) {
    const namespace = generateChannelNamespace();

    initPegasusTransport({allowWindowMessagingForNamespace: namespace});

    // Lets the background detect that this page is not a restricted browser
    // page; see contentScriptPing.ts.
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (isContentScriptPing(message)) {
        sendResponse(true);
      }
    });

    // Init store for relay between injected script and the rest of the extension to work
    extensionStoreReady()
      .then(() => {
        injectScript('/injected.js', {
          [CHANNEL_NAMESPACE_PARAM]: namespace,
        });
      })
      .catch(console.error);
  },
  matches: ['<all_urls>'],
  registration: 'manifest',
  runAt: 'document_end',
});
