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
  INTERNAL_$recordTextRetype,
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

test('split-only consumers record provenance without enabling the edit log', () => {
  const {editor, key} = setUp(false);
  editor._recordTextSplits++;
  const prev = editor.getEditorState();
  let tail = '';
  editor.update(
    () => {
      const source = $getNodeByKey(key) as TextNode;
      source.setTextContent('abcdef #first #second');
      const [, rest] = source.splitText(7);
      tail = rest.splitText(6)[1].getKey();
    },
    {discrete: true},
  );
  const state = editor.getEditorState();
  expect(state._splitNodes).toBe(null);
  expect(state._splitTextOrigins?.get(prev._nodeMap)?.get(tail)).toEqual({
    offset: 13,
    source: key,
    text: 'abcdef #first #second',
  });
  expect(state._splitTextOrigins?.get(prev._nodeMap)?.get(key)?.text).toBe(
    'abcdef #first #second',
  );
  expect(state._textEdits).toBe(null);
  expect(editor._recordTextEdits).toBe(false);
  editor._recordTextSplits--;
  editor.update(
    () => {
      ($getNodeByKey(key) as TextNode).splitText(2);
    },
    {discrete: true},
  );
  expect(editor.getEditorState()._splitNodes).toBe(null);
  expect(editor.getEditorState()._splitTextOrigins).toBe(null);
});

test('split-only consumer release does not disable a full edit recorder', () => {
  const {editor, key} = setUp(true);
  editor._recordTextSplits++;
  editor._recordTextSplits--;
  const prev = editor.getEditorState();
  editor.update(
    () => {
      ($getNodeByKey(key) as TextNode).splitText(2);
    },
    {discrete: true},
  );
  expect(editor.getEditorState()._splitNodes?.get(prev._nodeMap)?.size).toBe(1);
  expect(
    editor.getEditorState()._textEdits?.get(prev._nodeMap),
  ).not.toBeUndefined();
  expect(editor.getEditorState()._splitTextOrigins).toBe(null);
  expect(editor._recordTextEdits).toBe(true);
});

test('retyped split provenance does not add retypes to the Yjs split map', () => {
  for (const recordEdits of [false, true]) {
    const {editor, key} = setUp(recordEdits);
    editor._recordTextSplits++;
    const prev = editor.getEditorState();
    let pieceKey = '';
    let replacementKey = '';
    editor.update(
      () => {
        const source = $getNodeByKey(key) as TextNode;
        const [, piece] = source.splitText(3);
        pieceKey = piece.getKey();
        const replacement = $createTextNode(
          piece.getTextContent(),
        ).toggleFormat('bold');
        replacementKey = replacement.getKey();
        piece.replace(replacement);
        INTERNAL_$recordTextRetype(piece, replacement);
      },
      {discrete: true},
    );
    const state = editor.getEditorState();
    expect(
      state._splitTextOrigins?.get(prev._nodeMap)?.get(replacementKey),
    ).toEqual({
      offset: 3,
      source: key,
      text: 'abcdef',
    });
    expect(state._splitNodes && state._splitNodes.get(prev._nodeMap)).toEqual(
      recordEdits ? new Map([[pieceKey, [key, 3]]]) : null,
    );
    if (!recordEdits) {
      expect(state._textEdits).toBe(null);
    } else {
      expect(
        state._textEdits
          ?.get(prev._nodeMap)
          ?.some(entry => entry[0] === 'retype'),
      ).toBe(true);
    }
  }
});

test('retyping a split piece with different text does not propagate provenance', () => {
  const {editor, key} = setUp(false);
  editor._recordTextSplits++;
  const prev = editor.getEditorState();
  let replacementKey = '';
  editor.update(
    () => {
      const [, piece] = ($getNodeByKey(key) as TextNode).splitText(3);
      const replacement = $createTextNode('changed').toggleFormat('bold');
      replacementKey = replacement.getKey();
      piece.replace(replacement);
      INTERNAL_$recordTextRetype(piece, replacement);
    },
    {discrete: true},
  );
  expect(
    editor
      .getEditorState()
      ._splitTextOrigins?.get(prev._nodeMap)
      ?.has(replacementKey),
  ).toBe(false);
});
