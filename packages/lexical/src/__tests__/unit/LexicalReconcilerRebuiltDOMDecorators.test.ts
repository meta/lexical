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
  $isElementNode,
  $removeSlot,
  $setSlot,
  type ElementNode,
  type LexicalEditor,
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
    name: 'lexical-reconciler-rebuilt-dom-decorators',
    nodes: [TestDecoratorNode, TestElementNode, TestUpdateDOMTrueHostNode],
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
  const deliveries = new Map<string, number>();
  for (const klass of [
    TestDecoratorNode,
    TestElementNode,
    TestUpdateDOMTrueHostNode,
    ParagraphNode,
    TextNode,
  ]) {
    editor.registerMutationListener(
      klass,
      changes => {
        for (const [key, kind] of changes) {
          mutations.set(key, kind);
          deliveries.set(key, (deliveries.get(key) || 0) + 1);
        }
      },
      {skipInitialization: true},
    );
  }
  function update(fn: () => void) {
    mutations = new Map();
    deliveries.clear();
    editor.update(fn, {discrete: true});
    return {deliveries, mutations};
  }
  return {editor, root, update};
}

function checkCommit(
  editor: LexicalEditor,
  root: HTMLElement,
  previousKeys: string[],
  changes: ReturnType<ReturnType<typeof setup>['update']>,
) {
  const next = editor.getEditorState();
  expect([...editor._keyToDOMMap.keys()].sort()).toEqual(
    [...next._nodeMap.keys()].sort(),
  );
  for (const [key, dom] of editor._keyToDOMMap) {
    expect(root.contains(dom), `detached DOM for ${key}`).toBe(true);
  }
  for (const key of previousKeys) {
    if (!next._nodeMap.has(key)) {
      expect(changes.mutations.get(key), `removed ${key}`).toBe('destroyed');
      expect(changes.deliveries.get(key)).toBe(1);
    } else {
      expect(changes.mutations.get(key), `surviving ${key}`).not.toBe(
        'destroyed',
      );
    }
  }
  for (const key of next._nodeMap.keys()) {
    if (!previousKeys.includes(key)) {
      expect(changes.mutations.get(key), `new ${key}`).toBe('created');
    }
  }
  expect([...changes.deliveries.values()].every(count => count === 1)).toBe(
    true,
  );
  const fresh = setup();
  fresh.editor.setEditorState(next.clone(null));
  expect(root.innerHTML).toBe(fresh.root.innerHTML);
  editor.read('latest', () => {
    for (const [key, node] of next._nodeMap) {
      if ($isElementNode(node)) {
        const dom = editor.getElementByKey(key) as HTMLElement & {
          __lexicalTextContent: string;
        };
        expect(dom.__lexicalTextContent).toBe(node.getTextContent());
      }
    }
  });
}

// A decorator whose own updateDOM returns true is built anew through
// $createNode(key, null); its previous slot values are cleaned up too.
test.each(['remove', 'replace'] as const)(
  'a decorator whose own updateDOM returns true cleans a %s of its slot',
  action => {
    const {editor, root, update} = setup();
    let hostKey = '';
    let valueKey = '';
    let textKey = '';
    update(() => {
      const host = $createTestDecoratorNode();
      const value = $createParagraphNode().append($createTextNode('old'));
      hostKey = host.getKey();
      valueKey = value.getKey();
      textKey = value.getFirstChildOrThrow().getKey();
      $setSlot(host, 'title', value);
      $getRoot().append(host, $createParagraphNode());
    });
    const previousKeys = [...editor.getEditorState()._nodeMap.keys()];
    const oldHostDOM = editor.getElementByKey(hostKey);
    const changes = update(() => {
      const host = $getNodeByKey(hostKey) as TestDecoratorNode;
      host.setIsInline(false); // changes span to div: updateDOM returns true
      if (action === 'remove') {
        $removeSlot(host, 'title');
      } else {
        $setSlot(
          host,
          'title',
          $createParagraphNode().append($createTextNode('new')),
        );
      }
    });
    expect(editor.getElementByKey(hostKey)).not.toBe(oldHostDOM);
    expect.soft(editor.getElementByKey(valueKey)).toBe(null);
    expect.soft(editor.getElementByKey(textKey)).toBe(null);
    expect.soft(changes.mutations.get(valueKey)).toBe('destroyed');
    expect.soft(changes.mutations.get(textKey)).toBe('destroyed');
    expect(changes.mutations.get(hostKey)).toBe('updated');
    expect(editor.getDecorators()).toHaveProperty(hostKey);
    expect(editor._pendingDecorators).toBe(null);
    checkCommit(editor, root, previousKeys, changes);
  },
);

