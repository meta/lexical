/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Loading bytes keeps what the document that encoded them showed, a struct
// it integrated across a clock gap included (see internal/LoadFully).
//
// Upstream, "encodeStateAsUpdate drops text the doc shows after it
// integrated a struct across a clock gap" (@y/y 14.0.0-rc.29): a struct that
// arrives in an update of its own is integrated past an earlier, blocked
// struct of its client, but encodeStateAsUpdate merges the pending structs
// into that client's run, and a fresh decode holds the later struct (and
// anything typed after it) pending behind the blocked one.

import {buildEditorFromExtensions} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  defineExtension,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {afterEach, describe, expect, test, vi} from 'vitest';

import {createYDoc, YBinding} from '../../..';
import {editYState, readYState} from '../../../headless';
import {
  applyStoredState,
  type GapRepairYjs,
  integrateHeldBehindGapsWith,
  LOAD_COUNTERS,
  LOAD_PLAN_COUNTERS,
  LOAD_TEST_HOOKS,
  MAX_SUFFIX_APPLIES,
  MAX_TRIAL_VISITS,
  planGapRepairForTests,
} from '../../../internal/LoadFully';
import {createRawYDoc} from '../../../internal/RawYDoc';
import {migrateYDoc, MIGRATION_ORIGIN} from '../../../internal/Runner';
import {migrateYState} from '../../../migrate';
import {
  createYQuarantineRecord,
  prepareYRoom,
  sourceView,
} from '../../../server';
import {catalogAppExtension, catalogHeadlessConfig} from '../../catalog/bind';
import {rawDoc, SEED, STAMP} from '../../utils/migrateSteps';
import {textOf} from '../../utils/splitFixtures';

const CONFIG = catalogHeadlessConfig({blockIds: 'absent'});

// A check that throws is a bug in bounded code: none, but where a test
// forces one.
let forcedCheckFailures = 0;
const checkFailuresAtStart = LOAD_PLAN_COUNTERS.checkFailed;
afterEach(() => {
  expect(LOAD_PLAN_COUNTERS.checkFailed - checkFailuresAtStart).toBe(
    forcedCheckFailures,
  );
});
const SOURCE = {
  generation: 'inc-1/-',
  incarnation: 'inc-1',
  layouts: [SEED, SEED] as [number, number],
  renderer: 'r1',
  schemaVersion: 1,
};

/**
 * The race's shape on @lexical/y's root (a seeded "ABCDEFGH"):
 * 1. A writes "aaaaaa" after A, "bb" after C, "ccc" after "Aa" (it depends
 *    on the first) and "dd" after G (it does not), one update each.
 * 2. B never gets the first: it integrates "bb" across the gap and holds
 *    "ccc" pending. C syncs from B (B's structs and its pending ones).
 * 3. "dd" reaches C in its own update: C integrates it past the blocked
 *    "ccc" and types "X" after it, and (with `bold`) formats "dd" bold.
 * C shows "ABCbbDEFGddXH"; a plain decode of its bytes shows "ABCbbDEFGH".
 */
function gapScenario(gc: boolean, bold = false) {
  const mk = (clientID: number, state: Uint8Array | null = null) => {
    const d = new Y.Doc({gc});
    d.clientID = clientID;
    d.cleanupFormatting = false;
    if (state !== null) {
      Y.applyUpdate(d, state);
    }
    return d;
  };
  const seed = rawDoc(SEED, 'ABCDEFGH');
  const a = mk(1000, seed);
  const ups: Uint8Array<ArrayBuffer>[] = [];
  a.on('update', (u: Uint8Array) => ups.push(new Uint8Array(u)));
  const root = (d: Y.Doc) => d.get('lexical-y');
  const after = (d: Y.Doc, left: string, s: string) =>
    d.transact(() =>
      root(d).insert(textOf(root(d)).indexOf(left) + left.length, s),
    );
  after(a, 'A', 'aaaaaa');
  after(a, 'C', 'bb');
  after(a, 'Aa', 'ccc');
  after(a, 'G', 'dd');
  const b = mk(2000, seed);
  Y.applyUpdate(b, ups[1]);
  Y.applyUpdate(b, ups[2]);
  const c = mk(3000, seed);
  Y.applyUpdate(c, Y.encodeStateAsUpdate(b, Y.encodeStateVector(c)));
  Y.applyUpdate(c, ups[3]);
  after(c, 'dd', 'X');
  if (bold) {
    c.transact(() =>
      root(c).format(textOf(root(c)).indexOf('dd'), 2, {'f:bold': true}),
    );
  }
  const shown = textOf(root(c));
  const state = Y.encodeStateAsUpdate(c);
  const dispose = () => {
    for (const d of [a, b, c]) {
      d.destroy();
    }
  };
  return {a, c, dispose, shown, state, ups};
}

const $text = () => $getRoot().getTextContent();
const $boldText = () =>
  $getRoot()
    .getAllTextNodes()
    .filter((n: TextNode) => n.hasFormat('bold'))
    .map((n: LexicalNode) => ($isTextNode(n) ? n.getTextContent() : ''))
    .join('');

describe.each([false, true])('loading across a clock gap, gc %s', gc => {
  test('the race shape: C shows the text, a plain decode does not', () => {
    const t = gapScenario(gc);
    expect(t.shown).toBe('ABCbbDEFGddXH');
    const plain = new Y.Doc({gc});
    plain.cleanupFormatting = false;
    Y.applyUpdate(plain, t.state);
    expect(textOf(plain.get('lexical-y'))).toBe('ABCbbDEFGH');
    plain.destroy();
    t.dispose();
  });

  test('createYDoc(state) and the raw document show it, and encode then load is stable', () => {
    const t = gapScenario(gc);
    for (const load of [createYDoc, createRawYDoc]) {
      const doc = load(t.state, {gc});
      expect(textOf(doc.get('lexical-y'))).toBe(t.shown);
      const again = load(Y.encodeStateAsUpdate(doc), {gc});
      expect(textOf(again.get('lexical-y'))).toBe(t.shown);
      expect(Buffer.from(Y.encodeStateAsUpdate(again))).toEqual(
        Buffer.from(Y.encodeStateAsUpdate(doc)),
      );
      doc.destroy();
      again.destroy();
    }
    t.dispose();
  });

  test('headless read and edit show it', () => {
    const t = gapScenario(gc);
    expect(readYState(t.state, CONFIG, $text)).toBe(t.shown);
    const {state} = editYState(
      t.state,
      CONFIG,
      () => {
        $getRoot().getAllTextNodes().at(-1)!.spliceText(0, 0, '!');
      },
      {writer: null},
    );
    expect(readYState(state, CONFIG, $text)).toContain('ddX');
    expect(readYState(state, CONFIG, $text)).toContain('!');
    t.dispose();
  });

  test('migrateYState and prepareYRoom keep it', () => {
    const t = gapScenario(gc);
    // The runner migrates the integrated prefix and splits out what follows
    // a gap (`pending`, for the quarantine): the two together show it.
    const migrated = migrateYState(t.state, [STAMP], {gc, to: SEED + 1});
    expect(migrated.pending).not.toBeNull();
    const doc = createYDoc(migrated.state, {gc});
    applyStoredState(doc, migrated.pending!);
    expect(textOf(doc.get('lexical-y'))).toBe(t.shown);
    doc.destroy();
    const room = prepareYRoom(t.state, {
      gc,
      incarnation: 'inc-1',
      steps: [STAMP],
      to: SEED + 1,
    });
    expect(room.changed).toBe(true);
    expect(room.pending).not.toBeNull();
    const served = createYDoc(room.state, {gc});
    applyStoredState(served, room.pending!);
    expect(textOf(served.get('lexical-y'))).toBe(t.shown);
    served.destroy();
    t.dispose();
  });

  test('a quarantine record and its source view show it; still-pending structs leave it incomplete', () => {
    const t = gapScenario(gc);
    const record = createYQuarantineRecord({
      kind: 'handoff',
      receivedAt: 1,
      replica: 'r1',
      session: 's1',
      snapshot: t.state,
      source: SOURCE,
    });
    // "ccc" stays pending (what it depends on never arrived).
    expect(record.complete).toBe(false);
    const view = sourceView(record);
    expect(textOf(view.doc.get('lexical-y'))).toBe(t.shown);
    expect(view.complete).toBe(false);
    view.doc.destroy();
    t.dispose();
  });

  test('a format item whose origin is the gap-integrated text: integrated and read bold', () => {
    const t = gapScenario(gc, true);
    expect(readYState(t.state, CONFIG, $boldText)).toBe('dd');
    const doc = createYDoc(t.state, {gc});
    expect(textOf(doc.get('lexical-y'))).toBe(t.shown);
    doc.destroy();
    t.dispose();
  });

  test('once every update arrives, the repaired and a plain load end byte-identical', () => {
    const t = gapScenario(gc, true);
    const repaired = createRawYDoc(t.state, {gc});
    const plain = new Y.Doc({gc});
    plain.cleanupFormatting = false;
    Y.applyUpdate(plain, t.state);
    for (const doc of [repaired, plain]) {
      for (const u of t.ups) {
        Y.applyUpdate(doc, u);
      }
    }
    expect(textOf(repaired.get('lexical-y'))).toBe(
      textOf(plain.get('lexical-y')),
    );
    expect(Buffer.from(Y.encodeStateAsUpdate(repaired))).toEqual(
      Buffer.from(Y.encodeStateAsUpdate(plain)),
    );
    expect(Buffer.from(Y.encodeStateVector(repaired))).toEqual(
      Buffer.from(Y.encodeStateVector(plain)),
    );
    repaired.destroy();
    plain.destroy();
    t.dispose();
  });

  test("the binding's seed of another root on a gapped document: seeded, and the gap-integrated text still shown", () => {
    const t = gapScenario(gc);
    // A root that held content, deleted since: its seed is written on a
    // copy of the document (createYDoc of its bytes, repaired).
    const c2 = createRawYDoc(t.state, {gc});
    c2.clientID = 3001;
    c2.transact(() => c2.get('notes').insert(0, 'gone'));
    c2.transact(() => c2.get('notes').delete(0, 4));
    const doc = createYDoc(Y.encodeStateAsUpdate(c2), {gc});
    c2.destroy();
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [catalogAppExtension({blockIds: 'absent'})],
        name: 'load-across-gap-seed',
        onError: e => {
          throw e;
        },
      }),
    );
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('seeded')));
      },
      {discrete: true},
    );
    const binding = new YBinding(editor, doc, {
      root: doc.get('notes'),
      schemaVersion: 1,
    });
    binding.start();
    binding.initialize();
    expect(binding.status).toBe('active');
    expect(textOf(doc.get('notes'))).toBe('seeded');
    expect(textOf(doc.get('lexical-y'))).toBe(t.shown);
    binding.dispose();
    editor.dispose();
    doc.destroy();
    t.dispose();
  });

  test('in production the contract does not run the gap probe, and the repair still runs', async () => {
    const env = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      vi.resetModules();
      const raw = await import('../../../internal/RawYDoc');
      const loader = await import('../../../internal/LoadFully');
      // The first load runs the contract's probe: no repair apply of the
      // probe's own (development only), one apply of the state.
      raw.createRawYDoc(rawDoc(SEED, 'AB'), {gc}).destroy();
      expect(loader.LOAD_COUNTERS).toEqual({
        applies: 1,
        exhausted: 0,
        failedCuts: 0,
        keptBytes: 0,
        repairs: 0,
      });
      const t = gapScenario(gc);
      const doc = raw.createRawYDoc(t.state, {gc});
      expect(textOf(doc.get('lexical-y'))).toBe(t.shown);
      expect(loader.LOAD_COUNTERS.repairs).toBe(1);
      doc.destroy();
      t.dispose();
    } finally {
      process.env.NODE_ENV = env;
      vi.resetModules();
    }
  });

  test('nothing pending: a single apply (the fast path)', () => {
    const state = rawDoc(SEED, 'ABCDEFGH');
    const before = {...LOAD_COUNTERS};
    const doc = createRawYDoc(state, {gc});
    expect(LOAD_COUNTERS.applies - before.applies).toBe(1);
    expect(LOAD_COUNTERS.repairs).toBe(before.repairs);
    doc.destroy();
  });
});

// A format item the repair could integrate alone while the other end of
// its format stays blocked: the repair holds it back, as a plain load does
// (the format rule, D112). Otherwise the format would run on over text the
// encoding document showed otherwise, and that a healed document shows
// otherwise too.

/** Every format item a document holds (not deleted), as `key=value`. */
function formatItems(root: Y.Node): string[] {
  const out: string[] = [];
  for (let it = root._start; it !== null; it = it.right) {
    if (!it.deleted && it.content instanceof Y.ContentFormat) {
      out.push(`${it.content.key}=${JSON.stringify(it.content.value)}`);
    }
  }
  return out;
}

/**
 * On a seeded "abcdefgh" (@lexical/y's root), writer A loses "L" after "c",
 * then in one update writes "M" after "L" (blocked) and formats `range`
 * bold: the format items are held behind "M" with it.
 */
function blockedFormat(gc: boolean, from: number, length: number) {
  const seed = rawDoc(SEED, 'abcdefgh');
  const a = plainDoc(gc, seed);
  a.clientID = 1000;
  const ups: Uint8Array<ArrayBuffer>[] = [];
  a.on('update', (u: Uint8Array) => ups.push(new Uint8Array(u)));
  const root = a.get('lexical-y');
  a.transact(() => root.insert(3, 'L')); // lost
  a.transact(() => {
    root.insert(4, 'M');
    root.format(from, length, {'f:bold': true});
  });
  const b = plainDoc(gc, seed);
  b.clientID = 2000;
  Y.applyUpdate(b, ups[1]);
  return {
    a,
    b,
    dispose: () => [a, b].forEach(d => d.destroy()),
    ups,
  };
}

