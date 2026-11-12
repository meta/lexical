/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The agent edit sketches of the server page
// (packages/lexical-website/docs/collaboration/y-server.md), as written there
// (with `export` added): `ServerDocsAgentEdits.test.ts` checks that the two
// are the same, and runs them; `BlockHandles.test.ts` uses them as the Block
// IDs page does.

import {$getBlockById, $getBlockId} from '@lexical/extension';
import {
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $getSlotNameWithinHost,
  $isElementNode,
  $isRootNode,
  $isTextNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';

import {
  createYWriter,
  editYState,
  type HeadlessYConfig,
  readYState,
} from '../../headless';

// Once per process.
const agent = createYWriter('Writing assistant');

// Your storage of one document: its latest state and a version, a store
// that succeeds only while the version is unchanged (a compare-and-set), and
// the connected clients.
export interface DocStore {
  load(): Promise<{state: Uint8Array; version: number}>;
  storeIf(version: number, state: Uint8Array): Promise<boolean>;
  send(update: Uint8Array): void;
}

// Runs an agent's edit on the latest stored state. `$check` lists what is
// wrong with the edit there, every part of it checked. `$edit` makes it,
// checking each part again on the state the parts before it leave, and
// lists what failed there (an earlier part changed a later one's target).
// With any failure, from either, nothing is stored or sent: the failures go
// back with the latest state, for the agent's new read. When the store loses
// a race to a newer state, the state and the update computed on the older
// one are dropped, and the check and the edit run again on the newer state,
// `attempts` times at most; then the state that won the last race is loaded
// and returned with no failures (the document kept changing). An update
// computed on an older state is never stored or sent.
export async function applyChecked<F>(
  store: DocStore,
  config: HeadlessYConfig,
  $check: () => F[],
  $edit: () => F[],
  attempts = 3,
): Promise<{failures: F[]; latest: Uint8Array} | null> {
  if (!(attempts >= 1)) {
    throw new RangeError('applyChecked: attempts must be at least 1');
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const {state: latest, version} = await store.load();
    const failures = readYState(latest, config, $check);
    if (failures.length > 0) {
      return {failures, latest};
    }
    let failed: F[] = [];
    const {state, update} = editYState(
      latest,
      config,
      () => {
        failed = $edit();
      },
      {writer: agent},
    );
    if (failed.length > 0) {
      return {failures: failed, latest};
    }
    if (update === null) {
      return null;
    }
    if (await store.storeIf(version, state)) {
      store.send(update);
      return null;
    }
  }
  return {failures: [], latest: (await store.load()).state};
}

// The words `from` in the block with this id: the plain text node that
// holds them and their offset there, or why the edit cannot apply. They must
// occur exactly once in the block's text, and inside one text node (a tab
// does not take text, and a hashtag or a code token would keep its type
// around the new text).
export function $findWords(
  id: string,
  from: string,
): {offset: number; text: TextNode} | string {
  const block = $getBlockById(id);
  if (block === null) {
    return 'the block is gone';
  }
  const all = block.getTextContent();
  const at = all.indexOf(from);
  if (from === '' || at === -1) {
    return 'the words changed';
  }
  if (all.indexOf(from, at + 1) !== -1) {
    return 'the words appear more than once';
  }
  for (const text of $isElementNode(block) ? block.getAllTextNodes() : []) {
    const offset = text.getTextContent().indexOf(from);
    if (offset !== -1) {
      return text.isSimpleText() ? {offset, text} : 'not plain text';
    }
  }
  return 'not in one text node';
}

// Changes a text node's text to `next` with one splice: the start and end
// the two texts share stay (and what collaborators type in them), and
// everything from the first difference to the last is replaced. For an
// answer that changes several separate places, splice each change on its
// own (from a diff of the two texts), so the text between them stays too.
export function $setTextInPlace(text: TextNode, next: string): void {
  const prev = text.getTextContent();
  let start = 0;
  while (start < prev.length && prev[start] === next[start]) {
    start++;
  }
  let end = 0;
  while (
    end < prev.length - start &&
    end < next.length - start &&
    prev[prev.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++;
  }
  text.spliceText(
    start,
    prev.length - start - end,
    next.slice(start, next.length - end),
  );
}

// The text node of a block that this sketch edits in place, or null: the
// block's only child, plain text, and no named slots. A tab does not take
// text, a hashtag or a code token would keep its type around the new text,
// and the text of a named slot is part of the block's text but not of that
// child.
export function $plainTextOf(block: LexicalNode | null): TextNode | null {
  if (
    !$isElementNode(block) ||
    $getSlotNames(block).length > 0 ||
    block.getChildrenSize() !== 1
  ) {
    return null;
  }
  const text = block.getFirstChild();
  return $isTextNode(text) && text.isSimpleText() ? text : null;
}

// A node as a whole: what it exports (its type, text, formats, style and
// NodeState), its children and its named slots, each as a whole.
export function $subtree(node: LexicalNode): unknown {
  const slots: Record<string, unknown> = {};
  for (const name of $getSlotNames(node)) {
    const slot = $getSlot(node, name);
    slots[name] = slot === null ? null : $subtree(slot);
  }
  return {
    ...node.exportJSON(),
    children: $isElementNode(node) ? node.getChildren().map($subtree) : [],
    slots,
  };
}

// Where the block with this id is and all it holds, or null when no block
// has the id: the path from it up to the root (through the hosts of named
// slots), each node on it by its id or, for one without (a table cell, by
// default), by its type, and each by its place: the slot it fills, or its
// index in its parent; and the block as a whole. A collaborator's move of
// the block or of a container it is in changes the path; any change inside
// it (text, a format, a style, a NodeState, a child) changes the rest, as far
// as the server's node classes export it: a stored field that this schema
// no longer declares is not compared.
export function $blockAt(id: string): string | null {
  const block = $getBlockById(id);
  if (block === null) {
    return null;
  }
  const path: unknown[] = [];
  for (
    let node: LexicalNode | null = block;
    node !== null && !$isRootNode(node);
    node = node.getParent() ?? $getSlotHost(node)
  ) {
    path.push([
      $getBlockId(node) ?? node.getType(),
      $getSlotNameWithinHost(node) ?? node.getIndexWithinParent(),
    ]);
  }
  return JSON.stringify([path, $subtree(block)]);
}
