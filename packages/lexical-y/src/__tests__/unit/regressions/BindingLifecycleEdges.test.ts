/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Two binding lifecycle edges from the automated code review of #9766:
//
// - quiesce() after dispose() must leave the editor as dispose() gave it
//   back (editable): a binding started later on the same editor records the
//   editor's editability when it starts, and would stay non-editable while
//   active.
// - A root holding only a well-formed epoch (no layout record, no content)
//   is not pristine, so initialize() seeds nothing: the binding reports it
//   missing and is read only, instead of staying pending without a word
//   (as the runner, 'missing', and describeYRoom, unreadable, see it).

import {buildEditorFromExtensions} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, UNSUPPORTED_LAYOUT_WARNING, YBinding} from '../../..';
import {catalogAppExtension} from '../../catalog/bind';
import {rawDoc, SEED} from '../../utils/migrateSteps';
import {textOf} from '../../utils/splitFixtures';

const CFG = {blockIds: 'absent'} as const;
type Warning = {code?: string; data?: Record<string, unknown>};

function editorOf(warnings: Warning[]) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(CFG)],
      name: 'lifecycle-edges',
      onError: e => {
        throw e;
      },
      onWarn: w => {
        warnings.push(w as Warning);
      },
    }),
  );
}

describe.each([false, true])('binding lifecycle edges, gc %s', gc => {
  test('quiesce() after dispose(): a new binding on the same editor is active and the editor editable', () => {
    const warnings: Warning[] = [];
    const editor = editorOf(warnings);
    const doc = createYDoc(rawDoc(SEED), {gc});
    const first = new YBinding(editor, doc, {schemaVersion: 1});
    first.start();
    first.initialize();
    expect(first.status).toBe('active');
    first.dispose();
    expect(editor.isEditable()).toBe(true);
    first.quiesce();
    expect(editor.isEditable()).toBe(true);
    const second = new YBinding(editor, doc, {schemaVersion: 1});
    second.start();
    second.initialize();
    expect(second.status).toBe('active');
    expect(editor.isEditable()).toBe(true);
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('again')),
        );
      },
      {discrete: true},
    );
    expect(textOf(doc.get('lexical-y'))).toContain('again');
    expect(warnings).toEqual([]);
    second.dispose();
    editor.dispose();
    doc.destroy();
  });

  test('a root holding only a well-formed epoch: missing, read only, nothing seeded', () => {
    const d = createYDoc(null, {gc});
    d.get('lexical-y').setAttr('lexical-y-epoch', {
      client: 7,
      clock: 0,
      kind: 'layout',
      layout: 2,
      revision: 1,
      step: 'lexical-y/layout/1to2',
      v: 1,
    } as never);
    const state = Y.encodeStateAsUpdate(d);
    d.destroy();
    const warnings: Warning[] = [];
    const editor = editorOf(warnings);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('seed')));
      },
      {discrete: true},
    );
    const doc = createYDoc(state, {gc});
    const binding = new YBinding(editor, doc, {schemaVersion: 1});
    binding.start();
    binding.initialize();
    expect(binding.status).toBe('readonly');
    expect(
      warnings
        .filter(w => w.code === UNSUPPORTED_LAYOUT_WARNING)
        .map(w => w.data),
    ).toEqual([{reason: 'missing', supported: expect.any(Number)}]);
    // Nothing was seeded or written.
    expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(Buffer.from(state));
    binding.dispose();
    editor.dispose();
    doc.destroy();
  });
});
