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

// A programmatic shrink of a text node (spliceText without
// moveSelection, setTextContent) leaves a RangeSelection point past the end
// of the node; the update commits it, and a later splitText on that node
// throws (dev) from $getTextNodeOffset.

const ext = defineExtension({
  dependencies: [RichTextExtension],
  name: '[selection-past-end]',
});

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

const $text = (): TextNode => {
  const t = $getRoot().getLastDescendant();
  if (!$isTextNode(t)) {
    throw new Error('no text');
  }
  return t;
};

const shrink = {
  setTextContent: () => $text().setTextContent('a'),
  spliceText: () => $text().spliceText(1, 2, ''),
  'spliceText, moveSelection (control)': () =>
    $text().spliceText(1, 2, '', true),
} as const;

describe.each(Object.entries(shrink))('%s', (name, $shrink) => {
  test('the committed selection stays inside the node', () => {
    const editor = setup();
    editor.update($shrink, {discrete: true});
    const out = editor.getEditorState().read(() => {
      const s = $getSelection();
      const a = $first();
      const t = $text();
      return s && $isRangeSelection(s)
        ? {
            anchorKey: s.anchor.key,
            anchorOffset: s.anchor.offset,
            focusKey: s.focus.key,
            focusOffset: s.focus.offset,
            firstKey: a.getKey(),
            textKey: t.getKey(),
            size: t.getTextContentSize(),
          }
        : null;
    });
    expect(out).not.toBeNull();
    if (name.includes('moveSelection')) {
      expect(out!.anchorKey).toBe(out!.textKey);
    } else {
      expect(out!.anchorKey).toBe(out!.firstKey);
    }
    expect(out!.anchorOffset).toBe(1);
    expect(out!.focusKey).toBe(out!.textKey);
    expect(out!.focusOffset).toBe(out!.size);
  });

  test('a later splitText on the node does not throw', () => {
    const editor = setup();
    editor.update($shrink, {discrete: true});
    let error: unknown = null;
    editor.update(
      () => {
        try {
          $first().splitText(1);
        } catch (e) {
          error = e;
        }
      },
      {discrete: true},
    );
    expect(String(error)).toBe('null');
    void name;
  });
});

test('control: an in-bounds selection and the same splitText', () => {
  const editor = setup();
  editor.update(
    () => {
      const s = $text().select(1, 1);
      s.anchor.set($first().getKey(), 1, 'text');
    },
    {discrete: true},
  );
  editor.update(() => $text().spliceText(1, 2, ''), {discrete: true});
  let error: unknown = null;
  editor.update(
    () => {
      try {
        $first().splitText(1);
      } catch (e) {
        error = e;
      }
    },
    {discrete: true},
  );
  expect(String(error)).toBe('null');
});