test('re-registering transforms dirties existing hosts and cleans their removed children', () => {
  const {editor, root, update} = setup();
  let hostKey = '';
  update(() => {
    const host = $createTestUpdateDOMTrueHostNode().append(
      $createParagraphNode().append($createTextNode('kept')),
      $createParagraphNode().append($createTextNode('first removed')),
    );
    hostKey = host.getKey();
    $getRoot().append(host);
  });
  for (let pass = 0; pass < 2; pass++) {
    const previousKeys = [...editor.getEditorState()._nodeMap.keys()];
    // A new constructor with the registered type mirrors a module reload.
    // registerNodeTransform resolves the registration by type; no nodes of
    // the unregistered constructor are instantiated.
    class ReloadedHost extends TestUpdateDOMTrueHostNode {}
    const unregister = editor.registerNodeTransform(ReloadedHost, host => {
      if (host.getChildrenSize() > 1) {
        host.getLastChildOrThrow().remove();
      }
    });
    // Flush the pending update scheduled by transform registration.
    const changes = update(() => {});
    unregister();
    checkCommit(editor, root, previousKeys, changes);
    if (pass === 0) {
      update(() => {
        ($getNodeByKey(hostKey) as ElementNode).append(
          $createParagraphNode().append($createTextNode('second removed')),
        );
      });
    }
  }
});

// Deterministically generate two different forests with shared keys. This
// covers removed ancestors with surviving descendants, ancestor inversions,
// moves in both render orders, multiple rebuilds, and repeated visits caused
// by moving a node while its old ancestor is being rendered.
test.each(Array.from({length: 80}, (_, seed) => seed + 1))(
  'shared-key forest reshuffle, seed %i',
  seed => {
    let state = seed;
    const random = (n: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % n;
    };
    const {editor, root, update} = setup();
    const keys: string[] = [];
    update(() => {
      const nodes: ElementNode[] = [];
      for (let i = 0; i < 24; i++) {
        const node =
          random(3) === 0
            ? $createTestUpdateDOMTrueHostNode()
            : $createTestElementNode();
        node.append(
          $createParagraphNode().append($createTextNode(`item ${i}`)),
        );
        keys.push(node.getKey());
        const parent = random(i + 1);
        (parent === i ? $getRoot() : nodes[parent]).append(node);
        nodes.push(node);
      }
    });
    const previousKeys = [...editor.getEditorState()._nodeMap.keys()];
    const changes = update(() => {
      const nodes = keys
        .filter(() => random(5) !== 0)
        .map(key => $getNodeByKey(key) as ElementNode);
      // Release all old parent links before constructing the new acyclic tree.
      for (const node of nodes) {
        node.clear();
      }
      $getRoot().clear();
      for (let i = nodes.length - 1; i > 0; i--) {
        const j = random(i + 1);
        [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
      }
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        node.append(
          $createParagraphNode().append($createTextNode(`next ${i}`)),
        );
        const parent = random(i + 1);
        (parent === i ? $getRoot() : nodes[parent]).append(node);
      }
    });
    checkCommit(editor, root, previousKeys, changes);
  },
);
