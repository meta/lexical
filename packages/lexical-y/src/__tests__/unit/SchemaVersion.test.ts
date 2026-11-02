/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The schema version gate: an app declares the version of its document
// schema (`schemaVersion`), a document records every version that wrote to
// it (`lexical-y-schema:<n>` = true on the root, a record that only grows),
// and a client older than the highest recorded version opens the document
// read only, with an UNSUPPORTED_SCHEMA_WARNING. A client of an equal or
// higher version edits as before, keeping the fields it does not know.

import {buildEditorFromExtensions} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $getRoot,
  configExtension,
  createEditor,
  defineExtension,
  ElementNode,
  type LexicalEditor,
  LexicalWarning,
  nodeSchema,
  type ParagraphNode,
  stringValue,
  TextNode,
  withField,
} from 'lexical';
import {afterEach, describe, expect, test, vi} from 'vitest';

import {
  createYDoc,
  RECOVERED_READ_WARNING,
  UNSUPPORTED_EDIT_WARNING,
  UNSUPPORTED_SCHEMA_WARNING,
  YBinding,
  type YBindingOptions,
  YCollabExtension,
  type YDoc,
} from '../..';
import {
  editYState,
  type HeadlessYConfig,
  readYState,
  seedYState,
  YHeadlessError,
} from '../../headless';
import {Reader} from '../../internal/Read';
import {$p, NODES} from '../utils/harness';

const SCHEMA = 'lexical-y-schema:';

interface Client {
  binding: YBinding;
  doc: YDoc;
  editor: LexicalEditor;
  warnings: LexicalWarning[];
  /** Updates this client's document emitted (its own writes and applies). */
  updates: Uint8Array[];
}

function client(
  schemaVersion: number,
  options: Partial<YBindingOptions> = {},
  nodes: NonNullable<Parameters<typeof createEditor>[0]>['nodes'] = NODES,
): Client {
  const doc = createYDoc(null, {gc: false});
  const warnings: LexicalWarning[] = [];
  const editor = createEditor({
    namespace: 'schema',
    nodes,
    onError: e => {
      throw e;
    },
    onWarn: e => {
      expect(e).toBeInstanceOf(LexicalWarning);
      warnings.push(e as LexicalWarning);
    },
  });
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  const binding = new YBinding(editor, doc, {
    captureTimeout: null,
    schemaVersion,
    selfCheck: true,
    ...options,
  });
  binding.start();
  return {binding, doc, editor, updates, warnings};
}

/** Exchange what each document lacks. */
function sync(...clients: Client[]): void {
  for (const a of clients) {
    for (const b of clients) {
      if (a !== b) {
        Y.applyUpdate(
          b.doc,
          Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
        );
      }
    }
  }
}

const text = (c: Client) =>
  c.editor.getEditorState().read(() => $getRoot().getTextContent());

/** The schema records of a document's root, sorted. */
const records = (doc: YDoc, root = 'lexical-y') =>
  Object.keys(doc.get(root).getAttrs())
    .filter(k => k.startsWith(SCHEMA))
    .sort();

const codes = (c: Client) => c.warnings.map(w => w.code);

/** Append `s` to the first paragraph. */
function type(c: Client, s: string): void {
  c.editor.update(
    () => {
      const first = $getRoot().getFirstChild() as ParagraphNode;
      const last = first.getLastChild();
      if (last instanceof TextNode) {
        last.setTextContent(last.getTextContent() + s);
      } else {
        first.append(new TextNode(s));
      }
    },
    {discrete: true},
  );
}

/** A client of `version` that writes a new document holding `content`. */
function seeded(version: number, content: string): Client {
  const c = client(version);
  c.editor.update(() => $getRoot().clear().append($p(content)), {
    discrete: true,
  });
  c.binding.initialize();
  expect(c.binding.status).toBe('active');
  return c;
}

