/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Several editors can share one Yjs `Doc` (the `rootName` / `getXmlText`
 * binding options), which puts every editor's tree in one document and one
 * awareness channel. A peer's awareness state can therefore describe a position
 * inside a *different* editor's subtree. V1 resolves such a position through
 * the collab node cached on the shared type (`sharedType._collabNode`), which
 * is owned by whichever binding materialized it, so without scoping the lookup
 * to the binding's own root a peer editing note B resolves to a `NodeKey` from
 * note B's editor -- a key that means something else entirely in note A's
 * editor, where the cursor would then be painted.
 */

import {
  $getAnchorAndFocusForUserState,
  type Binding,
  createYjsBinding,
  initLocalState,
  type Provider,
  type ProviderAwareness,
  syncLexicalUpdateToYjs,
  type UserState,
} from '@lexical/yjs';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  createEditor,
  type LexicalEditor,
  SKIP_COLLAB_TAG,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';
import * as Y from 'yjs';

interface TestEditor {
  binding: Binding;
  editor: LexicalEditor;
  provider: Provider;
}

let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.reverse()) {
    cleanup();
  }
  cleanups = [];
});

function createAwareness(doc: Y.Doc): ProviderAwareness {
  let localState: UserState | null = null;
  return {
    getLocalState: () => localState,
    getStates: () => {
      const states = new Map<number, UserState>();
      if (localState !== null) {
        states.set(doc.clientID, localState);
      }
      return states;
    },
    off: () => {},
    on: () => {},
    setLocalState: state => {
      localState = state;
    },
    setLocalStateField: (field, value) => {
      if (localState !== null) {
        localState = {...localState, [field]: value};
      }
    },
  };
}

/**
 * An editor bound to one named root of a shared `Doc`, wired to yjs the way
 * `CollaborationPlugin` wires it (minus the DOM and remote transport).
 */
function createTestEditor(
  doc: Y.Doc,
  docMap: Map<string, Y.Doc>,
  rootName: string,
): TestEditor {
  const provider = {
    awareness: createAwareness(doc),
    connect: () => {},
    disconnect: () => {},
    off: () => {},
    on: () => {},
  } as unknown as Provider;
  const editor = createEditor({
    namespace: rootName,
    onError: error => {
      throw error;
    },
  });
  const binding = createYjsBinding({
    doc,
    docMap,
    editor,
    id: rootName,
    rootName,
  });
  initLocalState(provider, rootName, '#000000', true, {});

  const removeUpdateListener = editor.registerUpdateListener(
    ({
      prevEditorState,
      editorState,
      dirtyElements,
      dirtyLeaves,
      normalizedNodes,
      tags,
    }) => {
      if (!tags.has(SKIP_COLLAB_TAG)) {
        syncLexicalUpdateToYjs(
          binding,
          provider,
          prevEditorState,
          editorState,
          dirtyElements,
          dirtyLeaves,
          normalizedNodes,
          tags,
        );
      }
    },
  );
  cleanups.push(removeUpdateListener);

  return {binding, editor, provider};
}

/** Write a paragraph and leave the caret at its end, publishing awareness. */
function typeAndSelect(client: TestEditor, text: string): void {
  client.editor.update(
    () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(text));
      $getRoot().clear().append(paragraph);
      paragraph.selectEnd();
    },
    {discrete: true},
  );
}

describe('cursor positions across editors sharing one Doc', () => {
  test("a peer editing another editor's root does not resolve in this editor", () => {
    const doc = new Y.Doc();
    const docMap = new Map<string, Y.Doc>([['note-a', doc]]);
    const noteA = createTestEditor(doc, docMap, 'note-a');
    const noteB = createTestEditor(doc, docMap, 'note-b');

    typeAndSelect(noteA, 'Note A content');
    typeAndSelect(noteB, 'Note B content');

    // note B's awareness state: a caret inside note B's subtree of the doc.
    const userState = noteB.provider.awareness.getLocalState();
    expect(userState).not.toBeNull();
    expect(userState!.anchorPos).not.toBeNull();
    expect(userState!.focusPos).not.toBeNull();

    // note A cannot place that caret: the position is outside its root.
    const inNoteA = noteA.editor.read('latest', () =>
      $getAnchorAndFocusForUserState(noteA.binding, userState!),
    );
    expect(inNoteA.anchorKey).toBeNull();
    expect(inNoteA.focusKey).toBeNull();

    // the editor the position belongs to still resolves it.
    const inNoteB = noteB.editor.read('latest', () =>
      $getAnchorAndFocusForUserState(noteB.binding, userState!),
    );
    expect(inNoteB.anchorKey).not.toBeNull();
    expect(
      noteB.editor.read('latest', () =>
        $getNodeByKey(inNoteB.anchorKey!)!.getTextContent(),
      ),
    ).toBe('Note B content');
  });

  test('a binding rebuilt over an already-materialized root still resolves', () => {
    const doc = new Y.Doc();
    const docMap = new Map<string, Y.Doc>([['note-a', doc]]);
    const noteA = createTestEditor(doc, docMap, 'note-a');
    typeAndSelect(noteA, 'Note A content');

    const userState = noteA.provider.awareness.getLocalState();
    expect(userState!.anchorPos).not.toBeNull();
    const beforeRebuild = noteA.editor.read('latest', () =>
      $getAnchorAndFocusForUserState(noteA.binding, userState!),
    );
    expect(beforeRebuild.anchorKey).not.toBeNull();

    // What remounting the collaboration plugin over the same document does: a
    // second binding on a root whose shared types already carry the collab
    // nodes of the first binding, which are reused as they are -- their
    // `_parent` chain still ends at the first binding's root.
    const rebuilt = createYjsBinding({
      doc,
      docMap,
      editor: noteA.editor,
      id: 'note-a',
      rootName: 'note-a',
    });

    const afterRebuild = noteA.editor.read('latest', () =>
      $getAnchorAndFocusForUserState(rebuilt, userState!),
    );
    expect(afterRebuild.anchorKey).toBe(beforeRebuild.anchorKey);
    expect(afterRebuild.anchorOffset).toBe(beforeRebuild.anchorOffset);
  });
});