describe.each([false, true])(
  'a format whose other end stays blocked, gc %s',
  gc => {
    for (const [name, from, length, integrable] of [
      // The opener after "a" is integrable; the closer after "L" is not.
      ['an opener integrable, its closer blocked', 1, 3, 'opener'],
      // The opener before "L" is not; the closer after "e" is.
      ['a closer integrable, its opener blocked', 3, 3, 'closer'],
    ] as const) {
      test(`${name}: held back with it, no bold where the encoding document showed none, converged once healed`, () => {
        const t = blockedFormat(gc, from, length);
        // B holds everything A wrote in that update, and shows no bold.
        expect(formatItems(t.b.get('lexical-y'))).toEqual([]);
        expect(textOf(t.b.get('lexical-y'))).toBe('abcdefgh');
        const state = Y.encodeStateAsUpdate(t.b);
        const pending = Y.decodeUpdateV2(t.b.store.pendingStructs!.update);
        const formats = pending.structs.filter(
          s => (s as {content?: unknown}).content instanceof Y.ContentFormat,
        );
        expect(formats).toHaveLength(2);
        // Without the format rule the repair integrates that end alone (and
        // only it): what the rule holds back.
        const unruled = plainDoc(gc, state);
        integrateHeldBehindGapsWith(
          Y,
          unruled,
          undefined,
          true,
          MAX_SUFFIX_APPLIES,
          false,
        );
        expect(formatItems(unruled.get('lexical-y'))).toEqual([
          integrable === 'opener' ? 'f:bold=true' : 'f:bold=null',
        ]);
        unruled.destroy();
        const before = {...LOAD_PLAN_COUNTERS};
        const doc = createYDoc(state, {gc});
        expect(LOAD_PLAN_COUNTERS.heldBack).toBeGreaterThan(before.heldBack);
        // Checked against the maximal repair, and kept: no fallback.
        expect(LOAD_PLAN_COUNTERS.checks).toBe(before.checks + 1);
        expect(LOAD_PLAN_COUNTERS.formatFallback).toBe(before.formatFallback);
        expect(formatItems(doc.get('lexical-y'))).toEqual([]);
        expect(textOf(doc.get('lexical-y'))).toBe('abcdefgh');
        expect(readYState(state, CONFIG, $boldText)).toBe('');
        expect(readYState(state, CONFIG, $text)).toBe('abcdefgh');
        const edited = editYState(
          state,
          CONFIG,
          () => {
            $getRoot().getAllTextNodes()[0].spliceText(0, 0, '!');
          },
          {writer: null},
        );
        expect(readYState(edited.state, CONFIG, $boldText)).toBe('');
        // Once "L" arrives: byte-identical with a plain load, and the format
        // where A put it.
        const plain = plainDoc(gc, state);
        for (const d of [doc, plain]) {
          Y.applyUpdate(d, t.ups[0]);
        }
        expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(
          Buffer.from(Y.encodeStateAsUpdate(plain)),
        );
        expect(formatItems(doc.get('lexical-y'))).toHaveLength(2);
        for (const d of [doc, plain]) {
          d.destroy();
        }
        t.dispose();
      });
    }
  },
);

/** A state vector (format V1) of one client's clock. */
function vectorOf(client: number, clock: number): Uint8Array {
  const bytes: number[] = [1];
  for (let n of [client, clock]) {
    while (n > 127) {
      bytes.push(128 | (n % 128));
      n = Math.floor(n / 128);
    }
    bytes.push(n);
  }
  return new Uint8Array(bytes);
}

/**
 * A peer of seeded "abcdefgh" that received writer A's second update and
 * integrated its bold opener on its own (a suffix from the opener), then
 * A's later updates: "X" typed bold after "a" (needing that opener), "K"
 * after "L", and "c".."L" made plain again (a closer after "b" whose region
 * the opener started). The peer shows "Xb" bold.
 */
function balancingCloser(gc: boolean) {
  const seed = rawDoc(SEED, 'abcdefgh');
  const a = plainDoc(gc, seed);
  a.clientID = 3000;
  const ups: Uint8Array<ArrayBuffer>[] = [];
  a.on('update', (u: Uint8Array) => ups.push(new Uint8Array(u)));
  const root = a.get('lexical-y');
  a.transact(() => root.insert(3, 'L')); // lost
  a.transact(() => {
    root.insert(4, 'M');
    root.format(1, 3, {'f:bold': true});
  });
  a.transact(() => root.insert(1, 'X', {'f:bold': true}));
  a.transact(() => root.insert(5, 'K'));
  a.transact(() => root.format(3, 2, {'f:bold': null}));
  const peer = plainDoc(gc, seed);
  peer.clientID = 2;
  Y.applyUpdate(peer, ups[1]);
  const pending = peer.store.pendingStructs!;
  const opener = Y.decodeUpdateV2(pending.update).structs.find(
    s => (s as {content?: unknown}).content instanceof Y.ContentFormat,
  )!;
  Y.applyUpdateV2(
    peer,
    Y.diffUpdateV2(pending.update, vectorOf(3000, opener.id.clock)),
  );
  for (const u of ups.slice(2)) {
    Y.applyUpdate(peer, u);
  }
  return {a, dispose: () => [a, peer].forEach(d => d.destroy()), peer, ups};
}

/** Bold text of @lexical/y's root, read from its format items. */
function rawBold(doc: Y.Doc): string {
  let bold = false;
  let out = '';
  for (let it = doc.get('lexical-y')._start; it !== null; it = it.right) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof Y.ContentFormat && it.content.key === 'f:bold') {
      bold = it.content.value === true;
    } else if (it.content instanceof Y.ContentString && bold) {
      out += it.content.str;
    }
  }
  return out;
}

describe.each([false, true])(
  'a held cut checked against the maximal repair, gc %s',
  gc => {
    test('a closer held back would let a region its opener started spread: the load falls back to the maximal repair ("Xb" bold, as the peer shows)', () => {
      const t = balancingCloser(gc);
      expect(rawBold(t.peer)).toBe('Xb');
      const state = Y.encodeStateAsUpdate(t.peer);
      const unruled = plainDoc(gc, state);
      integrateHeldBehindGapsWith(
        Y,
        unruled,
        undefined,
        true,
        MAX_SUFFIX_APPLIES,
        false,
      );
      expect(rawBold(unruled)).toBe('Xb');
      const before = {...LOAD_PLAN_COUNTERS};
      const doc = createYDoc(state, {gc});
      expect(LOAD_PLAN_COUNTERS.checks).toBe(before.checks + 1);
      expect(LOAD_PLAN_COUNTERS.formatFallback).toBe(before.formatFallback + 1);
      expect(rawBold(doc)).toBe('Xb');
      expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(
        Buffer.from(Y.encodeStateAsUpdate(unruled)),
      );
      expect(readYState(state, CONFIG, $boldText)).toBe('Xb');
      expect(readYState(state, CONFIG, $text)).toBe('aXbcdefgh');
      // Once healed, as a plain load.
      const plain = plainDoc(gc, state);
      for (const d of [doc, plain]) {
        for (const u of t.ups) {
          Y.applyUpdate(d, u);
        }
      }
      expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(
        Buffer.from(Y.encodeStateAsUpdate(plain)),
      );
      for (const d of [doc, plain, unruled]) {
        d.destroy();
      }
      t.dispose();
    });

    test('holding back a format-only cut never frees the budget for other content at the cost of content the maximal repair recovers', () => {
      const seed = rawDoc(SEED, 'abcd');
      const a = plainDoc(gc, seed);
      a.clientID = 3000;
      const aUps: Uint8Array<ArrayBuffer>[] = [];
      a.on('update', (u: Uint8Array) => aUps.push(new Uint8Array(u)));
      const ar = a.get('lexical-y');
      a.transact(() => ar.insert(3, 'L')); // lost
      a.transact(() => {
        ar.insert(4, 'M');
        ar.format(1, 3, {'f:bold': true});
      });
      const b = plainDoc(gc, Y.encodeStateAsUpdate(a));
      b.clientID = 2000;
      const bUps: Uint8Array<ArrayBuffer>[] = [];
      b.on('update', (u: Uint8Array) => bUps.push(new Uint8Array(u)));
      b.transact(() =>
        b.get('lexical-y').insert(1, 'RECOVERED'.repeat(100), {'f:bold': true}),
      );
      const peer = plainDoc(gc, seed);
      peer.clientID = 2;
      const docs = [a, b, peer];
      Y.applyUpdate(peer, aUps[1]);
      const pending = peer.store.pendingStructs!;
      const opener = Y.decodeUpdateV2(pending.update).structs.find(
        s => (s as {content?: unknown}).content instanceof Y.ContentFormat,
      )!;
      Y.applyUpdateV2(
        peer,
        Y.diffUpdateV2(pending.update, vectorOf(3000, opener.id.clock)),
      );
      Y.applyUpdate(peer, bUps[0]);
      // 1,023 writers, each a struct integrable alone behind a lost one:
      // the maximal plan's cuts fill the budget.
      for (let i = 0; i < 1023; i++) {
        const w = plainDoc(gc, seed);
        w.clientID = 4000 + i;
        const wUps: Uint8Array<ArrayBuffer>[] = [];
        w.on('update', (u: Uint8Array) => wUps.push(new Uint8Array(u)));
        const wr = w.get('lexical-y');
        w.transact(() => wr.insert(0, 'r'));
        w.transact(() => wr.insert(1, 's'));
        w.transact(() => wr.insert(wr.length - 1, 'p'));
        for (const u of wUps.slice(1)) {
          Y.applyUpdate(peer, u);
        }
        docs.push(w);
      }
      const state = Y.encodeStateAsUpdate(peer);
      const unruled = plainDoc(gc, state);
      const result = integrateHeldBehindGapsWith(
        Y,
        unruled,
        undefined,
        true,
        MAX_SUFFIX_APPLIES,
        false,
      );
      expect(result.exhausted).toBe(true);
      expect(textOf(unruled.get('lexical-y'))).toContain(
        'RECOVERED'.repeat(100),
      );
      expect(readYState(state, CONFIG, $text)).toContain(
        'RECOVERED'.repeat(100),
      );
      const doc = createYDoc(state, {gc});
      expect(shownIds(doc, 'lexical-y')).toEqual(
        shownIds(unruled, 'lexical-y'),
      );
      for (const d of [...docs, doc, unruled]) {
        d.destroy();
      }
    }, 60000);
  },
);

describe.each([false, true])(
  'map entries and the text they hold, gc %s',
  gc => {
    /**
     * On "ab" with a node whose attribute "cell" holds a node with "old",
     * writer B (seen) overwrites "cell" with a node holding "t36z"; writer
     * A, concurrently, loses "L", then in one update writes "M" after it
     * (blocked) and `write` (integrable alone, behind "M"). An overwrite's
     * update deletes the entry it replaces, so the plain load shows B's.
     */
    const shape = (write: (node: Y.Node) => void) => {
      const z = plainDoc(gc);
      z.clientID = 1;
      const t = z.get('t');
      const node = new Y.Node('p');
      z.transact(() => {
        t.insert(0, 'ab');
        t.insert(1, [node]);
        const cell = new Y.Node('c');
        node.setAttr('cell', cell);
        cell.insert(0, 'old');
        node.setAttr('s:s1', 1);
      });
      const base = Y.encodeStateAsUpdate(z);
      const b = writerDoc(gc, 2000, base);
      b.d.transact(() => {
        const bt = b.d.get('t');
        let it = bt._start;
        while (it !== null && !(it.content instanceof Y.ContentType)) {
          it = it.right;
        }
        const cell = new Y.Node('c');
        ((it!.content as Y.ContentType).type as Y.Node).setAttr('cell', cell);
        cell.insert(0, 't36z');
      });
      const a = writerDoc(gc, 3000, base);
      const at = a.d.get('t');
      a.d.transact(() => at.insert(0, 'L'));
      a.d.transact(() => {
        at.insert(1, 'M');
        let it = at._start;
        while (it !== null && !(it.content instanceof Y.ContentType)) {
          it = it.right;
        }
        write((it!.content as Y.ContentType).type as Y.Node);
      });
      const peer = plainDoc(gc, base);
      Y.applyUpdate(peer, b.ups[0]);
      Y.applyUpdate(peer, a.ups[1]);
      return {
        dispose: () => [z, a.d, b.d, peer].forEach(d => d.destroy()),
        state: Y.encodeStateAsUpdate(peer),
        ups: a.ups,
      };
    };

    test('a concurrent overwrite of a node-valued entry whose new node is empty: the maximal repair hides the text the plain load shows, the load keeps it (the plain load)', () => {
      const s = shape(node => node.setAttr('cell', new Y.Node('c')));
      const plain = plainDoc(gc, s.state);
      const text = (d: Y.Doc) => attributesShown(d).size;
      expect(textOfCell(plain)).toBe('t36z');
      const unruled = plainDoc(gc, s.state);
      integrateHeldBehindGapsWith(
        Y,
        unruled,
        undefined,
        true,
        MAX_SUFFIX_APPLIES,
        false,
      );
      // The maximal repair shows less text than the plain load.
      expect(textOfCell(unruled)).toBe('');
      expect(text(unruled)).toBeLessThan(text(plain));
      const before = {
        ...LOAD_PLAN_COUNTERS,
        wins: {...LOAD_PLAN_COUNTERS.wins},
      };
      const doc = createRawYDoc(s.state, {gc});
      // A shown entry overwritten: checked, never applied as it is.
      expect(LOAD_PLAN_COUNTERS.checks).toBe(before.checks + 1);
      expect(LOAD_PLAN_COUNTERS.direct).toBe(before.direct);
      expect(LOAD_PLAN_COUNTERS.wins.plain).toBe(before.wins.plain + 1);
      expect(textOfCell(doc)).toBe('t36z');
      expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(
        Buffer.from(Y.encodeStateAsUpdate(plain)),
      );
      // Once healed, as a plain load.
      for (const d of [doc, plain]) {
        for (const u of s.ups) {
          Y.applyUpdate(d, u);
        }
      }
      expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(
        Buffer.from(Y.encodeStateAsUpdate(plain)),
      );
      [doc, plain, unruled].forEach(d => d.destroy());
      s.dispose();
    });

    test('an attribute overwritten (NodeState): the value the plain load or the maximal repair shows, never another, and no text lost', () => {
      const s = shape(node => node.setAttr('s:s1', 2));
      const before = {
        ...LOAD_PLAN_COUNTERS,
        wins: {...LOAD_PLAN_COUNTERS.wins},
      };
      const doc = createRawYDoc(s.state, {gc});
      // The entry it overwrites is not shown (its update deleted it): the
      // maximal plan applies without the check.
      expect(LOAD_PLAN_COUNTERS.checks).toBe(before.checks);
      expect(LOAD_PLAN_COUNTERS.direct).toBe(before.direct + 1);
      const value = (d: Y.Doc) =>
        [...entriesOf(d)].find(([k]) => k.endsWith('|s:s1'))?.[1];
      const plain = plainDoc(gc, s.state);
      // The overwrite's update deleted the old value; the new one waits.
      expect(value(plain)).toBe(undefined);
      expect(value(doc)).toBe('[2]');
      expect(textOfCell(doc)).toBe('t36z');
      [doc, plain].forEach(d => d.destroy());
      s.dispose();
    });
  },
);

