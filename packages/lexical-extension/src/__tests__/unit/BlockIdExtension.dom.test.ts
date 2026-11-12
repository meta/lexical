/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getClipboardDataFromSelection,
  $insertDataTransferForRichText,
} from '@lexical/clipboard';
import {
  $getBlockById,
  $getBlockId,
  BlockIdExtension,
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {$createHeadingNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  configExtension,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  DELETE_CHARACTER_COMMAND,
  type ElementNode,
  HISTORY_MERGE_TAG,
  HISTORY_PUSH_TAG,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
  UNDO_COMMAND,
} from 'lexical';
import {afterEach, assert, describe, expect, test} from 'vitest';

function counter(prefix = 'b') {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

/**
 * The first content an empty editor gets is a load, so its blocks get
 * positional ids (tested on their own). These tests are about edits, so their
 * editors have had content once and the first blocks they add get ids from
 * `generateId`.
 */
function asEdited<T extends LexicalEditor>(editor: T): T {
  const options = {discrete: true, tag: HISTORY_MERGE_TAG} as const;
  editor.update(() => {
    $getRoot().append($createParagraphNode());
  }, options);
  editor.update(() => {
    $getRoot().clear();
  }, options);
  return editor;
}

function mount(prefix = 'b'): LexicalEditorWithDispose {
  const editor = asEdited(
    buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        configExtension(HistoryExtension, {delay: 0}),
        configExtension(BlockIdExtension, {generateId: counter(prefix)}),
      ],
      name: '[block-id-dom]',
      // Editors that share a namespace paste each other's Lexical JSON.
      namespace: 'block-id-dom',
    }),
  );
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  containers.push(root);
  editor.setRootElement(root);
  return editor;
}

function update(editor: LexicalEditor, fn: () => void, tag?: string): void {
  editor.update(fn, {discrete: true, tag});
}

function blocks(editor: LexicalEditor): string[] {
  return editor.read(() =>
    $getRoot()
      .getChildren()
      .map(
        node =>
          `${node.getType()}:${node.getTextContent()}:${$getBlockId(node)}`,
      ),
  );
}

function $nth(index: number): ElementNode {
  const node = $getRoot().getChildAtIndex(index);
  assert($isElementNode(node));
  return node;
}

function $caret(index: number, offset: number): void {
  const text = $nth(index).getFirstDescendant();
  assert($isTextNode(text));
  text.select(offset, offset);
}

function seed(editor: LexicalEditor, texts: string[]): void {
  update(editor, () => {
    $getRoot()
      .clear()
      .append(
        ...texts.map(text =>
          $createParagraphNode().append($createTextNode(text)),
        ),
      );
  });
}

