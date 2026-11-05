/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The required layoutUpgrade (y.md "Layout upgrades"): createYCollabConfig
// requires the app to declare how documents below MIN_LAYOUT are upgraded,
// a handle from createYServerLayoutUpgrade or null. The binding behaves the
// same with either (read only below the floor); the 'older' warning says
// which was declared, and a config without the option (plain JavaScript,
// a direct configExtension) also brings UNSUPPORTED_CONFIG_WARNING
// 'missing-layout-upgrade'. The handle builds the session handshake.

import {buildEditorFromExtensions} from '@lexical/extension';
import {configExtension, defineExtension} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {
  createYCollabConfig,
  createYDoc,
  createYServerLayoutUpgrade,
  isYLayoutUpgradeHandle,
  LAYOUT_VERSION,
  MIN_LAYOUT,
  SEED_LAYOUT,
  UNSUPPORTED_CONFIG_WARNING,
  UNSUPPORTED_LAYOUT_WARNING,
  YCollabExtension,
  type YCollabInput,
  type YLayoutUpgradeHandle,
} from '../../..';
import {setMinLayoutForTests} from '../../../internal/Binding';
import * as serverEntry from '../../../server';
import {catalogAppExtension} from '../../catalog/bind';
import {FLOOR, rawDoc} from '../../utils/migrateSteps';

const CFG = {blockIds: 'absent'} as const;
type Warning = {code?: string; data?: Record<string, unknown>};

afterEach(() => {
  setMinLayoutForTests(null);
});

// Through the factory, an omitted layoutUpgrade does not compile; a handle
// and null do.
export function typeCells(doc: YCollabInput['doc']): unknown[] {
  return [
    // @ts-expect-error layoutUpgrade is required
    createYCollabConfig({doc, schemaVersion: 1}),
    createYCollabConfig({
      doc,
      layoutUpgrade: createYServerLayoutUpgrade(),
      schemaVersion: 1,
    }),
    createYCollabConfig({doc, layoutUpgrade: null, schemaVersion: 1}),
  ];
}

// Only the factory makes a handle: a structural look-alike does not type.
export function handleCells(): YLayoutUpgradeHandle[] {
  const real = createYServerLayoutUpgrade();
  // @ts-expect-error a look-alike lacks the brand
  const fake: YLayoutUpgradeHandle = {
    handshake: real.handshake,
    kind: 'server',
    target: 1,
  };
  return [real, fake];
}

function editorWith(
  dependency: ReturnType<typeof createYCollabConfig>,
  warnings: Warning[],
): ReturnType<typeof buildEditorFromExtensions> {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [catalogAppExtension(CFG), dependency],
      name: 'layout-upgrade',
      onWarn: w => {
        warnings.push(w as Warning);
      },
    }),
  );
}

const older = (warnings: Warning[]) =>
  warnings
    .filter(
      w => w.code === UNSUPPORTED_LAYOUT_WARNING && w.data?.reason === 'older',
    )
    .map(w => w.data?.upgrade);
const missing = (warnings: Warning[]) =>
  warnings.filter(
    w =>
      w.code === UNSUPPORTED_CONFIG_WARNING &&
      w.data?.reason === 'missing-layout-upgrade',
  );

describe.each([false, true])('layoutUpgrade, gc %s', gc => {
  const cases: [
    string,
    (doc: YCollabInput['doc']) => unknown,
    string,
    number,
  ][] = [
    [
      'a server handle',
      doc =>
        createYCollabConfig({
          doc,
          layoutUpgrade: createYServerLayoutUpgrade(),
          schemaVersion: 1,
          synced: true,
        }),
      'server',
      0,
    ],
    [
      'null',
      doc =>
        createYCollabConfig({
          doc,
          layoutUpgrade: null,
          schemaVersion: 1,
          synced: true,
        }),
      'read-only',
      0,
    ],
    [
      'left out (a direct configExtension)',
      doc =>
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          synced: true,
        }),
      'read-only',
      1,
    ],
  ];

  test.each(cases)(
    'below the floor with %s: read only, the older warning says what was declared',
    async (_name, configOf, upgrade, missingCount) => {
      setMinLayoutForTests(FLOOR);
      const warnings: Warning[] = [];
      const doc = createYDoc(rawDoc(FLOOR - 1), {gc});
      const editor = editorWith(
        configOf(doc) as ReturnType<typeof createYCollabConfig>,
        warnings,
      );
      await Promise.resolve();
      expect(editor.isEditable()).toBe(false);
      expect(older(warnings)).toEqual([upgrade]);
      expect(missing(warnings)).toHaveLength(missingCount);
      editor.dispose();
    },
  );

  test.each(cases)(
    'at the floor with %s: active, no layout or config warning',
    async (_name, configOf) => {
      setMinLayoutForTests(FLOOR);
      const warnings: Warning[] = [];
      const doc = createYDoc(rawDoc(FLOOR), {gc});
      const editor = editorWith(
        configOf(doc) as ReturnType<typeof createYCollabConfig>,
        warnings,
      );
      await Promise.resolve();
      expect(editor.isEditable()).toBe(true);
      expect(older(warnings)).toEqual([]);
      expect(missing(warnings)).toHaveLength(0);
      editor.dispose();
    },
  );
});

