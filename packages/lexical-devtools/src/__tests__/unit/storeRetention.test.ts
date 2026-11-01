/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {SerializedRawEditorState} from '../../types';

import {beforeEach, describe, expect, it} from 'vitest';

import {MAX_RETAINED_EDITORS_PER_TAB, useExtensionStore} from '../../store';

const state = () => useExtensionStore.getState();

function statesFor(count: number): {
  [editorKey: string]: SerializedRawEditorState;
} {
  return Object.fromEntries(
    Array.from({length: count}, (_, i) => [
      `editor-${i}`,
      {_nodeMap: {}, _selection: null} as unknown as SerializedRawEditorState,
    ]),
  );
}

describe('extension store retention', () => {
  beforeEach(() => {
    useExtensionStore.setState({
      isPanelOpen: {},
      isSelecting: {},
      lexicalState: {},
      selectedEditorKey: {},
    });
  });

  it('keeps everything below the cap', () => {
    state().setStatesForTab(1, statesFor(3));

    expect(Object.keys(state().lexicalState[1] ?? {})).toHaveLength(3);
  });

  it('bounds what a single tab can retain', () => {
    state().setStatesForTab(1, statesFor(MAX_RETAINED_EDITORS_PER_TAB + 25));

    expect(Object.keys(state().lexicalState[1] ?? {})).toHaveLength(
      MAX_RETAINED_EDITORS_PER_TAB,
    );
  });

  it('drops the oldest entries when over the cap', () => {
    state().setStatesForTab(1, statesFor(MAX_RETAINED_EDITORS_PER_TAB + 1));

    const keys = Object.keys(state().lexicalState[1] ?? {});
    expect(keys).not.toContain('editor-0');
    expect(keys).toContain(`editor-${MAX_RETAINED_EDITORS_PER_TAB}`);
  });

  it('clearTab removes every trace of a tab', () => {
    state().setStatesForTab(7, statesFor(2));
    state().setSelectedEditorKey(7, 'editor-0');
    state().setIsSelecting(7, true);
    state().setIsPanelOpen(7, true);

    state().clearTab(7);

    expect(state().lexicalState).not.toHaveProperty('7');
    expect(state().selectedEditorKey).not.toHaveProperty('7');
    expect(state().isSelecting).not.toHaveProperty('7');
    expect(state().isPanelOpen).not.toHaveProperty('7');
  });

  it('clearTab leaves other tabs alone', () => {
    state().setStatesForTab(1, statesFor(2));
    state().setStatesForTab(2, statesFor(2));

    state().clearTab(1);

    expect(state().lexicalState).not.toHaveProperty('1');
    expect(Object.keys(state().lexicalState[2] ?? {})).toHaveLength(2);
  });

  it('clearTab on an unknown tab is a no-op', () => {
    state().setStatesForTab(1, statesFor(1));
    const before = state().lexicalState;

    state().clearTab(999);

    expect(state().lexicalState).toBe(before);
  });
});
