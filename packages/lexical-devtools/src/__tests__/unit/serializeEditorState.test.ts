/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {EditorState} from 'lexical';

import {describe, expect, it} from 'vitest';

import {serializeEditorState} from '../../serializeEditorState';

function editorStateWithText(text: string): {
  editorState: EditorState;
  node: {__text: string; __type: string};
} {
  const node = {__text: text, __type: 'text'};

  return {
    editorState: {
      _nodeMap: new Map<string, unknown>([
        ['root', {__type: 'root'}],
        ['1', node],
      ]),
      _selection: null,
    } as unknown as EditorState,
    node,
  };
}

describe('serializeEditorState', () => {
  it('passes text through by default', () => {
    const {editorState} = editorStateWithText('hello world');

    const serialized = serializeEditorState(editorState);

    expect(
      (serialized._nodeMap['1'] as unknown as {__text: string}).__text,
    ).toBe('hello world');
  });

  it('masks text when asked, preserving length', () => {
    const {editorState} = editorStateWithText('hello world');

    const serialized = serializeEditorState(editorState, {
      obfuscateText: true,
    });

    expect(
      (serialized._nodeMap['1'] as unknown as {__text: string}).__text,
    ).toBe('***********');
  });

  it('leaves nodes without text untouched', () => {
    const {editorState} = editorStateWithText('hi');

    const serialized = serializeEditorState(editorState, {
      obfuscateText: true,
    });

    expect(serialized._nodeMap.root).toEqual({__type: 'root'});
  });

  it('never mutates the editor its own nodes', () => {
    // The node map holds live references to the editor's nodes, so masking
    // has to copy. Mutating in place would corrupt the user's document.
    const {editorState, node} = editorStateWithText('secret');

    serializeEditorState(editorState, {obfuscateText: true});

    expect(node.__text).toBe('secret');
  });
});
