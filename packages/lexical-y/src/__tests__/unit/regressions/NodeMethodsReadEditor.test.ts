/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A node's methods can depend on the editor, e.g. to read an extension's
// config (https://github.com/meta/lexical/issues/9934), so the binding reads
// editor states with that editor active.

import {
  buildEditorFromExtensions,
  defineExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $getEditor,
  $getRoot,
  type SerializedTextNode,
  TextNode,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';

import {createYCollabConfig, createYDoc, YCollabExtension} from '../../..';

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

  isInline(): true {
    $getEditor();
    return true;
  }
}

function client(id: number, doc = createYDoc()) {
  doc.clientID = id;
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        createYCollabConfig({
          doc,
          layoutUpgrade: null,
          onYStatus: null,
          schemaVersion: 1,
          selfCheck: true,
          synced: true,
        }),
      ],
      name: '@lexical/y/test/active-editor',
      nodes: [EditorReadingTextNode],
      onError: e => {
        throw e;
      },
    }),
  );
  onTestFinished(() => {
    editor.dispose();
    doc.destroy();
  });
  const {binding} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  return {binding, doc, editor};
}

function $text(): EditorReadingTextNode {
  const node = $getRoot().getAllTextNodes()[0];
  assert(node instanceof EditorReadingTextNode);
  return node;
}

test('the binding writes custom nodes with the active editor', async () => {
  const a = client(1);
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
  a.binding.initialize();
  a.editor.update(() => $text().select(2, 2).insertText('c'), {
    discrete: true,
  });
  a.editor.update(() => $text().markDirty(), {discrete: true});

  const b = client(2);
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'net');
  b.binding.initialize();
  // The binding reads a remote change in a later task.
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(b.editor.read(() => $getRoot().getTextContent())).toBe('abc');
});
