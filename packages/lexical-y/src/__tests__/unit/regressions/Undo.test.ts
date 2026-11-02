/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// ProdUndoNodeSelection (a production repro): undo puts back the range
// selection from before the step, but a step that started from a node
// selection (a selected image or chip) or a table selection comes back as a
// caret. HistoryExtension does the same (its snapshot holds the selection of
// the last content change). Open (#9572).

import {
  buildEditorFromExtensions,
  configExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $create,
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  DecoratorNode,
  defineExtension,
  type LexicalEditor,
  UNDO_COMMAND,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding, YCollabExtension} from '../../..';

class ChipNode extends DecoratorNode<null> {
  $config() {
    return this.config('prod-chip', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): false {
    return false;
  }
  isInline(): true {
    return true;
  }
  decorate(): null {
    return null;
  }
}

const NODES = [ChipNode];

function $build(): void {
  $getRoot()
    .clear()
    .append(
      $createParagraphNode().append(
        $createTextNode('before '),
        $create(ChipNode),
        $createTextNode(' after'),
      ),
    );
}

function seed(): Uint8Array {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension],
      name: 'prod-undo-node-seed',
      nodes: NODES,
    }),
  );
  editor.update($build, {discrete: true});
  const doc = createYDoc();
  doc.clientID = 7;
  const binding = new YBinding(editor, doc, {
    captureTimeout: null,
    schemaVersion: 1,
  });
  binding.start();
  binding.initialize();
  binding.dispose();
  return Y.encodeStateAsUpdate(doc);
}

function openY(state: Uint8Array): LexicalEditor {
  const doc = createYDoc();
  doc.clientID = 1;
  Y.applyUpdate(doc, state, 'load');
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        RichTextExtension,
        configExtension(YCollabExtension, {
          captureTimeout: 0,
          doc,
          schemaVersion: 1,
        }),
      ],
      name: 'prod-undo-node',
      nodes: NODES,
      onError: e => {
        throw e;
      },
    }),
  );
  getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output.binding.initialize();
  return editor;
}

function openHistory(): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        RichTextExtension,
        configExtension(HistoryExtension, {delay: 0}),
      ],
      name: 'prod-undo-node-history',
      nodes: NODES,
      onError: e => {
        throw e;
      },
    }),
  );
  editor.update($build, {discrete: true});
  return editor;
}

/** Select the chip as a node, then type over it (the fuzzer's step). */
function selectChipAndType(editor: LexicalEditor): void {
  editor.update(
    () => {
      const chip = $getRoot().getAllTextNodes()[0].getNextSibling() as ChipNode;
      const s = $createNodeSelection();
      s.add(chip.getKey());
      $setSelection(s);
    },
    {discrete: true},
  );
  editor.update(
    () => {
      // What typing on a selected chip does: the chip is replaced by the
      // typed text, with the caret after it.
      const s = $getSelection();
      if ($isNodeSelection(s)) {
        const text = $createTextNode('fuzz');
        s.getNodes()[0].replace(text);
        text.select(4, 4);
      }
    },
    {discrete: true},
  );
}

const shape = (editor: LexicalEditor) =>
  editor.read(() => {
    const s = $getSelection();
    return {
      selection: $isNodeSelection(s)
        ? `node:${s
            .getNodes()
            .map(n => n.getType())
            .join(',')}`
        : $isRangeSelection(s)
          ? `range:${s.anchor.offset}-${s.focus.offset}`
          : String(s),
      text: $getRoot().getTextContent(),
    };
  });

describe('ProdUndoNodeSelection: undo of a step that started from a node selection', () => {
  test('ProdUndoNodeSelection reference: HistoryExtension does not restore it either (a caret)', () => {
    const editor = openHistory();
    selectChipAndType(editor);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(shape(editor).selection).toMatch(/^range:/);
  });

  test.fails(
    'ProdUndoNodeSelection @lexical/y restores the node selection',
    () => {
      const editor = openY(seed());
      selectChipAndType(editor);
      const typed = shape(editor);
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      // The chip is back, but the selection is a caret.
      expect({
        typed: typed.text.includes('fuzz'),
        undone: shape(editor),
      }).toEqual({
        typed: true,
        undone: {selection: 'node:prod-chip', text: expect.any(String)},
      });
    },
  );
});
