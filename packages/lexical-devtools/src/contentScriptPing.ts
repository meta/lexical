/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Message the background sends to a tab to learn whether our content script
 * is running there.
 *
 * Browsers never run extension content scripts on their own pages (chrome://,
 * about:, the Web Store, ...), so a tab whose content script answers is one
 * DevTools can inspect. Asking the page this way lets the background tell
 * restricted pages apart without reading `Tab.url`, which would require the
 * `tabs` permission.
 */
export const CONTENT_SCRIPT_PING = 'lexical-devtools:content-script-ping';

export interface ContentScriptPingMessage {
  type: typeof CONTENT_SCRIPT_PING;
}

export function isContentScriptPing(
  message: unknown,
): message is ContentScriptPingMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as {type?: unknown}).type === CONTENT_SCRIPT_PING
  );
}
