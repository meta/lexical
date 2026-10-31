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
  $addMarkID,
  $getNodeMarkIDs,
  $removeMarkID,
  MarkStateExtension,
} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {$patchStyleText} from '@lexical/selection';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getState,
  $isElementNode,
  $isTextNode,
  $setSelection,
  $setState,
  configExtension,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  REDO_COMMAND,
  type TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension, type YDoc} from '../../..';
import {readYState, seedYState} from '../../../headless';
import {$block, $selectIn, expectConverged, setup} from '../../utils/harness';
import {markState, prepareMarkState as prepare} from '../../utils/sizeOps';

// #9623, #9620: an undo that brings back an item opening a value (a comment,
// a format, a style, a NodeState value) whose run's end is gone, because
// another change's undo deleted it before (#9623) or at the same time
// (#9620), left the value open: it covered everything after it. The undo
// now ends the run it brings back where that run ended when the item was
// deleted, with a null of its own (see Binding#closeRestoredRuns and
// #recordRunEnds).
//
// Input space: the value is a comment id (MarkState), bold, a color style or
// a NodeState value; a collaborator removes it from the whole word, from part
// of it, or (comments) from the whole document; the value's author undoes
// its change before the removal is undone, or not; another client types
// plain text right after the word, or not; then a redo and another undo;
// garbage collection on and off; two client id orders.

const PARAS = ['zero zero', 'one one', 'two two two', 'three three', 'four'];
const WORD: [block: number, start: number, end: number] = [2, 0, 5];
const NODE_STATE = markState('n');

type Value = 'comment' | 'bold' | 'color' | 'NodeState';
type Removal = 'the word' | 'part of the word' | 'the whole document';

function $wordSelection(start = WORD[1], end = WORD[2]) {
  const block = $getRoot().getChildAtIndex(WORD[0]) as ElementNode;
  let offset = 0;
  const selection = $createRangeSelection();
  for (const node of block.getAllTextNodes()) {
    const size = node.getTextContentSize();
    if (start >= offset && start <= offset + size) {
      selection.anchor.set(node.getKey(), start - offset, 'text');
      break;
    }
    offset += size;
  }
  offset = 0;
  for (const node of block.getAllTextNodes()) {
    const size = node.getTextContentSize();
    if (end >= offset && end <= offset + size) {
      selection.focus.set(node.getKey(), end - offset, 'text');
      break;
    }
    offset += size;
  }
  $setSelection(selection);
  return selection;
}

function $give(value: Value, on: boolean, start?: number, end?: number) {
  const selection = $wordSelection(start, end);
  if (value === 'comment') {
    if (on) {
      $addMarkID('c2', selection);
    } else {
      $removeMarkID('c2', selection);
    }
  } else if (value === 'bold') {
    // 1 is bold's format flag: bold on, or off, whatever the text has.
    selection.formatText('bold', on ? 1 : 0);
  } else if (value === 'color') {
    $patchStyleText(selection, {color: on ? 'red' : null});
  } else {
    for (const node of selection.extract()) {
      if ($isTextNode(node)) {
        $setState(node, NODE_STATE, on);
      }
    }
  }
  $setSelection(null);
}

function $has(value: Value, node: TextNode): boolean {
  switch (value) {
    case 'comment':
      return $getNodeMarkIDs(MarkStateExtension, node).includes('c2');
    case 'bold':
      return node.hasFormat('bold');
    case 'color':
      return node.getStyle().includes('red');
    case 'NodeState':
      return $getState(node, NODE_STATE);
  }
}

/** Each block's text with every character that has the value as `^`. */
function $marked(value: Value): string[] {
  return $getRoot()
    .getChildren()
    .map(block =>
      $isElementNode(block)
        ? block
            .getAllTextNodes()
            .map(node =>
              $has(value, node)
                ? '^'.repeat(node.getTextContentSize())
                : node.getTextContent(),
            )
            .join('')
        : '?',
    );
}

const CONFIG = {
  extensions: [RichTextExtension, MarkStateExtension],
  schemaVersion: 1,
};

function clients(gc: boolean, ids: number[]) {
  const seeded = seedYState(CONFIG, () => {
    $getRoot()
      .clear()
      .append(
        ...PARAS.map(text =>
          $createParagraphNode().append($createTextNode(text)),
        ),
      );
  });
  const peers = ids.map(id => {
    const doc = createYDoc(seeded, {gc});
    doc.clientID = id;
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          MarkStateExtension,
          configExtension(YCollabExtension, {
            captureTimeout: 0,
            doc,
            schemaVersion: 1,
            synced: true,
          }),
        ],
        name: `undo-restored-run-ends/${id}`,
        onError: error => {
          throw error;
        },
      }),
    );
    return {doc, editor};
  });
  const sync = () => {
    for (const from of peers) {
      for (const to of peers) {
        if (from !== to) {
          Y.applyUpdate(
            to.doc,
            Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
          );
        }
      }
    }
  };
  return {peers, sync};
}

