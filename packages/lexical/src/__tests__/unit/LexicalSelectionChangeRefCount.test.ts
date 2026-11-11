/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {createEditor} from 'lexical';
import {afterEach, describe, expect, type MockInstance, test, vi} from 'vitest';

// The shared `selectionchange` listener is reference counted across every
// editor registered against a document (via createRefCountedRegistry): it is
// added when the first root element is registered and removed only when the
// last one is unregistered. These tests pin that lifecycle by spying on the
// document's listener registration.
describe('selectionchange listener reference counting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  function countSelectionChange(spy: MockInstance): number {
    return spy.mock.calls.filter(
      (args: unknown[]) => args[0] === 'selectionchange',
    ).length;
  }

  function mountEditor(): {detach: () => void} {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    const editor = createEditor();
    editor.setRootElement(root);
    return {
      detach() {
        editor.setRootElement(null);
        root.remove();
      },
    };
  }

  test('adds the listener once for multiple editors and removes it after the last detaches', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const a = mountEditor();
    expect(countSelectionChange(addSpy)).toBe(1);

    // A second editor on the same document shares the one listener.
    const b = mountEditor();
    expect(countSelectionChange(addSpy)).toBe(1);

    // Detaching the first editor must not remove the still-shared listener.
    a.detach();
    expect(countSelectionChange(removeSpy)).toBe(0);

    // Detaching the last editor removes it exactly once.
    b.detach();
    expect(countSelectionChange(removeSpy)).toBe(1);
  });

  test('re-adds the listener when an editor mounts again after the document went idle', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');

    mountEditor().detach();
    expect(countSelectionChange(addSpy)).toBe(1);

    // Once the count returned to zero, a fresh mount re-activates the listener.
    mountEditor();
    expect(countSelectionChange(addSpy)).toBe(2);
  });
});
