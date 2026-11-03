/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// The binding's side of layout migrations (D102): a root below MIN_LAYOUT
// binds read only with the 'older' warning (headless reads and edits
// refuse it), migrateLocally migrates a local-only document with the app's
// loaders and clears only that cause, a migration clears the undo history
// after its capture (the binding's, and an app's through onLayoutEpoch),
// and quiesce() writes what the editor holds and turns read only for good.
// The tests use a floor (FLOOR: MIN_LAYOUT, or 2 raised with the internal
// override where MIN_LAYOUT is 1) and a raw document one layout below it,
// which a synthetic step migrates; the build's constants decide the
// layouts.

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setCompositionKey,
  $setSelection,
  configExtension,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {afterEach, describe, expect, test, vi} from 'vitest';

import {
  createYDoc,
  LAYOUT_VERSION,
  MIN_LAYOUT,
  onLayoutEpoch,
  SEED_LAYOUT,
  UNSUPPORTED_LAYOUT_WARNING,
  UNSUPPORTED_SCHEMA_WARNING,
  YBinding,
  type YBindingOptions,
  YCollabExtension,
  type YDoc,
  type YMigrateLocally,
} from '../..';
import {editYState, readYState, YHeadlessError} from '../../headless';
import {setMinLayoutForTests} from '../../internal/Binding';
import {migrateYDoc, MIGRATION_ORIGIN, recordedLayout} from '../../migrate';
import {
  $snapshot,
  catalogAppExtension,
  catalogHeadlessConfig,
  seedShapes,
} from '../catalog/bind';
import {NODE_SHAPES, shapesWith} from '../catalog/nodes';
import {FLOOR, rawDoc, STAMP, stamp} from '../utils/migrateSteps';

const CFG = {blockIds: 'absent'} as const;
const BELOW = FLOOR - 1;
const LOADERS: YMigrateLocally = {
  [BELOW]: async () => ({default: stamp(BELOW)}),
  runner: () => import('../../migrate'),
};
/** A raw document below the floor, and the same content at the floor. */
const OLD = rawDoc(BELOW);
const AT_FLOOR = rawDoc(FLOOR);

/** A seeded document (at SEED_LAYOUT), seeded at module load. */
const SEEDED = seedShapes([NODE_SHAPES[0], shapesWith('table')[0]], CFG);

type Warning = {code: string; data: Record<string, unknown>};

function bind(
  state: Uint8Array,
  gc: boolean,
  options: Partial<YBindingOptions> = {},
): {
  editor: LexicalEditor;
  binding: YBinding;
  doc: YDoc;
  warnings: Warning[];
  errors: Error[];
  dispose: () => void;
} {
  const doc = createYDoc(state, {gc});
  const warnings: Warning[] = [];
  const errors: Error[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(CFG)],
      name: 'migrate-core',
      onError: (e: Error) => {
        errors.push(e);
      },
      onWarn: (w: Error) => {
        const {code, data} = w as unknown as Warning;
        warnings.push({code, data});
      },
    }),
  );
  const binding = new YBinding(editor, doc, {schemaVersion: 1, ...options});
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

const json = (editor: LexicalEditor) =>
  JSON.stringify(editor.getEditorState().toJSON());

