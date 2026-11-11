/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from 'lexical';

import {createTestEditor} from 'lexical/src/__tests__/utils';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {useMenuAnchorRef} from '../../shared/LexicalMenu';

let shadowEditor: LexicalEditor;
let shadowRootElement: HTMLDivElement;
let shadowRoot: ShadowRoot;

vi.mock('@lexical/react/LexicalComposerContext', () => ({
  useLexicalComposerContext: () => [shadowEditor],
}));

describe('useMenuAnchorRef shadow DOM', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);

    const host = document.createElement('div');
    document.body.appendChild(host);
    shadowRoot = host.attachShadow({mode: 'open'});
    shadowRootElement = document.createElement('div');
    shadowRootElement.contentEditable = 'true';
    shadowRoot.appendChild(shadowRootElement);

    shadowEditor = createTestEditor();
    shadowEditor.setRootElement(shadowRootElement);
  });

  afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    shadowRootElement.remove();
    (shadowRoot.host as HTMLElement).remove();
    vi.clearAllMocks();
  });

  it('appends anchor to the shadow root when no explicit parent is provided', async () => {
    let ref: React.RefObject<HTMLElement | null> | undefined;

    function App() {
      ref = useMenuAnchorRef(null, vi.fn());
      return null;
    }

    await act(async () => {
      reactRoot.render(<App />);
    });

    expect(ref).toBeDefined();
    const anchor = ref!.current;
    expect(anchor).not.toBeNull();
    expect(anchor!.getRootNode()).toBe(shadowRoot);
    expect(document.body.contains(anchor!)).toBe(false);
  });

  it('removes anchor from shadow root on unmount', async () => {
    let ref: React.RefObject<HTMLElement | null> | undefined;

    function App() {
      ref = useMenuAnchorRef(null, vi.fn());
      return null;
    }

    await act(async () => {
      reactRoot.render(<App />);
    });

    const anchor = ref!.current;
    expect(anchor).not.toBeNull();
    expect(shadowRoot.contains(anchor!)).toBe(true);

    await act(async () => {
      reactRoot.render(<span />);
    });

    expect(shadowRoot.contains(anchor!)).toBe(false);
  });

  it('uses explicit parent even when editor is in shadow', async () => {
    const explicitParent = document.createElement('div');
    document.body.appendChild(explicitParent);
    let ref: React.RefObject<HTMLElement | null> | undefined;

    function App() {
      ref = useMenuAnchorRef(null, vi.fn(), undefined, explicitParent);
      return null;
    }

    await act(async () => {
      reactRoot.render(<App />);
    });

    const anchor = ref!.current;
    expect(anchor).not.toBeNull();
    expect(explicitParent.contains(anchor!)).toBe(true);
    explicitParent.remove();
  });
});
