/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getClipboardDataFromSelection,
  setLexicalClipboardDataTransfer,
} from '@lexical/clipboard';
import {buildEditorFromExtensions} from '@lexical/extension';
import {createEmptyHistoryState, HistoryExtension} from '@lexical/history';
import {RichTextExtension} from '@lexical/rich-text';
import {$dfsWithSlots} from '@lexical/utils';
import {
  $copyNode,
  $create,
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  $getSlot,
  $getState,
  $isElementNode,
  $isRootNode,
  $isTextNode,
  $setSelection,
  $setSlot,
  $setState,
  configExtension,
  COPY_COMMAND,
  createState,
  CUT_COMMAND,
  defineExtension,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
  PASTE_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {
  externalIdState as externalId,
  loadApplicationDocument,
  registerApplicationIdentity,
} from '../../identity';

const color = createState('color', {
  parse: value => (typeof value === 'string' ? value : ''),
});

// Custom nodes use only their standard Lexical topology. The application
// identity policy knows neither this class nor its slot names.
class IdentityCard extends ElementNode {
  $config() {
    return this.config('identity-card', {
      extends: ElementNode,
      stateConfigs: [{flat: true, stateConfig: externalId}],
    });
  }
  createDOM(): HTMLElement {
    return $getDocument().createElement('section');
  }
  updateDOM(): boolean {
    return false;
  }
  isShadowRoot(): boolean {
    return true;
  }
}

class IdentitySlot extends ElementNode {
  $config() {
    return this.config('identity-slot', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return $getDocument().createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isShadowRoot(): boolean {
    return true;
  }
}

function makeApp(prefix: string, enabled = true) {
  const history = createEmptyHistoryState();
  const allocations: string[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        configExtension(HistoryExtension, {
          createInitialHistoryState: () => history,
          delay: 1000,
          now: () => 0,
        }),
      ],
      name: '[identity-example-test]',
      namespace: 'identity-example-test',
      nodes: [IdentityCard, IdentitySlot],
      register: currentEditor =>
        enabled
          ? registerApplicationIdentity(currentEditor, () => {
              const id = `${prefix}_${allocations.length + 1}`;
              allocations.push(id);
              return id;
            })
          : () => {},
    }),
  );
  editor.setRootElement(document.createElement('div'));
  return {allocations, editor, history};
}

function $seed(): void {
  const paragraph = $createParagraphNode().append($createTextNode('hello'));
  $getRoot().append(paragraph);
  $setState(paragraph, externalId, 'para_A');
  for (const {node} of $dfsWithSlots(paragraph)) {
    $setState(node, color, 'red');
  }
}

function $selectNode(node: LexicalNode): void {
  const selection = $createNodeSelection();
  selection.add(node.getKey());
  $setSelection(selection);
}

function snapshot(editor: LexicalEditor) {
  return editor.read(() =>
    $dfsWithSlots($getRoot())
      .filter(({node}) => !$isRootNode(node))
      .map(({node}) => ({
        color: $getState(node, color),
        id: $getState(node, externalId),
        type: node.getType(),
      })),
  );
}

function copyData(editor: LexicalEditor): DataTransfer {
  const data = new DataTransfer();
  editor.read(() =>
    setLexicalClipboardDataTransfer(data, $getClipboardDataFromSelection()),
  );
  return data;
}

function selectFirst(editor: LexicalEditor): void {
  editor.update(() => $selectNode($getRoot().getFirstChildOrThrow()), {
    discrete: true,
  });
}

function paste(editor: LexicalEditor, data: DataTransfer): void {
  editor.update(
    () => {
      const blank = $createParagraphNode();
      $getRoot().append(blank);
      blank.select();
      editor.dispatchCommand(
        PASTE_COMMAND,
        new ClipboardEvent('paste', {cancelable: true, clipboardData: data}),
      );
    },
    {discrete: true},
  );
}

function expectUnique(editor: LexicalEditor): void {
  const nodes = snapshot(editor);
  for (const node of nodes) {
    expect(Boolean(node.id)).toBe(node.type !== 'text');
  }
  const ids = nodes.map(node => node.id).filter(Boolean);
  expect(new Set(ids).size).toBe(ids.length);
}

