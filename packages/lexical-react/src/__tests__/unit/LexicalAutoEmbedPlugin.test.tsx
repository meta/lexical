/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor, NodeKey} from 'lexical';

import {AutoLinkNode, LinkNode} from '@lexical/link';
import {
  AutoEmbedOption,
  type EmbedConfig,
  type EmbedMatchResult,
  LexicalAutoEmbedPlugin,
  URL_MATCHER,
} from '@lexical/react/LexicalAutoEmbedPlugin';
import {
  AutoLinkPlugin,
  createLinkMatcherWithRegExp,
} from '@lexical/react/LexicalAutoLinkPlugin';
import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {EditorRefPlugin} from '@lexical/react/LexicalEditorRefPlugin';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {type MenuRenderFn} from '@lexical/react/LexicalNodeMenuPlugin';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isTextNode,
  PASTE_COMMAND,
  PASTE_TAG,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import * as React from 'react';
import {act} from 'react';
import ReactDOM from 'react-dom';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const SHORT_YOUTUBE_URL = 'youtu.be/jNQXAC9IVRw';
const MATCHERS = [
  createLinkMatcherWithRegExp(URL_MATCHER),
  // A scheme-less matcher, broader than URL_MATCHER, as an app might add.
  createLinkMatcherWithRegExp(/youtu\.be\/[\w-]+/),
];

const menuRenderFn: MenuRenderFn<AutoEmbedOption> = (
  anchorElementRef,
  {options},
) =>
  anchorElementRef.current && options.length
    ? ReactDOM.createPortal(
        <ul data-testid="auto-embed-menu">
          {options.map(option => (
            <li key={option.key}>{option.title}</li>
          ))}
        </ul>,
        anchorElementRef.current,
      )
    : null;

function createPasteEvent(data: Record<string, string>): ClipboardEvent {
  const clipboardData = new DataTransfer();
  for (const [type, value] of Object.entries(data)) {
    clipboardData.setData(type, value);
  }
  return new ClipboardEvent('paste', {clipboardData});
}

