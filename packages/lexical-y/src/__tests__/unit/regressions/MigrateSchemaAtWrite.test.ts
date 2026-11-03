/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The schema gate (D08) is checked inside each binding-authored write
// transaction too (code review round 3, M3): an app's beforeTransaction
// listener that records a newer (or a malformed) schema version at the
// write's start gets nothing written, by an editor update (main stored it),
// initialization, or an undo; the binding then reads the record and is read
// only with the schema warning. A schema record the binding already read
// keeps its existing gate (the local updates made before it are written).

import {buildEditorFromExtensions} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

import {createYDoc, UNSUPPORTED_SCHEMA_WARNING, YBinding} from '../../..';
import {Writer} from '../../../internal/Write';
import {catalogAppExtension} from '../../catalog/bind';
import {rawDoc, SEED} from '../../utils/migrateSteps';
import {textOf} from '../../utils/splitFixtures';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function editorOf(errors: Error[], warnings: string[]) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension({blockIds: 'absent'})],
      name: 'schema-at-write',
      onError: e => {
        errors.push(e);
      },
      onWarn: w => {
        warnings.push((w as {code?: string}).code ?? '');
      },
    }),
  );
}

function append(editor: LexicalEditor, s: string): void {
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode(s)));
    },
    {discrete: true},
  );
}

function onNextTransaction(doc: Y.Doc, fn: () => void): void {
  let done = false;
  doc.on('beforeTransaction', () => {
    if (!done) {
      done = true;
      fn();
    }
  });
}

const SPOIL = {
  malformed: (root: Y.Node) => root.setAttr('lexical-y-schema:x', true),
  newer: (root: Y.Node) => root.setAttr('lexical-y-schema:2', true),
} as const;

