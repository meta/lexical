/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Fuzz: does an undo spread a comment onto other blocks? Two bound editors,
// synced after every op, run random comment adds (each inside one text
// node), comment removals ($removeMarkID over the whole document), formats,
// plain typing, deletes and undos. A comment id on two blocks is a spread
// (#9623: "X adds, Y removes, X undoes, Y undoes" put it on everything
// after it). Env: US_SEEDS (default 60), US_START, US_OPS (default 30),
// US_UNDO (default 0.15), US_STEP_END (default 0.1: the chance an undo
// step ends after an op).

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $addMarkID,
  $getNodeMarkIDs,
  $removeMarkID,
  MarkStateExtension,
} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  configExtension,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';
import {seedYState} from '../../headless';

const SEEDS = Number(process.env.US_SEEDS ?? 60);
const START = Number(process.env.US_START ?? 1);
const OPS = Number(process.env.US_OPS ?? 30);
const UNDO = Number(process.env.US_UNDO ?? 0.15);
const STEP_END = Number(process.env.US_STEP_END ?? 0.1);
const BLOCKS = 6;
const CONFIG = {
  extensions: [RichTextExtension, MarkStateExtension],
  schemaVersion: 1,
};

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

type Op = {e: number} & (
  | {k: 'add'; t: number; a: number; b: number; id: string}
  | {k: 'remove'; id: string}
  | {k: 'format'; t: number; a: number; b: number; f: 'bold' | 'italic'}
  | {k: 'type'; t: number; a: number; s: string}
  | {k: 'del'; t: number; a: number; b: number}
  | {k: 'undo'}
);

function $texts(): TextNode[] {
  const out: TextNode[] = [];
  const walk = (n: LexicalNode) => {
    if ($isTextNode(n) && n.getType() === 'text') {
      out.push(n);
    }
    if ($isElementNode(n)) {
      n.getChildren().forEach(walk);
    }
  };
  walk($getRoot());
  return out;
}

function $select(t: TextNode, a: number, b: number) {
  const s = $createRangeSelection();
  const n = t.getTextContentSize();
  s.anchor.set(t.getKey(), Math.min(a, n), 'text');
  s.focus.set(t.getKey(), Math.min(b, n), 'text');
  $setSelection(s);
  return s;
}

function $apply(op: Op) {
  if (op.k === 'undo') {
    return;
  }
  if (op.k === 'remove') {
    $removeMarkID(op.id);
    return;
  }
  const ts = $texts();
  const t = ts[op.t % Math.max(1, ts.length)];
  if (t === undefined) {
    return;
  }
  const size = t.getTextContentSize();
  if (op.k === 'add') {
    if (Math.min(op.b, size) > Math.min(op.a, size)) {
      $addMarkID(op.id, $select(t, op.a, op.b));
    }
  } else if (op.k === 'format') {
    $select(t, op.a, op.b).formatText(op.f);
  } else if (op.k === 'type') {
    const s = $select(t, op.a, op.a);
    s.format = 0;
    s.insertText(op.s);
  } else if (Math.min(op.b, size) > Math.min(op.a, size)) {
    $select(t, op.a, op.b).removeText();
  }
  $setSelection(null);
}

/** The comment ids that are on more than one block. */
function spread(editor: LexicalEditor): string[] {
  return editor.read(() => {
    const blocks = new Map<string, Set<string>>();
    for (const t of $texts()) {
      const block = t.getParentOrThrow().getKey();
      for (const id of $getNodeMarkIDs(MarkStateExtension, t)) {
        const set = blocks.get(id) ?? new Set();
        set.add(block);
        blocks.set(id, set);
      }
    }
    return [...blocks].filter(([, s]) => s.size > 1).map(([id]) => id);
  });
}

function gen(seed: number): Op[] {
  const r = rng(seed * 2654435761);
  const ops: Op[] = [];
  const live: string[] = [];
  let n = 0;
  const pos = () => Math.floor(r() * 30);
  for (let i = 0; i < OPS; i++) {
    const e = Math.floor(r() * 2);
    const v = r() * (0.88 + UNDO);
    const t = Math.floor(r() * BLOCKS * 3);
    if (v < 0.25) {
      const a = pos();
      const id = `c${++n}`;
      live.push(id);
      ops.push({a, b: a + 1 + Math.floor(r() * 12), e, id, k: 'add', t});
    } else if (v < 0.37 && live.length > 0) {
      const [id] = live.splice(Math.floor(r() * live.length), 1);
      ops.push({e, id, k: 'remove'});
    } else if (v < 0.5) {
      const a = pos();
      const f = r() < 0.5 ? 'bold' : 'italic';
      ops.push({a, b: a + 1 + Math.floor(r() * 8), e, f, k: 'format', t});
    } else if (v < 0.68) {
      const s = ['x', ' new ', 'yy'][Math.floor(r() * 3)];
      ops.push({a: pos(), e, k: 'type', s, t});
    } else if (v < 0.88) {
      const a = pos();
      ops.push({a, b: a + 1 + Math.floor(r() * 6), e, k: 'del', t});
    } else {
      ops.push({e, k: 'undo'});
    }
  }
  return ops;
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'note', 'run'];

// Seeds 10, 23, 26, 35 and 51 spread a comment with the default profile
// (#9623) until the binding kept its own format items from garbage collection
// while they are undoable: the documents here use Yjs's default, gc on, as
// products do.
for (let seed = START; seed < START + SEEDS; seed++) {
  test(`an undo never spreads a comment onto another block (seed ${seed})`, () => {
    const seeded = seedYState(CONFIG, () => {
      const root = $getRoot().clear();
      for (let i = 0; i < BLOCKS; i++) {
        root.append(
          $createParagraphNode().append(
            $createTextNode(`${WORDS[i]} one two three four five ${i}`),
          ),
        );
      }
    });
    const peers = ['A', 'B'].map(name => {
      const doc = createYDoc(seeded);
      const editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            RichTextExtension,
            MarkStateExtension,
            configExtension(YCollabExtension, {
              // Undo steps end where the script says, whatever the
              // runner's speed (see below).
              captureTimeout: 2 ** 30,
              doc,
              schemaVersion: 1,
              synced: true,
            }),
          ],
          name: `undo-spread-fuzz/${name}`,
          onError: error => {
            throw error;
          },
        }),
      );
      const {binding} = getExtensionDependencyFromEditor(
        editor,
        YCollabExtension,
      ).output;
      return {binding, doc, editor};
    });
    const sync = () => {
      const [a, b] = peers;
      Y.applyUpdate(
        b.doc,
        Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
      );
      Y.applyUpdate(
        a.doc,
        Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)),
      );
    };
    const ops = gen(seed);
    // Where an undo step ends: after an op with this chance (as edits a
    // person makes in a burst share one step), from its own sequence so
    // the ops stay those of the seed.
    const steps = rng(seed * 40503 + 1);
    try {
      ops.forEach((op, i) => {
        const {editor} = peers[op.e];
        if (op.k === 'undo') {
          editor.dispatchCommand(UNDO_COMMAND, undefined);
        } else {
          editor.update(() => $apply(op), {discrete: true});
        }
        if (steps() < STEP_END) {
          peers[op.e].binding.undoManager?.stopCapturing();
        }
        sync();
        for (const peer of peers) {
          expect(
            spread(peer.editor),
            `after op ${i}: ${JSON.stringify(ops.slice(0, i + 1))}`,
          ).toEqual([]);
        }
      });
    } finally {
      for (const peer of peers) {
        peer.editor.dispose();
      }
    }
  });
}