/** The text of the first node's "cell" attribute (its node's text). */
function textOfCell(doc: Y.Doc): string {
  for (let it = doc.get('t')._start; it !== null; it = it.right) {
    if (!it.deleted && it.content instanceof Y.ContentType) {
      const cell = (it.content.type as Y.Node)._map.get('cell');
      if (cell === undefined || cell.deleted) {
        return '';
      }
      return textOf((cell.content as Y.ContentType).type as Y.Node);
    }
  }
  return '';
}

/** The ids of the characters a document shows, in nodes too. */
function attributesShown(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  const walk = (node: Y.Node) => {
    for (let it = node._start; it !== null; it = it.right) {
      if (it.deleted) {
        continue;
      }
      if (it.content instanceof Y.ContentString) {
        for (let i = 0; i < it.length; i++) {
          ids.add(`${it.id.client}:${it.id.clock + i}`);
        }
      } else if (it.content instanceof Y.ContentType) {
        walk(it.content.type as Y.Node);
      }
    }
    node._map.forEach(item => {
      if (!item.deleted && item.content instanceof Y.ContentType) {
        walk(item.content.type as Y.Node);
      }
    });
  };
  walk(doc.get('t'));
  return ids;
}

describe.each([false, true])(
  'what the check meets: values, roots, observers, work, gc %s',
  gc => {
    for (const [kind, value] of [
      ['a bigint', () => BigInt(42)],
      ['undefined', () => undefined],
      ['null', () => null],
      ['bytes', () => new Uint8Array([1, 2])],
      ['a subdocument', () => new Y.Doc({gc})],
    ] as const) {
      test(`${kind} in a root's attributes and another root: the check runs, nothing thrown, the text and bold the maximal repair shows`, () => {
        const t = balancingCloser(gc);
        const v = value();
        t.peer.transact(() => {
          t.peer.get('lexical-y').setAttr('meta', v);
          t.peer.get('metadata').setAttr('value', v);
        });
        const state = Y.encodeStateAsUpdate(t.peer);
        const before = {...LOAD_PLAN_COUNTERS};
        const doc = createYDoc(state, {gc});
        expect(LOAD_PLAN_COUNTERS.checks).toBe(before.checks + 1);
        expect(LOAD_PLAN_COUNTERS.checkFailed).toBe(before.checkFailed);
        expect(textOf(doc.get('lexical-y'))).toBe('aXbcdefgh');
        expect(rawBold(doc)).toBe('Xb');
        expect(readYState(state, CONFIG, $text)).toBe('aXbcdefgh');
        doc.destroy();
        if (v instanceof Y.Doc) {
          v.destroy();
        }
        t.dispose();
      });
    }

    test('an observer that writes while the plan applies: no assertion trips, and its write stays', () => {
      const t = balancingCloser(gc);
      const state = Y.encodeStateAsUpdate(t.peer);
      const writer = plainDoc(gc, state);
      writer.clientID = 8000;
      const ups: Uint8Array<ArrayBuffer>[] = [];
      writer.on('update', (u: Uint8Array) => ups.push(new Uint8Array(u)));
      writer.transact(() => writer.get('lexical-y').setAttr('metadata', 7));
      const doc = plainDoc(gc, state);
      const origin = {};
      let fed = false;
      const feed = (tr: Y.Transaction) => {
        if (tr.origin === origin && !fed) {
          fed = true;
          Y.applyUpdate(doc, ups[0], 'provider');
        }
      };
      doc.on('afterTransaction', feed);
      expect(() =>
        integrateHeldBehindGapsWith(Y, doc, origin, true),
      ).not.toThrow();
      doc.off('afterTransaction', feed);
      expect(fed).toBe(true);
      expect(doc.get('lexical-y').getAttr('metadata')).toBe(7);
      expect(rawBold(doc)).toBe('Xb');
      [doc, writer].forEach(d => d.destroy());
      t.dispose();
    });

    test("a root named like a type's id: its entries never stand for the type's, and each entry shows the plain load's value or the maximal repair's", () => {
      for (const collision of [false, true]) {
        const z = plainDoc(gc);
        z.clientID = 1;
        const root = z.get('t');
        const node = new Y.Node('p');
        z.transact(() => {
          root.insert(0, 'abcd');
          root.insert(1, [node]);
          node.setAttr('s:other', 'A');
        });
        const id = node._item!.id;
        if (collision) {
          z.get(`${id.client}:${id.clock}`).setAttr('s:s1', 'CONST');
        }
        const base = Y.encodeStateAsUpdate(z);
        const child = (d: Y.Doc) => {
          for (let it = d.get('t')._start; it !== null; it = it.right) {
            if (!it.deleted && it.content instanceof Y.ContentType) {
              return it.content.type as Y.Node;
            }
          }
          throw new Error('no node');
        };
        const a = writerDoc(gc, 3000, base);
        const at = a.d.get('t');
        a.d.transact(() => at.insert(3, 'L'));
        a.d.transact(() => {
          at.insert(4, 'M');
          child(a.d).setAttr('s:s1', 'C');
          at.format(1, 3, {bold: true});
        });
        const b = writerDoc(gc, 2000, base);
        const bt = b.d.get('t');
        b.d.transact(() => bt.insert(0, 'R'));
        b.d.transact(() => {
          bt.insert(1, 'S');
          child(b.d).setAttr('s:s1', 'D');
        });
        const peer = plainDoc(gc, base);
        Y.applyUpdate(peer, a.ups[1]);
        Y.applyUpdate(peer, b.ups[1]);
        const state = Y.encodeStateAsUpdate(peer);
        const plain = plainDoc(gc, state);
        const unruled = plainDoc(gc, state);
        integrateHeldBehindGapsWith(
          Y,
          unruled,
          undefined,
          true,
          MAX_SUFFIX_APPLIES,
          false,
        );
        const doc = createRawYDoc(state, {gc});
        const value = (d: Y.Doc) => child(d).getAttr('s:s1');
        expect([value(plain), value(unruled)]).toContain(value(doc));
        if (collision) {
          expect(doc.get(`${id.client}:${id.clock}`).getAttr('s:s1')).toBe(
            'CONST',
          );
        }
        [z, a.d, b.d, peer, plain, unruled, doc].forEach(d => d.destroy());
      }
    });

    test("the format rule's trials stop at their visit bound, every visit counted (512 roots, one client's long runs)", () => {
      const z = plainDoc(gc);
      z.clientID = 1;
      for (let i = 0; i < 512; i++) {
        z.get(`t${i}`).insert(0, 'abcd');
      }
      const base = Y.encodeStateAsUpdate(z);
      const a = writerDoc(gc, 1000, base);
      a.d.transact(() => a.d.get('t0').insert(3, 'L'));
      a.d.transact(() => {
        a.d.get('t0').insert(4, 'M');
        a.d.get('t0').format(1, 3, {bold: true});
        for (let i = 1; i < 512; i++) {
          a.d.get(`t${i}`).format(1, 2, {bold: true});
        }
      });
      const peer = plainDoc(gc, base);
      Y.applyUpdate(peer, a.ups[1]);
      const state = Y.encodeStateAsUpdate(peer);
      const before = LOAD_PLAN_COUNTERS.trialVisits;
      const t0 = performance.now();
      const doc = createRawYDoc(state, {gc});
      const ms = performance.now() - t0;
      expect(LOAD_PLAN_COUNTERS.trialVisits - before).toBeLessThanOrEqual(
        MAX_TRIAL_VISITS,
      );
      // Unbounded, these trials took 2.7 s.
      expect(ms).toBeLessThan(2000);
      [z, a.d, peer, doc].forEach(d => d.destroy());
    }, 30000);
  },
);

describe.each([false, true])('stored values shaped like types, gc %s', gc => {
  const mk = (id: number, state?: Uint8Array) => {
    const d = plainDoc(gc, state ?? null);
    d.clientID = id;
    return d;
  };
  const firstNode = (d: Y.Doc) => {
    for (let it = d.get('t')._start; it !== null; it = it.right) {
      if (!it.deleted && it.content instanceof Y.ContentType) {
        return it.content.type as Y.Node;
      }
    }
    throw new Error('no node');
  };
  const loads = (state: Uint8Array) => {
    const plain = mk(5000, state);
    const maximal = mk(6000, state);
    integrateHeldBehindGapsWith(
      Y,
      maximal,
      undefined,
      true,
      MAX_SUFFIX_APPLIES,
      false,
    );
    const repaired = mk(7000, state);
    integrateHeldBehindGapsWith(Y, repaired, undefined, true);
    return {maximal, plain, repaired};
  };

  for (const kind of ['normal', 'item-object'] as const) {
    test(`a concurrent overwrite of a node-valued entry beside a ${kind} payload: the text the plain load shows stays`, () => {
      const z = mk(1);
      z.transact(() => {
        const p = new Y.Node('p');
        z.get('t').insert(0, [p]);
        const c = new Y.Node('c');
        p.setAttr('cell', c);
        c.insert(0, 'old');
        p.setAttr(
          's:payload',
          kind === 'normal' ? {value: 1} : {_item: {}, value: 1},
        );
      });
      const base = Y.encodeStateAsUpdate(z);
      const b = writerDoc(gc, 2000, base);
      b.d.transact(() => {
        const c = new Y.Node('c');
        firstNode(b.d).setAttr('cell', c);
        c.insert(0, 't36z');
      });
      const a = writerDoc(gc, 3000, base);
      a.d.transact(() => a.d.get('t').insert(0, 'L'));
      a.d.transact(() => {
        a.d.get('t').insert(1, 'M');
        firstNode(a.d).setAttr('cell', new Y.Node('c'));
      });
      const peer = mk(4000, base);
      Y.applyUpdate(peer, b.ups[0]);
      Y.applyUpdate(peer, a.ups[1]);
      const before = LOAD_PLAN_COUNTERS.checkFailed;
      const {maximal, plain, repaired} = loads(Y.encodeStateAsUpdate(peer));
      const cell = (d: Y.Doc) => textOf(firstNode(d).getAttr('cell') as Y.Node);
      expect(cell(plain)).toBe('t36z');
      expect(cell(maximal)).toBe('');
      expect(cell(repaired)).toBe('t36z');
      expect(LOAD_PLAN_COUNTERS.checkFailed).toBe(before);
      [z, a.d, b.d, peer, plain, maximal, repaired].forEach(d => d.destroy());
    });
  }

  for (const kind of ['normal', 'item-null'] as const) {
    test(`a map value (${kind}) shows the plain load's or the maximal repair's, never a third`, () => {
      const value = (v: string) => (kind === 'normal' ? {v} : {_item: null, v});
      const z = mk(1);
      z.transact(() => {
        const p = new Y.Node('p');
        z.get('t').insert(0, [p]);
        p.insert(0, 'abcd');
      });
      const base = Y.encodeStateAsUpdate(z);
      const p = writerDoc(gc, 1000, base);
      p.d.transact(() => firstNode(p.d).setAttr('s:value', value('P')));
      const c = writerDoc(gc, 2000, base);
      c.d.transact(() => firstNode(c.d).insert(1, 'L'));
      c.d.transact(() => {
        firstNode(c.d).insert(2, 'M');
        firstNode(c.d).setAttr('s:value', value('R'));
      });
      const a = writerDoc(gc, 3000, base);
      a.d.transact(() => firstNode(a.d).insert(1, 'L'));
      a.d.transact(() => {
        firstNode(a.d).insert(2, 'M');
        firstNode(a.d).setAttr('s:value', value('V'));
        firstNode(a.d).format(0, 2, {'f:bold': true});
      });
      const peer = mk(4000, base);
      Y.applyUpdate(peer, p.ups[0]);
      Y.applyUpdate(peer, c.ups[1]);
      Y.applyUpdate(peer, a.ups[1]);
      const {maximal, plain, repaired} = loads(Y.encodeStateAsUpdate(peer));
      const get = (d: Y.Doc) => firstNode(d).getAttr('s:value');
      expect(get(plain)).toEqual(value('P'));
      expect(get(maximal)).toEqual(value('V'));
      expect([
        JSON.stringify(get(plain)),
        JSON.stringify(get(maximal)),
      ]).toContain(JSON.stringify(get(repaired)));
      [z, p.d, c.d, a.d, peer, plain, maximal, repaired].forEach(d =>
        d.destroy(),
      );
    });
  }

  test('a check that throws (injected): the plain load, counted', () => {
    const t = balancingCloser(gc);
    const state = Y.encodeStateAsUpdate(t.peer);
    const before = {
      ...LOAD_PLAN_COUNTERS,
      wins: {...LOAD_PLAN_COUNTERS.wins},
    };
    forcedCheckFailures++;
    LOAD_TEST_HOOKS.check = () => {
      throw new Error('injected');
    };
    let doc: Y.Doc;
    try {
      doc = createRawYDoc(state, {gc});
    } finally {
      LOAD_TEST_HOOKS.check = null;
    }
    expect(LOAD_PLAN_COUNTERS.checkFailed).toBe(before.checkFailed + 1);
    expect(LOAD_PLAN_COUNTERS.wins.plain).toBe(before.wins.plain + 1);
    const plain = plainDoc(gc, state);
    expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(
      Buffer.from(Y.encodeStateAsUpdate(plain)),
    );
    [doc, plain].forEach(d => d.destroy());
    t.dispose();
  });
});

