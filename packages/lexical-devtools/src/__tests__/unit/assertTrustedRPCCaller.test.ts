/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {PegasusRPCMessage, RuntimeContext} from '@webext-pegasus/rpc';

import {describe, expect, it} from 'vitest';

import {assertTrustedRPCCaller} from '../../entrypoints/injected/assertTrustedRPCCaller';

function messageFrom(context: unknown): PegasusRPCMessage {
  return {
    id: 'test-message',
    sender: {context: context as RuntimeContext, tabId: 1},
    timestamp: 0,
  };
}

describe('assertTrustedRPCCaller', () => {
  it('allows the extension surfaces that drive the injected service', () => {
    expect(() => assertTrustedRPCCaller(messageFrom('devtools'))).not.toThrow();
    expect(() => assertTrustedRPCCaller(messageFrom('popup'))).not.toThrow();
  });

  it('rejects calls from the window context', () => {
    // The content script relay labels the origin of anything forwarded out
    // of a page as `window`.
    expect(() => assertTrustedRPCCaller(messageFrom('window'))).toThrow(
      /untrusted context "window"/,
    );
  });

  it('rejects every other context', () => {
    for (const context of ['content-script', 'background', 'options']) {
      expect(() => assertTrustedRPCCaller(messageFrom(context))).toThrow(
        /untrusted context/,
      );
    }
  });

  it('rejects messages with a missing or malformed sender', () => {
    expect(() => assertTrustedRPCCaller(messageFrom(undefined))).toThrow(
      /untrusted context/,
    );
    expect(() =>
      assertTrustedRPCCaller({id: 'x', timestamp: 0} as PegasusRPCMessage),
    ).toThrow(/untrusted context/);
  });
});
