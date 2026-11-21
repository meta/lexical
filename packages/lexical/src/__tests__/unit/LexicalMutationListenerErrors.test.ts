/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

// A mutation listener that throws does not stop the other mutation listeners,
// nor the update listeners, from seeing the commit (mutation listeners run
// only for a reconciled editor); the first error is rethrown.
test('a mutation listener that throws does not hide the commit from the others', () => {
  const editor = createEditor({
    nodes: [],
    onError: error => {
      throw error;
    },
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode('one')));
    },
    {discrete: true},
  );
  const calls: string[] = [];
  const first = new Error('first');
  editor.registerMutationListener(
    TextNode,
    () => {
      calls.push('a');
      throw first;
    },
    {skipInitialization: true},
  );
  editor.registerMutationListener(
    TextNode,
    () => {
      calls.push('b');
      throw new Error('second');
    },
    {skipInitialization: true},
  );
  editor.registerMutationListener(TextNode, () => void calls.push('c'), {
    skipInitialization: true,
  });
  editor.registerUpdateListener(({editorState}) => {
    calls.push(`update ${editorState.read(() => $getRoot().getTextContent())}`);
  });
  let thrown: unknown = null;
  try {
    editor.update(
      () => {
        ($getRoot().getFirstDescendant() as TextNode).setTextContent('ONE');
      },
      {discrete: true},
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(first);
  expect(calls).toEqual(['a', 'b', 'c', 'update ONE']);
  editor.setRootElement(null);
  root.remove();
});
