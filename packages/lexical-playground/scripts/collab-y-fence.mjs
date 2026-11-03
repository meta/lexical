/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The generation fence of the playground's collab Y relay
// (collab-y-server.mjs): the reference for docs/collaboration/y-server.md's
// "Migrating stored documents", built from `@lexical/y/server`.
//
// - A store per room that outlives the live document (the relay keeps it in
//   memory; a real server keeps it on disk): its state, incarnation and seed
//   contract, generation, version, the immutable base of every generation it
//   migrated from, its quarantine records and the replay ledger.
// - Loading a room migrates it (prepareYRoom) before anyone is served, and
//   commits with a compare-and-set on the version read.
// - Every connection presents a handshake in its URL; checkYSession decides,
//   and only admitted sessions sync. A session without one (a client from
//   before the fence) is captured (captureYSession) unless the room predates
//   the fence and never migrated.
// - A stale client hands its material off (POST /handoff): the record is
//   stored, acknowledged by hash, and replayed onto the live document as a
//   checked edit (replayYRecovery).

import step1to2 from '@lexical/y/migrate/1to2';
import {
  captureYSession,
  checkYSession,
  createYDoc,
  describeYRoom,
  generationOf,
  hasNewYEdits,
  pendingYRecord,
  prepareYRoom,
  quarantineRecord,
  recoveryYState,
  replayYRecovery,
  sourceView,
} from '@lexical/y/server';
import * as Y from '@y/y';

export {createYDoc};

/** The y-websocket message type of the fence's verdict (JSON, sent first). */
export const MESSAGE_FENCE = 8;

const ROOT = 'lexical-y';
const SEED_LAYOUT = 1;
const steps = [step1to2];

/**
 * @typedef {{
 *   id: string,
 *   record: import('@lexical/y/server').YQuarantineRecord,
 *   replay: null | {applied: number, conflicts: number, skipped: number, eligible: boolean, reason: string | null},
 *   capture?: ReturnType<typeof captureYSession>,
 * }} Entry
 */

/** A random token (the room's incarnation). */
function token() {
  return `i${Math.random().toString(36).slice(2, 10)}`;
}

/** A live room's generation (its incarnation and the epochs it records). */
export function describeGeneration(doc, store) {
  return generationOf(doc, store.incarnation);
}

/** The layout a document records on its root, null when none. */
export function layoutOf(doc) {
  const root = doc.share.has(ROOT) ? doc.get(ROOT) : null;
  if (root === null) {
    return null;
  }
  let layout = null;
  for (const key of Object.keys(root.getAttrs())) {
    const m = /^lexical-y:(\d+)$/.exec(key);
    if (m !== null) {
      layout = Math.max(layout ?? 0, Number(m[1]));
    }
  }
  return layout;
}

/** The text of a document's root, for record previews. */
function textOf(doc) {
  const walk = node => {
    let s = '';
    for (let it = node._start; it !== null; it = it.right) {
      if (it.deleted) {
        continue;
      }
      if (it.content instanceof Y.ContentString) {
        s += it.content.str;
      } else if (it.content instanceof Y.ContentType) {
        s += walk(it.content.type) + ' ';
      }
    }
    return s;
  };
  return doc.share.has(ROOT) ? walk(doc.get(ROOT)).trim() : '';
}

/**
 * The handshake a client put in its connection URL, null when none (a
 * release before the fence).
 *
 * @param {URLSearchParams} params
 */
export function handshakeOf(params) {
  if (!params.has('g')) {
    return null;
  }
  const g = params.get('g');
  return {
    generation: g === 'null' ? null : g,
    layouts: [Number(params.get('lo')), Number(params.get('hi'))],
    material: params.get('m') === '1',
    seed: Number(params.get('seed')),
  };
}

/** One room's persistent side (what a server would keep on disk). */
export class StoredRoom {
  /**
   * @param {string} name
   * @param {{floor: number}} options
   */
  constructor(name, {floor}) {
    this.name = name;
    /** @type {Uint8Array | null} */
    this.state = null;
    this.incarnation = token();
    /** Assigned with the room, after the fence: not inherited. */
    this.inherited = false;
    this.seedContract = SEED_LAYOUT;
    this.version = 0;
    /** The layout below which loading migrates (prepareYRoom's target). */
    this.floor = floor;
    /** @type {Map<string, Uint8Array>} immutable, by source generation */
    this.bases = new Map();
    /** @type {Entry[]} append-only */
    this.records = [];
    /** @type {Map<string, string>} the replay ledger */
    this.ledger = new Map();
    this.generation = `${this.incarnation}/-`;
  }

  /**
   * Load the room: migrate a copy of the stored state when a root is below
   * the floor and commit it (compare-and-set on the version read), then
   * return the document to serve.
   */
  load() {
    for (;;) {
      const version = this.version;
      const state = this.state;
      if (state === null) {
        return createYDoc(null);
      }
      const prepared = prepareYRoom(state, {
        incarnation: this.incarnation,
        steps,
        to: this.floor,
      });
      if (!prepared.changed) {
        return createYDoc(state);
      }
      if (this.version !== version) {
        // Lost the race: discard the result and start over.
        continue;
      }
      if (!this.bases.has(prepared.base.generation)) {
        this.bases.set(prepared.base.generation, prepared.base.state);
      }
      this.state = prepared.state;
      this.generation = prepared.generation;
      this.version++;
      const doc = createYDoc(prepared.state);
      if (prepared.pending !== null) {
        // What the migration split out, with the whole stored state it came
        // from, so the record renders and replays the cut items in place.
        const entry = this.add(
          pendingYRecord({
            pending: prepared.pending,
            receivedAt: Date.now(),
            source: {
              generation: prepared.base.generation,
              incarnation: this.incarnation,
              layouts: null,
              renderer: null,
              schemaVersion: null,
            },
            stored: prepared.base.state,
          }),
        );
        this.replay(entry, doc, false);
      }
      return doc;
    }
  }