describe('LexicalAutoEmbedPlugin', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;
  let editor: LexicalEditor;
  let onError: ReturnType<typeof vi.fn<(error: Error) => void>>;
  let parseUrl: ReturnType<
    typeof vi.fn<(url: string) => EmbedMatchResult | null>
  >;

  beforeEach(async () => {
    class ResizeObserverMock {
      // LexicalMenu only constructs ResizeObserver and calls observe/unobserve/disconnect.
      constructor(_callback: unknown) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);

    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);
    onError = vi.fn((error: Error) => {
      throw error;
    });
    parseUrl = vi.fn((url: string) => {
      const match = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/.exec(url);
      return match ? {id: match[1], url} : null;
    });
    const embedConfig: EmbedConfig = {
      insertNode: vi.fn(),
      parseUrl,
      type: 'youtube-video',
    };
    const editorRef = React.createRef<LexicalEditor>();

    function App() {
      return (
        <LexicalComposer
          initialConfig={{
            namespace: 'test-auto-embed',
            nodes: [LinkNode, AutoLinkNode],
            onError,
            theme: {},
          }}>
          <RichTextPlugin
            contentEditable={<ContentEditable />}
            placeholder={null}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <AutoLinkPlugin matchers={MATCHERS} />
          <EditorRefPlugin editorRef={editorRef} />
          <LexicalAutoEmbedPlugin
            embedConfigs={[embedConfig]}
            getMenuOptions={(_config, embedFn) => [
              new AutoEmbedOption('Embed', {onSelect: embedFn}),
            ]}
            menuRenderFn={menuRenderFn}
          />
        </LexicalComposer>
      );
    }

    await act(async () => {
      reactRoot.render(<App />);
    });
    editor = editorRef.current!;
    expect(editor).not.toBeNull();
  });

  afterEach(async () => {
    await act(async () => {
      reactRoot.unmount();
    });
    document.body.removeChild(container);
    vi.unstubAllGlobals();
  });

  async function pasteEvent(
    event: ClipboardEvent,
    $select: () => void = () => $getRoot().selectEnd(),
  ): Promise<void> {
    await act(async () => {
      editor.update(
        () => {
          $select();
          editor.dispatchCommand(PASTE_COMMAND, event);
        },
        {discrete: true},
      );
    });
    // Let the async parseUrl check and the menu positioning settle.
    await act(async () => {
      await Promise.resolve();
    });
  }

  function paste(
    data: Record<string, string>,
    $select?: () => void,
  ): Promise<void> {
    return pasteEvent(createPasteEvent(data), $select);
  }

  function getMenu(): Element | null {
    return document.querySelector('[data-testid="auto-embed-menu"]');
  }

  it('offers to embed a bare URL pasted as plain text', async () => {
    await paste({'text/plain': YOUTUBE_URL});

    expect(parseUrl).toHaveBeenCalledWith(YOUTUBE_URL);
    expect(getMenu()).not.toBeNull();
  });

  it('does not offer to embed a pasted sentence that contains a URL', async () => {
    await paste({
      'text/html': `<p>Look at this <a href="${YOUTUBE_URL}">${YOUTUBE_URL}</a> please</p>`,
      'text/plain': `Look at this ${YOUTUBE_URL} please`,
    });

    expect(parseUrl).not.toHaveBeenCalled();
    expect(getMenu()).toBeNull();
  });

  it('does not offer to embed a pasted plain text sentence that contains a URL', async () => {
    await paste({'text/plain': `Look at this ${YOUTUBE_URL} please`});

    expect(parseUrl).not.toHaveBeenCalled();
    expect(getMenu()).toBeNull();
  });

  it('offers to embed a copied link whose text is its URL', async () => {
    await paste({
      'text/html': `<a href="${YOUTUBE_URL}">${YOUTUBE_URL}</a>`,
      'text/plain': YOUTUBE_URL,
    });

    expect(parseUrl).toHaveBeenCalledWith(YOUTUBE_URL);
    expect(getMenu()).not.toBeNull();
  });

  it('does not offer to embed a copied link with a label', async () => {
    await paste({
      'text/html': `<a href="${YOUTUBE_URL}">first video</a>`,
      'text/plain': 'first video',
    });

    expect(parseUrl).not.toHaveBeenCalled();
    expect(getMenu()).toBeNull();
  });

  it('offers to embed a bare address that only a custom matcher links', async () => {
    await paste({'text/plain': SHORT_YOUTUBE_URL});

    expect(parseUrl).toHaveBeenCalledWith(SHORT_YOUTUBE_URL);
    expect(getMenu()).not.toBeNull();
  });

  it('still offers to embed a bare URL pasted after typed text', async () => {
    await act(async () => {
      editor.update(() => {
        const paragraph = $createParagraphNode().append(
          $createTextNode('Check this out: '),
        );
        $getRoot().clear().append(paragraph);
      });
    });

    await paste({'text/plain': YOUTUBE_URL});

    expect(parseUrl).toHaveBeenCalledWith(YOUTUBE_URL);
    expect(getMenu()).not.toBeNull();
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe(
        `Check this out: ${YOUTUBE_URL}`,
      );
    });
  });

  it('offers to embed a bare URL pasted into formatted text', async () => {
    let middleKey: NodeKey;
    await act(async () => {
      editor.update(() => {
        const middle = $createTextNode(' and ');
        middleKey = middle.getKey();
        const paragraph = $createParagraphNode().append(
          $createTextNode('Read '),
          $createTextNode('this').toggleFormat('bold'),
          middle,
          $createTextNode('that').toggleFormat('italic'),
          $createTextNode(' now'),
        );
        $getRoot().clear().append(paragraph);
      });
    });

    let pasteDirtyLeaves = 0;
    const removeUpdateListener = editor.registerUpdateListener(
      ({dirtyLeaves, tags}) => {
        if (tags.has(PASTE_TAG)) {
          pasteDirtyLeaves = dirtyLeaves.size;
        }
      },
    );
    try {
      // Paste over the word between the bold and italic runs.
      await paste({'text/plain': YOUTUBE_URL}, () => {
        $assertNodeType($getNodeByKey(middleKey), $isTextNode)!.select(1, 4);
      });
    } finally {
      removeUpdateListener();
    }

    // The formatted siblings and the split text nodes are all dirty, so a
    // dirty leaf count cannot tell this paste apart from pasted prose.
    expect(pasteDirtyLeaves).toBeGreaterThan(3);
    expect(parseUrl).toHaveBeenCalledTimes(1);
    expect(parseUrl).toHaveBeenCalledWith(YOUTUBE_URL);
    expect(getMenu()).not.toBeNull();
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe(
        `Read this ${YOUTUBE_URL} that now`,
      );
    });
  });

  it('does not throw when the clipboard reports no plain text', async () => {
    await pasteEvent(createPasteEvent({'text/html': 'replaced'}));

    expect(onError).not.toHaveBeenCalled();
    expect(parseUrl).not.toHaveBeenCalled();
    expect(getMenu()).toBeNull();
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('replaced');
    });
  });
});