describe('Application identity example', () => {
  test('creation, normal edits, persistence, and direct copy lifecycle', () => {
    const app = makeApp('created');
    using editor = app.editor;
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('new')),
        );
      },
      {discrete: true},
    );
    const initial = snapshot(editor);
    expect(initial.map(node => node.id)).toEqual(['created_1', '']);
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isElementNode(paragraph));
        paragraph.setIndent(1);
      },
      {discrete: true},
    );
    expect(snapshot(editor)).toEqual(initial);
    const saved = JSON.stringify(editor.getEditorState());
    const reload = makeApp('reload');
    using loaded = reload.editor;
    loadApplicationDocument(loaded, saved);
    expect(snapshot(loaded).map(node => node.id)).toEqual(
      initial.map(node => node.id),
    );
    expect(reload.allocations).toHaveLength(0);
    loaded.update(
      () => {
        const original = $getRoot().getFirstChildOrThrow();
        const copy = $copyNode(original);
        expect($getState(copy, externalId)).toBe('');
        $getRoot().append(copy);
      },
      {discrete: true},
    );
    expect(snapshot(loaded).map(node => node.id)).toEqual([
      'created_1',
      '',
      'reload_1',
    ]);
  });

  test('application load registers ad hoc config before an immediate unobserved direct copy', () => {
    const a = makeApp('source', false);
    const b = makeApp('loaded');
    using source = a.editor;
    using target = b.editor;
    source.update($seed, {discrete: true});
    loadApplicationDocument(target, JSON.stringify(source.getEditorState()));
    target.update(
      () => {
        const copy = $copyNode($getRoot().getFirstChildOrThrow());
        expect($getState(copy, externalId)).toBe('');
        $getRoot().append(copy);
      },
      {discrete: true},
    );
    expect(snapshot(target).map(node => node.id)).toEqual([
      'para_A',
      '',
      'loaded_1',
    ]);
  });

  test('same-editor repeated paste replaces inherited IDs and preserves ordinary state', () => {
    const app = makeApp('paste');
    using editor = app.editor;
    editor.update($seed, {discrete: true});
    selectFirst(editor);
    const data = copyData(editor);
    const before = snapshot(editor);
    paste(editor, data);
    paste(editor, data);
    expectUnique(editor);
    const after = snapshot(editor);
    expect(after.slice(0, 2)).toEqual(before);
    expect(after.slice(2).map(node => node.id)).toEqual([
      'paste_1',
      '',
      'paste_2',
      '',
    ]);
    expect(after.every(node => node.color === 'red')).toBe(true);
  });

  test('custom registered flat state and nested slots need no application recursion or class knowledge', () => {
    const a = makeApp('source');
    const b = makeApp('slotcopy');
    using source = a.editor;
    using target = b.editor;
    source.update(
      () => {
        const card = $create(IdentityCard).append(
          $createParagraphNode().append($createTextNode('body')),
        );
        const slot = $create(IdentitySlot).append(
          $createParagraphNode().append($createTextNode('title')),
        );
        $getRoot().append(card);
        $setSlot(card, 'title', slot);
        for (const {node} of $dfsWithSlots(card)) {
          $setState(node, color, 'red');
        }
        $selectNode(card);
      },
      {discrete: true},
    );
    const original = snapshot(source);
    expect(original).toHaveLength(6);
    const data = copyData(source);
    const json = JSON.parse(data.getData('application/x-lexical-editor'));
    expect(json.nodes[0].externalId).toBe(original[0].id);
    paste(target, data);
    const copied = snapshot(target).filter(
      node => node.type !== 'paragraph' || node.color === 'red',
    );
    expect(copied).toHaveLength(6);
    expect(copied.every(node => node.color === 'red')).toBe(true);
    expect(
      copied
        .filter(node => node.id)
        .every(node => !original.some(old => old.id === node.id)),
    ).toBe(true);
    expectUnique(target);
    target.read(() => {
      const card = $getRoot()
        .getChildren()
        .find(node => node instanceof IdentityCard);
      assert(card);
      expect($getSlot(card, 'title')).toBeInstanceOf(IdentitySlot);
    });
  });

  test('paste adds one update/history entry and undo/redo restores IDs without allocation', () => {
    const app = makeApp('history');
    using editor = app.editor;
    editor.update($seed, {discrete: true});
    selectFirst(editor);
    const data = copyData(editor);
    const before = snapshot(editor);
    const historyBefore = app.history.undoStack.length;
    let updates = 0;
    const unregister = editor.registerUpdateListener(() => {
      updates++;
    });
    paste(editor, data);
    expect(updates).toBe(1);
    unregister();
    expect(app.history.undoStack.length).toBe(historyBefore + 1);
    const pasted = snapshot(editor);
    const allocationCount = app.allocations.length;
    editor.dispatchCommand(UNDO_COMMAND);
    expect(snapshot(editor)).toEqual(before);
    editor.dispatchCommand(REDO_COMMAND);
    expect(snapshot(editor)).toEqual(pasted);
    expect(app.allocations).toHaveLength(allocationCount);
    expectUnique(editor);
  });

  test('real copy and cut commands share ID payloads; cut/paste uses fresh identity policy', async () => {
    const app = makeApp('cut');
    using editor = app.editor;
    editor.update($seed, {discrete: true});
    selectFirst(editor);
    const copied = new DataTransfer();
    editor.dispatchCommand(
      COPY_COMMAND,
      new ClipboardEvent('copy', {cancelable: true, clipboardData: copied}),
    );
    editor.read(() => {});
    const cut = new DataTransfer();
    editor.dispatchCommand(
      CUT_COMMAND,
      new ClipboardEvent('cut', {cancelable: true, clipboardData: cut}),
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(copied.getData('application/x-lexical-editor')).not.toBe('');
    expect(cut.getData('application/x-lexical-editor')).toBe(
      copied.getData('application/x-lexical-editor'),
    );
    expect(snapshot(editor).some(node => node.id === 'para_A')).toBe(false);
    paste(editor, cut);
    expect(snapshot(editor).some(node => node.id === 'para_A')).toBe(false);
    expectUnique(editor);
    const afterPaste = snapshot(editor);
    const allocationCount = app.allocations.length;
    editor.dispatchCommand(UNDO_COMMAND);
    editor.read(() => {});
    editor.dispatchCommand(UNDO_COMMAND);
    expect(snapshot(editor).map(node => node.id)).toEqual(['para_A', '']);
    editor.dispatchCommand(REDO_COMMAND);
    editor.read(() => {});
    editor.dispatchCommand(REDO_COMMAND);
    expect(snapshot(editor)).toEqual(afterPaste);
    expect(app.allocations).toHaveLength(allocationCount);
  });

  test('receiver clears ineligible text IDs but preserves unknown unrelated metadata', () => {
    const a = makeApp('source', false);
    const b = makeApp('target');
    using source = a.editor;
    using target = b.editor;
    source.update($seed, {discrete: true});
    selectFirst(source);
    const data = copyData(source);
    const payload = JSON.parse(data.getData('application/x-lexical-editor'));
    payload.nodes[0].$.thirdPartyExternalId = 'foreign_A';
    payload.nodes[0].children[0].$.externalId = 'foreign_text_A';
    data.setData('application/x-lexical-editor', JSON.stringify(payload));
    paste(target, data);
    target.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      expect(paragraph.exportJSON().$).toMatchObject({
        thirdPartyExternalId: 'foreign_A',
      });
      expect($getState(paragraph, externalId)).toBe('target_1');
    });
    expectUnique(target);
  });

  test.each([false, true])(
    'text normalization with pre-existing text IDs: %s',
    textIds => {
      const app = makeApp('structural');
      using editor = app.editor;
      editor.update(
        () => {
          const left = $createTextNode('left').toggleFormat('bold');
          const right = $createTextNode('right');
          if (textIds) {
            $setState(left, externalId, 'left_id');
            $setState(right, externalId, 'right_id');
          }
          $getRoot().append($createParagraphNode().append(left, right));
        },
        {discrete: true},
      );
      // Save/load preserves existing state; changing eligibility is not migration.
      loadApplicationDocument(editor, JSON.stringify(editor.getEditorState()));
      editor.update(
        () => {
          const paragraph = $getRoot().getFirstChildOrThrow();
          assert($isElementNode(paragraph));
          const left = paragraph.getFirstChildOrThrow();
          assert($isTextNode(left));
          left.toggleFormat('bold');
        },
        {discrete: true},
      );
      editor.read(() => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isElementNode(paragraph));
        expect(paragraph.getTextContent()).toBe('leftright');
        expect(
          paragraph.getChildren().map(node => $getState(node, externalId)),
        ).toEqual(textIds ? ['left_id', 'right_id'] : ['']);
        expect($getState(paragraph, externalId)).toBe('structural_1');
      });
      expect(app.allocations).toEqual(['structural_1']);
    },
  );

  test('text-only paste merges normally and preserves the destination paragraph ID', () => {
    const app = makeApp('partial');
    using editor = app.editor;
    editor.update(
      () => {
        $seed();
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isElementNode(paragraph));
        const text = paragraph.getFirstChildOrThrow();
        assert($isTextNode(text));
        text.select(0, 5);
      },
      {discrete: true},
    );
    const data = copyData(editor);
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        assert($isElementNode(paragraph));
        paragraph.selectEnd();
        editor.dispatchCommand(
          PASTE_COMMAND,
          new ClipboardEvent('paste', {
            cancelable: true,
            clipboardData: data,
          }),
        );
      },
      {discrete: true},
    );
    expect(snapshot(editor).map(node => node.id)).toEqual(['para_A', '']);
    expect(editor.read(() => $getRoot().getTextContent())).toBe('hellohello');
    expect(app.allocations).toEqual([]);
  });
});
