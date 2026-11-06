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
import {describe, expect, test, vi} from 'vitest';

import {createYDoc, YBinding} from '../../..';
import {editYState, readYState} from '../../../headless';
import {
  applyStoredState,
  type GapRepairYjs,
  integrateHeldBehindGapsWith,
  LOAD_COUNTERS,
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

// The repair on plain Yjs documents (a root "t"), with the shapes a single
// cut rule misses and a property test over random gap scenarios.

type Shown = Set<string>;

/** Every item a document shows (text, nodes, attributes), by id. */
function shownIds(doc: Y.Doc): Shown {
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
  walk(doc.get('t'));
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
      test(`${name}: no suffix apply, the kept update once, converged once healed`, () => {
        const t = make(gc, count);
        let t0 = performance.now();
        const plain = plainDoc(gc, t.state);
        const plainMs = performance.now() - t0;
        const counts = {applies: 0};
        const doc = plainDoc(gc, t.state);
        t0 = performance.now();
        const result = integrateHeldBehindGapsWith(countingYjs(counts), doc);
        const repairMs = performance.now() - t0;
        // Nothing is integrable: no suffix is applied, only the kept pending
        // update, whole.
        expect(result).toEqual({
          exhausted: false,
          failedCuts: 0,
          suffixApplies: 0,
        });
        expect(counts.applies).toBe(1);
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
    });

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
