/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// quiesce() stops a local migration that is still loading its steps (code
// review round 1, M6): nothing is written after the state quiesce()
// returned, and no error is reported.

import {buildEditorFromExtensions} from '@lexical/extension';
import * as Y from '@y/y';
import {defineExtension} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {createYDoc, YBinding} from '../../..';
import {setMinLayoutForTests} from '../../../internal/Binding';
import {catalogAppExtension} from '../../catalog/bind';
import {FLOOR, rawDoc, stamp} from '../../utils/migrateSteps';

afterEach(() => setMinLayoutForTests(null));

describe.each([false, true])('quiesce and migrateLocally, gc %s', gc => {
  for (const pause of ['runner', 'step'] as const) {
    test(`a migration whose ${pause} loader is still pending writes nothing after quiesce()`, async () => {
      setMinLayoutForTests(FLOOR);
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const doc = createYDoc(rawDoc(FLOOR - 1), {gc});
      const errors: Error[] = [];
      const editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [catalogAppExtension({blockIds: 'absent'})],
          name: 'quiesce-local',
          onError: e => {
            errors.push(e);
          },
          onWarn: () => {},
        }),
      );
      const binding = new YBinding(editor, doc, {
        migrateLocally: {
          [FLOOR - 1]: async () => {
            if (pause === 'step') {
              await gate;
            }
            return stamp(FLOOR - 1);
          },
          runner: async () => {
            if (pause === 'runner') {
              await gate;
            }
            return import('../../../migrate');
          },
        },
        schemaVersion: 1,
      });
      binding.start();
      binding.initialize();
      expect(binding.status).toBe('readonly');
      const captured = binding.quiesce();
      let updates = 0;
      doc.on('update', () => {
        updates++;
      });
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(updates).toBe(0);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(captured.state);
      expect(binding.status).toBe('readonly');
      expect(errors).toEqual([]);
      binding.dispose();
      editor.dispose();
      doc.destroy();
    });
  }

  test('control: without quiesce() the same migration runs', async () => {
    setMinLayoutForTests(FLOOR);
    const doc = createYDoc(rawDoc(FLOOR - 1), {gc});
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [catalogAppExtension({blockIds: 'absent'})],
        name: 'quiesce-local-control',
        onError: e => {
          throw e;
        },
        onWarn: () => {},
      }),
    );
    const binding = new YBinding(editor, doc, {
      migrateLocally: {
        [FLOOR - 1]: async () => stamp(FLOOR - 1),
        runner: () => import('../../../migrate'),
      },
      schemaVersion: 1,
    });
    binding.start();
    binding.initialize();
    for (let i = 0; i < 20 && binding.status !== 'active'; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(binding.status).toBe('active');
    expect(doc.get('lexical-y').getAttr(`lexical-y:${FLOOR}`)).toBe(true);
    binding.dispose();
    editor.dispose();
    doc.destroy();
  });
});
