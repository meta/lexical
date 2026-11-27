/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Contract C1 for derived element fields across reconciles: an element's
// `textFormat` and `textStyle` (derived from its first text when it
// renders) do not depend on how the editor got to its state. After any read
// and after a full reconcile (`$fullReconcile`, which re-renders without
// changing anything, as toggling editable or a mark filter does), the
// editor still equals what a fresh editor loading the same state shows, and
// a full reconcile writes nothing to the document. For every node shape,
// bound (every bind mode, rendered in jsdom) and unbound (an app loading the
// JSON a headless writer stored).

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $fullReconcile,
  type LexicalEditor,
  type SerializedEditorState,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {
  bindFresh,
  type BindMode,
  type BoundEditor,
  catalogAppExtension,
  DEFAULT_CONFIG,
  firstDifference,
  freshSnapshot,
  NODE_SHAPES,
  type NodeShape,
  seedShapes,
} from '../../catalog';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    c();
  }
});

const elide = (json: SerializedEditorState) =>
  JSON.parse(JSON.stringify(json), (key, value) =>
    key === 'editorState' && value !== null && typeof value === 'object'
      ? '(nested editor)'
      : value,
  );

function fullReconcile(editor: LexicalEditor): void {
  editor.update(() => $fullReconcile(), {discrete: true});
}

const config = {...DEFAULT_CONFIG, dom: 'jsdom' as const};

async function bound(shape: NodeShape, mode: BindMode): Promise<string[]> {
  const out: string[] = [];
  const seed = seedShapes([shape], config);
  const b: BoundEditor = bindFresh(seed, config, mode);
  cleanups.push(() => b.dispose());
  await new Promise(resolve => setTimeout(resolve, 0));
  const check = (when: string) => {
    const fresh = freshSnapshot(Y.encodeStateAsUpdate(b.doc), config).json;
    const shown = b.editor.getEditorState().toJSON();
    const d = firstDifference(elide(shown), elide(fresh));
    if (d !== null) {
      out.push(`${when}: differs from a fresh readYState at ${d}`);
    }
  };
  check('after the read');
  const vector = Y.encodeStateVector(b.doc);
  const before = elide(b.editor.getEditorState().toJSON());
  fullReconcile(b.editor);
  await new Promise(resolve => setTimeout(resolve, 0));
  const d = firstDifference(elide(b.editor.getEditorState().toJSON()), before);
  if (d !== null) {
    out.push(`a full reconcile changed the editor at ${d}`);
  }
  if (
    JSON.stringify(Array.from(Y.encodeStateVector(b.doc))) !==
    JSON.stringify(Array.from(vector))
  ) {
    out.push('a full reconcile wrote to the document');
  }
  check('after a full reconcile');
  b.editor.setEditable(false);
  b.editor.setEditable(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  check('after toggling editable');
  out.push(...b.errors.map(e => `error: ${String(e)}`));
  return out;
}

function unbound(shape: NodeShape): string[] {
  const out: string[] = [];
  // What a writer that never rendered stores for the shape: every element's
  // textFormat 0 and textStyle '' (Lexical derives them only when it
  // renders).
  const stored = JSON.parse(
    JSON.stringify(freshSnapshot(seedShapes([shape], config), config).json),
    (key, value) =>
      key === 'textFormat' ? 0 : key === 'textStyle' ? '' : value,
  ) as SerializedEditorState;
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(config)],
      name: 'c1-reconcile-plain',
      onError: e => {
        throw e;
      },
    }),
  );
  cleanups.push(() => editor.dispose());
  const root = document.createElement('div');
  document.body.append(root);
  cleanups.push(() => root.remove());
  editor.setRootElement(root);
  editor.setEditorState(editor.parseEditorState(stored));
  const loaded = elide(editor.getEditorState().toJSON());
  const d0 = firstDifference(loaded, elide(stored));
  if (d0 !== null) {
    out.push(`loading changed the state at ${d0}`);
  }
  fullReconcile(editor);
  const d1 = firstDifference(elide(editor.getEditorState().toJSON()), loaded);
  if (d1 !== null) {
    out.push(`a full reconcile changed the editor at ${d1}`);
  }
  // A fresh editor loading the same state, never rendered.
  const plain = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(config)],
      name: 'c1-reconcile-fresh',
      onError: e => {
        throw e;
      },
    }),
  );
  cleanups.push(() => plain.dispose());
  plain.setEditorState(plain.parseEditorState(stored));
  const d2 = firstDifference(
    elide(editor.getEditorState().toJSON()),
    elide(plain.getEditorState().toJSON()),
  );
  if (d2 !== null) {
    out.push(`differs from a fresh editor loading the same state at ${d2}`);
  }
  return out;
}

describe('C1: derived element fields do not depend on reconcile history', () => {
  for (const shape of NODE_SHAPES) {
    // A paragraph loaded into a mounted editor derives its textFormat and
    // textStyle from its first text when it renders, so it differs from the
    // same state loaded without rendering (#9568, open).
    (shape.name === 'paragraph/formatted-first-text' ? test.fails : test)(
      `unbound: ${shape.name}`,
      () => {
        expect(unbound(shape)).toEqual([]);
      },
    );
    for (const mode of ['binding', 'extension'] as const) {
      // A full reconcile keeps the textFormat and textStyle of elements the
      // update did not change, so the binding writes nothing for them.
      test(`${mode}: ${shape.name}`, async () => {
        expect(await bound(shape, mode)).toEqual([]);
      });
    }
  }
});
