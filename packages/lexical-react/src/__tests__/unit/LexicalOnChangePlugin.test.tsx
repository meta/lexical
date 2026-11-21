/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode, CodeHighlightNode, CodeNode} from '@lexical/code';
import {registerCodeHighlighting} from '@lexical/code-prism';
import {AutoFocusPlugin} from '@lexical/react/LexicalAutoFocusPlugin';
import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {OnChangePlugin} from '@lexical/react/LexicalOnChangePlugin';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {
  $createTextNode,
  $getRoot,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';
import * as React from 'react';
import {act, useEffect} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function CodeHighlightPlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerCodeHighlighting(editor), [editor]);
  return null;
}

function CaptureEditorPlugin({
  editorRef,
}: {
  editorRef: {current: LexicalEditor | null};
}): null {
  const [editor] = useLexicalComposerContext();
  editorRef.current = editor;
  return null;
}

function TestEditor({
  onChange,
  editorRef,
}: {
  onChange: (tags: Set<string>) => void;
  editorRef: {current: LexicalEditor | null};
}) {
  return (
    <LexicalComposer
      initialConfig={{
        editorState: () => {
          $getRoot()
            .clear()
            .append(
              $createCodeNode('javascript').append(
                $createTextNode('const a = 1;'),
              ),
            );
        },
        namespace: 'issue-4493',
        nodes: [CodeNode, CodeHighlightNode],
        onError(error) {
          throw error;
        },
      }}>
      <RichTextPlugin
        contentEditable={<ContentEditable />}
        placeholder={null}
        ErrorBoundary={({children}) => <>{children}</>}
      />
      {/* Matches the reported combination: AutoFocusPlugin mounts before the
          code-highlighting plugin, so its editor.focus() call opens an update
          that the plugin's registerCodeHighlighting call then lands inside. */}
      <AutoFocusPlugin />
      <CodeHighlightPlugin />
      <CaptureEditorPlugin editorRef={editorRef} />
      <OnChangePlugin
        onChange={(_editorState, _editor, tags) => onChange(tags)}
      />
    </LexicalComposer>
  );
}

describe('OnChangePlugin + AutoFocusPlugin + code highlighting (#4493)', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      reactRoot = createRoot(container);
    });
  });

  afterEach(() => {
    act(() => {
      reactRoot.unmount();
    });
    container.remove();
  });

  it('does not report a change when a document with an existing code block is loaded and auto-focused', async () => {
    const onChange = vi.fn();
    const editorRef: {current: LexicalEditor | null} = {current: null};

    await act(async () => {
      reactRoot.render(
        <TestEditor onChange={onChange} editorRef={editorRef} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('still reports a real, subsequent edit to the code block', async () => {
    const onChange = vi.fn();
    const editorRef: {current: LexicalEditor | null} = {current: null};

    await act(async () => {
      reactRoot.render(
        <TestEditor onChange={onChange} editorRef={editorRef} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    onChange.mockClear();

    const editor = editorRef.current;
    expect(editor).not.toBe(null);

    await act(async () => {
      editor!.update(() => {
        $getRoot().getFirstChild<ElementNode>()!.selectEnd().insertText('!');
      });
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalled();
  });
});