function update(editor: LexicalEditor, fn: () => void) {
  editor.update(fn, {discrete: true});
}

function liveFormatItems(doc: YDoc): number {
  let n = 0;
  const root = doc.get('lexical-y') as unknown as {_start: Y.Item | null};
  for (let it = root._start; it !== null; it = it.right) {
    if (!it.deleted && it.content instanceof Y.ContentFormat) {
      n++;
    }
  }
  return n;
}

/**
 * Every client and a fresh read of the document agree, the other blocks have
 * no value, and the word's block (with `^` where the value is) is
 * `expected`.
 */
function check(
  value: Value,
  t: ReturnType<typeof clients>,
  // The word's block with `^` where the value is, or several such outcomes
  // any of which is right.
  expected: string | string[],
) {
  const outcomes = typeof expected === 'string' ? [expected] : expected;
  // Every block keeps its text (and the word's block the text typed after
  // the word, where there is some), whatever the value.
  const lines = PARAS.map((line, i) =>
    i === WORD[0] && outcomes[0].includes('ZZ')
      ? line.slice(0, WORD[2]) + 'ZZ' + line.slice(WORD[2])
      : line,
  );
  for (const p of t.peers) {
    expect(
      p.editor.read(() =>
        $getRoot()
          .getChildren()
          .map(block => block.getTextContent()),
      ),
      'the text',
    ).toEqual(lines);
  }
  const views = t.peers.map(p => p.editor.read(() => $marked(value)));
  const fresh = readYState(Y.encodeStateAsUpdate(t.peers[0].doc), CONFIG, () =>
    $marked(value),
  );
  for (const view of views) {
    expect(view).toEqual(views[0]);
  }
  expect(fresh).toEqual(views[0]);
  views[0].forEach((text, i) => {
    if (i !== WORD[0]) {
      expect(text).not.toContain('^');
    }
  });
  expect(outcomes).toContain(views[0][WORD[0]]);
}

/**
 * The word's block with `^` exactly on `[a, b)` of it (nothing marked where
 * `a === b`), and the text typed after the word, when there is some, unmarked.
 */
function exactly(a: number, b: number, typedAfter: boolean) {
  const text = PARAS[WORD[0]];
  const marked = text.slice(0, a) + '^'.repeat(b - a) + text.slice(b);
  const at = WORD[2];
  const expected = typedAfter
    ? marked.slice(0, at) + 'ZZ' + marked.slice(at)
    : marked;
  return expected;
}

const VALUES: Value[] = ['comment', 'bold', 'color', 'NodeState'];
const REMOVALS: Removal[] = [
  'the word',
  'part of the word',
  'the whole document',
];

/**
 * The cells main fails, pinned as test.fails until the fixes land: with
 * garbage collection on, the restored value runs on past its end (#9623);
 * where the removal took part of the word, the author's undo leaves the rest
 * of the word with the value the removal restated after that part (D64,
 * #9560), and the removal's undo gives the whole word back.
 */
function testOnMain(name: string, fn: () => void) {
  const fails =
    name.includes('its author undoes it first') &&
    (name.includes('gc on') || name.includes('part of the word'));
  (fails ? test.fails : test)(name, fn);
}

