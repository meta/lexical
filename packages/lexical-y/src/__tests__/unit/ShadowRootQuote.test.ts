/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A quote that holds paragraphs (a shadow root, as Meta Artifacts' quote is)
// holds only blocks. One client turns a paragraph into such a quote (the
// paragraph moves into it) while another types into the paragraph: the
// typed text stays at the paragraph's old position (a move, see Limits),
// which is outside the quote: from layout 5 the quote is a container, and a
// move into it behaves as a move into any other container (the box control
// below). Every client and fresh reader show the same, and never text
// directly inside the quote (which apps reading the tree throw on).

import {$createQuoteNode, $isQuoteNode, QuoteNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSlot,
  $isElementNode,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $createBoxNode,
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  type Peer,
  setup,
} from '../utils/harness';
import {$body, $caretAt, $component, SLOT_NODES} from '../utils/slots';

function $moveIntoQuote(
  path: number[],
  $container: () => ElementNode = () => $createQuoteNode({shadowRoot: true}),
) {
  // What a container quote's `> ` shortcut does: the paragraph moves into a
  // new quote in its place.
  const p = $block(path);
  const quote = $container();
  p.insertBefore(quote);
  quote.append(p);
  p.selectEnd();
}

function $replaceWithQuote(path: number[]) {
  // The other way to write it: a new quote with a new paragraph holding the
  // old paragraph's children.
  const p = $block(path);
  const quote = $createQuoteNode({shadowRoot: true});
  const inner = $createParagraphNode();
  for (const child of p.getChildren()) {
    inner.append(child);
  }
  quote.append(inner);
  p.replace(quote);
  inner.selectEnd();
}

/** What each quote holds: block types, and anything else as `!type`. */
function quoteChildren(peer: Peer): string[][] {
  return peer.read(() =>
    $getRoot()
      .getChildren()
      .filter($isQuoteNode)
      .map(q =>
        (q as ElementNode)
          .getChildren()
          .map(c =>
            $isElementNode(c) && !c.isInline()
              ? c.getType()
              : `!${c.getType()}`,
          ),
      ),
  );
}

describe('a quote that holds paragraphs ‖ typing in the paragraph it takes', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    for (const [name, $wrap] of [
      ['moved into the quote', $moveIntoQuote],
      ['replaced by the quote', $replaceWithQuote],
    ] as const) {
      test(`ids ${ids}, ${name}`, async () => {
        const t = await setup(
          () => $getRoot().append($p('one'), $p('Lorem ipsum'), $p('end')),
          {ids},
        );
        t.offline();
        t.a.update(() => $wrap([1]));
        t.b.update(() => {
          $selectIn([1], 5).insertText('qa');
        });
        await t.sync();
        const fresh = await freshReader(t.a);
        for (const peer of [t.a, t.b, fresh]) {
          expect(quoteChildren(peer)).toEqual([['paragraph']]);
        }
        await expectConverged(
          t.peers,
          'paragraph("one") / quote(paragraph("Lorem ipsum")) / paragraph("qaend")',
        );
        // A later edit in the quote's paragraph reaches every client.
        t.b.update(() => {
          $selectIn([1, 0], 2).insertText('!');
        });
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.read(() => $getRoot().getTextContent())).toContain('Lo!rem');
      });
    }
    test(`ids ${ids}, control: moved into a box`, async () => {
      const t = await setup(
        () => $getRoot().append($p('one'), $p('Lorem ipsum'), $p('end')),
        {ids},
      );
      t.offline();
      t.a.update(() => $moveIntoQuote([1], () => $createBoxNode()));
      t.b.update(() => {
        $selectIn([1], 5).insertText('qa');
      });
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("one") / test_box(paragraph("Lorem ipsum")) / paragraph("qaend")',
      );
    });
  }
});

// The same quote in a named slot (Meta Artifacts' details body). The binding
// enforces node structure, which turns core's shadow root transform off and
// normalizes from the root down, never reaching a named slot: the binding
// wraps a slot's shadow root's inline children itself, so the author shows
// the paragraph every reader shows (the stored text is a line without a
// marker), and never text directly inside the quote.

/** The quote's children in the component's `body` slot, as quoteChildren. */
function slotQuoteChildren(peer: Peer): string[][] {
  return peer.read(() => {
    const body = $getSlot($getRoot().getChildAtIndex(1)!, 'body');
    return ((body as ElementNode | null)?.getChildren() ?? [])
      .filter($isQuoteNode)
      .map(q =>
        (q as ElementNode)
          .getChildren()
          .map(c =>
            $isElementNode(c) && !c.isInline()
              ? c.getType()
              : `!${c.getType()}`,
          ),
      );
  });
}

function $bodyParagraph(): ElementNode {
  const body = $getSlot($getRoot().getChildAtIndex(1)!, 'body') as ElementNode;
  return $assertNodeType(body.getFirstChildOrThrow(), $isElementNode);
}

/** What the `> ` shortcut does (@lexical/markdown's QUOTE): an inline quote
 *  takes the paragraph's children and replaces it. An app transform then
 *  makes every quote a shadow root (Meta Artifacts' DocCoreExtension). */