describe('BlockIdExtension (DOM)', () => {
  test('typing, Enter and Backspace in a mounted editor', () => {
    using editor = mount();
    seed(editor, ['hello', 'world']);
    update(editor, () => {
      $caret(0, 5);
      editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, '!');
    });
    expect(blocks(editor)).toEqual([
      'paragraph:hello!:b1',
      'paragraph:world:b2',
    ]);
    update(editor, () => {
      $caret(0, 2);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    expect(blocks(editor)).toEqual([
      'paragraph:he:b1',
      'paragraph:llo!:b3',
      'paragraph:world:b2',
    ]);
    update(editor, () => {
      $caret(2, 0);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    });
    expect(blocks(editor)).toEqual([
      'paragraph:he:b1',
      'paragraph:llo!world:b3',
    ]);
    // The rendered DOM is in sync with the state.
    expect(editor.getRootElement()!.textContent).toBe('hello!world');
  });

  test('Backspace at the start of the first heading', () => {
    using editor = mount();
    update(editor, () => {
      $getRoot().append(
        $createHeadingNode('h2').append($createTextNode('Title')),
        $createHeadingNode('h3'),
        $createParagraphNode().append($createTextNode('after')),
      );
    });
    update(editor, () => {
      $caret(0, 0);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    });
    // Nothing to delete before it: unchanged.
    expect(blocks(editor)).toEqual([
      'heading:Title:b1',
      'heading::b2',
      'paragraph:after:b3',
    ]);
    // An empty heading is removed; the other blocks keep their ids.
    update(editor, () => {
      $nth(1).select(0, 0);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    });
    expect(blocks(editor)).toEqual(['heading:Title:b1', 'paragraph:after:b3']);
  });

  function copy(editor: LexicalEditor, from: number, to: number) {
    let data!: ReturnType<typeof $getClipboardDataFromSelection>;
    update(editor, () => {
      const first = $nth(from).getFirstDescendant();
      const last = $nth(to).getLastDescendant();
      assert($isTextNode(first) && $isTextNode(last));
      first.select(0, 0);
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      selection.focus.set(last.getKey(), last.getTextContentSize(), 'text');
      data = $getClipboardDataFromSelection(selection);
    });
    return data;
  }

  function paste(
    editor: LexicalEditor,
    data: Record<string, string | undefined>,
    $place: () => void,
  ) {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(data)) {
      if (value !== undefined) {
        transfer.setData(type, value);
      }
    }
    update(editor, () => {
      $place();
      const selection = $getSelection();
      assert(selection !== null);
      $insertDataTransferForRichText(transfer, selection, editor);
    });
  }

  test('copy and paste between editors and within one editor', () => {
    using source = mount('s');
    using target = mount('t');
    seed(source, ['alpha', 'beta', 'gamma']);
    seed(target, ['one', '']);
    const data = copy(source, 1, 2);
    expect(data['application/x-lexical-editor']).toContain('"blockId":"s2"');
    // Into another editor, replacing its empty paragraph: the ids do not
    // clash there and are kept.
    paste(target, data, () => $nth(1).select());
    expect(blocks(target)).toEqual([
      'paragraph:one:t1',
      'paragraph:beta:s2',
      'paragraph:gamma:s3',
    ]);
    // Pasting the same blocks again into that editor: now they clash, and
    // the earlier blocks (the ones pasted first) keep the ids.
    paste(target, data, () => $getRoot().selectEnd());
    // The first pasted block merges into the block at the caret; the second
    // is a copy of s3 placed after the original, so it gets a fresh id.
    expect(blocks(target)).toEqual([
      'paragraph:one:t1',
      'paragraph:beta:s2',
      'paragraph:gammabeta:s3',
      'paragraph:gamma:t3',
    ]);
    // Into the source editor, below the originals: the copies get fresh ids.
    paste(source, data, () => $getRoot().selectEnd());
    expect(blocks(source)).toEqual([
      'paragraph:alpha:s1',
      'paragraph:beta:s2',
      'paragraph:gammabeta:s3',
      'paragraph:gamma:s4',
    ]);
  });

  test('HTML pasted through the legacy importer gets fresh ids', () => {
    using editor = mount();
    seed(editor, ['one']);
    paste(
      editor,
      {
        'text/html':
          '<p data-block-id="b1">pasted a</p><p data-block-id="b1">pasted b</p>',
      },
      () => $getRoot().selectEnd(),
    );
    const result = blocks(editor);
    expect(result[0]).toBe('paragraph:onepasted a:b1');
    expect(result.slice(1)).toEqual(['paragraph:pasted b:b2']);
  });

  test('undo restores ids and the index', () => {
    using editor = mount();
    seed(editor, ['one', 'two']);
    const before = blocks(editor);
    update(
      editor,
      () => {
        $caret(0, 1);
        editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
      },
      HISTORY_PUSH_TAG,
    );
    expect(blocks(editor)).toEqual([
      'paragraph:o:b1',
      'paragraph:ne:b3',
      'paragraph:two:b2',
    ]);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(blocks(editor)).toEqual(before);
    editor.read(() => {
      expect($getBlockById('b3')).toBeNull();
      expect($getBlockById('b1')!.getTextContent()).toBe('one');
    });
  });
});
