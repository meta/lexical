/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A client whose editor does not register a node type the document holds is
// read only (UNKNOWN_NODE_TYPES_WARNING) and keeps reading remote changes:
// it shows what a fresh reader with its configuration shows, the document
// without those nodes. Such a node's unit has no Lexical node, so it covers
// no children of the container: a read of a region places what it reads
// after the nearest unit before it that covers some, and replaces the
// children of every unit it reads again (S7-18: a paragraph added after such
// a node showed at the top of the editor, and a line merged away next to
// one kept showing).

import {$create, $getRoot, type ElementNode} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $p,
  flush,
  freshReader,
  NODES,
  Peer,
  WidgetNode,
} from '../utils/harness';

/** An editor that does not register WidgetNode (`test_widget`). */
const WITHOUT_WIDGET = NODES.filter(klass => klass !== WidgetNode);

/** B registers every node; A does not register WidgetNode. */
async function peers(build: () => void): Promise<{a: Peer; b: Peer}> {
  const net = {delivery: 'causal', peers: [], pumping: false, queue: []};
  const b = new Peer(2, net as never, NODES);
  const a = new Peer(1, net as never, WITHOUT_WIDGET);
  b.update(() => {
    $getRoot().clear();
    build();
  });
  b.binding.initialize();
  await flush();
  expect(a.binding.status).toBe('readonly');
  return {a, b};
}

async function expectShownAsAFreshReader(a: Peer, expected: string) {
  await flush();
  const fresh = await freshReader(a);
  expect(fresh.describe()).toBe(expected);
  expect(a.describe()).toBe(expected);
}

describe('a client read only for a node type it does not register (S7-18)', () => {
  test('a paragraph added after such a node shows after the content before it', async () => {
    const {a, b} = await peers(() => {
      $getRoot().append($p('one'), $p('two'), $create(WidgetNode));
    });
    b.update(() => {
      $getRoot().append($p('after'));
    });
    expect(b.describe()).toBe(
      'paragraph("one") / paragraph("two") / test_widget / paragraph("after")',
    );
    await expectShownAsAFreshReader(
      a,
      'paragraph("one") / paragraph("two") / paragraph("after")',
    );
  });

  test('paragraphs added between and after two such nodes', async () => {
    const {a, b} = await peers(() => {
      $getRoot().append($p('one'), $create(WidgetNode), $create(WidgetNode));
    });
    b.update(() => {
      const [, first, second] = $getRoot().getChildren();
      first.insertAfter($p('between'));
      second.insertAfter($p('last'));
    });
    await expectShownAsAFreshReader(
      a,
      'paragraph("one") / paragraph("between") / paragraph("last")',
    );
  });

  test('a paragraph added after such a node at the start', async () => {
    const {a, b} = await peers(() => {
      $getRoot().append($create(WidgetNode), $p('one'));
    });
    b.update(() => {
      $getRoot().getFirstChildOrThrow().insertAfter($p('after'));
    });
    await expectShownAsAFreshReader(a, 'paragraph("after") / paragraph("one")');
  });

  test('a line merged away right after such a node, read with it, is gone', async () => {
    const {a, b} = await peers(() => {
      $getRoot().append($p('one'), $create(WidgetNode), $p('two'), $p('three'));
    });
    // One change reads the node's unit again (a line inserted right before
    // it) together with the lines after it (two joined with three).
    b.update(() => {
      const [, widget, two, three] = $getRoot().getChildren() as ElementNode[];
      widget.insertBefore($p('new'));
      two.append(...three.getChildren());
      three.remove();
    });
    expect(b.describe()).toBe(
      'paragraph("one") / paragraph("new") / test_widget / paragraph("twothree")',
    );
    await expectShownAsAFreshReader(
      a,
      'paragraph("one") / paragraph("new") / paragraph("twothree")',
    );
  });
});
