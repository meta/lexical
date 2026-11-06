/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Block decorators (an image-like widget; a component holding a named slot)
// one client puts into each kind of container that holds blocks: the root, a
// table cell, a named slot's body, and a quote that holds paragraphs (a
// shadow root stored as a line, whose children are stored in it). Every
// client and a fresh reader show the tree the author shows: a block
// decorator in a quote stays a child of the quote, as Lexical's shadow root
// transform leaves it, never wrapped in a paragraph. Applying the change
// writes nothing.

import {$createQuoteNode} from '@lexical/rich-text';
import {$createTableNodeWithDimensions} from '@lexical/table';
import {
  $create,
  $getRoot,
  $getSlot,
  $isElementNode,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {
  $p,
  expectConverged,
  freshReader,
  type Peer,
  setup,
  WidgetNode,
} from '../utils/harness';
import {$body, $caretAt, $component, SLOT_NODES} from '../utils/slots';

/** Updates a client wrote itself (not applied from the network). */
function countWrites(peer: Peer): {count: number} {
  const writes = {count: 0};
  peer.doc.on('update', (_u: Uint8Array, origin: unknown) => {
    if (origin !== peer.net) {
      writes.count++;
    }
  });
  return writes;
}

/** Every block's type, nested, slots included: `type(children)[slots]`. */
function tree(peer: Peer): string {
  return peer.read(() => {
    const visit = (n: LexicalNode): string => {
      if (!$isElementNode(n) && n.isInline()) {
        return n.getType();
      }
      const kids = $isElementNode(n)
        ? n
            .getChildren()
            .filter(c => $isElementNode(c) || !c.isInline())
            .map(visit)
        : [];
      const body = $getSlot(n, 'body');
      return (
        n.getType() +
        (kids.length > 0 ? `(${kids.join(' ')})` : '') +
        (body !== null ? `[${visit(body)}]` : '')
      );
    };
    return $getRoot().getChildren().map(visit).join(' ');
  });
}

type Where = 'root' | 'cell' | 'slot' | 'quote' | 'quote in a cell';

/** The container `where` names, in the document `$initial` builds. */
function $container(where: Where): ElementNode {
  const second = $getRoot().getChildAtIndex(1) as ElementNode;
  switch (where) {
    case 'root':
      return $getRoot();
    case 'cell':
      return $assertNodeType(
        $assertNodeType(
          second.getFirstChildOrThrow(),
          $isElementNode,
        ).getFirstChildOrThrow(),
        $isElementNode,
      );
    case 'slot':
      return $getSlot(second, 'body') as ElementNode;
    case 'quote':
      return second;
    case 'quote in a cell':
      return $assertNodeType(
        $assertNodeType(
          $assertNodeType(
            second.getFirstChildOrThrow(),
            $isElementNode,
          ).getFirstChildOrThrow(),
          $isElementNode,
        ).getFirstChildOrThrow(),
        $isElementNode,
      );
  }
}

function $initial(where: Where): void {
  const quote = () => $createQuoteNode({shadowRoot: true}).append($p('quoted'));
  let second: LexicalNode = $p('second');
  if (where === 'cell' || where === 'quote in a cell') {
    const table = $createTableNodeWithDimensions(1, 1, false);
    const cell = $assertNodeType(
      $assertNodeType(
        table.getFirstChildOrThrow(),
        $isElementNode,
      ).getFirstChildOrThrow(),
      $isElementNode,
    );
    if (where === 'cell') {
      $assertNodeType(cell.getFirstChildOrThrow(), $isElementNode).append(
        $p('celled').getFirstChildOrThrow(),
      );
    } else {
      cell.clear().append(quote());
    }
    second = table;
  } else if (where === 'slot') {
    second = $component({body: $body($p('in the body'))});
  } else if (where === 'quote') {
    second = quote();
  }
  $getRoot().append($p('top'), second, $p('end'));
}

const WHERE: Where[] = ['root', 'cell', 'slot', 'quote', 'quote in a cell'];

describe('block decorators a client puts into a container that holds blocks', () => {
  for (const where of WHERE) {
    for (const what of ['widgets', 'a component with a slot'] as const) {
      test(`${what} into ${where === 'root' ? 'the root' : `a ${where}`}`, async () => {
        const t = await setup(() => $initial(where), {nodes: SLOT_NODES});
        const writesB = countWrites(t.b);
        t.a.update(() => {
          const into = $container(where);
          const after = $p('after');
          if (what === 'widgets') {
            into.append($create(WidgetNode), $create(WidgetNode), after);
          } else {
            into.append($component({body: $body($p('slotted'))}), after);
          }
        });
        const authored = tree(t.a);
        expect(authored).not.toContain('paragraph(test_widget');
        expect(authored).not.toContain('paragraph(test_component');
        await t.sync();
        // The other client showed the decorators in a paragraph here, in a
        // quote.
        expect(tree(t.b)).toBe(authored);
        expect(writesB.count).toBe(0);
        const fresh = await freshReader(t.a, SLOT_NODES);
        const writesFresh = countWrites(fresh);
        expect(tree(fresh)).toBe(authored);
        await expectConverged(t.peers);
        // An edit next to them, by the other client.
        t.b.update(() => {
          $caretAt('after', true).insertText('!');
        });
        await t.sync();
        await expectConverged(t.peers);
        expect(tree(t.a)).toBe(authored);
        expect(writesFresh.count).toBe(0);
      });
    }
  }
});
