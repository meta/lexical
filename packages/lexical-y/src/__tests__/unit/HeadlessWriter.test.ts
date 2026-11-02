/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $isElementNode,
  $isTextNode,
  $setState,
  COLLABORATION_TAG,
  createState,
  defineExtension,
  type LexicalWarning,
} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

import {DEFAULT_ROOT_NAME} from '../..';
import {
  createYWriter,
  editYState,
  readYState,
  seedYState,
  WRITER_NEW_CLIENT_ID_WARNING,
  type YWriter,
} from '../../headless';
import {createHeadlessYEditor} from '../../internal/HeadlessEditor';
import {createWriter} from '../../internal/Writer';
import {$p, NODES} from '../utils/harness';

// The tests turn the binding's self-check on (it is off by default); the
// scale test measures without it, as a server runs. Warnings are checked in
// the results.
const config = {
  nodes: NODES,
  onWarn: () => {},
  schemaVersion: 1,
  selfCheck: true,
};
const serverConfig = {nodes: NODES, onWarn: () => {}, schemaVersion: 1};

function seed(...lines: string[]): Uint8Array {
  return seedYState(config, () => {
    for (const line of lines) {
      $getRoot().append($p(line));
    }
  });
}

/** An edit that types `text` at the end of the last line. */
const $typeAtEnd = (text: string) => () => {
  const last = $getRoot().getLastChild();
  const node = $isElementNode(last) ? last.getLastChild() : null;
  if (!$isTextNode(node)) {
    throw new Error('the last line ends without text');
  }
  node.spliceText(node.getTextContentSize(), 0, text);
};

const $append = (text: string) => () => {
  $getRoot().append($createParagraphNode().append($createTextNode(text)));
};

const $text = () => $getRoot().getTextContent();

/** The client ids a state holds. */
function clientsOf(state: Uint8Array): number[] {
  return [
    ...Y.decodeStateVector(Y.encodeStateVectorFromUpdate(state)).keys(),
  ].sort((x, y) => x - y);
}

function stateVectorBytes(state: Uint8Array): number {
  return Y.encodeStateVectorFromUpdate(state).length;
}

/** The client ids an update inserts under. */
function insertedBy(update: Uint8Array | null): number[] {
  if (update === null) {
    return [];
  }
  return [...Y.createContentIdsFromUpdate(update).inserts.clients.keys()];
}

/** `updates` applied in turn to `state`, read as text. */
function merged(state: Uint8Array, ...updates: Uint8Array[]): string {
  const doc = new Y.Doc();
  doc.cleanupFormatting = false;
  Y.applyUpdate(doc, state);
  for (const update of updates) {
    Y.applyUpdate(doc, update);
  }
  const out = readYState(Y.encodeStateAsUpdate(doc), config, $text);
  doc.destroy();
  return out;
}

function writerWarnings(warnings: readonly LexicalWarning[]) {
  return warnings
    .filter(warning => warning.code === WRITER_NEW_CLIENT_ID_WARNING)
    .map(warning => warning.data as {reason: string; clientID: number});
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[sorted.length >> 1];
}

