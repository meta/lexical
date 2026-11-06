/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {SerializedRawEditorState} from '../../types';
import type {PegasusRPCMessage, RuntimeContext} from '@webext-pegasus/rpc';

import {beforeEach, describe, expect, it} from 'vitest';

import {createDevToolsPanelService} from '../../entrypoints/devtools-panel/DevToolsPanelService';
import {usePanelStore} from '../../entrypoints/devtools-panel/panelStore';

function messageFrom(context: unknown): PegasusRPCMessage {
  return {
    id: 'test-message',
    sender: {context: context as RuntimeContext, tabId: 1},
    timestamp: 0,
  };
}

const someState = {
  _nodeMap: {},
  _selection: null,
} as unknown as SerializedRawEditorState;

describe('DevToolsPanelService', () => {
  beforeEach(() => {
    usePanelStore.getState().clear();
  });

  it('accepts state routed by the background', () => {
    const service = createDevToolsPanelService(usePanelStore);

    service.receiveStates(messageFrom('background'), {'editor-1': someState});

    expect(Object.keys(usePanelStore.getState().states)).toEqual(['editor-1']);
  });

  it('refuses state pushed by anything else, a page above all', () => {
    const service = createDevToolsPanelService(usePanelStore);

    for (const context of ['window', 'content-script', 'devtools', 'popup']) {
      expect(() =>
        service.receiveStates(messageFrom(context), {'editor-1': someState}),
      ).toThrow(/untrusted context/);
    }

    expect(usePanelStore.getState().states).toEqual({});
  });

  it('clear drops what the panel was holding', () => {
    const service = createDevToolsPanelService(usePanelStore);
    service.receiveStates(messageFrom('background'), {'editor-1': someState});

    usePanelStore.getState().clear();

    expect(usePanelStore.getState().states).toEqual({});
  });
});
