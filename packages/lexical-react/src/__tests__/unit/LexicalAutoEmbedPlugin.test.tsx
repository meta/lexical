/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$isLinkNode, AutoLinkNode, LinkNode} from '@lexical/link';
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
import {$createQuoteNode, $isQuoteNode, QuoteNode} from '@lexical/rich-text';
import {$getNearestNodeOfType} from '@lexical/utils';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isTextNode,
  $setSelection,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type ParagraphNode,
  PASTE_COMMAND,
  PASTE_TAG,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import * as React from 'react';
import {act} from 'react';
import ReactDOM from 'react-dom';
import {createRoot, type Root} from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const SHORT_YOUTUBE_URL = 'youtu.be/jNQXAC9IVRw';
const MATCHERS = [
  createLinkMatcherWithRegExp(URL_MATCHER),
  // A scheme-less matcher, broader than URL_MATCHER, as an app might add.
  createLinkMatcherWithRegExp(/youtu\.be\/[\w-]+/),
];

const menuRenderFn: MenuRenderFn<AutoEmbedOption> = (
  anchorElementRef,
  {options, selectOptionAndCleanUp},
) =>
  anchorElementRef.current && options.length
    ? ReactDOM.createPortal(
        <ul data-testid="auto-embed-menu">
          {options.map(option => (
            <li key={option.key}>
              <button onClick={() => selectOptionAndCleanUp(option)}>
                {option.title}
              </button>
            </li>
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

let container: HTMLDivElement;
let reactRoot: Root;
let editor: LexicalEditor;
let onError: Mock<(error: Error) => void>;
let parseUrl: Mock<EmbedConfig['parseUrl']>;
let insertNode: Mock<EmbedConfig['insertNode']>;
let embedConfig: EmbedConfig;
const editorRef = React.createRef<LexicalEditor>();

function App({
  $disableMenuFor,
}: {
  $disableMenuFor?: (node: LexicalNode) => boolean;
}) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'test-auto-embed',
        nodes: [LinkNode, AutoLinkNode, QuoteNode],
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
        $disableMenuFor={$disableMenuFor}
      />
    </LexicalComposer>
  );
}

describe('LexicalAutoEmbedPlugin', () => {
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
    insertNode = vi.fn();
    embedConfig = {
      insertNode,
      parseUrl,
      type: 'youtube-video',
    };

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

  function deferParseUrl(): (result: EmbedMatchResult | null) => void {
    let resolve!: (result: EmbedMatchResult | null) => void;
    parseUrl.mockReturnValueOnce(
      new Promise<EmbedMatchResult | null>(res => {
        resolve = res;
      }),
    );
    return resolve;
  }

  function getEmbedButton(): HTMLButtonElement {
    const button = getMenu()?.querySelector('button') ?? null;
    expect(button).not.toBeNull();
    return button!;
  }

  async function selectEmbedOption(): Promise<void> {
    const button = getEmbedButton();
    await act(async () => {
      button.click();
    });
  }

  function $getParagraph(): ParagraphNode {
    return $assertNodeType($getRoot().getFirstChild(), $isParagraphNode);
  }

  function $getPastedLink(): LinkNode {
    return $assertNodeType($getParagraph().getFirstChild(), $isLinkNode);
  }

  it('embeds an unchanged link without parsing its URL again', async () => {
    await paste({'text/plain': YOUTUBE_URL});
    await selectEmbedOption();

    expect(parseUrl).toHaveBeenCalledOnce();
    expect(insertNode).toHaveBeenCalledExactlyOnceWith(editor, {
      id: 'jNQXAC9IVRw',
      url: YOUTUBE_URL,
    });
    expect(onError).not.toHaveBeenCalled();
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('');
    });
  });

  it('embeds an unchanged link with no selection', async () => {
    await paste({'text/plain': YOUTUBE_URL});
    await act(async () => {
      editor.update(() => $setSelection(null));
    });
    await selectEmbedOption();

    expect(parseUrl).toHaveBeenCalledOnce();
    expect(insertNode).toHaveBeenCalledExactlyOnceWith(editor, {
      id: 'jNQXAC9IVRw',
      url: YOUTUBE_URL,
    });
    expect(onError).not.toHaveBeenCalled();
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('');
      expect($getSelection()).not.toBeNull();
    });
  });

  it('does not embed a link removed by a pending update', async () => {
    await paste({'text/plain': YOUTUBE_URL});
    const button = getEmbedButton();

    await act(async () => {
      editor.update(() => {
        $getPastedLink().remove();
        $getParagraph().selectEnd();
      });
      button.click();
    });

    expect(insertNode).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('');
    });
  });

  it('does not embed a link whose URL changed in a pending update', async () => {
    await paste({'text/plain': YOUTUBE_URL});
    const button = getEmbedButton();

    await act(async () => {
      editor.update(() => {
        $getPastedLink().setURL('https://example.com/');
      });
      button.click();
    });

    expect(insertNode).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    editor.read(() => {
      expect($getPastedLink().getURL()).toBe('https://example.com/');
    });
  });

  it('does not let an older paste that resolves late replace the menu', async () => {
    const OTHER_URL = 'https://www.youtube.com/watch?v=OTHERvid123';
    const resolveFirst = deferParseUrl();
    await paste({'text/plain': YOUTUBE_URL});
    expect(getMenu()).toBeNull();
    await paste({'text/plain': OTHER_URL}, () => {
      const paragraph = $createParagraphNode();
      $getRoot().append(paragraph);
      paragraph.select();
    });
    expect(getMenu()).not.toBeNull();

    await act(async () => {
      resolveFirst({id: 'jNQXAC9IVRw', url: YOUTUBE_URL});
    });
    await selectEmbedOption();

    expect(insertNode).toHaveBeenCalledExactlyOnceWith(editor, {
      id: 'OTHERvid123',
      url: OTHER_URL,
    });
  });

  it('does not offer to embed a link whose URL changed while parsing', async () => {
    const resolveParseUrl = deferParseUrl();
    await paste({'text/plain': YOUTUBE_URL});
    expect(getMenu()).toBeNull();

    await act(async () => {
      editor.update(() => {
        $getPastedLink().setURL('https://example.com/');
      });
    });
    await act(async () => {
      resolveParseUrl({id: 'jNQXAC9IVRw', url: YOUTUBE_URL});
    });

    expect(getMenu()).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not offer to embed a link with a pending URL change when parsing resolves', async () => {
    const resolveParseUrl = deferParseUrl();
    await paste({'text/plain': YOUTUBE_URL});
    expect(getMenu()).toBeNull();

    await act(async () => {
      resolveParseUrl({id: 'jNQXAC9IVRw', url: YOUTUBE_URL});
      editor.update(() => {
        $getPastedLink().setURL('https://example.com/');
      });
    });

    expect(getMenu()).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

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

  it('does not show the menu when a $disableMenuFor predicate matches the link location', async () => {
    await act(async () => {
      reactRoot.render(
        <App
          $disableMenuFor={node =>
            $getNearestNodeOfType(node, QuoteNode) !== null
          }
        />,
      );
    });
    await act(async () => {
      editor.update(
        () => {
          $getRoot().append($createQuoteNode().append($createParagraphNode()));
        },
        {discrete: true},
      );
    });

    await paste({'text/plain': YOUTUBE_URL}, () => {
      const quote = $assertNodeType($getRoot().getLastChild(), $isQuoteNode);
      $assertNodeType(quote.getFirstChild(), $isParagraphNode).selectEnd();
    });

    // The menu never opens, so the URL is never even parsed and the pasted
    // link is left untouched.
    expect(parseUrl).not.toHaveBeenCalled();
    expect(getMenu()).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    editor.read(() => {
      const quote = $assertNodeType($getRoot().getLastChild(), $isQuoteNode);
      const paragraph = $assertNodeType(
        quote.getFirstChild(),
        $isParagraphNode,
      );
      expect($assertNodeType(paragraph.getFirstChild(), $isLinkNode)).toBe(
        paragraph.getFirstChild(),
      );
    });
  });

  it('shows the menu when no $disableMenuFor predicate matches', async () => {
    await act(async () => {
      reactRoot.render(
        <App
          $disableMenuFor={node =>
            $getNearestNodeOfType(node, QuoteNode) !== null
          }
        />,
      );
    });

    // The default paste target is the root paragraph, outside any quote.
    await paste({'text/plain': YOUTUBE_URL});

    expect(getMenu()).not.toBeNull();
    await selectEmbedOption();
    expect(insertNode).toHaveBeenCalledExactlyOnceWith(editor, {
      id: 'jNQXAC9IVRw',
      url: YOUTUBE_URL,
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