describe('schema version gate', () => {
  test('a new document records the version that wrote it', () => {
    const a = seeded(3, 'hello');
    expect(records(a.doc)).toEqual([SCHEMA + '3']);
    expect(a.doc.get('lexical-y').getAttr(SCHEMA + '3')).toBe(true);
  });

  test('an older client opens a newer document read only, with the warning', () => {
    const newer = seeded(2, 'hello');
    const older = client(1);
    sync(newer, older);
    older.binding.initialize();
    expect(older.binding.status).toBe('readonly');
    expect(older.editor.isEditable()).toBe(false);
    // It shows the document.
    expect(text(older)).toBe('hello');
    expect(codes(older)).toEqual([UNSUPPORTED_SCHEMA_WARNING]);
    expect(older.warnings[0].data).toEqual({
      found: 2,
      reason: 'newer',
      supported: 1,
    });
    // A short developer note, no product text.
    expect(older.warnings[0].message).toBe(
      `schema 2 is newer than 1. A newer version of your app (a higher schemaVersion) wrote this document, so this editor is read only: load the newer app version to edit it`,
    );

    // A local edit is refused (#9510): nothing is written, and the editor
    // shows the document again.
    const before = Y.encodeStateVector(older.doc);
    type(older, ' world');
    expect(Y.encodeStateVector(older.doc)).toEqual(before);
    expect(text(older)).toBe('hello');
    expect(codes(older)).toEqual([
      UNSUPPORTED_SCHEMA_WARNING,
      UNSUPPORTED_EDIT_WARNING,
    ]);
    // Nothing of its own reached the document.
    expect(records(older.doc)).toEqual([SCHEMA + '2']);
  });

  test('an equal or higher version edits; opening writes nothing', () => {
    const v1 = seeded(1, 'hello');
    for (const version of [1, 2]) {
      const c = client(version);
      sync(v1, c);
      c.updates.length = 0;
      c.binding.initialize();
      expect(c.binding.status).toBe('active');
      expect(c.warnings).toEqual([]);
      // Opening wrote nothing.
      expect(c.updates).toEqual([]);
      expect(records(c.doc)).toEqual([SCHEMA + '1']);
    }
    const v2 = client(2);
    sync(v1, v2);
    v2.binding.initialize();
    v2.updates.length = 0;
    type(v2, '!');
    // The first write carries the version, in the same update: a client
    // that receives the edit receives the record with it.
    expect(v2.updates).toHaveLength(1);
    const alone = client(1);
    Y.applyUpdate(alone.doc, Y.encodeStateAsUpdate(v1.doc));
    alone.binding.initialize();
    expect(alone.binding.status).toBe('active');
    Y.applyUpdate(alone.doc, v2.updates[0]);
    expect(alone.binding.status).toBe('readonly');
    expect(text(alone)).toBe('hello!');
    expect(records(v2.doc)).toEqual([SCHEMA + '1', SCHEMA + '2']);
    // A later write records nothing more.
    v2.updates.length = 0;
    type(v2, '?');
    expect(v2.updates).toHaveLength(1);
    expect(records(v2.doc)).toEqual([SCHEMA + '1', SCHEMA + '2']);
  });

  test('an older client turns read only when a newer one edits mid-session', () => {
    const older = seeded(1, 'ab');
    const newer = client(2);
    sync(older, newer);
    newer.binding.initialize();
    expect(newer.binding.status).toBe('active');
    // Both edit while the record holds only version 1.
    type(older, 'c');
    sync(older, newer);
    expect(older.binding.status).toBe('active');
    expect(text(newer)).toBe('abc');
    // The newer client's first write records 2: the older one turns read
    // only then, and shows that write, what it had shown included.
    type(newer, 'd');
    sync(older, newer);
    expect(older.binding.status).toBe('readonly');
    expect(older.editor.isEditable()).toBe(false);
    expect(text(older)).toBe('abcd');
    expect(codes(older)).toEqual([UNSUPPORTED_SCHEMA_WARNING]);
    expect(older.warnings[0].data).toEqual({
      found: 2,
      reason: 'newer',
      supported: 1,
    });
    // It keeps reading the newer client's edits.
    type(newer, 'e');
    sync(older, newer);
    expect(text(older)).toBe('abcde');
    expect(older.binding.status).toBe('readonly');
    expect(codes(older)).toEqual([UNSUPPORTED_SCHEMA_WARNING]);
  });

  test('a local edit pending when the newer record arrives is written', () => {
    const older = seeded(1, 'ab');
    const newer = client(2);
    sync(older, newer);
    newer.binding.initialize();
    type(newer, 'd');
    // An update made in the same task as the provider applies the change:
    // made while the binding could write, it is written before the change
    // is read, not refused.
    older.editor.update(() => {
      const t = $getRoot().getFirstDescendant() as TextNode;
      t.setTextContent('X' + t.getTextContent());
    });
    Y.applyUpdate(
      older.doc,
      Y.encodeStateAsUpdate(newer.doc, Y.encodeStateVector(older.doc)),
    );
    expect(older.binding.status).toBe('readonly');
    expect(codes(older)).toEqual([UNSUPPORTED_SCHEMA_WARNING]);
    sync(older, newer);
    expect(text(newer)).toBe('Xabd');
    expect(text(older)).toBe('Xabd');
  });

  test('concurrent versions: the highest recorded wins on every client', () => {
    const base = seeded(1, 'x');
    const v2 = client(2);
    const v3 = client(3);
    sync(base, v2, v3);
    v2.binding.initialize();
    v3.binding.initialize();
    // Both write at once, without seeing each other.
    type(v2, '2');
    type(v3, '3');
    expect(records(v2.doc)).toEqual([SCHEMA + '1', SCHEMA + '2']);
    expect(records(v3.doc)).toEqual([SCHEMA + '1', SCHEMA + '3']);
    sync(base, v2, v3);
    for (const c of [base, v2, v3]) {
      expect(records(c.doc)).toEqual([
        SCHEMA + '1',
        SCHEMA + '2',
        SCHEMA + '3',
      ]);
    }
    expect(v3.binding.status).toBe('active');
    expect(v2.binding.status).toBe('readonly');
    expect(base.binding.status).toBe('readonly');
    expect(v2.warnings.map(w => w.data)).toEqual([
      {found: 3, reason: 'newer', supported: 2},
    ]);
    // Warned again for each higher version it receives (here 2, then 3).
    expect(base.warnings.map(w => w.data)).toEqual([
      {found: 2, reason: 'newer', supported: 1},
      {found: 3, reason: 'newer', supported: 1},
    ]);
    // Every client shows the same document.
    expect(text(base)).toBe(text(v3));
    expect(text(v2)).toBe(text(v3));
    // A fresh client reads the highest.
    const fresh = client(2);
    Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(v3.doc));
    fresh.binding.initialize();
    expect(fresh.binding.status).toBe('readonly');
    expect(fresh.warnings.map(w => w.data)).toEqual([
      {found: 3, reason: 'newer', supported: 2},
    ]);
  });

  test('undo never removes a version record', () => {
    const base = seeded(1, 'x');
    const v2 = client(2, {captureTimeout: 0});
    sync(base, v2);
    v2.binding.initialize();
    type(v2, 'y');
    expect(records(v2.doc)).toEqual([SCHEMA + '1', SCHEMA + '2']);
    expect(v2.binding.undoManager!.canUndo()).toBe(true);
    v2.binding.undo();
    expect(text(v2)).toBe('x');
    expect(records(v2.doc)).toEqual([SCHEMA + '1', SCHEMA + '2']);
    v2.binding.redo();
    expect(text(v2)).toBe('xy');
    v2.binding.undo();
    expect(records(v2.doc)).toEqual([SCHEMA + '1', SCHEMA + '2']);
    // Undone, the edit still came from version 2: a version 1 client stays
    // read only.
    const v1 = client(1);
    Y.applyUpdate(v1.doc, Y.encodeStateAsUpdate(v2.doc));
    v1.binding.initialize();
    expect(v1.binding.status).toBe('readonly');
  });

  test('a malformed record opens the document read only', () => {
    const a = seeded(1, 'x');
    const b = client(5);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    b.doc.get('lexical-y').setAttr(SCHEMA + 'two', true);
    b.binding.initialize();
    expect(b.binding.status).toBe('readonly');
    expect(b.warnings.map(w => [w.code, w.data])).toEqual([
      [
        UNSUPPORTED_SCHEMA_WARNING,
        {found: true, key: SCHEMA + 'two', reason: 'malformed', supported: 5},
      ],
    ]);
  });

  test('an older client does not initialize a document a newer one recorded', () => {
    const c = client(1);
    // A newer client's record arrived, its content not yet.
    c.doc.get('lexical-y').setAttr(SCHEMA + '2', true);
    c.editor.update(() => $getRoot().clear().append($p('mine')), {
      discrete: true,
    });
    const before = Y.encodeStateVector(c.doc);
    c.binding.initialize();
    expect(c.binding.status).toBe('readonly');
    expect(Y.encodeStateVector(c.doc)).toEqual(before);
    expect(codes(c)).toEqual([UNSUPPORTED_SCHEMA_WARNING]);
  });
});

