/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A transform registered while the document is open (an app plugin mounted
// after the document was read) that gives every component a default named
// slot: that update writes nothing, and the client reads the component again,
// so it shows the document (no slot), as every other client and a fresh
// reader do (R6-A S2).
// @vitest-environment node

import {
  $create,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $setSlot,
  type LexicalNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {$p, flush, freshReader, type Peer, setup} from '../utils/harness';
import {$all, $body, ComponentNode, SLOT_NODES} from '../utils/slots';

const slotsOf = (peer: Peer) =>
  peer.read(() =>
    $all()
      .filter((n: LexicalNode) => n.getType() === 'test_component')
      .map((n: LexicalNode) =>
        $getSlotNames(n).map(
          name => `${name}:${$getSlot(n, name)?.getTextContent() ?? ''}`,
        ),
      ),
  );

test('a transform registered while the document is open that adds a slot: the editor keeps showing the document', async () => {
  const {a, b, sync} = await setup(
    () => {
      $getRoot().append($p('top'), $create(ComponentNode), $p('end'));
    },
    {nodes: SLOT_NODES},
  );
  b.editor.registerNodeTransform(ComponentNode, node => {
    if ($getSlot(node, 'body') === null) {
      $setSlot(node, 'body', $body($p('default body')));
    }
  });
  await flush();
  await flush();
  await sync();
  const fresh = await freshReader(b, SLOT_NODES);
  expect(slotsOf(fresh)).toEqual([[]]);
  expect(slotsOf(b)).toEqual(slotsOf(fresh));
  expect(slotsOf(a)).toEqual(slotsOf(fresh));
  expect(b.warnings).toEqual([]);
});
