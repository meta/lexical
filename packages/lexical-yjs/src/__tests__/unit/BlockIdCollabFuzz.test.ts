/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Deterministic randomized test of BlockIdExtension over @lexical/yjs: two or
// three peers type, split, join, duplicate, change block types, move blocks,
// undo and redo, with random partitions. After every run all peers must hold
// the same document, every top-level block must have an id, the ids must be
// unique, nothing must change any more, and blocks that were never split,
// merged, copied, or restructured concurrently must keep the ids they started
// with. Even seeds start from a document stored without ids that every peer
// opens at the same time: the peers must name its blocks alike (by place, as
// a headless reader does) and leave nothing to repair when they meet.
//
// The nested runs add list conversions, indents and outdents, so that list
// items (identified by default) and nested lists (not identified) are split,
// joined, moved and restructured concurrently too; every identified block,
// nested or not, must then have a unique id.
//
// CI runs a few seeds per binding; set BLOCK_ID_FUZZ_SEEDS (and optionally
// BLOCK_ID_FUZZ_FIRST_SEED) to run more locally.

import {$defaultIsIdentifiedBlock, $getBlockId} from '@lexical/extension';
import {INSERT_UNORDERED_LIST_COMMAND} from '@lexical/list';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  INDENT_CONTENT_COMMAND,
  type LexicalNode,
  OUTDENT_CONTENT_COMMAND,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {
  $block,
  $caretAt,
  $deepCopy,
  $enter,
  $join,
  $type,
  type CollabVersion,
  Network,
  type Peer,
  readIds,
} from './utils/blockIdPeers';

const SEEDS = Number(process.env.BLOCK_ID_FUZZ_SEEDS || 8);
const FIRST_SEED = Number(process.env.BLOCK_ID_FUZZ_FIRST_SEED || 1);
const STEPS = 40;
// Local diagnostics only: build the peers without BlockIdExtension and check
// convergence alone, to tell binding issues from block id issues.
const CONTROL = process.env.BLOCK_ID_FUZZ_CONTROL === '1';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let network: Network | null = null;
afterEach(() => {
  if (network) {
    network.dispose();
    network = null;
  }
});

interface BlockInfo {
  id: string | null;
  text: string;
}

function readBlocks(peer: Peer): BlockInfo[] {
  return peer.blocks().map(entry => {
    const [, ...rest] = entry.split(':');
    const id = rest.pop()!;
    return {id: id === 'null' ? null : id, text: rest.join(':')};
  });
}

/**
 * Every identified block (default predicate), nested or not, with its own
 * text: that of its inline children, without the blocks nested in it.
 */
function readNestedBlocks(peer: Peer): BlockInfo[] {
  return peer.editor.read(() => {
    const out: BlockInfo[] = [];
    const walk = (node: LexicalNode) => {
      if ($defaultIsIdentifiedBlock(node)) {
        out.push({
          id: $getBlockId(node),
          text: $isElementNode(node)
            ? node
                .getChildren()
                .filter(child => !$isElementNode(child) || child.isInline())
                .map(child => child.getTextContent())
                .join('')
            : node.getTextContent(),
        });
      }
      if ($isElementNode(node)) {
        node.getChildren().forEach(walk);
      }
    };
    $getRoot().getChildren().forEach(walk);
    return out;
  });
}

const OPS = [
  'type',
  'type',
  'enter',
  'enter',
  'join',
  'duplicate',
  'retype',
  'move',
  'undo',
  'redo',
  'partition',
  'sync',
  'sync',
] as const;
const NESTED_OPS = [...OPS, 'list', 'list', 'indent', 'outdent'] as const;

