/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {OverflowNode} from '@lexical/overflow';
import {CharacterLimitPlugin} from '@lexical/react/LexicalCharacterLimitPlugin';
import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {EditorRefPlugin} from '@lexical/react/LexicalEditorRefPlugin';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalEditor,
} from 'lexical';
import * as React from 'react';
import {act, createRef} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const MAX_LENGTH = 5;

describe('CharacterLimitPlugin', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;
  let editor: LexicalEditor;

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

  /**
   * Mount an editor that already holds `text`, then mount the plugin on top of
   * it -- which is what toggling the character-limit setting on does.
   */
  async function mountWithText(
    text: string,
    charset: 'UTF-8' | 'UTF-16' = 'UTF-16',
  ): Promise<void> {
    const editorRef =
      createRef<LexicalEditor>() as React.RefObject<LexicalEditor>;
    await act(async () => {
      reactRoot.render(
        <LexicalComposer
          initialConfig={{
            editorState: () => {
              $getRoot()
                .clear()
                .append($createParagraphNode().append($createTextNode(text)));
            },
            namespace: 'character-limit',
            nodes: [OverflowNode],
            onError: (error: Error) => {
              throw error;
            },
          }}>
          <EditorRefPlugin editorRef={editorRef} />
          <RichTextPlugin
            contentEditable={<ContentEditable />}
            ErrorBoundary={({children}) => <>{children}</>}
          />
          <CharacterLimitPlugin charset={charset} maxLength={MAX_LENGTH} />
        </LexicalComposer>,
      );
    });
    editor = editorRef.current;
  }

  function remainingCharacters(): string {
    const span = container.querySelector('.characters-limit');
    expect(span).not.toBe(null);
    return (span as HTMLElement).textContent ?? '';
  }

  function overflowNodeCount(): number {
    return editor.read(
      () =>
        $getRoot()
          .getAllTextNodes()
          .filter(node => node.getParent() instanceof OverflowNode).length,
    );
  }

  it('counts the text that is already in the editor when it mounts', async () => {
    await mountWithText('hello world');

    // 5 - 11
    expect(remainingCharacters()).toBe('-6');
    expect(overflowNodeCount()).toBeGreaterThan(0);
  });

  it('reports a full budget for an editor that is under the limit', async () => {
    await mountWithText('hi');

    expect(remainingCharacters()).toBe('3');
    expect(overflowNodeCount()).toBe(0);
  });

  it('counts in the charset it was given', async () => {
    // Three 3-byte characters: 3 UTF-16 code units, 9 UTF-8 bytes.
    await mountWithText('一二三', 'UTF-8');

    expect(remainingCharacters()).toBe('-4');
  });
});
