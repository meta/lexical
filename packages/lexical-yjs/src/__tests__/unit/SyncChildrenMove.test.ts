/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  createBinding,
  createUndoManager,
  type Provider,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
} from '@lexical/yjs';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKeyOrThrow,
  $getRoot,
  $isElementNode,
  $isTextNode,
  defineExtension,
  type LexicalNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, onTestFinished, test} from 'vitest';
import {applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector} from 'yjs';

import {type CollabElementNode} from '../../CollabElementNode';

const noop = () => {};
const provider = {
  awareness: {
    getLocalState: () => null,
    getStates: () => new Map(),
    off: noop,
    on: noop,
    setLocalState: noop,
    setLocalStateField: noop,
  },
  connect: noop,
  disconnect: noop,
  off: noop,
  on: noop,
} as unknown as Provider;

describe('syncChildrenFromLexical: moving children among siblings', () => {
  // A client that mirrors useYjsCollaboration: local updates are written to
  // its own Doc, and Doc changes from other origins are applied to the editor.
  function buildClient(deferSync = false) {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[sync-children-move]',
        onError: (error: Error) => {
          throw error;
        },
      }),
    );
    onTestFinished(() => editor.dispose());
    const doc = new Doc();
    onTestFinished(() => doc.destroy());
    const binding = createBinding(
      editor,
      provider,
      'test',
      doc,
      new Map([['test', doc]]),
    );
    const pendingSyncs: (() => void)[] = [];
    editor.registerUpdateListener(
      ({
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      }) => {
        const sync = () =>
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
        if (deferSync) {
          pendingSyncs.push(sync);
        } else {
          sync();
        }
      },
    );
    binding.root.getSharedType().observeDeep((events, transaction) => {
      if (transaction.origin !== binding) {
        syncYjsChangesToLexical(
          binding,
          provider,
          events,
          transaction.origin instanceof Object &&
            'undo' in (transaction.origin as object),
          noop,
        );
      }
    });
    return {
      binding,
      doc,
      editor,
      syncPendingUpdates: () => {
        for (const sync of pendingSyncs.splice(0)) {
          sync();
        }
      },
      texts: () =>
        editor.read(() =>
          $getRoot()
            .getChildren()
            .map(child => child.getTextContent()),
        ),
    };
  }

  type Client = ReturnType<typeof buildClient>;

  async function flush() {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  async function syncClients(a: Client, b: Client) {
    applyUpdate(
      b.doc,
      encodeStateAsUpdate(a.doc, encodeStateVector(b.doc)),
      'remote',
    );
    applyUpdate(
      a.doc,
      encodeStateAsUpdate(b.doc, encodeStateVector(a.doc)),
      'remote',
    );
    await flush();
  }

  function seed(client: Client, count: number) {
    client.editor.update(
      () => {
        $getRoot().append(
          ...Array.from({length: count}, (_, i) =>
            $createParagraphNode().append($createTextNode(`P${i}`)),
          ),
        );
      },
      {discrete: true},
    );
  }

  function rootChildren(client: Client): CollabElementNode['_children'] {
    return client.binding.root._children.slice();
  }

  const labels = (count: number) =>
    Array.from({length: count}, (_, i) => `P${i}`);

  function $move(from: number, to: number) {
    // Moves the child at `from` so that it ends up at index `to`
    const children = $getRoot().getChildren();
    if (from < to) {
      children[to].insertAfter(children[from]);
    } else {
      children[to].insertBefore(children[from]);
    }
  }

  test.each([
    ['last to front', 9, 0],
    ['first to end', 0, 9],
    ['middle to front', 5, 0],
    ['middle to end', 5, 9],
    ['forward by one', 3, 4],
    ['backward by one', 4, 3],
    ['middle to middle', 2, 7],
  ])(
    'moving %s re-creates only the moved collab node',
    async (_name, from, to) => {
      const a = buildClient();
      const b = buildClient();
      seed(a, 10);
      await syncClients(a, b);
      const before = rootChildren(a);

      a.editor.update(() => $move(from, to), {discrete: true});

      const after = rootChildren(a);
      const expected = labels(10);
      const [moved] = expected.splice(from, 1);
      expected.splice(to, 0, moved);
      expect(a.texts()).toEqual(expected);
      expect(after.filter(child => !before.includes(child))).toHaveLength(1);
      for (let i = 0; i < before.length; i++) {
        const collabNode = a.binding.collabNodeMap.get(before[i].getKey());
        if (i === from) {
          expect(collabNode).not.toBe(before[i]);
        } else {
          expect(collabNode).toBe(before[i]);
        }
      }

      await syncClients(a, b);
      expect(b.texts()).toEqual(expected);
      expect(a.texts()).toEqual(expected);
    },
  );

  test.each([
    [
      'insertAfter',
      (children: LexicalNode[]) => children[4].insertAfter(children[3]),
    ],
    [
      'insertBefore',
      (children: LexicalNode[]) => children[3].insertBefore(children[4]),
    ],
    [
      'splice',
      (children: LexicalNode[]) => $getRoot().splice(5, 0, [children[3]]),
    ],
    [
      'remove and insert',
      (children: LexicalNode[]) => {
        children[3].remove();
        children[4].insertAfter(children[3]);
      },
    ],
  ])(
    'a concurrent edit to an adjacent shifted sibling survives %s',
    async (name, move) => {
      const a = buildClient();
      const b = buildClient();
      seed(a, 10);
      await syncClients(a, b);
      const editedIndex = name === 'insertBefore' ? 3 : 4;
      const before = rootChildren(a);

      a.editor.update(() => move($getRoot().getChildren()), {
        discrete: true,
      });
      b.editor.update(
        () => {
          $assertNodeType(
            $assertNodeType(
              $getRoot().getChildAtIndex(editedIndex),
              $isElementNode,
            ).getFirstChildOrThrow(),
            $isTextNode,
          ).setTextContent(`P${editedIndex} edited`);
        },
        {discrete: true},
      );

      expect(a.binding.collabNodeMap.get(before[editedIndex].getKey())).toBe(
        before[editedIndex],
      );
      await syncClients(a, b);
      const expected = labels(10);
      [expected[3], expected[4]] = [expected[4], expected[3]];
      expected[editedIndex === 3 ? 4 : 3] = `P${editedIndex} edited`;
      expect(a.texts()).toEqual(expected);
      expect(b.texts()).toEqual(expected);
    },
  );

  test('moving a majority of siblings preserves a concurrent edit to an untouched sibling', async () => {
    const a = buildClient();
    const b = buildClient();
    seed(a, 10);
    await syncClients(a, b);
    const before = rootChildren(a);
    a.editor.update(
      () => {
        const children = $getRoot().getChildren();
        for (let i = 3; i < 10; i++) {
          children[0].insertBefore(children[i]);
        }
      },
      {discrete: true},
    );
    b.editor.update(
      () => {
        $assertNodeType(
          $assertNodeType(
            $getRoot().getChildAtIndex(1),
            $isElementNode,
          ).getFirstChildOrThrow(),
          $isTextNode,
        ).setTextContent('P1 edited');
      },
      {discrete: true},
    );
    for (let i = 0; i < 3; i++) {
      expect(a.binding.collabNodeMap.get(before[i].getKey())).toBe(before[i]);
    }
    await syncClients(a, b);
    const expected = [...labels(10).slice(3), 'P0', 'P1 edited', 'P2'];
    expect(a.texts()).toEqual(expected);
    expect(b.texts()).toEqual(expected);
  });

  test('batched moves, an insertion, and a removal preserve untouched siblings', async () => {
    const a = buildClient();
    const b = buildClient();
    seed(a, 10);
    await syncClients(a, b);
    const before = rootChildren(a);
    const keys = a.editor.read(() => $getRoot().getChildrenKeys());
    a.editor.update(() =>
      $getNodeByKeyOrThrow(keys[4]).insertAfter($getNodeByKeyOrThrow(keys[3])),
    );
    a.editor.update(
      () => {
        $getNodeByKeyOrThrow(keys[6]).insertBefore(
          $getNodeByKeyOrThrow(keys[7]),
        );
        $getNodeByKeyOrThrow(keys[0]).remove();
        $getRoot().append(
          $createParagraphNode().append($createTextNode('new')),
        );
      },
      {discrete: true},
    );
    b.editor.update(
      () => {
        $assertNodeType(
          $assertNodeType(
            $getRoot().getChildAtIndex(4),
            $isElementNode,
          ).getFirstChildOrThrow(),
          $isTextNode,
        ).setTextContent('P4 edited');
        $assertNodeType(
          $assertNodeType(
            $getRoot().getChildAtIndex(6),
            $isElementNode,
          ).getFirstChildOrThrow(),
          $isTextNode,
        ).setTextContent('P6 edited');
      },
      {discrete: true},
    );
    expect(a.binding.collabNodeMap.get(before[4].getKey())).toBe(before[4]);
    expect(a.binding.collabNodeMap.get(before[6].getKey())).toBe(before[6]);
    await syncClients(b, a);
    expect(a.texts()).toEqual([
      'P1',
      'P2',
      'P4 edited',
      'P3',
      'P5',
      'P7',
      'P6 edited',
      'P8',
      'P9',
      'new',
    ]);
    expect(b.texts()).toEqual(a.texts());
  });

  test('restoring an editor state does not reuse movement hints from a different transition', async () => {
    const a = buildClient();
    const b = buildClient();
    seed(a, 6);
    a.editor.update(() => $move(1, 5), {discrete: true});
    const snapshot = a.editor.getEditorState();
    a.editor.update(() => $move(4, 5), {discrete: true});
    await syncClients(a, b);
    const before = rootChildren(a);
    const p1 = before[4];
    a.editor.setEditorState(snapshot);
    expect(a.texts()).toEqual(['P0', 'P2', 'P3', 'P4', 'P5', 'P1']);
    expect(a.binding.collabNodeMap.get(p1.getKey())).toBe(p1);
    expect(
      rootChildren(a).filter(child => !before.includes(child)),
    ).toHaveLength(1);
    await syncClients(a, b);
    expect(b.texts()).toEqual(a.texts());
  });

  test('queued transitions use their own movement hints', async () => {
    const a = buildClient(true);
    const b = buildClient();
    seed(a, 10);
    a.syncPendingUpdates();
    await syncClients(a, b);
    const before = rootChildren(a);

    a.editor.update(() => $move(3, 4), {discrete: true});
    a.editor.update(() => $move(7, 8), {discrete: true});
    a.syncPendingUpdates();

    for (const index of [4, 8]) {
      expect(a.binding.collabNodeMap.get(before[index].getKey())).toBe(
        before[index],
      );
    }
    for (const index of [3, 7]) {
      expect(a.binding.collabNodeMap.get(before[index].getKey())).not.toBe(
        before[index],
      );
    }
    expect(a.texts()).toEqual([
      'P0',
      'P1',
      'P2',
      'P4',
      'P3',
      'P5',
      'P6',
      'P8',
      'P7',
      'P9',
    ]);
    await syncClients(a, b);
    expect(b.texts()).toEqual(a.texts());
  });

  test('bulk reorder snapshots still minimize re-created nodes', async () => {
    const a = buildClient();
    const b = buildClient();
    seed(a, 10);
    await syncClients(a, b);
    const before = rootChildren(a);
    a.editor.update(
      () => {
        const root = $getRoot();
        const children = root.getChildren();
        [children[3], children[4]] = [children[4], children[3]];
        root.splice(0, children.length, children);
      },
      {discrete: true},
    );
    expect(
      rootChildren(a).filter(child => !before.includes(child)),
    ).toHaveLength(1);
    await syncClients(a, b);
    expect(b.texts()).toEqual(a.texts());
  });

  test('undo and redo an adjacent move without losing the shifted sibling edit', async () => {
    const a = buildClient();
    const b = buildClient();
    seed(a, 10);
    await syncClients(a, b);
    const undo = createUndoManager(a.binding, a.binding.root.getSharedType());
    try {
      a.editor.update(() => $move(3, 4), {discrete: true});
      b.editor.update(
        () => {
          $assertNodeType(
            $assertNodeType(
              $getRoot().getChildAtIndex(4),
              $isElementNode,
            ).getFirstChildOrThrow(),
            $isTextNode,
          ).setTextContent('P4 edited');
        },
        {discrete: true},
      );
      await syncClients(a, b);
      const moved = a.texts();
      undo.undo();
      await flush();
      await syncClients(a, b);
      const expected = labels(10);
      expected[4] = 'P4 edited';
      expect(a.texts()).toEqual(expected);
      expect(b.texts()).toEqual(expected);
      undo.redo();
      await flush();
      await syncClients(a, b);
      expect(a.texts()).toEqual(moved);
      expect(b.texts()).toEqual(moved);

      // A subsequent remote edit must still target the live collab node.
      b.editor.update(
        () => {
          $assertNodeType(
            $assertNodeType(
              $getRoot().getChildAtIndex(3),
              $isElementNode,
            ).getFirstChildOrThrow(),
            $isTextNode,
          ).setTextContent('P4 edited again');
        },
        {discrete: true},
      );
      await syncClients(a, b);
      expect(a.texts()[3]).toBe('P4 edited again');
      expect(b.texts()).toEqual(a.texts());
      const restored = buildClient();
      await syncClients(a, restored);
      expect(restored.texts()).toEqual(a.texts());
    } finally {
      undo.destroy();
    }
  });

  test('a concurrent edit to a sibling that shifted position is preserved', async () => {
    const a = buildClient();
    const b = buildClient();
    seed(a, 20);
    await syncClients(a, b);

    // A moves the last paragraph to the front, shifting all the others, while
    // B concurrently types in a paragraph that merely shifts.
    a.editor.update(() => $move(19, 0), {discrete: true});
    b.editor.update(
      () => {
        const paragraph = $assertNodeType(
          $getRoot().getChildAtIndex(7),
          $isElementNode,
        );
        expect($isElementNode(paragraph)).toBe(true);
        $assertNodeType(
          paragraph.getFirstChildOrThrow(),
          $isTextNode,
        ).setTextContent('P7 edited');
      },
      {discrete: true},
    );
    await syncClients(a, b);

    const expected = labels(20);
    expected.unshift(expected.pop()!);
    expected[8] = 'P7 edited';
    expect(a.texts()).toEqual(expected);
    expect(b.texts()).toEqual(expected);
  });

  test('moves combined with inserts and removals converge', async () => {
    const a = buildClient();
    const b = buildClient();
    seed(a, 12);
    await syncClients(a, b);

    a.editor.update(
      () => {
        const root = $getRoot();
        const children = root.getChildren();
        // reverse a run, drop one, add one, and move one to the front
        const next = [
          children[11],
          children[0],
          children[3],
          children[2],
          children[1],
          $createParagraphNode().append($createTextNode('new')),
          children[5],
          children[6],
          children[8],
          children[7],
          children[9],
        ];
        children[4].remove();
        children[10].remove();
        root.splice(0, root.getChildrenSize(), next);
      },
      {discrete: true},
    );
    const expected = [
      'P11',
      'P0',
      'P3',
      'P2',
      'P1',
      'new',
      'P5',
      'P6',
      'P8',
      'P7',
      'P9',
    ];
    expect(a.texts()).toEqual(expected);
    await syncClients(a, b);
    expect(b.texts()).toEqual(expected);
  });
});