describe('the handle', () => {
  test('createYServerLayoutUpgrade: a branded, open handle that builds the complete handshake', () => {
    const handle: YLayoutUpgradeHandle = createYServerLayoutUpgrade();
    expect(handle.kind).toBe('server');
    expect(handle.target).toBe(MIN_LAYOUT);
    expect(isYLayoutUpgradeHandle(handle)).toBe(true);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(handle.handshake({generation: 'inc/-', material: true})).toEqual({
      features: [],
      generation: 'inc/-',
      layouts: [MIN_LAYOUT, LAYOUT_VERSION],
      material: true,
      seed: SEED_LAYOUT,
      v: 1,
    });
    // Look-alikes are not handles, nor is a branded object without a valid
    // target or kind.
    expect(isYLayoutUpgradeHandle({handshake() {}, kind: 'server'})).toBe(
      false,
    );
    const brand = Symbol.for('@lexical/y/layout-upgrade');
    const branded = (fields: Record<string, unknown>) => ({
      [brand]: true,
      handshake: handle.handshake,
      kind: 'server',
      target: MIN_LAYOUT,
      ...fields,
    });
    expect(isYLayoutUpgradeHandle(branded({}))).toBe(true);
    expect(isYLayoutUpgradeHandle(branded({target: undefined}))).toBe(false);
    expect(isYLayoutUpgradeHandle(branded({target: 0}))).toBe(false);
    expect(isYLayoutUpgradeHandle(branded({target: 1.5}))).toBe(false);
    expect(isYLayoutUpgradeHandle(branded({kind: ''}))).toBe(false);
    expect(isYLayoutUpgradeHandle(null)).toBe(false);
  });

  test("the server entry's handle is the core's, and its handshake passes checkYSession", () => {
    const handle = serverEntry.createYServerLayoutUpgrade();
    expect(isYLayoutUpgradeHandle(handle)).toBe(true);
    expect(
      serverEntry.isYLayoutUpgradeHandle(createYServerLayoutUpgrade()),
    ).toBe(true);
    const doc = serverEntry.createYDoc(rawDoc(SEED_LAYOUT));
    const room = serverEntry.describeYRoom(doc, {
      incarnation: 'inc',
      inherited: false,
      seedContract: SEED_LAYOUT,
    });
    expect(
      serverEntry.checkYSession(
        room,
        handle.handshake({generation: room.generation, material: true}),
      ),
    ).toMatchObject({verdict: 'admit'});
    expect(
      serverEntry.checkYSession(
        room,
        handle.handshake({generation: null, material: false}),
      ),
    ).toMatchObject({verdict: 'bootstrap'});
    // It is a version 1 handshake with this release's features: a room that
    // requires a feature this release does not support turns it away (its
    // material handed off first).
    const built = handle.handshake({generation: null, material: false});
    expect(built).toMatchObject({features: [], v: 1});
    const requiring = serverEntry.createYDoc(rawDoc(SEED_LAYOUT));
    requiring.get('lexical-y').setAttr('lexical-y-require:future', true);
    const fenced = serverEntry.describeYRoom(requiring, {
      incarnation: 'inc',
      inherited: false,
      seedContract: SEED_LAYOUT,
    });
    expect(fenced.requires).toEqual(['future']);
    expect(
      serverEntry.checkYSession(
        fenced,
        handle.handshake({generation: fenced.generation, material: true}),
      ),
    ).toMatchObject({reason: 'requires', verdict: 'stale'});
    expect(
      serverEntry.checkYSession(
        fenced,
        handle.handshake({generation: null, material: false}),
      ),
    ).toMatchObject({reason: 'requires', verdict: 'refuse-layout'});
  });

  test('a target outside [MIN_LAYOUT, LAYOUT_VERSION] is refused; a handle that is not one is refused by the factory and the extension', () => {
    expect(() =>
      createYServerLayoutUpgrade({target: LAYOUT_VERSION + 1}),
    ).toThrow(RangeError);
    expect(() => createYServerLayoutUpgrade({target: 0})).toThrow(RangeError);
    const doc = createYDoc();
    const fake = {handshake: () => null, kind: 'server'} as never;
    expect(() =>
      createYCollabConfig({doc, layoutUpgrade: fake, schemaVersion: 1}),
    ).toThrow(/layoutUpgrade/);
    expect(() =>
      buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            catalogAppExtension(CFG),
            configExtension(YCollabExtension, {
              doc,
              layoutUpgrade: fake,
              schemaVersion: 1,
            }),
          ],
          name: 'fake-handle',
        }),
      ),
    ).toThrow(/layoutUpgrade/);
  });
});