/** Errors rethrown in microtasks (an app listener's), collected. */
function catchMicrotasks(): unknown[] {
  const caught: unknown[] = [];
  const original = globalThis.queueMicrotask.bind(globalThis);
  vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(fn =>
    original(() => {
      try {
        fn();
      } catch (error) {
        caught.push(error);
      }
    }),
  );
  return caught;
}

/** The update that brings only `doc`'s root schema record `key`. */
function recordOnly(doc: YDoc, key: string): Uint8Array {
  const copy = createYDoc(Y.encodeStateAsUpdate(doc), {gc: false});
  const sv = Y.encodeStateVector(copy);
  copy.get('lexical-y').setAttr(key, true);
  const update = Y.encodeStateAsUpdate(copy, sv);
  copy.destroy();
  return update;
}

describe('schema version gate: timing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('a recovery that first writes many pending local updates still gates', async () => {
    const caught = catchMicrotasks();
    const older = seeded(1, 'ab');
    const newer = client(2);
    sync(older, newer);
    newer.binding.initialize();
    type(newer, 'd');
    // A new task: the updates below wait for a commit.
    await new Promise(resolve => setTimeout(resolve, 0));
    // Each commit's listener queues the next update and throws, so that the
    // read gives up on the pending updates and recovers.
    let left = 20;
    older.editor.registerUpdateListener(({tags}) => {
      if (left > 0 && !tags.has('collaboration')) {
        const n = left--;
        older.editor.update(() => void $getRoot().append($p(`q${n}`)));
        throw new Error(`app failure ${n}`);
      }
    });
    older.editor.update(() => void $getRoot().append($p('first')));
    Y.applyUpdate(
      older.doc,
      Y.encodeStateAsUpdate(newer.doc, Y.encodeStateVector(older.doc)),
    );
    await Promise.resolve();
    expect(caught).toHaveLength(20);
    expect(older.binding.status).toBe('readonly');
    expect(codes(older)).toContain(UNSUPPORTED_SCHEMA_WARNING);
    // The updates made before the change was read were written.
    sync(older, newer);
    for (const s of ['first', 'q1', 'q20', 'abd']) {
      expect(text(newer)).toContain(s);
    }
    // Later local updates are refused.
    const before = Y.encodeStateVector(older.doc);
    older.editor.update(() => void $getRoot().append($p('late')), {
      discrete: true,
    });
    expect(Y.encodeStateVector(older.doc)).toEqual(before);
  });

  test('local updates still pending past the commit limit: the read does not run, and the recovery gates', async () => {
    const caught = catchMicrotasks();
    const older = seeded(1, 'ab');
    const newer = client(2);
    sync(older, newer);
    newer.binding.initialize();
    type(newer, 'd');
    await new Promise(resolve => setTimeout(resolve, 0));
    // More pending commits than the read waits for: it gives up before it
    // runs (its `before` never gates), and only the recovery can.
    let left = 40;
    older.editor.registerUpdateListener(({tags}) => {
      if (left > 0 && !tags.has('collaboration')) {
        const n = left--;
        older.editor.update(() => void $getRoot().append($p(`q${n}`)));
        throw new Error(`app failure ${n}`);
      }
    });
    older.editor.update(() => void $getRoot().append($p('first')));
    Y.applyUpdate(
      older.doc,
      Y.encodeStateAsUpdate(newer.doc, Y.encodeStateVector(older.doc)),
    );
    await Promise.resolve();
    expect(caught.length).toBeGreaterThan(0);
    expect(older.binding.status).toBe('readonly');
    // The recovery read gated, not a fail-closed path (which warns about
    // what it cannot read instead of a recovered read).
    expect(codes(older)).toEqual([
      RECOVERED_READ_WARNING,
      UNSUPPORTED_SCHEMA_WARNING,
    ]);
    const before = Y.encodeStateVector(older.doc);
    older.editor.update(() => void $getRoot().append($p('late')), {
      discrete: true,
    });
    expect(Y.encodeStateVector(older.doc)).toEqual(before);
  });

  test('a record that arrives alone while an update runs: the update is written, then read only', () => {
    const older = seeded(1, 'ab');
    const update = recordOnly(older.doc, SCHEMA + '2');
    older.editor.update(
      () => {
        const t = $getRoot().getFirstDescendant() as TextNode;
        t.setTextContent('X' + t.getTextContent());
        Y.applyUpdate(older.doc, update);
      },
      {discrete: true},
    );
    expect(older.binding.status).toBe('readonly');
    expect(codes(older)).toEqual([UNSUPPORTED_SCHEMA_WARNING]);
    const reader = client(2);
    Y.applyUpdate(reader.doc, Y.encodeStateAsUpdate(older.doc));
    reader.binding.initialize();
    expect(text(reader)).toBe('Xab');
    expect(text(older)).toBe('Xab');
  });

  test('a record that arrives alone with nothing pending gates at once', () => {
    const older = seeded(1, 'ab');
    Y.applyUpdate(older.doc, recordOnly(older.doc, SCHEMA + '2'));
    expect(older.binding.status).toBe('readonly');
    const before = Y.encodeStateVector(older.doc);
    type(older, 'c');
    expect(Y.encodeStateVector(older.doc)).toEqual(before);
    expect(text(older)).toBe('ab');
  });

  test("an update the app's Yjs observers make on the newer record is refused", () => {
    const older = seeded(1, 'ab');
    const newer = client(2);
    sync(older, newer);
    newer.binding.initialize();
    type(newer, 'd');
    let armed = true;
    older.doc.get('lexical-y').observe(() => {
      if (armed) {
        armed = false;
        older.editor.update(() => void $getRoot().append($p('late')), {
          discrete: true,
        });
      }
    });
    Y.applyUpdate(
      older.doc,
      Y.encodeStateAsUpdate(newer.doc, Y.encodeStateVector(older.doc)),
    );
    expect(armed).toBe(false);
    expect(older.binding.status).toBe('readonly');
    sync(older, newer);
    expect(text(newer)).toBe('abd');
    expect(text(older)).toBe('abd');
  });

  test("an observer's update on the newer record is refused, a local update pending before it written", async () => {
    const older = seeded(1, 'ab');
    const newer = client(2);
    sync(older, newer);
    newer.binding.initialize();
    type(newer, 'd');
    await new Promise(resolve => setTimeout(resolve, 0));
    let armed = true;
    older.doc.get('lexical-y').observe(() => {
      if (armed) {
        armed = false;
        older.editor.update(() => void $getRoot().append($p('late')), {
          discrete: true,
        });
      }
    });
    // Pending: made before the change, it waits for a commit.
    older.editor.update(() => {
      const t = $getRoot().getFirstDescendant() as TextNode;
      t.setTextContent('X' + t.getTextContent());
    });
    Y.applyUpdate(
      older.doc,
      Y.encodeStateAsUpdate(newer.doc, Y.encodeStateVector(older.doc)),
    );
    expect(armed).toBe(false);
    expect(older.binding.status).toBe('readonly');
    sync(older, newer);
    expect(text(newer)).toBe('Xabd');
    expect(text(older)).toBe('Xabd');
  });

  test('a gate deferred to a running update does nothing once the binding is disposed', () => {
    const older = seeded(1, 'ab');
    const update = recordOnly(older.doc, SCHEMA + '2');
    older.editor.update(
      () => {
        Y.applyUpdate(older.doc, update);
        older.binding.dispose();
      },
      {discrete: true},
    );
    expect(older.editor.isEditable()).toBe(true);
    expect(older.warnings).toEqual([]);
  });

  test("a write in the app's own transaction records the version only when the binding writes", () => {
    const v1 = seeded(1, 'x');
    const v2 = client(2);
    sync(v1, v2);
    v2.binding.initialize();
    v2.doc.transact(() => {
      v2.doc.get('log').setAttr('opened', true);
      // An update that changes nothing the binding stores.
      v2.editor.update(() => void $getRoot().getFirstChild()!.markDirty(), {
        discrete: true,
      });
    });
    expect(v2.doc.get('log').getAttr('opened')).toBe(true);
    expect(records(v2.doc)).toEqual([SCHEMA + '1']);
    v2.doc.transact(() => {
      v2.doc.get('log').setAttr('edited', true);
      type(v2, 'y');
    });
    expect(records(v2.doc)).toEqual([SCHEMA + '1', SCHEMA + '2']);
  });

  test('a record that arrives while an update runs that then throws: later updates are refused', () => {
    const older = seeded(1, 'ab');
    const update = recordOnly(older.doc, SCHEMA + '2');
    expect(() =>
      older.editor.update(
        () => {
          const t = $getRoot().getFirstDescendant() as TextNode;
          t.setTextContent('X' + t.getTextContent());
          Y.applyUpdate(older.doc, update);
          throw new Error('app failure');
        },
        {discrete: true},
      ),
    ).toThrow('app failure');
    // The update the gate waited for never committed: the next one is not
    // written, and the binding is read only.
    const before = Y.encodeStateVector(older.doc);
    type(older, 'c');
    expect(Y.encodeStateVector(older.doc)).toEqual(before);
    expect(older.binding.status).toBe('readonly');
    expect(codes(older)).toContain(UNSUPPORTED_SCHEMA_WARNING);
    expect(text(older)).toBe('ab');
  });

  test('a binding the schema gate holds stays read only when the layout record changes', () => {
    const older = seeded(1, 'ab');
    Y.applyUpdate(older.doc, recordOnly(older.doc, SCHEMA + '2'));
    expect(older.binding.status).toBe('readonly');
    const editable: boolean[] = [];
    older.editor.registerEditableListener(value => {
      editable.push(value);
    });
    // A newer client records layout 2 (its first set-valued member does).
    Y.applyUpdate(older.doc, recordOnly(older.doc, 'lexical-y:2'));
    expect(older.binding.status).toBe('readonly');
    expect(editable).toEqual([]);
    expect(older.editor.isEditable()).toBe(false);
    // Warned once, when the gate closed.
    expect(codes(older)).toEqual([UNSUPPORTED_SCHEMA_WARNING]);
    const before = Y.encodeStateVector(older.doc);
    type(older, 'c');
    expect(Y.encodeStateVector(older.doc)).toEqual(before);
  });

  test('a newer record in a change whose read throws: the recovery gates', () => {
    const older = seeded(1, 'ab');
    const newer = client(2);
    sync(older, newer);
    newer.binding.initialize();
    type(newer, 'd');
    const proto = Reader.prototype as unknown as {
      $apply: (...args: unknown[]) => void;
    };
    const apply = proto.$apply;
    proto.$apply = function () {
      throw new Error('simulated reader failure');
    };
    try {
      Y.applyUpdate(
        older.doc,
        Y.encodeStateAsUpdate(newer.doc, Y.encodeStateVector(older.doc)),
      );
    } finally {
      proto.$apply = apply;
    }
    // Gated before the read; the recovery gates again (a no-op here).
    expect(codes(older)).toEqual([
      UNSUPPORTED_SCHEMA_WARNING,
      RECOVERED_READ_WARNING,
    ]);
    expect(older.binding.status).toBe('readonly');
    // Rebuilt from the document, with the newer client's edit.
    expect(text(older)).toBe('abd');
    const before = Y.encodeStateVector(older.doc);
    type(older, 'e');
    expect(Y.encodeStateVector(older.doc)).toEqual(before);
    expect(text(older)).toBe('abd');
  });
});

