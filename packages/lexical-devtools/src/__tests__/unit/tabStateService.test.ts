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

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {createTabStateService} from '../../entrypoints/background/TabStateService';
import {useExtensionStore} from '../../store';

function messageFrom(tabId: unknown): PegasusRPCMessage {
  return {
    id: 'test-message',
    sender: {
      context: 'window' as RuntimeContext,
      tabId: tabId as number,
    },
    timestamp: 0,
  };
}

const statesFor = (text: string) =>
  ({
    _nodeMap: {1: {__text: text, __type: 'text'}},
    _selection: null,
  }) as unknown as SerializedRawEditorState;

describe('TabStateService', () => {
  beforeEach(() => {
    useExtensionStore.setState({
      editorCount: {},
      isSelecting: {},
      selectedEditorKey: {},
    });
  });

  it('attributes a report to the tab the browser attests, not to anything the caller says', () => {
    const service = createTabStateService(useExtensionStore);

    service.reportEditorCount(messageFrom(42), 3);

    expect(useExtensionStore.getState().editorCount[42]).toBe(3);
  });

  it('refuses a report with no attested tab id', () => {
    const service = createTabStateService(useExtensionStore);

    expect(() => service.reportEditorCount(messageFrom(undefined), 1)).toThrow(
      /no attested tab id/,
    );
    expect(() => service.reportIsSelecting(messageFrom('42'), true)).toThrow(
      /no attested tab id/,
    );
  });

  it('routes editor state only to the panel of the reporting tab', () => {
    const receiveStates = vi.fn().mockResolvedValue(undefined);
    const panelFor = vi.fn(() => ({receiveStates}));
    const service = createTabStateService(
      useExtensionStore,
      panelFor as unknown as Parameters<typeof createTabStateService>[1],
    );

    const states = {'editor-1': statesFor('hello')};
    service.reportStates(messageFrom(7), states);

    expect(panelFor).toHaveBeenCalledWith(7);
    expect(receiveStates).toHaveBeenCalledWith(states);
  });

  it('keeps no editor content of its own', () => {
    const receiveStates = vi.fn().mockResolvedValue(undefined);
    const service = createTabStateService(useExtensionStore, (() => ({
      receiveStates,
    })) as unknown as Parameters<typeof createTabStateService>[1]);

    service.reportStates(messageFrom(7), {'editor-1': statesFor('secret')});

    expect(JSON.stringify(useExtensionStore.getState())).not.toContain(
      'secret',
    );
  });
});
