/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Every transaction the binding writes in is admitted inside it, after the
// app's beforeTransaction listeners (code review round 2, M4):
// initialization seeds only a root still pristine (no content, no layout
// record, no epoch), the recovery rewrite after a failed write and the pin
// write check the layout record. A listener that records layout 99 or a
// broken epoch at their start makes them write nothing.

import type * as Y from '@y/y';

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

import {createYDoc, YBinding} from '../../..';
import {Writer} from '../../../internal/Write';
import {catalogAppExtension} from '../../catalog/bind';
import {rawDoc, SEED} from '../../utils/migrateSteps';
import {textOf} from '../../utils/splitFixtures';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function editorOf(errors: Error[]) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension({blockIds: 'absent'})],
      name: 'every-write',
      onError: e => {
        errors.push(e);
      },
      onWarn: () => {},
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

/** At the start of the next transaction only, run `fn`. */
function onNextTransaction(doc: Y.Doc, when: () => boolean, fn: () => void) {
  let done = false;
  doc.on('beforeTransaction', () => {
    if (!done && when()) {
      done = true;
      fn();
    }
  });
}

const SPOIL = {
  'broken epoch': (root: Y.Node) => root.setAttr('lexical-y-epoch', 'broken'),
  'layout 99': (root: Y.Node) => root.setAttr('lexical-y:99', true),
} as const;

describe.each([false, true])('every binding write is admitted, gc %s', gc => {
  for (const [cause, spoil] of Object.entries(SPOIL)) {
    test(`initialization: a listener recording ${cause} at the seed's start: nothing seeded`, async () => {
      const doc = createYDoc(null, {gc});
      const errors: Error[] = [];
      const editor = editorOf(errors);
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
      onNextTransaction(
        doc,
        () => true,
        () => spoil(doc.get('lexical-y')),
      );
      binding.initialize();
      await flush();
      expect(textOf(doc.get('lexical-y'))).not.toContain('SEED');
      expect(binding.status).not.toBe('active');
      expect(errors).toEqual([]);
      binding.dispose();
      editor.dispose();
      doc.destroy();
    });

    test(`recovery: a listener recording ${cause} at the rewrite's start: nothing written, read only`, async () => {
      const doc = createYDoc(rawDoc(SEED), {gc});
      const errors: Error[] = [];
      const editor = editorOf(errors);
      const binding = new YBinding(editor, doc, {schemaVersion: 1});
      binding.start();
      binding.initialize();
      const before = textOf(doc.get('lexical-y'));
      const original = Writer.prototype.$run;
      let failed = false;
      const spy = vi
        .spyOn(Writer.prototype, '$run')
        .mockImplementation(function (this: Writer) {
          if (!failed) {
            failed = true;
            throw new Error('first writer failure');
          }
          return original.call(this);
        });
      onNextTransaction(
        doc,
        () => failed,
        () => spoil(doc.get('lexical-y')),
      );
      try {
        append(editor, 'forbidden');
        await flush();
      } finally {
        spy.mockRestore();
      }
      expect(failed).toBe(true);
      expect(textOf(doc.get('lexical-y'))).toBe(before);
      expect(binding.status).toBe('readonly');
      binding.dispose();
      editor.dispose();
      doc.destroy();
    });

    test(`pins: a listener recording ${cause} at the pin write's start: no pin, read only`, async () => {
      const doc = createYDoc(rawDoc(SEED), {gc});
      const errors: Error[] = [];
      const editor = editorOf(errors);
      const binding = new YBinding(editor, doc, {schemaVersion: 1});
      binding.start();
      binding.initialize();
      const root = doc.get('lexical-y');
      const pinsBefore = Object.keys(root.getAttrs()).filter(k =>
        k.startsWith('k:'),
      );
      const original = Writer.prototype.$run;
      let wrote = false;
      const spy = vi
        .spyOn(Writer.prototype, '$run')
        .mockImplementation(function (this: Writer) {
          const result = original.call(this);
          wrote = true;
          return result;
        });
      onNextTransaction(
        doc,
        () => wrote,
        () => spoil(root),
      );
      try {
        append(editor, 'local');
        await flush();
      } finally {
        spy.mockRestore();
      }
      expect(
        Object.keys(root.getAttrs()).filter(k => k.startsWith('k:')),
      ).toEqual(pinsBefore);
      expect(binding.status).toBe('readonly');
      binding.dispose();
      editor.dispose();
      doc.destroy();
    });
  }

  test('control: initialization and an edit inside one app transaction are stored, active', () => {
    const doc = createYDoc(null, {gc});
    const errors: Error[] = [];
    const editor = editorOf(errors);
    const binding = new YBinding(editor, doc, {schemaVersion: 1});
    binding.start();
    doc.transact(() => {
      append(editor, 'seed');
      binding.initialize();
      append(editor, 'inside');
    }, 'app');
    expect(textOf(doc.get('lexical-y'))).toContain('seed');
    expect(textOf(doc.get('lexical-y'))).toContain('inside');
    expect(binding.status).toBe('active');
    binding.dispose();
    editor.dispose();
    doc.destroy();
  });

  test('control: a pristine root is seeded, its record created by the seed', async () => {
    const doc = createYDoc(null, {gc});
    const errors: Error[] = [];
    const editor = editorOf(errors);
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
