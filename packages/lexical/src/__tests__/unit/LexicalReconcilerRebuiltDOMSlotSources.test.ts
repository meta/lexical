/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSlot,
  $setSlot,
  type LexicalEditor,
  mountSlotContainer,
  type NodeMutation,
  ParagraphNode,
  TextNode,
} from 'lexical';
import {
  $createTestDecoratorNode,
  $createTestElementNode,
  $createTestUpdateDOMTrueHostNode,
  TestDecoratorNode,
  TestElementNode,
  TestUpdateDOMTrueHostNode,
} from 'lexical/src/__tests__/utils';
import {afterEach, expect, test} from 'vitest';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function setup() {
  const editor = buildEditorFromExtensions({
    name: 'lexical-reconciler-rebuilt-dom-slot-sources',
    nodes: [TestElementNode, TestUpdateDOMTrueHostNode, TestDecoratorNode],
    onError: (error: Error) => {
      throw error;
    },
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  editor.setRootElement(root);
  cleanups.push(() => {
    editor.dispose();
    root.remove();
  });
  let mutations = new Map<string, NodeMutation>();
  for (const klass of [
    TestElementNode,
    TestUpdateDOMTrueHostNode,
    TestDecoratorNode,
    ParagraphNode,
    TextNode,
  ]) {
    editor.registerMutationListener(
      klass,
      changes => {
        for (const [key, mutation] of changes) {
          expect(mutations.has(key)).toBe(false);
          mutations.set(key, mutation);
        }
      },
      {skipInitialization: true},
    );
  }
  const update = (fn: () => void) => {
    mutations = new Map();
    editor.update(fn, {discrete: true});
    return mutations;
  };
  return {editor, root, update};
}

function $paragraph(text: string) {
  return $createParagraphNode().append($createTextNode(text));
}

function freshHTML(editor: LexicalEditor) {
  const fresh = setup();
  fresh.editor.setEditorState(editor.getEditorState().clone(null));
  return fresh.root.innerHTML;
}

function checkMap(editor: LexicalEditor, root: HTMLElement) {
  expect
    .soft([...editor._keyToDOMMap.keys()].sort())
    .toEqual([...editor.getEditorState()._nodeMap.keys()].sort());
  expect
    .soft(
      [...editor._keyToDOMMap]
        .filter(([, dom]) => !root.contains(dom))
        .map(([key]) => key),
    )
    .toEqual([]);
}

// A removed slot host whose value moves to a host rendered later still has
// its old mounted container removed (the value's DOM has not moved yet). No
// node here asks to re-create its DOM.
test.each(['element', 'decorator'] as const)(
  'removing a %s host before rendering a moved slot removes its old mounted container',
  kind => {
    const {editor, root, update} = setup();
    let sourceKey = '';
    let targetKey = '';
    let chromeKey = '';
    let valueKey = '';
    update(() => {
      // Decorator chrome is unmanaged, and deliberately outlives the source.
      const chrome = $createTestDecoratorNode().setIsInline(false);
      const source =
        kind === 'element'
          ? $createTestElementNode().append($paragraph('source'))
          : $createTestDecoratorNode().setIsInline(false);
      const target = $createTestElementNode().append($paragraph('target'));
      const value = $paragraph('title');
      sourceKey = source.getKey();
      targetKey = target.getKey();
      chromeKey = chrome.getKey();
      valueKey = value.getKey();
      $setSlot(source, 'title', value);
      $getRoot().append(chrome, source, target);
    });
    const chrome = editor.getElementByKey(chromeKey)!;
    const oldContainer = mountSlotContainer(
      editor,
      sourceKey,
      'title',
      chrome,
    )!;
    const changes = update(() => {
      const source = $getNodeByKey(sourceKey)!;
      $setSlot(
        $getNodeByKey(targetKey) as TestElementNode,
        'title',
        $getSlot(source, 'title')!,
      );
      source.remove();
    });
    expect.soft(oldContainer.isConnected).toBe(false);
    expect.soft(chrome.childElementCount).toBe(0);
    expect.soft(changes.get(sourceKey)).toBe('destroyed');
    expect.soft(changes.get(valueKey)).toBe('updated');
    checkMap(editor, root);
    expect(root.innerHTML).toBe(freshHTML(editor));
  },
);

test('removing the sole child of a rebuilt host destroys its subtree', () => {
  const {editor, root, update} = setup();
  let hostKey = '';
  let removed: string[] = [];
  update(() => {
    const host = $createTestUpdateDOMTrueHostNode();
    const value = $paragraph('sole child');
    hostKey = host.getKey();
    removed = [value.getKey(), value.getFirstChildOrThrow().getKey()];
    $getRoot().append(host.append(value));
  });
  const changes = update(() => {
    ($getNodeByKey(hostKey) as TestUpdateDOMTrueHostNode).setToggle(1);
    $getNodeByKey(removed[0])!.remove();
  });
  for (const key of removed) {
    expect.soft(editor.getElementByKey(key)).toBe(null);
    expect.soft(changes.get(key)).toBe('destroyed');
  }
  checkMap(editor, root);
  expect(root.innerHTML).toBe(freshHTML(editor));
});
