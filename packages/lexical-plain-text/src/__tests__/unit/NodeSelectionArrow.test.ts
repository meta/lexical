/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createHorizontalRuleNode,
  buildEditorFromExtensions,
  HorizontalRuleExtension,
} from '@lexical/extension';
import {PlainTextExtension} from '@lexical/plain-text';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  defineExtension,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

const ARROWS = [
  ['ArrowUp', KEY_ARROW_UP_COMMAND, 'before', 1],
  ['ArrowLeft', KEY_ARROW_LEFT_COMMAND, 'before', 1],
  ['ArrowDown', KEY_ARROW_DOWN_COMMAND, 'after', 0],
  ['ArrowRight', KEY_ARROW_RIGHT_COMMAND, 'after', 0],
] as const;

function setup() {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [PlainTextExtension, HorizontalRuleExtension],
      name: 'NodeSelectionArrow',
    }),
  );
  onTestFinished(() => editor[Symbol.dispose]());
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  onTestFinished(() => root.remove());
  editor.setRootElement(root);
  editor.update(
    () => {
      const rule = $createHorizontalRuleNode();
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append($createTextNode('before')),
          rule,
          $createParagraphNode().append($createTextNode('after')),
        );
      const selection = $createNodeSelection();
      selection.add(rule.getKey());
      $setSelection(selection);
    },
    {discrete: true},
  );
  return editor;
}

describe('arrow keys on a node-selected decorator in plain text', () => {
  test.each(ARROWS)(
    "%s moves the caret to the decorator's side",
    (key, command, text, offset) => {
      const editor = setup();
      const event = new KeyboardEvent('keydown', {cancelable: true, key});
      editor.update(
        () => {
          expect(editor.dispatchCommand(command, event)).toBe(true);
        },
        {discrete: true},
      );
      expect(event.defaultPrevented).toBe(true);
      editor.read(() => {
        const selection = $getSelection();
        expect($isNodeSelection(selection)).toBe(false);
        expect($isRangeSelection(selection)).toBe(true);
        if ($isRangeSelection(selection)) {
          expect(selection.isCollapsed()).toBe(true);
          expect(selection.anchor.getNode().getTextContent()).toBe(text);
          expect(selection.anchor.offset).toBe(offset);
        }
      });
    },
  );

  test('Shift+ArrowDown turns the node selection into a range to extend', () => {
    const editor = setup();
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      shiftKey: true,
    });
    editor.update(
      () => {
        expect(editor.dispatchCommand(KEY_ARROW_DOWN_COMMAND, event)).toBe(
          false,
        );
      },
      {discrete: true},
    );
    expect(event.defaultPrevented).toBe(false);
    editor.read(() => {
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if ($isRangeSelection(selection)) {
        expect(selection.isCollapsed()).toBe(false);
      }
    });
  });
});
