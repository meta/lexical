/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {AutoLinkNode} from '@lexical/link';
import {
  AutoLinkPlugin,
  createLinkMatcherWithRegExp,
} from '@lexical/react/LexicalAutoLinkPlugin';
import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {EditorRefPlugin} from '@lexical/react/LexicalEditorRefPlugin';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  getDOMSelection,
  isDOMTextNode,
  type LexicalEditor,
} from 'lexical';
import * as React from 'react';
import {act, createRef} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, assert, beforeEach, describe, expect, it} from 'vitest';

describe('AutoLinkPlugin', () => {
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

  // https://github.com/facebook/lexical/issues/5016
  it('does not take focus from another input when it re-renders', async () => {
    const editorRef =
      createRef<LexicalEditor>() as React.RefObject<LexicalEditor>;
    const inputRef =
      createRef<HTMLInputElement>() as React.RefObject<HTMLInputElement>;
    function App({value}: {value: string}) {
      return (
        <>
          <input ref={inputRef} value={value} readOnly={true} />
          <LexicalComposer
            initialConfig={{
              namespace: 'auto-link',
              nodes: [AutoLinkNode],
              onError: (error: Error) => {
                throw error;
              },
            }}>
            <EditorRefPlugin editorRef={editorRef} />
            <RichTextPlugin
              contentEditable={<ContentEditable />}
              ErrorBoundary={({children}) => <>{children}</>}
            />
            {/* A new matchers array on every render, as in the issue */}
            <AutoLinkPlugin
              matchers={[
                createLinkMatcherWithRegExp(/https?:\/\/\S+/, text => text),
              ]}
            />
          </LexicalComposer>
        </>
      );
    }

    await act(async () => {
      reactRoot.render(<App value="" />);
    });
    const editor = editorRef.current;
    const rootElement = editor.getRootElement();
    assert(rootElement !== null, 'Expected a root element');
    await act(async () => {
      rootElement.focus();
      editor.update(
        () => {
          const text = $createTextNode('hello');
          $getRoot().clear().append($createParagraphNode().append(text));
          text.select(5, 5);
        },
        {discrete: true},
      );
    });
    const textDOM = rootElement.querySelector(
      '[data-lexical-text]',
    )?.firstChild;
    assert(isDOMTextNode(textDOM), 'Expected the text node of "hello"');

    const input = inputRef.current;
    input.focus();
    // jsdom moves the selection to the focused input; browsers leave it in the
    // contenteditable, which is what this restores.
    const domSelection = getDOMSelection(window);
    assert(domSelection !== null, 'Expected a DOM selection');
    domSelection.setBaseAndExtent(textDOM, 5, textDOM, 5);

    // Typing in the input re-renders the app and AutoLinkPlugin
    await act(async () => {
      reactRoot.render(<App value="a" />);
    });
    await act(async () => {
      reactRoot.render(<App value="ab" />);
    });

    expect(document.activeElement).toBe(input);
  });
});
