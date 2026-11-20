/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  type ElementNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  LineBreakNode,
  type NodeKey,
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
import {describe, expect, test} from 'vitest';

// Some updates make the reconciler build a node's DOM anew instead of
// reconciling it against its previous children: an element whose updateDOM
// returns true (and every child under it), or a node moved out of a parent's
// only child into that parent's only-child position. A child removed in the
// same update must still leave the editor's DOM map and report 'destroyed';
// children that stay must not.

const NODE_CLASSES: Klass<LexicalNode>[] = [
  ParagraphNode,
  TextNode,
  LineBreakNode,
  TestElementNode,
  TestUpdateDOMTrueHostNode,
  TestDecoratorNode,
];

function buildEditor() {
  const editor = buildEditorFromExtensions({
    name: 'lexical-reconciler-rebuilt-dom-children',
    nodes: [TestElementNode, TestUpdateDOMTrueHostNode, TestDecoratorNode],
    onError: (error: Error) => {
      throw error;
    },
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  // Mutations of the last update, by key; a key reported twice in one
  // update with different kinds is recorded as 'conflict'.
  let mutations = new Map<NodeKey, NodeMutation | 'conflict'>();
  for (const klass of NODE_CLASSES) {
    editor.registerMutationListener(
      klass,
      nodeMutations => {
        for (const [key, mutation] of nodeMutations) {
          const seen = mutations.get(key);
          mutations.set(
            key,
            seen !== undefined && seen !== mutation ? 'conflict' : mutation,
          );
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

// Keys in the DOM map whose node is no longer in the editor state.
function staleKeys(editor: LexicalEditor): NodeKey[] {
  const nodeMap = editor.getEditorState()._nodeMap;
  return [...editor._keyToDOMMap.keys()].filter(key => !nodeMap.has(key));
}

// The DOM a fresh editor renders for the same editor state (the state
// itself, not a JSON copy: the test host's toggle is not serialized).
function freshDOM(editor: LexicalEditor): string {
  const fresh = buildEditor();
  fresh.editor.setEditorState(editor.getEditorState().clone(null));
  const html = fresh.root.innerHTML;
  fresh.editor.dispose();
  fresh.root.remove();
  return html;
}

function expectCleanCommit(
  editor: LexicalEditor,
  root: HTMLElement,
  mutations: Map<NodeKey, NodeMutation | 'conflict'>,
  removed: NodeKey[],
  kept: NodeKey[],
) {
  expect(staleKeys(editor)).toEqual([]);
  for (const key of removed) {
    expect(editor.getElementByKey(key)).toBe(null);
    expect(mutations.get(key)).toBe('destroyed');
  }
  for (const key of kept) {
    const element = editor.getElementByKey(key);
    expect(element).not.toBe(null);
    expect(root.contains(element)).toBe(true);
    expect(mutations.get(key)).not.toBe('destroyed');
  }
  expect([...mutations.values()]).not.toContain('conflict');
  expect(root.innerHTML).toBe(freshDOM(editor));
}

describe('LexicalReconciler: children of a node whose DOM is built anew', () => {
  test('a child removed from an element whose updateDOM returns true', () => {
    const {editor, root, update} = buildEditor();
    const keys: Record<string, NodeKey> = {};
    update(() => {
      const host = $createTestUpdateDOMTrueHostNode();
      const a = $createParagraphNode().append($createTextNode('a'));
      const b = $createParagraphNode().append($createTextNode('b'));
      keys.host = host.getKey();
      keys.a = a.getKey();
      keys.b = b.getKey();
      keys.bText = b.getFirstChildOrThrow().getKey();
      $getRoot().clear().append(host.append(a, b));
    });
    const mutations = update(() => {
      ($getNodeByKey(keys.host) as TestUpdateDOMTrueHostNode).setToggle(1);
      $getNodeByKey(keys.b)!.remove();
    });
    expectCleanCommit(
      editor,
      root,
      mutations,
      [keys.b, keys.bText],
      [keys.host, keys.a],
    );
  });

  test('a grandchild removed under a kept child of an element whose updateDOM returns true', () => {
    const {editor, root, update} = buildEditor();
    const keys: Record<string, NodeKey> = {};
    update(() => {
      const host = $createTestUpdateDOMTrueHostNode();
      const p = $createParagraphNode().append(
        $createTextNode('a'),
        $createLineBreakNode(),
        $createTextNode('b').setFormat('bold'),
      );
      keys.host = host.getKey();
      keys.p = p.getKey();
      keys.a = p.getFirstChildOrThrow().getKey();
      keys.br = p.getChildAtIndex(1)!.getKey();
      keys.b = p.getLastChildOrThrow().getKey();
      $getRoot().clear().append(host.append(p));
    });
    const mutations = update(() => {
      ($getNodeByKey(keys.host) as TestUpdateDOMTrueHostNode).setToggle(1);
      $getNodeByKey(keys.br)!.remove();
      $getNodeByKey(keys.b)!.remove();
    });
    expectCleanCommit(
      editor,
      root,
      mutations,
      [keys.br, keys.b],
      [keys.host, keys.p, keys.a],
    );
  });

  test('a child moved out of an element whose updateDOM returns true stays', () => {
    const {editor, root, update} = buildEditor();
    const keys: Record<string, NodeKey> = {};
    update(() => {
      const host = $createTestUpdateDOMTrueHostNode();
      const a = $createParagraphNode().append($createTextNode('a'));
      const b = $createParagraphNode().append($createTextNode('b'));
      keys.host = host.getKey();
      keys.a = a.getKey();
      keys.b = b.getKey();
      keys.bText = b.getFirstChildOrThrow().getKey();
      $getRoot().clear().append(host.append(a, b), $createParagraphNode());
    });
    const mutations = update(() => {
      ($getNodeByKey(keys.host) as TestUpdateDOMTrueHostNode).setToggle(1);
      $getRoot().append($getNodeByKey(keys.b)!);
    });
    expectCleanCommit(
      editor,
      root,
      mutations,
      [],
      [keys.host, keys.a, keys.b, keys.bText],
    );
  });

  test('a decorator removed from an element whose updateDOM returns true', () => {
    const {editor, root, update} = buildEditor();
    const keys: Record<string, NodeKey> = {};
    update(() => {
      const host = $createTestUpdateDOMTrueHostNode();
      const p = $createParagraphNode().append(
        $createTextNode('a'),
        $createTestDecoratorNode(),
      );
      keys.host = host.getKey();
      keys.p = p.getKey();
      keys.decorator = p.getLastChildOrThrow().getKey();
      $getRoot().clear().append(host.append(p));
    });
    const mutations = update(() => {
      ($getNodeByKey(keys.host) as TestUpdateDOMTrueHostNode).setToggle(1);
      $getNodeByKey(keys.decorator)!.remove();
    });
    expectCleanCommit(
      editor,
      root,
      mutations,
      [keys.decorator],
      [keys.host, keys.p],
    );
    expect(Object.keys(editor.getDecorators())).not.toContain(keys.decorator);
  });

  test("a node moved out of a parent's only child into its place, with a child removed", () => {
    const {editor, root, update} = buildEditor();
    const keys: Record<string, NodeKey> = {};
    update(() => {
      const inner = $createTestElementNode().append(
        $createParagraphNode().append($createTextNode('x')),
        $createParagraphNode().append($createTextNode('y')),
      );
      const outer = $createTestElementNode().append(
        $createTestElementNode().append(inner),
      );
      const parent = $createTestElementNode().append(outer);
      keys.inner = inner.getKey();
      keys.x = inner.getFirstChildOrThrow().getKey();
      keys.y = inner.getLastChildOrThrow().getKey();
      keys.yText = (inner.getLastChildOrThrow() as ElementNode)
        .getFirstChildOrThrow()
        .getKey();
      keys.outer = outer.getKey();
      keys.wrapper = outer.getFirstChildOrThrow().getKey();
      keys.parent = parent.getKey();
      $getRoot()
        .clear()
        .append(parent, $createParagraphNode().append($createTextNode('tail')));
    });
    const mutations = update(() => {
      $getNodeByKey(keys.y)!.remove();
      ($getNodeByKey(keys.parent) as ElementNode).append(
        $getNodeByKey(keys.inner)!,
      );
      $getNodeByKey(keys.outer)!.remove();
    });
    expectCleanCommit(
      editor,
      root,
      mutations,
      [keys.y, keys.yText, keys.outer, keys.wrapper],
      [keys.parent, keys.inner, keys.x],
    );
  });

  test('the DOM map does not grow when such updates repeat', () => {
    const {editor, update} = buildEditor();
    for (let i = 0; i < 50; i++) {
      const keys: Record<string, NodeKey> = {};
      update(() => {
        const host = $createTestUpdateDOMTrueHostNode();
        const a = $createParagraphNode().append($createTextNode('a'));
        const b = $createParagraphNode().append($createTextNode('b'));
        keys.host = host.getKey();
        keys.b = b.getKey();
        $getRoot().clear().append(host.append(a, b));
      });
      update(() => {
        ($getNodeByKey(keys.host) as TestUpdateDOMTrueHostNode).setToggle(1);
        $getNodeByKey(keys.b)!.remove();
      });
    }
    expect(staleKeys(editor)).toEqual([]);
    // root, the host, its kept paragraph and that paragraph's text
    expect(editor._keyToDOMMap.size).toBe(4);
  });

  test('the DOM map is cleaned also when no mutation listener is registered', () => {
    const editor = buildEditorFromExtensions({
      name: 'lexical-reconciler-rebuilt-dom-children-no-listeners',
      nodes: [TestUpdateDOMTrueHostNode],
      onError: (error: Error) => {
        throw error;
      },
    });
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    editor.setRootElement(root);
    const keys: Record<string, NodeKey> = {};
    editor.update(
      () => {
        const host = $createTestUpdateDOMTrueHostNode();
        const b = $createParagraphNode().append($createTextNode('b'));
        keys.host = host.getKey();
        keys.b = b.getKey();
        $getRoot()
          .clear()
          .append(
            host.append($createParagraphNode().append($createTextNode('a')), b),
          );
      },
      {discrete: true},
    );
    expect(editor._listeners.mutation.size).toBe(0);
    editor.update(
      () => {
        ($getNodeByKey(keys.host) as TestUpdateDOMTrueHostNode).setToggle(1);
        $getNodeByKey(keys.b)!.remove();
      },
      {discrete: true},
    );
    expect(staleKeys(editor)).toEqual([]);
    expect(editor.getElementByKey(keys.b)).toBe(null);
    editor.dispose();
    root.remove();
  });
});
