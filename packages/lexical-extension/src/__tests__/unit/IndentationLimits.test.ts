/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  ListExtension,
} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isParagraphNode,
  $selectAll,
  configExtension,
  defineExtension,
  INDENT_CONTENT_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  OUTDENT_CONTENT_COMMAND,
} from 'lexical';
import {assert, expect, test} from 'vitest';

import {buildEditorFromExtensions, TabIndentationExtension} from '../../index';

function createEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        RichTextExtension,
        ListExtension,
        configExtension(TabIndentationExtension, {maxIndent: 7}),
      ],
      name: 'IndentationLimits',
    }),
  );
}

function indent(editor: LexicalEditor, times: number) {
  for (let i = 0; i < times; i++) {
    editor.update(
      () => {
        editor.dispatchCommand(INDENT_CONTENT_COMMAND);
      },
      {discrete: true},
    );
  }
}

function $items(
  node: LexicalNode = $getRoot(),
): {indent: number; text: string}[] {
  if ($isListItemNode(node) && !$isElementNode(node.getFirstChild())) {
    return [{indent: node.getIndent(), text: node.getTextContent()}];
  }
  return $isElementNode(node) ? node.getChildren().flatMap($items) : [];
}

function $getParagraphIndent(): number {
  const paragraph = $getRoot().getFirstChildOrThrow();
  assert($isParagraphNode(paragraph));
  return paragraph.getIndent();
}

test.each(['', 'World'])('caps paragraph indentation for %j', text => {
  using editor = createEditor();
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      if (text) paragraph.append($createTextNode(text));
      $getRoot().clear().append(paragraph);
      paragraph.selectEnd();
    },
    {discrete: true},
  );
  for (let i = 1; i <= 14; i++) {
    indent(editor, 1);
    expect(editor.read($getParagraphIndent)).toBe(Math.min(i, 6));
  }
});

test.each(['', 'World'])('caps list indentation for %j', text => {
  using editor = createEditor();
  editor.update(
    () => {
      const item = $createListItemNode();
      if (text) item.append($createTextNode(text));
      $getRoot().clear().append($createListNode('bullet').append(item));
      item.selectEnd();
    },
    {discrete: true},
  );
  for (let i = 1; i <= 14; i++) {
    indent(editor, 1);
    expect(editor.read(() => $items())).toEqual([
      {indent: Math.min(i, 6), text},
    ]);
  }
});

test('caps each selected item independently in a nested list', () => {
  using editor = createEditor();
  editor.update(
    () => {
      const list = $createListNode('bullet');
      $getRoot().clear().append(list);
      let parent = list;
      for (const text of ['Hello', 'from', 'the', 'other', 'side']) {
        parent.append($createListItemNode().append($createTextNode(text)));
        if (text !== 'side') {
          const nested = $createListNode('bullet');
          parent.append($createListItemNode().append(nested));
          parent = nested;
        }
      }
      parent.append($createListItemNode());
      $selectAll();
    },
    {discrete: true},
  );
  indent(editor, 3);
  expect(editor.read(() => $items())).toEqual([
    {indent: 3, text: 'Hello'},
    {indent: 4, text: 'from'},
    {indent: 5, text: 'the'},
    {indent: 6, text: 'other'},
    {indent: 6, text: 'side'},
    {indent: 6, text: ''},
  ]);
  indent(editor, 3);
  const expected = ['Hello', 'from', 'the', 'other', 'side', ''].map(text => ({
    indent: 6,
    text,
  }));
  expect(editor.read(() => $items())).toEqual(expected);
  indent(editor, 3);
  expect(editor.read(() => $items())).toEqual(expected);
});

test.each([0, 0.025, 0.05, 0.075, 1, 6])(
  'outdent never makes indent %s negative',
  initial => {
    using editor = createEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode().append(
          $createTextNode('Hello'),
        );
        paragraph.setIndent(initial);
        $getRoot().clear().append(paragraph);
        paragraph.selectEnd();
      },
      {discrete: true},
    );
    for (let i = 1; i <= 8; i++) {
      editor.update(
        () => {
          editor.dispatchCommand(OUTDENT_CONTENT_COMMAND);
        },
        {discrete: true},
      );
      expect(editor.read($getParagraphIndent)).toBe(Math.max(0, initial - i));
    }
  },
);