/**
 * A legal dependency chain across `n` clients (each lost clock 0, a blocked
 * clock 1 and an independent clock 2 after the previous client's clock 2),
 * and one concurrent map entry (the check runs): encoded with stock struct
 * writers.
 */
function clientChain(gc: boolean, n: number): Uint8Array {
  const source = new Y.Doc({gc});
  source.clientID = 1;
  source.cleanupFormatting = false;
  const root = source.get('t');
  root.insert(0, 'A');
  root.setAttr('key', 'P');
  const clients = source.store.clients as Map<number, unknown[]>;
  const item = (
    client: number,
    clock: number,
    origin: ReturnType<typeof Y.createID> | null,
    sub: string | null,
    content: Y.Item['content'],
  ) =>
    new Y.Item(
      Y.createID(client, clock),
      null,
      origin,
      null,
      null,
      root,
      sub,
      content,
    );
  for (let i = 0; i < n; i++) {
    const client = 10000 + i;
    const origin = i === 0 ? Y.createID(1, 0) : Y.createID(client - 1, 2);
    clients.set(client, [
      new Y.Skip(Y.createID(client, 0), 1),
      item(client, 1, Y.createID(client, 0), null, new Y.ContentString('M')),
      item(client, 2, origin, null, new Y.ContentString('Z')),
    ]);
  }
  const client = 10000 + n + 50000;
  clients.set(client, [
    new Y.Skip(Y.createID(client, 0), 1),
    item(client, 1, Y.createID(client, 0), null, new Y.ContentString('M')),
    item(client, 2, null, 'key', new Y.ContentAny(['V'])),
  ]);
  const encoded = Y.encodeStateAsUpdateV2(source);
  source.destroy();
  return encoded;
}

describe('inputs as large or as deep as they are legal', () => {
  for (const [n, gcs] of [
    [8000, [false, true]],
    [50000, [false]],
  ] as const) {
    for (const gc of gcs) {
      // 50,000 clients take minutes (the maximal repair's 1,024 cuts over
      // 100,000 pending structs, on the copy and then the document): run
      // with LEXICAL_Y_HEAVY=1.
      test.skipIf(n > 8000 && !process.env.LEXICAL_Y_HEAVY)(
        `a ${n}-client dependency chain: no stack overflow, what the maximal repair shows, gc ${gc}`,
        () => {
          const input = clientChain(gc, n);
          const load = (rule: boolean) => {
            const d = new Y.Doc({gc});
            d.cleanupFormatting = false;
            Y.applyUpdateV2(d, input);
            integrateHeldBehindGapsWith(
              Y,
              d,
              undefined,
              true,
              MAX_SUFFIX_APPLIES,
              rule,
            );
            return d;
          };
          const unruled = load(false);
          const doc = load(true);
          expect(textOf(doc.get('t')).length).toBeGreaterThanOrEqual(1024);
          expect([...shownIds(doc)].sort()).toEqual(
            [...shownIds(unruled)].sort(),
          );
          expect(doc.get('t').getAttr('key')).toBe(
            unruled.get('t').getAttr('key'),
          );
          [doc, unruled].forEach(d => d.destroy());
        },
        600000,
      );
    }
  }

  test.each([false, true])(
    'a node-valued entry 2,000 levels deep, overwritten concurrently: no stack overflow, the plain load (the text it shows stays), gc %s',
    gc => {
      // @y/y's own Item#delete recurses through nested types (two frames a
      // level), so a much deeper tree overflows inside @y/y itself on Node
      // 22's default stack, whatever the loader does. The loader's own walks
      // are iterative: the long client chains above and the deeply nested
      // stored value below cover that.
      const nest = (cell: Y.Node, text: string) => {
        let node = cell;
        for (let i = 0; i < 2000; i++) {
          const child = new Y.Node('c');
          node.insert(0, [child]);
          node = child;
        }
        node.insert(0, text);
      };
      const z = plainDoc(gc);
      z.clientID = 1;
      z.transact(() => {
        const p = new Y.Node('p');
        z.get('t').insert(0, [p]);
        const cell = new Y.Node('c');
        p.setAttr('cell', cell);
        nest(cell, 'old');
      });
      const base = Y.encodeStateAsUpdate(z);
      const p = (d: Y.Doc) => {
        for (let it = d.get('t')._start; it !== null; it = it.right) {
          if (!it.deleted && it.content instanceof Y.ContentType) {
            return it.content.type as Y.Node;
          }
        }
        throw new Error('no node');
      };
      const b = writerDoc(gc, 2000, base);
      b.d.transact(() => {
        const cell = new Y.Node('c');
        p(b.d).setAttr('cell', cell);
        nest(cell, 't36z');
      });
      const a = writerDoc(gc, 3000, base);
      a.d.transact(() => a.d.get('t').insert(0, 'L'));
      a.d.transact(() => {
        a.d.get('t').insert(1, 'M');
        p(a.d).setAttr('cell', new Y.Node('c'));
      });
      const peer = plainDoc(gc, base);
      Y.applyUpdate(peer, b.ups[0]);
      Y.applyUpdate(peer, a.ups[1]);
      const state = Y.encodeStateAsUpdate(peer);
      const plain = plainDoc(gc, state);
      const before = {
        ...LOAD_PLAN_COUNTERS,
        wins: {...LOAD_PLAN_COUNTERS.wins},
      };
      const doc = createRawYDoc(state, {gc});
      expect(LOAD_PLAN_COUNTERS.checks).toBe(before.checks + 1);
      expect(LOAD_PLAN_COUNTERS.wins.plain).toBe(before.wins.plain + 1);
      expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(
        Buffer.from(Y.encodeStateAsUpdate(plain)),
      );
      [z, a.d, b.d, peer, plain, doc].forEach(d => d.destroy());
    },
    120000,
  );

  test.each([false, true])(
    'a stored value nested 20,000 levels deep: loaded without reading it, gc %s',
    gc => {
      let value: unknown = 'leaf';
      for (let i = 0; i < 20000; i++) {
        value = i % 2 === 0 ? [value] : {_item: null, v: value};
      }
      const t = balancingCloser(gc);
      let state: Uint8Array | null = null;
      try {
        t.peer.get('lexical-y').setAttr('deep', value as never);
        state = Y.encodeStateAsUpdate(t.peer);
      } catch {
        // Yjs itself cannot store a value this deep: nothing to load.
      }
      if (state !== null) {
        const doc = createYDoc(state, {gc});
        expect(textOf(doc.get('lexical-y'))).toBe('aXbcdefgh');
        expect(rawBold(doc)).toBe('Xb');
        doc.destroy();
      }
      t.dispose();
    },
    60000,
  );
});

describe.each([false, true])('a plan the budget cuts short, gc %s', gc => {
  for (const budget of [1, MAX_SUFFIX_APPLIES]) {
    test(`takes no holds (a hold would free budget for a map write the maximal repair never applies), budget ${budget}`, () => {
      const mk = (id: number, state?: Uint8Array) => {
        const d = new Y.Doc({gc});
        d.clientID = id;
        d.cleanupFormatting = false;
        if (state !== undefined) {
          Y.applyUpdateV2(d, state);
        }
        return d;
      };
      const docs: Y.Doc[] = [];
      const writer = (id: number, state: Uint8Array) => {
        const doc = mk(id, state);
        docs.push(doc);
        const updates: Uint8Array<ArrayBuffer>[] = [];
        doc.on('updateV2', (u: Uint8Array) => updates.push(new Uint8Array(u)));
        return {doc, updates};
      };
      const inner = (d: Y.Doc) => {
        for (let it = d.get('t')._start; it !== null; it = it.right) {
          if (!it.deleted && it.content instanceof Y.ContentType) {
            return it.content.type as Y.Node;
          }
        }
        throw new Error('no node');
      };
      const z = mk(1);
      docs.push(z);
      z.transact(() => {
        const p = new Y.Node('p');
        z.get('t').insert(0, [p]);
        p.insert(0, 'abcd');
      });
      const base = Y.encodeStateAsUpdateV2(z);
      // P: a value the plain load shows; a held format; R, a concurrent
      // value behind "M" that only a cut past the budget integrates.
      const p = writer(1000, base);
      p.doc.transact(() => inner(p.doc).setAttr('s:value', 'P'));
      const a = writer(3000, base);
      a.doc.transact(() => inner(a.doc).insert(1, 'L'));
      a.doc.transact(() => {
        inner(a.doc).insert(2, 'M');
        inner(a.doc).format(0, 2, {'f:bold': true});
      });
      const c = writer(2000, base);
      c.doc.transact(() => c.doc.get('u').insert(0, 'L'));
      c.doc.transact(() => {
        c.doc.get('u').insert(1, 'M');
        inner(c.doc).setAttr('s:value', 'R');
      });
      const pending = [a.updates[1], c.updates[1]];
      for (let i = 0; i < budget - 1; i++) {
        const w = writer(30000 + i, base);
        w.doc.transact(() => w.doc.get('u').insert(0, 'L'));
        w.doc.transact(() => {
          w.doc.get('u').insert(1, 'M');
          inner(w.doc).setAttr(`pad${i}`, false);
        });
        pending.push(w.updates[1]);
      }
      const peer = mk(4000, base);
      docs.push(peer);
      Y.applyUpdateV2(peer, p.updates[0]);
      Y.applyUpdateV2(peer, Y.mergeUpdatesV2(pending));
      const input = Y.encodeStateAsUpdateV2(peer);
      const plain = mk(5000, input);
      const maximal = mk(6000, input);
      const repaired = mk(7000, input);
      docs.push(plain, maximal, repaired);
      integrateHeldBehindGapsWith(Y, maximal, undefined, true, budget, false);
      integrateHeldBehindGapsWith(Y, repaired, undefined, true, budget, true);
      expect(inner(plain).getAttr('s:value')).toBe('P');
      expect(inner(maximal).getAttr('s:value')).toBe('P');
      expect(inner(repaired).getAttr('s:value')).toBe('P');
      docs.forEach(d => d.destroy());
    }, 120000);
  }
});

describe.each([false, true])('a plan that no longer holds, gc %s', gc => {
  /**
   * Writer A on "abc": "L" (lost), "P" after it (blocked), "Q" at the start
   * (integrable alone), "R" after "P" (blocked): the plan's one cut is "Q",
   * stopped at "R".
   */
  const shape = () => {
    const z = plainDoc(gc);
    z.clientID = 1;
    z.get('t').insert(0, 'abc');
    const base = Y.encodeStateAsUpdate(z);
    const a = writerDoc(gc, 3000, base);
    const t = a.d.get('t');
    a.d.transact(() => t.insert(1, 'L'));
    a.d.transact(() => t.insert(2, 'P'));
    a.d.transact(() => t.insert(0, 'Q'));
    a.d.transact(() => t.insert(4, 'R'));
    const peer = plainDoc(gc, base);
    for (const u of a.ups.slice(1)) {
      Y.applyUpdate(peer, u);
    }
    const state = Y.encodeStateAsUpdate(peer);
    return {
      dispose: () => [z, a.d, peer].forEach(d => d.destroy()),
      state,
      ups: a.ups,
    };
  };

  test("an observer that supplies the stop's dependency integrates more than planned: counted, the plan stops, nothing thrown", () => {
    const s = shape();
    const doc = plainDoc(gc, s.state);
    const origin = {};
    let fed = false;
    const feed = (tr: Y.Transaction) => {
      if (tr.origin === origin && !fed) {
        fed = true;
        Y.applyUpdate(doc, s.ups[0], 'provider');
        Y.applyUpdate(doc, s.ups[1], 'provider');
      }
    };
    doc.on('afterTransaction', feed);
    const before = LOAD_PLAN_COUNTERS.mispredicted;
    const result = integrateHeldBehindGapsWith(Y, doc, origin, true);
    doc.off('afterTransaction', feed);
    expect(fed).toBe(true);
    expect(result.failedCuts).toBe(1);
    expect(LOAD_PLAN_COUNTERS.mispredicted).toBe(before + 1);
    expect(textOf(doc.get('t'))).toBe('QaLPRbc');
    const whole = plainDoc(gc, s.state);
    for (const u of s.ups) {
      Y.applyUpdate(whole, u);
    }
    expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(
      Buffer.from(Y.encodeStateAsUpdate(whole)),
    );
    [doc, whole].forEach(d => d.destroy());
    s.dispose();
  });

  test('a cut that does not integrate what was planned: counted, thrown in development, the load as a plain apply left it in production', () => {
    const s = shape();
    for (const rethrow of [true, false]) {
      const doc = plainDoc(gc, s.state);
      const before = LOAD_PLAN_COUNTERS.mispredicted;
      const skipping: GapRepairYjs = {...countingYjs({applies: 0})};
      let calls = 0;
      const y: GapRepairYjs = {
        ...skipping,
        applyUpdateV2: (d, u, o) => {
          if (++calls > 1) {
            Y.applyUpdateV2(d, u, o);
          }
        },
      };
      const run = () => integrateHeldBehindGapsWith(y, doc, undefined, rethrow);
      if (rethrow) {
        expect(run).toThrow(/plan did not hold at 3000:2/);
      } else {
        expect(run().failedCuts).toBe(1);
      }
      expect(LOAD_PLAN_COUNTERS.mispredicted).toBe(before + 1);
      expect(textOf(doc.get('t'))).toBe('abc');
      doc.destroy();
    }
    s.dispose();
  });
});

