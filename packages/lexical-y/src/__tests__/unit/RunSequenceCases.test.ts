/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Reduced cases of the randomized run-sequence sessions: a client formats
// a run, types plain text, formats again, and undoes those writes while a
// collaborator types (and undoes) plain text inside the first run. Words no
// one formatted keep their formats, and the clients agree. Main passes
// both; #9561 (parked) failed the first before a fix and the second always
// (#9593).

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
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {YCollabExtension} from '../..';
import {createYDoc, seedYState} from '../../headless';
import {$selectIn, expectConverged, setup} from '../utils/harness';

const extensions = [RichTextExtension];
const config = {extensions, onWarn: () => {}, schemaVersion: 1};

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

test('one undo step that underlines a run, types and underlines what it typed, undone while a collaborator types inside the run', async () => {
  // Randomized run-sequence seed 175, reduced to its steps: B underlines
  // w4..w5, types plain " zz" after w0 and underlines " zz" (one undo
  // step); A types plain "X" inside w5; B undoes, the last time after A's
  // "X" arrived. w6 and w7 stay as they were.
  const words = Array.from({length: 9}, (_, i) => `w${i}`);
  const pre = [0, 0, 1, 2, 4, 0, 0, 0, 8];
  const state = seedYState(config, () => {
    const lines = [$createParagraphNode(), $createParagraphNode()];
    words.forEach((w, i) =>
      lines[i < 4.5 ? 0 : 1].append($createTextNode(w + ' ').setFormat(pre[i])),
    );
    $getRoot()
      .clear()
      .append(...lines);
  });
  const a = client(state, 1);
  const b = client(state, 2);
  await Promise.resolve();
  b.editor.update(() => $select('w4', 'w5').formatText('underline'), {
    discrete: true,
  });
  b.editor.update(() => $typePlain('w0', 2, ' zz'), {discrete: true});
  b.editor.update(() => $select('zz', 'zz').formatText('underline'), {
    discrete: true,
  });
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
  await Promise.resolve();
  const before = formatsOf(a.editor);
  const svB = Y.encodeStateVector(b.doc);
  const svA = Y.encodeStateVector(a.doc);
  a.editor.update(() => $typePlain('w5', 1, 'X'), {discrete: true});
  const binding = getExtensionDependencyFromEditor(b.editor, YCollabExtension)
    .output.binding;
  const undo = () => {
    binding.undoManager?.stopCapturing();
    binding.undo();
  };
  undo();
  undo();
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, svB));
  await Promise.resolve();
  undo();
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, svB));
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, svA));
  await Promise.resolve();
  const after = formatsOf(a.editor);
  for (const w of ['w0', 'w1', 'w2', 'w3', 'w6', 'w7', 'w8']) {
    expect(after[w] ?? 0, w).toBe(before[w] ?? 0);
  }
  expect(formatsOf(b.editor)).toEqual(after);
});

const $strike = (from: number, to: number) => () => {
  const s = $selectIn([0], from, to);
  s.format = (s.anchor.getNode() as TextNode).getFormat();
  s.formatText('strikethrough');
  $setSelection(null);
};

const $plainAt = (off: number, text: string) => () => {
  for (const n of $getRoot().getAllTextNodes()) {
    const size = n.getTextContentSize();
    if (off > 0 && off < size) {
      const [, tail] = n.splitText(off);
      tail.insertBefore($createTextNode(text));
      return;
    }
    if (off === size) {
      n.insertAfter($createTextNode(text));
      return;
    }
    off -= size;
  }
  throw new Error('offset');
};

for (const ids of [
  [1, 2],
  [2, 1],
]) {
  for (const seen of [true, false]) {
    test(`a collaborator's undo of text inside a run, with the writer's undo of the run's format (writer saw the text: ${seen}, ids ${ids})`, async () => {
      // Randomized run-sequence seed 8500123, reduced: B strikes "bb",
      // types plain " zz", strikes "dd"; A types plain "X" inside "bb"; B
      // undoes twice; then A undoes "X" while B undoes the strike of "bb".
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('aa bb cc dd ee')),
          ),
        {ids},
      );
      t.b.update($strike(3, 5));
      t.b.update($plainAt(14, ' zz'));
      t.b.update($strike(9, 11));
      await t.sync();
      if (!seen) {
        t.offline();
      }
      t.a.update($plainAt(4, 'X'));
      if (seen) {
        await t.sync();
        t.offline();
      }
      t.b.undo();
      t.b.undo();
      t.a.undo();
      t.b.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(
        t.a.read(() =>
          $getRoot()
            .getAllTextNodes()
            .filter(n => n.hasFormat('strikethrough'))
            .map(n => n.getTextContent())
            .join(''),
        ),
      ).toBe('');
    });
  }
}
