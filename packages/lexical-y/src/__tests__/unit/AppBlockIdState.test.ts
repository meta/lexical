/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// An app that keeps its own block ids as NodeState named `blockId` (its own
// StateConfig, without BlockIdExtension). Lexical allows one StateConfig per
// key on a node class, so the binding must never touch BlockIdExtension's
// `blockIdState` where the editor has no BlockIdExtension: the app's state is
// NodeState like any other, stored and read back as it is, on lists (whose
// state their items carry) too. This file uses no BlockIdExtension, so that
// its node classes never meet `blockIdState`.

import {
  $createListItemNode,
  $createListNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $isElementNode,
  $setState,
  createEditor,
  createState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';

/** The app's own id state: BlockIdExtension's key, its own config. */
const appBlockId = createState('blockId', {
  parse: (v: unknown) => (typeof v === 'string' ? v : undefined),
});

type Client = {
  binding: YBinding;
  doc: Y.Doc;
  editor: LexicalEditor;
  errors: string[];
  warnings: string[];
  writes: number[];
};

const NET = 'net';

function client(id: number, state: Uint8Array | null = null): Client {
  const doc = createYDoc();
  doc.clientID = id;
  if (state !== null) {
    Y.applyUpdate(doc, state, NET);
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const writes: number[] = [];
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== NET) {
      writes.push(u.length);
    }
  });
  const editor = createEditor({
    namespace: 'app-block-id',
    nodes: [ParagraphNode, TextNode, ListNode, ListItemNode],
    onError: e => {
      errors.push(e.message);
    },
    onWarn: e => {
      warnings.push(String(e && (e as Error).message));
    },
  });
  const binding = new YBinding(editor, doc, {
    schemaVersion: 1,
    selfCheck: true,
  });
  binding.start();
  return {binding, doc, editor, errors, warnings, writes};
}

function sync(from: Client, to: Client): void {
  Y.applyUpdate(
    to.doc,
    Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
    NET,
  );
}

/** Every block with the app's id on it, as `type:id`, in document order. */
function appIds(c: Client): string[] {
  return c.editor.read(() => {
    const out: string[] = [];
    const visit = (n: LexicalNode) => {
      if (n.getType() !== 'root' && $isElementNode(n)) {
        out.push(`${n.getType()}:${$getState(n, appBlockId) ?? '-'}`);
      }
      if ($isElementNode(n)) {
        n.getChildren().forEach(visit);
      }
    };
    visit($getRoot());
    return out;
  });
}

function json(c: Client): string {
  return JSON.stringify(c.editor.getEditorState().toJSON());
}

function $build(): void {
  const intro = $createParagraphNode().append($createTextNode('intro'));
  const nested = $createListNode('bullet').append(
    $createListItemNode().append($createTextNode('inner')),
  );
  const list = $createListNode('bullet').append(
    $createListItemNode().append($createTextNode('one')),
    $createListItemNode().append(nested),
    $createListItemNode().append($createTextNode('two')),
  );
  $setState(intro, appBlockId, 'app-1');
  $setState(list, appBlockId, 'app-2');
  // A nested list with its parent list's id: the app's state, kept as is.
  $setState(nested, appBlockId, 'app-2');
  $getRoot().clear().append(intro, list);
}

const WANT = [
  'paragraph:app-1',
  'list:app-2',
  'listitem:-',
  'listitem:-',
  'list:app-2',
  'listitem:-',
  'listitem:-',
];

describe("an app's own blockId NodeState, without BlockIdExtension", () => {
  test('every client and a fresh reader show it, nested lists included', () => {
    const a = client(1);
    a.editor.update($build, {discrete: true});
    a.binding.initialize();
    // The binding's transform on lists threw here: "State key collision
    // "blockId" detected in ListNode".
    expect(a.errors).toEqual([]);
    expect(appIds(a)).toEqual(WANT);
    const b = client(2, Y.encodeStateAsUpdate(a.doc));
    b.binding.initialize();
    expect(b.errors).toEqual([]);
    expect(appIds(b)).toEqual(WANT);
    expect(json(b)).toBe(json(a));
    expect(b.writes).toEqual([]);
    for (const c of [a, b]) {
      expect(c.errors).toEqual([]);
      expect(c.warnings).toEqual([]);
    }
  });

  test("edits of lists that hold it keep it, on the author's editor and in the document", () => {
    const a = client(1);
    a.editor.update($build, {discrete: true});
    a.binding.initialize();
    const b = client(2, Y.encodeStateAsUpdate(a.doc));
    b.binding.initialize();
    // The author's transforms on lists run (an item added to each list),
    // and the app sets its id on a new nested list.
    a.editor.update(
      () => {
        const list = $getRoot().getChildAtIndex(1) as ElementNode;
        list.append($createListItemNode().append($createTextNode('three')));
        const nested = (
          list.getChildAtIndex(1) as ElementNode
        ).getFirstChild() as ElementNode;
        nested.append($createListItemNode().append($createTextNode('deeper')));
        const more = $createListNode('number').append(
          $createListItemNode().append($createTextNode('more')),
        );
        $setState(more, appBlockId, 'app-3');
        $getRoot().append(more);
      },
      {discrete: true},
    );
    sync(a, b);
    // And a peer edits a list item in reply.
    b.editor.update(
      () => {
        const last = $getRoot().getLastChildOrThrow() as ElementNode;
        expect($isListNode(last)).toBe(true);
        last.append($createListItemNode().append($createTextNode('reply')));
      },
      {discrete: true},
    );
    sync(b, a);
    const fresh = client(3, Y.encodeStateAsUpdate(a.doc));
    fresh.binding.initialize();
    const want = [
      'paragraph:app-1',
      'list:app-2',
      'listitem:-',
      'listitem:-',
      'list:app-2',
      'listitem:-',
      'listitem:-',
      'listitem:-',
      'listitem:-',
      'list:app-3',
      'listitem:-',
      'listitem:-',
    ];
    for (const c of [a, b, fresh]) {
      expect(appIds(c)).toEqual(want);
      expect(json(c)).toBe(json(a));
      expect(c.errors).toEqual([]);
      expect(c.warnings).toEqual([]);
    }
    expect(fresh.writes).toEqual([]);
  });
});