  /** Persist the live document (the seal before a migration). */
  seal(doc) {
    this.state = Y.encodeStateAsUpdate(doc);
    this.version++;
  }

  /** The verdict for a session's handshake (see checkYSession). */
  verdict(doc, handshake) {
    return checkYSession(
      describeYRoom(doc, {
        incarnation: this.incarnation,
        inherited: this.inherited,
        seedContract: this.seedContract,
      }),
      handshake,
    );
  }

  /** @param {import('@lexical/y/server').YQuarantineRecord} record */
  add(record) {
    /** @type {Entry} */
    const entry = {id: record.id, record, replay: null};
    this.records.push(entry);
    return entry;
  }

  /**
   * A stale client's handoff: store it (once per hash), then replay it.
   *
   * @param {{snapshot: Uint8Array, draft: unknown, generation: string | null, peers?: boolean, clients?: number[]}} input
   * @param {Y.Doc | null} doc the live document, when the room is loaded
   */
  handoff(input, doc) {
    const incarnation =
      input.generation === null ? null : input.generation.split('/')[0];
    const record = quarantineRecord(
      {
        clients: input.clients ?? [],
        draft: input.draft ?? null,
        kind: 'handoff',
        // Unknown provenance is peers.
        peers: input.peers ?? true,
        receivedAt: Date.now(),
        snapshot: input.snapshot,
        source: {
          generation: input.generation,
          incarnation,
          layouts: null,
          renderer: null,
          schemaVersion: null,
        },
      },
      input.generation !== null && this.bases.has(input.generation)
        ? {
            generation: input.generation,
            state: this.bases.get(input.generation),
          }
        : null,
    );
    const existing = this.records.find(e => e.record.hash === record.hash);
    if (existing !== undefined) {
      return existing;
    }
    const entry = this.add(record);
    if (doc !== null) {
      this.replay(entry, doc, true);
    }
    return entry;
  }

  /**
   * Replay a record onto the live document as a checked edit: computed on
   * the state of a version, committed with its ledger only while that
   * version holds.
   */
  replay(entry, doc, live) {
    const source = entry.record.source.generation;
    const base = source === null ? undefined : this.bases.get(source);
    if (base === undefined) {
      entry.replay = {
        applied: 0,
        conflicts: 0,
        eligible: false,
        reason: 'no base for its generation',
        skipped: 0,
      };
      return;
    }
    const version = this.version;
    const result = replayYRecovery(
      entry.record,
      base,
      Y.encodeStateAsUpdate(doc),
      {
        baseGeneration: source,
        generation: this.generation,
        inPlace: true,
        incarnation: this.incarnation,
        ledger: this.ledger,
      },
    );
    if (this.version !== version) {
      return this.replay(entry, doc, live);
    }
    if (result.update !== null) {
      Y.applyUpdate(doc, result.update, live ? 'replay' : null);
    }
    for (const [k, v] of result.receipt.ledger) {
      this.ledger.set(k, v);
    }
    this.version++;
    entry.replay = {
      applied: result.receipt.applied,
      conflicts: result.receipt.conflicts,
      eligible: result.eligible,
      reason: result.reason,
      skipped: result.receipt.skipped,
    };
  }

  /** A legacy session's capture: its record grows with what it sends. */
  capture() {
    const capture = captureYSession();
    /** @type {Entry} */
    const entry = {
      capture,
      id: `capture-${this.records.length}`,
      record: null,
      replay: null,
    };
    this.records.push(entry);
    return entry;
  }

  /** The listing of the room's records (the recovery view's data). */
  list() {
    return this.records.map(entry => {
      let record = entry.record;
      if (entry.capture !== undefined) {
        const m = entry.capture.material();
        record =
          m.snapshot === null
            ? null
            : quarantineRecord({
                deltas: m.deltas,
                kind: 'capture',
                receivedAt: 0,
                signals: m.signals,
                snapshot: m.snapshot,
                source: {
                  generation: 'unknown',
                  incarnation: null,
                  layouts: null,
                  renderer: null,
                  schemaVersion: null,
                },
              });
      }
      if (record === null) {
        return {id: entry.id, kind: 'capture', preview: '', source: null};
      }
      const view = sourceView(record);
      try {
        const base =
          record.source.generation === null
            ? undefined
            : this.bases.get(record.source.generation);
        // What the recovery view renders: the record migrated on a scratch
        // copy, through any gap (render only; never stored or sent into
        // the room).
        let preview;
        try {
          const shown = createYDoc(recoveryYState(record, steps, base ?? null));
          preview = textOf(shown);
          shown.destroy();
        } catch {
          preview = textOf(view.doc);
        }
        return {
          actionable: base === undefined ? true : hasNewYEdits(record, base),
          complete: view.complete,
          hash: record.hash,
          id: entry.id,
          kind: record.kind,
          preview: preview.slice(0, 200),
          receivedAt: record.receivedAt,
          replay: entry.replay,
          source: record.source.generation,
        };
      } finally {
        view.doc.destroy();
      }
    });
  }

  /** The room's description for the e2e suite. */
  describe(doc) {
    return {
      generation:
        doc === null ? this.generation : generationOf(doc, this.incarnation),
      incarnation: this.incarnation,
      layout: doc === null ? null : layoutOf(doc),
      records: this.records.length,
      version: this.version,
    };
  }
}
