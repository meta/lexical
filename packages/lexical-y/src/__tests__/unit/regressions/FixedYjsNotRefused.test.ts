/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A @y/y with the encoding problem the loaders repair fixed (yjs/yjs#824,
// fixed by yjs/yjs#827) is not refused by a development build: createYDoc,
// the YBinding constructor and the headless helpers run, the contract check
// warns once that this @y/y appears to have the fix, and the loaders still
// load stored states with the repair on. Before D114, the development probe
// refused it with YUnsupportedYjsError, while production builds ran it.
//
// The fixed @y/y is the installed one with each applyUpdate followed by the
// loader repair, which integrates what a fixed decode does. Delete this file
// with LoadFully (removal steps in its header).

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
} from 'lexical';
import {afterEach, expect, test, vi} from 'vitest';

import {createYDoc, YBinding} from '../../..';
import {type HeadlessYConfig, readYState, seedYState} from '../../../headless';
import {integrateHeldBehindGaps} from '../../../internal/LoadFully';
import {
  GAP_REPAIR_RETIRABLE_WARNING,
  getGapRepairStatus,
} from '../../../internal/YjsContract';

vi.mock('@y/y', async importOriginal => {
  const actual = await importOriginal<typeof import('@y/y')>();
  return {
    ...actual,
    applyUpdate: (doc: Y.Doc, update: Uint8Array, origin?: unknown) => {
      actual.applyUpdate(doc, update, origin);
      const repair = (globalThis as {fixedYjsRepair?: (d: Y.Doc) => void})
        .fixedYjsRepair;
      if (repair !== undefined && doc.store.pendingStructs !== null) {
        repair(doc);
      }
    },
  };
});

(globalThis as {fixedYjsRepair?: (d: Y.Doc) => void}).fixedYjsRepair =
  integrateHeldBehindGaps;

afterEach(() => {
  vi.restoreAllMocks();
});

test('the entry points run on a @y/y with yjs/yjs#824 fixed, and the check warns once', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // The first entry point runs the contract check (once per module).
  const doc = createYDoc();
  expect(getGapRepairStatus()).toBe('retirable');
  expect(warn.mock.calls).toEqual([[GAP_REPAIR_RETIRABLE_WARNING]]);
  const binding = new YBinding(createEditor(), doc, {schemaVersion: 1});
  binding.dispose();
  const config: HeadlessYConfig = {schemaVersion: 1};
  const state = seedYState(config, () => {
    $getRoot().append($createParagraphNode().append($createTextNode('kept')));
  });
  // Loading stored bytes through the loaders still works.
  expect(readYState(state, config, () => $getRoot().getTextContent())).toBe(
    'kept',
  );
  expect(createYDoc(state)).toBeInstanceOf(Y.Doc);
  expect(warn).toHaveBeenCalledTimes(1);
});
