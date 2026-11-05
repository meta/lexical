/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Writes are admitted against the root's layout record as it is when they
// happen, not as the binding last read it (ported from the identity
// project's review round 10). Inside an app transaction that makes the
// record older than the floor, newer than the binding, missing or
// malformed, the binding writes nothing: not an editor update, not its own
// undo or redo, and not an undo or redo through its exposed UndoManager;
// headless edits inside `transact` likewise. Once the transaction ends the
// binding reads the record and is read only for that cause; a record put
// back makes it active again. The floor is FLOOR (raised with the internal
// override where MIN_LAYOUT is 1).

import {buildEditorFromExtensions} from '@lexical/extension';
import {$addMarkID} from '@lexical/mark';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getEditor,
  $getRoot,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {
  createYDoc,
  LAYOUT_VERSION,
  UNSUPPORTED_EDIT_WARNING,
  UNSUPPORTED_LAYOUT_WARNING,
  YBinding,
  type YDoc,
} from '../../..';
import {editYState, seedYState} from '../../../headless';
import {setMinLayoutForTests} from '../../../internal/Binding';
import {catalogAppExtension, catalogHeadlessConfig} from '../../catalog/bind';
import {admitted, FLOOR} from '../../utils/migrateSteps';

const CFG = {blockIds: 'absent', marks: 'mark-state'} as const;
const ROOT = 'lexical-y';

type Cause = 'older' | 'newer' | 'missing' | 'malformed';
const CAUSES: readonly Cause[] = ['older', 'newer', 'missing', 'malformed'];

/** Make `root`'s layout record show `cause` (inside the caller's transaction). */
function spoil(root: Y.Node, cause: Cause): void {
  const records = Object.keys(root.getAttrs()).filter(k =>
    k.startsWith('lexical-y:'),
  );
  if (cause === 'older') {
    root.setAttr(`lexical-y:${FLOOR - 1}`, true);
    for (const key of records) {
      if (Number(key.slice('lexical-y:'.length)) >= FLOOR) {
        root.deleteAttr(key);
      }
    }
  } else if (cause === 'newer') {
    root.setAttr(`lexical-y:${LAYOUT_VERSION + 1}`, true);
  } else if (cause === 'missing') {
    for (const key of records) {
      root.deleteAttr(key);
    }
  } else {
    root.setAttr('lexical-y:x', true);
  }
}

/** Put `root`'s record back to FLOOR (a remote fix). */
function repair(root: Y.Node): void {
  for (const key of Object.keys(root.getAttrs())) {
    if (key.startsWith('lexical-y:')) {
      root.deleteAttr(key);
    }
  }
  root.setAttr(`lexical-y:${FLOOR}`, true);
}

/** Every live text under `node`, in document order. */
function text(node: Y.Node): string {
  let out = '';
  for (let it = node._start; it !== null; it = it.right) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof Y.ContentString) {
      out += it.content.str;
    } else if (it.content instanceof Y.ContentType) {
      out += text(it.content.type as Y.Node);
    }
  }
  return out;
}

/** A comment on the first text: a member entry (layout 2 where seeds are 1). */
function $commented(): void {
  const t = $createTextNode('abcd');
  $getRoot().clear().append($createParagraphNode().append(t));
  const s = $createRangeSelection();
  s.anchor.set(t.getKey(), 1, 'text');
  s.focus.set(t.getKey(), 3, 'text');
  $addMarkID('c1', s);
}

function editorOf(warnings: string[], messages: string[]): LexicalEditor {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(CFG)],
      name: 'history-gate',
      onError: e => {
        throw e;
      },
      onWarn: w => {
        warnings.push(String((w as {data?: {reason?: string}}).data?.reason));
        messages.push(w.message);
      },
    }),
  );
}

/**
 * A binding of a document at FLOOR, possibly nested in another shared
 * type, that wrote `local` in its own undo step.
 */
