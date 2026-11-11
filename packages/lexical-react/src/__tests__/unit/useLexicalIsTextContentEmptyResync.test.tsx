/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {useLexicalIsTextContentEmpty} from '@lexical/react/useLexicalIsTextContentEmpty';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
  ParagraphNode,
} from 'lexical';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

describe('useLexicalIsTextContentEmpty re-derives its value', () => {
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

  function makeEditor(text: string): LexicalEditor {
    const editor = createEditor({
      namespace: 'is-text-content-empty',
      nodes: [ParagraphNode],
      onError: error => {
        throw error;
      },
    });
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        if (text !== '') {
          paragraph.append($createTextNode(text));
        }
        $getRoot().clear().append(paragraph);
      },
      {discrete: true},
    );
    return editor;
  }

  let current = false;

  // Declared once, so that re-rendering with different props updates the same
  // component instance rather than mounting a fresh one (which would re-run
  // the useState initializer and hide the bug).
  function Test({editor, trim}: {editor: LexicalEditor; trim: boolean}) {
    current = useLexicalIsTextContentEmpty(editor, trim);
    return null;
  }

  async function render(
    editor: LexicalEditor,
    trim: boolean,
  ): Promise<boolean> {
    await act(async () => {
      reactRoot.render(<Test editor={editor} trim={trim} />);
    });
    return current;
  }

  it('follows a change of the trim argument', async () => {
    // Whitespace-only content is empty when trimmed and not empty otherwise,
    // so the answer depends entirely on `trim`.
    const editor = makeEditor('   ');

    expect(await render(editor, false)).toBe(false);
    expect(await render(editor, true)).toBe(true);
  });

  it('follows a change of the editor', async () => {
    const withText = makeEditor('hello');
    const empty = makeEditor('');

    expect(await render(withText, true)).toBe(false);
    expect(await render(empty, true)).toBe(true);
  });
});
