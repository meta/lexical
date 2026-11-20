/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {PegasusRPCMessage, RuntimeContext} from '@webext-pegasus/rpc';

/**
 * Extension surfaces that drive the services registered by the injected
 * script.
 *
 * The injected script runs in the page's main world, so its services check
 * that calls arrive from one of the extension's own surfaces. The content
 * script relay labels the origin of anything it forwards out of a page, which
 * is what makes the context reliable here.
 */
const TRUSTED_CALLER_CONTEXTS: ReadonlySet<string> = new Set<RuntimeContext>([
  'devtools',
  'popup',
]);

export function assertTrustedRPCCaller(message: PegasusRPCMessage): void {
  const context = message?.sender?.context;

  if (typeof context !== 'string' || !TRUSTED_CALLER_CONTEXTS.has(context)) {
    throw new Error(
      `InjectedPegasusService: refusing call from untrusted context "${String(
        context,
      )}"`,
    );
  }
}
