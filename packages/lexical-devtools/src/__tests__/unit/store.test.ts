/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {beforeEach, describe, expect, it} from 'vitest';

import {useExtensionStore} from '../../store';

const state = () => useExtensionStore.getState();

describe('shared extension store', () => {
  beforeEach(() => {
    useExtensionStore.setState({
      editorCount: {},
      isSelecting: {},
      selectedEditorKey: {},
    });
  });

  it('holds a count for a tab, never its content', () => {
    state().setEditorCount(1, 3);

    expect(state().editorCount[1]).toBe(3);
    // Nothing in this store can carry an editor's text.
    expect(Object.keys(state())).not.toContain('lexicalState');
  });

  it('marks a restricted tab apart from one with no editors', () => {
    state().setEditorCount(1, 0);
    state().markTabAsRestricted(2);

    expect(state().editorCount[1]).toBe(0);
    expect(state().editorCount[2]).toBeNull();
  });

  it('clearTab removes every trace of a tab', () => {
    state().setEditorCount(7, 2);
    state().setSelectedEditorKey(7, 'editor-0');
    state().setIsSelecting(7, true);

    state().clearTab(7);

    expect(state().editorCount).not.toHaveProperty('7');
    expect(state().selectedEditorKey).not.toHaveProperty('7');
    expect(state().isSelecting).not.toHaveProperty('7');
  });

  it('clearTab leaves other tabs alone', () => {
    state().setEditorCount(1, 2);
    state().setEditorCount(2, 5);

    state().clearTab(1);

    expect(state().editorCount).not.toHaveProperty('1');
    expect(state().editorCount[2]).toBe(5);
  });

  it('clearTab on an unknown tab is a no-op', () => {
    state().setEditorCount(1, 1);
    const before = state().editorCount;

    state().clearTab(999);

    expect(state().editorCount).toBe(before);
  });
});
