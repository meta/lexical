/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Every update the binding makes is tagged COLLABORATION_TAG: its reads of
// remote changes and its refresh of derived list fields after them, on
// open too. An app's update listener that edits after every change and
// skips that tag (as the documentation advises) acts on users' own edits
// only, so it never writes on every reader.

import {$createListItemNode, $createListNode} from '@lexical/list';
import {
  $createTextNode,
  $getRoot,
  COLLABORATION_TAG,
  type ElementNode,
  HISTORIC_TAG,
} from 'lexical';
import {expect, test} from 'vitest';

import {$p, flush, freshReader, type Peer, setup} from '../utils/harness';

/** The commits a listener following the advice would act on. */
function watch(p: Peer): string[] {
  const seen: string[] = [];
  p.editor.registerUpdateListener(({tags, dirtyElements, dirtyLeaves}) => {
    if (
      tags.has(COLLABORATION_TAG) ||
      tags.has(HISTORIC_TAG) ||
      (dirtyElements.size === 0 && dirtyLeaves.size === 0)
    ) {
      return;
    }
    seen.push([...tags].join('+'));
  });
  return seen;
}

const $list = () =>
  $createListNode('number').append(
    $createListItemNode().append($createTextNode('one')),
    $createListItemNode().append($createTextNode('two')),
  );

test('the reader of a remote list change commits nothing untagged', async () => {
  const {a, b, sync} = await setup(() => {
    $getRoot().append($p('top'), $list());
  });
  const seen = watch(b);
  a.update(() => {
    ($getRoot().getLastChild() as ElementNode).append(
      $createListItemNode().append($createTextNode('three')),
    );
  });
  await sync();
  await flush();
  expect(b.describe()).toContain('three');
  expect(seen).toEqual([]);
});

test("the author's own list edit is still seen", async () => {
  const {a} = await setup(() => {
    $getRoot().append($p('top'), $list());
  });
  const seen = watch(a);
  a.update(() => {
    ($getRoot().getLastChild() as ElementNode).append(
      $createListItemNode().append($createTextNode('three')),
    );
  });
  await flush();
  expect(seen.length).toBeGreaterThan(0);
});

test('opening a document holding a list commits nothing untagged', async () => {
  const {a} = await setup(() => {
    $getRoot().append($p('top'), $list());
  });
  const reader = await freshReader(a);
  const seen = watch(reader);
  // The refresh after the read runs in a later task.
  await flush();
  await flush();
  expect(seen).toEqual([]);
});
