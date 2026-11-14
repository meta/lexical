/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// How an application that stores quotes as `quote` adopts QuoteContainerNode
// in its shared documents: it registers the replacement of QuoteNode, bumps
// its schemaVersion, and reseeds each room from the room's JSON (as a server
// that upgrades a document on its first open does). A room written before,
// whose quotes `@lexical/y` stores as lines, cannot be edited through the
// replacement in place: the replacement is a container, stored as a nested
// node. So the room is rebuilt from JSON: `quote` JSON loads as a
// container (a shadow root `quote`'s blocks kept, a plain one's inline
// content in a paragraph, the `shadowRoot` flag dropped, NodeState such as a
// block id kept), and the seed stores it as a container, after which a
// collaborator's typing survives a concurrent Enter or Backspace in it.

import {
  $createQuoteContainerNode,
  QuoteContainerNode,
  QuoteContainerReplacementExtension,
  QuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $getRoot,
  $parseSerializedNode,
  type Klass,
  type LexicalNode,
  type SerializedLexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {STORAGE_MISMATCH_WARNING} from '../../..';
import {readYState, seedYState} from '../../../headless';
import {
  $selectIn,
  expectConverged,
  NODES,
  Peer,
  setup,
} from '../../utils/harness';

const REPLACED_NODES = [
  ...NODES.filter(klass => klass !== QuoteNode),
  QuoteNode,
  QuoteContainerNode,
  {
    replace: QuoteNode,
    with: () => $createQuoteContainerNode(),
    withKlass: QuoteContainerNode,
  },
] as unknown as Klass<LexicalNode>[];

/** A room's JSON head before adoption: two kinds of `quote`. */
const HEAD: SerializedLexicalNode[] = [
  {
    children: [
      {
        detail: 0,
        format: 0,
        mode: 'normal',
        style: '',
        text: 'title',
        type: 'text',
        version: 1,
      },
    ],
    direction: null,
    format: '',
    indent: 0,
    textFormat: 0,
    textStyle: '',
    type: 'paragraph',
    version: 1,
  },
  {
    $: {blockId: 'q1'},
    children: [
      {
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: 'Lorem ipsum',
            type: 'text',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        textFormat: 0,
        textStyle: '',
        type: 'paragraph',
        version: 1,
      },
      {
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: 'dolor',
            type: 'text',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        textFormat: 0,
        textStyle: '',
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: null,
    format: '',
    indent: 0,
    shadowRoot: true,
    type: 'quote',
    version: 1,
  },
  {
    children: [
      {
        detail: 0,
        format: 0,
        mode: 'normal',
        style: '',
        text: 'plain quote',
        type: 'text',
        version: 1,
      },
    ],
    direction: null,
    format: '',
    indent: 0,
    type: 'quote',
    version: 1,
  },
] as unknown as SerializedLexicalNode[];

const CONFIG = {
  extensions: [RichTextExtension, QuoteContainerReplacementExtension],
  onWarn: () => {},
  schemaVersion: 2,
};

function $describe(node: {
  getType(): string;
  getTextContent(): string;
  getChildren?: () => unknown[];
}): string {
  const children = node.getChildren
    ? (node.getChildren() as (typeof node)[])
    : null;
  return children === null
    ? JSON.stringify(node.getTextContent())
    : `${node.getType()}(${children.map($describe).join(' ')})`;
}

describe('adopting QuoteContainerNode: a room reseeded from JSON', () => {
  test('stores every quote as a container, its blocks and NodeState kept, without the shadowRoot flag', () => {
    const state = seedYState(CONFIG, () => {
      $getRoot().append(...HEAD.map(json => $parseSerializedNode(json)));
    });
    const read = readYState(state, CONFIG, () => ({
      json: $getRoot()
        .getChildren()
        .map(child => child.exportJSON()) as unknown as Record<
        string,
        unknown
      >[],
      shape: $getRoot()
        .getChildren()
        .map(child => $describe(child as never))
        .join(' / '),
    }));
    expect(read.shape).toBe(
      'paragraph("title") / quote-container(paragraph("Lorem ipsum") paragraph("dolor")) / quote-container(paragraph("plain quote"))',
    );
    expect(read.json[1]).toMatchObject({
      $: {blockId: 'q1'},
      type: 'quote-container',
    });
    expect(read.json[1]).not.toHaveProperty('shadowRoot');
    expect(read.json[2]).not.toHaveProperty('shadowRoot');
  });

  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`ids ${ids}: Enter in a reseeded quote ‖ typing after the caret keeps the typing in its paragraph`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(...HEAD.map(json => $parseSerializedNode(json)));
        },
        {ids, nodes: REPLACED_NODES},
      );
      const root = t.a.doc.get('lexical-y');
      expect(root.getAttr('k:quote-container')).toBe('nested');
      expect(root.getAttr('k:quote')).toBeUndefined();
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
        'paragraph("title") / quote-container(paragraph("Lorem") paragraph(" ipXYsum") paragraph("dolor")) / quote-container(paragraph("plain quote"))',
      );
    });
  }

  test('without the reseed, a client with the replacement opens a room holding quote lines read only (meta/lexical#9912)', async () => {
    const t = await setup(
      () => {
        $getRoot().append(...HEAD.map(json => $parseSerializedNode(json)));
      },
      {nodes: NODES},
    );
    expect(t.a.doc.get('lexical-y').getAttr('k:quote')).toBe('line');
    const peer = new Peer(
      5,
      {delivery: 'causal', peers: [], pumping: false, queue: []},
      REPLACED_NODES,
    );
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(t.a.doc), 'load');
    peer.binding.initialize();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(peer.binding.status).toBe('readonly');
    expect(
      peer.warningEvents.some(
        (warning: unknown) =>
          (warning as {code?: string}).code === STORAGE_MISMATCH_WARNING,
      ),
    ).toBe(true);
  });
});
