/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Randomized concurrent edits in and around named slots: typing, splits,
// joins, formats and list indents inside slots (a slot holding blocks and
// lists, a one-line slot, an element host's slot next to its children),
// slots added, replaced and removed, hosts inserted, moved and removed, and
// undo. Two or three peers; updates are delivered causally or in sender
// order, and part of them mid-round (a peer edits on a state that has some
// of another peer's updates and not others). Every round, all peers and a
// fresh reader agree (expectConverged also fails on any self-check
// warning). SLOTS_FUZZ_SEEDS runs more seeds.

import {
  $createListNode,
  $isListItemNode,
  type ListItemNode,
} from '@lexical/list';
import * as Y from '@y/y';
import {
  $create,
  $createRangeSelection,
  $getRoot,
  $getSlotNames,
  $isDecoratorNode,
  $isElementNode,
  $isTextNode,
  $removeSlot,
  $setSelection,
  $setSlot,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {$p, expectConverged, type Peer, setup} from '../utils/harness';
import {
  $all,
  $body,
  $component,
  $li,
  CardNode,
  ComponentNode,
  PullQuoteNode,
  SLOT_NODES,
} from '../utils/slots';

const SEEDS = Number(process.env.SLOTS_FUZZ_SEEDS || 16);
const ROUNDS = 5;

/** Blocks that hold only text (the lines a caret can be in). */
function $lines(): ElementNode[] {
  return $all().filter(
    (n): n is ElementNode =>
      $isElementNode(n) &&
      !n.isInline() &&
      n.getChildrenSize() > 0 &&
      n.getChildren().every($isTextNode),
  );
}

/** Nodes that hold slots (or may). */
function $hosts(): LexicalNode[] {
  return $all().filter(
    n =>
      n instanceof ComponentNode ||
      n instanceof PullQuoteNode ||
      n instanceof CardNode,
  );
}

let counter = 0;
const token = (peer: Peer) => `<${peer.doc.clientID}.${++counter}>`;

function $op(peer: Peer, rnd: () => number): void {
  const pick = <T>(list: T[]): T | undefined =>
    list.length === 0 ? undefined : list[Math.floor(rnd() * list.length)];
  const caret = (line: ElementNode, at?: number) => {
    const text = line.getFirstChild();
    if (!$isTextNode(text)) {
      return null;
    }
    const off =
      at !== undefined
        ? at
        : Math.floor(rnd() * (text.getTextContentSize() + 1));
    const sel = $createRangeSelection();
    sel.anchor.set(text.getKey(), off, 'text');
    sel.focus.set(text.getKey(), off, 'text');
    $setSelection(sel);
    return sel;
  };
  const r = rnd();
  const lines = $lines();
  const hosts = $hosts();
  if (r < 0.3) {
    // Type in a line, in a slot or not.
    const line = pick(lines);
    const sel = line && caret(line);
    if (sel) {
      sel.insertText(token(peer));
    }
  } else if (r < 0.4) {
    // Enter (a no-op in a one-line slot).
    const line = pick(lines);
    const sel = line && caret(line);
    if (sel) {
      sel.insertParagraph();
    }
  } else if (r < 0.46) {
    // Join a line into the line before it (what Backspace at its start
    // does; deleteCharacter itself needs a DOM in some places).
    const line = pick(
      lines.filter(l => {
        const prev = l.getPreviousSibling();
        return (
          $isElementNode(prev) &&
          !prev.isInline() &&
          prev.getChildren().every($isTextNode)
        );
      }),
    );
    if (line) {
      $setSelection(null);
      const prev = line.getPreviousSibling() as ElementNode;
      prev.append(...line.getChildren());
      line.remove();
    }
  } else if (r < 0.52) {
    const line = pick(lines);
    const text = line && line.getFirstChild();
    if ($isTextNode(text) && text.getTextContentSize() > 2) {
      const sel = $createRangeSelection();
      sel.anchor.set(text.getKey(), 0, 'text');
      sel.focus.set(text.getKey(), 2, 'text');
      $setSelection(sel);
      sel.formatText('bold');
    }
  } else if (r < 0.56) {
    const item = pick($all().filter($isListItemNode)) as
      | ListItemNode
      | undefined;
    if (item) {
      item.setIndent(Math.floor(rnd() * 2));
    }
  } else if (r < 0.66) {
    // Add or replace a slot: a body of blocks or a one-line slot.
    const host = pick(hosts.filter(h => !(h instanceof CardNode)));
    if (host) {
      $setSelection(null);
      const t = token(peer);
      $setSlot(
        host as ComponentNode,
        pick(['aside', 'note', 'caption', 'body'])!,
        rnd() < 0.5 ? $body($p(t), $p(t + '+')) : $p(t),
      );
    }
  } else if (r < 0.72) {
    const host = pick(hosts.filter(h => !(h instanceof CardNode)));
    const names = host ? $getSlotNames(host) : [];
    if (host && names.length > 1) {
      $setSelection(null);
      $removeSlot(host as ComponentNode, pick(names)!);
    }
  } else if (r < 0.8) {
    // A new host, somewhere among the root's blocks.
    $setSelection(null);
    const t = token(peer);
    const host = $component({
      body: $body($p(t), $createListNode('bullet').append($li(t + 'i'))),
      caption: $p(t + 'c'),
    });
    const at = pick($getRoot().getChildren());
    if (at && rnd() < 0.5) {
      at.insertBefore(host);
    } else {
      $getRoot().append(host);
    }
  } else if (r < 0.85) {
    const host = pick($getRoot().getChildren().filter($isDecoratorNode));
    if (host && $getRoot().getChildrenSize() > 2) {
      $setSelection(null);
      host.remove();
    }
  } else if (r < 0.9) {
    // Move a top-level host.
    const host = pick(
      $getRoot()
        .getChildren()
        .filter(n => $getSlotNames(n).length > 0),
    );
    const at = pick($getRoot().getChildren());
    if (host && at && !at.is(host)) {
      $setSelection(null);
      at.insertAfter(host);
    }
  } else {
    // Remove a line that is not the last of its container.
    const line = pick(
      lines.filter(l => {
        const parent = l.getParent();
        return parent !== null && parent.getChildrenSize() > 1;
      }),
    );
    if (line) {
      $setSelection(null);
      line.remove();
    }
  }
}

function $initial() {
  const quote = $create(PullQuoteNode);
  $setSlot(quote, 'quote', $body($p('Quote q1'), $p('Quote q2')));
  $setSlot(quote, 'attribution', $p('Author a1'));
  const card = $create(CardNode).append($p('Card c1'), $p('Card c2'));
  $setSlot(card, 'title', $p('Title t1'));
  $getRoot().append(
    $p('Top p1'),
    $component({
      body: $body(
        $p('Body b1'),
        $createListNode('bullet').append($li('Item i1'), $li('Item i2')),
        $p('Body b2'),
      ),
      caption: $p('Caption k1'),
    }),
    quote,
    card,
    $p('End p2'),
  );
}

test.each(Array.from({length: SEEDS}, (_, i) => i + 1))(
  'slots seed %i',
  async seed => {
    let x = seed * 2654435761;
    const rnd = () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
    const t = await setup($initial, {
      delivery: seed % 2 ? 'causal' : 'sender',
      ids: seed % 4 === 0 ? [2, 1] : seed % 3 ? [1, 2, 3] : [3, 1, 2],
      nodes: SLOT_NODES,
    });
    for (let round = 0; round < ROUNDS; round++) {
      t.offline();
      for (let step = 0; step < 4; step++) {
        for (const peer of t.peers) {
          if (rnd() < 0.5) {
            continue;
          }
          if (rnd() < 0.08) {
            peer.undo();
          } else {
            peer.update(() => $op(peer, rnd));
          }
        }
        // Part of the updates arrive mid-round: a prefix of one sender's
        // pending updates reaches one receiver.
        if (rnd() < 0.5) {
          const receiver = t.peers[Math.floor(rnd() * t.peers.length)];
          const senders = [...receiver.pending.keys()];
          if (senders.length > 0) {
            const sender = senders[Math.floor(rnd() * senders.length)];
            const list = receiver.pending.get(sender)!;
            const n = 1 + Math.floor(rnd() * list.length);
            for (const update of list.splice(0, n)) {
              Y.applyUpdate(receiver.doc, update, receiver.net);
            }
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
      }
      await t.sync();
      await expectConverged(t.peers);
    }
    for (const peer of t.peers) {
      expect(peer.binding.status).toBe('active');
    }
  },
);
