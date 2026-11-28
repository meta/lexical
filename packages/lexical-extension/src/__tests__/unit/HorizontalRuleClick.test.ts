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
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

// A rule that is not laid out (as in jsdom, where every rect is zero) has
// nothing beside it to click (#7758).
test('a click on the root does not select a rule that is not laid out', () => {
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Above')),
        $createHorizontalRuleNode(),
      );
      $getRoot().selectStart();
    },
    dependencies: [RichTextExtension, HorizontalRuleExtension],
    name: 'test',
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.setRootElement(null);
    root.remove();
    editor.dispose();
  });
  root.click();
  expect(editor.read(() => $isRangeSelection($getSelection()))).toBe(true);
});
