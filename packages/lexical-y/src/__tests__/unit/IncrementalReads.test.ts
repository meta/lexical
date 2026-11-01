/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// What a client shows after an incremental read, or after its own write,
// equals what a fresh reader of the document shows: a list item whose
// first child changes between a nested list and text renumbers its list,
// a list its author changes without transforms is renumbered before the
// author's normalization runs, and a link an author holds inside another
// link (which the document stores as one link per character) is shown as
// stored.

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createLinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
} from '@lexical/list';
import * as Y from '@y/y';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setCompositionKey,
  configExtension,
  defineExtension,
  type ElementNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension, type YDoc} from '../..';
import {
  $p,
  expectConverged,
  flush,
  freshReader,
  NODES,
  type Peer,
  setup,
} from '../utils/harness';

function reader(doc: YDoc) {
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: false,
        }),
      ],
      name: 'numbering',
      nodes: NODES,
      onError: e => {
        throw e;
      },
    }),
  );
  getExtensionDependencyFromEditor(editor, YCollabExtension);
  return editor;
}

test('text typed before the nested list a first item holds renumbers the list, as a fresh read does', async () => {
  // A numbered list stored by a client of the legacy layout: its first item
  // holds a list stored as its own node and nothing else; values 1, 1.
  const doc = new Y.Doc({gc: false});
  doc.clientID = 7;
  const root = doc.get('lexical-y');
  const nested = new Y.Node('i:list');
  doc.transact(() => {
    root.setAttr('lexical-y:1', true);
    root.setAttr('k:list', 'group|listType');
    root.setAttr('k:listitem', 'line');
    root.insert(0, [nested]);
    nested.setAttr('c', 'b');
    nested.setAttr('p:listType', 'number');
    nested.insert(0, 'nested');
    const inner = new Y.Node('¶');
    nested.insert(6, [inner]);
    inner.setAttr('t', 'listitem');
    const first = new Y.Node('¶');
    root.insert(1, [first]);
    first.setAttr('t', 'listitem');
    first.setAttr('g', 'list');
    first.setAttr('g:listType', 'number');
    root.insert(2, 'later');
    const last = new Y.Node('¶');
    root.insert(7, [last]);
    last.setAttr('t', 'listitem');
    last.setAttr('g', 'list');
    last.setAttr('g:listType', 'number');
  });
  const copy = createYDoc(null, {gc: false});
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const live = reader(copy);
  await flush();
  const sv = Y.encodeStateVector(copy);
  // Another client types before the nested list.
  root.insert(0, 'prefix');
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc, sv), 'net');
  await flush();
  const freshDoc = createYDoc(null, {gc: false});
  Y.applyUpdate(freshDoc, Y.encodeStateAsUpdate(copy));
  const fresh = reader(freshDoc);
  await flush();
  expect(live.getEditorState().toJSON()).toEqual(
    fresh.getEditorState().toJSON(),
  );
  live.dispose();
  fresh.dispose();
});

test('an author that holds a link inside a link shows what is stored', async () => {
  const {a, b, sync} = await setup(() => {
    $getRoot().append($p('start'));
  });
  // Without transforms (as raw code applies an update): nothing unwraps the
  // inner link before it is written.
  a.editor.update(
    () => {
      ($getRoot().getFirstChild() as ElementNode).append(
        $createLinkNode('https://example.test/0').append(
          $createTextNode('outer'),
          $createLinkNode('https://example.test/2').append(
            $createTextNode('inner'),
          ),
        ),
      );
    },
    {discrete: true, skipTransforms: true},
  );
  await flush();
  await sync();
  await flush();
  const fresh = await freshReader(a);
  expect(a.json()).toEqual(fresh.json());
  await expectConverged([a, b]);
});

test("a list its author changes without transforms while composing is numbered as a fresh reader numbers it, before the author's normalization runs", async () => {
  const {a, b, sync} = await setup(() => {
    $getRoot().append(
      $p('compose'),
      $createListNode('number').append(
        $createListItemNode().append($createTextNode('one')),
        $createListItemNode().append($createTextNode('two')),
      ),
    );
  });
  const $list = () =>
    $assertNodeType($getRoot().getLastChildOrThrow(), $isListNode);
  const values = (peer: Peer) =>
    peer.read(() =>
      $list()
        .getChildren()
        .map(node => $assertNodeType(node, $isListItemNode))
        .map(item => item.getValue()),
    );
  // The author's normalization of an update that ran no transforms waits
  // for the composition to end; the refresh of the groups it changed does
  // not.
  a.editor.update(
    () => {
      const text = $assertNodeType(
        $assertNodeType(
          $getRoot().getFirstChildOrThrow(),
          $isElementNode,
        ).getFirstChildOrThrow(),
        $isTextNode,
      );
      text.select(7, 7);
      $setCompositionKey(text.getKey());
    },
    {discrete: true},
  );
  // An item inserted first without transforms (as raw code applies an
  // update): the list's own transforms do not renumber its items.
  a.editor.update(
    () => {
      $list()
        .getFirstChildOrThrow()
        .insertBefore($createListItemNode().append($createTextNode('zero')));
    },
    {discrete: true, skipTransforms: true},
  );
  await flush();
  const fresh = await freshReader(a);
  expect(values(fresh)).toEqual([1, 2, 3]);
  expect(values(a)).toEqual([1, 2, 3]);
  a.editor.update(() => $setCompositionKey(null), {discrete: true});
  await flush();
  await sync();
  expect(values(a)).toEqual([1, 2, 3]);
  expect(values(b)).toEqual([1, 2, 3]);
  await expectConverged([a, b]);
});
