/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$getRoot, $isParagraphNode} from 'lexical';
import {createTestEditor} from 'lexical/src/__tests__/utils';
import {describe, expect, it, vi} from 'vitest';

// `setEditorState` reports an empty editor state with `devInvariant`, which
// throws outside production — rolling the recovery update back before it can
// be observed. Stubbing it out is how this file exercises the production arm
// (`formatProdWarningMessage`, which only warns) from a development test run.
vi.mock('@lexical/internal/devInvariant', () => ({default: vi.fn()}));

// Content persisted while the editor was empty: the shape `setEditorState`
// used to throw on.
const EMPTY_SERIALIZED_EDITOR_STATE = JSON.stringify({
  root: {
    children: [],
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
});

describe('setEditorState with an empty editor state (production arm)', () => {
  it('recovers to an empty paragraph rather than leaving the root childless', () => {
    const onError = vi.fn();
    const editor = createTestEditor({onError});
    const rootElement = document.createElement('div');
    document.body.appendChild(rootElement);
    editor.setRootElement(rootElement);

    editor.setEditorState(
      editor.parseEditorState(EMPTY_SERIALIZED_EDITOR_STATE),
    );

    expect(onError).not.toHaveBeenCalled();
    editor.read(() => {
      const root = $getRoot();

      expect(root.getChildrenSize()).toBe(1);
      expect($isParagraphNode(root.getFirstChild())).toBe(true);
      expect(root.getTextContent()).toBe('');
    });
    // A childless root reconciles to a contenteditable with no block element
    // to place a caret in; the recovered document renders one.
    expect(rootElement.innerHTML).toContain('<p');

    editor.update(
      () => {
        $getRoot().selectEnd().insertText('typed');
      },
      {discrete: true},
    );

    expect(editor.read(() => $getRoot().getTextContent())).toBe('typed');
  });

  it('leaves a non-empty editor state untouched', () => {
    const onError = vi.fn();
    const editor = createTestEditor({onError});
    const rootElement = document.createElement('div');
    document.body.appendChild(rootElement);
    editor.setRootElement(rootElement);

    editor.setEditorState(
      editor.parseEditorState(
        JSON.stringify({
          root: {
            children: [
              {
                children: [
                  {
                    detail: 0,
                    format: 0,
                    mode: 'normal',
                    style: '',
                    text: 'hello',
                    type: 'text',
                    version: 1,
                  },
                ],
                direction: null,
                format: '',
                indent: 0,
                type: 'paragraph',
                version: 1,
              },
            ],
            direction: null,
            format: '',
            indent: 0,
            type: 'root',
            version: 1,
          },
        }),
      ),
    );

    expect(onError).not.toHaveBeenCalled();
    editor.read(() => {
      // No stray paragraph appended alongside the parsed content.
      expect($getRoot().getChildrenSize()).toBe(1);
      expect($getRoot().getTextContent()).toBe('hello');
    });
  });
});
