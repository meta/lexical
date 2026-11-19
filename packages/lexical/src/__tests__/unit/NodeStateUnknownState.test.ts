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
  $getRoot,
  $getState,
  $getWritableNodeState,
  $parseSerializedNode,
  $setState,
  createEditor,
  createState,
  type LexicalNode,
  NODE_STATE_KEY,
  ParagraphNode,
  type SerializedParagraphNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// Neither state is known to ParagraphNode in a fresh editor until it is first
// read or written, so a paragraph made from JSON keeps their values in
// `unknownState` until then.
const idState = createState('nsuId', {
  parse: v => (typeof v === 'string' ? v : undefined),
});
const countState = createState('nsuCount', {
  parse: v => (typeof v === 'number' ? v : 0),
});

const JSON_STATE = {nsuCount: 2, nsuId: 'stored', nsuOther: true};

function paragraphJSON(): SerializedParagraphNode {
  return {
    [NODE_STATE_KEY]: {...JSON_STATE},
    children: [],
    direction: null,
    format: '',
    indent: 0,
    textFormat: 0,
    textStyle: '',
    type: 'paragraph',
    version: 1,
  } as SerializedParagraphNode;
}

function $appendFromJSON(): LexicalNode {
  const node = $parseSerializedNode(paragraphJSON());
  $getRoot().clear().append(node);
  return node;
}

function exportState(editor: ReturnType<typeof createEditor>) {
  return editor
    .getEditorState()
    .read(() => $getRoot().getFirstChildOrThrow().exportJSON())[NODE_STATE_KEY];
}

function makeEditor() {
  return createEditor({
    nodes: [ParagraphNode],
    onError: e => {
      throw e;
    },
  });
}

describe('a state that is still in unknownState', () => {
  test('$setState to the default removes it, in the same update and after', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const node = $appendFromJSON();
        $setState(node, idState, undefined);
        expect($getState(node, idState)).toBe(undefined);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getState($getRoot().getFirstChildOrThrow(), idState)).toBe(
        undefined,
      );
    });
    expect(exportState(editor)).toEqual({nsuCount: 2, nsuOther: true});
  });

  test('$setState to the default after a read removes it', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const node = $appendFromJSON();
        expect($getState(node, idState)).toBe('stored');
        $setState(node, idState, () => undefined);
        expect($getState(node, idState)).toBe(undefined);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getState($getRoot().getFirstChildOrThrow(), idState)).toBe(
        undefined,
      );
    });
    expect(exportState(editor)).toEqual({nsuCount: 2, nsuOther: true});
  });

  test('updateFromUnknown with a known key removes it', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const node = $appendFromJSON();
        // Make the key known to the type after the node was made from JSON
        $setState($createParagraphNode(), idState, 'other');
        $getWritableNodeState(node).updateFromUnknown('nsuId', undefined);
        expect($getState(node, idState)).toBe(undefined);
      },
      {discrete: true},
    );
    expect(exportState(editor)).toEqual({nsuCount: 2, nsuOther: true});
  });

  test('a value that is set is the only copy of the key', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const node = $appendFromJSON();
        $setState(node, idState, 'new');
        $setState(node, countState, 0);
        const [unknown, known] = $getWritableNodeState(node).getInternalState();
        expect(unknown).toEqual({nsuOther: true});
        expect(known.get(idState)).toBe('new');
        expect(known.get(countState)).toBe(0);
        expect($getState(node, idState)).toBe('new');
        expect($getState(node, countState)).toBe(0);
      },
      {discrete: true},
    );
    expect(exportState(editor)).toEqual({nsuId: 'new', nsuOther: true});
  });

  test('reading it does not change the JSON', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const node = $appendFromJSON();
        expect($getState(node, idState)).toBe('stored');
        expect($getState(node, countState)).toBe(2);
      },
      {discrete: true},
    );
    expect(JSON.stringify(exportState(editor))).toBe(
      JSON.stringify(JSON_STATE),
    );
  });
});
