/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The binding's public API (layout 4 spec, section 11, with 11.8): the
// entry points createYBinding and yCollab, their required choices and the
// errors that name the fix, the status with its cause, markSynced, the
// handshake, history, freeze, Y_DEFAULTS, and describeUnsyncedEdits.

import {
  blockIdState,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setState,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  createEditor,
  defineExtension,
  type LexicalEditor,
  UNDO_COMMAND,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {
  createYBinding,
  createYDoc,
  createYHandshake,
  LAYOUT_VERSION,
  parseYGeneration,
  Y_DEFAULTS,
  yCollab,
  type YCollabBinding,
  YCollabExtension,
  type YCollabOptions,
  type YStatus,
} from '../..';
import {describeUnsyncedEdits, seedYState} from '../../headless';
import {setMinLayoutForTests} from '../../internal/Binding';
import {STORAGE_MISMATCH_WARNING} from '../../internal/Warnings';
import {NODES} from '../utils/harness';
import {FLOOR, rawDoc} from '../utils/migrateSteps';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function newEditor(): LexicalEditor {
  return createEditor({
    namespace: 'api',
    nodes: NODES,
    onError: error => {
      throw error;
    },
    onWarn: () => {},
  });
}

function bind(options: Partial<YCollabOptions> = {}): {
  binding: YCollabBinding;
  editor: LexicalEditor;
  statuses: YStatus[];
} {
  const editor = newEditor();
  const statuses: YStatus[] = [];
  const binding = createYBinding(editor, {
    doc: createYDoc(),
    onStatus: status => statuses.push(status),
    schemaVersion: 1,
    synced: false,
    ...options,
  });
  return {binding, editor, statuses};
}

const text = (editor: LexicalEditor) =>
  editor.getEditorState().read(() => $getRoot().getTextContent());

function type(editor: LexicalEditor, value: string) {
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode(value)));
    },
    {discrete: true},
  );
}