// The repair on plain Yjs documents (a root "t"), with the shapes a single
// cut rule misses and a property test over random gap scenarios.

type Shown = Set<string>;

/** Every item a document shows (text, nodes, attributes), by id. */
function shownIds(doc: Y.Doc, root = 't'): Shown {
  const ids: Shown = new Set();
  const walk = (node: Y.Node) => {
    node._map.forEach(item => {
      if (!item.deleted) {
        ids.add(`${item.id.client}:${item.id.clock}`);
      }
    });
    for (let it = node._start; it !== null; it = it.right) {
      if (it.deleted) {
        continue;
      }
      for (let i = 0; i < it.length; i++) {
        ids.add(`${it.id.client}:${it.id.clock + i}`);
      }
      if (it.content instanceof Y.ContentType) {
        walk(it.content.type as Y.Node);
      }
    }
  };
  walk(doc.get(root));
  return ids;
}

function plainDoc(gc: boolean, state: Uint8Array | null = null): Y.Doc {
  const d = new Y.Doc({gc});
  d.cleanupFormatting = false;
  if (state !== null) {
    Y.applyUpdate(d, state);
  }
  return d;
}

function writerDoc(gc: boolean, clientID: number, state: Uint8Array) {
  const d = plainDoc(gc, state);
  d.clientID = clientID;
  // Its own writes only (what it applies from others is theirs).
  const ups: Uint8Array<ArrayBuffer>[] = [];
  d.on(
    'update',
    (u: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction) => {
      if (tr.local) {
        ups.push(new Uint8Array(u));
      }
    },
  );
  return {d, ups};
}

/** Load `state` both ways and check the loader's guarantees; the extras. */
function checkLoad(
  gc: boolean,
  shown: Shown,
  state: Uint8Array,
  heal: readonly Uint8Array[],
): {extras: number; lost: number; plainLost: number} {
  const repaired = createRawYDoc(state, {gc});
  const plain = plainDoc(gc, state);
  const got = shownIds(repaired);
  const lost = [...shown].filter(id => !got.has(id)).length;
  const plainShown = shownIds(plain);
  const plainLost = [...shown].filter(id => !plainShown.has(id)).length;
  const extras = [...got].filter(id => !shown.has(id));
  // An extra is a struct in the bytes (its origins present, as Yjs
  // integrated it) ...
  const inBytes = new Set<string>();
  for (const s of Y.decodeUpdate(state).structs) {
    for (let i = 0; i < s.length; i++) {
      inBytes.add(`${s.id.client}:${s.id.clock + i}`);
    }
  }
  for (const id of extras) {
    expect(inBytes.has(id)).toBe(true);
  }
  // ... placed where a plain apply puts it once the gap heals: both end
  // byte-identical.
  for (const doc of [repaired, plain]) {
    for (const u of heal) {
      Y.applyUpdate(doc, u);
    }
  }
  expect(Buffer.from(Y.encodeStateAsUpdate(repaired))).toEqual(
    Buffer.from(Y.encodeStateAsUpdate(plain)),
  );
  expect(Buffer.from(Y.encodeStateVector(repaired))).toEqual(
    Buffer.from(Y.encodeStateVector(plain)),
  );
  repaired.destroy();
  plain.destroy();
  return {extras: extras.length, lost, plainLost};
}

describe.each([false, true])(
  'the repair on shapes a single cut misses, gc %s',
  gc => {
    test('a blocked run that spans a node, its attributes and children: the later struct is still integrated', () => {
      const z = plainDoc(gc);
      z.clientID = 1;
      z.get('t').insert(0, 'ABCD');
      const base = Y.encodeStateAsUpdate(z);
      // M's "m" never arrives; N's node is written next to it (its right
      // origin is "m"), its attributes and children inside it, then text
      // whose origins are the base's.
      const m = writerDoc(gc, 230369314, base);
      m.d.transact(() => m.d.get('t').insert(1, 'm'));
      const n = writerDoc(gc, 1653873637, base);
      Y.applyUpdate(n.d, m.ups[0]);
      n.d.transact(() => {
        const node = new Y.Node('p');
        n.d.get('t').insert(1, [node]);
        node.setAttr('k', 1);
        node.setAttr('j', 'v');
        node.insert(0, 'inner');
        node.insert(0, [new Y.Node('q')]);
      });
      // Between C and D (A, the node, m, B, C come first).
      n.d.transact(() => n.d.get('t').insert(5, '乗乘'));
      const d = plainDoc(gc, base);
      for (const u of n.ups) {
        Y.applyUpdate(d, u);
      }
      expect(textOf(d.get('t'))).toContain('乗乘');
      const result = checkLoad(gc, shownIds(d), Y.encodeStateAsUpdate(d), [
        ...m.ups,
        ...n.ups,
      ]);
      expect(result.plainLost).toBeGreaterThan(0);
      expect(result.lost).toBe(0);
      for (const doc of [d, z, m.d, n.d]) {
        doc.destroy();
      }
    });

    for (const order of ['A before B', 'B before A'] as const) {
      test(`two clients, each with a blocked and an integrable struct, B's depending on A's (${order})`, () => {
        const z = plainDoc(gc);
        z.clientID = 1;
        z.get('t').insert(0, 'AB');
        const base = Y.encodeStateAsUpdate(z);
        // Client ids decide the order clients appear in a pending update.
        const [idA, idB] = order === 'A before B' ? [10, 20] : [20, 10];
        const a = writerDoc(gc, idA, base);
        a.d.transact(() => a.d.get('t').insert(1, 'x'));
        a.d.transact(() => a.d.get('t').insert(1, 'y')); // depends on "x"
        a.d.transact(() => a.d.get('t').insert(4, 'q')); // does not
        const b = writerDoc(gc, idB, base);
        for (const u of a.ups) {
          Y.applyUpdate(b.d, u);
        }
        b.d.transact(() => b.d.get('t').insert(1, 'u'));
        b.d.transact(() => b.d.get('t').insert(1, 'v')); // depends on "u"
        // After "q" (A's integrable struct): depends on it.
        b.d.transact(() =>
          b.d.get('t').insert(textOf(b.d.get('t')).indexOf('q') + 1, 's'),
        );
        const d = plainDoc(gc, base);
        for (const u of [a.ups[1], a.ups[2], b.ups[1], b.ups[2]]) {
          Y.applyUpdate(d, u);
        }
        expect(textOf(d.get('t'))).toContain('qs');
        const result = checkLoad(gc, shownIds(d), Y.encodeStateAsUpdate(d), [
          ...a.ups,
          ...b.ups,
        ]);
        expect(result.plainLost).toBeGreaterThan(0);
        expect(result.lost).toBe(0);
        for (const doc of [d, z, a.d, b.d]) {
          doc.destroy();
        }
      });
    }
  },
);

describe.each([false, true])(
  'a round that throws drops no pending struct, gc %s',
  gc => {
    for (const fault of ['decodeUpdateV2', 'mergeUpdatesV2'] as const) {
      test(`an observer's pending update survives a ${fault} that throws while it is kept`, () => {
        // Two integrable stretches behind a blocked run of writer 1000. On
        // the repair's first suffix, an observer applies writer 900's second
        // update (pending without the first). Taking that pending set then
        // decodes it (is it in P?) and merges it into what is kept: a throw
        // there must not lose it.
        const z = plainDoc(gc);
        z.clientID = 1;
        z.get('t').insert(0, 'ABCD');
        const base = Y.encodeStateAsUpdate(z);
        const w = writerDoc(gc, 1000, base);
        const root = w.d.get('t');
        w.d.transact(() => root.insert(0, 'L')); // lost
        for (let i = 0; i < 2; i++) {
          w.d.transact(() => root.insert(1, 'b'));
          w.d.transact(() => root.insert(root.length - 1 - i, 'e'));
        }
        const source = plainDoc(gc, base);
        for (const u of w.ups.slice(1)) {
          Y.applyUpdate(source, u);
        }
        const state = Y.encodeStateAsUpdate(source);
        const q = writerDoc(gc, 900, base);
        q.d.transact(() => q.d.get('t').insert(0, 'U'));
        q.d.transact(() => q.d.get('t').insert(1, 'V'));
        const doc = plainDoc(gc, state);
        const control = plainDoc(gc, state);
        const origin = {};
        let fed = false;
        const feed = (tr: Y.Transaction) => {
          if (tr.origin === origin && !fed) {
            fed = true;
            Y.applyUpdate(doc, q.ups[1], 'provider');
          }
        };
        doc.on('afterTransaction', feed);
        let decodes = 0;
        let merges = 0;
        const y: GapRepairYjs = {
          Skip: Y.Skip,
          applyUpdateV2: Y.applyUpdateV2,
          decodeUpdateV2: u => {
            if (fault === 'decodeUpdateV2' && ++decodes === 2) {
              throw new Error('injected');
            }
            return Y.decodeUpdateV2(u);
          },
          diffUpdateV2: Y.diffUpdateV2,
          mergeUpdatesV2: us => {
            if (fault === 'mergeUpdatesV2' && ++merges === 1) {
              throw new Error('injected');
            }
            return Y.mergeUpdatesV2(us);
          },
        };
        integrateHeldBehindGapsWith(y, doc, origin, false);
        doc.off('afterTransaction', feed);
        expect(fed).toBe(true);
        Y.applyUpdate(control, q.ups[1]);
        for (const d of [doc, control]) {
          for (const u of [...w.ups, q.ups[0]]) {
            Y.applyUpdate(d, u);
          }
        }
        expect(plainText(doc)).toBe(plainText(control));
        expect(plainText(doc)).toContain('UV');
        expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(
          Buffer.from(Y.encodeStateAsUpdate(control)),
        );
        for (const d of [z, w.d, source, q.d, doc, control]) {
          d.destroy();
        }
      });
    }
    for (const rethrow of [true, false]) {
      test(`${rethrow ? 'development: restored, then rethrown' : 'production: restored, and the load goes on'}`, () => {
        // Each apply of the round in turn throws: at the first (nothing is
        // pending yet: the saved structs are put back), later ones (Yjs
        // pended some again: P is re-applied whole) and the last.
        for (let throwAt = 1; throwAt <= 12; throwAt++) {
          const t = gapScenario(gc);
          const doc = plainDoc(gc, t.state);
          const plainShown = shownIds(doc);
          expect(doc.store.pendingStructs).not.toBeNull();
          let calls = 0;
          const injected = new Error('injected');
          const y: GapRepairYjs = {
            Skip: Y.Skip,
            applyUpdateV2: (d, u, o) => {
              if (++calls === throwAt) {
                throw injected;
              }
              Y.applyUpdateV2(d, u, o);
            },
            decodeUpdateV2: Y.decodeUpdateV2,
            diffUpdateV2: Y.diffUpdateV2,
            mergeUpdatesV2: Y.mergeUpdatesV2,
          };
          let thrown: unknown = null;
          try {
            integrateHeldBehindGapsWith(y, doc, undefined, rethrow);
          } catch (e) {
            thrown = e;
          }
          const threw = calls >= throwAt;
          expect(thrown).toBe(threw && rethrow ? injected : null);
          // Never worse than a plain apply: everything it showed is shown,
          // and what is not integrated is pending still ...
          const got = shownIds(doc);
          expect([...plainShown].filter(id => !got.has(id))).toEqual([]);
          expect(doc.store.pendingStructs).not.toBeNull();
          // ... so once the missing updates arrive it ends byte-identical
          // with a plain load.
          const plain = plainDoc(gc, t.state);
          for (const d of [doc, plain]) {
            for (const u of t.ups) {
              Y.applyUpdate(d, u);
            }
          }
          expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(
            Buffer.from(Y.encodeStateAsUpdate(plain)),
          );
          doc.destroy();
          plain.destroy();
          t.dispose();
        }
      });
    }
  },
);

/** The repair's own @y/y functions, `applyUpdateV2` counted. */
function countingYjs(counts: {applies: number}): GapRepairYjs {
  return {
    Skip: Y.Skip,
    applyUpdateV2: (d, u, o) => {
      counts.applies++;
      Y.applyUpdateV2(d, u, o);
    },
    decodeUpdateV2: Y.decodeUpdateV2,
    diffUpdateV2: Y.diffUpdateV2,
    mergeUpdatesV2: Y.mergeUpdatesV2,
  };
}

const plainText = (d: Y.Doc) => textOf(d.get('t'));

/**
 * A chain of `n` writers on "AB": each gets the previous writers' history
 * and writes "x" after A, "y" before it (it depends on "x") and its letter
 * at the end, after the previous writer's. A peer gets only each writer's
 * last two updates, separately: it shows every letter, each integrated
 * across its writer's gap, each depending on the one before.
 */