function setup(
  gc: boolean,
  nested: boolean,
): {
  doc: YDoc;
  root: Y.Node;
  editor: LexicalEditor;
  binding: YBinding;
  warnings: string[];
  messages: string[];
} {
  const doc = createYDoc(null, {gc});
  doc.clientID = 7;
  let root: Y.Node = doc.get(ROOT);
  if (nested) {
    const holder = doc.get('app');
    root = new Y.Node('editor-root');
    holder.setAttr('editor', root);
  }
  const warnings: string[] = [];
  const messages: string[] = [];
  const editor = editorOf(warnings, messages);
  editor.update($commented, {discrete: true});
  const binding = new YBinding(editor, doc, {
    captureTimeout: 0,
    root: nested ? root : undefined,
    schemaVersion: 1,
  });
  binding.start();
  binding.initialize();
  // At FLOOR: a seed with a member entry records it where seeds are 1.
  if (root.getAttr(`lexical-y:${FLOOR}`) !== true) {
    root.setAttr(`lexical-y:${FLOOR}`, true);
  }
  setMinLayoutForTests(FLOOR);
  binding.undoManager!.clear();
  editor.update(
    () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('local')),
      );
    },
    {discrete: true},
  );
  binding.undoManager!.stopCapturing();
  return {binding, doc, editor, messages, root, warnings};
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => {
  setMinLayoutForTests(null);
});

