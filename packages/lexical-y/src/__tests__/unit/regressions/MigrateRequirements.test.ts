/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Feature requirements (API review M5): `lexical-y-require:<feature> = true`
// on a root. A requirement this version does not support (it supports none)
// or one that is not well formed opens the root read only, in the binding
// and in headless editing: the editor shows it, nothing is written, and the
// document is kept as it is. Any other unknown `lexical-y-*` attribute is
// kept and ignored.

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
import {editYState, YHeadlessError} from '../../../headless';
import {readRequirements} from '../../../internal/Layouts';
import {migrateYState, YMigrationError} from '../../../migrate';
import {catalogAppExtension, catalogHeadlessConfig} from '../../catalog/bind';
import {rawDoc, SEED, stamp} from '../../utils/migrateSteps';
import {textOf} from '../../utils/splitFixtures';

const CFG = {blockIds: 'absent'} as const;
type Warning = {code?: string; data?: Record<string, unknown>};

function withAttrs(gc: boolean, attrs: Record<string, unknown>): Uint8Array {
  const d = createYDoc(rawDoc(SEED), {gc});
  for (const [k, v] of Object.entries(attrs)) {
    d.get('lexical-y').setAttr(k, v as never);
  }
  const out = Y.encodeStateAsUpdate(d);
  d.destroy();
  return out;
}

