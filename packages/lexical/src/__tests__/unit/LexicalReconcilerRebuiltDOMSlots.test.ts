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
  $getSelection,
  $getSlot,
  $isElementNode,
  $removeSlot,
  $setSlot,
  type ElementNode,
  type LexicalEditor,
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
import {afterEach, describe, expect, test, vi} from 'vitest';

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
  vi.restoreAllMocks();
});

function setup(parentEditor?: LexicalEditor) {
  const editor = buildEditorFromExtensions({
    name: 'lexical-reconciler-rebuilt-dom-slots',
    nodes: [TestElementNode, TestUpdateDOMTrueHostNode, TestDecoratorNode],
    onError: (error: Error) => {
      throw error;
    },
    parentEditor,
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  editor.setRootElement(root);
  disposals.push(() => {
    editor.dispose();
    root.remove();
  });
  let mutations = new Map<NodeKey, NodeMutation>();
  let deliveries = new Map<NodeKey, number>();
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
    deliveries = new Map();
    editor.update(fn, {discrete: true});
    return {deliveries, mutations};
  }
  return {editor, root, update};
}

function $paragraph(text: string) {
  return $createParagraphNode().append($createTextNode(text));
}

function checkDOM(editor: LexicalEditor, root: HTMLElement) {
  const state = editor.getEditorState();
  const stale = [...editor._keyToDOMMap.keys()].filter(
    key => !state._nodeMap.has(key),
  );
  const detached = [...editor._keyToDOMMap].filter(
    ([, dom]) => !root.contains(dom),
  );
  expect.soft({detached: detached.map(([key]) => key), stale}).toEqual({
    detached: [],
    stale: [],
  });
  expect
    .soft([...editor._keyToDOMMap.keys()].sort())
    .toEqual([...state._nodeMap.keys()].sort());
  const fresh = setup();
  fresh.editor.setEditorState(state.clone(null));
  expect(root.innerHTML).toBe(fresh.root.innerHTML);
  editor.read('latest', () => {
    for (const [key, node] of state._nodeMap) {
      if ($isElementNode(node)) {
        expect(
          (
            editor.getElementByKey(key) as HTMLElement & {
              __lexicalTextContent: string;
            }
          ).__lexicalTextContent,
        ).toBe(node.getTextContent());
      }
    }
  });
}

function checkRemoved(
  editor: LexicalEditor,
  changes: ReturnType<ReturnType<typeof setup>['update']>,
  keys: NodeKey[],
) {
  for (const key of keys) {
    // All assertions execute, so the failure records both map and listener gaps.
    expect.soft(editor.getEditorState()._nodeMap.has(key)).toBe(false);
    expect.soft(editor.getElementByKey(key)).toBe(null);
    expect.soft(changes.mutations.get(key)).toBe('destroyed');
    expect.soft(changes.deliveries.get(key)).toBe(1);
  }
}

describe('LexicalReconciler: slots of a node whose DOM is built anew', () => {
  test('a slot moved from a removed child to its rebuilt ancestor keeps its new live container', () => {
    const {editor, root, update} = setup();
    let hostKey = '';
    let sourceKey = '';
    let slotKey = '';
    update(() => {
      const host = $createTestUpdateDOMTrueHostNode();
      const source = $createTestElementNode();
      const value = $paragraph('moved slot');
      hostKey = host.getKey();
      sourceKey = source.getKey();
      slotKey = value.getKey();
      $setSlot(source, 'title', value);
      $getRoot().append(host.append(source));
    });
    const previousSlotDOM = editor.getElementByKey(slotKey);
    const changes = update(() => {
      const host = $getNodeByKey(hostKey) as TestUpdateDOMTrueHostNode;
      const source = $getNodeByKey(sourceKey) as TestElementNode;
      host.setToggle(1);
      $setSlot(host, 'title', $getSlot(source, 'title')!);
      source.remove();
    });
    expect(editor.getElementByKey(slotKey)).toBe(previousSlotDOM);
    // Destroying the removed source must not resolve the moved slot's NEW
    // parent container through its reused DOM and remove that container.
    expect.soft(root.contains(editor.getElementByKey(slotKey))).toBe(true);
    expect
      .soft(root.querySelector('[data-lexical-slot="title"]'))
      .not.toBe(null);
    expect(changes.mutations.get(slotKey)).toBe('updated');
    // Every NEXT key must still be live, and the DOM must match a fresh render.
    for (const key of editor.getEditorState()._nodeMap.keys()) {
      expect.soft(root.contains(editor.getElementByKey(key))).toBe(true);
    }
    const fresh = setup();
    fresh.editor.setEditorState(editor.getEditorState().clone(null));
    expect(root.innerHTML).toBe(fresh.root.innerHTML);
  });

  test.each(['remove', 'replace'] as const)(
    'a %s of a slot on a host whose updateDOM returns true destroys the previous slot subtree',
    action => {
      const {editor, root, update} = setup();
      let hostKey = '';
      let removed: NodeKey[] = [];
      update(() => {
        const host = $createTestUpdateDOMTrueHostNode();
        const value = $paragraph('old slot');
        const text = value.getFirstChildOrThrow();
        hostKey = host.getKey();
        removed = [value.getKey(), text.getKey()];
        host.append($paragraph('body'));
        $setSlot(host, 'title', value);
        $getRoot().append(host);
      });
      const changes = update(() => {
        const host = $getNodeByKey(hostKey) as TestUpdateDOMTrueHostNode;
        host.setToggle(1);
        if (action === 'remove') {
          $removeSlot(host, 'title');
        } else {
          $setSlot(host, 'title', $paragraph('new slot'));
        }
      });
      checkRemoved(editor, changes, removed);
      checkDOM(editor, root);
    },
  );

  test.each(['element', 'decorator'] as const)(
    'a slot removed from a kept %s below a rebuilt ancestor is destroyed',
    kind => {
      const {editor, root, update} = setup();
      let hostKey = '';
      let childKey = '';
      let removed: NodeKey[] = [];
      update(() => {
        const host = $createTestUpdateDOMTrueHostNode();
        const child =
          kind === 'element'
            ? $createTestElementNode().append($paragraph('body'))
            : $createTestDecoratorNode();
        const value = $paragraph('old slot');
        removed = [value.getKey(), value.getFirstChildOrThrow().getKey()];
        $setSlot(child, 'title', value);
        hostKey = host.getKey();
        childKey = child.getKey();
        $getRoot().append(host.append(child));
      });
      const changes = update(() => {
        ($getNodeByKey(hostKey) as TestUpdateDOMTrueHostNode).setToggle(1);
        $removeSlot(
          $getNodeByKey(childKey) as TestElementNode | TestDecoratorNode,
          'title',
        );
      });
      checkRemoved(editor, changes, removed);
      checkDOM(editor, root);
    },
  );
});

describe('LexicalReconciler: what stays when a DOM is built anew', () => {
  test('inverting two rebuilt ancestors cleans both old child lists without destroying either survivor', () => {
    const {editor, root, update} = setup();
    let outerKey = '';
    let innerKey = '';
    const removed: NodeKey[] = [];
    update(() => {
      const outer = $createTestUpdateDOMTrueHostNode();
      const inner = $createTestUpdateDOMTrueHostNode();
      outerKey = outer.getKey();
      innerKey = inner.getKey();
      const outerGone = $paragraph('outer gone');
      const innerGone = $paragraph('inner gone');
      for (const node of [outerGone, innerGone]) {
        removed.push(node.getKey(), node.getFirstChildOrThrow().getKey());
      }
      inner.append(innerGone);
      outer.append(inner, $paragraph('kept'), outerGone);
      $getRoot().append(outer);
    });
    const changes = update(() => {
      const outer = $getNodeByKey(outerKey) as TestUpdateDOMTrueHostNode;
      const inner = $getNodeByKey(innerKey) as TestUpdateDOMTrueHostNode;
      outer.setToggle(1);
      inner.setToggle(1);
      $getRoot().append(inner);
      inner.append(outer);
      $getNodeByKey(removed[0])!.remove();
      $getNodeByKey(removed[2])!.remove();
    });
    checkRemoved(editor, changes, removed);
    for (const key of [outerKey, innerKey]) {
      expect(changes.mutations.get(key)).toBe('updated');
      expect(changes.deliveries.get(key)).toBe(1);
    }
    checkDOM(editor, root);
  });

  test('cleanup also applies to ordinary children of a host with an unchanged slot', () => {
    // A host with an unchanged slot still cleans up its removed children.
    const {editor, root, update} = setup();
    let hostKey = '';
    let childKey = '';
    let slotKey = '';
    let removed: NodeKey[] = [];
    update(() => {
      const host = $createTestUpdateDOMTrueHostNode();
      const child = $paragraph('remove');
      const value = $paragraph('kept slot');
      hostKey = host.getKey();
      childKey = child.getKey();
      slotKey = value.getKey();
      removed = [childKey, child.getFirstChildOrThrow().getKey()];
      $setSlot(host, 'title', value);
      $getRoot().append(host.append($paragraph('kept'), child));
    });
    const slotDOM = editor.getElementByKey(slotKey);
    const changes = update(() => {
      ($getNodeByKey(hostKey) as TestUpdateDOMTrueHostNode).setToggle(1);
      $getNodeByKey(childKey)!.remove();
    });
    checkRemoved(editor, changes, removed);
    expect(editor.getElementByKey(slotKey)).toBe(slotDOM);
    expect(changes.mutations.get(slotKey)).not.toBe('destroyed');
    checkDOM(editor, root);
  });

  test.each([1, 5, 30])(
    'removing a subtree below %i levels of re-creation preserves every survivor and delivers one destruction',
    depth => {
      const {editor, root, update} = setup();
      let hostKey = '';
      let removedRoot = '';
      let keptText = '';
      let removed: NodeKey[] = [];
      let survivors: NodeKey[] = [];
      update(() => {
        const host = $createTestUpdateDOMTrueHostNode();
        hostKey = host.getKey();
        let parent: ElementNode = host;
        for (let i = 0; i < depth; i++) {
          const next = $createTestElementNode();
          parent.append(next);
          parent = next;
        }
        const kept = $paragraph('keep');
        const gone = $createTestElementNode().append($paragraph('gone'));
        $setSlot(gone, 'alsoGone', $paragraph('slot gone'));
        removedRoot = gone.getKey();
        keptText = kept.getFirstChildOrThrow().getKey();
        parent.append(kept, gone);
        $getRoot().append(host);
        (kept.getFirstChildOrThrow() as TextNode).select(2, 2);
      });
      const previous = editor.getEditorState();
      const changes = update(() => {
        ($getNodeByKey(hostKey) as TestUpdateDOMTrueHostNode).setToggle(1);
        $getNodeByKey(removedRoot)!.remove();
      });
      removed = [...previous._nodeMap.keys()].filter(
        key => !editor.getEditorState()._nodeMap.has(key),
      );
      survivors = [...previous._nodeMap.keys()].filter(key =>
        editor.getEditorState()._nodeMap.has(key),
      );
      checkRemoved(editor, changes, removed);
      for (const key of survivors) {
        expect(changes.mutations.get(key)).not.toBe('destroyed');
      }
      editor.read('latest', () => {
        expect($getSelection()?.getNodes()[0].getKey()).toBe(keptText);
      });
      checkDOM(editor, root);
    },
  );

  test.each(['before', 'after'] as const)(
    'a kept child moves %s a rebuilt host while its grandchild is removed',
    position => {
      const {editor, root, update} = setup();
      let hostKey = '';
      let movedKey = '';
      let removed: NodeKey[] = [];
      update(() => {
        const host = $createTestUpdateDOMTrueHostNode();
        const moved = $createTestElementNode().append(
          $paragraph('kept'),
          $paragraph('gone'),
        );
        const gone = moved.getLastChildOrThrow() as ElementNode;
        removed = [gone.getKey(), gone.getFirstChildOrThrow().getKey()];
        hostKey = host.getKey();
        movedKey = moved.getKey();
        $getRoot().append(host.append(moved), $paragraph('tail'));
      });
      const changes = update(() => {
        const host = $getNodeByKey(hostKey) as TestUpdateDOMTrueHostNode;
        host.setToggle(1);
        $getNodeByKey(removed[0])!.remove();
        const moved = $getNodeByKey(movedKey)!;
        if (position === 'before') {
          host.insertBefore(moved);
        } else {
          host.insertAfter(moved);
        }
      });
      checkRemoved(editor, changes, removed);
      expect(changes.mutations.get(movedKey)).toBe('updated');
      checkDOM(editor, root);
    },
  );

  test.each(['before', 'after'] as const)(
    'a slot value moves %s its old host while both hosts are rebuilt and one grandchild leaves',
    position => {
      const {editor, root, update} = setup();
      let sourceKey = '';
      let targetKey = '';
      let valueKey = '';
      let removed: NodeKey[] = [];
      update(() => {
        const source = $createTestUpdateDOMTrueHostNode();
        const target = $createTestUpdateDOMTrueHostNode();
        const value = $createTestElementNode().append(
          $paragraph('kept'),
          $paragraph('gone'),
        );
        const gone = value.getLastChildOrThrow() as ElementNode;
        sourceKey = source.getKey();
        targetKey = target.getKey();
        valueKey = value.getKey();
        removed = [gone.getKey(), gone.getFirstChildOrThrow().getKey()];
        $setSlot(source, 'title', value);
        if (position === 'before') {
          $getRoot().append(target, source);
        } else {
          $getRoot().append(source, target);
        }
      });
      const valueDOM = editor.getElementByKey(valueKey);
      const changes = update(() => {
        const source = $getNodeByKey(sourceKey) as TestUpdateDOMTrueHostNode;
        const target = $getNodeByKey(targetKey) as TestUpdateDOMTrueHostNode;
        source.setToggle(1);
        target.setToggle(1);
        $getNodeByKey(removed[0])!.remove();
        $setSlot(target, 'title', $getSlot(source, 'title')!);
      });
      checkRemoved(editor, changes, removed);
      expect(editor.getElementByKey(valueKey)).toBe(valueDOM);
      expect(changes.mutations.get(valueKey)).toBe('updated');
      checkDOM(editor, root);
    },
  );

  test.each(['before', 'after'] as const)(
    'an element moves into a rebuilt subtree from a parent rendered %s it',
    position => {
      const {editor, root, update} = setup();
      let sourceKey = '';
      let targetKey = '';
      let movedKey = '';
      let removed: NodeKey[] = [];
      update(() => {
        const source = $createTestElementNode();
        const target = $createTestUpdateDOMTrueHostNode();
        const moved = $createTestElementNode().append(
          $paragraph('kept'),
          $paragraph('gone'),
        );
        const gone = moved.getLastChildOrThrow() as ElementNode;
        removed = [gone.getKey(), gone.getFirstChildOrThrow().getKey()];
        movedKey = moved.getKey();
        sourceKey = source.getKey();
        targetKey = target.getKey();
        source.append(moved, $paragraph('source tail'));
        target.append($paragraph('target child'));
        if (position === 'before') {
          $getRoot().append(source, target);
        } else {
          $getRoot().append(target, source);
        }
      });
      const movedDOM = editor.getElementByKey(movedKey);
      const changes = update(() => {
        const target = $getNodeByKey(targetKey) as TestUpdateDOMTrueHostNode;
        target.setToggle(1);
        $getNodeByKey(removed[0])!.remove();
        target.append($getNodeByKey(movedKey)!);
      });
      checkRemoved(editor, changes, removed);
      expect(editor.getElementByKey(movedKey)).toBe(movedDOM);
      expect(changes.mutations.get(movedKey)).toBe('updated');
      expect(editor.getElementByKey(sourceKey)).not.toBe(null);
      checkDOM(editor, root);
    },
  );

  test('a kept decorator keeps its value and a removed decorator clears pending decorators', () => {
    const {editor, root, update} = setup();
    let hostKey = '';
    let keptKey = '';
    let goneKey = '';
    update(() => {
      const host = $createTestUpdateDOMTrueHostNode();
      const kept = $createTestDecoratorNode();
      const gone = $createTestDecoratorNode();
      hostKey = host.getKey();
      keptKey = kept.getKey();
      goneKey = gone.getKey();
      $getRoot().append(host.append(kept, gone));
    });
    const value = editor.getDecorators()[keptKey];
    const changes = update(() => {
      ($getNodeByKey(hostKey) as TestUpdateDOMTrueHostNode).setToggle(1);
      $getNodeByKey(goneKey)!.remove();
    });
    checkRemoved(editor, changes, [goneKey]);
    expect(editor.getDecorators()[keptKey]).toEqual(value);
    expect(editor.getDecorators()).not.toHaveProperty(goneKey);
    expect(editor._pendingDecorators).toBe(null);
    expect(changes.mutations.get(keptKey)).toBe('created');
    checkDOM(editor, root);
  });

  test('new keys get created, unchanged rebuilt children retain the pre-existing created notification', () => {
    const {editor, root, update} = setup();
    let hostKey = '';
    let keptKey = '';
    let newKey = '';
    update(() => {
      const host = $createTestUpdateDOMTrueHostNode();
      const kept = $paragraph('kept');
      keptKey = kept.getKey();
      hostKey = host.getKey();
      $getRoot().append(host.append(kept));
    });
    const changes = update(() => {
      const host = $getNodeByKey(hostKey) as TestUpdateDOMTrueHostNode;
      host.setToggle(1);
      const added = $paragraph('added');
      newKey = added.getKey();
      host.append(added);
    });
    expect(changes.mutations.get(newKey)).toBe('created');
    expect(changes.mutations.get(keptKey)).toBe('created');
    expect(changes.mutations.get(hostKey)).toBe('updated');
    expect([...changes.deliveries.values()].every(count => count === 1)).toBe(
      true,
    );
    checkDOM(editor, root);
  });

  test('setEditorState with shared keys and a removed child cleans the previous map', () => {
    const {editor, root, update} = setup();
    let hostKey = '';
    let removed: NodeKey[] = [];
    update(() => {
      const host = $createTestUpdateDOMTrueHostNode();
      const gone = $paragraph('gone');
      hostKey = host.getKey();
      removed = [gone.getKey(), gone.getFirstChildOrThrow().getKey()];
      $getRoot().append(host.append($paragraph('kept'), gone));
    });
    const other = setup();
    other.editor.setEditorState(editor.getEditorState().clone(null));
    other.update(() => {
      ($getNodeByKey(hostKey) as TestUpdateDOMTrueHostNode).setToggle(1);
      $getNodeByKey(removed[0])!.remove();
    });
    editor.setEditorState(other.editor.getEditorState().clone(null));
    for (const key of removed) {
      expect(editor.getElementByKey(key)).toBe(null);
    }
    checkDOM(editor, root);
    // JSON has fresh keys; the old tree is wholly destroyed, not shared.
    editor.setEditorState(
      editor.parseEditorState(JSON.stringify(editor.getEditorState())),
    );
    checkDOM(editor, root);
  });

  test('a transform removes children from several re-created hosts in one commit', () => {
    const {editor, root, update} = setup();
    const hostKeys: NodeKey[] = [];
    const removed: NodeKey[] = [];
    update(() => {
      for (let i = 0; i < 8; i++) {
        const host = $createTestUpdateDOMTrueHostNode();
        const gone = $paragraph('gone');
        hostKeys.push(host.getKey());
        removed.push(gone.getKey(), gone.getFirstChildOrThrow().getKey());
        $getRoot().append(host.append($paragraph('kept'), gone));
      }
    });
    const unregister = editor.registerNodeTransform(
      TestUpdateDOMTrueHostNode,
      host => {
        if (host.__toggle === 1 && host.getChildrenSize() === 2) {
          host.getLastChildOrThrow().remove();
        }
      },
    );
    const changes = update(() => {
      for (const key of hostKeys) {
        ($getNodeByKey(key) as TestUpdateDOMTrueHostNode).setToggle(1);
      }
    });
    unregister();
    checkRemoved(editor, changes, removed);
    checkDOM(editor, root);
  });

  test('a nested editor remains intact when an outer unrelated host is rebuilt', () => {
    const outer = setup();
    const nested = setup(outer.editor);
    let hostKey = '';
    outer.update(() => {
      const host = $createTestUpdateDOMTrueHostNode();
      hostKey = host.getKey();
      $getRoot().append(host.append($paragraph('outer')));
    });
    nested.update(() => $getRoot().append($paragraph('nested')));
    const previous = nested.root.innerHTML;
    outer.update(() => {
      ($getNodeByKey(hostKey) as TestUpdateDOMTrueHostNode).setToggle(1);
    });
    expect(nested.root.innerHTML).toBe(previous);
    checkDOM(outer.editor, outer.root);
    checkDOM(nested.editor, nested.root);
  });

  test('rebuilding 10,000 items makes a linear number of previous-map lookups', () => {
    const {editor, update} = setup();
    let hostKey = '';
    let removed: NodeKey[] = [];
    update(() => {
      const host = $createTestUpdateDOMTrueHostNode();
      hostKey = host.getKey();
      for (let i = 0; i < 10000; i++) {
        host.append($paragraph(String(i)));
      }
      const gone = host.getLastChildOrThrow() as ElementNode;
      removed = [gone.getKey(), gone.getFirstChildOrThrow().getKey()];
      $getRoot().append(host);
    });
    const previous = editor.getEditorState()._nodeMap;
    const lookups = vi.spyOn(previous, 'get');
    const changes = update(() => {
      ($getNodeByKey(hostKey) as TestUpdateDOMTrueHostNode).setToggle(1);
      $getNodeByKey(removed[0])!.remove();
    });
    // Counts operations instead of using a machine-dependent time budget.
    expect(lookups.mock.calls.length).toBeLessThan(12 * previous.size);
    checkRemoved(editor, changes, removed);
    expect(editor._keyToDOMMap.size).toBe(
      editor.getEditorState()._nodeMap.size,
    );
  }, 30000);
});
