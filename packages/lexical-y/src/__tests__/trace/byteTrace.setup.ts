/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The byte-identity harness: what a refactor of this package compares
// before and after (see ARCHITECTURE.md, "Gates"). Loaded as a setup file by
// vitest.byte-trace.config.mts, it does nothing unless LEXICAL_Y_BYTE_TRACE
// names a directory. With it, every test file of the run writes one JSON
// record there: counts, and a hash of
//
// - every Yjs update any Doc emits, in order (`updatesHash`);
// - the state vector of the Doc after every transaction (`vectorsHash`);
// - the final state (encodeStateAsUpdate) of every Doc the file made
//   (`finalHash`);
// - every committed editor state (JSON and selection) of every editor that
//   has an update listener, so every editor a binding is bound to
//   (`statesHash`);
// - every warning passed to an editor's onWarn, and every console.warn and
//   console.error (`warningsHash`).
//
// Two runs are comparable because nothing in a run is left to chance or to
// the time of day: Math.random and crypto.getRandomValues are seeded per
// test file (so client ids repeat), and Date.now is a clock that starts at
// a fixed time and advances by a fixed step at every reading (the undo
// manager's capture timeout reads it, so the bytes of some tests depend on
// it). LEXICAL_Y_BYTE_TRACE_CLOCK sets the step in milliseconds (default
// 7; 0 leaves the real clock, which shows what depends on it).
//
// To compare a change with its base (from the repository root; a base that
// does not have these files yet takes a copy of this directory and of
// vitest.byte-trace.config.mts):
//
//   LEXICAL_Y_BYTE_TRACE=/tmp/trace/before pnpm vitest run \
//     --config packages/lexical-y/vitest.byte-trace.config.mts \
//     --project unit --pool=forks packages/lexical-y/     # on the base
//   LEXICAL_Y_BYTE_TRACE=/tmp/trace/after  ...            # on the change
//   node packages/lexical-y/src/__tests__/trace/compareByteTraces.mjs \
//     /tmp/trace/before /tmp/trace/after
//
// and again with LEXICAL_Y_GC=1 FUZZ_GC=1. The comparison exits with 1
// where a file both runs traced differs in any hash or count.
//
// Read pass and fail from an ordinary run of the suite, not from a traced
// one: the tracer keeps every Doc until its file ends and loads `lexical`
// before a test file's own mocks, so a few tests that measure memory or
// mock the platform fail under it, before and after alike. A test file
// whose final states differ between two runs of one tree (compare a tree
// with itself to find them) is not deterministic and proves nothing either
// way. The same retention bounds one file's size: a file that makes tens
// of thousands of Docs runs out of heap, so trace LaneFuzz in slices of
// about 500 seeds (LANE_SEEDS, LANE_SEED_START), one output directory each.
import type * as YTypes from '@y/y';
import type {LexicalEditor} from 'lexical';

import * as nodeCrypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {afterAll, expect} from 'vitest';

const OUT = process.env.LEXICAL_Y_BYTE_TRACE;

interface Sink {
  hashes: {
    states: nodeCrypto.Hash;
    updates: nodeCrypto.Hash;
    vectors: nodeCrypto.Hash;
    warnings: nodeCrypto.Hash;
  };
  counts: {
    docs: number;
    finalBytes: number;
    states: number;
    transactions: number;
    updateBytes: number;
    updates: number;
    warnings: number;
  };
  docs: Set<YTypes.Doc>;
}

type Traced = typeof globalThis & {__lexicalYByteTrace?: Sink};

/** JSON of `value`, with the values JSON has no form for. */
function text(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, x) =>
      typeof x === 'bigint'
        ? String(x)
        : x instanceof Uint8Array
          ? Array.from(x)
          : x instanceof Map || x instanceof Set
            ? [...x]
            : x,
    );
  } catch {
    return String(value);
  }
}

