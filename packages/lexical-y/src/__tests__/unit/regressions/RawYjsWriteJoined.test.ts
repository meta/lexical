/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The binding's own writes inside an app's transaction are not raw writes.
// An editor edit, initialize() or binding.undo()/redo() made inside
// `doc.transact(fn, appOrigin)` joins the app's transaction, so it carries
// the app's origin: the raw-write diagnostic (development builds) must not
// report it (with Lexical's default onWarn, a report is an uncaught error
// for usage the write-time gate supports). Every warning here throws. A raw
// write by the app in a transaction of its own is still reported.

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, RAW_YJS_WRITE_WARNING, YBinding} from '../../..';
import {catalogAppExtension} from '../../catalog/bind';
import {rawDoc, SEED} from '../../utils/migrateSteps';
import {textOf} from '../../utils/splitFixtures';

const CFG = {blockIds: 'absent'} as const;

class AppOrigin {}

function bind(
  gc: boolean,
  state: Uint8Array | null = rawDoc(SEED),
  strict = true,
) {
  const doc = createYDoc(state, {gc});
  const warnings: unknown[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(CFG)],
      name: 'raw-writes-joined',
      onError: e => {
        throw e;
      },
      // Strict: any warning fails the test (rethrown, it is unhandled).
      onWarn: w => {
        warnings.push(w);
        if (strict) {
          throw w;
        }
      },
    }),
  );
  const binding = new YBinding(editor, doc, {
    captureTimeout: 0,
    schemaVersion: 1,
  });
  binding.start();
  const append = (s: string) =>
    editor.update(
      () => {
        $getRoot().append($createParagraphNode().append($createTextNode(s)));
      },
      {discrete: true},
    );
  const dispose = () => {
    binding.dispose();
    editor.dispose();
    doc.destroy();
  };
  const root = doc.get('lexical-y');
  return {append, binding, dispose, doc, editor, root, warnings};
}

describe.each([false, true])(
  'binding writes inside an app transaction, gc %s',
  gc => {
    test('an editor edit inside doc.transact(fn, appOrigin): stored, active, no warning', () => {
      const t = bind(gc);
      t.binding.initialize();
      expect(t.binding.status).toBe('active');
      t.doc.transact(() => {
        t.append('inside');
      }, new AppOrigin());
      expect(textOf(t.root)).toContain('inside');
      expect(t.binding.status).toBe('active');
      expect(t.warnings).toEqual([]);
      t.dispose();
    });

    test('initialize() inside doc.transact(fn, appOrigin): seeded, active, no warning', () => {
      const t = bind(gc, null);
      t.editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('seed')));
        },
        {discrete: true},
      );
      t.doc.transact(() => {
        t.binding.initialize();
      }, new AppOrigin());
      expect(t.binding.status).toBe('active');
      expect(textOf(t.root)).toContain('seed');
      expect(t.warnings).toEqual([]);
      t.dispose();
    });

    test('binding.undo() and redo() inside doc.transact(fn, appOrigin): applied, no warning', () => {
      const t = bind(gc);
      t.binding.initialize();
      const app = new AppOrigin();
      t.append('undone');
      expect(textOf(t.root)).toContain('undone');
      t.doc.transact(() => {
        expect(t.binding.undo()).toBe(true);
      }, app);
      expect(textOf(t.root)).not.toContain('undone');
      // A redo inside one too, from an undo made outside (Yjs records an
      // undo nested in a foreign transaction on no redo stack).
      t.append('redone');
      expect(t.binding.undo()).toBe(true);
      expect(textOf(t.root)).not.toContain('redone');
      t.doc.transact(() => {
        expect(t.binding.redo()).toBe(true);
      }, app);
      expect(textOf(t.root)).toContain('redone');
      expect(t.binding.status).toBe('active');
      expect(t.warnings).toEqual([]);
      t.dispose();
    });

    test('control: a raw write by the app in its own transaction is still reported', () => {
      const t = bind(gc, rawDoc(SEED), false);
      t.binding.initialize();
      t.doc.transact(() => {
        t.root.insert(0, 'raw');
      }, new AppOrigin());
      expect(t.warnings).toHaveLength(1);
      expect(t.warnings[0]).toMatchObject({
        code: RAW_YJS_WRITE_WARNING,
        data: {kind: 'content', origin: 'AppOrigin', reason: 'raw-write'},
      });
      t.dispose();
    });
  },
);
