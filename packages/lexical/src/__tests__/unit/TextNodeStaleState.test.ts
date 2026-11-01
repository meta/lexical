/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// The returned reference is captured during the seeding update, so from the
// next update on it is the previous version of the node: the first call that
// goes through getWritable() clones it and leaves this object behind. That is
// the reference a listener or a plugin holds across updates.
function seedStaleTextNode(editor: LexicalEditor): TextNode {
  let text!: TextNode;
  editor.update(
    () => {
      text = $createTextNode('a');
      $getRoot().clear().append($createParagraphNode().append(text));
    },
    {discrete: true},
  );
  return text;
}

describe('TextNode stale state readers', () => {
  test('setTextContent can restore the original text through a stale reference', () => {
    using editor = buildEditorFromExtensions({name: 'textnode-stale-state'});
    const text = seedStaleTextNode(editor);

    editor.update(
      () => {
        // The first call clones the node, so an early return comparing
        // against this stale object's __text skips the second, real change.
        text.setTextContent('b');
        text.setTextContent('a');
      },
      {discrete: true},
    );

    expect(editor.read(() => text.getTextContent())).toBe('a');
  });

  test('setMode can restore the original mode through a stale reference', () => {
    using editor = buildEditorFromExtensions({name: 'textnode-stale-state'});
    const text = seedStaleTextNode(editor);

    editor.update(
      () => {
        text.setMode('token');
        text.setMode('normal');
      },
      {discrete: true},
    );

    expect(editor.read(() => text.getMode())).toBe('normal');
  });

  test('isSimpleText reflects the latest mode', () => {
    using editor = buildEditorFromExtensions({name: 'textnode-stale-state'});
    const text = seedStaleTextNode(editor);

    editor.update(() => text.setMode('token'), {discrete: true});

    editor.read(() => {
      expect(text.isToken()).toBe(true);
      expect(text.isSimpleText()).toBe(false);
    });
  });
});