describe('an undo that brings back a value ends its run where it ended (#9623)', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const value of VALUES) {
        for (const removal of REMOVALS) {
          if (removal === 'the whole document' && value !== 'comment') {
            continue;
          }
          for (const authorUndoes of [true, false]) {
            for (const typedAfter of [false, true]) {
              testOnMain(
                `${value}, removed from ${removal}, ${authorUndoes ? 'its author undoes it first' : 'kept by its author'}${typedAfter ? ', text typed after the word' : ''} (gc ${gc ? 'on' : 'off'}, ids ${ids})`,
                () => {
                  const t = clients(gc, ids);
                  const [a, b, c] = t.peers;
                  update(b.editor, () => $give(value, true));
                  t.sync();
                  if (typedAfter) {
                    update(c.editor, () => {
                      const selection = $wordSelection(WORD[2], WORD[2]);
                      selection.format = 0;
                      selection.style = '';
                      selection.insertNodes([$createTextNode('ZZ')]);
                      $setSelection(null);
                    });
                    t.sync();
                  }
                  update(a.editor, () => {
                    if (removal === 'the whole document') {
                      $removeMarkID('c2');
                    } else if (removal === 'the word') {
                      $give(value, false);
                    } else {
                      $give(value, false, WORD[1], WORD[1] + 3);
                    }
                  });
                  t.sync();
                  if (authorUndoes) {
                    b.editor.dispatchCommand(UNDO_COMMAND, undefined);
                    t.sync();
                  }
                  // What the removal took off the word, and what it left.
                  const [from, to] =
                    removal === 'part of the word'
                      ? [WORD[1], WORD[1] + 3]
                      : [WORD[1], WORD[2]];
                  // The undo gives back what the removal took (the author's
                  // undo already took the rest), or, where the author undid
                  // the value, possibly nothing (undecided, #9623); never
                  // more. A redo takes it again.
                  const undone = authorUndoes
                    ? [exactly(from, to, typedAfter), exactly(0, 0, typedAfter)]
                    : exactly(WORD[1], WORD[2], typedAfter);
                  const redone = authorUndoes
                    ? exactly(0, 0, typedAfter)
                    : exactly(to, WORD[2], typedAfter);
                  a.editor.dispatchCommand(UNDO_COMMAND, undefined);
                  t.sync();
                  check(value, t, undone);
                  a.editor.dispatchCommand(REDO_COMMAND, undefined);
                  t.sync();
                  check(value, t, redone);
                  a.editor.dispatchCommand(UNDO_COMMAND, undefined);
                  t.sync();
                  check(value, t, undone);
                  for (const p of t.peers) {
                    p.editor.dispose();
                  }
                },
              );
            }
          }
        }
      }
    }
  }

  test('repeated undo and redo of the removal keep the items bounded', () => {
    const t = clients(false, [1, 2, 3]);
    const [a, b] = t.peers;
    update(b.editor, () => $give('comment', true));
    t.sync();
    update(a.editor, () => $give('comment', false));
    t.sync();
    b.editor.dispatchCommand(UNDO_COMMAND, undefined);
    t.sync();
    const counts: number[] = [];
    for (let i = 1; i <= 40; i++) {
      a.editor.dispatchCommand(UNDO_COMMAND, undefined);
      t.sync();
      a.editor.dispatchCommand(REDO_COMMAND, undefined);
      t.sync();
      if (i % 10 === 0) {
        counts.push(liveFormatItems(a.doc));
      }
    }
    // The last step is a redo of the removal: no comment.
    check('comment', t, exactly(0, 0, false));
    // As many live format items after 40 cycles as after 10.
    expect(counts[3]).toBe(counts[0]);
    for (const p of t.peers) {
      p.editor.dispose();
    }
  });
});

// #9620: the end goes at the same time as the undo brings the value back.
describe('an undo that brings back a value while its end goes at the same time (#9620)', () => {
  function show(peer: {read: <T>(fn: () => T) => T}): string {
    return peer.read(() =>
      $getRoot()
        .getChildren()
        .map((_, i) =>
          ($block([i]).getAllTextNodes() as TextNode[])
            .map(n => {
              const ids = $getNodeMarkIDs(n as LexicalNode);
              return (
                JSON.stringify(n.getTextContent()) +
                (ids.length > 0 ? `[${ids.join(',')}]` : '')
              );
            })
            .join(''),
        )
        .join(' / '),
    );
  }
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    // Failed while a delete collapsed the run it left (#9620: the collapse
    // dropped the comment's end); a delete now keeps every format item it
    // leaves (D86).
    test(`a comment its author undid does not cover the rest of the document (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('abcd Kilo bb cc')),
            $createParagraphNode().append($createTextNode('tail line')),
          ),
        {ids, prepare},
      );
      t.a.update(() => void $addMarkID('c1', $selectIn([0], 5, 9)));
      t.b.update(() => void $addMarkID('c2', $selectIn([0], 0, 3)));
      t.b.update(() => {
        const [, tail] = (
          $block([0]).getAllTextNodes() as TextNode[]
        )[0].splitText(2);
        tail.insertBefore($createTextNode('XY'));
      });
      await t.sync();
      expect(show(t.a)).toBe(
        '"ab"[c2]"XY""c"[c2]"d ""Kilo"[c1]" bb cc" / "tail line"',
      );
      t.offline();
      t.a.update(() => void $selectIn([0], 2, 5).removeText());
      t.a.update(() => void $selectIn([0], 2, 7).removeText());
      t.a.undo();
      t.b.undo();
      t.b.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(show(t.a)).toBe('"abd ""Kilo"[c1]" bb cc" / "tail line"');
    });
  }
});
