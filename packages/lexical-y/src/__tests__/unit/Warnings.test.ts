/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {LinkNode} from '@lexical/link';
import * as Y from '@y/y';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  $setState,
  createEditor,
  createState,
  type LexicalEditor,
  LexicalWarning,
} from 'lexical';
import {afterEach, describe, expect, test, vi} from 'vitest';

import {
  createYDoc,
  LAYOUT_VERSION,
  NESTED_FALLBACK_WARNING,
  RECOVERED_READ_WARNING,
  RECOVERED_WRITE_WARNING,
  SELF_CHECK_WARNING,
  STORAGE_MISMATCH_WARNING,
  UNKNOWN_NODE_TYPES_WARNING,
  UNSUPPORTED_LAYOUT_WARNING,
  UNSYNCED_VALUE_WARNING,
  YBinding,
  type YBindingOptions,
  type YBindingStatus,
} from '../..';
import {Reader} from '../../internal/Read';
import {Writer} from '../../internal/Write';
import {$createBoxNode, $p, BoxNode, NODES} from '../utils/harness';

// The self-check is forced to find a mismatch (`mismatch.on`): these tests
// are about where its findings go.
const mismatch = vi.hoisted(() => ({on: false}));
vi.mock('../../internal/SelfCheck', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../internal/SelfCheck')>();
  return {
    ...actual,
    $checkWrite: (...args: Parameters<typeof actual.$checkWrite>) =>
      mismatch.on ? ['forced mismatch'] : actual.$checkWrite(...args),
    checkContainer: (...args: Parameters<typeof actual.checkContainer>) =>
      mismatch.on ? ['forced mismatch'] : actual.checkContainer(...args),
  };
});

/** Run microtasks collected by a spy; the messages of those that throw. */
function rethrown(tasks: (() => void)[]): string[] {
  const out: string[] = [];
  for (const task of tasks.splice(0)) {
    try {
      task();
    } catch (e) {
      out.push((e as Error).message);
    }
  }
  return out;
}

type Seen = {
  warning: LexicalWarning;
  /** Whether a Yjs transaction (or its cleanup: observers) was running. */
  inTransaction: boolean;
  /** The editor's text when the warning arrived. */
  text: string;
};

/**
 * A client whose editor's onWarn records each warning (with what was going
 * on when it arrived); `onWarn` replaces that handler (null: Lexical's
 * default, which throws in development).
 */
function peer(
  clientID: number,
  options: YBindingOptions = {schemaVersion: 1, selfCheck: true},
  onWarn?: ((error: Error) => void) | null,
) {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = clientID;
  const seen: Seen[] = [];
  const editor: LexicalEditor = createEditor({
    namespace: 'w',
    nodes: NODES,
    onError: e => {
      throw e;
    },
    onWarn:
      onWarn === null
        ? undefined
        : onWarn ||
          (e => {
            expect(e).toBeInstanceOf(LexicalWarning);
            seen.push({
              inTransaction:
                doc._transaction !== null ||
                doc._transactionCleanups.length > 0,
              text: text(editor),
              warning: e as LexicalWarning,
            });
          }),
  });
  const binding = new YBinding(editor, doc, options);
  binding.start();
  const codes = () => seen.map(s => s.warning.code);
  return {binding, codes, doc, editor, seen};
}

const text = (editor: LexicalEditor) =>
  editor.getEditorState().read(() => $getRoot().getTextContent());

/** Two synced peers sharing `hello` (b reads what a initialized). */
function pair(
  options: YBindingOptions = {schemaVersion: 1, selfCheck: true},
  onWarn?: ((error: Error) => void) | null,
) {
  const a = peer(1, options, onWarn);
  a.editor.update(() => $getRoot().clear().append($p('hello')), {
    discrete: true,
  });
  a.binding.initialize();
  const b = peer(2, options, onWarn);
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  b.binding.initialize();
  a.doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'net') {
      Y.applyUpdate(b.doc, u, 'net');
    }
  });
  b.doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'net') {
      Y.applyUpdate(a.doc, u, 'net');
    }
  });
  return {a, b};
}

const $typeAtEnd = (s: string) => {
  const p = $getRoot().getFirstChild();
  if ($isElementNode(p)) {
    p.append($createTextNode(s));
  }
};