function run(
  version: CollabVersion,
  seed: number,
  log: string[],
  nested = false,
): void {
  const rng = mulberry32(seed * 7919 + version);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(rng() * items.length)];
  const int = (n: number) => Math.floor(rng() * n);

  network = new Network(version);
  const net = network;
  const names = rng() < 0.5 ? ['a', 'b'] : ['a', 'b', 'c'];
  const peers = names.map(name => net.add(name, {withoutBlockIds: CONTROL}));
  const initialCount = 3 + int(4);
  const $seed = () => {
    $getRoot()
      .clear()
      .append(
        ...Array.from({length: initialCount}, (_, i) =>
          $createParagraphNode().append($createTextNode(`M${i} text`)),
        ),
      );
  };
  // Even seeds start from a document written without ids (by a client
  // without the extension), which every peer opens at the same time.
  const legacy = seed % 2 === 0;
  log.push(legacy ? 'document stored without ids' : 'seeded by a');
  if (legacy) {
    const old = net.add('o', {withoutBlockIds: true});
    old.update($seed);
    old.online = false;
    for (const peer of peers) {
      peer.online = false;
      net.deliver(old, peer);
    }
    const repairs = peers.map(peer => peer.repairs);
    if (!CONTROL) {
      // Each peer named the blocks by their place before seeing the others,
      // as a headless reader of the stored document does.
      const stored = readIds(old.json());
      for (const peer of peers) {
        expect(readBlocks(peer).map(block => block.id)).toEqual(stored);
      }
    }
    for (const peer of peers) {
      peer.online = true;
    }
    net.sync();
    // Their writes agree: the merge leaves nothing to repair.
    expect(peers.map(peer => peer.repairs)).toEqual(repairs);
  } else {
    peers[0].update($seed);
    net.sync();
  }
  // The initial document is not an undoable edit of peer a.
  for (const peer of peers) {
    peer.undoManager.clear();
  }
  const marker = new Map<string, string>();
  readBlocks(peers[0]).forEach((block, i) =>
    marker.set(block.id || `#${i}`, `M${i} `),
  );

  // Ids whose stability is not claimed: split, merged, copied, or touched by
  // restructuring ops of two peers between full syncs, or reachable by an
  // undo/redo of a peer that touched them.
  const tainted = new Set<string>();
  const touchedBy = new Map<string, Set<string>>();
  let epochOps = new Map<string, Set<string>>();
  const touch = (peer: Peer, id: string | null, restructure: boolean) => {
    if (id === null) {
      return;
    }
    let ids = touchedBy.get(peer.name);
    if (!ids) {
      ids = new Set();
      touchedBy.set(peer.name, ids);
    }
    ids.add(id);
    if (restructure) {
      let who = epochOps.get(id);
      if (!who) {
        who = new Set();
        epochOps.set(id, who);
      }
      who.add(peer.name);
      if (who.size > 1) {
        tainted.add(id);
      }
    }
  };

  for (let step = 0; step < STEPS; step++) {
    const peer = pick(peers);
    const blocks = readBlocks(peer);
    const n = blocks.length;
    const i = int(n);
    const op = pick(nested ? NESTED_OPS : OPS);
    log.push(
      `${step} ${peer.name}${peer.online ? '' : '(off)'} ${op} @${i} ${JSON.stringify(peer.blocks())}`,
    );
    // The ids of block `index` and, in nested runs, of the blocks inside it,
    // read before the op.
    const insideIds = (index: number): (string | null)[] =>
      nested
        ? peer.editor.read(() => {
            const out: (string | null)[] = [];
            const walk = (node: LexicalNode) => {
              if ($defaultIsIdentifiedBlock(node)) {
                out.push($getBlockId(node));
              }
              if ($isElementNode(node)) {
                node.getChildren().forEach(walk);
              }
            };
            walk($block(index));
            return out;
          })
        : [blocks[index].id];
    const groups = new Map<number, (string | null)[]>();
    const within = (index: number) => {
      let ids = groups.get(index);
      if (ids === undefined) {
        ids = insideIds(index);
        groups.set(index, ids);
      }
      return ids;
    };
    const touchAll = (ids: (string | null)[], restructure: boolean) =>
      ids.forEach(id => touch(peer, id, restructure));
    within(i);
    if (i > 0) {
      within(i - 1);
    }
    const taintAll = (ids: (string | null)[]) => {
      for (const id of ids) {
        if (id) {
          tainted.add(id);
        }
      }
      touchAll(ids, true);
    };
    switch (op) {
      case 'type': {
        const text = blocks[i].text;
        const minOffset = Math.min(text.length, 3);
        const offset = minOffset + int(text.length - minOffset + 1);
        peer.update(() => $type(i, offset, pick(['x', 'yy', ' z'])));
        touchAll(within(i), false);
        break;
      }
      case 'enter': {
        const offset = int(blocks[i].text.length + 1);
        peer.update(() => $enter(peer.editor, i, offset));
        taintAll(within(i));
        break;
      }
      case 'join': {
        if (i === 0) {
          break;
        }
        peer.update(() => $join(peer.editor, i));
        taintAll([...within(i), ...within(i - 1)]);
        break;
      }
      case 'duplicate': {
        const target = int(n);
        const before = rng() < 0.5;
        peer.update(() => {
          const copy = $deepCopy($block(i));
          if (before) {
            $block(target).insertBefore(copy);
          } else {
            $block(target).insertAfter(copy);
          }
        });
        taintAll(within(i));
        break;
      }
      case 'retype': {
        const kind = pick(['h1', 'h2', 'quote', 'paragraph'] as const);
        peer.update(() => {
          $caretAt(i, 0);
          $setBlocksType($getSelection(), () =>
            kind === 'quote'
              ? $createQuoteNode()
              : kind === 'paragraph'
                ? $createParagraphNode()
                : $createHeadingNode(kind),
          );
        });
        touchAll(within(i), true);
        break;
      }
      case 'move': {
        const target = int(n);
        if (target === i) {
          break;
        }
        peer.update(() => {
          $block(target).insertAfter($block(i));
        });
        touchAll(within(i), true);
        break;
      }
      case 'list': {
        peer.update(() => {
          $caretAt(i, int(blocks[i].text.length + 1));
          peer.editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
        });
        touchAll(within(i), true);
        break;
      }
      case 'indent':
      case 'outdent': {
        peer.update(() => {
          $caretAt(i, int(blocks[i].text.length + 1));
          peer.editor.dispatchCommand(
            op === 'indent' ? INDENT_CONTENT_COMMAND : OUTDENT_CONTENT_COMMAND,
            undefined,
          );
        });
        touchAll(within(i), true);
        break;
      }
      case 'undo':
      case 'redo': {
        for (const id of touchedBy.get(peer.name) || []) {
          tainted.add(id);
        }
        if (op === 'undo') {
          peer.undo();
        } else {
          peer.redo();
        }
        break;
      }
      case 'partition': {
        peer.online = !peer.online;
        break;
      }
      case 'sync': {
        net.sync();
        if (peers.every(p => p.online)) {
          epochOps = new Map();
        }
        break;
      }
    }
  }

  for (const peer of peers) {
    peer.online = true;
  }
  net.sync();
  for (const peer of peers) {
    log.push(`final ${peer.name} ${JSON.stringify(peer.blocks())}`);
  }
  log.push(`tainted ${[...tainted].join(',')}`);

  // Convergence.
  const json = peers[0].json();
  for (const peer of peers.slice(1)) {
    expect(peer.json(), `${peer.name} diverged`).toEqual(json);
  }
  if (CONTROL) {
    return;
  }
  // Every block has an id, and ids are unique.
  const final = nested ? readNestedBlocks(peers[0]) : readBlocks(peers[0]);
  const ids = final.map(block => block.id);
  expect(ids).not.toContain(null);
  expect(new Set(ids).size).toBe(ids.length);
  // Quiescent: one more round of local commits and syncing changes nothing.
  const before = peers.map(peer => peer.localYjsUpdates);
  for (const peer of peers) {
    peer.update(() => $getRoot().markDirty());
  }
  expect(net.sync()).toBe(0);
  expect(peers.map(peer => peer.localYjsUpdates)).toEqual(before);
  // Stability: an untainted block whose content survived (its marker starts
  // exactly one block) still has the id it started with. A block whose
  // content the binding itself lost or rewrote is not something block ids
  // can be judged on, so it is only logged.
  const stable: string[] = [];
  for (const [id, prefix] of marker) {
    if (tainted.has(id)) {
      continue;
    }
    const holders = final.filter(block => block.text.startsWith(prefix));
    if (holders.length !== 1) {
      log.push(`content of ${id} (${prefix.trim()}) did not survive`);
      continue;
    }
    stable.push(id);
    expect(holders[0].id, `${prefix.trim()} keeps ${id}`).toBe(id);
  }
  log.push(`stable: ${stable.join(',')}`);
}

describe.each([
  [1, false],
  [2, false],
  [1, true],
  [2, true],
] as const)(
  'BlockIdExtension fuzz, @lexical/yjs v%s, nested %s',
  (v, nested) => {
    for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
      test(`seed ${seed}`, () => {
        const log: string[] = [];
        try {
          run(v, seed, log, nested);
        } catch (error) {
          if (process.env.BLOCK_ID_FUZZ_LOG) {
            // eslint-disable-next-line no-console
            console.log(
              `v${v} nested ${nested} seed ${seed}\n${log.join('\n')}`,
            );
          }
          throw error;
        }
      });
    }
  },
);