describe('createYBinding', () => {
  test('starts pending, not editable, until markSynced; a second markSynced does nothing', async () => {
    const {binding, editor, statuses} = bind();
    expect(binding.status).toEqual({kind: 'pending'});
    expect(editor.isEditable()).toBe(false);
    binding.markSynced();
    await flush();
    expect(binding.status).toEqual({kind: 'active'});
    expect(editor.isEditable()).toBe(true);
    expect(statuses).toEqual([{kind: 'active'}]);
    binding.markSynced();
    await flush();
    expect(statuses).toEqual([{kind: 'active'}]);
    binding.dispose();
  });

  test('synced: true marks it synced at bind', async () => {
    const {binding} = bind({synced: true});
    await flush();
    expect(binding.status).toEqual({kind: 'active'});
    binding.dispose();
  });

  test('two bindings converge through their documents', async () => {
    const a = bind({synced: true});
    const b = bind({synced: false});
    await flush();
    type(a.editor, 'hello');
    Y.applyUpdate(
      b.binding.binding.doc,
      Y.encodeStateAsUpdate(a.binding.binding.doc),
    );
    b.binding.markSynced();
    await flush();
    expect(text(b.editor)).toBe(text(a.editor));
    expect(text(b.editor)).toContain('hello');
    a.binding.dispose();
    b.binding.dispose();
  });

  test('history: the default undoes, false has none; CAN_UNDO follows', async () => {
    const withHistory = bind({synced: true});
    await flush();
    expect(withHistory.binding.history).not.toBeNull();
    expect(withHistory.binding.history!.canUndo).toBe(false);
    let changes = 0;
    const unsubscribe = withHistory.binding.history!.subscribe(() => changes++);
    type(withHistory.editor, 'undo me');
    expect(withHistory.binding.history!.canUndo).toBe(true);
    expect(changes).toBeGreaterThan(0);
    withHistory.binding.history!.undo();
    expect(text(withHistory.editor)).not.toContain('undo me');
    unsubscribe();
    withHistory.binding.dispose();

    // CAN_UNDO and CAN_REDO: false at bind, then what the history says.
    const editor = newEditor();
    const canUndo: boolean[] = [];
    editor.registerCommand(
      CAN_UNDO_COMMAND,
      value => {
        canUndo.push(value);
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    );
    const dispatched = createYBinding(editor, {
      doc: createYDoc(),
      onStatus: () => {},
      schemaVersion: 1,
      synced: true,
    });
    await flush();
    expect(canUndo[0]).toBe(false);
    type(editor, 'step');
    expect(canUndo.at(-1)).toBe(true);
    dispatched.dispose();

    // UNDO_COMMAND undoes the binding's step, as the extension does.
    const undoing = newEditor();
    const withCommands = createYBinding(undoing, {
      doc: createYDoc(),
      onStatus: () => {},
      schemaVersion: 1,
      synced: true,
    });
    await flush();
    type(undoing, 'undone');
    expect(undoing.dispatchCommand(UNDO_COMMAND, undefined)).toBe(true);
    expect(
      undoing.getEditorState().read(() => $getRoot().getTextContent()),
    ).not.toContain('undone');
    withCommands.dispose();
    expect(undoing.dispatchCommand(UNDO_COMMAND, undefined)).toBe(false);

    const without = bind({history: false, synced: true});
    expect(without.binding.history).toBeNull();
    without.binding.dispose();
  });

  test('freeze hands over the local edits and turns the binding read only', async () => {
    const {binding, editor, statuses} = bind({synced: true});
    await flush();
    type(editor, 'keep me');
    const edits = binding.freeze();
    await flush();
    expect(edits.text).toContain('keep me');
    expect(edits.differs).toBe(false);
    expect(edits.json.root.children.length).toBeGreaterThan(0);
    expect(edits.state).toBeInstanceOf(Uint8Array);
    expect(binding.status).toEqual({cause: {code: 'frozen'}, kind: 'readonly'});
    expect(editor.isEditable()).toBe(false);
    expect(statuses.at(-1)).toEqual({
      cause: {code: 'frozen'},
      kind: 'readonly',
    });
    // Each call returns its own copies.
    const again = binding.freeze();
    expect(again.state).not.toBe(edits.state);
    edits.json.root.children.length = 0;
    expect(binding.freeze().json.root.children.length).toBeGreaterThan(0);
    expect(again.text).toBe(edits.text);
    binding.dispose();
  });
});

describe('handshake', () => {
  test('fills hasLocalEdits from what the client wrote, and the release fields', async () => {
    const {binding, editor} = bind({synced: true});
    await flush();
    // Seeding an empty document is a write of this client's.
    const generation = parseYGeneration('g1:["inc",[]]');
    expect(generation).not.toBeNull();
    const first = binding.handshake(generation);
    expect(first).toMatchObject({generation: 'g1:["inc",[]]', v: 1});
    expect(first).toEqual(
      createYHandshake({generation, hasLocalEdits: first.material}),
    );
    type(editor, 'local');
    expect(binding.handshake(null)).toMatchObject({
      generation: null,
      material: true,
    });
    binding.dispose();
  });

  test("seeding an empty document is the client's local edit", async () => {
    const {binding, editor} = bind();
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('seed')),
        );
      },
      {discrete: true},
    );
    binding.markSynced();
    await flush();
    expect(binding.handshake(null).material).toBe(true);
    binding.dispose();
  });

  test('a cached state holding only pending structs is material', () => {
    const source = new Y.Doc();
    source.get('t').insert(0, 'A');
    const vector = Y.encodeStateVector(source);
    source.get('t').insert(1, 'B');
    // B without A: Yjs holds it as pending.
    const doc = createYDoc(Y.encodeStateAsUpdate(source, vector));
    expect(doc.store.clients.size).toBe(0);
    const {binding} = bind({doc});
    expect(binding.handshake(null).material).toBe(true);
    binding.dispose();
  });

  test('a fresh client with nothing written has no local edits', () => {
    const {binding} = bind();
    expect(binding.handshake(null).material).toBe(false);
    binding.dispose();
  });

  test('a document that held state before the first sync has local edits', () => {
    const seeded = createYDoc();
    seeded.get('other').insert(0, 'cached');
    const {binding} = bind({doc: seeded});
    expect(binding.handshake(null).material).toBe(true);
    binding.dispose();
  });

  test('a string that is not a generation is refused, naming the fix', () => {
    const {binding} = bind();
    expect(() => binding.handshake('abc' as never)).toThrow(
      /takes the generation your server issued/,
    );
    expect(parseYGeneration('abc')).toBeNull();
    expect(parseYGeneration(42)).toBeNull();
    binding.dispose();
  });
});