if (OUT) {
  // Seeded randomness, before @y/y loads: lib0 binds getRandomValues when
  // it does.
  let seed = 0x9e3779b9;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Math.random = next;
  const fill = <T extends ArrayBufferView | null>(array: T): T => {
    if (array !== null) {
      const bytes = new Uint8Array(
        array.buffer,
        array.byteOffset,
        array.byteLength,
      );
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(next() * 256);
      }
    }
    return array;
  };
  for (const crypto of [
    (nodeCrypto as unknown as {webcrypto: Crypto}).webcrypto,
    (globalThis as {crypto?: Crypto}).crypto,
  ]) {
    if (crypto) {
      try {
        Object.defineProperty(crypto, 'getRandomValues', {
          configurable: true,
          value: fill,
          writable: true,
        });
      } catch {
        // Left as it is: the client ids of this run are then its own.
      }
    }
  }

  // A fixed clock: the same reading at the same call in every run.
  const step = Number(process.env.LEXICAL_Y_BYTE_TRACE_CLOCK ?? 7);
  if (step > 0) {
    let now = 1_700_000_000_000;
    Date.now = () => (now += step);
  }

  const Y = await import('@y/y');
  const {createEditor} = await import('lexical');

  const sink: Sink = {
    counts: {
      docs: 0,
      finalBytes: 0,
      states: 0,
      transactions: 0,
      updateBytes: 0,
      updates: 0,
      warnings: 0,
    },
    docs: new Set(),
    hashes: {
      states: nodeCrypto.createHash('sha256'),
      updates: nodeCrypto.createHash('sha256'),
      vectors: nodeCrypto.createHash('sha256'),
      warnings: nodeCrypto.createHash('sha256'),
    },
  };
  // The prototypes are patched once per worker (a pool may share modules
  // between the files of a worker); each file's records go to its own sink.
  const traced = globalThis as Traced;
  traced.__lexicalYByteTrace = sink;
  const current = (): Sink | undefined => traced.__lexicalYByteTrace;

  const docProto = Y.Doc.prototype as unknown as {
    emit: (name: string, args: unknown[]) => void;
    __lexicalYByteTraced?: boolean;
  };
  if (!docProto.__lexicalYByteTraced) {
    docProto.__lexicalYByteTraced = true;
    const emit = docProto.emit;
    docProto.emit = function (this: YTypes.Doc, name: string, args: unknown[]) {
      const s = current();
      if (s) {
        if (name === 'update') {
          const update = args[0] as Uint8Array;
          s.hashes.updates.update(update);
          s.counts.updates++;
          s.counts.updateBytes += update.length;
        } else if (name === 'afterTransaction') {
          s.docs.add(this);
          s.counts.transactions++;
          try {
            s.hashes.vectors.update(Y.encodeStateVector(this));
          } catch {
            s.hashes.vectors.update('!');
          }
        }
      }
      return emit.call(this, name, args);
    };
  }

  type Point = {key: string; offset: number; type: string};
  type UpdateListener = (payload: {
    editorState: {
      toJSON(): unknown;
      _nodeMap: Map<string, unknown>;
      _selection: unknown;
    };
  }) => void;
  const editorProto = Object.getPrototypeOf(createEditor()) as {
    registerUpdateListener: (listener: UpdateListener) => () => void;
    __lexicalYByteTraced?: boolean;
  };
  if (!editorProto.__lexicalYByteTraced) {
    editorProto.__lexicalYByteTraced = true;
    const editors = new WeakSet<LexicalEditor>();
    const register = editorProto.registerUpdateListener;
    editorProto.registerUpdateListener = function (
      this: LexicalEditor,
      listener,
    ) {
      if (!editors.has(this)) {
        editors.add(this);
        register.call(this, ({editorState}) => {
          const s = current();
          if (!s) {
            return;
          }
          s.counts.states++;
          const size = editorState._nodeMap.size;
          s.hashes.states.update(String(size));
          // (A very large state is compared by its size and by the updates
          // written from it.)
          if (size <= 2500) {
            s.hashes.states.update(text(editorState.toJSON()));
            const selection = editorState._selection as null | {
              anchor?: Point;
              focus?: Point;
            };
            if (selection && selection.anchor && selection.focus) {
              const {anchor, focus} = selection;
              s.hashes.states.update(
                `${anchor.key}:${anchor.offset}:${anchor.type}|${focus.key}:${focus.offset}:${focus.type}`,
              );
            } else {
              s.hashes.states.update(selection === null ? 'null' : 'other');
            }
          }
        });
        const self = this as unknown as {_onWarn?: (warning: unknown) => void};
        const onWarn = self._onWarn;
        if (typeof onWarn === 'function') {
          self._onWarn = function (this: unknown, warning: unknown) {
            const s = current();
            if (s) {
              const w = warning as {
                code?: unknown;
                message?: unknown;
                data?: unknown;
              };
              s.counts.warnings++;
              s.hashes.warnings.update(text([w.code, w.message, w.data]));
            }
            return onWarn.call(this, warning);
          };
        }
      }
      return register.call(this, listener);
    };
  }

  for (const level of ['warn', 'error'] as const) {
    // eslint-disable-next-line no-console
    const original = console[level];
    // eslint-disable-next-line no-console
    console[level] = (...args: unknown[]) => {
      sink.counts.warnings++;
      sink.hashes.warnings.update(
        level +
          args
            .map(arg =>
              typeof arg === 'string'
                ? arg
                : arg instanceof Error
                  ? arg.message
                  : text(arg),
            )
            .join(' '),
      );
      return original.apply(console, args);
    };
  }

  afterAll(() => {
    const final = nodeCrypto.createHash('sha256');
    for (const doc of sink.docs) {
      sink.counts.docs++;
      try {
        const bytes = Y.encodeStateAsUpdate(doc);
        sink.counts.finalBytes += bytes.length;
        final.update(bytes);
      } catch {
        final.update('!');
      }
    }
    const file = (expect.getState().testPath ?? 'unknown').replace(
      /^.*packages\//,
      'packages/',
    );
    fs.mkdirSync(OUT, {recursive: true});
    fs.writeFileSync(
      path.join(OUT, file.replace(/[^A-Za-z0-9.]+/g, '_') + '.json'),
      JSON.stringify({
        file,
        ...sink.counts,
        finalHash: final.digest('hex'),
        statesHash: sink.hashes.states.digest('hex'),
        updatesHash: sink.hashes.updates.digest('hex'),
        vectorsHash: sink.hashes.vectors.digest('hex'),
        warningsHash: sink.hashes.warnings.digest('hex'),
      }) + '\n',
    );
  });
}
