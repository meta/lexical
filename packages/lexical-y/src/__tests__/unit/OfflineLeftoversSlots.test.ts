/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Leftovers (D134) through a wrapper that puts the blocks in a decorator's
// named slot, as Meta Artifacts' collapsible does (a component whose
// `$slots.body` holds them): the output's check reads slots as it reads
// children, so it is written as it is, not replaced by the raw blocks, and
// every block written in a slot gets a new id.

import {
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSlot,
  $getState,
  $isElementNode,
  $setState,
  defineExtension,
  type LexicalNode,
  type SerializedLexicalNode,
} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {createYDoc, yCollab, YCollabExtension} from '../..';
import {
  describeUnsyncedEdits,
  type HeadlessYConfig,
  seedYState,
} from '../../headless';
import {replayUnsyncedEdits, type YLeftoversWrap} from '../../offline';
import {ComponentNode, SLOT_NODES} from '../utils/slots';

const config: HeadlessYConfig = {
  extensions: [BlockIdExtension],
  nodes: SLOT_NODES,
  onWarn: () => {},
  schemaVersion: 1,
};
const live: {dispose(): void}[] = [];
afterEach(() => {
  for (const editor of live.splice(0)) {
    editor.dispose();
  }
});

const $p = (text: string, id: string) =>
  $setState(
    $createParagraphNode().append($createTextNode(text)),
    blockIdState,
    id,
  );
const state = (...blocks: [string, string][]) =>
  seedYState(config, () => {
    $getRoot().append(...blocks.map(([id, text]) => $p(text, id)));
  });

/** A collapsible: a component whose body slot holds the blocks. */
const DETAILS: YLeftoversWrap = blocks => [
  {
    $slots: {
      body: {
        children: blocks.map(block => block.yours),
        direction: null,
        format: '',
        indent: 0,
        type: 'test_slot_body',
        version: 1,
      },
      summary: {
        children: [
          {
            children: [
              {
                detail: 0,
                format: 0,
                mode: 'normal',
                style: '',
                text: 'Offline edits',
                type: 'text',
                version: 1,
              },
            ],
            direction: null,
            format: '',
            indent: 0,
            type: 'paragraph',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        type: 'test_slot_body',
        version: 1,
      },
    },
    type: 'test_component',
    version: 1,
  } as SerializedLexicalNode,
];

function setup() {
  const base = state(['b1', 'one'], ['b2', 'two']);
  const doc = createYDoc(base);
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        BlockIdExtension,
        yCollab({doc, onStatus: () => {}, schemaVersion: 1, synced: true}),
      ],
      name: 'offline-leftovers-slots',
      nodes: SLOT_NODES,
      onError: error => {
        throw error;
      },
      onWarn: () => {},
    }),
  );
  live.push(editor);
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.collab;
  const report = describeUnsyncedEdits({
    base,
    capturedAt: 0,
    config,
    current: base,
    edits: {state: state(['b1', 'one, mine'], ['b2', 'two, mine'])},
    reason: 'stale',
  });
  return {binding, editor, report};
}

test('blocks a wrapper puts in a slot are written as the wrapper returned them, with new ids', () => {
  const {binding, editor, report} = setup();
  const result = replayUnsyncedEdits({
    autoReplay: 'none',
    binding,
    leftovers: {placement: 'top', wrap: DETAILS},
    report,
  });
  expect(result.leftovers.map(place => place.fallback)).toEqual([null]);
  expect(result.leftovers[0].blocks).toEqual(['b1', 'b2']);
  editor.read(() => {
    const host = $getRoot().getFirstChildOrThrow();
    expect(host).toBeInstanceOf(ComponentNode);
    const body = $getSlot(host, 'body')!;
    expect($isElementNode(body)).toBe(true);
    const blocks = $isElementNode(body) ? body.getChildren() : [];
    expect(blocks.map(block => block.getTextContent())).toEqual([
      'one, mine',
      'two, mine',
    ]);
    const ids = blocks.map((block: LexicalNode) =>
      $getState(block, blockIdState),
    );
    for (const id of ids) {
      expect(['b1', 'b2']).not.toContain(id);
    }
    expect(new Set(ids).size).toBe(2);
    expect(
      $getRoot()
        .getChildren()
        .slice(1)
        .map(block => block.getTextContent()),
    ).toEqual(['one', 'two']);
  });
});

test('a wrapper that leaves a block out of its slot falls back to the raw blocks', () => {
  const {binding, report} = setup();
  const result = replayUnsyncedEdits({
    autoReplay: 'none',
    binding,
    leftovers: {
      placement: 'top',
      wrap: (blocks, context) => DETAILS(blocks.slice(0, 1), context),
    },
    report,
  });
  expect(result.leftovers[0].fallback).toMatch(
    /does not hold the text of block b2/,
  );
  expect(result.inserted).toHaveLength(2);
});