function $shortcutQuote(p: LexicalNode): void {
  const quote = $createQuoteNode();
  quote.append(...(p as ElementNode).getChildren());
  p.replace(quote);
}

function quotesHoldParagraphs(peer: Peer): () => void {
  return peer.editor.registerNodeTransform(QuoteNode, quote => {
    if (!quote.isShadowRoot()) {
      quote.setIsShadowRoot(true);
    }
  });
}

describe('a paragraph in a named slot made a quote that holds paragraphs', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`ids ${ids}, the \`> \` shortcut, an app transform: the author shows the paragraph`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('top'),
            $component({body: $body($p('In the body'))}),
            $p('end'),
          ),
        {ids, nodes: SLOT_NODES},
      );
      for (const peer of t.peers) {
        quotesHoldParagraphs(peer);
      }
      t.a.update(() => {
        $shortcutQuote($bodyParagraph());
      });
      // The author held {"quote":["text:In the body"]} here.
      expect(slotQuoteChildren(t.a)).toEqual([['paragraph']]);
      await t.sync();
      const fresh = await freshReader(t.a, SLOT_NODES);
      for (const peer of [t.a, t.b, fresh]) {
        expect(slotQuoteChildren(peer)).toEqual([['paragraph']]);
      }
      await expectConverged(t.peers);
      // The paragraph is stored: an edit in it reaches the other client.
      t.b.update(() => {
        $caretAt('body', true).insertText('!');
      });
      await t.sync();
      await expectConverged(t.peers);
      expect(slotQuoteChildren(t.a)).toEqual([['paragraph']]);
      expect(t.a.read(() => $bodyParagraph().getTextContent())).toBe(
        'In the body!',
      );
    });

    test(`ids ${ids}, a quote holding text replaces the paragraph ‖ typing in it`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('top'),
            $component({body: $body($p('Lorem ipsum'))}),
            $p('end'),
          ),
        {ids, nodes: SLOT_NODES},
      );
      t.offline();
      t.a.update(() => {
        const p = $bodyParagraph();
        const quote = $createQuoteNode({shadowRoot: true});
        quote.append(...p.getChildren());
        p.replace(quote);
      });
      expect(slotQuoteChildren(t.a)).toEqual([['paragraph']]);
      t.b.update(() => {
        $caretAt('ipsum').insertText('qa');
      });
      await t.sync();
      const fresh = await freshReader(t.a, SLOT_NODES);
      for (const peer of [t.a, t.b, fresh]) {
        const quotes = slotQuoteChildren(peer);
        expect(quotes.length).toBe(1);
        expect(quotes[0].every(c => c === 'paragraph')).toBe(true);
      }
      await expectConverged(t.peers);
      // The typed text stays at the paragraph's old position (a move, see
      // Limits): in the body, in a paragraph of its own after the quote.
      expect(
        t.a.read(() =>
          ($getSlot($getRoot().getChildAtIndex(1)!, 'body') as ElementNode)
            .getChildren()
            .map(c => `${c.getType()}:${c.getTextContent()}`),
        ),
      ).toEqual(['quote:Lorem ipsum', 'paragraph:qa']);
    });
  }
});

// Turning `shadowRoot` on or off for a quote that exists changes how it is
// stored (a container of lines, or a line): the binding writes it as a
// replace in place, as it writes a type change. Every client and a fresh
// reader show the same quote, its text kept, and the store holds the shape
// the new state stores.
describe('turning a quote shadow root on or off', () => {
  const stored = (peer: Peer): string[] =>
    (peer.binding.root.toArray() as unknown[])
      .filter(c => c instanceof Y.Node)
      .map(c => (c as Y.Node).name ?? '');
  test('on: a quote that holds text becomes a container of its paragraph', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $p('one'),
        $createQuoteNode().append($createTextNode('Lorem ipsum')),
        $p('end'),
      ),
    );
    expect(stored(t.a)).not.toContain('b:quote');
    t.a.update(() => {
      ($block([1]) as QuoteNode).setIsShadowRoot(true);
    });
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("one") / quote(paragraph("Lorem ipsum")) / paragraph("end")',
    );
    expect(stored(t.a)).toContain('b:quote');
    // An edit in the quote's paragraph reaches the other client.
    t.b.update(() => {
      $selectIn([1, 0], 5).insertText('!');
    });
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("one") / quote(paragraph("Lorem! ipsum")) / paragraph("end")',
    );
  });
  test('off: a quote that holds a paragraph becomes a line', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $p('one'),
        $createQuoteNode({shadowRoot: true}).append($p('Lorem ipsum')),
        $p('end'),
      ),
    );
    expect(stored(t.a)).toContain('b:quote');
    t.a.update(() => {
      const quote = $block([1]) as QuoteNode;
      quote.setIsShadowRoot(false);
      const inner = quote.getFirstChildOrThrow() as ElementNode;
      quote.append(...inner.getChildren());
      inner.remove();
    });
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("one") / quote("Lorem ipsum") / paragraph("end")',
    );
    expect(stored(t.a)).not.toContain('b:quote');
  });
});
