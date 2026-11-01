/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $setSelection,
  createEditor,
  type LexicalEditor,
  type NodeKey,
  resetRandomKey,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {type EntityMatch, registerLexicalTextEntity} from '../..';

// While an editor records text edits (`_recordTextEdits`, set by the Yjs 14
// binding), registerLexicalTextEntity says what its transforms do with the
// characters they touch, around the same calls it makes otherwise: an entity
// grown over the start of the next node takes those characters (a `move`),
// and an entity made plain text again, or plain text made an entity, holds
// the same characters in a node of another type (a `retype`). Without
// recording nothing is recorded, and the editor ends the same either way.

class TagNode extends TextNode {
  $config() {
    return this.config('record-tag', {extends: TextNode});
  }
  isTextEntity(): true {
    return true;
  }
}

const getMatch = (text: string): null | EntityMatch => {
  const m = /#[a-z]+/.exec(text);
  return m === null ? null : {end: m.index + m[0].length, start: m.index};
};

/** A plain text node, or a tag (`['#tag']`). */
type Piece = string | [string];

function setUp(
  record: boolean,
  pieces: Piece[],
  createNode: (node: TextNode) => TagNode = node =>
    $create(TagNode).setTextContent(node.getTextContent()),
) {
  const editor = createEditor({
    nodes: [TagNode],
    onError: e => {
      throw e;
    },
  });
  registerLexicalTextEntity(editor, getMatch, TagNode, createNode);
  editor._recordTextEdits = record;
  const keys: NodeKey[] = [];
  let p = '';
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      p = paragraph.getKey();
      for (const piece of pieces) {
        const node =
          typeof piece === 'string'
            ? $createTextNode(piece)
            : $create(TagNode).setTextContent(piece[0]);
        keys.push(node.getKey());
        paragraph.append(node);
      }
      $getRoot().append(paragraph);
      $setSelection(null);
    },
    {discrete: true},
  );
  return {editor, keys, p};
}

/** The record of an update (null when nothing was recorded). */
function recorded(editor: LexicalEditor, run: () => void) {
  const prev = editor.getEditorState();
  editor.update(run, {discrete: true});
  const edits = editor.getEditorState()._textEdits;
  const log = edits === null ? undefined : edits.get(prev._nodeMap);
  return log === undefined ? null : log;
}

/** The line as [type, text, key] triples, and the selection. */
function $state() {
  const s = $getSelection();
  const line = $getRoot().getFirstChildOrThrow();
  return {
    line: ($isElementNode(line) ? line.getChildren() : []).map(n => [
      n.getType(),
      n.getTextContent(),
      n.getKey(),
    ]),
    selection: $isRangeSelection(s)
      ? [s.anchor.key, s.anchor.offset, s.focus.key, s.focus.offset]
      : null,
  };
}

const $text = (key: NodeKey) => $getNodeByKey(key) as TextNode;

/**
 * The same edit with and without recording, from the same node keys: the
 * record with it, nothing recorded without it, and the same JSON, nodes and
 * selection both ways.
 */
function both(pieces: Piece[], edit: (keys: NodeKey[]) => void) {
  resetRandomKey();
  const off = setUp(false, pieces);
  expect(recorded(off.editor, () => edit(off.keys))).toBe(null);
  resetRandomKey();
  const on = setUp(true, pieces);
  const log = recorded(on.editor, () => edit(on.keys));
  expect(on.keys).toEqual(off.keys);
  expect(on.editor.getEditorState().toJSON()).toEqual(
    off.editor.getEditorState().toJSON(),
  );
  const state = on.editor.read($state);
  expect(state).toEqual(off.editor.read($state));
  return {...on, log: log!, state};
}

