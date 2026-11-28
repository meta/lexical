/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A live room migrated in place by one of its own editor tabs (migrateYDoc
// on the bound document, its update synced to every peer as an ordinary Yjs
// update), with peers connected:
// - another tab of this build, bound while the room was below the floor
//   (read only, 'older'), becomes editable live when the update arrives,
//   with no rebind, and writes;
// - a tab of an older build (simulated: a binding of this build that meets a
//   layout newer than its own, the same code path) turns read only live;
// - text an older build's tab typed while offline, before it saw the
//   migration, survives when it merges after it, with the value it was
//   typed in. A NodeState change that tab made in that window is not always
//   kept: the migration restated the old value as a paired run, and the
//   tab's plain items meet it as a concurrent write (a documented limit,
//   pinned here; see y.md "Migrating a live room in place");
// - a layout 1 room migrates to the floor in place the same way (1to2, 2to3,
//   3to4 in one call).
// Gc off and on, both client orders.

import {buildEditorFromExtensions} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import {
  createYDoc,
  LAYOUT_VERSION,
  onYMigrationEpoch,
  UNSUPPORTED_LAYOUT_WARNING,
  YBinding,
  type YDoc,
} from '../../..';
import {readYState} from '../../../headless';
import {migrateYDoc, recordedLayout} from '../../../internal/Runner';
import {migrateYState} from '../../../migrate';
import step1to2 from '../../../migrate/1to2';
import step2to3 from '../../../migrate/2to3';
import step3to4 from '../../../migrate/3to4';
import {
  $snapshot,
  catalogAppExtension,
  catalogHeadlessConfig,
} from '../../catalog/bind';
import {rawDoc, stamp} from '../../utils/migrateSteps';

type Golden = {name: string; input: string};
const FIXTURE = (
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', 'golden', 'migrate-3to4-r1.json'),
      'utf8',
    ),
  ) as Golden[]
).find(f => f.name === 'flat/overwrite-inside')!;
// "ab", then "cd" red, "ef" blue, "gh" red (flat NodeState `s:color`, as
// the layout 3 release stored it: plain values), then "ij".
const INPUT = new Uint8Array(Buffer.from(FIXTURE.input, 'base64'));
// (Its block ids are left out: the fixture's own configuration installs
// BlockIdExtension with repairTransforms, which a binding refuses.)
const CFG = {blockIds: 'absent'} as const;

type Warning = {code: string; data: Record<string, unknown>};

/** A tab: an editor bound to its own document. */
function tab(state: Uint8Array, gc: boolean, clientID: number) {
  const doc = createYDoc(state, {gc});
  doc.clientID = clientID;
  const warnings: Warning[] = [];
  const errors: Error[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(CFG)],
      name: 'migrate-in-place-tab',
      onError: (e: Error) => {
        errors.push(e);
      },
      onWarn: (w: Error) => {
        const {code, data} = w as unknown as Warning;
        warnings.push({code, data});
      },
    }),
  );
  const binding = new YBinding(editor, doc, {
    layoutUpgrade: null,
    schemaVersion: 1,
  });
  const stop = binding.start();
  binding.initialize();
  return {
    binding,
    dispose: () => {
      stop();
      editor.dispose();
    },
    doc,
    editor,
    errors,
    warnings,
  };
}

/** Peers that forward every local update to each other while connected. */
function connect(docs: YDoc[] | Y.Doc[]): () => void {
  const off: (() => void)[] = [];
  for (const from of docs as Y.Doc[]) {
    const listener = (update: Uint8Array, origin: unknown) => {
      if (origin === 'net') {
        return;
      }
      for (const to of docs as Y.Doc[]) {
        if (to !== from) {
          Y.applyUpdate(to, update, 'net');
        }
      }
    };
    from.on('update', listener);
    off.push(() => from.off('update', listener));
  }
  return () => off.forEach(f => f());
}

/** Two documents brought to each other's state. */
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'net');
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'net');
}