describe.each([false, true])('schema admission at write time, gc %s', gc => {
  for (const [cause, spoil] of Object.entries(SPOIL)) {
    test(`an editor write: a listener recording a ${cause} schema at its start: nothing written, read only`, async () => {
      const doc = createYDoc(rawDoc(SEED), {gc});
      const errors: Error[] = [];
      const warnings: string[] = [];
      const editor = editorOf(errors, warnings);
      const binding = new YBinding(editor, doc, {schemaVersion: 1});
      binding.start();
      binding.initialize();
      const before = textOf(doc.get('lexical-y'));
      onNextTransaction(doc, () => spoil(doc.get('lexical-y')));
      append(editor, 'forbidden');
      await flush();
      expect(textOf(doc.get('lexical-y'))).toBe(before);
      expect(binding.status).toBe('readonly');
      expect(warnings).toContain(UNSUPPORTED_SCHEMA_WARNING);
      expect(errors).toEqual([]);
      binding.dispose();
      editor.dispose();
      doc.destroy();
    });

    test(`initialization: a listener recording a ${cause} schema at the seed's start: nothing seeded`, async () => {
      const doc = createYDoc(null, {gc});
      const errors: Error[] = [];
      const warnings: string[] = [];
      const editor = editorOf(errors, warnings);
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('SEED')));
        },
        {discrete: true},
      );
      const binding = new YBinding(editor, doc, {schemaVersion: 1});
      binding.start();
      onNextTransaction(doc, () => spoil(doc.get('lexical-y')));
      binding.initialize();
      await flush();
      expect(textOf(doc.get('lexical-y'))).not.toContain('SEED');
      expect(binding.status).not.toBe('active');
      binding.dispose();
      editor.dispose();
      doc.destroy();
    });

    test(`an undo: a listener recording a ${cause} schema at its start: nothing written`, async () => {
      const doc = createYDoc(rawDoc(SEED), {gc});
      const errors: Error[] = [];
      const warnings: string[] = [];
      const editor = editorOf(errors, warnings);
      const binding = new YBinding(editor, doc, {
        captureTimeout: 0,
        schemaVersion: 1,
      });
      binding.start();
      binding.initialize();
      append(editor, 'local');
      await flush();
      const before = textOf(doc.get('lexical-y'));
      onNextTransaction(doc, () => spoil(doc.get('lexical-y')));
      expect(binding.undoManager!.undo()).toBeNull();
      await flush();
      expect(textOf(doc.get('lexical-y'))).toBe(before);
      binding.dispose();
      editor.dispose();
      doc.destroy();
    });
  }

  for (const value of ['true', 1, false, null, {}]) {
    test(`an editor write: a listener turning the existing valid schema record into ${JSON.stringify(value)} at its start: nothing written`, async () => {
      const doc = createYDoc(rawDoc(SEED), {gc});
      const errors: Error[] = [];
      const warnings: string[] = [];
      const editor = editorOf(errors, warnings);
      const binding = new YBinding(editor, doc, {schemaVersion: 2});
      binding.start();
      binding.initialize();
      expect(binding.status).toBe('active');
      expect(doc.get('lexical-y').getAttr('lexical-y-schema:1')).toBe(true);
      const before = textOf(doc.get('lexical-y'));
      onNextTransaction(doc, () =>
        doc.get('lexical-y').setAttr('lexical-y-schema:1', value as never),
      );
      append(editor, 'forbidden');
      await flush();
      expect(textOf(doc.get('lexical-y'))).toBe(before);
      expect(binding.status).toBe('readonly');
      binding.dispose();
      editor.dispose();
      doc.destroy();
    });
  }

  test('the recovery of a write whose failed attempt recorded a newer schema rewrites nothing', async () => {
    const doc = createYDoc(rawDoc(SEED), {gc});
    const errors: Error[] = [];
    const warnings: string[] = [];
    const editor = editorOf(errors, warnings);
    const binding = new YBinding(editor, doc, {schemaVersion: 1});
    binding.start();
    binding.initialize();
    const before = textOf(doc.get('lexical-y'));
    const original = Writer.prototype.$run;
    let once = false;
    const spy = vi.spyOn(Writer.prototype, '$run').mockImplementation(function (
      this: Writer,
    ) {
      if (!once) {
        once = true;
        doc.get('lexical-y').setAttr('lexical-y-schema:2', true);
        throw new Error('the first attempt failed after the schema changed');
      }
      return original.call(this);
    });
    try {
      append(editor, 'forbidden');
      await flush();
    } finally {
      spy.mockRestore();
    }
    expect(textOf(doc.get('lexical-y'))).toBe(before);
    expect(binding.status).toBe('readonly');
    binding.dispose();
    editor.dispose();
    doc.destroy();
  });

  for (const step of ['undo', 'redo'] as const) {
    test(`binding.undoManager.${step}() inside the app transaction that recorded a newer schema (status still active): nothing written`, async () => {
      const doc = createYDoc(rawDoc(SEED), {gc});
      const errors: Error[] = [];
      const warnings: string[] = [];
      const editor = editorOf(errors, warnings);
      const binding = new YBinding(editor, doc, {
        captureTimeout: 0,
        schemaVersion: 1,
      });
      binding.start();
      binding.initialize();
      append(editor, 'local');
      await flush();
      if (step === 'redo') {
        expect(binding.undoManager!.undo()).not.toBeNull();
        await flush();
      }
      const before = textOf(doc.get('lexical-y'));
      let result: unknown = 'unset';
      doc.transact(() => {
        doc.get('lexical-y').setAttr('lexical-y-schema:2', true);
        expect(binding.status).toBe('active');
        result = binding.undoManager![step]();
      }, 'app');
      await flush();
      expect(result).toBeNull();
      expect(textOf(doc.get('lexical-y'))).toBe(before);
      expect(binding.status).toBe('readonly');
      binding.dispose();
      editor.dispose();
      doc.destroy();
    });
  }

  test("control (D08): a local edit pending when a peer's newer schema record arrives is still written, then read only", async () => {
    const doc = createYDoc(rawDoc(SEED), {gc});
    const errors: Error[] = [];
    const warnings: string[] = [];
    const editor = editorOf(errors, warnings);
    const binding = new YBinding(editor, doc, {schemaVersion: 1});
    binding.start();
    binding.initialize();
    const peer = createYDoc(Y.encodeStateAsUpdate(doc), {gc});
    peer.get('lexical-y').setAttr('lexical-y-schema:2', true);
    const bump = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc));
    editor.update(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('mine')));
      // The peer's record arrives while the local update is running.
      Y.applyUpdate(doc, bump, 'remote');
    });
    await flush();
    expect(textOf(doc.get('lexical-y'))).toContain('mine');
    expect(binding.status).toBe('readonly');
    expect(warnings).toContain(UNSUPPORTED_SCHEMA_WARNING);
    peer.destroy();
    binding.dispose();
    editor.dispose();
    doc.destroy();
  });

  // D08's permission covers exactly the records the pending edit was
  // admitted on: a listener changing a malformed record into another
  // malformed value (NaN, Infinity, -Infinity, -0 and 0, undefined and null
  // look alike in JSON), or rewriting an object-valued one with an equal
  // value, ends it; the records unchanged keep it.
  for (const [first, second] of [
    [NaN, Infinity],
    [Infinity, -Infinity],
    [-0, 0],
    [null, undefined],
    [new Uint8Array([1]), new Uint8Array([2])],
    [new Date(1), new Date(2)],
    [{v: 1}, {v: 1}],
    [null, null],
  ] as const) {
    const unchanged = Object.is(first, second);
    const label = (v: unknown) =>
      Object.is(v, -0)
        ? '-0'
        : v instanceof Uint8Array
          ? `bytes ${String(v[0])}`
          : v instanceof Date
            ? `date ${v.getTime()}`
            : typeof v === 'object' && v !== null
              ? `an object ${JSON.stringify(v)}`
              : String(v);
    test(`D08: a peer's malformed schema record ${label(first)}, then a listener sets ${label(second)} at the pending edit's write: ${unchanged ? 'written (control)' : 'nothing written'}`, async () => {
      const doc = createYDoc(rawDoc(SEED), {gc});
      const errors: Error[] = [];
      const warnings: string[] = [];
      const editor = editorOf(errors, warnings);
      const binding = new YBinding(editor, doc, {schemaVersion: 1});
      binding.start();
      binding.initialize();
      const peer = createYDoc(Y.encodeStateAsUpdate(doc), {gc});
      peer.get('lexical-y').setAttr('lexical-y-schema:2', first as never);
      const bump = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc));
      let once = false;
      doc.on('beforeTransaction', tr => {
        if (tr.origin === binding && !once) {
          once = true;
          if (!unchanged) {
            doc.get('lexical-y').setAttr('lexical-y-schema:2', second as never);
          }
        }
      });
      editor.update(() => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('mine')),
        );
        Y.applyUpdate(doc, bump, 'remote');
      });
      await flush();
      expect(once).toBe(true);
      expect(textOf(doc.get('lexical-y')).includes('mine')).toBe(unchanged);
      expect(binding.status).toBe('readonly');
      peer.destroy();
      binding.dispose();
      editor.dispose();
      doc.destroy();
    });
  }

  test('control: a schema record at or below the version, recorded by a listener, does not refuse the write', async () => {
    const doc = createYDoc(rawDoc(SEED), {gc});
    const errors: Error[] = [];
    const warnings: string[] = [];
    const editor = editorOf(errors, warnings);
    const binding = new YBinding(editor, doc, {schemaVersion: 2});
    binding.start();
    binding.initialize();
    onNextTransaction(doc, () =>
      doc.get('lexical-y').setAttr('lexical-y-schema:2', true),
    );
    append(editor, 'allowed');
    await flush();
    expect(textOf(doc.get('lexical-y'))).toContain('allowed');
    expect(binding.status).toBe('active');
    binding.dispose();
    editor.dispose();
    doc.destroy();
  });

  test('control: a pristine root is seeded, its records created by the seed', async () => {
    const doc = createYDoc(null, {gc});
    const errors: Error[] = [];
    const warnings: string[] = [];
    const editor = editorOf(errors, warnings);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('SEED')));
      },
      {discrete: true},
    );
    const binding = new YBinding(editor, doc, {schemaVersion: 1});
    binding.start();
    binding.initialize();
    await flush();
    expect(textOf(doc.get('lexical-y'))).toContain('SEED');
    expect(binding.status).toBe('active');
    binding.dispose();
    editor.dispose();
    doc.destroy();
  });
});