describe('read only, with its cause', () => {
  test('a newer schema version', async () => {
    const doc = createYDoc();
    // A peer with schema version 5 wrote the document.
    const peer = bind({doc, schemaVersion: 5, synced: true});
    await flush();
    type(peer.editor, 'from v5');
    const {binding, statuses} = bind({
      doc: createYDoc(Y.encodeStateAsUpdate(doc)),
      synced: true,
    });
    await flush();
    expect(binding.status).toEqual({
      cause: {code: 'schema-newer', schemaVersion: 5},
      kind: 'readonly',
    });
    expect(statuses.at(-1)).toEqual(binding.status);
    // A cause the binding warns after the schema's does not replace it: the
    // newer schema explains what follows.
    (
      binding.binding as unknown as {
        warn(code: string, message: string, data: unknown): void;
      }
    ).warn(STORAGE_MISMATCH_WARNING, 'later', {type: 'paragraph'});
    expect(binding.status).toEqual({
      cause: {code: 'schema-newer', schemaVersion: 5},
      kind: 'readonly',
    });
    // Freezing it then reports the new cause, though the binding's own
    // status does not change, once Yjs is idle.
    const ydoc = binding.binding.doc;
    const count = statuses.length;
    ydoc.once('afterTransaction', () => {
      // In a transaction's cleanup: Yjs is not idle yet.
      binding.freeze();
      expect(statuses.length).toBe(count);
    });
    ydoc.transact(() => {
      ydoc.get('other').insert(0, 'x');
    });
    expect(statuses.at(-1)).toEqual({
      cause: {code: 'frozen'},
      kind: 'readonly',
    });
    peer.binding.dispose();
    binding.dispose();
  });
});

describe('read only, with its cause: layouts', () => {
  afterEach(() => {
    setMinLayoutForTests(null);
  });

  test('a layout below the floor waits for its server: layout-older', async () => {
    setMinLayoutForTests(FLOOR);
    const {binding} = bind({
      doc: createYDoc(rawDoc(FLOOR - 1)),
      synced: true,
    });
    await flush();
    expect(binding.status).toEqual({
      cause: {code: 'layout-older', layout: FLOOR - 1},
      kind: 'readonly',
    });
    binding.dispose();
  });

  test('a newer layout: layout-newer', async () => {
    const {binding} = bind({
      doc: createYDoc(rawDoc(LAYOUT_VERSION + 1)),
      synced: true,
    });
    await flush();
    expect(binding.status).toEqual({
      cause: {code: 'layout-newer', layout: LAYOUT_VERSION + 1},
      kind: 'readonly',
    });
    binding.dispose();
  });
});

describe('required choices fail with the fix', () => {
  const doc = createYDoc();
  const onStatus = () => {};
  test.each([
    ['no synced', {doc, onStatus, schemaVersion: 1}, /needs synced/],
    ['no onStatus', {doc, schemaVersion: 1, synced: false}, /needs onStatus/],
    ['no doc', {onStatus, schemaVersion: 1, synced: false}, /needs doc/],
    ['no schemaVersion', {doc, onStatus, synced: false}, /needs schemaVersion/],
    [
      'a root that is not a name',
      {doc, onStatus, root: 1, schemaVersion: 1, synced: false},
      /takes root as a name/,
    ],
  ])('%s', (_name, options, message) => {
    expect(() => createYBinding(newEditor(), options as never)).toThrow(
      message,
    );
    expect(() => yCollab(options as never)).toThrow(message);
  });
});

test('Y_DEFAULTS states the defaults the binding uses', () => {
  expect(Y_DEFAULTS).toEqual({
    history: {captureTimeout: 500},
    root: 'lexical-y',
  });
  expect(Object.isFrozen(Y_DEFAULTS)).toBe(true);
  const {binding} = bind();
  expect(binding.binding.root).toBe(binding.binding.doc.get(Y_DEFAULTS.root));
  binding.dispose();
});

test('yCollab: the extension built from the options, its collab output', async () => {
  const statuses: YStatus[] = [];
  const doc = createYDoc();
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        yCollab({
          doc,
          onStatus: status => statuses.push(status),
          schemaVersion: 1,
          synced: false,
        }),
      ],
      name: 'api',
      nodes: () => NODES,
      onError: error => {
        throw error;
      },
      onWarn: () => {},
    }),
  );
  const {collab} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  expect(collab.status).toEqual({kind: 'pending'});
  // Nothing written yet: no local edits.
  expect(collab.handshake(null).material).toBe(false);
  collab.markSynced();
  await flush();
  expect(collab.status).toEqual({kind: 'active'});
  expect(statuses).toEqual([{kind: 'active'}]);
  expect(collab.handshake(null)).toMatchObject({v: 1});
  editor.dispose();
});

test('disposing the editor removes the collab binding listener', () => {
  const doc = createYDoc();
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        yCollab({doc, onStatus: () => {}, schemaVersion: 1, synced: false}),
      ],
      name: 'api-dispose',
      nodes: () => NODES,
      onError: error => {
        throw error;
      },
      onWarn: () => {},
    }),
  );
  const {collab} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  editor.dispose();
  // A local write after the dispose is not this binding's to report.
  doc.get('other').insert(0, 'after dispose');
  expect(collab.handshake(null).material).toBe(false);
});

