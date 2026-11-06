/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The writers of `@lexical/y/headless` (see createYWriter): who an edit is
// written as. Bundled into that entry only.
//
// Invariant: a writer continues a client id only from its tip. A writer
// writes under client ids it drew itself (never one in use by a call in
// progress) and never takes one from its caller. It continues one only on a
// document state whose clock for that id equals the writer's tip (the clock
// its last returned update under that id reached), and never in a call made
// while another call writes under it.
// Why: two writes under one client id from different states give two
// different items the same id. Yjs keeps the copy a peer receives first and
// drops the other, or builds on the wrong one, so peers diverge with no
// error. From its tip, every write under an id extends the one chain of
// writes under it, which nothing else writes to.

import type {ClientIDRange} from '..';
import type {Doc} from '@y/y';

import {LexicalWarning} from 'lexical';

/**
 * The key of {@link YWriter}'s phantom brand. Declared rather than defined:
 * it exists only in the type system, so nothing is emitted for it. Named so
 * that tsc's message for a writer written by hand reads as the fix:
 * "Property '[createdByCreateYWriter]' is missing in type '{ author: string;
 * }' but required in type 'YWriter'".
 */
declare const createdByCreateYWriter: unique symbol;

/**
 * @experimental Who `editYState` writes an edit as (see
 * {@link createYWriter}): an author, and the client ids the writer writes
 * under, one per document it edits.
 */
export interface YWriter {
  /** Who the writer's edits are by, as given to `createYWriter`. */
  readonly author: string;
  /** Phantom brand: only `createYWriter` makes a writer. */
  readonly [createdByCreateYWriter]: true;
}

/**
 * @experimental A writer could not continue its client id on the state an
 * edit was given, so the edit was written under a new one, and the document
 * now carries one more client id. `data`: `{author: string, clientID: number,
 * previousClientID: number, reason: 'stale-state' | 'busy' | 'range' |
 * 'foreign-writes'}`: the state was read before the writer's last update
 * under that id (or the update was never stored); another call with the
 * writer was writing under it (a call made from inside another call); the id
 * does not fit `clientIDRange: 'uint32'`; or something else wrote under it,
 * and the writer stops using it.
 */
export const WRITER_NEW_CLIENT_ID_WARNING = '@lexical/y/writer-new-client-id';

/** Why a writer did not continue a client id that the state holds. */
export type WriterNewClientIDReason =
  | 'stale-state'
  | 'busy'
  | 'range'
  | 'foreign-writes';

/**
 * The client ids a writer remembers. The least recently used is forgotten
 * first, and a forgotten id is never written under again: the document it
 * belonged to gets a new client id on its next edit by the writer.
 */
export const MAX_WRITER_CLIENT_IDS = 10000;

const MAX_UINT32 = 0xffffffff;

interface WriterState {
  readonly author: string;
  /**
   * The client ids the writer has drawn, each with its tip: the clock its
   * last returned update under that id reached (0 before the first). Least
   * recently used first.
   */
  readonly tips: Map<number, number>;
  /** The client ids of calls in progress. */
  readonly busy: Set<number>;
  readonly max: number;
}

/** Each writer's state, out of reach of a copy of the writer. */
const writerStates = new WeakMap<object, WriterState>();

/**
 * @experimental A writer for `editYState`. `author` names who its edits are
 * by (an agent, an integration): for your attribution, and in the warnings
 * about the writer. It is not written into documents.
 *
 * Create one per agent or integration, once per process, and pass it to
 * every edit it makes. It keeps one client id per document it edits,
 * continued from edit to edit, so a document the server edits thousands of
 * times carries one client id for it instead of thousands. It remembers up
 * to 10,000 client ids, the least recently used forgotten first; a document
 * whose id it forgot gets a new one on its next edit. A writer created for
 * each edit gives each edit a new client id, as `writer: null` does.
 */
export function createYWriter(author: string): YWriter {
  return createWriter(author, MAX_WRITER_CLIENT_IDS);
}

/** @internal {@link createYWriter} remembering at most `max` client ids. */
export function createWriter(author: string, max: number): YWriter {
  const writer = Object.freeze({author}) as unknown as YWriter;
  writerStates.set(writer, {author, busy: new Set(), max, tips: new Map()});
  return writer;
}

/** @internal Whether `value` is a writer made by {@link createYWriter}. */
export function isYWriter(value: unknown): value is YWriter {
  return typeof value === 'object' && value !== null && writerStates.has(value);
}

/** @internal The client id one `editYState` call writes under. */
export interface WriterLease {
  readonly clientID: number;
  /** Reported when the writer could not continue a client id the state holds. */
  readonly warning: LexicalWarning | null;
  /** The call returned its update: `doc`'s clock for the id is the new tip. */
  commit(doc: Doc): void;
  /** The call returned nothing: what it wrote never left it. */
  release(): void;
}