const env = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = env;
  mismatch.on = false;
});

describe('@lexical/y warnings', () => {
  test('a local self-check mismatch goes to the editor onWarn as a LexicalWarning', () => {
    const {a, b} = pair();
    mismatch.on = true;
    expect(() =>
      a.editor.update(() => $typeAtEnd(' there'), {discrete: true}),
    ).not.toThrow();
    mismatch.on = false;
    expect(a.codes()).toEqual([SELF_CHECK_WARNING]);
    expect(a.codes()).toEqual(['@lexical/y/self-check']);
    const {warning} = a.seen[0];
    expect(warning.message).toContain('forced mismatch');
    expect(warning.data).toEqual({
      problems: ['forced mismatch'],
      reason: 'local',
    });
    expect(a.seen[0].inTransaction).toBe(false);
    expect(b.seen).toEqual([]);
  });

  test('a remote self-check mismatch is reported after the change is applied, and the container is read again', () => {
    const {a, b} = pair();
    // A structural change: the remote check compares whole containers.
    mismatch.on = true;
    expect(() =>
      a.editor.update(() => $getRoot().append($p('there')), {discrete: true}),
    ).not.toThrow();
    mismatch.on = false;
    const remote = b.seen.find(s => s.warning.code === SELF_CHECK_WARNING)!;
    expect(remote.warning.message).toContain('(remote)');
    expect(remote.warning.data).toMatchObject({reason: 'remote'});
    // Not from inside Yjs, and the remote change is already in the editor.
    expect(remote.inTransaction).toBe(false);
    expect(remote.text).toBe('hello\n\nthere');
    expect(text(b.editor)).toBe('hello\n\nthere');
  });

  test('the self-check is off unless enabled, in development and production', () => {
    for (const nodeEnv of ['development', 'production']) {
      process.env.NODE_ENV = nodeEnv;
      for (const selfCheck of [undefined, false, true]) {
        const {a, b} = pair({schemaVersion: 1, selfCheck});
        mismatch.on = true;
        a.editor.update(() => $typeAtEnd(' there'), {discrete: true});
        a.editor.update(() => $getRoot().append($p('more')), {
          discrete: true,
        });
        mismatch.on = false;
        expect([...a.codes(), ...b.codes()].length > 0).toBe(
          selfCheck === true,
        );
      }
    }
  });

  test('read only, recovery: each warning has its code and data', () => {
    // A newer layout.
    const newer = new Y.Doc();
    newer.get('lexical-y').setAttr('lexical-y:99', true);
    const n = peer(3);
    Y.applyUpdate(n.doc, Y.encodeStateAsUpdate(newer));
    expect(n.binding.status).toBe('readonly');
    expect(n.codes()).toEqual([UNSUPPORTED_LAYOUT_WARNING]);
    expect(n.seen[0].warning.data).toEqual({
      found: 99,
      reason: 'newer',
      supported: LAYOUT_VERSION,
    });
    expect(n.seen[0].inTransaction).toBe(false);

    // A remote read that throws.
    const {a, b} = pair();
    const proto = Reader.prototype as unknown as {
      $apply: (...args: unknown[]) => void;
    };
    const apply = proto.$apply;
    proto.$apply = function () {
      throw new Error('simulated reader failure');
    };
    try {
      a.editor.update(() => $typeAtEnd(' there'), {discrete: true});
    } finally {
      proto.$apply = apply;
    }
    expect(b.codes()).toEqual([RECOVERED_READ_WARNING]);
    expect(b.seen[0].warning.data).toMatchObject({reason: 'remote-change'});
    expect((b.seen[0].warning.data as {error: Error}).error.message).toBe(
      'simulated reader failure',
    );
    // Reported once the editor was rebuilt.
    expect(b.seen[0].text).toBe('hello there');
    expect(text(b.editor)).toBe('hello there');

    // A local write that throws.
    const wproto = Writer.prototype as unknown as {$run: () => void};
    const run = wproto.$run;
    let calls = 0;
    wproto.$run = function (this: Writer) {
      if (++calls === 1) {
        throw new Error('simulated writer failure');
      }
      return run.call(this);
    };
    try {
      a.editor.update(() => $typeAtEnd('!'), {discrete: true});
    } finally {
      wproto.$run = run;
    }
    expect(a.codes()).toEqual([RECOVERED_WRITE_WARNING]);
    expect(a.seen[0].warning.data).toMatchObject({reason: 'local-change'});
    expect((a.seen[0].warning.data as {error: Error}).error.message).toBe(
      'simulated writer failure',
    );
    expect(text(b.editor)).toBe('hello there!');
  });

  for (const handler of ['a throwing onWarn', "Lexical's default onWarn"]) {
    test(`${handler} does not break syncing`, () => {
      // The handler's error is rethrown in a microtask (outside Yjs and the
      // provider): collected here instead.
      const later: (() => void)[] = [];
      const microtask = vi
        .spyOn(globalThis, 'queueMicrotask')
        .mockImplementation(fn => later.push(fn));
      try {
        const onWarn =
          handler === 'a throwing onWarn'
            ? (e: Error) => {
                throw new Error('handler failure: ' + e.message);
              }
            : null;
        const {a, b} = pair({schemaVersion: 1, selfCheck: true}, onWarn);
        // Both sides find a mismatch: a local one on a, a remote one on b
        // (which b reports after reading the change in full).
        mismatch.on = true;
        expect(() =>
          a.editor.update(() => $getRoot().append($p('one')), {
            discrete: true,
          }),
        ).not.toThrow();
        mismatch.on = false;
        // Lexical schedules with microtasks too: the ones that throw are
        // the handler's errors, one per warning (a's local, b's remote).
        const errors = rethrown(later);
        expect(errors.length).toBe(2);
        for (const message of errors) {
          expect(message).toMatch(
            handler === 'a throwing onWarn'
              ? /^handler failure: self-check/
              : /^self-check/,
          );
        }
        // Syncing goes on, both ways.
        expect(text(b.editor)).toBe('hello\n\none');
        a.editor.update(() => $typeAtEnd(' two'), {discrete: true});
        b.editor.update(() => $getRoot().append($p('three')), {
          discrete: true,
        });
        expect(text(a.editor)).toBe('hello two\n\none\n\nthree');
        expect(text(b.editor)).toBe(text(a.editor));
        expect(a.binding.status).toBe('active');
        expect(b.binding.status).toBe('active');
        // A read-only warning from a throwing handler still leaves the
        // binding read only.
        const newer = new Y.Doc();
        newer.get('lexical-y').setAttr('lexical-y:99', true);
        const n = peer(3, {schemaVersion: 1}, onWarn);
        expect(() =>
          Y.applyUpdate(n.doc, Y.encodeStateAsUpdate(newer)),
        ).not.toThrow();
        expect(n.binding.status).toBe('readonly');
        expect(rethrown(later)).toEqual([
          expect.stringContaining('layout 99 is newer'),
        ]);
      } finally {
        microtask.mockRestore();
      }
    });
  }

  test('a handler that edits the editor sees the binding consistent', () => {
    let edited = false;
    const {a, b} = pair({schemaVersion: 1, selfCheck: true}, () => {
      if (!edited) {
        edited = true;
        b.editor.update(() => $getRoot().append($p('from the handler')), {
          discrete: true,
        });
      }
    });
    mismatch.on = true;
    a.editor.update(() => $getRoot().append($p('one')), {discrete: true});
    mismatch.on = false;
    expect(edited).toBe(true);
    expect(text(a.editor)).toBe(text(b.editor));
    expect(text(a.editor)).toContain('from the handler');
  });

  test('public fields are read only', () => {
    const {a} = pair();
    expect(a.binding.status).toBe('active');
    expect(() => {
      (a.binding as unknown as {status: string}).status = 'readonly';
    }).toThrow();
    expect(() => {
      (a.binding as unknown as {undoManager: null}).undoManager = null;
    }).toThrow();
    expect(a.binding.status).toBe('active');
    expect(a.binding.undoManager).not.toBe(null);
    expect([...a.binding.pins.keys()]).toContain('paragraph');
  });
});