describe.each([false, true])('writes are admitted at write time, gc %s', gc => {
  for (const nested of [false, true]) {
    for (const cause of CAUSES) {
      const where = nested ? 'a nested root' : 'the root';
      for (const method of [
        'binding undo',
        'binding redo',
        'manager undo',
        'manager redo',
        'editor write',
      ] as const) {
        test(`${where}, record ${cause} inside an app transaction: ${method} writes nothing`, async () => {
          const t = setup(gc, nested);
          expect(t.binding.status).toBe('active');
          if (method.endsWith('redo')) {
            expect(t.binding.undo()).toBe(true);
          }
          const manager = t.binding.undoManager!;
          let before = '';
          let after = '';
          let result: unknown = 'none';
          t.doc.transact(() => {
            spoil(t.root, cause);
            before = text(t.root);
            if (method === 'binding undo') {
              result = t.binding.undo();
            } else if (method === 'binding redo') {
              result = t.binding.redo();
            } else if (method === 'manager undo') {
              result = manager.undo();
            } else if (method === 'manager redo') {
              result = manager.redo();
            } else {
              t.editor.update(
                () => {
                  $getRoot().append(
                    $createParagraphNode().append($createTextNode('forbidden')),
                  );
                },
                {discrete: true},
              );
            }
            after = text(t.root);
          }, 'app');
          await flush();
          expect(after).toBe(before);
          expect(text(t.root)).toBe(before);
          if (method !== 'editor write') {
            expect(result === false || result === null).toBe(true);
          }
          // Read only for that cause now, unless the record admits writes
          // again (a build may put the seed's record back itself).
          expect(t.binding.status).toBe(
            admitted(t.root) ? 'active' : 'readonly',
          );
          // A record put back: active, and it writes again.
          t.doc.transact(() => repair(t.root), 'remote');
          await flush();
          expect(t.binding.status).toBe('active');
          const restored = text(t.root);
          t.editor.update(
            () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('again')),
              );
            },
            {discrete: true},
          );
          expect(text(t.root)).toBe(restored + 'again');
          t.binding.dispose();
        });
      }
    }
  }

  test.each(CAUSES)(
    'an undo queued inside an editor update runs after the record turns %s: it writes nothing',
    async cause => {
      const t = setup(gc, false);
      const before = text(t.root);
      let queued: boolean | null = null;
      t.doc.transact(() => {
        t.editor.update(
          () => {
            // Queued as the next update (the editor is updating), admitted
            // when it runs.
            queued = t.binding.undo();
            spoil(t.root, cause);
          },
          {discrete: true},
        );
      }, 'app');
      await flush();
      expect(queued).toBe(true);
      expect(text(t.root)).toBe(before);
      expect(t.binding.status).toBe(admitted(t.root) ? 'active' : 'readonly');
      t.binding.dispose();
    },
  );

  test.each(CAUSES)(
    'an editor write refused inside an app transaction that makes the record %s: the cause is reported before the refusal',
    async cause => {
      const t = setup(gc, false);
      t.warnings.length = 0;
      t.doc.transact(() => {
        spoil(t.root, cause);
        t.editor.update(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('forbidden')),
            );
          },
          {discrete: true},
        );
      }, 'app');
      await flush();
      const refusal = t.warnings.indexOf('read-only');
      expect(refusal).toBeGreaterThanOrEqual(0);
      // Unless a build put the record back itself (then nothing is read
      // only and there is no cause to report).
      if (!admitted(t.root)) {
        expect(t.warnings.slice(0, refusal)).toContain(cause);
      }
      t.binding.dispose();
    },
  );

  test.each(CAUSES)(
    'an app transaction that makes the record %s around an editor write and puts it back: refused, active, a warning naming the record and no earlier cause',
    async cause => {
      const t = setup(gc, false);
      const before = text(t.root);
      t.warnings.length = 0;
      t.messages.length = 0;
      t.doc.transact(() => {
        spoil(t.root, cause);
        t.editor.update(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('forbidden')),
            );
          },
          {discrete: true},
        );
        repair(t.root);
      }, 'app');
      await flush();
      expect(text(t.root)).toBe(before);
      // The refused edit is read back: the editor no longer shows it.
      expect(
        t.editor.getEditorState().read(() => $getRoot().getTextContent()),
      ).not.toContain('forbidden');
      expect(t.binding.status).toBe('active');
      // The app's transaction wrote the record raw: reported as such in
      // development, besides the refusal.
      expect(t.warnings.filter(w => w !== 'raw-write')).toEqual(['read-only']);
      expect(t.warnings).toContain('raw-write');
      expect(t.messages.join('\n')).toMatch(
        /not written: when it was written, the document's layout or schema record \(changed in the same transaction, by the app or by an update a provider applied\) was missing, malformed or one this version does not write\. It is not retried/,
      );
      expect(t.messages.join('\n')).not.toMatch(/an earlier warning/);
      t.binding.dispose();
    },
  );

  test('outside such a transaction, history and the exposed UndoManager work as before', () => {
    const t = setup(gc, false);
    const manager = t.binding.undoManager!;
    const all = text(t.root);
    expect(manager.undo()).not.toBeNull();
    expect(text(t.root)).not.toBe(all);
    expect(manager.redo()).not.toBeNull();
    expect(text(t.root)).toBe(all);
    expect(t.binding.undo()).toBe(true);
    expect(t.binding.redo()).toBe(true);
    expect(text(t.root)).toBe(all);
    t.binding.dispose();
  });

  test.each(CAUSES)(
    'a headless edit inside transact after the record turns %s is refused',
    cause => {
      const config = catalogHeadlessConfig(CFG);
      const seeded = seedYState(config, () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('abc')),
        );
      });
      const copy = createYDoc(seeded, {gc});
      repair(copy.get(ROOT));
      const base = Y.encodeStateAsUpdate(copy);
      copy.destroy();
      setMinLayoutForTests(FLOOR);
      let editor: LexicalEditor | undefined;
      const result = editYState(
        base,
        config,
        () => {
          editor = $getEditor();
        },
        {
          transact: doc => {
            spoil(doc.get(ROOT), cause);
            editor!.update(
              () => {
                $getRoot().append(
                  $createParagraphNode().append($createTextNode('forbidden')),
                );
              },
              {discrete: true},
            );
          },
          writer: null,
        },
      );
      // Refused as on a read-only binding: the refusal, after its cause.
      const codes = result.warnings.map(
        w =>
          `${w.code}:${String((w.data as {reason?: unknown} | undefined)?.reason)}`,
      );
      const refusal = codes.indexOf(`${UNSUPPORTED_EDIT_WARNING}:read-only`);
      const why = codes.findIndex(c =>
        c.startsWith(`${UNSUPPORTED_LAYOUT_WARNING}:`),
      );
      expect(refusal).toBeGreaterThanOrEqual(0);
      const out = createYDoc(result.state, {gc});
      if (!admitted(out.get(ROOT))) {
        expect(why).toBeGreaterThanOrEqual(0);
        expect(why).toBeLessThan(refusal);
      }
      expect(text(out.get(ROOT))).toBe('abc');
      out.destroy();
    },
  );
});