function chain(gc: boolean, n: number, descending: boolean) {
  const z = plainDoc(gc);
  z.clientID = 1;
  z.get('t').insert(0, 'AB');
  const base = Y.encodeStateAsUpdate(z);
  const full = plainDoc(gc, base);
  const peer = plainDoc(gc, base);
  const all: Uint8Array<ArrayBuffer>[] = [];
  const docs = [z, full, peer];
  for (let k = 0; k < n; k++) {
    const w = writerDoc(
      gc,
      descending ? 1000 + n - k : 1000 + k,
      Y.encodeStateAsUpdate(full),
    );
    docs.push(w.d);
    const t = w.d.get('t');
    w.d.transact(() => t.insert(1, 'x'));
    w.d.transact(() => t.insert(1, 'y'));
    w.d.transact(() => t.insert(t.length, String.fromCharCode(67 + k)));
    for (const u of w.ups) {
      Y.applyUpdate(full, u);
    }
    for (const u of w.ups.slice(1)) {
      Y.applyUpdate(peer, u);
    }
    all.push(...w.ups);
  }
  return {
    all,
    dispose: () => docs.forEach(d => d.destroy()),
    shown: plainText(peer),
    state: Y.encodeStateAsUpdate(peer),
  };
}

describe.each([false, true])('dependency chains across clients, gc %s', gc => {
  for (const n of [9, 12, 20]) {
    for (const descending of [false, true]) {
      test(`${n} writers, ${descending ? 'descending' : 'ascending'} ids: the whole chain, stable before healing`, () => {
        const c = chain(gc, n, descending);
        expect(c.shown).toBe(
          'AB' +
            Array.from({length: n}, (_, k) => String.fromCharCode(67 + k)).join(
              '',
            ),
        );
        const plain = plainDoc(gc, c.state);
        expect(plainText(plain)).not.toBe(c.shown);
        const first = createRawYDoc(c.state, {gc});
        expect(plainText(first)).toBe(c.shown);
        const second = createRawYDoc(Y.encodeStateAsUpdate(first), {gc});
        expect(plainText(second)).toBe(c.shown);
        const publicLoad = createYDoc(c.state, {gc});
        expect(plainText(publicLoad)).toBe(c.shown);
        for (const d of [first, plain]) {
          for (const u of c.all) {
            Y.applyUpdate(d, u);
          }
        }
        expect(Buffer.from(Y.encodeStateAsUpdate(first))).toEqual(
          Buffer.from(Y.encodeStateAsUpdate(plain)),
        );
        for (const d of [first, second, publicLoad, plain]) {
          d.destroy();
        }
        c.dispose();
      });
    }
  }
});

describe.each([false, true])(
  'chains a round cap would cut short, gc %s',
  gc => {
    test('one writer, 9 hops: each letter after the one before, each behind a blocked struct of its own writer', () => {
      const z = plainDoc(gc);
      z.clientID = 1;
      z.get('t').insert(0, 'AB');
      const base = Y.encodeStateAsUpdate(z);
      const w = writerDoc(gc, 1000, base);
      const t = w.d.get('t');
      w.d.transact(() => t.insert(2, 'L')); // lost
      for (let k = 0; k < 9; k++) {
        w.d.transact(() => t.insert(t.length, 'z')); // after L: blocked
        w.d.transact(() => t.insert(1 + k, String.fromCharCode(97 + k)));
      }
      const peer = plainDoc(gc, base);
      for (const u of w.ups.slice(1)) {
        Y.applyUpdate(peer, u);
      }
      expect(plainText(peer)).toBe('AabcdefghiB');
      const state = Y.encodeStateAsUpdate(peer);
      expect(plainText(plainDoc(gc, state))).toBe('AB');
      const doc = createRawYDoc(state, {gc});
      expect(plainText(doc)).toBe('AabcdefghiB');
      expect(plainText(createRawYDoc(Y.encodeStateAsUpdate(doc), {gc}))).toBe(
        'AabcdefghiB',
      );
      for (const d of [z, w.d, peer, doc]) {
        d.destroy();
      }
    });

    test("two writers taking 16 turns: each letter after the other writer's, each behind a blocked struct of its writer", () => {
      const z = plainDoc(gc);
      z.clientID = 1;
      z.get('t').insert(0, 'AB');
      const base = Y.encodeStateAsUpdate(z);
      const writers = [writerDoc(gc, 2000, base), writerDoc(gc, 1000, base)];
      for (const w of writers) {
        w.d.transact(() => w.d.get('t').insert(2, 'L')); // lost
      }
      const peer = plainDoc(gc, base);
      const delivered: Uint8Array[] = [];
      let letters = '';
      for (let turn = 0; turn < 16; turn++) {
        const w = writers[turn % 2];
        const other = writers[(turn + 1) % 2];
        // It has the other writer's history.
        for (const u of other.ups) {
          Y.applyUpdate(w.d, u);
        }
        const t = w.d.get('t');
        const from = w.ups.length;
        w.d.transact(() => t.insert(t.length, 'z')); // at the end: after an L
        const letter = String.fromCharCode(97 + turn);
        w.d.transact(() => t.insert(1 + turn, letter));
        letters += letter;
        delivered.push(...w.ups.slice(from));
      }
      for (const u of delivered) {
        Y.applyUpdate(peer, u);
      }
      expect(plainText(peer)).toBe(`A${letters}B`);
      const state = Y.encodeStateAsUpdate(peer);
      const doc = createRawYDoc(state, {gc});
      expect(plainText(doc)).toBe(`A${letters}B`);
      const plain = plainDoc(gc, state);
      for (const d of [doc, plain]) {
        for (const w of writers) {
          for (const u of w.ups) {
            Y.applyUpdate(d, u);
          }
        }
      }
      expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(
        Buffer.from(Y.encodeStateAsUpdate(plain)),
      );
      for (const d of [z, ...writers.map(w => w.d), peer, doc, plain]) {
        d.destroy();
      }
    });
  },
);

/** `count` edits at scattered places in a lost run, one update each. */
function scatteredBehindLostRun(gc: boolean, count: number) {
  const w = writerDoc(gc, 100, Y.encodeStateAsUpdate(plainDoc(gc)));
  const t = w.d.get('t');
  w.d.transact(() => t.insert(0, 'l'.repeat(count))); // lost
  for (let i = 0; i < count; i++) {
    // Inside the lost run (after its character count - 1 - i): blocked.
    w.d.transact(() => t.insert(count - i, 's'));
  }
  return {
    dispose: () => w.d.destroy(),
    heal: w.ups,
    state: Y.mergeUpdates(w.ups.slice(1)),
  };
}

/** A node written before `count` attribute writes under it, one each. */
function attributesUnderWithheldNode(gc: boolean, count: number) {
  const w = writerDoc(gc, 100, Y.encodeStateAsUpdate(plainDoc(gc)));
  const parent = new Y.Node('p');
  w.d.transact(() => w.d.get('t').insert(0, [parent]));
  for (let i = 0; i < count; i++) {
    w.d.transact(() => parent.setAttr('key' + i, i));
  }
  return {
    dispose: () => w.d.destroy(),
    heal: w.ups,
    state: Y.mergeUpdates(w.ups.slice(1)),
  };
}

/** A block of `count` nodes (each with an attribute and text) after a lost node. */
function pasteBehindLostNode(gc: boolean, count: number) {
  const z = plainDoc(gc);
  z.clientID = 1;
  z.get('t').insert(0, [new Y.Node('p')]);
  const base = Y.encodeStateAsUpdate(z);
  const a = writerDoc(gc, 1000, base);
  const root = a.d.get('t');
  a.d.transact(() => root.insert(1, [new Y.Node('lost')]));
  a.d.transact(() => {
    for (let i = 0; i < count; i++) {
      const node = new Y.Node('p');
      root.insert(root.length, [node]);
      node.setAttr('k', `v${i}`);
      node.insert(0, [`x${i}`]);
    }
  });
  const b = plainDoc(gc, base);
  Y.applyUpdate(b, a.ups[1]);
  return {
    dispose: () => [z, a.d, b].forEach(d => d.destroy()),
    heal: a.ups,
    state: Y.encodeStateAsUpdate(b),
  };
}

describe.each([false, true])(
  'the cost of genuinely blocked structs, gc %s',
  gc => {
    for (const [name, make, count] of [
      [
        '3,000 attribute writes under a withheld node',
        attributesUnderWithheldNode,
        3000,
      ],
      ['a 2,000-node paste behind a lost node', pasteBehindLostNode, 2000],
      ['8,000 edits scattered behind a lost run', scatteredBehindLostRun, 8000],
    ] as const) {
      test(`${name}: no suffix apply and no re-apply, converged once healed`, () => {
        const t = make(gc, count);
        let t0 = performance.now();
        const plain = plainDoc(gc, t.state);
        const plainMs = performance.now() - t0;
        const counts = {applies: 0};
        const doc = plainDoc(gc, t.state);
        t0 = performance.now();
        const result = integrateHeldBehindGapsWith(countingYjs(counts), doc);
        const repairMs = performance.now() - t0;
        // Nothing is integrable: no suffix is applied, and the pending
        // structs, never cleared, are left as they are.
        expect(result).toEqual({
          exhausted: false,
          failedCuts: 0,
          suffixApplies: 0,
        });
        expect(counts.applies).toBe(0);
        expect(doc.store.pendingStructs).not.toBeNull();
        if (process.env.LEXICAL_Y_LOAD_STATS) {
          console.warn(
            `cost ${JSON.stringify({applies: counts.applies + 1, bytes: t.state.length, count, gc, name, plainMs, repairMs})}`,
          );
        }
        for (const d of [doc, plain]) {
          for (const u of t.heal) {
            Y.applyUpdate(d, u);
          }
        }
        expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(
          Buffer.from(Y.encodeStateAsUpdate(plain)),
        );
        doc.destroy();
        plain.destroy();
        t.dispose();
      });
    }

    test('many separate integrable edits behind one blocked struct: one suffix apply', () => {
      const z = plainDoc(gc);
      z.clientID = 1;
      z.get('t').insert(0, 'x'.repeat(800));
      const base = Y.encodeStateAsUpdate(z);
      const a = writerDoc(gc, 1000, base);
      const root = a.d.get('t');
      a.d.transact(() => root.insert(0, 'L')); // lost
      a.d.transact(() => root.insert(1, 'B')); // after L: blocked without it
      for (let i = 0; i < 400; i++) {
        a.d.transact(() => root.insert(2 + i * 3, 'e'));
      }
      const b = plainDoc(gc, base);
      for (const u of a.ups.slice(1)) {
        Y.applyUpdate(b, u);
      }
      const state = Y.encodeStateAsUpdate(b);
      const doc = plainDoc(gc, state);
      const counts = {applies: 0};
      const result = integrateHeldBehindGapsWith(countingYjs(counts), doc);
      expect(plainText(doc)).toBe(plainText(b));
      expect(result.suffixApplies).toBe(1);
      expect(counts.applies).toBe(2);
      for (const d of [z, a.d, b, doc]) {
        d.destroy();
      }
    }, 30000);

    test("1,000 blocked stretches: the pending updates it holds stay about P's size (not one per suffix), all integrate, and it converges once healed", () => {
      const z = plainDoc(gc);
      z.clientID = 1;
      z.get('t').insert(0, 'x'.repeat(4000));
      const base = Y.encodeStateAsUpdate(z);
      const a = writerDoc(gc, 1000, base);
      const root = a.d.get('t');
      a.d.transact(() => root.insert(0, 'L')); // lost
      // 1,000 stretches: an edit after L (blocked without it), then one in
      // Z's text (integrable).
      for (let i = 0; i < 1000; i++) {
        a.d.transact(() => root.insert(1, 'b'));
        a.d.transact(() => root.insert(root.length - 1 - i * 3, 'e'));
      }
      const b = plainDoc(gc, base);
      for (const u of a.ups.slice(1)) {
        Y.applyUpdate(b, u);
      }
      const state = Y.encodeStateAsUpdate(b);
      const count = (d: Y.Doc) => plainText(d).split('e').length - 1;
      const doc = plainDoc(gc, state);
      const pending = doc.store.pendingStructs;
      expect(pending).not.toBeNull();
      const pendingBytes = pending === null ? 0 : pending.update.length;
      LOAD_COUNTERS.keptBytes = 0;
      const result = integrateHeldBehindGapsWith(
        countingYjs({applies: 0}),
        doc,
      );
      expect(result).toEqual({
        exhausted: false,
        failedCuts: 0,
        suffixApplies: 1000,
      });
      expect(count(doc)).toBe(1000);
      // The peak of what it held: P alone. Keeping every cleared update, as
      // before, held the sum of 1,000 shrinking suffixes of P.
      expect(LOAD_COUNTERS.keptBytes).toBe(pendingBytes);
      const plain = plainDoc(gc, state);
      for (const d of [doc, plain]) {
        for (const u of a.ups) {
          Y.applyUpdate(d, u);
        }
      }
      expect(Y.encodeStateAsUpdate(doc)).toEqual(Y.encodeStateAsUpdate(plain));
      for (const d of [z, a.d, b, doc, plain]) {
        d.destroy();
      }
    }, 30000);

    test('past its budget the repair stops: what it integrated stays, every other struct stays pending, and it converges once healed', () => {
      const z = plainDoc(gc);
      z.clientID = 1;
      z.get('t').insert(0, 'x'.repeat(1200));
      const base = Y.encodeStateAsUpdate(z);
      const a = writerDoc(gc, 1000, base);
      const root = a.d.get('t');
      a.d.transact(() => root.insert(0, 'L')); // lost
      // 300 blocked stretches: an edit after L, then one in Z's text.
      for (let i = 0; i < 300; i++) {
        a.d.transact(() => root.insert(1, 'b'));
        a.d.transact(() => root.insert(root.length - 1 - i * 3, 'e'));
      }
      const b = plainDoc(gc, base);
      for (const u of a.ups.slice(1)) {
        Y.applyUpdate(b, u);
      }
      const state = Y.encodeStateAsUpdate(b);
      const count = (d: Y.Doc) => plainText(d).split('e').length - 1;
      const plain = plainDoc(gc, state);
      const doc = plainDoc(gc, state);
      const counts = {applies: 0};
      const result = integrateHeldBehindGapsWith(
        countingYjs(counts),
        doc,
        undefined,
        true,
        50,
      );
      expect(result).toEqual({
        exhausted: true,
        failedCuts: 0,
        suffixApplies: 50,
      });
      expect(counts.applies).toBe(51);
      expect(count(plain)).toBe(0);
      expect(count(doc)).toBe(50);
      expect(doc.store.pendingStructs).not.toBeNull();
      // Within the default budget, all of them.
      const full = createRawYDoc(state, {gc});
      expect(count(full)).toBe(300);
      for (const d of [doc, plain, full]) {
        for (const u of a.ups) {
          Y.applyUpdate(d, u);
        }
      }
      expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(
        Buffer.from(Y.encodeStateAsUpdate(plain)),
      );
      expect(Buffer.from(Y.encodeStateAsUpdate(full))).toEqual(
        Buffer.from(Y.encodeStateAsUpdate(plain)),
      );
      for (const d of [z, a.d, b, doc, plain, full]) {
        d.destroy();
      }
    });
  },
);