describe('editYState writers', () => {
  test('every call decides who it writes as', () => {
    const state = seed('one');
    const $edit = $typeAtEnd('!');
    const writer = createYWriter('agent');
    // Refused by the type...
    expect(() =>
      // @ts-expect-error - options, with a writer, are required
      editYState(state, config, $edit),
    ).toThrow(TypeError);
    expect(() =>
      // @ts-expect-error - writer is required: a writer, or null
      editYState(state, config, $edit, {}),
    ).toThrow(/needs options\.writer \(got none\)/);
    expect(() =>
      // @ts-expect-error - undefined is not a decision
      editYState(state, config, $edit, {writer: undefined}),
    ).toThrow(/needs options\.writer \(got none\)/);
    expect(() =>
      // @ts-expect-error - a writer comes from createYWriter
      editYState(state, config, $edit, {writer: {author: 'agent'}}),
    ).toThrow(/needs options\.writer \(got object\)/);
    expect(() =>
      // @ts-expect-error - a client id is not a writer
      editYState(state, config, $edit, {writer: 123}),
    ).toThrow(/needs options\.writer \(got number\)/);
    // ...and at run time for callers the type does not reach, with the fix.
    expect(() => editYState(state, config, $edit, undefined as never)).toThrow(
      '@lexical/y: editYState needs options.writer (got none): a writer from createYWriter(author), created once per process and passed to every edit it makes, or null to write this edit under a new anonymous client id.',
    );
    // A writer is only made by createYWriter, also as a type.
    // @ts-expect-error - a writer written by hand lacks the brand
    const forged: YWriter = {author: 'agent'};
    expect(() => editYState(state, config, $edit, {writer: forged})).toThrow(
      /needs options\.writer \(got object\)/,
    );
    // Both decisions compile and write.
    expect(
      editYState(state, config, $edit, {writer: null}).update,
    ).not.toBeNull();
    expect(editYState(state, config, $edit, {writer}).update).not.toBeNull();
    expect(writer.author).toBe('agent');
  });

  test('3,000 edits with a writer keep one client id: the state stays small and each call costs the same', () => {
    const N = 3000;
    const lines = Array.from({length: 20}, (_, i) => `line ${i} `);
    const seeded = seedYState(serverConfig, () => {
      for (const line of lines) {
        $getRoot().append($p(line));
      }
    });
    const writer = createYWriter('agent');
    let state = seeded;
    const ms: number[] = [];
    const ids = new Set<number>();
    let warned = 0;
    for (let i = 0; i < N; i++) {
      const start = performance.now();
      const result = editYState(state, serverConfig, $typeAtEnd('a'), {
        writer,
      });
      ms.push(performance.now() - start);
      ids.add(result.clientID);
      warned += result.warnings.length;
      state = result.state;
    }
    // One client making the same edits, as a browser tab would.
    const tab = createHeadlessYEditor({...serverConfig, state: seeded});
    for (let i = 0; i < N; i++) {
      tab.editor.update($typeAtEnd('a'), {discrete: true});
    }
    const compacted = new Y.Doc();
    Y.applyUpdate(compacted, Y.encodeStateAsUpdate(tab.doc));
    const oneClient = Y.encodeStateAsUpdate(compacted);
    compacted.destroy();
    tab.dispose();

    expect(warned).toBe(0);
    expect(ids.size).toBe(1);
    expect(clientsOf(state)).toEqual(
      [...clientsOf(seeded), ...ids].sort((x, y) => x - y),
    );
    expect(readYState(state, serverConfig, $text)).toBe(
      readYState(oneClient, serverConfig, $text),
    );
    const sizes = {
      oneClient: oneClient.length,
      oneClientVector: stateVectorBytes(oneClient),
      writer: state.length,
      writerVector: stateVectorBytes(state),
    };
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ...sizes,
        firstMs: median(ms.slice(100, 400)),
        lastMs: median(ms.slice(-300)),
      }),
    );
    expect(sizes.writerVector).toBeLessThanOrEqual(sizes.oneClientVector + 2);
    expect(sizes.writer).toBeLessThan(sizes.oneClient * 1.25);
    // Flat: the last calls cost about what the first ones did (with a new
    // client id per call, the 3,000th costs tens of times the first).
    expect(median(ms.slice(-300))).toBeLessThan(
      2 * median(ms.slice(100, 400)) + 1,
    );
  }, 120000);

  test('writer: null keeps a new anonymous client id per edit', () => {
    const seeded = seed('one');
    let state = seeded;
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) {
      const result = editYState(state, config, $typeAtEnd('a'), {
        writer: null,
      });
      expect(result.warnings).toEqual([]);
      expect(insertedBy(result.update)).toEqual([result.clientID]);
      ids.push(result.clientID);
      state = result.state;
    }
    expect(new Set(ids).size).toBe(20);
    expect(clientsOf(state)).toEqual(
      [...clientsOf(seeded), ...ids].sort((x, y) => x - y),
    );
    // The same edits through a writer: one client id, and a smaller state.
    const writer = createYWriter('agent');
    let written = seeded;
    for (let i = 0; i < 20; i++) {
      written = editYState(written, config, $typeAtEnd('a'), {writer}).state;
    }
    expect(clientsOf(written)).toHaveLength(clientsOf(seeded).length + 1);
    expect(written.length).toBeLessThan(state.length);
    expect(readYState(written, config, $text)).toBe(
      readYState(state, config, $text),
    );
    // An edit that writes nothing reports the id it would have written under.
    const none = editYState(state, config, () => {}, {writer: null});
    expect(none.update).toBeNull();
    expect(typeof none.clientID).toBe('number');
  });

  test('a writer continues its client id only on a state that holds its last update', () => {
    const base = seed('one');
    const writer = createYWriter('agent');
    const first = editYState(base, config, $typeAtEnd(' a'), {writer});
    const next = editYState(first.state, config, $typeAtEnd(' b'), {writer});
    expect(next.clientID).toBe(first.clientID);
    expect(next.warnings).toEqual([]);
    // The merged update (not the returned state) is what a server stores
    // when it edits an older read: the writer continues on it too.
    const latest = merged(base, first.update!, next.update!);
    expect(latest).toBe('one a b');

    // An edit planned from a state read before the writer's last update
    // there (two agent runs overlapping, one writer): continuing the client
    // id would give two different items one id. A new one is used, with a
    // warning that says why and how to keep one.
    const stale = editYState(first.state, config, $typeAtEnd(' c'), {writer});
    expect(stale.clientID).not.toBe(first.clientID);
    expect(writerWarnings(stale.warnings)).toEqual([
      expect.objectContaining({
        clientID: stale.clientID,
        reason: 'stale-state',
      }),
    ]);
    expect(stale.warnings[0].message).toBe(
      `@lexical/y: writer "agent" wrote this edit under a new client id, ${stale.clientID}: the state holds its client id ${first.clientID} up to clock ${Y.decodeStateVector(Y.encodeStateVectorFromUpdate(first.state)).get(first.clientID)}, but its last update under that id reached clock ${Y.decodeStateVector(Y.encodeStateVectorFromUpdate(next.state)).get(first.clientID)} (the state was read before that update, or the update was never stored). To keep one client id per document, run this writer's edits one after another, each on a state that holds its last update, and store every update it returns.`,
    );
    // Every order of delivery gives the same document, with every edit.
    const orders = [
      merged(base, first.update!, next.update!, stale.update!),
      merged(base, stale.update!, first.update!, next.update!),
      merged(base, first.update!, stale.update!, next.update!),
    ];
    expect(new Set(orders).size).toBe(1);
    expect(orders[0]).toMatch(/^one a( b c| c b)$/);

    // What the guard prevents: the same edits under one client id from the
    // same state diverge, silently, depending on what a peer receives first.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, first.state);
    const forced = (text: string) => {
      const copy = new Y.Doc();
      Y.applyUpdate(copy, first.state);
      copy.clientID = first.clientID;
      const out: Uint8Array[] = [];
      copy.on('update', (update: Uint8Array) => out.push(update));
      copy.get('scratch').insert(0, text);
      copy.destroy();
      return out[0];
    };
    const x = forced('x');
    const y = forced('y');
    const text = (...updates: Uint8Array[]) => {
      const peer = new Y.Doc();
      Y.applyUpdate(peer, first.state);
      for (const update of updates) {
        Y.applyUpdate(peer, update);
      }
      const out = peer.get('scratch').toString();
      peer.destroy();
      return out;
    };
    expect(text(x, y)).not.toBe(text(y, x));
    doc.destroy();
  });

  test('a call made inside another call with the same writer gets its own client id', () => {
    const base = seed('one');
    const writer = createYWriter('agent');
    let inner: ReturnType<typeof editYState> | null = null;
    const outer = editYState(base, config, $typeAtEnd(' outer'), {
      transact: () => {
        inner = editYState(base, config, $typeAtEnd(' inner'), {writer});
      },
      writer,
    });
    // A new writer's first edit of a document: nothing to continue yet.
    expect(outer.warnings).toEqual([]);
    expect(inner).not.toBeNull();
    const nested = inner!;
    expect(nested.clientID).not.toBe(outer.clientID);
    expect(writerWarnings(nested.warnings)).toEqual([]);
    // Once the writer has written the document, a nested call on a state
    // holding that write would continue the id the outer call is writing
    // under: it is busy.
    let busy: ReturnType<typeof editYState> | null = null;
    const again = editYState(outer.state, config, $typeAtEnd(' again'), {
      transact: () => {
        busy = editYState(outer.state, config, $typeAtEnd(' busy'), {writer});
      },
      writer,
    });
    expect(again.clientID).toBe(outer.clientID);
    const blocked = busy!;
    expect(blocked.clientID).not.toBe(outer.clientID);
    expect(writerWarnings(blocked.warnings)).toEqual([
      expect.objectContaining({reason: 'busy'}),
    ]);
    expect(blocked.warnings[0].message).toMatch(
      /in use by another call with this writer .*Run a writer's edits one after another, never from inside another edit\.$/,
    );
    const orders = [
      merged(outer.state, again.update!, blocked.update!),
      merged(outer.state, blocked.update!, again.update!),
    ];
    expect(orders[0]).toBe(orders[1]);
    expect(orders[0]).toMatch(/again/);
    expect(orders[0]).toMatch(/busy/);
  });

  test('a call made inside another call never draws the client id the outer call is writing under', () => {
    // The writer's draws, forced: the outer call draws X; the inner call
    // draws X again (it is in no state and not yet in the writer's memory,
    // as the outer call has not returned), then Y. Other random values stay
    // real.
    const X = 0x2468ace;
    const Y_ = 0x1357bdf;
    const draws = [
      [0, X],
      [0, X],
      [0, Y_],
    ];
    let drawn = 0;
    const crypto = globalThis.crypto;
    const real = crypto.getRandomValues.bind(crypto);
    const spy = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        if (
          array instanceof Uint32Array &&
          array.length === 2 &&
          drawn < draws.length
        ) {
          array.set(draws[drawn++]);
          return array;
        }
        return real(array as never) as T;
      });
    try {
      const base = seed('one');
      const writer = createYWriter('agent');
      let inner: ReturnType<typeof editYState> | null = null;
      const outer = editYState(base, config, $typeAtEnd(' outer'), {
        transact: () => {
          inner = editYState(base, config, $typeAtEnd(' inner'), {writer});
        },
        writer,
      });
      expect(drawn).toBe(3);
      expect(outer.clientID).toBe(X);
      expect(inner!.clientID).toBe(Y_);
      // Two ids: the two updates merge in either order.
      const orders = [
        merged(base, outer.update!, inner!.update!),
        merged(base, inner!.update!, outer.update!),
      ];
      expect(orders[0]).toBe(orders[1]);
      expect(orders[0]).toMatch(/outer/);
      expect(orders[0]).toMatch(/inner/);
    } finally {
      spy.mockRestore();
    }
  });

  test('an update applied inside transact refuses the edit: its items would be credited to the writer', () => {
    const base = seed('one');
    const peer = editYState(base, config, $typeAtEnd(' peer'), {
      writer: createYWriter('peer'),
    });
    const writer = createYWriter('agent');
    let thrown: unknown = null;
    try {
      editYState(base, config, $typeAtEnd(' agent'), {
        allowedRoots: [DEFAULT_ROOT_NAME, 'people'],
        transact: doc => {
          doc.get('people').setAttr(String(doc.clientID), writer.author);
          Y.applyUpdate(doc, peer.update!);
        },
        writer,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({code: 'imported-items'});
    expect((thrown as Error).message).toBe(
      `@lexical/y: the update holds items written under other client ids (${peer.clientID}): options.transact applied another update to the edit's document, so they would be returned as this edit's and credited to its writer. Apply other updates to your own copy of the document; use transact only to write.`,
    );
    // Nothing left the refused call: the writer's next edit is its first
    // in this document's history.
    const next = editYState(base, config, $typeAtEnd(' agent'), {writer});
    expect(next.warnings).toEqual([]);
    expect(insertedBy(next.update)).toEqual([next.clientID]);
  });

  test('a writer that continues its client id writes new segment keys: adjacent token nodes stay apart', () => {
    const writer = createYWriter('agent');
    const $token = (text: string) => () => {
      const line = $getRoot().getFirstChild();
      if (!$isElementNode(line)) {
        throw new Error('no line');
      }
      line.append($createTextNode(text).setMode('token'));
    };
    const first = editYState(seed('x'), config, $token('@a'), {writer});
    const second = editYState(first.state, config, $token('@b'), {writer});
    expect(second.clientID).toBe(first.clientID);
    expect(
      readYState(second.state, config, () => {
        const line = $getRoot().getFirstChild();
        return $isElementNode(line)
          ? line
              .getChildren()
              .map(
                node =>
                  `${node.getTextContent()}:${
                    $isTextNode(node) ? node.getMode() : ''
                  }`,
              )
          : [];
      }),
    ).toEqual(['x:normal', '@a:token', '@b:token']);
  });

  test('one writer keeps one client id per document', () => {
    const writer = createYWriter('agent');
    let a = seed('a');
    let b = seed('b');
    const seen = new Map<string, Set<number>>([
      ['a', new Set()],
      ['b', new Set()],
    ]);
    for (let i = 0; i < 10; i++) {
      const ra = editYState(a, config, $typeAtEnd('1'), {writer});
      const rb = editYState(b, config, $typeAtEnd('2'), {writer});
      expect([...ra.warnings, ...rb.warnings]).toEqual([]);
      seen.get('a')!.add(ra.clientID);
      seen.get('b')!.add(rb.clientID);
      a = ra.state;
      b = rb.state;
    }
    expect(seen.get('a')!.size).toBe(1);
    expect(seen.get('b')!.size).toBe(1);
    expect([...seen.get('a')!][0]).not.toBe([...seen.get('b')!][0]);
    expect(clientsOf(a)).toHaveLength(2);
    expect(clientsOf(b)).toHaveLength(2);
    // Two documents seeded from the same template, edited the same way,
    // still get different client ids: one document's state can never pass
    // for the other's.
    const t1 = editYState(seed('t'), config, $typeAtEnd('!'), {writer});
    const t2 = editYState(seed('t'), config, $typeAtEnd('!'), {writer});
    expect(t1.clientID).not.toBe(t2.clientID);
    expect(t2.warnings).toEqual([]);
  });

  test('an edit that throws, or is refused, does not move the writer on', () => {
    const base = seed('one');
    const writer = createYWriter('agent');
    const first = editYState(base, config, $typeAtEnd(' a'), {writer});
    expect(() =>
      editYState(
        first.state,
        config,
        () => {
          $typeAtEnd(' lost')();
          throw new Error('the edit failed');
        },
        {writer},
      ),
    ).toThrow('the edit failed');
    expect(() =>
      editYState(first.state, config, $typeAtEnd(' refused'), {
        transact: doc => doc.get('elsewhere').insert(0, 'x'),
        writer,
      }),
    ).toThrow(/writes outside the allowed roots/);
    // Refused before or while opening: an empty state, a newer layout.
    expect(() =>
      editYState(new Uint8Array([0, 0]), config, $typeAtEnd('!'), {writer}),
    ).toThrow(/seed the document first/);
    const newer = new Y.Doc();
    Y.applyUpdate(newer, first.state);
    newer.get(DEFAULT_ROOT_NAME).setAttr('lexical-y:99', true);
    expect(() =>
      editYState(Y.encodeStateAsUpdate(newer), config, $typeAtEnd('!'), {
        writer,
      }),
    ).toThrow(/read only/);
    newer.destroy();
    const next = editYState(first.state, config, $typeAtEnd(' b'), {writer});
    expect(next.clientID).toBe(first.clientID);
    expect(next.warnings).toEqual([]);
    expect(readYState(next.state, config, $text)).toBe('one a b');
  });

  test('a client id the writer drew and wrote nothing under is used for the next document', () => {
    const writer = createYWriter('agent');
    const none = editYState(seed('a'), config, () => {}, {writer});
    expect(none.update).toBeNull();
    const next = editYState(seed('b'), config, $typeAtEnd('!'), {writer});
    expect(next.clientID).toBe(none.clientID);
  });

  test('a writer used with clientIDRange uint32 writes under 32-bit client ids', () => {
    const base = seedYState({...config, clientIDRange: 'uint32'}, () => {
      $getRoot().append($p('one'));
    });
    const writer = createYWriter('agent');
    const wide = editYState(base, config, $typeAtEnd(' a'), {writer});
    const narrow = editYState(
      wide.state,
      {...config, clientIDRange: 'uint32'},
      $typeAtEnd(' b'),
      {writer},
    );
    expect(narrow.clientID).toBeLessThanOrEqual(0xffffffff);
    expect(insertedBy(narrow.update)).toEqual([narrow.clientID]);
    if (wide.clientID > 0xffffffff) {
      expect(writerWarnings(narrow.warnings)).toEqual([
        expect.objectContaining({reason: 'range'}),
      ]);
    }
    const again = editYState(
      narrow.state,
      {...config, clientIDRange: 'uint32'},
      $typeAtEnd(' c'),
      {writer},
    );
    expect(again.clientID).toBe(narrow.clientID);
    expect(again.warnings).toEqual([]);
  });

  test('writes under a writer client id that the writer did not make stop it using that id', () => {
    const base = seed('one');
    const writer = createYWriter('agent');
    const first = editYState(base, config, $typeAtEnd(' a'), {writer});
    // An app that assigns the writer's client id to a document of its own
    // (do not), and writes there.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, first.state);
    peer.clientID = first.clientID;
    peer.get('scratch').insert(0, 'x');
    const mixed = Y.encodeStateAsUpdate(peer);
    peer.destroy();
    const next = editYState(mixed, config, $typeAtEnd(' b'), {writer});
    expect(next.clientID).not.toBe(first.clientID);
    expect(writerWarnings(next.warnings)).toEqual([
      expect.objectContaining({reason: 'foreign-writes'}),
    ]);
    expect(next.warnings[0].message).toMatch(
      /Never assign a writer's client id \(result\.clientID\) to a Y\.Doc\.$/,
    );
    // It never comes back to that id, even on a state that holds it at the
    // writer's tip.
    const later = editYState(first.state, config, $typeAtEnd(' c'), {writer});
    expect(later.clientID).not.toBe(first.clientID);
  });

  test('a writer remembers a bounded number of client ids', () => {
    const writer = createWriter('agent', 2);
    const docs = ['a', 'b', 'c'].map(line => {
      const result = editYState(seed(line), config, $typeAtEnd('!'), {
        writer,
      });
      return result;
    });
    // 'a' was forgotten: its next edit gets a new client id, silently (the
    // writer no longer knows the id is its own).
    const a = editYState(docs[0].state, config, $typeAtEnd('?'), {writer});
    expect(a.clientID).not.toBe(docs[0].clientID);
    expect(a.warnings).toEqual([]);
    const c = editYState(docs[2].state, config, $typeAtEnd('?'), {writer});
    expect(c.clientID).toBe(docs[2].clientID);
  });

  test('attribution: the update is the writer client id alone, and Yjs attributions credit its author', () => {
    const writer = createYWriter('jot AI');
    // A person types in a seeded note (a browser tab, one client id).
    const tab = createHeadlessYEditor({...config, state: seed('Notes')});
    tab.editor.update($typeAtEnd(' by Ana'), {discrete: true});
    const person = tab.doc.clientID;
    const typed = Y.encodeStateAsUpdate(tab.doc);
    tab.dispose();
    let registered: number | null = null;
    const result = editYState(typed, config, $append('Summary by AI'), {
      allowedRoots: [DEFAULT_ROOT_NAME, 'people'],
      // A registry of client ids, as Jot's blame keeps (a root of its own),
      // written in the same update.
      transact: doc => {
        registered = doc.clientID;
        doc.get('people').setAttr(String(doc.clientID), writer.author);
      },
      writer,
    });
    expect(registered).toBe(result.clientID);
    expect(insertedBy(result.update)).toEqual([result.clientID]);

    // Blame from the registry: each registered client's inserts are
    // attributed to its person, and the root rendered with them.
    const doc = new Y.Doc();
    doc.cleanupFormatting = false;
    Y.applyUpdate(doc, result.state);
    const registry = new Map<number, string>([[person, 'Ana']]);
    for (const [key, value] of doc.get('people').attrEntries() as Iterable<
      [string, unknown]
    >) {
      registry.set(Number(key), String(value));
    }
    const byPerson = new Map<string, Y.IdSet>();
    Y.createInsertSetFromStructStore(doc.store, true).forEach(
      (range, client) => {
        const name = registry.get(client);
        if (name !== undefined) {
          const set = byPerson.get(name) || Y.createIdSet();
          set.add(client, range.clock, range.len);
          byPerson.set(name, set);
        }
      },
    );
    const contentMap = Y.createContentMap(
      Y.mergeIdMaps(
        [...byPerson].map(([name, set]) =>
          Y.createIdMapFromIdSet(set, [
            Y.createContentAttribute('insert', name),
          ]),
        ),
      ),
      Y.createIdMap(),
    );
    const blame = attributedText(doc, contentMap);
    expect(blame).toContainEqual({by: ['jot AI'], text: 'Summary by AI'});
    expect(blame).toContainEqual({by: ['Ana'], text: ' by Ana'});

    // Or from the update alone, without a registry: Yjs 14 attributes the
    // ids it inserts and deletes.
    const fromUpdate = Y.createContentMapFromContentIds(
      Y.createContentIdsFromUpdate(result.update!),
      [Y.createContentAttribute('insert', writer.author)],
      [Y.createContentAttribute('delete', writer.author)],
    );
    const fromUpdateBlame = attributedText(doc, fromUpdate);
    expect(fromUpdateBlame).toContainEqual({
      by: ['jot AI'],
      text: 'Summary by AI',
    });
    expect(fromUpdateBlame.filter(run => run.text.includes('Ana'))).toEqual([
      {by: null, text: expect.stringContaining('Ana')},
    ]);
    doc.destroy();
  });

  test('a seed is credited by the client ids in its state vector: one, unless a listener writes once the content is read', () => {
    const seeded = seed('one', 'two');
    expect(clientsOf(seeded)).toHaveLength(1);
    // Its id is derived from the content: the same content, the same id.
    expect(clientsOf(seed('one', 'two'))).toEqual(clientsOf(seeded));
    // A listener that sets a value once the binding has read the content
    // writes under the temporary document's own client id.
    const opened = createState('opened', {
      parse: v => (typeof v === 'number' ? v : 0),
    });
    const OnOpen = defineExtension({
      name: 'test-on-open',
      nodes: NODES,
      register: editor =>
        editor.registerUpdateListener(({tags}) => {
          if (tags.has(COLLABORATION_TAG)) {
            editor.update(() => {
              const first = $getRoot().getFirstChild();
              if (first !== null && $getState(first, opened) === 0) {
                $setState(first, opened, 1);
              }
            });
          }
        }),
    });
    const withListener = seedYState({...config, extensions: [OnOpen]}, () => {
      $getRoot().append($p('one'));
    });
    expect(clientsOf(withListener)).toHaveLength(2);
    expect(
      readYState(withListener, config, () => {
        const first = $getRoot().getFirstChild();
        return first === null ? null : $getState(first, opened);
      }),
    ).toBe(1);
  });
});

/** The text runs of the layout root with who inserted them (null: no one). */
function attributedText(
  doc: Y.Doc,
  contentMap: ReturnType<typeof Y.createContentMap>,
): {by: string[] | null; text: string}[] {
  const renderer = Y.createAttributionsRenderer(contentMap);
  const delta = doc
    .get(DEFAULT_ROOT_NAME)
    .toDelta({deep: true, renderer}) as unknown as {toJSON(): unknown};
  const runs: {by: string[] | null; text: string}[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === 'object' && value !== null) {
      const op = value as Record<string, unknown>;
      if (typeof op.insert === 'string') {
        const attribution = op.attribution as {insert?: string[]} | undefined;
        runs.push({by: attribution?.insert ?? null, text: op.insert});
      }
      for (const key of Object.keys(op)) {
        if (key !== 'insert' || typeof op.insert !== 'string') {
          visit(op[key]);
        }
      }
    }
  };
  visit(delta.toJSON());
  return runs;
}