/** Wait until `done` holds (a few macrotasks at most). */
async function until(done: () => boolean, rounds = 50): Promise<void> {
  for (let i = 0; i < rounds && !done(); i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

const olderWarnings = (warnings: Warning[]) =>
  warnings.filter(
    w => w.code === UNSUPPORTED_LAYOUT_WARNING && w.data.reason === 'older',
  );

afterEach(() => {
  setMinLayoutForTests(null);
});

describe.each([false, true])('the binding and layout migrations, gc %s', gc => {
  test('a seeded document is at or above MIN_LAYOUT: nothing is below the floor', () => {
    expect(MIN_LAYOUT).toBeLessThanOrEqual(SEED_LAYOUT);
    expect(SEED_LAYOUT).toBeLessThanOrEqual(LAYOUT_VERSION);
    const b = bind(SEEDED, gc);
    expect(b.binding.status).toBe('active');
    expect(olderWarnings(b.warnings)).toEqual([]);
    b.dispose();
  });

  test("below the floor: read only with the 'older' warning; headless reads and edits refuse it", () => {
    setMinLayoutForTests(FLOOR);
    const b = bind(OLD, gc);
    expect(b.binding.status).toBe('readonly');
    expect(b.editor.isEditable()).toBe(false);
    expect(olderWarnings(b.warnings).map(w => w.data)).toEqual([
      {found: BELOW, min: FLOOR, reason: 'older', supported: LAYOUT_VERSION},
    ]);
    // The editor shows the document, and a local edit is not written.
    expect(
      b.editor.getEditorState().read(() => $getRoot().getTextContent()),
    ).toContain('abc');
    const before = Y.encodeStateAsUpdate(b.doc);
    b.editor.update(
      () => {
        $getRoot().append($createParagraphNode().append($createTextNode('x')));
      },
      {discrete: true},
    );
    expect(Buffer.from(Y.encodeStateAsUpdate(b.doc))).toEqual(
      Buffer.from(before),
    );
    b.dispose();
    for (const run of [
      () => readYState(OLD, catalogHeadlessConfig(CFG), $snapshot),
      () =>
        editYState(
          OLD,
          catalogHeadlessConfig(CFG),
          () => {
            $getRoot().append($createParagraphNode());
          },
          {writer: null},
        ),
    ]) {
      let error: unknown = null;
      try {
        run();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(YHeadlessError);
      expect((error as YHeadlessError).code).toBe('read-only');
      expect(
        (error as YHeadlessError).warnings.map(
          w => (w as unknown as Warning).data,
        ),
      ).toContainEqual({
        found: BELOW,
        min: FLOOR,
        reason: 'older',
        supported: LAYOUT_VERSION,
      });
    }
    // At the floor: active.
    const c = bind(AT_FLOOR, gc);
    expect(c.binding.status).toBe('active');
    c.dispose();
  });

  test('migrateLocally: loads the chain, migrates in place, reads again and becomes editable', async () => {
    setMinLayoutForTests(FLOOR);
    const unbound = bind(AT_FLOOR, gc);
    const shown = json(unbound.editor);
    unbound.dispose();
    const runner = vi.fn(LOADERS.runner);
    const step = vi.fn(LOADERS[BELOW]);
    const b = bind(OLD, gc, {migrateLocally: {[BELOW]: step, runner}});
    expect(b.binding.status).toBe('readonly');
    // Handled by migrateLocally: no warning.
    expect(olderWarnings(b.warnings)).toEqual([]);
    await until(() => b.binding.status === 'active');
    expect(b.binding.status).toBe('active');
    expect(runner).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenCalledTimes(1);
    expect(recordedLayout(b.doc)).toBe(FLOOR);
    expect(json(b.editor)).toBe(shown);
    expect(b.editor.isEditable()).toBe(true);
    expect(b.errors).toEqual([]);
    // It writes now.
    b.editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('after')),
        );
      },
      {discrete: true},
    );
    expect(
      readYState(Y.encodeStateAsUpdate(b.doc), catalogHeadlessConfig(CFG), () =>
        $getRoot().getTextContent(),
      ),
    ).toContain('after');
    b.dispose();
  });

  test('migrateLocally through YCollabExtension', async () => {
    setMinLayoutForTests(FLOOR);
    const doc = createYDoc(OLD, {gc});
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          catalogAppExtension(CFG),
          configExtension(YCollabExtension, {
            doc,
            migrateLocally: LOADERS,
            schemaVersion: 1,
            synced: true,
          }),
        ],
        name: 'migrate-core-ext',
        onWarn: () => {},
      }),
    );
    const {binding} = getExtensionDependencyFromEditor(
      editor,
      YCollabExtension,
    ).output;
    expect(binding.status).toBe('readonly');
    await until(() => binding.status === 'active');
    expect(binding.status).toBe('active');
    expect(recordedLayout(doc)).toBe(FLOOR);
    editor.dispose();
  });

  test('migrateLocally that fails stays read only, the document untouched, the error to onError', async () => {
    setMinLayoutForTests(FLOOR);
    const failing: YMigrateLocally[] = [
      {
        [BELOW]: async () => {
          throw new Error('offline');
        },
        runner: LOADERS.runner,
      },
      {runner: LOADERS.runner},
      {[BELOW]: LOADERS[BELOW], runner: async () => ({})},
    ];
    for (const loaders of failing) {
      const b = bind(OLD, gc, {migrateLocally: loaders});
      const before = Y.encodeStateAsUpdate(b.doc);
      await until(() => b.errors.length > 0);
      expect(b.errors).toHaveLength(1);
      expect(b.binding.status).toBe('readonly');
      expect(recordedLayout(b.doc)).toBe(BELOW);
      expect(Buffer.from(Y.encodeStateAsUpdate(b.doc))).toEqual(
        Buffer.from(before),
      );
      b.dispose();
    }
  });

  test("a successful local migration clears only the 'older' cause: a newer schema keeps it read only", async () => {
    setMinLayoutForTests(FLOOR);
    const doc = createYDoc(OLD, {gc});
    doc.get('lexical-y').setAttr('lexical-y-schema:5', true);
    const b = bind(Y.encodeStateAsUpdate(doc), gc, {migrateLocally: LOADERS});
    await until(() => recordedLayout(b.doc) === FLOOR);
    await until(() => false, 5);
    expect(recordedLayout(b.doc)).toBe(FLOOR);
    expect(b.binding.status).toBe('readonly');
    expect(b.warnings.map(w => w.code)).toContain(UNSUPPORTED_SCHEMA_WARNING);
    b.dispose();
  });

  test("the 'older' warning goes to onWarn only when the app handles it in neither way", async () => {
    setMinLayoutForTests(FLOOR);
    const configs: [string, Partial<YBindingOptions>, number][] = [
      ['neither', {}, 1],
      ['onOlderLayout', {onOlderLayout: () => {}}, 0],
      [
        'migrateLocally',
        {
          migrateLocally: {
            [BELOW]: async () => {
              throw new Error('offline');
            },
            runner: LOADERS.runner,
          },
        },
        0,
      ],
    ];
    for (const [, options, warnings] of configs) {
      const b = bind(OLD, gc, options);
      await until(() => false, 3);
      expect(b.binding.status).toBe('readonly');
      expect(olderWarnings(b.warnings)).toHaveLength(warnings);
      b.dispose();
    }
    // Other read-only causes keep onWarn.
    const newer = createYDoc(AT_FLOOR, {gc});
    newer.get('lexical-y').setAttr(`lexical-y:${LAYOUT_VERSION + 1}`, true);
    const n = bind(Y.encodeStateAsUpdate(newer), gc, {onOlderLayout: () => {}});
    expect(
      n.warnings.filter(
        w => w.code === UNSUPPORTED_LAYOUT_WARNING && w.data.reason === 'newer',
      ),
    ).toHaveLength(1);
    n.dispose();
  });

  test('onOlderLayout through YCollabExtension', async () => {
    setMinLayoutForTests(FLOOR);
    const calls: [number, number][] = [];
    const warnings: unknown[] = [];
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          catalogAppExtension(CFG),
          configExtension(YCollabExtension, {
            doc: createYDoc(OLD, {gc}),
            onOlderLayout: (found, min) => calls.push([found, min]),
            schemaVersion: 1,
            synced: true,
          }),
        ],
        name: 'older-ext',
        onWarn: w => warnings.push(w),
      }),
    );
    await Promise.resolve();
    expect(calls).toEqual([[BELOW, FLOOR]]);
    expect(warnings).toEqual([]);
    editor.dispose();
  });

  test('onOlderLayout(found, min): once per read-only period, in a microtask', async () => {
    setMinLayoutForTests(FLOOR);
    const calls: [number, number][] = [];
    const b = bind(OLD, gc, {
      onOlderLayout: (found, min) => calls.push([found, min]),
    });
    expect(calls).toEqual([]);
    await Promise.resolve();
    expect(calls).toEqual([[BELOW, FLOOR]]);
    // Read again while still read only: not again.
    b.doc.get('lexical-y').setAttr('k:other', 'element');
    await until(() => false, 3);
    expect(calls).toEqual([[BELOW, FLOOR]]);
    b.dispose();
    // Another binding's period, ended by a migration: once.
    const c = bind(OLD, gc, {
      migrateLocally: LOADERS,
      onOlderLayout: (found, min) => calls.push([found, min]),
    });
    await until(() => c.binding.status === 'active');
    expect(calls).toEqual([
      [BELOW, FLOOR],
      [BELOW, FLOOR],
    ]);
    c.dispose();
    // At or above the floor: never.
    const d = bind(AT_FLOOR, gc, {
      onOlderLayout: (found, min) => calls.push([found, min]),
    });
    await until(() => false, 3);
    expect(calls).toHaveLength(2);
    d.dispose();
  });

  test("an epoch change (a migration) clears the binding's undo history after its capture", () => {
    const b = bind(SEEDED, gc, {captureTimeout: 0});
    const edit = (text: string) =>
      b.editor.update(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode(text)),
          );
        },
        {discrete: true},
      );
    edit('one');
    edit('two');
    const um = b.binding.undoManager!;
    expect(um.canUndo()).toBe(true);
    let cleared = -1;
    const stop = onLayoutEpoch(b.doc, () => {
      cleared = um.undoStack.length;
    });
    // A migration's epoch, from another origin (a step to the next layout,
    // where this build reads it, writes the same).
    if (SEED_LAYOUT < LAYOUT_VERSION) {
      migrateYDoc(b.doc, [STAMP], {to: SEED_LAYOUT + 1});
    } else {
      b.doc.transact(() => {
        b.doc.get('lexical-y').setAttr('lexical-y-epoch', {
          client: 9,
          clock: 0,
          layout: SEED_LAYOUT,
          revision: 1,
          step: `lexical-y/layout/${SEED_LAYOUT - 1}to${SEED_LAYOUT}`,
          v: 1,
        } as never);
      }, MIGRATION_ORIGIN);
    }
    expect(um.canUndo()).toBe(false);
    expect(um.canRedo()).toBe(false);
    // The binding's hook ran before ours (registered first): cleared then.
    expect(cleared).toBe(0);
    expect(b.binding.undo()).toBe(false);
    expect(b.binding.status).toBe('active');
    // It keeps capturing after.
    edit('three');
    expect(um.canUndo()).toBe(true);
    stop();
    b.dispose();
  });

  test("onLayoutEpoch fires once per migration, after an app UndoManager's capture", () => {
    const doc = createYDoc(SEEDED, {gc});
    const root = doc.get('lexical-y');
    const um = new Y.UndoManager(root, {
      captureTimeout: 0,
      trackedOrigins: new Set([MIGRATION_ORIGIN]),
    });
    const seen: unknown[] = [];
    const lengths: number[] = [];
    const stop = onLayoutEpoch(doc, epoch => {
      seen.push(epoch);
      lengths.push(um.undoStack.length);
      um.clear();
    });
    const receipt = migrateYDoc(doc, [STAMP], {to: SEED_LAYOUT + 1});
    // The migration was captured (tracked), and cleared by the hook.
    expect(lengths).toEqual([1]);
    expect(um.undoStack).toHaveLength(0);
    expect(seen).toEqual([receipt.roots[0].epoch]);
    // Other transactions do not fire it.
    root.setAttr('other', 1);
    expect(seen).toHaveLength(1);
    stop();
  });

  test('quiesce() commits a batched update, returns the state and a draft, and stays read only', async () => {
    const b = bind(SEEDED, gc);
    // Mounted: Lexical commits a non-discrete update in a microtask.
    const element = document.createElement('div');
    element.contentEditable = 'true';
    document.body.append(element);
    b.editor.setRootElement(element);
    // After the bind's own work, an update is batched.
    await new Promise(resolve => setTimeout(resolve, 0));
    b.editor.update(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('unsent')),
      );
    });
    // Still pending (batched): quiesce() commits it.
    expect(b.editor._pendingEditorState).not.toBeNull();
    const {state, draft} = b.binding.quiesce();
    expect(JSON.stringify(draft.json)).toContain('unsent');
    expect(draft.differs).toBe(false);
    expect(
      readYState(state, catalogHeadlessConfig(CFG), () =>
        $getRoot().getTextContent(),
      ),
    ).toContain('unsent');
    expect(b.binding.status).toBe('readonly');
    expect(b.editor.isEditable()).toBe(false);
    // A programmatic edit is not written.
    const after = Y.encodeStateAsUpdate(b.doc);
    b.editor.update(
      () => {
        $getRoot().append($createParagraphNode().append($createTextNode('x')));
      },
      {discrete: true},
    );
    expect(Buffer.from(Y.encodeStateAsUpdate(b.doc))).toEqual(
      Buffer.from(after),
    );
    // Read only for good: a change that has the document read again does
    // not make it editable.
    b.doc.get('lexical-y').setAttr(`lexical-y:${SEED_LAYOUT}`, true);
    b.doc.get('lexical-y').setAttr('k:other', 'element');
    expect(b.binding.status).toBe('readonly');
    b.editor.setRootElement(null);
    element.remove();
    b.dispose();
  });

  test('quiesce() ends a composition and writes its text; it refuses inside an update', () => {
    const b = bind(SEEDED, gc);
    b.editor.update(
      () => {
        const text = $createTextNode('compo');
        $getRoot().append($createParagraphNode().append(text));
        $setSelection(null);
        $setCompositionKey(text.getKey());
      },
      {discrete: true},
    );
    b.editor.update(
      () => {
        expect(() => b.binding.quiesce()).toThrow(/inside an editor update/);
      },
      {discrete: true},
    );
    const {state, draft} = b.binding.quiesce();
    expect(b.editor._compositionKey).toBeNull();
    expect(JSON.stringify(draft.json)).toContain('compo');
    expect(draft.differs).toBe(false);
    expect(
      readYState(state, catalogHeadlessConfig(CFG), () =>
        $getRoot().getTextContent(),
      ),
    ).toContain('compo');
    b.dispose();
  });

  test('quiesce() on a read-only binding: the draft is what it shows, nothing written', () => {
    setMinLayoutForTests(FLOOR);
    const b = bind(OLD, gc);
    const before = Y.encodeStateAsUpdate(b.doc);
    const {state, draft} = b.binding.quiesce();
    expect(Buffer.from(state)).toEqual(Buffer.from(before));
    expect(JSON.stringify(draft.json)).toContain('abc');
    expect(draft.differs).toBe(false);
    b.dispose();
  });
});