/** A NodeState whose values are kept as they are (a Date is not JSON). */
const whenState = createState('when', {parse: v => v as unknown});

/** A link class that decides its merges itself: stored as a node. */
class OwnMergeLink extends LinkNode {
  static getType() {
    return 'test_own_merge_link';
  }
  static clone(node: OwnMergeLink) {
    return new OwnMergeLink(node.__url, {}, node.__key);
  }
  shouldMergeAdjacentLink() {
    return false;
  }
}

describe('@lexical/y warnings: every code and its data', () => {
  test('a document stored without a version, or with an older layout root', () => {
    // Content and no version.
    const src = peer(5);
    src.editor.update(() => $getRoot().clear().append($p('hello')), {
      discrete: true,
    });
    src.binding.initialize();
    const stripped = new Y.Doc();
    Y.applyUpdate(stripped, Y.encodeStateAsUpdate(src.doc));
    stripped.get('lexical-y').deleteAttr('lexical-y:1');
    const noVersion = peer(6);
    Y.applyUpdate(noVersion.doc, Y.encodeStateAsUpdate(stripped));
    noVersion.binding.initialize();
    expect(noVersion.binding.status).toBe('readonly');
    expect(noVersion.codes()).toEqual([UNSUPPORTED_LAYOUT_WARNING]);
    expect(noVersion.seen[0].warning.data).toEqual({
      reason: 'missing',
      supported: LAYOUT_VERSION,
    });

    // An older layout's root with content.
    const legacy = peer(7);
    legacy.doc.get('root-v2').insert(0, [new Y.Node('paragraph')]);
    legacy.binding.initialize();
    expect(legacy.binding.status).toBe('readonly');
    expect(legacy.codes()).toEqual([UNSUPPORTED_LAYOUT_WARNING]);
    expect(legacy.seen[0].warning.data).toEqual({
      reason: 'legacy-roots',
      roots: ['root-v2'],
      supported: LAYOUT_VERSION,
    });
  });

  test('unknown node types and storage mismatches name the types', () => {
    const doc = createYDoc();
    const writer = new YBinding(
      createEditor({
        namespace: 'w',
        nodes: NODES,
        onError: e => {
          throw e;
        },
      }),
      doc,
      {schemaVersion: 1},
    );
    writer.start();
    writer.editor.update(
      () =>
        $getRoot()
          .clear()
          .append($createBoxNode('t').append($p('in'))),
      {discrete: true},
    );
    writer.initialize();

    // A client that does not register the box class.
    const seen: LexicalWarning[] = [];
    const reader = new YBinding(
      createEditor({
        namespace: 'r',
        nodes: NODES.filter(k => k !== BoxNode),
        onError: e => {
          throw e;
        },
        onWarn: e => seen.push(e as LexicalWarning),
      }),
      createYDoc(),
      {schemaVersion: 1},
    );
    reader.start();
    Y.applyUpdate(reader.doc, Y.encodeStateAsUpdate(doc));
    reader.initialize();
    expect(reader.status).toBe('readonly');
    expect(seen.map(w => [w.code, w.data])).toEqual([
      [
        UNKNOWN_NODE_TYPES_WARNING,
        {reason: 'unregistered', types: ['test_box']},
      ],
    ]);

    // A pin this editor cannot store its class as, and a malformed pin.
    for (const [pin, value, data] of [
      [
        'k:paragraph',
        'group',
        {
          declared: {kind: 'line'},
          reason: 'declaration-changed',
          stored: {kind: 'group'},
          type: 'paragraph',
        },
      ],
      [
        'k:paragraph',
        7,
        {found: 7, key: 'k:paragraph', reason: 'malformed', type: 'paragraph'},
      ],
    ] as const) {
      const bad = new Y.Doc();
      Y.applyUpdate(bad, Y.encodeStateAsUpdate(doc));
      bad.get('lexical-y').setAttr(pin, value as never);
      const p = peer(8);
      Y.applyUpdate(p.doc, Y.encodeStateAsUpdate(bad));
      p.binding.initialize();
      expect(p.binding.status).toBe('readonly');
      expect(p.codes()).toEqual([STORAGE_MISMATCH_WARNING]);
      expect(p.seen[0].warning.data).toEqual(data);
      // Nothing written: the malformed pin is not overwritten either.
      p.editor.update(() => $getRoot().append($p('local')), {discrete: true});
      expect(p.doc.get('lexical-y').getAttr(pin)).toBe(value);
    }
  });

  test('a class stored as a node and a value that is not JSON: each binding reports each once', () => {
    const reports: [string, unknown][][] = [];
    for (let i = 0; i < 2; i++) {
      const seen: [string, unknown][] = [];
      reports.push(seen);
      const editor = createEditor({
        namespace: 'v' + i,
        nodes: [...NODES, OwnMergeLink],
        onError: e => {
          throw e;
        },
        onWarn: e => {
          seen.push([(e as LexicalWarning).code, (e as LexicalWarning).data]);
        },
      });
      const binding = new YBinding(editor, createYDoc(), {schemaVersion: 1});
      binding.start();
      for (let edit = 0; edit < 2; edit++) {
        editor.update(
          () => {
            const p = $p('x' + edit);
            $setState(p, whenState, new Date(0));
            $getRoot().append(p);
          },
          {discrete: true},
        );
        binding.initialize();
      }
    }
    for (const seen of reports) {
      expect(seen).toEqual([
        [
          NESTED_FALLBACK_WARNING,
          {
            method: 'shouldMergeAdjacentLink',
            reason: 'merge-override',
            type: 'test_own_merge_link',
          },
        ],
        [
          UNSYNCED_VALUE_WARNING,
          {property: 'NodeState when', reason: 'not-json'},
        ],
      ]);
    }
  });
});

