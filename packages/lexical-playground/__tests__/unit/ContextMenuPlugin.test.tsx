/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {
  COMMAND_PRIORITY_CRITICAL,
  type LexicalEditor,
  PASTE_COMMAND,
  type PasteCommandType,
} from 'lexical';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import ContextMenuPlugin from '../../src/plugins/ContextMenuPlugin';

describe('ContextMenuPlugin Clipboard', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;
  let editor: LexicalEditor;

  function CaptureEditor() {
    const [contextEditor] = useLexicalComposerContext();
    editor = contextEditor;
    return null;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);
    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(async () => {
    await act(async () => {
      reactRoot.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderPlugin(): Promise<void> {
    await act(async () => {
      reactRoot.render(
        <LexicalComposer
          initialConfig={{
            namespace: 'context-menu-test',
            onError: (error: Error) => {
              throw error;
            },
          }}>
          <CaptureEditor />
          <RichTextPlugin
            contentEditable={<ContentEditable />}
            ErrorBoundary={({children}) => <>{children}</>}
          />
          <ContextMenuPlugin shouldPreserveNewLinesInMarkdown={false} />
        </LexicalComposer>,
      );
    });
  }

  async function openContextMenu(): Promise<void> {
    const rootElement = container.querySelector(
      '[contenteditable="true"]',
    ) as HTMLElement;
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 50,
    });
    await act(async () => {
      rootElement.dispatchEvent(event);
    });
  }

  function getMenuItem(text: string): HTMLElement | null {
    const items = Array.from(
      document.querySelectorAll('.PlaygroundEditorTheme__contextMenuItem'),
    );
    return (
      (items.find(item => item.textContent?.includes(text)) as HTMLElement) ??
      null
    );
  }

  it('pastes successfully when navigator.permissions.query throws (e.g. Firefox)', async () => {
    const mockPasteHandler = vi.fn((_event: PasteCommandType) => true);

    const mockClipboardItem = {
      getType: vi.fn(
        async () => new Blob(['hello world'], {type: 'text/plain'}),
      ),
      types: ['text/plain'],
    };

    vi.stubGlobal('navigator', {
      clipboard: {
        read: vi.fn(async () => [mockClipboardItem]),
        readText: vi.fn(async () => 'hello world'),
      },
      permissions: {
        query: vi.fn(async () => {
          throw new TypeError(
            "'clipboard-read' (value of 'name' member of PermissionDescriptor) is not a valid PermissionName.",
          );
        }),
      },
    });

    await renderPlugin();
    editor.registerCommand(
      PASTE_COMMAND,
      mockPasteHandler,
      COMMAND_PRIORITY_CRITICAL,
    );

    await openContextMenu();
    const pasteOption = getMenuItem('Paste');
    expect(pasteOption).not.toBeNull();

    await act(async () => {
      pasteOption!.click();
    });

    expect(mockPasteHandler).toHaveBeenCalledTimes(1);
    const dispatchedEvent = mockPasteHandler.mock.calls[0][0] as ClipboardEvent;
    expect(dispatchedEvent.clipboardData?.getData('text/plain')).toBe(
      'hello world',
    );
    expect(alert).not.toHaveBeenCalled();
  });

  it('pastes plain text successfully when navigator.permissions.query throws (e.g. Firefox)', async () => {
    const mockPasteHandler = vi.fn((_event: PasteCommandType) => true);

    vi.stubGlobal('navigator', {
      clipboard: {
        readText: vi.fn(async () => 'plain text content'),
      },
      permissions: {
        query: vi.fn(async () => {
          throw new TypeError('unsupported PermissionName');
        }),
      },
    });

    await renderPlugin();
    editor.registerCommand(
      PASTE_COMMAND,
      mockPasteHandler,
      COMMAND_PRIORITY_CRITICAL,
    );

    await openContextMenu();
    const pastePlainTextOption = getMenuItem('Paste as Plain Text');
    expect(pastePlainTextOption).not.toBeNull();

    await act(async () => {
      pastePlainTextOption!.click();
    });

    expect(mockPasteHandler).toHaveBeenCalledTimes(1);
    const dispatchedEvent = mockPasteHandler.mock.calls[0][0] as ClipboardEvent;
    expect(dispatchedEvent.clipboardData?.getData('text/plain')).toBe(
      'plain text content',
    );
    expect(alert).not.toHaveBeenCalled();
  });

  it('shows alert and blocks paste when clipboard-read permission is denied', async () => {
    const mockPasteHandler = vi.fn((_event: PasteCommandType) => true);

    vi.stubGlobal('navigator', {
      clipboard: {
        read: vi.fn(),
      },
      permissions: {
        query: vi.fn(async () => ({state: 'denied'})),
      },
    });

    await renderPlugin();
    editor.registerCommand(
      PASTE_COMMAND,
      mockPasteHandler,
      COMMAND_PRIORITY_CRITICAL,
    );

    await openContextMenu();
    const pasteOption = getMenuItem('Paste');
    expect(pasteOption).not.toBeNull();

    await act(async () => {
      pasteOption!.click();
    });

    expect(alert).toHaveBeenCalledWith('Not allowed to paste from clipboard.');
    expect(mockPasteHandler).not.toHaveBeenCalled();
  });

  it('handles NotAllowedError when clipboard.read() rejects with permission denial', async () => {
    const mockPasteHandler = vi.fn((_event: PasteCommandType) => true);

    vi.stubGlobal('navigator', {
      clipboard: {
        read: vi.fn(async () => {
          const err = new Error('The request is not allowed');
          err.name = 'NotAllowedError';
          throw err;
        }),
      },
      permissions: {
        query: vi.fn(async () => {
          throw new TypeError('unsupported');
        }),
      },
    });

    await renderPlugin();
    editor.registerCommand(
      PASTE_COMMAND,
      mockPasteHandler,
      COMMAND_PRIORITY_CRITICAL,
    );

    await openContextMenu();
    const pasteOption = getMenuItem('Paste');
    expect(pasteOption).not.toBeNull();

    await act(async () => {
      pasteOption!.click();
    });

    expect(alert).toHaveBeenCalledWith('Not allowed to paste from clipboard.');
    expect(mockPasteHandler).not.toHaveBeenCalled();
  });
});
