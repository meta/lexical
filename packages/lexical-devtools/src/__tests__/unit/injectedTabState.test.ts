/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {SerializedRawEditorState} from '../../types';

import {beforeEach, describe, expect, it, vi} from 'vitest';

const rpc = vi.hoisted(() => ({
  calls: [] as {args: unknown[]; method: string}[],
  panelOpenAnswer: false,
}));

vi.mock('@webext-pegasus/rpc', () => ({
  getRPCService: () =>
    new Proxy(
      {},
      {
        get:
          (_target, method: string) =>
          (...args: unknown[]) => {
            rpc.calls.push({args, method});
            return Promise.resolve(
              method === 'isPanelOpenForMyTab'
                ? rpc.panelOpenAnswer
                : undefined,
            );
          },
      },
    ),
}));

const {InjectedTabState} =
  await import('../../entrypoints/injected/InjectedTabState');

const stateFor = (text: string) =>
  ({
    _nodeMap: {1: {__text: text, __type: 'text'}},
    _selection: null,
  }) as unknown as SerializedRawEditorState;

const scanOf = (...texts: string[]) =>
  Object.fromEntries(texts.map((text, i) => [`editor-${i}`, stateFor(text)]));

const callsOf = (method: string) =>
  rpc.calls.filter(call => call.method === method);

const lastCount = () =>
  callsOf('reportEditorCount').at(-1)?.args[0] as number | undefined;

describe('InjectedTabState', () => {
  beforeEach(() => {
    rpc.calls = [];
    rpc.panelOpenAnswer = false;
  });

  it('reports a count without sending any content while no panel is open', () => {
    const tabState = new InjectedTabState();

    tabState.replaceStates(scanOf('CANARY-A', 'CANARY-B'));

    expect(lastCount()).toBe(2);
    expect(callsOf('reportStates')).toHaveLength(0);
    expect(JSON.stringify(rpc.calls)).not.toContain('CANARY-A');
  });

  it('sends content once a panel is open, and stops when it closes', () => {
    const tabState = new InjectedTabState();
    tabState.setPanelOpen(true);

    tabState.replaceStates(scanOf('CANARY-A'));
    expect(callsOf('reportStates')).toHaveLength(2);

    tabState.setPanelOpen(false);
    rpc.calls = [];
    tabState.setState('editor-0', stateFor('CANARY-C'));

    expect(callsOf('reportStates')).toHaveLength(0);
    expect(JSON.stringify(rpc.calls)).not.toContain('CANARY-C');
  });

  it('keeps the editor count right after the panel closes', () => {
    const tabState = new InjectedTabState();
    tabState.setPanelOpen(true);
    tabState.replaceStates(scanOf('a', 'b', 'c'));

    tabState.setPanelOpen(false);

    // The page still has three editors: the popup must not read zero
    // because nobody is inspecting them.
    expect(lastCount()).toBe(3);
  });

  it('adopts a panel that was already attached when the page loaded', async () => {
    rpc.panelOpenAnswer = true;
    const tabState = new InjectedTabState();

    await tabState.adoptPanelState();

    expect(tabState.isPanelOpen()).toBe(true);

    tabState.replaceStates(scanOf('CANARY-RELOAD'));
    expect(JSON.stringify(callsOf('reportStates'))).toContain('CANARY-RELOAD');
  });

  it('stays closed when no panel is attached', async () => {
    const tabState = new InjectedTabState();

    await tabState.adoptPanelState();

    expect(tabState.isPanelOpen()).toBe(false);
  });

  it('registers a listener for an editor only once', () => {
    const tabState = new InjectedTabState();

    expect(tabState.isListening('editor-0')).toBe(false);
    tabState.markListening('editor-0');
    expect(tabState.isListening('editor-0')).toBe(true);
  });
});