describe('schema version: headless', () => {
  const config = (schemaVersion: number): HeadlessYConfig => ({
    nodes: NODES,
    onWarn: () => {},
    schemaVersion,
    selfCheck: true,
  });
  const $append = (s: string) => () => {
    $getRoot().append($p(s));
  };
  const recordsOf = (state: Uint8Array) => {
    const doc = createYDoc(state);
    try {
      return records(doc);
    } finally {
      doc.destroy();
    }
  };

  test('seedYState and editYState record their versions', () => {
    const seed = seedYState(config(2), $append('a'));
    expect(recordsOf(seed)).toEqual([SCHEMA + '2']);
    // Equal: nothing new to record.
    const same = editYState(seed, config(2), $append('b'), {writer: null});
    expect(recordsOf(same.state)).toEqual([SCHEMA + '2']);
    // Higher: recorded with the edit, in its update.
    const higher = editYState(same.state, config(3), $append('c'), {
      writer: null,
    });
    expect(higher.update).not.toBeNull();
    expect(recordsOf(higher.state)).toEqual([SCHEMA + '2', SCHEMA + '3']);
    const onlyUpdate = createYDoc(same.state);
    Y.applyUpdate(onlyUpdate, higher.update!);
    expect(records(onlyUpdate)).toEqual([SCHEMA + '2', SCHEMA + '3']);
    onlyUpdate.destroy();
    // A no-op edit writes nothing, and records nothing.
    const noop = editYState(higher.state, config(4), () => {}, {
      writer: null,
    });
    expect(noop.update).toBeNull();
    expect(recordsOf(noop.state)).toEqual([SCHEMA + '2', SCHEMA + '3']);
  });

  test('an older editYState refuses with the warning and writes nothing', () => {
    const seed = seedYState(config(3), $append('a'));
    const warned: LexicalWarning[] = [];
    let ran = false;
    let thrown: unknown = null;
    try {
      editYState(
        seed,
        {...config(2), onWarn: w => warned.push(w)},
        () => {
          ran = true;
          $append('b')();
        },
        {writer: null},
      );
    } catch (error) {
      thrown = error;
    }
    expect(ran).toBe(false);
    expect(thrown).toBeInstanceOf(YHeadlessError);
    const error = thrown as YHeadlessError;
    expect(error.code).toBe('read-only');
    expect(error.warnings.map(w => [w.code, w.data])).toEqual([
      [UNSUPPORTED_SCHEMA_WARNING, {found: 3, reason: 'newer', supported: 2}],
    ]);
    expect(warned.map(w => w.code)).toEqual([UNSUPPORTED_SCHEMA_WARNING]);
    // As a client opens it: read only, also for reads.
    expect(() =>
      readYState(seed, config(2), () => $getRoot().getTextContent()),
    ).toThrow(YHeadlessError);
    expect(readYState(seed, config(3), () => $getRoot().getTextContent())).toBe(
      'a',
    );
  });
});