describe('registerLexicalTextEntity records its edits', () => {
  test('an entity grown over the start of the next node: a move', () => {
    const {keys, log, state} = both([['#foo'], ' bar baz'], ([, plain]) => {
      $text(plain).select(0, 1).removeText();
    });
    const [tag, plain] = keys;
    expect(state.line).toEqual([
      ['record-tag', '#foobar', tag],
      ['text', ' baz', plain],
    ]);
    expect(log).toEqual([
      ['splice', plain, 0, 1, '', ' bar baz'],
      ['move', plain, tag, 3, 'bar baz', '#foo'],
    ]);
  });

  test('an entity grown over all of the next node: a move, then its removal', () => {
    const {keys, log, p, state} = both([['#foo'], ' bar'], ([, plain]) => {
      $text(plain).select(0, 1).removeText();
    });
    const [tag, plain] = keys;
    expect(state.line).toEqual([['record-tag', '#foobar', tag]]);
    expect(log).toEqual([
      ['splice', plain, 0, 1, '', ' bar'],
      ['move', plain, tag, 3, 'bar', '#foo'],
      ['detach', plain, p],
    ]);
  });

  test('an entity shrunk: a split, as before (the rest is plain text)', () => {
    const {keys, log, p, state} = both([['#foo']], ([tag]) => {
      $text(tag).setTextContent('#fo-o');
    });
    const [tag] = keys;
    const [, [, , rest]] = state.line;
    expect(state.line).toEqual([
      ['record-tag', '#fo', tag],
      ['text', '-o', rest],
    ]);
    expect(log).toEqual([
      ['set', tag, '#foo', '#fo-o'],
      ['split', tag, [tag, rest], [0, 3], '#fo-o'],
      ['detach', tag, p],
      ['attach', tag, p, null, null, '#fo'],
      ['attach', rest, p, tag, null, '-o'],
    ]);
  });

  test('an entity made plain text: a retype', () => {
    const {keys, log, p, state} = both([['#foo'], ' x'], ([tag]) => {
      $text(tag).setTextContent('foo');
    });
    const [tag, x] = keys;
    const [[, , plain]] = state.line;
    expect(state.line).toEqual([['text', 'foo x', plain]]);
    expect(log).toEqual([
      ['set', tag, '#foo', 'foo'],
      ['detach', tag, p],
      ['attach', plain, p, null, x, 'foo'],
      ['retype', tag, plain, 'foo'],
      ['merge', plain, x, false, 'foo', ' x'],
      ['detach', x, p],
    ]);
  });

  test('plain text made an entity: a split, then a retype', () => {
    const {keys, log, p, state} = both(['say '], ([plain]) => {
      $text(plain).select(4, 4).insertText('#foo');
      $setSelection(null);
    });
    const [plain] = keys;
    const [, [, , tag]] = state.line;
    expect(state.line).toEqual([
      ['text', 'say ', plain],
      ['record-tag', '#foo', tag],
    ]);
    const part = (log[1][2] as NodeKey[])[1];
    expect(log).toEqual([
      ['splice', plain, 4, 0, '#foo', 'say '],
      ['split', plain, [plain, part], [0, 4], 'say #foo'],
      ['detach', plain, p],
      ['attach', plain, p, null, null, 'say '],
      ['attach', part, p, plain, null, '#foo'],
      // (createNode sets the text of the node it makes.)
      ['set', tag, '', '#foo'],
      ['detach', part, p],
      ['attach', tag, p, plain, null, '#foo'],
      ['retype', part, tag, '#foo'],
    ]);
  });

  test('no retype where createNode gives the entity other text', () => {
    const {editor, keys} = setUp(true, ['say '], node =>
      $create(TagNode).setTextContent(node.getTextContent().toUpperCase()),
    );
    const log = recorded(editor, () => {
      $text(keys[0]).select(4, 4).insertText('#foo');
      $setSelection(null);
    })!;
    // "#foo" made "#FOO" is no retype; "#FOO" (no match) made plain text
    // with the same text is one.
    expect(log.filter(e => e[0] === 'retype').map(e => e[3])).toEqual(['#FOO']);
    expect(editor.read(() => $getRoot().getTextContent())).toBe('say #FOO');
  });
});
