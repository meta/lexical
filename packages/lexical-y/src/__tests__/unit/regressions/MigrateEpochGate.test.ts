/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A malformed epoch (`lexical-y-epoch`) closes the gate like a malformed
// layout record (code review round 1, M5): the binding opens read only, or
// turns read only when one arrives, with the malformed warning naming the
// key; headless reads and edits refuse it; the runner and the server agree.
// No epoch is fine (a document that never migrated), and a well-formed one
// changes nothing.

import {buildEditorFromExtensions} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, UNSUPPORTED_LAYOUT_WARNING, YBinding} from '../../..';
import {editYState, readYState, YHeadlessError} from '../../../headless';
import {migrateYState} from '../../../migrate';
import {describeYRoom} from '../../../server';
import {catalogAppExtension, catalogHeadlessConfig} from '../../catalog/bind';
import {rawDoc, SEED, stamp} from '../../utils/migrateSteps';
import {textOf} from '../../utils/splitFixtures';

const CFG = {blockIds: 'absent'} as const;
const BROKEN = [
  'broken',
  {v: 1},
  {client: 1, clock: 0, layout: 2, revision: 1, step: 'x', v: 2},
];

function bind(state: Uint8Array, gc: boolean) {
  const doc = createYDoc(state, {gc});
  const warnings: {code?: string; data?: Record<string, unknown>}[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(CFG)],
      name: 'epoch-gate',
      onError: e => {
        throw e;
      },
      onWarn: w => {
        warnings.push(w as never);
      },
    }),
  );
  const binding = new YBinding(editor, doc, {schemaVersion: 1});
  binding.start();
  binding.initialize();
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
  return {append, binding, dispose, doc, warnings};
}

const text = (doc: Y.Doc) => textOf(doc.get('lexical-y'));
const malformedEpoch = (w: {code?: string; data?: Record<string, unknown>}) =>
  w.code === UNSUPPORTED_LAYOUT_WARNING &&
  w.data?.reason === 'malformed' &&
  w.data?.key === 'lexical-y-epoch';

function withEpoch(gc: boolean, epoch: unknown): Uint8Array {
  const d = createYDoc(rawDoc(SEED), {gc});
  d.get('lexical-y').setAttr('lexical-y-epoch', epoch as never);
  const out = Y.encodeStateAsUpdate(d);
  d.destroy();
  return out;
}

describe.each([false, true])('malformed epochs, gc %s', gc => {
  test.each(BROKEN.map(e => [JSON.stringify(e), e]))(
    'a document with epoch %s opens read only and writes nothing',
    (_name, epoch) => {
      const state = withEpoch(gc, epoch);
      const t = bind(state, gc);
      expect(t.binding.status).toBe('readonly');
      expect(t.warnings.some(malformedEpoch)).toBe(true);
      const before = text(t.doc);
      t.append('forbidden');
      expect(text(t.doc)).toBe(before);
      t.dispose();
    },
  );

  test('an epoch turning malformed under an active binding: read only, and back to active when it is fixed', () => {
    const t = bind(rawDoc(SEED), gc);
    expect(t.binding.status).toBe('active');
    t.doc.get('lexical-y').setAttr('lexical-y-epoch', 'broken');
    expect(t.binding.status).toBe('readonly');
    expect(t.warnings.some(malformedEpoch)).toBe(true);
    const before = text(t.doc);
    t.append('forbidden');
    expect(text(t.doc)).toBe(before);
    t.doc.get('lexical-y').deleteAttr('lexical-y-epoch');
    expect(t.binding.status).toBe('active');
    t.append('again');
    expect(text(t.doc)).toContain('again');
    t.dispose();
  });

  test('inside an app transaction that breaks the epoch, an editor write is refused', () => {
    const t = bind(rawDoc(SEED), gc);
    const before = text(t.doc);
    t.doc.transact(() => {
      t.doc.get('lexical-y').setAttr('lexical-y-epoch', 'broken');
      t.append('forbidden');
    }, 'app');
    expect(text(t.doc)).toBe(before);
    expect(t.binding.status).toBe('readonly');
    t.dispose();
  });

  test('headless reads and edits refuse it; the runner and the server agree', () => {
    const state = withEpoch(gc, 'broken');
    const config = catalogHeadlessConfig(CFG);
    expect(() => readYState(state, config, () => null)).toThrow(YHeadlessError);
    expect(() =>
      editYState(
        state,
        config,
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('headless')),
          );
        },
        {writer: null},
      ),
    ).toThrow(YHeadlessError);
    expect(() =>
      migrateYState(state, [stamp(SEED)], {gc, to: SEED + 1}),
    ).toThrow(/epoch/);
    const doc = createYDoc(state, {gc});
    expect(
      describeYRoom(doc, {incarnation: 'i', inherited: false, seedContract: 1})
        .unreadable,
    ).toEqual(['lexical-y']);
    doc.destroy();
  });

  test('no epoch, or a well-formed one, keeps the binding active', () => {
    const t = bind(rawDoc(SEED), gc);
    expect(t.binding.status).toBe('active');
    t.dispose();
    const migrated = migrateYState(rawDoc(SEED), [stamp(SEED)], {
      gc,
      to: SEED + 1,
    }).state;
    const m = bind(migrated, gc);
    expect(m.doc.get('lexical-y').getAttr('lexical-y-epoch')).toMatchObject({
      v: 1,
    });
    // Active when this build reads SEED + 1; else read only as newer.
    expect(m.warnings.some(malformedEpoch)).toBe(false);
    m.dispose();
  });
});
