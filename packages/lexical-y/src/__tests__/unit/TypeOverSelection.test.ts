/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Typing over a selection (the selection's insertText on a range, as a
// person types over selected text) writes exactly the removed and the typed
// characters, whatever the caret does after (soak A5 S5-1). Lexical removes
// the range and types the text into a node it makes for it, cut into the
// node and merged back: the record of text edits keeps every other
// character's item. Before, the merged node was diffed and the replacement
// widened to whole words: "abcdef" with "c" replaced by "X" was written
// `del "abcdef" ins "abXdef"`, so a peer's concurrent delete of "a" came
// back and its typing landed at the start of the text.

import {
  buildEditorFromExtensions,
  configExtension,
  defineExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$addMarkID, MarkStateExtension} from '@lexical/mark';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function peer(id: number) {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = id;
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
        }),
        MarkStateExtension,
      ],
      name: 'type-over/' + id,
      onError: e => {
        throw e;
      },
    }),
  );
  const {binding} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  return {binding, doc, editor};
}
type Peer = ReturnType<typeof peer>;

const $line = () => $getRoot().getChildAtIndex(1) as ElementNode;
const lineText = (p: Peer) =>
  p.editor.getEditorState().read(() => $line().getTextContent());

/** The ids of the shared items of line 1's characters, in order. */
function lineIds(p: Peer): string[] {
  const lines: string[][] = [[]];
  const root = p.binding.root as unknown as {_start: Y.Item | null};
  for (let it = root._start; it !== null; it = it.right) {
    if (it.deleted || !it.countable) {
      continue;
    }
    if (it.content instanceof Y.ContentString) {
      for (let k = 0; k < it.length; k++) {
        lines[lines.length - 1].push(`${it.id.client}:${it.id.clock + k}`);
      }
    } else if (it.content instanceof Y.ContentType) {
      lines.push([]);
    }
  }
  return lines[1];
}

/** The text node and offset at `at` of the line's text. */
function $at(at: number, isStart: boolean): [TextNode, number] {
  const texts = $line().getAllTextNodes();
  let pos = 0;
  for (let i = 0; i < texts.length; i++) {
    const size = texts[i].getTextContentSize();
    if (
      (isStart ? at < pos + size : at <= pos + size) ||
      i === texts.length - 1
    ) {
      return [texts[i], at - pos];
    }
    pos += size;
  }
  throw new Error('no text');
}

// The lines: text runs [text, format, comment id or null].
const LINES: [string, number, string | null][][] = [
  [['abcdef la la ', 0, null]],
  [
    ['t3z ', 1, null],
    ['t4z t4z ', 0, null],
    ['la ', 2, null],
  ],
  [
    ['da ', 0, null],
    ['da t2z da', 0, 'c1'],
    [' da', 0, null],
  ],
  [
    ['ab', 1, null],
    ['abab ', 0, 'c2'],
    ['ab ab', 0, null],
  ],
];

async function start(runs: [string, number, string | null][]) {
  const p = peer(1);
  p.editor.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append($createTextNode('Title')),
          $createParagraphNode().append(
            ...runs.map(([text, format]) =>
              $createTextNode(text).setFormat(format),
            ),
          ),
        );
    },
    {discrete: true},
  );
  p.binding.initialize();
  await flush();
  // Comments over their runs.
  let pos = 0;
  for (const [text, , id] of runs) {
    if (id !== null) {
      const [from, to] = [pos, pos + text.length];
      p.editor.update(
        () => {
          const [a, ao] = $at(from, true);
          const [f, fo] = $at(to, false);
          const s = $createRangeSelection();
          s.anchor.set(a.getKey(), ao, 'text');
          s.focus.set(f.getKey(), fo, 'text');
          $addMarkID(id, s);
          $setSelection(null);
        },
        {discrete: true},
      );
      await flush();
    }
    pos += text.length;
  }
  return p;
}

describe('typing over a selection writes exactly the removed and typed characters', () => {
  test('every position, selections of 0 to 5 characters, the caret kept or cleared', async () => {
    const fails: string[] = [];
    let n = 0;
    for (const runs of LINES) {
      const full = runs.map(r => r[0]).join('');
      for (let at = 0; at <= full.length; at++) {
        for (let len = 0; len <= 5 && at + len <= full.length; len++) {
          // A new letter, and text equal to what is next to it.
          const typed = [
            'X',
            full.slice(at, at + len) ||
              full.slice(Math.max(0, at - 1), at) ||
              'a',
          ];
          for (const ins of typed) {
            for (const caret of [true, false]) {
              n++;
              const p = await start(runs);
              const before = lineIds(p);
              p.editor.update(
                () => {
                  const [a, ao] = $at(at, true);
                  const [f, fo] = $at(at + len, false);
                  const s = $createRangeSelection();
                  s.anchor.set(a.getKey(), ao, 'text');
                  s.focus.set(f.getKey(), fo, 'text');
                  // As a selection made in the editor: its text's format.
                  s.format = a.getFormat();
                  s.style = a.getStyle();
                  $setSelection(s);
                  s.insertText(ins);
                  if (!caret) {
                    $setSelection(null);
                  }
                },
                {discrete: true},
              );
              const want = full.slice(0, at) + ins + full.slice(at + len);
              const model: (string | null)[] = before.slice();
              model.splice(at, len, ...new Array<null>(ins.length).fill(null));
              const ids = lineIds(p);
              const old = new Set(before);
              if (
                lineText(p) !== want ||
                ids.length !== model.length ||
                model.some((id, i) =>
                  id === null ? old.has(ids[i]) : id !== ids[i],
                )
              ) {
                fails.push(
                  `${JSON.stringify(runs.map(r => r[0]))} [${at},${at + len}) -> ${JSON.stringify(ins)}${caret ? '' : ' (caret cleared)'}: ${JSON.stringify(lineText(p))}`,
                );
              }
              p.editor.dispose();
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(1000);
    expect(fails).toEqual([]);
  }, 600_000);

  test('a peer deletes an untouched character, or types between them, at the same time', async () => {
    for (const op of ['delete a', 'type Z at 4'] as const) {
      const a = peer(1);
      const b = peer(2);
      a.editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('Title')),
              $createParagraphNode().append($createTextNode('abcdef')),
            );
        },
        {discrete: true},
      );
      a.binding.initialize();
      await flush();
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      b.binding.initialize();
      await flush();
      a.editor.update(
        () => {
          const t = $line().getFirstChild() as TextNode;
          t.select(2, 3).insertText('X');
        },
        {discrete: true},
      );
      b.editor.update(
        () => {
          const t = $line().getFirstChild() as TextNode;
          if (op === 'delete a') {
            t.select(0, 1).removeText();
          } else {
            t.select(4, 4).insertText('Z');
          }
          $setSelection(null);
        },
        {discrete: true},
      );
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      await flush();
      expect(lineText(a)).toBe(lineText(b));
      expect(lineText(a)).toBe(op === 'delete a' ? 'bXdef' : 'abXdZef');
      a.editor.dispose();
      b.editor.dispose();
    }
  });
});
