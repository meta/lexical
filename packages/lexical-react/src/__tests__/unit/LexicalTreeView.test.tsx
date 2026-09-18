/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {TreeView} from '@lexical/react/LexicalTreeView';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
} from 'lexical';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

function makeEditor(text: string): LexicalEditor {
  const editor = createEditor({
    namespace: 'tree-view',
    onError: error => {
      throw error;
    },
  });
  editor.setRootElement(document.createElement('div'));
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append($createParagraphNode().append($createTextNode(text)));
    },
    {discrete: true},
  );
  return editor;
}

describe('TreeView', () => {
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

  /** The rendered tree is produced asynchronously, so let it settle. */
  async function renderTreeFor(editor: LexicalEditor): Promise<string> {
    await act(async () => {
      reactRoot.render(<TreeView editor={editor} />);
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const pre = container.querySelector('pre');
    expect(pre).not.toBe(null);
    return (pre as HTMLPreElement).textContent ?? '';
  }

  it('renders the tree of the editor it was given', async () => {
    expect(await renderTreeFor(makeEditor('AAAAA'))).toContain('"AAAAA"');
  });

  it('re-renders when the editor prop changes', async () => {
    expect(await renderTreeFor(makeEditor('AAAAA'))).toContain('"AAAAA"');

    const tree = await renderTreeFor(makeEditor('BBBBB'));
    expect(tree).toContain('"BBBBB"');
    expect(tree).not.toContain('"AAAAA"');
  });
});
