/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {EditorRefPlugin} from '@lexical/react/LexicalEditorRefPlugin';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {TabIndentationPlugin} from '@lexical/react/LexicalTabIndentationPlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';
import * as React from 'react';
import {act, createRef} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, assert, beforeEach, describe, expect, it, vi} from 'vitest';

describe('TabIndentationPlugin', () => {
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

  function App({
    $canIndent,
    editorRef,
  }: {
    $canIndent?: (node: ElementNode) => boolean;
    editorRef: React.RefObject<LexicalEditor>;
  }) {
    return (
      <LexicalComposer
        initialConfig={{
          namespace: 'tab-indentation',
          nodes: [],
          onError: (error: Error) => {
            throw error;
          },
        }}>
        <EditorRefPlugin editorRef={editorRef} />
        <RichTextPlugin
          contentEditable={<ContentEditable />}
          ErrorBoundary={({children}) => <>{children}</>}
        />
        <TabIndentationPlugin maxIndent={4} $canIndent={$canIndent} />
      </LexicalComposer>
    );
  }

  // Registering re-checks the whole document (#5170), so an inline
  // $canIndent must not re-register on every render.
  it('does not re-register when an inline $canIndent changes', async () => {
    const editorRef =
      createRef<LexicalEditor>() as React.RefObject<LexicalEditor>;
    await act(async () => {
      reactRoot.render(
        <App $canIndent={node => node.canIndent()} editorRef={editorRef} />,
      );
    });
    const editor = editorRef.current;
    assert(editor !== null, 'Expected an editor');
    const registerNodeTransform = vi.spyOn(editor, 'registerNodeTransform');
    await act(async () => {
      reactRoot.render(
        <App
          $canIndent={node => !$isParagraphNode(node)}
          editorRef={editorRef}
        />,
      );
    });
    expect(registerNodeTransform).not.toHaveBeenCalled();

    // The latest predicate is still used: paragraphs are now left alone.
    await act(async () => {
      editor.update(() => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().setIndent(9).append($createTextNode('x')),
          );
      });
    });
    expect(
      editor.read(() =>
        ($getRoot().getFirstChild() as ElementNode).getIndent(),
      ),
    ).toBe(9);
  });

  it('clamps with the default predicate', async () => {
    const editorRef =
      createRef<LexicalEditor>() as React.RefObject<LexicalEditor>;
    await act(async () => {
      reactRoot.render(<App editorRef={editorRef} />);
    });
    const editor = editorRef.current;
    assert(editor !== null, 'Expected an editor');
    await act(async () => {
      editor.update(() => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().setIndent(9).append($createTextNode('x')),
          );
      });
    });
    expect(
      editor.read(() =>
        ($getRoot().getFirstChild() as ElementNode).getIndent(),
      ),
    ).toBe(3);
  });
});
