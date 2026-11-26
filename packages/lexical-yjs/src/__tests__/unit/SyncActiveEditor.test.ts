/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A node's methods can depend on the editor, e.g. to read an extension's
// config (https://github.com/meta/lexical/issues/9934), so a local update is
// written to Yjs with that editor active (only the v2 binding calls the node
// methods, so the node tests below use v2; the awareness tests cover both).
// The awareness update for the local selection is made after that read, so
// an awareness listener that dispatches a command does not start an update
// inside a read-only context (a development warning).

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  createBinding,
  createBindingV2__EXPERIMENTAL,
  type Provider,
  syncLexicalUpdateToYjs,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
  syncYjsChangesToLexicalV2__EXPERIMENTAL,
} from '@lexical/yjs';
import {
  $create,
  $createParagraphNode,
  $getEditor,
  $getRoot,
  COMMAND_PRIORITY_CRITICAL,
  createCommand,
  type LexicalEditor,
  type SerializedTextNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test, vi} from 'vitest';
import * as Y from 'yjs';

class EditorReadingTextNode extends TextNode {
  $config() {
    return this.config('editor-reading-text', {extends: TextNode});
  }

  exportJSON(): SerializedTextNode {
    $getEditor();
    return super.exportJSON();
  }

  getTextContent(): string {
    $getEditor();
    return super.getTextContent();
  }
}

const provider = {
  awareness: {
    getLocalState: () => null,
    getStates: () => new Map(),
    off() {},
    on() {},
    setLocalState() {},
    setLocalStateField() {},
  },
  connect() {},
  disconnect() {},
  off() {},
  on() {},
} as unknown as Provider;

function createPeer(clientID: number) {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  const editor = buildEditorFromExtensions({
    name: 'peer' + clientID,
    nodes: [EditorReadingTextNode],
    onError: e => {
      throw e;
    },
  });
  onTestFinished(() => {
    editor.dispose();
    doc.destroy();
  });
  const docMap = new Map([['main', doc]]);
  const binding = createBindingV2__EXPERIMENTAL(editor, 'main', doc, docMap);
  binding.root.observeDeep((events, transaction) => {
    if (transaction.origin !== binding) {
      syncYjsChangesToLexicalV2__EXPERIMENTAL(
        binding,
        provider,
        events,
        transaction,
        false,
      );
    }
  });
  editor.registerUpdateListener(p =>
    syncLexicalUpdateToYjsV2__EXPERIMENTAL(
      binding,
      provider,
      p.prevEditorState,
      p.editorState,
      p.dirtyElements,
      p.dirtyLeaves,
      p.normalizedNodes,
      p.tags,
    ),
  );
  return {doc, editor};
}

describe('collab v2', () => {
  test('writes custom nodes with the active editor', () => {
    const a = createPeer(1);
    const b = createPeer(2);
    a.editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $create(EditorReadingTextNode).setTextContent('ab'),
            ),
          );
      },
      {discrete: true},
    );
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    expect(b.editor.read(() => $getRoot().getTextContent())).toBe('ab');
  });
});

const AWARENESS_COMMAND = createCommand<void>('AWARENESS_COMMAND');

/** A provider whose awareness listener dispatches a command to `editor`. */
function dispatchingProvider(getEditor: () => LexicalEditor) {
  let state: Record<string, unknown> | null = {
    anchorPos: null,
    awarenessData: {},
    color: 'red',
    focusPos: null,
    focusing: true,
    name: 'a',
  };
  return {
    awareness: {
      getLocalState: () => state,
      getStates: () => new Map(),
      off() {},
      on() {},
      setLocalState(next: Record<string, unknown> | null) {
        state = next;
        getEditor().dispatchCommand(AWARENESS_COMMAND, undefined);
      },
      setLocalStateField() {},
    },
    connect() {},
    disconnect() {},
    off() {},
    on() {},
  } as unknown as Provider;
}

/**
 * An editor whose local updates are synced to Yjs with `version`'s binding
 * and an awareness listener that dispatches a command.
 */
function awarenessEditor(version: 'v1' | 'v2') {
  const doc = new Y.Doc();
  const editor = buildEditorFromExtensions({
    name: 'awareness-' + version,
    onError: e => {
      throw e;
    },
  });
  onTestFinished(() => {
    editor.dispose();
    doc.destroy();
  });
  const counts = {dispatched: 0};
  editor.registerCommand(
    AWARENESS_COMMAND,
    () => {
      counts.dispatched++;
      return true;
    },
    COMMAND_PRIORITY_CRITICAL,
  );
  const awarenessProvider = dispatchingProvider(() => editor);
  const docMap = new Map([['main', doc]]);
  if (version === 'v1') {
    const binding = createBinding(
      editor,
      awarenessProvider,
      'main',
      doc,
      docMap,
    );
    editor.registerUpdateListener(p =>
      syncLexicalUpdateToYjs(
        binding,
        awarenessProvider,
        p.prevEditorState,
        p.editorState,
        p.dirtyElements,
        p.dirtyLeaves,
        p.normalizedNodes,
        p.tags,
      ),
    );
  } else {
    const binding = createBindingV2__EXPERIMENTAL(editor, 'main', doc, docMap);
    editor.registerUpdateListener(p =>
      syncLexicalUpdateToYjsV2__EXPERIMENTAL(
        binding,
        awarenessProvider,
        p.prevEditorState,
        p.editorState,
        p.dirtyElements,
        p.dirtyLeaves,
        p.normalizedNodes,
        p.tags,
      ),
    );
  }
  const warn = vi.spyOn(console, 'warn');
  onTestFinished(() => warn.mockRestore());
  return {counts, editor, warn};
}

describe('awareness listeners run after the read', () => {
  for (const version of ['v1', 'v2'] as const) {
    test(version, () => {
      const {counts, editor, warn} = awarenessEditor(version);
      editor.update(
        () => {
          const text = $create(TextNode).setTextContent('ab');
          $getRoot().clear().append($createParagraphNode().append(text));
          text.select(1, 1);
        },
        {discrete: true},
      );
      expect(counts.dispatched).toBeGreaterThan(0);
      expect(warn).not.toHaveBeenCalled();
    });
  }
});
