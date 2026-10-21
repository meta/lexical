/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {ContentEditableElement} from '@lexical/react/LexicalContentEditable';
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

  // The time-travel panel freezes the editor while the user scrubs through
  // recorded EditorStates. The surface is ContentEditableElement's, which
  // renders `contentEditable` from `editor.isEditable()`, so freezing has to
  // go through the editor: an attribute written behind the editor's back is
  // invisible to it and is re-derived from its state on the next mount.
  describe('time-travel read-only toggle', () => {
    function makeEditorWithoutRoot(): LexicalEditor {
      const editor = createEditor({
        namespace: 'tree-view',
        onError: error => {
          throw error;
        },
      });
      editor.update(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('seed')),
          );
        },
        {discrete: true},
      );
      return editor;
    }

    /** Mounts the editable surface next to the tree, as an app would. */
    async function renderSurfaceAndTree(
      editor: LexicalEditor,
      surfaceKey?: string,
    ): Promise<HTMLDivElement> {
      await act(async () => {
        reactRoot.render(
          <>
            <ContentEditableElement editor={editor} key={surfaceKey} />
            <TreeView editor={editor} />
          </>,
        );
        // The rendered tree is produced asynchronously.
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      const rootElement = editor.getRootElement();
      expect(rootElement).not.toBe(null);
      return rootElement as HTMLDivElement;
    }

    /** The panel appears once more than two editor states are recorded. */
    async function recordEditorStates(
      editor: LexicalEditor,
      count: number,
    ): Promise<void> {
      for (let i = 0; i < count; i++) {
        await act(async () => {
          editor.update(
            () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode(`state${i}`)),
              );
            },
            {discrete: true},
          );
        });
      }
    }

    async function clickButton(label: string): Promise<void> {
      const button = Array.from(container.querySelectorAll('button')).find(
        el => el.textContent === label,
      );
      expect(button, `${label} button`).not.toBe(null);
      await act(async () => {
        (button as HTMLButtonElement).click();
      });
    }

    it('freezes the editor through its editable state', async () => {
      const editor = makeEditorWithoutRoot();
      const rootElement = await renderSurfaceAndTree(editor);
      await recordEditorStates(editor, 2);

      await clickButton('Time Travel');

      expect(editor.isEditable()).toBe(false);
      expect(rootElement.contentEditable).toBe('false');
    });

    it('unfreezes the editor when time travel exits', async () => {
      const editor = makeEditorWithoutRoot();
      const rootElement = await renderSurfaceAndTree(editor);
      await recordEditorStates(editor, 2);

      await clickButton('Time Travel');
      await clickButton('Exit');

      expect(editor.isEditable()).toBe(true);
      expect(rootElement.contentEditable).toBe('true');
    });

    it('leaves an app-level read-only editor read-only', async () => {
      const editor = makeEditorWithoutRoot();
      editor.setEditable(false);
      const rootElement = await renderSurfaceAndTree(editor);
      await recordEditorStates(editor, 2);
      expect(rootElement.contentEditable).toBe('false');

      await clickButton('Time Travel');
      await clickButton('Exit');

      expect(editor.isEditable()).toBe(false);
      expect(rootElement.contentEditable).toBe('false');
    });

    it('keeps the surface frozen when it mounts again during time travel', async () => {
      const editor = makeEditorWithoutRoot();
      const first = await renderSurfaceAndTree(editor);
      await recordEditorStates(editor, 2);

      await clickButton('Time Travel');

      // Re-mount the surface: it derives `contentEditable` from the editor on
      // every mount, so a freeze the editor knows nothing about is undone.
      const remounted = await renderSurfaceAndTree(editor, 'remounted');
      expect(remounted).not.toBe(first);

      expect(remounted.contentEditable).toBe('false');
    });
  });
});