describe('schema version: required', () => {
  const FIX =
    "start at 1 and increase it whenever a node's stored fields or node types change";

  test('YCollabExtension throws without a doc, with the fix', () => {
    expect(() =>
      buildEditorFromExtensions(
        defineExtension({
          dependencies: [configExtension(YCollabExtension, {schemaVersion: 1})],
          name: 'test-doc-required',
        }),
      ),
    ).toThrow(
      'YCollabExtension needs a doc: pass doc: createYDoc() in its config, the document your provider syncs',
    );
  });

  test('YCollabExtension throws without schemaVersion, with the fix', () => {
    for (const schemaVersion of [undefined, 0, 1.5, -1, NaN]) {
      expect(() =>
        buildEditorFromExtensions(
          defineExtension({
            dependencies: [
              configExtension(
                YCollabExtension,
                (schemaVersion === undefined
                  ? {doc: createYDoc()}
                  : {doc: createYDoc(), schemaVersion}) as never,
              ),
            ],
            name: 'test-schema-required',
          }),
        ),
      ).toThrow(
        `YCollabExtension needs schemaVersion (got ${
          schemaVersion === undefined || schemaVersion === 0
            ? 'none'
            : schemaVersion
        }): ${FIX}`,
      );
    }
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          configExtension(YCollabExtension, {
            doc: createYDoc(),
            schemaVersion: 7,
            synced: true,
          }),
        ],
        name: 'test-schema-given',
      }),
    );
    expect(
      editor.getEditorState().read(() => $getRoot().getChildrenSize()),
    ).toBeGreaterThan(0);
    editor.dispose();
  });

  test('YBinding and the headless config throw without schemaVersion', () => {
    const editor = createEditor({nodes: NODES});
    // @ts-expect-error schemaVersion is required
    expect(() => new YBinding(editor, createYDoc())).toThrow(
      `YBinding needs options.schemaVersion (got undefined): ${FIX}`,
    );
    // @ts-expect-error schemaVersion is required
    expect(() => new YBinding(editor, createYDoc(), {selfCheck: true})).toThrow(
      FIX,
    );
    expect(
      () => new YBinding(editor, createYDoc(), {schemaVersion: 0}),
    ).toThrow(FIX);
    // @ts-expect-error schemaVersion is required
    const bare: HeadlessYConfig = {nodes: NODES};
    expect(() => seedYState(bare, () => {})).toThrow(
      `the config needs schemaVersion (got undefined): ${FIX}`,
    );
    expect(() => readYState(new Uint8Array(), bare, () => null)).toThrow(FIX);
  });
});

