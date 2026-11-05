/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Binding lifecycle edges from the automated code review of #9766:
//
// - quiesce() after dispose() must leave the editor as dispose() gave it
//   back (editable): a binding started later on the same editor records the
//   editor's editability when it starts, and would stay non-editable while
//   active.

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding} from '../../..';
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
});
