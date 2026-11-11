/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  $isParagraphNode,
  configExtension,
  ElementNode,
  HISTORY_MERGE_TAG,
  HISTORY_PUSH_TAG,
  type LexicalEditor,
  REDO_COMMAND,
  UNDO_COMMAND,
  type UpdateListener,
} from 'lexical';
import {assert, describe, expect, test, vi} from 'vitest';

// Empty inline elements change the adjacent TextNode's sibling pointer,
// without adding another dirty leaf or changing the text's serialized value.
class InlineEmptyElementNode extends ElementNode {
  $config() {
    return this.config('inline-empty', {extends: ElementNode});
  }

  createDOM(): HTMLElement {
    return $getDocument().createElement('span');
  }

  updateDOM(): boolean {
    return false;
  }

  isInline(): boolean {
    return true;
  }
}

function $getParagraph() {
  const paragraph = $getRoot().getFirstChildOrThrow();
  assert($isParagraphNode(paragraph));
  return paragraph;
}

function readChildren(editor: LexicalEditor) {
  return editor.read(() =>
    $getParagraph()
      .getChildren()
      .map(node => [node.getType(), node.getTextContent()]),
  );
}

function createEditor() {
  const editor = buildEditorFromExtensions({
    dependencies: [
      // Keep every update within the merge window without relying on wall time.
      configExtension(HistoryExtension, {
        delay: 1000,
        disabled: false,
        now: () => 0,
      }),
    ],
    name: 'test',
    nodes: [InlineEmptyElementNode],
  });
  editor.update(() => $getRoot().append($createParagraphNode()), {
    discrete: true,
  });
  editor.update(
    () => {
      const paragraph = $getParagraph();
      paragraph.append($createTextNode('ab'));
      paragraph.selectEnd();
    },
    {discrete: true},
  );
  return editor;
}

function getHistoryState(editor: LexicalEditor) {
  return getExtensionDependencyFromEditor(
    editor,
    HistoryExtension,
  ).output.historyState.peek();
}

const textChildren = [['text', 'ab']];
const insertedChildren = [...textChildren, ['inline-empty', '']];

describe('HISTORY_PUSH_TAG with an unchanged dirty TextNode (#9217)', () => {
  test.each([
    {tag: [HISTORY_PUSH_TAG]},
    {tag: [HISTORY_PUSH_TAG, HISTORY_MERGE_TAG]},
    {tag: [HISTORY_MERGE_TAG, HISTORY_PUSH_TAG]},
  ])('isolates an element insertion with tags $tag', ({tag}) => {
    using editor = createEditor();
    const listener = vi.fn<UpdateListener>();
    const unregister = editor.registerUpdateListener(listener);
    editor.update(
      () => {
        $getRoot()
          .getAllTextNodes()[0]
          .insertAfter($create(InlineEmptyElementNode));
      },
      {discrete: true, tag},
    );
    unregister();

    // Verify the regression's dirty-leaf shape so the fixture cannot silently
    // turn into a different insertion that already worked without the fix.
    expect(listener).toHaveBeenCalledTimes(1);
    const [{dirtyLeaves, editorState, prevEditorState}] =
      listener.mock.calls[0];
    expect(dirtyLeaves).toEqual(
      new Set(editor.read(() => [$getRoot().getAllTextNodes()[0].getKey()])),
    );
    expect(
      editorState.read(() => $getRoot().getAllTextNodes()[0].exportJSON()),
    ).toEqual(
      prevEditorState.read(() => $getRoot().getAllTextNodes()[0].exportJSON()),
    );
    expect(readChildren(editor)).toEqual(insertedChildren);

    // Undo the insertion and earlier text separately, then redo both. Check
    // content and structure: a stack-length assertion alone is insufficient.
    editor.update(() => editor.dispatchCommand(UNDO_COMMAND), {discrete: true});
    expect(readChildren(editor)).toEqual(textChildren);
    editor.update(() => editor.dispatchCommand(UNDO_COMMAND), {discrete: true});
    expect(readChildren(editor)).toEqual([]);
    editor.update(() => editor.dispatchCommand(REDO_COMMAND), {discrete: true});
    expect(readChildren(editor)).toEqual(textChildren);
    editor.update(() => editor.dispatchCommand(REDO_COMMAND), {discrete: true});
    expect(readChildren(editor)).toEqual(insertedChildren);
  });

  test('still merges an untagged TextNode marked dirty without a change', () => {
    using editor = createEditor();
    editor.update(() => $getRoot().getAllTextNodes()[0].markDirty(), {
      discrete: true,
    });
    expect(getHistoryState(editor).undoStack).toHaveLength(1);
    editor.update(() => editor.dispatchCommand(UNDO_COMMAND), {discrete: true});
    expect(readChildren(editor)).toEqual([]);
  });
});