function bind(state: Uint8Array | null, gc: boolean) {
  const doc = createYDoc(state, {gc});
  const warnings: Warning[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(CFG)],
      name: 'requirements',
      onError: e => {
        throw e;
      },
      onWarn: w => {
        warnings.push(w as Warning);
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
  const shown = () =>
    editor.getEditorState().read(() => $getRoot().getTextContent());
  const dispose = () => {
    binding.dispose();
    editor.dispose();
    doc.destroy();
  };
  return {append, binding, dispose, doc, shown, warnings};
}

const requires = (w: Warning) =>
  w.code === UNSUPPORTED_LAYOUT_WARNING && w.data?.reason === 'requires';
const malformed = (key: string) => (w: Warning) =>
  w.code === UNSUPPORTED_LAYOUT_WARNING &&
  w.data?.reason === 'malformed' &&
  w.data?.key === key;

describe.each([false, true])('feature requirements, gc %s', gc => {
  test('an unknown requirement: read only, shown, nothing written, the document kept', () => {
    const state = withAttrs(gc, {'lexical-y-require:acme.tables-v2': true});
    const t = bind(state, gc);
    expect(t.binding.status).toBe('readonly');
    expect(t.warnings.filter(requires).map(w => w.data)).toEqual([
      {
        features: ['acme.tables-v2'],
        reason: 'requires',
        supported: expect.any(Number),
      },
    ]);
    expect(t.shown()).toContain('abc');
    t.append('forbidden');
    expect(Buffer.from(Y.encodeStateAsUpdate(t.doc))).toEqual(
      Buffer.from(state),
    );
    t.dispose();
  });

  for (const [key, value] of [
    ['lexical-y-require:acme.x', 'yes'],
    ['lexical-y-require:', true],
  ] as const) {
    test(`a malformed requirement (${key} = ${JSON.stringify(value)}): read only with the malformed warning`, () => {
      const state = withAttrs(gc, {[key]: value});
      const t = bind(state, gc);
      expect(t.binding.status).toBe('readonly');
      expect(t.warnings.some(malformed(key))).toBe(true);
      t.append('forbidden');
      expect(Buffer.from(Y.encodeStateAsUpdate(t.doc))).toEqual(
        Buffer.from(state),
      );
      t.dispose();
    });
  }

  test('a requirement arriving under an active binding turns it read only; inside an app transaction, the editor write is refused', () => {
    const t = bind(rawDoc(SEED), gc);
    expect(t.binding.status).toBe('active');
    const before = textOf(t.doc.get('lexical-y'));
    t.doc.transact(() => {
      t.doc.get('lexical-y').setAttr('lexical-y-require:acme.x', true);
      t.append('forbidden');
    }, 'app');
    expect(textOf(t.doc.get('lexical-y'))).toBe(before);
    expect(t.binding.status).toBe('readonly');
    expect(t.warnings.some(requires)).toBe(true);
    t.dispose();
  });

  test('headless editing refuses a root with an unknown requirement', () => {
    const state = withAttrs(gc, {'lexical-y-require:acme.x': true});
    expect(() =>
      editYState(
        state,
        catalogHeadlessConfig(CFG),
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('headless')),
          );
        },
        {writer: null},
      ),
    ).toThrow(YHeadlessError);
  });

  test('a root holding only a requirement is not pristine: initialization seeds nothing', () => {
    const d = createYDoc(null, {gc});
    d.get('lexical-y').setAttr('lexical-y-require:acme.x', true);
    const state = Y.encodeStateAsUpdate(d);
    d.destroy();
    const t = bind(state, gc);
    expect(t.binding.status).toBe('readonly');
    expect(textOf(t.doc.get('lexical-y'))).toBe('');
    expect(Buffer.from(Y.encodeStateAsUpdate(t.doc))).toEqual(
      Buffer.from(state),
    );
    t.dispose();
  });

  test('control: an ordinary unknown lexical-y-* attribute is kept and ignored', () => {
    const t = bind(withAttrs(gc, {'lexical-y-acme-note': {any: 1}}), gc);
    expect(t.binding.status).toBe('active');
    t.append('allowed');
    expect(textOf(t.doc.get('lexical-y'))).toContain('allowed');
    expect(t.doc.get('lexical-y').getAttr('lexical-y-acme-note')).toEqual({
      any: 1,
    });
    t.dispose();
  });

  test('the runner refuses a root that would run a step and requires an unsupported feature, before running any root; a root needing no step passes through', () => {
    const unsupported = withAttrs(gc, {'lexical-y-require:acme.x': true});
    let error: unknown = null;
    try {
      migrateYState(unsupported, [stamp(SEED)], {gc, to: SEED + 1});
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(YMigrationError);
    expect(error).toMatchObject({
      code: 'unsupported-feature',
      problems: ['lexical-y-require:acme.x'],
      root: 'lexical-y',
    });
    const malformedState = withAttrs(gc, {'lexical-y-require:acme.x': 'yes'});
    expect(() =>
      migrateYState(malformedState, [stamp(SEED)], {gc, to: SEED + 1}),
    ).toThrow(expect.objectContaining({code: 'malformed'}));
    // At the target: no step runs, and the root is returned unchanged.
    const through = migrateYState(unsupported, [stamp(SEED)], {gc, to: SEED});
    expect(through.update).toBeNull();
    expect(through.receipt.changed).toBe(false);
    expect(Buffer.from(through.state)).toEqual(Buffer.from(unsupported));
    // Two roots that would both run a step: the refusal comes before either
    // runs (nothing is returned).
    const d = createYDoc(rawDoc(SEED), {gc});
    d.get('b').setAttr(`lexical-y:${SEED}`, true);
    d.get('b').setAttr('lexical-y-require:acme.y', true);
    const two = Y.encodeStateAsUpdate(d);
    d.destroy();
    expect(() =>
      migrateYState(two, [stamp(SEED)], {
        gc,
        roots: ['b', 'lexical-y'],
        to: SEED + 1,
      }),
    ).toThrow(
      expect.objectContaining({code: 'unsupported-feature', root: 'b'}),
    );
  });

  test('readRequirements: required, unknown and malformed, against the supported features', () => {
    const d = createYDoc(null, {gc});
    const root = d.get('lexical-y');
    root.setAttr('lexical-y-require:b', true);
    root.setAttr('lexical-y-require:a', true);
    root.setAttr('lexical-y-require:c', 1);
    root.setAttr('lexical-y-other', true);
    expect(readRequirements(root)).toEqual({
      malformed: [{found: 1, key: 'lexical-y-require:c'}],
      required: ['a', 'b'],
      unknown: ['a', 'b'],
    });
    expect(readRequirements(root, new Set(['a'])).unknown).toEqual(['b']);
    d.destroy();
  });
});
