/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  createEditor,
  type NodeKey,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// While an editor records text edits (`_recordTextEdits`, set by the Yjs 14
// binding), TextNode#splitText records, on the update's state and keyed by
// the previous node map, which node each new part came from and where in
// that node's text it starts.

function setUp(record: boolean) {
  const editor = createEditor({
    onError: e => {
      throw e;
    },
  });
  editor._recordTextEdits = record;
  let key: NodeKey = '';
  editor.update(
    () => {
      const text = $createTextNode('abcdef');
      key = text.getKey();
      $getRoot().append($createParagraphNode().append(text));
    },
    {discrete: true},
  );
  return {editor, key};
}

describe('the split record', () => {
  test('names the node each part was split from and its offset', () => {
    const {editor, key} = setUp(true);
    const prev = editor.getEditorState();
    let parts: NodeKey[] = [];
    let again: NodeKey = '';
    editor.update(
      () => {
        const [, b, c] = ($getNodeByKey(key) as TextNode).splitText(2, 4);
        parts = [b.getKey(), c.getKey()];
        // A part of a part counts from the node first split.
        again = c.splitText(1)[1].getKey();
      },
      {discrete: true},
    );
    const record = editor.getEditorState()._splitNodes;
    expect(record).not.toBe(null);
    expect(record!.get(prev._nodeMap)).toEqual(
      new Map([
        [parts[0], [key, 2]],
        [parts[1], [key, 4]],
        [again, [key, 5]],
      ]),
    );
  });

  test('is not made while the editor does not record text edits', () => {
    const {editor, key} = setUp(false);
    editor.update(
      () => {
        ($getNodeByKey(key) as TextNode).splitText(3);
      },
      {discrete: true},
    );
    expect(editor.getEditorState()._splitNodes).toBe(null);
  });
});
