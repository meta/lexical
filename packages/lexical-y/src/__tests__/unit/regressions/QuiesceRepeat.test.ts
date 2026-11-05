/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// quiesce() called again returns the first call's result: the same state and
// the same draft, `differs` included. When the first call refused the
// editor's batched update (the binding was already read only, or the record
// stopped admitting writes during the call), that update is the draft with
// `differs: true`, and the refusal reads the document back into the editor:
// a draft rebuilt from the editor would lose the text, so a retried handoff
// would lose what the user typed and was never written.

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

import {
  createYDoc,
  LAYOUT_VERSION,
  YBinding,
  type YQuiescedState,
} from '../../..';
import {catalogAppExtension} from '../../catalog/bind';
import {rawDoc, SEED} from '../../utils/migrateSteps';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(gc: boolean) {
  const doc = createYDoc(rawDoc(SEED), {gc});
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension({blockIds: 'absent'})],
      name: 'quiesce-repeat',
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

const $text = () =>
  (
    $getRoot().getFirstChildOrThrow() as ElementNode
  ).getFirstChildOrThrow() as TextNode;

/** A composition (committed). */
async function compose(t: ReturnType<typeof setup>) {
  t.editor.update(() => $setCompositionKey($text().getKey()), {
    discrete: true,
  });
  await flush();
}

/**
 * A batched update typed in it: it commits in a microtask, so it is still
 * pending at a quiesce() called synchronously after it.
 */
function batched(t: ReturnType<typeof setup>) {
  t.editor.update(() => $text().setTextContent('abcIME'), {
    skipTransforms: true,
  });
  expect(t.editor._pendingEditorState).not.toBeNull();
}

const newer = (doc: Y.Doc) =>
  doc.get('lexical-y').setAttr(`lexical-y:${LAYOUT_VERSION + 1}`, true);

function expectSame(again: YQuiescedState, first: YQuiescedState) {
  expect(again.draft.differs).toBe(true);
  expect(JSON.stringify(again.draft.json)).toContain('abcIME');
  expect(again.draft.json).toEqual(first.draft.json);
  expect(Buffer.from(again.state)).toEqual(Buffer.from(first.state));
}

const TRIGGERS = [
  'already-read-only',
  'app-transaction',
  'beforeTransaction',
] as const;

describe.each([false, true])(
  'quiesce() again keeps the first draft, gc %s',
  gc => {
    test.each(TRIGGERS)(
      'the first call refused the batched update (%s): a second call, and one after dispose, return the same draft with differs',
      async trigger => {
        const t = setup(gc);
        await compose(t);
        let first: YQuiescedState | null = null;
        if (trigger === 'already-read-only') {
          newer(t.doc);
          await flush();
          expect(t.binding.status).toBe('readonly');
          batched(t);
          first = t.binding.quiesce();
        } else if (trigger === 'app-transaction') {
          batched(t);
          t.doc.transact(() => {
            newer(t.doc);
            expect(t.binding.status).toBe('active');
            first = t.binding.quiesce();
          }, 'app');
        } else {
          batched(t);
          let once = false;
          t.doc.on('beforeTransaction', () => {
            if (!once) {
              once = true;
              newer(t.doc);
            }
          });
          first = t.binding.quiesce();
        }
        const firstState = first! as YQuiescedState;
        expect(firstState.draft.differs).toBe(true);
        expect(JSON.stringify(firstState.draft.json)).toContain('abcIME');
        expect(t.doc.get('lexical-y').toString()).not.toContain('IME');
        await flush();
        // The refusal read the document back: the editor no longer shows it.
        expect(
          t.editor.getEditorState().read(() => $getRoot().getTextContent()),
        ).not.toContain('IME');
        // What the first call returned, before it is changed below.
        const saved: YQuiescedState = {
          draft: {
            differs: firstState.draft.differs,
            json: JSON.parse(JSON.stringify(firstState.draft.json)),
          },
          state: firstState.state.slice(),
        };
        // Changing the first result changes no later one (the binding kept
        // its own copy).
        firstState.state.fill(0);
        (firstState.draft.json.root as {children: unknown[]}).children.length =
          0;
        // Another replica's update after the first call: the kept state is
        // frozen, so a later call's state bytes are the first call's.
        const peer = createYDoc(saved.state, {gc});
        peer.get('app-data').setAttr('later', true);
        Y.applyUpdate(t.doc, Y.encodeStateAsUpdate(peer), 'remote-provider');
        peer.destroy();
        expect(Buffer.from(Y.encodeStateAsUpdate(t.doc))).not.toEqual(
          Buffer.from(saved.state),
        );
        const second = t.binding.quiesce();
        expectSame(second, saved);
        expect(Buffer.from(second.state)).toEqual(Buffer.from(saved.state));
        // A copy: changing what one call returned changes no later result.
        second.state.fill(0);
        (second.draft.json.root as {children: unknown[]}).children.length = 0;
        expectSame(t.binding.quiesce(), saved);
        t.binding.dispose();
        expectSame(t.binding.quiesce(), saved);
        t.dispose();
      },
    );
  },
);
