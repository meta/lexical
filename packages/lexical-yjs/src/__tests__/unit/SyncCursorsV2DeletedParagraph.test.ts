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
  $getAnchorAndFocusForUserState,
  createBindingV2__EXPERIMENTAL,
  createUndoManager,
  type Provider,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
  syncYjsChangesToLexicalV2__EXPERIMENTAL,
  syncYjsStateToLexicalV2__EXPERIMENTAL,
  type UserState,
} from '@lexical/yjs';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';
import {
  createRelativePositionFromTypeIndex,
  Doc,
  UndoManager,
  type XmlElement,
  type XmlText,
} from 'yjs';

const provider = {
  awareness: {
    getLocalState: () => null,
    getStates: () => new Map(),
    off: () => {},
    on: () => {},
    setLocalState: () => {},
    setLocalStateField: () => {},
  },
  connect: () => {},
  disconnect: () => {},
  off: () => {},
  on: () => {},
} as unknown as Provider;

// Regression test for https://github.com/facebook/lexical/issues/9929.
// With the v2 binding and an UndoManager, locally deleting a paragraph that
// holds a peer's caret left the paragraph's nested XmlText in
// binding.mapping, so resolving the peer's caret in syncCursorPositions
// threw "node does not exist in active editor state" (#113).
describe('collab-v2 peer caret in a locally deleted paragraph', () => {
  test('the caret is skipped and the deleted types leave the mapping', () => {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[v2-deleted-paragraph-caret]',
        onError: (error: Error) => {
          throw error;
        },
      }),
    );
    onTestFinished(() => editor.dispose());
    const doc = new Doc();
    onTestFinished(() => doc.destroy());
    const binding = createBindingV2__EXPERIMENTAL(
      editor,
      'main',
      doc,
      new Map([['main', doc]]),
    );
    (binding.root as XmlElement).observeDeep(((
      events: never,
      transaction: {origin: unknown},
    ) => {
      if (transaction.origin !== binding) {
        syncYjsChangesToLexicalV2__EXPERIMENTAL(
          binding,
          provider,
          events,
          transaction as never,
          transaction.origin instanceof UndoManager,
        );
      }
    }) as never);
    editor.registerUpdateListener(
      ({
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      }) => {
        syncLexicalUpdateToYjsV2__EXPERIMENTAL(
          binding,
          provider,
          prevEditorState,
          editorState,
          dirtyElements,
          dirtyLeaves,
          normalizedNodes,
          tags,
        );
      },
    );
    // As useYjsUndoManagerV2 does in @lexical/react. The UndoManager keeps
    // deleted items from being garbage-collected, so the peer's relative
    // position into deleted content still resolves to its deleted XmlText.
    createUndoManager(binding, binding.root);

    syncYjsStateToLexicalV2__EXPERIMENTAL(binding, provider);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('hello')),
            $createParagraphNode().append($createTextNode('world')),
          );
      },
      {discrete: true},
    );
    expect(binding.root.length).toBe(2);

    // A peer's caret inside "world", as it arrives over awareness.
    const worldText = (binding.root.get(1) as XmlElement).get(0) as XmlText;
    const peerCaret = createRelativePositionFromTypeIndex(worldText, 2);
    const peerState: UserState = {
      anchorPos: peerCaret,
      awarenessData: {},
      color: '#000000',
      focusPos: peerCaret,
      focusing: true,
      name: 'peer',
    };

    // While "world" is live, the caret resolves to its text node.
    const before = editor.read(() =>
      $getAnchorAndFocusForUserState(binding, peerState),
    );
    expect(before.anchorKey).not.toBe(null);
    expect(before.focusKey).not.toBe(null);

    // The local user deletes the "world" paragraph.
    editor.update(
      () => {
        $getRoot().getLastChildOrThrow().remove();
      },
      {discrete: true},
    );

    // The deleted paragraph's nested types must leave the mapping, as they
    // do for remote deletions in syncYjsChangesToLexicalV2__EXPERIMENTAL.
    expect(binding.mapping.has(worldText)).toBe(false);

    // Resolving the peer's caret (what syncCursorPositions does on every
    // awareness update) must skip it instead of throwing #113.
    const after = editor.read(() =>
      $getAnchorAndFocusForUserState(binding, peerState),
    );
    expect(after.anchorKey).toBe(null);
    expect(after.focusKey).toBe(null);
  });
});