/** A client id the state holds that the writer could not continue. */
interface Blocked {
  readonly clientID: number;
  readonly clock: number;
  readonly reason: WriterNewClientIDReason;
  readonly tip: number;
}

function randomClientID(range: ClientIDRange): number {
  const words = new Uint32Array(2);
  const c = globalThis.crypto;
  if (c !== undefined && typeof c.getRandomValues === 'function') {
    c.getRandomValues(words);
  } else {
    words[0] = Math.floor(Math.random() * 0x100000000);
    words[1] = Math.floor(Math.random() * 0x100000000);
  }
  const id =
    range === 'uint32'
      ? words[0]
      : (words[0] & 0x1fffff) * 0x100000000 + words[1];
  return id === 0 ? 1 : id;
}

function newClientIDWarning(
  author: string,
  blocked: Blocked,
  clientID: number,
): LexicalWarning {
  const {clientID: previous, clock, reason, tip} = blocked;
  const why =
    reason === 'stale-state'
      ? `the state holds its client id ${previous} up to clock ${clock}, but its last update under that id reached clock ${tip} (the state was read before that update, or the update was never stored). To keep one client id per document, run this writer's edits one after another, each on a state that holds its last update, and store every update it returns.`
      : reason === 'busy'
        ? `its client id ${previous} is in use by another call with this writer (editYState called from inside another call's $edit, transact or onWarn). Run a writer's edits one after another, never from inside another edit.`
        : reason === 'range'
          ? `its client id ${previous} does not fit config.clientIDRange 'uint32'. Use the same clientIDRange in every config this writer edits a document with.`
          : `the state holds writes under its client id ${previous} up to clock ${clock} that it did not make (its last update reached clock ${tip}), so something else writes under that id, and the writer stops using it. Never assign a writer's client id (result.clientID) to a Y.Doc.`;
  return new LexicalWarning(
    WRITER_NEW_CLIENT_ID_WARNING,
    `@lexical/y: writer ${JSON.stringify(author)} wrote this edit under a new client id, ${clientID}: ${why}`,
    {author, clientID, previousClientID: previous, reason},
  );
}

/**
 * @internal Choose the client id an edit with `writer` writes under and set
 * it as `doc.clientID`: on `doc` holding the state the edit runs on, before
 * anything is written. The writer's most recently used client id that the
 * state holds at its tip, and is not in use by another call, continues;
 * otherwise a client id the writer drew and never wrote under, or a new one
 * (not in the state). The lease is in use until `commit` or `release`.
 */
export function leaseWriterClientID(
  writer: YWriter,
  doc: Doc,
  range: ClientIDRange,
): WriterLease {
  const state = writerStates.get(writer);
  if (state === undefined) {
    throw new TypeError(
      '@lexical/y: options.writer is not a writer from createYWriter(author): create one with createYWriter, or pass null.',
    );
  }
  const {busy, tips} = state;
  // Client ids are never 0.
  let chosen = 0;
  let unwritten = 0;
  let blocked: Blocked | null = null;
  const foreign: number[] = [];
  for (const [clientID, tip] of tips) {
    const clock = doc.store.getClock(clientID);
    let reason: WriterNewClientIDReason | null = null;
    if (clock !== tip) {
      reason = clock < tip ? 'stale-state' : 'foreign-writes';
    } else if (busy.has(clientID)) {
      reason = 'busy';
    } else if (range === 'uint32' && clientID > MAX_UINT32) {
      reason = 'range';
    } else if (clock > 0) {
      // Later entries were used more recently.
      chosen = clientID;
    } else {
      unwritten = clientID;
    }
    if (reason === 'foreign-writes') {
      foreign.push(clientID);
    }
    // A client id the state does not hold says nothing about this
    // document: it may be another document's.
    if (reason !== null && clock > 0) {
      blocked = {clientID, clock, reason, tip};
    }
  }
  for (const clientID of foreign) {
    tips.delete(clientID);
  }
  let clientID = chosen !== 0 ? chosen : unwritten;
  if (clientID === 0) {
    // Not in the state, not one of the writer's, and not the new id of a
    // call in progress (which is not in `tips` until it commits).
    do {
      clientID = randomClientID(range);
    } while (
      doc.store.clients.has(clientID) ||
      tips.has(clientID) ||
      busy.has(clientID)
    );
  }
  doc.clientID = clientID;
  busy.add(clientID);
  const warning =
    chosen === 0 && blocked !== null
      ? newClientIDWarning(state.author, blocked, clientID)
      : null;
  let leased = true;
  return {
    clientID,
    commit(committed: Doc) {
      if (!leased) {
        return;
      }
      leased = false;
      busy.delete(clientID);
      tips.delete(clientID);
      tips.set(clientID, committed.store.getClock(clientID));
      for (const old of tips.keys()) {
        if (tips.size <= state.max) {
          break;
        }
        if (!busy.has(old)) {
          tips.delete(old);
        }
      }
    },
    release() {
      if (leased) {
        leased = false;
        busy.delete(clientID);
      }
    },
    warning,
  };
}
