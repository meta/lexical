/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// quiesce() on a binding that is already read only (code review round 1,
// M1): the editor's uncommitted update (text typed during an IME
// composition, batched) is taken into the draft, with `differs`, before
// the binding refuses it; the composition ends; the document is not
// written.

import {buildEditorFromExtensions} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $getRoot,
  $setCompositionKey,
  defineExtension,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, LAYOUT_VERSION, YBinding} from '../../..';
import {catalogAppExtension} from '../../catalog/bind';
import {rawDoc, SEED} from '../../utils/migrateSteps';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(gc: boolean) {
  const doc = createYDoc(rawDoc(SEED), {gc});
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension({blockIds: 'absent'})],
      name: 'quiesce-draft',
      onError: e => {
        throw e;
      },
      onWarn: () => {},
    }),
  );
  const binding = new YBinding(editor, doc, {schemaVersion: 1});
  binding.start();
  binding.initialize();
  const element = document.createElement('div');
  document.body.append(element);
  editor.setRootElement(element);
  const dispose = () => {
    editor.setRootElement(null);
    binding.dispose();
    editor.dispose();
    element.remove();
    doc.destroy();
  };
  return {binding, dispose, doc, editor};
}

const $textKey = () =>
  ($getRoot().getFirstChildOrThrow() as ElementNode)
    .getFirstChildOrThrow()
    .getKey();

describe.each([false, true])('quiesce on a read-only binding, gc %s', gc => {
  test('a batched update inside a composition, after the record turned newer: in the draft, differs, composition ended, nothing written', async () => {
    const t = setup(gc);
    expect(t.binding.status).toBe('active');
    t.editor.update(() => $setCompositionKey($textKey()), {discrete: true});
    t.doc.get('lexical-y').setAttr(`lexical-y:${LAYOUT_VERSION + 1}`, true);
    await flush();
    expect(t.binding.status).toBe('readonly');
    // Batched (commits in a microtask): still pending when quiesce() runs.
    t.editor.update(
      () => {
        (
          (
            $getRoot().getFirstChildOrThrow() as ElementNode
          ).getFirstChildOrThrow() as TextNode
        ).setTextContent('abcIME');
      },
      {skipTransforms: true},
    );
    expect(t.editor._pendingEditorState).not.toBeNull();
    const before = Y.encodeStateAsUpdate(t.doc);
    const {state, draft} = t.binding.quiesce();
    expect(JSON.stringify(draft.json)).toContain('abcIME');
    expect(draft.differs).toBe(true);
    expect(t.editor._compositionKey).toBeNull();
    expect(t.editor._pendingEditorState).toBeNull();
    // No Yjs write: the state is the document's, unchanged.
    expect(state).toEqual(before);
    expect(Y.encodeStateAsUpdate(t.doc)).toEqual(before);
    await flush();
    expect(Y.encodeStateAsUpdate(t.doc)).toEqual(before);
    expect(t.binding.status).toBe('readonly');
    t.dispose();
  });

  test('a read-only binding with nothing pending: the draft is the editor state, differs false', async () => {
    const t = setup(gc);
    t.doc.get('lexical-y').setAttr(`lexical-y:${LAYOUT_VERSION + 1}`, true);
    await flush();
    expect(t.binding.status).toBe('readonly');
    const {draft} = t.binding.quiesce();
    expect(draft.differs).toBe(false);
    expect(JSON.stringify(draft.json)).toContain('abc');
    t.dispose();
  });

  test('control: an active binding writes the batched update, and the draft does not differ', async () => {
    const t = setup(gc);
    t.editor.update(() => $setCompositionKey($textKey()), {discrete: true});
    t.editor.update(
      () => {
        (
          (
            $getRoot().getFirstChildOrThrow() as ElementNode
          ).getFirstChildOrThrow() as TextNode
        ).setTextContent('abcIME');
      },
      {skipTransforms: true},
    );
    const {state, draft} = t.binding.quiesce();
    expect(draft.differs).toBe(false);
    expect(t.editor._compositionKey).toBeNull();
    const out = createYDoc(state, {gc});
    expect(out.get('lexical-y').toString()).toContain('abcIME');
    out.destroy();
    t.dispose();
  });
});
