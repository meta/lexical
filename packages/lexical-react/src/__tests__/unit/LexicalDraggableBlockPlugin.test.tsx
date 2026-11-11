/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {DraggableBlockPlugin_EXPERIMENTAL} from '@lexical/react/LexicalDraggableBlockPlugin';
import {EditorRefPlugin} from '@lexical/react/LexicalEditorRefPlugin';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {type LexicalEditor} from 'lexical';
import * as React from 'react';
import {act, createRef} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const MENU_CLASS = 'draggable-block-menu';

describe('DraggableBlockPlugin_EXPERIMENTAL', () => {
  let container: HTMLDivElement;
  let anchorElem: HTMLDivElement;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement('div');
    anchorElem = document.createElement('div');
    container.appendChild(anchorElem);
    document.body.appendChild(container);
    reactRoot = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      reactRoot.unmount();
    });
    document.body.removeChild(container);
  });

  function Test({editorRef}: {editorRef: React.RefObject<LexicalEditor>}) {
    const menuRef = React.useRef<HTMLDivElement | null>(null);
    const targetLineRef = React.useRef<HTMLDivElement | null>(null);
    return (
      <LexicalComposer
        initialConfig={{
          namespace: 'draggable-block',
          onError: (error: Error) => {
            throw error;
          },
        }}>
        <EditorRefPlugin editorRef={editorRef} />
        <RichTextPlugin
          contentEditable={<ContentEditable />}
          ErrorBoundary={({children}) => <>{children}</>}
        />
        <DraggableBlockPlugin_EXPERIMENTAL
          anchorElem={anchorElem}
          menuRef={menuRef}
          targetLineRef={targetLineRef}
          menuComponent={<div ref={menuRef} className={MENU_CLASS} />}
          targetLineComponent={<div ref={targetLineRef} />}
          isOnMenu={element => element.closest(`.${MENU_CLASS}`) !== null}
        />
      </LexicalComposer>
    );
  }

  function hasDragHandle(): boolean {
    return anchorElem.querySelector(`.${MENU_CLASS}`) !== null;
  }

  it('follows setEditable', async () => {
    const editorRef =
      createRef<LexicalEditor>() as React.RefObject<LexicalEditor>;
    await act(async () => {
      reactRoot.render(<Test editorRef={editorRef} />);
    });

    expect(hasDragHandle()).toBe(true);

    await act(async () => {
      editorRef.current.setEditable(false);
    });
    expect(hasDragHandle()).toBe(false);

    await act(async () => {
      editorRef.current.setEditable(true);
    });
    expect(hasDragHandle()).toBe(true);
  });

  it('renders no drag handle for an editor that mounts read-only', async () => {
    const editorRef =
      createRef<LexicalEditor>() as React.RefObject<LexicalEditor>;

    function ReadOnlyTest() {
      const menuRef = React.useRef<HTMLDivElement | null>(null);
      const targetLineRef = React.useRef<HTMLDivElement | null>(null);
      return (
        <LexicalComposer
          initialConfig={{
            editable: false,
            namespace: 'draggable-block',
            onError: (error: Error) => {
              throw error;
            },
          }}>
          <EditorRefPlugin editorRef={editorRef} />
          <RichTextPlugin
            contentEditable={<ContentEditable />}
            ErrorBoundary={({children}) => <>{children}</>}
          />
          <DraggableBlockPlugin_EXPERIMENTAL
            anchorElem={anchorElem}
            menuRef={menuRef}
            targetLineRef={targetLineRef}
            menuComponent={<div ref={menuRef} className={MENU_CLASS} />}
            targetLineComponent={<div ref={targetLineRef} />}
            isOnMenu={element => element.closest(`.${MENU_CLASS}`) !== null}
          />
        </LexicalComposer>
      );
    }

    await act(async () => {
      reactRoot.render(<ReadOnlyTest />);
    });
    expect(hasDragHandle()).toBe(false);

    await act(async () => {
      editorRef.current.setEditable(true);
    });
    expect(hasDragHandle()).toBe(true);
  });
});
