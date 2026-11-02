/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $fullReconcile,
  $getRoot,
  $isElementNode,
  $isTextNode,
  defineExtension,
  type LexicalEditor,
  type SerializedEditorState,
} from 'lexical';
import {afterEach, describe, expect, test, vi} from 'vitest';

// A paragraph whose stored textFormat (0) is not the format of its first
// text (bold), as a client that never rendered it writes it, and a second
// paragraph
const STATE = {
  root: {
    children: [
      {
        children: [
          {
            detail: 0,
            format: 1,
            mode: 'normal',
            style: 'color: red',
            text: 'bold',
            type: 'text',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        textFormat: 0,
        textStyle: '',
        type: 'paragraph',
        version: 1,
      },
      {
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: 'plain',
            type: 'text',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        textFormat: 0,
        textStyle: '',
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
} as unknown as SerializedEditorState;

function $firstParagraphTextFields(): [number, string] {
  const paragraph = $getRoot().getFirstChild();
  if (!$isElementNode(paragraph)) {
    throw new Error('expected a paragraph');
  }
  return [paragraph.getTextFormat(), paragraph.getTextStyle()];
}

describe('derived textFormat and textStyle of an element', () => {
  let root: HTMLElement;
  afterEach(() => {
    root.remove();
  });

  /**
   * An editor showing STATE, set before the root element: its first render
   * creates the DOM and derives nothing.
   */
  function setup(): LexicalEditor {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [RichTextExtension],
        name: 'derived-text-fields',
        onError: e => {
          throw e;
        },
      }),
    );
    root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    editor.setEditorState(editor.parseEditorState(STATE));
    editor.setRootElement(root);
    return editor;
  }

  test('a full reconcile changes no element that the update did not change', () => {
    const editor = setup();
    expect(editor.read($firstParagraphTextFields)).toEqual([0, '']);
    const listener = vi.fn();
    editor.registerUpdateListener(({dirtyElements, dirtyLeaves}) =>
      listener([...dirtyElements.keys()], [...dirtyLeaves]),
    );
    editor.update($fullReconcile, {discrete: true});
    expect(editor.read($firstParagraphTextFields)).toEqual([0, '']);
    expect(listener).toHaveBeenCalledTimes(1);
    // Only the root, which a full reconcile marks
    expect(listener).toHaveBeenLastCalledWith(['root'], []);
  });

  test('a full reconcile with an edit derives them for the element it changes only', () => {
    const editor = setup();
    editor.update(
      () => {
        $fullReconcile();
        const paragraph = $getRoot().getLastChild();
        const text = $isElementNode(paragraph)
          ? paragraph.getFirstChild()
          : null;
        if ($isTextNode(text)) {
          text.toggleFormat('italic');
          text.setStyle('color: blue');
        }
      },
      {discrete: true},
    );
    expect(
      editor.read(() =>
        $getRoot()
          .getChildren()
          .map(paragraph =>
            $isElementNode(paragraph)
              ? [paragraph.getTextFormat(), paragraph.getTextStyle()]
              : null,
          ),
      ),
    ).toEqual([
      [0, ''],
      [2, 'color: blue'],
    ]);
  });

  test('an element whose first text changes takes its format and style', () => {
    const editor = setup();
    editor.update(
      () => {
        const paragraph = $getRoot().getLastChild();
        const text = $isElementNode(paragraph)
          ? paragraph.getFirstChild()
          : null;
        if ($isTextNode(text)) {
          text.toggleFormat('italic');
          text.setStyle('color: blue');
        }
      },
      {discrete: true},
    );
    expect(
      editor.read(() => {
        const paragraph = $getRoot().getLastChild();
        return $isElementNode(paragraph)
          ? [paragraph.getTextFormat(), paragraph.getTextStyle()]
          : null;
      }),
    ).toEqual([2, 'color: blue']);
  });
});