describe('@lexical/y options', () => {
  test('captureTimeout: null turns collaborative undo off', () => {
    const {a} = pair({captureTimeout: null, schemaVersion: 1});
    expect(a.binding.undoManager).toBe(null);
    a.editor.update(() => $typeAtEnd(' there'), {discrete: true});
    expect(a.binding.undo()).toBe(false);
    expect(text(a.editor)).toBe('hello there');
  });

  test('onStatus reports each change once Yjs is idle', () => {
    const calls: [YBindingStatus, boolean][] = [];
    const a = peer(1, {
      onStatus: status => {
        calls.push([
          status,
          a.doc._transaction !== null || a.doc._transactionCleanups.length > 0,
        ]);
      },
      schemaVersion: 1,
    });
    expect(calls).toEqual([]);
    a.editor.update(() => $getRoot().clear().append($p('hello')), {
      discrete: true,
    });
    a.binding.initialize();
    expect(calls).toEqual([['active', false]]);
    // A peer moves the document to a newer layout: read only, reported
    // after the remote transaction.
    const newer = new Y.Doc();
    Y.applyUpdate(newer, Y.encodeStateAsUpdate(a.doc));
    newer.get('lexical-y').setAttr('lexical-y:99', true);
    Y.applyUpdate(
      a.doc,
      Y.encodeStateAsUpdate(newer, Y.encodeStateVector(a.doc)),
    );
    expect(calls).toEqual([
      ['active', false],
      ['readonly', false],
    ]);
    expect(a.binding.status).toBe('readonly');
  });

  test('undo and redo write nothing once the binding is read only', () => {
    const {a, b} = pair();
    a.editor.update(() => $typeAtEnd(' there'), {discrete: true});
    b.doc.transact(() => b.doc.get('lexical-y').setAttr('lexical-y:99', true));
    expect(a.binding.status).toBe('readonly');
    const before = Y.encodeStateVector(a.doc);
    expect(a.binding.undo()).toBe(false);
    expect(a.binding.redo()).toBe(false);
    expect(Y.encodeStateVector(a.doc)).toEqual(before);
    expect(text(b.editor)).toBe('hello there');
  });

  for (const sample of [0, 1]) {
    test(`selfCheckSample ${sample} samples local and remote checks`, () => {
      const {a, b} = pair({
        schemaVersion: 1,
        selfCheck: true,
        selfCheckSample: sample,
      });
      // A structural change: both sides check.
      mismatch.on = true;
      a.editor.update(() => $getRoot().append($p('there')), {discrete: true});
      mismatch.on = false;
      const local = a.seen.filter(
        s => s.warning.code === SELF_CHECK_WARNING,
      ).length;
      const remote = b.seen.filter(
        s => s.warning.code === SELF_CHECK_WARNING,
      ).length;
      expect([local, remote]).toEqual(sample === 0 ? [0, 0] : [1, 1]);
      expect(text(b.editor)).toBe('hello\n\nthere');
    });
  }
});
