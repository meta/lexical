/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {
  NodeContextMenuOption,
  NodeContextMenuPlugin,
  NodeContextMenuSeparator,
} from '@lexical/react/LexicalNodeContextMenuPlugin';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const MENU_CLASS = 'node-context-menu';

describe('NodeContextMenuPlugin', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      reactRoot.unmount();
    });
    container.remove();
  });

  async function renderPlugin(
    showOn: boolean,
    withSeparator = false,
  ): Promise<void> {
    const items = [
      ...(withSeparator ? [new NodeContextMenuSeparator()] : []),
      new NodeContextMenuOption('Do a thing', {
        $onSelect: vi.fn(),
        $showOn: () => showOn,
      }),
    ];
    await act(async () => {
      reactRoot.render(
        <LexicalComposer
          initialConfig={{
            namespace: 'context-menu',
            onError: (error: Error) => {
              throw error;
            },
          }}>
          <RichTextPlugin
            contentEditable={<ContentEditable />}
            ErrorBoundary={({children}) => <>{children}</>}
          />
          <NodeContextMenuPlugin className={MENU_CLASS} items={items} />
        </LexicalComposer>,
      );
    });
  }

  async function rightClick(): Promise<MouseEvent> {
    const rootElement = container.querySelector(
      '[contenteditable="true"]',
    ) as HTMLElement;
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      rootElement.dispatchEvent(event);
    });
    return event;
  }

  function isMenuOpen(): boolean {
    return document.querySelector(`.${MENU_CLASS}`) !== null;
  }

  it('leaves the native context menu alone when no item is shown', async () => {
    await renderPlugin(false);

    const event = await rightClick();
    expect(event.defaultPrevented).toBe(false);
    expect(isMenuOpen()).toBe(false);
  });

  it('opens and replaces the native context menu when an item is shown', async () => {
    await renderPlugin(true);

    const event = await rightClick();
    expect(event.defaultPrevented).toBe(true);
    expect(isMenuOpen()).toBe(true);
  });

  it('leaves the native context menu alone when only separators remain', async () => {
    // Separators have no $showOn, so they survive the filter even when every
    // option is hidden -- a menu of nothing but dividers is still no menu.
    await renderPlugin(false, true);

    const event = await rightClick();
    expect(event.defaultPrevented).toBe(false);
    expect(isMenuOpen()).toBe(false);
  });
});