// Removing a field in a newer version: the newer client does not declare a
// field an older one wrote, and keeps it when it edits the node (#9504), so
// nothing an older version stored is lost.
const noteV1Schema = nodeSchema<NoteV1>()({
  label: withField(stringValue(), {field: '__label'}),
  tone: withField(stringValue(), {field: '__tone'}),
});
class NoteV1 extends ElementNode {
  __label: string = '';
  __tone: string = '';
  $config() {
    return this.config('test_schema_note', {
      extends: ElementNode,
      json: noteV1Schema,
    });
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}
const noteV2Schema = nodeSchema<NoteV2>()({
  label: withField(stringValue(), {field: '__label'}),
});
class NoteV2 extends ElementNode {
  __label: string = '';
  $config() {
    return this.config('test_schema_note', {
      extends: ElementNode,
      json: noteV2Schema,
    });
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}

test('a newer client keeps editing a field it no longer declares', () => {
  const v1 = client(1, {}, [NoteV1]);
  v1.editor.update(
    () => {
      const note = new NoteV1();
      note.__label = 'old';
      note.__tone = 'red';
      $getRoot()
        .clear()
        .append(note.append($p('x')));
    },
    {discrete: true},
  );
  v1.binding.initialize();
  const v2 = client(2, {}, [NoteV2]);
  sync(v1, v2);
  v2.binding.initialize();
  expect(v2.binding.status).toBe('active');
  v2.editor.update(
    () => {
      const note = $getRoot().getFirstChild() as NoteV2;
      note.getWritable().__label = 'new';
    },
    {discrete: true},
  );
  sync(v1, v2);
  expect(v1.binding.status).toBe('readonly');
  // What a reader that knows the field reads: the label changed, the tone
  // kept.
  const reader = client(2, {}, [NoteV1]);
  Y.applyUpdate(reader.doc, Y.encodeStateAsUpdate(v2.doc));
  reader.binding.initialize();
  expect(reader.binding.status).toBe('active');
  const [label, tone] = reader.editor.getEditorState().read(() => {
    const note = $getRoot().getFirstChild() as NoteV1;
    return [note.__label, note.__tone];
  });
  expect([label, tone]).toEqual(['new', 'red']);
});
