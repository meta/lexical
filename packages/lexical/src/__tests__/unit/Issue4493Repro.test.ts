/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {PlainTextExtension} from '@lexical/plain-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type ElementNode,
  HISTORY_MERGE_TAG,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

describe('Issue #4493: history-merge tag for transform re-verification', () => {
  test('keeps re-verification in a separate update when another update is pending', async () => {
    using editor = buildEditorFromExtensions({
      dependencies: [PlainTextExtension],
      name: 'issue-4493-repro',
      onError: error => {
        throw error;
      },
    });
    editor.setRootElement(document.createElement('div'));
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('hello')));
      },
      {discrete: true},
    );

    const updates: {tags: string[]; text: string}[] = [];
    const unregister = editor.registerUpdateListener(({editorState, tags}) => {
      updates.push({
        tags: [...tags],
        text: editorState.read(() => $getRoot().getTextContent()),
      });
    });

    editor.focus();
    editor.update(() => {
      $getRoot()
        .getFirstChild<ElementNode>()!
        .getFirstChild<TextNode>()!
        .insertAfter($createTextNode(' world'));
    });
    const unregisterTransform = editor.registerNodeTransform(
      TextNode,
      () => {},
    );

    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(updates).toHaveLength(2);
    expect(updates[0].tags).toContain('focus');
    expect(updates[0].tags).not.toContain(HISTORY_MERGE_TAG);
    expect(updates[0].text).toBe('hello world');
    expect(updates[1].tags).toContain(HISTORY_MERGE_TAG);
    expect(updates[1].tags).not.toContain('focus');
    expect(updates[1].text).toBe('hello world');

    editor.update(
      () => {
        $getRoot()
          .getFirstChild<ElementNode>()!
          .getFirstChild<TextNode>()!
          .insertAfter($createTextNode(' world'));
      },
      {discrete: true},
    );

    expect(updates).toHaveLength(3);
    expect(updates[2].tags).not.toContain(HISTORY_MERGE_TAG);

    unregisterTransform();
    unregister();
  });
});
