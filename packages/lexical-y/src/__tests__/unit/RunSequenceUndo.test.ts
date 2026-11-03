/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Two clients, random words with random formats. B gives a run a format,
// types plain " zz" somewhere, gives a second run (or its own " zz") the same
// format, and the clients sync. Then, concurrently, A types plain "X" inside
// the first run while B undoes one to three of its writes (the last undo
// sometimes after A's "X" reached B). Words outside both runs keep the
// formats they had, and the clients agree. (Found by the randomized
// run-sequence sessions; seed 87 also fails on main, #9599.)

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  configExtension,
  defineExtension,
  type LexicalEditor,
  type TextFormatType,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {YCollabExtension} from '../..';
import {createYDoc, seedYState} from '../../headless';

const extensions = [RichTextExtension];
const config = {extensions, onWarn: () => {}, schemaVersion: 1};
const FORMATS: TextFormatType[] = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
];
const SEEDS = 200;
// Seeds of this range that fail. Seed 87 failed (#9599) until a restore's
// scan stopped at another client's content (`runOpener`).
const FAIL_ON_MAIN: number[] = [];

function rngOf(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function client(seed: Uint8Array, id: number) {
  const doc = createYDoc(seed);
  doc.clientID = id;
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        ...extensions,
        configExtension(YCollabExtension, {doc, schemaVersion: 1}),
      ],
      name: 'c' + id,
    }),
  );
  return {doc, editor};
}

function $find(token: string): [TextNode, number] {
  for (const t of $getRoot().getAllTextNodes()) {
    const i = t.getTextContent().indexOf(token);
    if (i >= 0) {
      return [t, i];
    }
  }
  throw new Error(token);
}

function $select(from: string, to: string) {
  const [a, ao] = $find(from);
  const [b, bo] = $find(to);
  const s = $createRangeSelection();
  s.anchor.set(a.getKey(), ao, 'text');
  s.focus.set(b.getKey(), bo + to.length, 'text');
  $setSelection(s);
  return s;
}

function $typePlain(token: string, offset: number, text: string) {
  const [node, i] = $find(token);
  const s = $createRangeSelection();
  s.anchor.set(node.getKey(), i + offset, 'text');
  s.focus.set(node.getKey(), i + offset, 'text');
  $setSelection(s);
  s.setFormat(0);
  s.insertText(text);
}

const formatsOf = (editor: LexicalEditor) =>
  editor.getEditorState().read(() => {
    const m: Record<string, number> = {};
    for (const t of $getRoot().getAllTextNodes()) {
      for (const w of t.getTextContent().split(/\s+/)) {
        if (/^w\d+$/.test(w)) {
          m[w] = (m[w] ?? 0) | t.getFormat();
        }
      }
    }
    return m;
  });

test('a run sequence undone while a collaborator types inside the first run leaves other words as they were', async () => {
  const failing: number[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rngOf(seed);
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const n = 6 + Math.floor(r() * 6);
    const words = Array.from({length: n}, (_, i) => `w${i}`);
    const pre = words.map(() => (r() < 0.3 ? 1 << Math.floor(r() * 4) : 0));
    const lines = r() < 0.5 ? 1 : 2;
    const state = seedYState(config, () => {
      const ps = Array.from({length: lines}, () => $createParagraphNode());
      words.forEach((w, i) =>
        ps[lines === 1 ? 0 : i < n / 2 ? 0 : 1].append(
          $createTextNode(w + ' ').setFormat(pre[i]),
        ),
      );
      $getRoot()
        .clear()
        .append(...ps);
    });
    const [ia, ib] = r() < 0.5 ? [1, 2] : [2, 1];
    const a = client(state, ia);
    const b = client(state, ib);
    await Promise.resolve();
    const format = pick(FORMATS);
    const i1 = Math.floor(r() * (n - 1));
    const j1 = Math.min(n - 1, i1 + Math.floor(r() * 2));
    const i2 = Math.floor(r() * n);
    const j2 = Math.min(n - 1, i2 + Math.floor(r() * 2));
    // The second run is the writer's own just-typed plain word.
    const ownWord = r() < 0.4;
    const typedAfter = pick(words);
    b.editor.update(() => $select(words[i1], words[j1]).formatText(format), {
      discrete: true,
    });
    b.editor.update(() => $typePlain(typedAfter, typedAfter.length, ' zz'), {
      discrete: true,
    });
    b.editor.update(
      () =>
        (ownWord
          ? $select('zz', 'zz')
          : $select(words[i2], words[j2])
        ).formatText(format),
      {discrete: true},
    );
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    await Promise.resolve();
    const before = formatsOf(a.editor);
    const svB = Y.encodeStateVector(b.doc);
    const svA = Y.encodeStateVector(a.doc);
    const k = 1 + Math.floor(r() * 3);
    const target = words[i1 + Math.floor(r() * (j1 - i1 + 1))];
    a.editor.update(() => $typePlain(target, 1, 'X'), {discrete: true});
    const binding = getExtensionDependencyFromEditor(b.editor, YCollabExtension)
      .output.binding;
    const undo = () => {
      binding.undoManager?.stopCapturing();
      binding.undo();
    };
    // The last undo after A's edit reached B.
    const late = k > 1 && r() < 0.5;
    for (let i = 0; i < (late ? k - 1 : k); i++) {
      undo();
    }
    if (late) {
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, svB));
      await Promise.resolve();
      undo();
    }
    const fromA = Y.encodeStateAsUpdate(a.doc, svA);
    const fromB = Y.encodeStateAsUpdate(b.doc, svB);
    Y.applyUpdate(a.doc, fromB);
    Y.applyUpdate(b.doc, fromA);
    await Promise.resolve();
    const after = formatsOf(a.editor);
    const afterB = formatsOf(b.editor);
    const touched = new Set([
      ...words.slice(i1, j1 + 1),
      ...(ownWord ? [] : words.slice(i2, j2 + 1)),
    ]);
    const changed = words.filter(
      w => !touched.has(w) && (after[w] ?? 0) !== (before[w] ?? 0),
    );
    if (
      changed.length > 0 ||
      JSON.stringify(after) !== JSON.stringify(afterB)
    ) {
      failing.push(seed);
    }
    a.editor.setRootElement(null);
    b.editor.setRootElement(null);
  }
  expect(failing).toEqual(FAIL_ON_MAIN);
}, 120000);
