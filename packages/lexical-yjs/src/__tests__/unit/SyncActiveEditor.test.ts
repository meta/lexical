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
// written to Yjs with that editor active. Only the v2 binding calls them.

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  createBindingV2__EXPERIMENTAL,
  type Provider,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
  syncYjsChangesToLexicalV2__EXPERIMENTAL,
} from '@lexical/yjs';
import {
  $create,
  $createParagraphNode,
  $getEditor,
  $getRoot,
  type SerializedTextNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';
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