describe.each([false, true])(
  'an observer that supplies pending material and throws, gc %s',
  gc => {
    for (const rethrow of [true, false]) {
      test(`${rethrow ? 'development' : 'production'}: the material it supplied survives the restore, and converges once healed`, () => {
        const c = chain(gc, 2, false);
        const doc = plainDoc(gc, c.state);
        // Writer 900: "u", then "v" before it (depends on "u", withheld).
        const z = plainDoc(gc);
        z.clientID = 1;
        z.get('t').insert(0, 'AB');
        const w = writerDoc(gc, 900, Y.encodeStateAsUpdate(z));
        w.d.transact(() => w.d.get('t').insert(1, 'u'));
        w.d.transact(() => w.d.get('t').insert(1, 'v'));
        const origin = {};
        let fed = false;
        let callbacks = 0;
        // On every repair transaction (the restore's included): the first
        // time it supplies "v" (pending: it needs "u"), then it throws.
        const listener = (tr: Y.Transaction) => {
          if (tr.origin === origin) {
            callbacks++;
            if (!fed) {
              fed = true;
              Y.applyUpdate(doc, w.ups[1], 'provider');
            }
            throw new Error('observer');
          }
        };
        doc.on('afterTransaction', listener);
        let thrown: unknown = null;
        try {
          integrateHeldBehindGapsWith(Y, doc, origin, rethrow);
        } catch (e) {
          thrown = e;
        }
        doc.off('afterTransaction', listener);
        expect(fed).toBe(true);
        expect(callbacks).toBeGreaterThanOrEqual(2);
        expect(thrown === null).toBe(!rethrow);
        // "v" is pending still.
        expect(
          Y.decodeUpdateV2(doc.store.pendingStructs!.update).structs.some(
            s => s.id.client === 900,
          ),
        ).toBe(true);
        // Healed: the same as a plain document that got "v" and everything.
        const control = plainDoc(gc, c.state);
        Y.applyUpdate(control, w.ups[1]);
        for (const u of [...c.all, w.ups[0]]) {
          Y.applyUpdate(doc, u);
          Y.applyUpdate(control, u);
        }
        expect(plainText(doc)).toContain('v');
        expect(plainText(doc)).toBe(plainText(control));
        expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(
          Buffer.from(Y.encodeStateAsUpdate(control)),
        );
        for (const d of [doc, control, z, w.d]) {
          d.destroy();
        }
        c.dispose();
      });
    }

    test("the live runner's apply is a plain one: an observer's pending material survives its throw", () => {
      const c = chain(gc, 2, false);
      const doc = createYDoc(rawDoc(SEED, 'hello'), {gc});
      const z = plainDoc(gc);
      z.clientID = 1;
      z.get('t').insert(0, 'AB');
      const base = Y.encodeStateAsUpdate(z);
      Y.applyUpdate(doc, base);
      const w = writerDoc(gc, 900, base);
      w.d.transact(() => w.d.get('t').insert(1, 'u'));
      w.d.transact(() => w.d.get('t').insert(1, 'v'));
      let count = 0;
      // The migration's apply is its one transaction: in its observer a
      // provider supplies the gapped state and "v" (pending: it needs "u"),
      // and the observer throws.
      const listener = (tr: Y.Transaction) => {
        if (tr.origin === MIGRATION_ORIGIN) {
          count++;
          Y.applyUpdate(doc, c.state, 'provider');
          Y.applyUpdate(doc, w.ups[1], 'provider');
          throw new Error('observer');
        }
      };
      doc.on('afterTransaction', listener);
      try {
        migrateYDoc(doc, [STAMP], {to: SEED + 1});
      } catch {
        // The observer's error (development) or none (production).
      }
      doc.off('afterTransaction', listener);
      expect(count).toBe(1);
      const control = plainDoc(gc, c.state);
      Y.applyUpdate(control, w.ups[1]);
      for (const u of [...c.all, w.ups[0]]) {
        Y.applyUpdate(doc, u);
        Y.applyUpdate(control, u);
      }
      expect(plainText(doc)).toBe(plainText(control));
      for (const d of [doc, control, z, w.d]) {
        d.destroy();
      }
      c.dispose();
    });
  },
);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Every map entry a document shows (not deleted) in every reachable type,
 * by `parent|key` (a root by name, a type by its item's id): its value as
 * JSON, a type as its item's id.
 */
function entriesOf(doc: Y.Doc): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: Y.Node, name: string) => {
    node._map.forEach((item, key) => {
      if (item.deleted) {
        return;
      }
      const id = `${item.id.client}:${item.id.clock}`;
      if (item.content instanceof Y.ContentType) {
        out.set(`${name}|${key}`, `type:${id}`);
        walk(item.content.type as Y.Node, id);
      } else {
        out.set(`${name}|${key}`, JSON.stringify(item.content.getContent()));
      }
    });
    for (let it = node._start; it !== null; it = it.right) {
      if (!it.deleted && it.content instanceof Y.ContentType) {
        walk(it.content.type as Y.Node, `${it.id.client}:${it.id.clock}`);
      }
    }
  };
  walk(doc.get('t'), 't');
  return out;
}