/** Wait until `done` holds (a few macrotasks at most). */
async function until(done: () => boolean, rounds = 50): Promise<void> {
  for (let i = 0; i < rounds && !done(); i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** Each text node of the first paragraph as "text:color". */
function runsOf(json: unknown): string[] {
  const root = (json as {root: {children: {children?: unknown[]}[]}}).root;
  return (root.children[0].children ?? []).map(n => {
    const t = n as {text?: string; $?: {color?: unknown}};
    return `${t.text}:${t.$?.color ?? ''}`;
  });
}

/** What a fresh reader of `doc` shows (the first paragraph's runs). */
const read = (doc: Y.Doc) =>
  runsOf(
    (
      readYState(
        Y.encodeStateAsUpdate(doc),
        catalogHeadlessConfig(CFG),
        $snapshot,
      ) as {json: unknown}
    ).json,
  );

const shown = (editor: LexicalEditor) =>
  runsOf(editor.getEditorState().toJSON());

/**
 * What a tab of the layout 3 build writes while offline, as Yjs stores it:
 * typing "XY" between "c" and "d" (it takes the value there: no format
 * item), and setting "gh" blue (plain values, as layout 3 wrote flat
 * NodeState).
 */
function olderTabEdits(doc: Y.Doc): void {
  const root = doc.get('lexical-y');
  // Typing inside a run: the text takes the value there.
  root.insert(3, 'XY', {'s:color': 'red'} as never);
  root.format(8, 2, {'s:color': 'blue'} as never);
}

/** The edits above as an update to INPUT, written by client `clientID`. */
function olderTabUpdate(gc: boolean, clientID: number): Uint8Array {
  const d = new Y.Doc({gc});
  d.cleanupFormatting = false;
  Y.applyUpdate(d, INPUT);
  d.clientID = clientID;
  const sv = Y.encodeStateVector(d);
  olderTabEdits(d);
  return Y.encodeStateAsUpdate(d, sv);
}

/** One migration of INPUT with `extra` merged in first: the reference. */
function oneMigrationOf(gc: boolean, ...extra: Uint8Array[]): string[] {
  const d = createYDoc(INPUT, {gc});
  for (const u of extra) {
    Y.applyUpdate(d, u);
  }
  const out = migrateYState(Y.encodeStateAsUpdate(d), [step3to4], {gc}).state;
  return read(createYDoc(out, {gc}));
}

for (const gc of [false, true]) {
  for (const [first, second] of [
    [11, 22],
    [22, 11],
  ]) {
    describe(`a live room migrated in place by a tab (gc ${gc}, clients ${first},${second})`, () => {
      test('the room before: layout 3, below the floor, shown read only', () => {
        expect(recordedLayout(createYDoc(INPUT))).toBe(3);
        expect(oneMigrationOf(gc)).toEqual([
          'ab:',
          'cd:red',
          'ef:blue',
          'gh:red',
          'ij:',
        ]);
      });

      test("a below-floor tab of this build becomes editable live when another tab's migration arrives, and both write", async () => {
        const a = tab(INPUT, gc, first);
        const b = tab(INPUT, gc, second);
        const disconnect = connect([a.doc, b.doc]);
        // An app's own UndoManager is cleared at the epoch on every tab:
        // the migrating one, and the one the update reaches.
        const epochs: string[] = [];
        const offA = onYMigrationEpoch(a.doc, () => epochs.push('a'));
        const offB = onYMigrationEpoch(b.doc, () => epochs.push('b'));
        for (const t of [a, b]) {
          expect(t.binding.status).toBe('readonly');
          expect(
            t.warnings.some(
              w =>
                w.code === UNSUPPORTED_LAYOUT_WARNING &&
                w.data.reason === 'older',
            ),
          ).toBe(true);
        }
        // A migrates its own document in place; B receives the update.
        const receipt = migrateYDoc(a.doc, [step3to4]);
        expect(receipt.changed).toBe(true);
        await until(
          () => a.binding.status === 'active' && b.binding.status === 'active',
        );
        expect(a.binding.status).toBe('active');
        expect(b.binding.status).toBe('active');
        expect(recordedLayout(b.doc)).toBe(4);
        expect(epochs.sort()).toEqual(['a', 'b']);
        offA();
        offB();
        expect(shown(b.editor)).toEqual(oneMigrationOf(gc));
        // Both type at once.
        for (const [t, word] of [
          [a, 'A'],
          [b, 'B'],
        ] as const) {
          t.editor.update(
            () => {
              const p = $getRoot().getFirstChildOrThrow();
              if ($isElementNode(p)) {
                p.append($createTextNode(word));
              }
            },
            {discrete: true},
          );
        }
        await until(() => shown(a.editor).join() === shown(b.editor).join());
        expect(shown(a.editor)).toEqual(shown(b.editor));
        // Both words, in one plain text node after "ij" (Lexical merges
        // plain text), in client order.
        expect(shown(a.editor).at(-1)).toMatch(/^ij(AB|BA):$/);
        expect(read(a.doc)).toEqual(shown(a.editor));
        expect(a.errors).toEqual([]);
        expect(b.errors).toEqual([]);
        disconnect();
        a.dispose();
        b.dispose();
      });

      test("an older build's tab turns read only live when the newer layout arrives (here: this build meeting layout LAYOUT_VERSION + 1)", async () => {
        const seeded = migrateYState(INPUT, [step3to4], {gc}).state;
        const a = tab(seeded, gc, first);
        const old = tab(seeded, gc, second);
        const disconnect = connect([a.doc, old.doc]);
        expect(old.binding.status).toBe('active');
        // A newer layout recorded by a migration of A's own document.
        migrateYDoc(a.doc, [stamp(LAYOUT_VERSION)], {to: LAYOUT_VERSION + 1});
        await until(() => old.binding.status === 'readonly');
        expect(old.binding.status).toBe('readonly');
        expect(old.editor.isEditable()).toBe(false);
        expect(
          old.warnings.filter(
            w =>
              w.code === UNSUPPORTED_LAYOUT_WARNING &&
              w.data.reason === 'newer',
          ),
        ).toHaveLength(1);
        // Its edits are not written from then on.
        const before = Y.encodeStateVector(old.doc);
        old.editor.update(
          () => {
            const p = $getRoot().getFirstChildOrThrow();
            if ($isElementNode(p)) {
              p.append($createTextNode('late'));
            }
          },
          {discrete: true},
        );
        expect(Y.encodeStateVector(old.doc)).toEqual(before);
        disconnect();
        a.dispose();
        old.dispose();
      });

      test("text an older build's tab typed offline merges after the migration with the value it was typed in; its NodeState change in that window can be lost (documented limit)", async () => {
        const a = tab(INPUT, gc, first);
        const b = tab(INPUT, gc, second);
        const disconnect = connect([a.doc, b.doc]);
        const older = olderTabUpdate(gc, 777);
        migrateYDoc(a.doc, [step3to4]);
        await until(() => b.binding.status === 'active');
        b.editor.update(
          () => {
            const p = $getRoot().getFirstChildOrThrow();
            if ($isElementNode(p)) {
              p.getFirstChildOrThrow().insertBefore($createTextNode('ZZ'));
            }
          },
          {discrete: true},
        );
        // The older tab reconnects.
        Y.applyUpdate(a.doc, older, 'remote');
        await until(() => shown(a.editor).join() === shown(b.editor).join());
        // One migration of everything: "XY" red, "gh" blue.
        expect(oneMigrationOf(gc, older)).toEqual([
          'ab:',
          'cXYd:red',
          'efgh:blue',
          'ij:',
        ]);
        // In place, with the older tab's edits merging after the migration:
        // "XY" typed in the red run is red, and B's "ZZ" is there, but the
        // tab's blue on "gh" meets the migration's red run there and loses.
        for (const t of [a, b]) {
          expect(shown(t.editor)).toEqual([
            'ZZab:',
            'cXYd:red',
            'ef:blue',
            'gh:red',
            'ij:',
          ]);
        }
        expect(read(a.doc)).toEqual(shown(a.editor));
        expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(b.doc));
        expect(a.errors).toEqual([]);
        expect(b.errors).toEqual([]);
        disconnect();
        a.dispose();
        b.dispose();
      });

      test('a layout 1 room migrates to the floor in place (1to2, 2to3, 3to4 in one call) and its peer becomes editable', async () => {
        const one = rawDoc(1, 'hello');
        const a = tab(one, gc, first);
        const b = tab(one, gc, second);
        const disconnect = connect([a.doc, b.doc]);
        expect(b.binding.status).toBe('readonly');
        const receipt = migrateYDoc(a.doc, [step1to2, step2to3, step3to4]);
        expect(receipt.roots[0].steps.map(s => s.id)).toEqual([
          'lexical-y/layout/1to2',
          'lexical-y/layout/2to3',
          'lexical-y/layout/3to4',
        ]);
        await until(() => b.binding.status === 'active');
        expect(b.binding.status).toBe('active');
        expect(recordedLayout(b.doc)).toBe(4);
        expect(
          b.editor.getEditorState().read(() => $getRoot().getTextContent()),
        ).toBe('hello');
        disconnect();
        a.dispose();
        b.dispose();
      });
    });
  }
}

describe('two tabs migrating the same room at once', () => {
  for (const gc of [false, true]) {
    test(`the same input: the same hashed client and the same structs, so the second update is a no-op (gc ${gc})`, () => {
      const a = createYDoc(INPUT, {gc});
      const b = createYDoc(INPUT, {gc});
      const updates: Uint8Array[] = [];
      a.on('update', (u: Uint8Array) => updates.push(u));
      b.on('update', (u: Uint8Array) => updates.push(u));
      const ra = migrateYDoc(a, [step3to4]);
      const rb = migrateYDoc(b, [step3to4]);
      expect(ra.roots[0].steps[0].client).toBe(rb.roots[0].steps[0].client);
      expect(Buffer.from(updates[0])).toEqual(Buffer.from(updates[1]));
      const before = Y.encodeStateAsUpdate(a);
      sync(a, b);
      expect(Buffer.from(Y.encodeStateAsUpdate(a))).toEqual(
        Buffer.from(before),
      );
      expect(read(a)).toEqual(oneMigrationOf(gc));
    });

    test(`divergent inputs (one saw an older tab's typing): the same read as one migration of both, converged (gc ${gc})`, () => {
      const typing = (() => {
        const d = new Y.Doc({gc});
        d.cleanupFormatting = false;
        Y.applyUpdate(d, INPUT);
        d.clientID = 777;
        const sv = Y.encodeStateVector(d);
        d.get('lexical-y').insert(3, 'XY', {'s:color': 'red'} as never);
        return Y.encodeStateAsUpdate(d, sv);
      })();
      const a = createYDoc(INPUT, {gc});
      const b = createYDoc(INPUT, {gc});
      Y.applyUpdate(b, typing);
      migrateYDoc(a, [step3to4]);
      migrateYDoc(b, [step3to4]);
      sync(a, b);
      expect(read(a)).toEqual(read(b));
      expect(read(a)).toEqual(oneMigrationOf(gc, typing));
    });

    test(`divergent inputs where one saw an older tab clear a value on part of a run: converged, but the other migration's restated value wins there (a documented limit) (gc ${gc})`, () => {
      const clear = (() => {
        const d = new Y.Doc({gc});
        d.cleanupFormatting = false;
        Y.applyUpdate(d, INPUT);
        d.clientID = 777;
        const sv = Y.encodeStateVector(d);
        d.get('lexical-y').format(7, 1, {'s:color': null} as never);
        return Y.encodeStateAsUpdate(d, sv);
      })();
      const a = createYDoc(INPUT, {gc});
      const b = createYDoc(INPUT, {gc});
      Y.applyUpdate(b, clear);
      migrateYDoc(a, [step3to4]);
      migrateYDoc(b, [step3to4]);
      sync(a, b);
      expect(read(a)).toEqual(read(b));
      // One migration of both: "h" loses its value.
      expect(oneMigrationOf(gc, clear)).toEqual([
        'ab:',
        'cd:red',
        'ef:blue',
        'g:red',
        'hij:',
      ]);
      // Two divergent migrations: A's run, which never saw the clear,
      // restates "gh" red over it.
      expect(read(a)).toEqual(oneMigrationOf(gc));
      // With one migrator, this clear merging after the migration is kept.
      const c = createYDoc(INPUT, {gc});
      migrateYDoc(c, [step3to4]);
      Y.applyUpdate(c, clear);
      expect(read(c)).toEqual(oneMigrationOf(gc, clear));
    });
  }
});
