/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A QuoteContainerNode normalizes itself in a transform: an empty container
// gets an empty paragraph, and inline content appended to it (what code
// written for QuoteNode appends) is wrapped in a paragraph. The peers of a
// shared document must agree on the result: the author's transform runs in
// the update that made the change, so one paragraph is stored, and a reader
// has nothing left to normalize.
//
// The second half runs with QuoteNode replaced by QuoteContainerNode on
// every peer, the registration an application uses to have one quote type:
// $createQuoteNode() then makes a container, which is stored as one.

import {
  $createQuoteContainerNode,
  $createQuoteNode,
  $isQuoteContainerNode,
  QuoteContainerNode,
  QuoteNode,
} from '@lexical/rich-text';
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type Klass,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {describeStorage} from '../../../';
import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  NODES as HARNESS_NODES,
  setup,
} from '../../utils/harness';

const NODES = [...HARNESS_NODES, QuoteContainerNode];

// The harness types its nodes as classes; an editor's `nodes` also takes a
// replacement.
const REPLACED_NODES = [
  ...NODES.filter(klass => klass !== QuoteNode),
  {
    replace: QuoteNode,
    with: () => $createQuoteContainerNode(),
    withKlass: QuoteContainerNode,
  },
] as unknown as Klass<LexicalNode>[];

describe('a quote container normalizes itself, and the peers agree', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`ids ${ids}: an empty container inserted by one peer holds one paragraph on both`, async () => {
      const t = await setup(() => $getRoot().append($p('title'), $p('end')), {
        ids,
        nodes: NODES,
      });
      t.a.update(() => {
        $block([0]).insertAfter($createQuoteContainerNode());
      });
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("title") / quote-container(paragraph()) / paragraph("end")',
      );
    });

    test(`ids ${ids}: text appended to a container is in a paragraph on both`, async () => {
      const t = await setup(() => $getRoot().append($p('title')), {
        ids,
        nodes: NODES,
      });
      t.a.update(() => {
        $block([0]).insertAfter(
          $createQuoteContainerNode().append($createTextNode('quoted')),
        );
      });
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("title") / quote-container(paragraph("quoted"))',
      );
    });

    test(`ids ${ids}: both peers empty the same container while offline`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('title'),
            $createQuoteContainerNode().append($p('a'), $p('b')),
          ),
        {ids, nodes: NODES},
      );
      t.offline();
      for (const peer of [t.a, t.b]) {
        peer.update(() => {
          for (const child of $block([1]).getChildren()) {
            child.remove();
          }
        });
      }
      await t.sync();
      // Each peer's transform added a paragraph while offline; the document
      // ends with one.
      await expectConverged(
        t.peers,
        'paragraph("title") / quote-container(paragraph())',
      );
    });

    // A known limit: each peer removes a different paragraph while offline,
    // so neither empties the container locally and neither transform adds
    // one. Reads of remote changes run no transforms (D20), so every peer
    // ends with an empty container. It stays editable: a caret placed in it
    // and typing make the paragraph, on every peer.
    test(`ids ${ids}: each peer removes a different paragraph while offline: the container ends empty, and stays editable`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('title'),
            $createQuoteContainerNode().append($p('a'), $p('b')),
          ),
        {ids, nodes: NODES},
      );
      t.offline();
      t.a.update(() => {
        $block([1, 0]).remove();
      });
      t.b.update(() => {
        $block([1, 1]).remove();
      });
      await t.sync();
      await expectConverged(t.peers, 'paragraph("title") / quote-container()');
      t.a.update(() => {
        $block([1]).selectStart();
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          throw new Error('no range selection');
        }
        selection.insertText('typed');
      });
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("title") / quote-container(paragraph("typed"))',
      );
    });
  }
});

describe('QuoteNode replaced by QuoteContainerNode on every peer', () => {
  test('a quote is stored as a container', async () => {
    const t = await setup(() => $getRoot().append($p('x')), {
      nodes: REPLACED_NODES,
    });
    expect(describeStorage(t.a.editor)[QuoteContainerNode.getType()]).toBe(
      'nested',
    );
  });

  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`ids ${ids}: $createQuoteNode() with text makes a container on both peers`, async () => {
      const t = await setup(() => $getRoot().append($p('title')), {
        ids,
        nodes: REPLACED_NODES,
      });
      t.a.update(() => {
        const quote = $createQuoteNode().append($createTextNode('Lorem ipsum'));
        expect($isQuoteContainerNode(quote)).toBe(true);
        $block([0]).insertAfter(quote);
      });
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("title") / quote-container(paragraph("Lorem ipsum"))',
      );
      // And a split in it keeps a collaborator's typing in its text.
      t.offline();
      t.a.update(() => {
        $selectIn([1, 0], 5).insertParagraph();
      });
      t.b.update(() => {
        $selectIn([1, 0], 8).insertText('XY');
      });
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("title") / quote-container(paragraph("Lorem") paragraph(" ipXYsum"))',
      );
    });
  }
});
