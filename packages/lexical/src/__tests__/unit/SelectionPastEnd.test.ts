/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

const ext = defineExtension({
  dependencies: [RichTextExtension],
  name: '[selection-past-end]',
});

// Paragraph with a bold "ab" followed by a plain "cde" (so they never merge),
// and a selection from offset 1 of "ab" to offset 3 (the end) of "cde".
function setup(): LexicalEditor {
  const editor = buildEditorFromExtensions(ext);
  editor.update(
    () => {
      const a = $createTextNode('ab').toggleFormat('bold');
      const t = $createTextNode('cde');
      $getRoot().clear().append($createParagraphNode().append(a, t));
      const s = t.select(3, 3);
      s.anchor.set(a.getKey(), 1, 'text');
    },
    {discrete: true},
  );
  return editor;
}

const $first = (): TextNode => {
  const t = $getRoot().getFirstDescendant();
  if (!$isTextNode(t)) {
    throw new Error('no text');
  }
  return t;
};

const $last = (): TextNode => {
  const t = $getRoot().getLastDescendant();
  if (!$isTextNode(t)) {
    throw new Error('no text');
  }
  return t;
};

function readSelection(editor: LexicalEditor) {
  return editor.getEditorState().read(() => {
    const s = $getSelection();
    if (!$isRangeSelection(s)) {
      return null;
    }
    const first = $first().getKey();
    const name = (key: string) => (key === first ? 'first' : 'last');
    return {
      anchor: [name(s.anchor.key), s.anchor.offset],
      focus: [name(s.focus.key), s.focus.offset],
      isBackward: s.isBackward(),
    };
  });
}

const shrink = {
  setTextContent: () => $last().setTextContent('c'),
  spliceText: () => $last().spliceText(1, 2, ''),
} as const;

describe.each(Object.entries(shrink))('%s', (_name, $shrink) => {
  test('the committed focus is clamped to the end of the shrunk node', () => {
    const editor = setup();
    editor.update($shrink, {discrete: true});
    expect(readSelection(editor)).toEqual({
      anchor: ['first', 1],
      focus: ['last', 1],
      isBackward: false,
    });
  });

  test('a backward selection collapsed by the clamp is not backward', () => {
    const editor = setup();
    editor.update(
      () => {
        const s = $last().select(3, 1);
        // Populate the cached direction before the node shrinks.
        expect(s.isBackward()).toBe(true);
        $shrink();
      },
      {discrete: true},
    );
    expect(readSelection(editor)).toEqual({
      anchor: ['last', 1],
      focus: ['last', 1],
      isBackward: false,
    });
  });

  test('a later splitText on the node does not throw', () => {
    const editor = setup();
    editor.update($shrink, {discrete: true});
    expect(() =>
      editor.update(() => $first().splitText(1), {discrete: true}),
    ).not.toThrow();
  });
});

test('queued updates that shrink and regrow the node keep the caret', async () => {
  const editor = setup();
  editor.update(() => $last().setTextContent('c'));
  editor.update(() => $last().setTextContent('cde'));
  await Promise.resolve();
  expect(readSelection(editor)).toEqual({
    anchor: ['first', 1],
    focus: ['last', 3],
    isBackward: false,
  });
});

test('control: spliceText with moveSelection places the caret itself', () => {
  const editor = setup();
  editor.update(() => $last().spliceText(1, 2, '', true), {discrete: true});
  expect(readSelection(editor)).toEqual({
    anchor: ['last', 1],
    focus: ['last', 1],
    isBackward: false,
  });
});