describe('a property: a load shows everything the encoding document showed', () => {
  test('random gap scenarios (writers, dropped updates, own and batched delivery, nodes, gc on and off)', () => {
    const totals = {
      extraItems: 0,
      loads: 0,
      loadsWithExtras: 0,
      plainLosses: 0,
      repairApplies: 0,
      repairLoads: 0,
      repairMs: 0,
    };
    const startCounters = {...LOAD_COUNTERS};
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const gc = r() < 0.5;
      const z = plainDoc(gc);
      z.clientID = 1;
      z.get('t').insert(0, 'ABCDEFGHIJ');
      const base = Y.encodeStateAsUpdate(z);
      const writers = Array.from({length: 2 + Math.floor(r() * 3)}, (_, i) =>
        writerDoc(gc, 1000 * (i + 1), base),
      );
      const ups: Uint8Array<ArrayBuffer>[] = [];
      for (const w of writers) {
        w.d.on(
          'update',
          (u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) => {
            if (tr.local) {
              ups.push(new Uint8Array(u));
            }
          },
        );
      }
      for (let step = 0; step < 6 + Math.floor(r() * 8); step++) {
        const w = writers[Math.floor(r() * writers.length)].d;
        const t = w.get('t');
        const roll = r();
        if (roll < 0.15) {
          w.transact(() => {
            const node = new Y.Node('p');
            t.insert(Math.floor(r() * (t.length + 1)), [node]);
            node.setAttr('k', 1);
            node.insert(0, 'inner');
            node.insert(0, [new Y.Node('q')]);
          });
        } else if (roll < 0.8 || t.length < 3) {
          w.transact(() =>
            t.insert(
              Math.floor(r() * (t.length + 1)),
              'xyz'.slice(0, 1 + Math.floor(r() * 3)),
            ),
          );
        } else {
          w.transact(() => t.delete(Math.floor(r() * (t.length - 1)), 1));
        }
        if (r() < 0.4) {
          const o = writers[Math.floor(r() * writers.length)].d;
          if (o !== w) {
            Y.applyUpdate(o, Y.encodeStateAsUpdate(w, Y.encodeStateVector(o)));
          }
        }
      }
      // Peers: updates dropped, delivered alone or batched.
      const peers = [0, 1, 2].map(k => {
        const p = plainDoc(gc, base);
        p.clientID = 9000 + k;
        let batch: Uint8Array[] = [];
        for (const u of ups) {
          if (r() < 0.25) {
            continue;
          }
          if (r() < 0.4) {
            batch.push(u);
          } else {
            if (batch.length > 0) {
              Y.applyUpdate(
                p,
                Y.mergeUpdates(batch as Uint8Array<ArrayBuffer>[]),
              );
              batch = [];
            }
            Y.applyUpdate(p, u);
          }
        }
        if (batch.length > 0) {
          Y.applyUpdate(p, Y.mergeUpdates(batch as Uint8Array<ArrayBuffer>[]));
        }
        return p;
      });
      for (let k = 1; k < peers.length; k++) {
        if (r() < 0.5) {
          Y.applyUpdate(
            peers[k],
            Y.encodeStateAsUpdate(peers[k - 1], Y.encodeStateVector(peers[k])),
          );
        }
      }
      for (const p of peers) {
        if (r() < 0.5) {
          const t = p.get('t');
          p.transact(() => t.insert(Math.floor(r() * (t.length + 1)), 'Q'));
        }
      }
      for (const p of peers) {
        const state = Y.encodeStateAsUpdate(p);
        const before = {...LOAD_COUNTERS};
        const t0 = performance.now();
        const probe = createRawYDoc(state, {gc});
        const ms = performance.now() - t0;
        probe.destroy();
        if (LOAD_COUNTERS.repairs > before.repairs) {
          totals.repairLoads++;
          totals.repairApplies += LOAD_COUNTERS.applies - before.applies;
          totals.repairMs += ms;
        } else {
          // Nothing pending: one apply.
          expect(LOAD_COUNTERS.applies - before.applies).toBe(1);
        }
        const result = checkLoad(gc, shownIds(p), state, ups);
        expect(result.lost).toBe(0);
        totals.loads++;
        totals.extraItems += result.extras;
        totals.loadsWithExtras += result.extras > 0 ? 1 : 0;
        totals.plainLosses += result.plainLost > 0 ? 1 : 0;
      }
      for (const doc of [z, ...writers.map(w => w.d), ...peers]) {
        doc.destroy();
      }
    }
    // Every cut integrated, and no load ran out of budget.
    expect(LOAD_COUNTERS.failedCuts).toBe(startCounters.failedCuts);
    expect(LOAD_COUNTERS.exhausted).toBe(startCounters.exhausted);
    // The scenarios do reach the bug.
    expect(totals.plainLosses).toBeGreaterThan(0);
    if (process.env.LEXICAL_Y_LOAD_STATS) {
      console.warn(`load stats ${JSON.stringify(totals)}`);
    }
  }, 120000);

  test('with formatting: all the text the maximal repair recovers, format-only runs held back unless content needs them; third values measured', () => {
    /**
     * Each text character a document shows, by id: its attributes (a
     * format's key and value, the format items before it in its node). With
     * `deleted`, a deleted character too (its string, or a garbage
     * collected run), as the attributes where it is.
     */
    const attributes = (
      doc: Y.Doc,
      deleted = false,
    ): Map<string, Map<string, unknown>> => {
      const out = new Map<string, Map<string, unknown>>();
      const walk = (node: Y.Node) => {
        const attrs = new Map<string, unknown>();
        for (let it = node._start; it !== null; it = it.right) {
          const gone =
            it.deleted &&
            (it.content instanceof Y.ContentString ||
              it.content.constructor.name === 'ContentDeleted');
          if (it.deleted && !(deleted && gone)) {
            continue;
          }
          if (it.content instanceof Y.ContentFormat) {
            if (it.content.value === null) {
              attrs.delete(it.content.key);
            } else {
              attrs.set(it.content.key, it.content.value);
            }
          } else if (it.content instanceof Y.ContentString || gone) {
            for (let i = 0; i < it.length; i++) {
              out.set(`${it.id.client}:${it.id.clock + i}`, new Map(attrs));
            }
          } else if (it.content instanceof Y.ContentType) {
            walk(it.content.type as Y.Node);
          }
        }
        // A node an attribute holds (a cell).
        node._map.forEach(item => {
          if (!item.deleted && item.content instanceof Y.ContentType) {
            walk(item.content.type as Y.Node);
          }
        });
      };
      walk(doc.get('t'));
      return out;
    };
    type View = Map<string, Map<string, unknown>>;
    /**
     * The attributes (character and key) a load shows as none of `views`
     * shows them, among `chars`.
     */
    const thirdValues = (load: View, views: View[], chars: Set<string>) => {
      let n = 0;
      for (const id of chars) {
        const own = load.get(id)!;
        const others = views
          .map(v => v.get(id))
          .filter((v): v is Map<string, unknown> => v !== undefined);
        const keys = new Set([
          ...own.keys(),
          ...others.flatMap(o => [...o.keys()]),
        ]);
        for (const key of keys) {
          const value = own.get(key) ?? null;
          if (
            others.length > 0 &&
            !others.some(o => (o.get(key) ?? null) === value)
          ) {
            n++;
          }
        }
      }
      return n;
    };
    // Per variant: the repair (format-only runs held back unless content
    // needs them), the repair without the format rule, and a plain load.
    const variants = ['repair', 'unruled', 'plain'] as const;
    const stat = () => ({
      // Characters the load shows that a plain load lacks.
      recovered: 0,

      // Characters the encoding document showed that the load does not.
      shortfall: 0,

      // Attributes shown as neither the plain load, the healed document nor
      // the encoding document shows them: on text the plain load shows, on
      // text it lacks; and on text the plain load shows in loads where no
      // format item of the healed document is missing from the bytes.
      thirdOnPlain: 0,

      thirdOnPlainFormatsInBytes: 0,

      thirdOnRest: 0,
    });
    const stats = Object.fromEntries(variants.map(v => [v, stat()])) as Record<
      (typeof variants)[number],
      ReturnType<typeof stat>
    >;
    const totals = {
      checks: 0,
      fallbacks: 0,
      formatLoads: 0,
      heldBackCuts: 0,
      loads: 0,
      wins: {held: 0, maximal: 0, plain: 0},
    };
    // Load times (ms) of the loads the check ran on, and of the maximal
    // repair on the same loads.
    const checkedMs: number[] = [];
    const unruledMs: number[] = [];
    const startPlan = {...LOAD_PLAN_COUNTERS};
    // Every load that skips the check: the check, run on a copy, passes.
    let direct = 0;
    LOAD_TEST_HOOKS.direct = wouldPass => {
      direct++;
      if (!wouldPass()) {
        throw new Error('a load skipped the check that it would fail');
      }
    };
    // Every check also builds V on a copy of its own: V built on the held
    // result must equal it.
    LOAD_TEST_HOOKS.verifyV = true;
    const seeds = Number(process.env.LEXICAL_Y_FORMAT_SEEDS || 500);
    for (let seed = 1; seed <= seeds; seed++) {
      const r = rng(seed * 7919);
      const gc = r() < 0.5;
      const z = plainDoc(gc);
      z.clientID = 1;
      z.get('t').insert(0, 'ABCDEFGHIJ');
      const base = Y.encodeStateAsUpdate(z);
      const writers = Array.from({length: 2 + Math.floor(r() * 3)}, (_, i) =>
        writerDoc(gc, 1000 * (i + 1), base),
      );
      const ups: Uint8Array<ArrayBuffer>[] = [];
      for (const w of writers) {
        w.d.on(
          'update',
          (u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) => {
            if (tr.local) {
              ups.push(new Uint8Array(u));
            }
          },
        );
      }
      for (let step = 0; step < 6 + Math.floor(r() * 10); step++) {
        const w = writers[Math.floor(r() * writers.length)].d;
        const t = w.get('t');
        const roll = r();
        const at = () => Math.floor(r() * (t.length + 1));
        // The nodes the writer's list shows (for attribute writes).
        const nodes: Y.Node[] = [];
        for (let it = t._start; it !== null; it = it.right) {
          if (!it.deleted && it.content instanceof Y.ContentType) {
            nodes.push(it.content.type as Y.Node);
          }
        }
        if (roll < 0.1) {
          w.transact(() => {
            const node = new Y.Node('p');
            t.insert(at(), [node]);
            node.setAttr('k', 1);
            node.insert(0, 'inner');
          });
        } else if (roll < 0.2 && nodes.length > 0) {
          // An attribute set or overwritten: a value, or a node holding
          // text (a cell), sometimes after an insert in the same update.
          const node = nodes[Math.floor(r() * nodes.length)];
          w.transact(() => {
            if (r() < 0.4) {
              t.insert(at(), 'v');
            }
            if (r() < 0.5) {
              node.setAttr('k', Math.floor(r() * 100));
            } else {
              const cell = new Y.Node('c');
              node.setAttr('cell', cell);
              if (r() < 0.7) {
                cell.insert(0, 'cell');
              }
            }
          });
        } else if (roll < 0.55 || t.length < 3) {
          w.transact(() =>
            t.insert(at(), 'xyz'.slice(0, 1 + Math.floor(r() * 3))),
          );
        } else if (roll < 0.65) {
          w.transact(() => t.delete(Math.floor(r() * (t.length - 1)), 1));
        } else {
          // Format or unformat a range, sometimes after an insert in the
          // same update (the format items held behind it).
          const key = r() < 0.6 ? 'bold' : 'italic';
          const value = r() < 0.7 ? true : null;
          w.transact(() => {
            if (r() < 0.4) {
              t.insert(at(), 'w');
            }
            const from = Math.floor(r() * (t.length - 1));
            t.format(from, 1 + Math.floor(r() * (t.length - from - 1)), {
              [key]: value,
            });
          });
        }
        if (r() < 0.4) {
          const o = writers[Math.floor(r() * writers.length)].d;
          if (o !== w) {
            Y.applyUpdate(o, Y.encodeStateAsUpdate(w, Y.encodeStateVector(o)));
          }
        }
      }
      const peers = [0, 1, 2].map(k => {
        const p = plainDoc(gc, base);
        p.clientID = 9000 + k;
        let batch: Uint8Array[] = [];
        for (const u of ups) {
          if (r() < 0.25) {
            continue;
          }
          if (r() < 0.4) {
            batch.push(u);
          } else {
            if (batch.length > 0) {
              Y.applyUpdate(
                p,
                Y.mergeUpdates(batch as Uint8Array<ArrayBuffer>[]),
              );
              batch = [];
            }
            Y.applyUpdate(p, u);
          }
        }
        if (batch.length > 0) {
          Y.applyUpdate(p, Y.mergeUpdates(batch as Uint8Array<ArrayBuffer>[]));
        }
        return p;
      });
      for (let k = 1; k < peers.length; k++) {
        if (r() < 0.5) {
          Y.applyUpdate(
            peers[k],
            Y.encodeStateAsUpdate(peers[k - 1], Y.encodeStateVector(peers[k])),
          );
        }
      }
      for (const p of peers) {
        const state = Y.encodeStateAsUpdate(p);
        const encoding = attributes(p);
        const plain = plainDoc(gc, state);
        const plainView = attributes(plain);
        const healed = plainDoc(gc, state);
        for (const u of ups) {
          Y.applyUpdate(healed, u);
        }
        // A character the missing updates delete: as it would be there.
        const healedView = attributes(healed, true);
        const planBefore = {
          ...LOAD_PLAN_COUNTERS,
          wins: {...LOAD_PLAN_COUNTERS.wins},
        };
        const appliesBefore = LOAD_COUNTERS.applies;
        const t0 = performance.now();
        const repair = createRawYDoc(state, {gc});
        const repairMs = performance.now() - t0;
        if (
          Y.decodeUpdate(state).structs.length > 0 &&
          !plainDoc(gc, state).store.pendingStructs
        ) {
          // Nothing pending: one apply.
          expect(LOAD_COUNTERS.applies - appliesBefore).toBe(1);
        }
        const checked = LOAD_PLAN_COUNTERS.checks > planBefore.checks;
        totals.checks += checked ? 1 : 0;
        totals.fallbacks +=
          LOAD_PLAN_COUNTERS.formatFallback - planBefore.formatFallback;
        for (const name of ['held', 'maximal', 'plain'] as const) {
          totals.wins[name] +=
            LOAD_PLAN_COUNTERS.wins[name] - planBefore.wins[name];
        }
        totals.heldBackCuts +=
          LOAD_PLAN_COUNTERS.heldBack - planBefore.heldBack;
        const loaded = {
          plain: plainDoc(gc, state),
          repair,
          unruled: plainDoc(gc, state),
        };
        const t1 = performance.now();
        integrateHeldBehindGapsWith(
          Y,
          loaded.unruled,
          undefined,
          true,
          MAX_SUFFIX_APPLIES,
          false,
        );
        if (checked) {
          checkedMs.push(repairMs);
          unruledMs.push(performance.now() - t1);
        }
        const views = [plainView, healedView, encoding];
        // Whether every format item the healed document holds is in the
        // bytes.
        const inBytes = new Set<string>();
        for (const s of Y.decodeUpdate(state).structs) {
          for (let i = 0; i < s.length; i++) {
            inBytes.add(`${s.id.client}:${s.id.clock + i}`);
          }
        }
        let formatsInBytes = true;
        for (let it = healed.get('t')._start; it !== null; it = it.right) {
          if (
            it.content instanceof Y.ContentFormat &&
            !inBytes.has(`${it.id.client}:${it.id.clock}`)
          ) {
            formatsInBytes = false;
          }
        }
        const shortfalls: Record<string, number> = {};
        const recovered: Record<string, number> = {};
        for (const variant of variants) {
          const view = attributes(loaded[variant]);
          const onPlain = new Set<string>();
          const rest = new Set<string>();
          for (const id of view.keys()) {
            (plainView.has(id) ? onPlain : rest).add(id);
          }
          const st = stats[variant];
          const third = thirdValues(view, views, onPlain);
          st.thirdOnPlain += third;
          st.thirdOnPlainFormatsInBytes += formatsInBytes ? third : 0;
          st.thirdOnRest += thirdValues(view, views, rest);
          let shortfall = 0;
          for (const id of encoding.keys()) {
            shortfall += view.has(id) ? 0 : 1;
          }
          st.shortfall += shortfall;
          st.recovered += rest.size;
          shortfalls[variant] = shortfall;
          recovered[variant] = rest.size;
        }
        // Never less text than a plain load.
        expect(shortfalls.repair).toBeLessThanOrEqual(shortfalls.plain);
        // The guarantee, against the plain load (P) and the maximal repair
        // (V): (a) every character P shows, the load shows; (b) every
        // character it shows, P or V shows; (c) each with P's attributes or
        // V's; (d) each map entry's value (absent included) P's or V's.
        {
          const shown = attributes(loaded.repair);
          const v = attributes(loaded.unruled);
          const fail = (what: string) => {
            throw new Error(`seed ${seed}: ${what}`);
          };
          const same = (a?: Map<string, unknown>, b?: Map<string, unknown>) =>
            a !== undefined &&
            b !== undefined &&
            JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
          for (const id of plainView.keys()) {
            if (!shown.has(id)) {
              fail(`${id}, which the plain load shows, is not shown`);
            }
          }
          for (const [id, attrs] of shown) {
            if (!plainView.has(id) && !v.has(id)) {
              fail(
                `${id} is shown by neither the plain load nor the maximal repair`,
              );
            }
            if (!same(attrs, v.get(id)) && !same(attrs, plainView.get(id))) {
              fail(
                `${id} shows ${JSON.stringify([...attrs])}, neither the plain load's nor the maximal repair's`,
              );
            }
          }
          const re = entriesOf(loaded.repair);
          const pe = entriesOf(loaded.plain);
          const ve = entriesOf(loaded.unruled);
          for (const key of new Set([
            ...re.keys(),
            ...pe.keys(),
            ...ve.keys(),
          ])) {
            const value = re.get(key);
            if (value !== pe.get(key) && value !== ve.get(key)) {
              fail(
                `entry ${key} is ${value}, neither the plain load's nor the maximal repair's`,
              );
            }
          }
        }
        // A format-only run that integrates while a format item of its key
        // stays pending does so only because content needs it: held back,
        // the plan would integrate less content.
        const planned = planGapRepairForTests(plain);
        if (planned !== null) {
          for (const cut of planned.cuts) {
            if (
              !cut.content &&
              cut.keys.some(k => planned.pendingKeys.includes(k))
            ) {
              expect(
                planGapRepairForTests(plain, [cut.from])!.content,
              ).toBeLessThan(planned.content);
            }
          }
        }
        totals.loads++;
        totals.formatLoads += Y.decodeUpdate(state).structs.some(
          s => (s as {content?: unknown}).content instanceof Y.ContentFormat,
        )
          ? 1
          : 0;
        const repaired = loaded.repair;
        // Converged once healed, byte for byte, with a plain load.
        for (const u of ups) {
          Y.applyUpdate(repaired, u);
        }
        expect(Buffer.from(Y.encodeStateAsUpdate(repaired))).toEqual(
          Buffer.from(Y.encodeStateAsUpdate(healed)),
        );
        for (const d of [plain, healed, ...Object.values(loaded)]) {
          d.destroy();
        }
      }
      for (const doc of [z, ...writers.map(w => w.d), ...peers]) {
        doc.destroy();
      }
    }
    const pct = (xs: number[], q: number) =>
      xs.length === 0
        ? 0
        : [...xs].sort((a, b) => a - b)[
            Math.min(xs.length - 1, Math.floor(q * xs.length))
          ];
    const times = (xs: number[]) => ({
      max: +pct(xs, 1).toFixed(2),
      p50: +pct(xs, 0.5).toFixed(2),
      p95: +pct(xs, 0.95).toFixed(2),
    });
    if (process.env.LEXICAL_Y_LOAD_STATS) {
      console.warn(
        `check times ${JSON.stringify({checked: times(checkedMs), unruled: times(unruledMs)})}`,
      );
    }
    // Every plan held, every copy was exact, and the scenarios reach the
    // rule.
    expect(LOAD_PLAN_COUNTERS.mispredicted).toBe(startPlan.mispredicted);
    expect(LOAD_PLAN_COUNTERS.copyInexact).toBe(startPlan.copyInexact);
    expect(totals.heldBackCuts).toBeGreaterThan(0);
    // No more third values than the maximal repair shows.
    expect(stats.repair.thirdOnPlain).toBeLessThanOrEqual(
      stats.unruled.thirdOnPlain,
    );
    expect(stats.repair.thirdOnRest).toBeLessThanOrEqual(
      stats.unruled.thirdOnRest,
    );
    LOAD_TEST_HOOKS.direct = null;
    LOAD_TEST_HOOKS.verifyV = false;
    expect(direct).toBeGreaterThan(0);
    expect(LOAD_PLAN_COUNTERS.vMismatch).toBe(startPlan.vMismatch);
    if (process.env.LEXICAL_Y_LOAD_STATS) {
      console.warn(
        `format stats ${JSON.stringify({...totals, direct, ...stats})}`,
      );
    }
  }, 240000);

  test('applyStoredState joins an enclosing transaction under its origin', () => {
    const t = gapScenario(false);
    const doc = plainDoc(false);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin));
    const origin = {};
    doc.transact(() => applyStoredState(doc, t.state, origin), origin);
    expect(origins).toEqual([origin]);
    expect(textOf(doc.get('lexical-y'))).toBe(t.shown);
    doc.destroy();
    t.dispose();
  });
});