test('parseYGeneration checks the version prefix and keeps the rest opaque', () => {
  expect(parseYGeneration('g1:["inc",[["lexical-y",null]]]')).not.toBeNull();
  expect(parseYGeneration('unknown')).toBe('unknown');
  expect(parseYGeneration('g1:')).toBeNull();
  expect(parseYGeneration('g2:x')).toBeNull();
  expect(parseYGeneration(42)).toBeNull();
});

test('the binding adds no update listener: a document with no provider encodes no updates', async () => {
  const doc = createYDoc();
  const updates: number[] = [];
  const countUpdates = () => {
    let n = 0;
    const observers = (
      doc as unknown as {_observers: Map<string, Set<unknown>>}
    )._observers;
    const set = observers.get('update');
    n = set === undefined ? 0 : set.size;
    updates.push(n);
  };
  const {binding, editor} = bind({doc, synced: true});
  await flush();
  type(editor, 'typed');
  countUpdates();
  expect(updates).toEqual([0]);
  expect(binding.handshake(null).material).toBe(true);
  binding.dispose();
});

test('dispose stops the binding and its listener', async () => {
  const {binding, editor} = bind({synced: true});
  await flush();
  binding.dispose();
  type(editor, 'not written');
  expect(binding.binding.doc.get('lexical-y').toString()).not.toContain(
    'not written',
  );
});

describe('describeUnsyncedEdits', () => {
  const config = {nodes: NODES, onWarn: () => {}, schemaVersion: 1};
  const $paragraph = (value: string, id?: string) => {
    const paragraph = $createParagraphNode().append($createTextNode(value));
    if (id !== undefined) {
      $setState(paragraph, blockIdState, id);
    }
    return paragraph;
  };
  const seed = (blocks: [string, string?][]) =>
    seedYState(config, () => {
      $getRoot().append(...blocks.map(([value, id]) => $paragraph(value, id)));
    });

  test('by block id: changed, added and deleted, replayable where now still matches the base', () => {
    const base = seed([
      ['one', 'b1'],
      ['two', 'b2'],
      ['three', 'b3'],
    ]);
    const edits = seed([
      ['one!', 'b1'],
      ['two', 'b2'],
      ['four', 'b4'],
    ]);
    const current = seed([
      ['one', 'b1'],
      ['two?', 'b2'],
      ['three', 'b3'],
    ]);
    const report = describeUnsyncedEdits({
      base,
      capturedAt: 1,
      config,
      current,
      edits: {state: edits},
      reason: 'stale',
    });
    expect(report.baseAvailable).toBe(true);
    expect(report.blocks.map(b => [b.id, b.change, b.replayable])).toEqual([
      ['b1', 'changed', true],
      ['b4', 'added', true],
      ['b3', 'deleted', true],
    ]);
    expect(report.fragment.length).toBe(2);
  });

  test("freeze()'s result: what the user saw, from its JSON", async () => {
    const base = seed([['one'], ['two']]);
    const {binding, editor} = bind({doc: createYDoc(base), synced: true});
    await flush();
    editor.update(
      () => {
        const second = $getRoot().getLastChild();
        if (second !== null) {
          second.replace($paragraph('two, edited'));
        }
      },
      {discrete: true},
    );
    await flush();
    const edits = binding.freeze();
    const report = describeUnsyncedEdits({
      base,
      capturedAt: 4,
      config,
      current: base,
      edits,
      reason: 'stale',
    });
    expect(report.blocks.map(b => [b.id, b.change])).toEqual([
      ['#1', 'changed'],
    ]);
    expect(JSON.stringify(report.blocks[0].yours)).toContain('two, edited');
    binding.dispose();
  });

  test('without a base: judged against now, nothing replayable', () => {
    const edits = seed([
      ['one!', 'b1'],
      ['two', 'b2'],
    ]);
    const current = seed([
      ['one', 'b1'],
      ['two', 'b2'],
    ]);
    const report = describeUnsyncedEdits({
      base: null,
      capturedAt: 2,
      config,
      current,
      edits: {state: edits},
      reason: 'expired',
    });
    expect(report.baseAvailable).toBe(false);
    expect(report.blocks.map(b => [b.id, b.change, b.replayable])).toEqual([
      ['b1', 'changed', false],
    ]);
  });

  test('without block ids: by position, nothing replayable', () => {
    const base = seed([['one'], ['two']]);
    const edits = seed([['one'], ['two!']]);
    const report = describeUnsyncedEdits({
      base,
      capturedAt: 3,
      config,
      current: base,
      edits: {state: edits},
      reason: 'legacy',
    });
    expect(report.blocks.map(b => [b.id, b.change, b.replayable])).toEqual([
      ['#1', 'changed', false],
    ]);
  });
});
