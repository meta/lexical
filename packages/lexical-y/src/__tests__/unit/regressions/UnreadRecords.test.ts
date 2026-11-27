/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Records and capture material this release does not read are kept, never
// decoded (API review round 2, N5): sourceView refuses a record of another
// version, update format, unknown kind or unsupported requirement before
// applying any bytes; createYQuarantineRecord derives nothing from such
// bytes and refuses material of another version; capture material is
// versioned and a capture resumes only version 1, 'yjs-v1'.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {
  createYQuarantineRecord,
  createYSessionCapture,
  sourceView,
  type YQuarantineRecordInput,
  type YRecordSource,
  type YSessionCaptureMaterial,
} from '../../../server';

const SOURCE: YRecordSource = {
  generation: null,
  incarnation: null,
  layouts: null,
  renderer: null,
  schemaVersion: null,
};

/** Bytes that are not a Yjs V1 update: decoding them throws. */
const NOT_V1 = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]);

function v1Update(gc: boolean): Uint8Array {
  const doc = new Y.Doc({gc});
  doc.get('x').insert(0, 'text');
  return Y.encodeStateAsUpdate(doc);
}

/** A record header and material whose bytes must not be touched. */
function untouchable(header: Record<string, unknown>) {
  let touched = 0;
  return {
    get deltas() {
      touched++;
      return [];
    },
    header,
    get queue() {
      touched++;
      return [];
    },
    get snapshot() {
      touched++;
      return NOT_V1;
    },
    touched: () => touched,
  };
}

describe.each([false, true])(
  'records this release does not read, gc %s',
  gc => {
    test('sourceView refuses another version, update format, unknown kind or unsupported requirement before applying any bytes', () => {
      const readable = {
        kind: 'handoff',
        requires: [] as string[],
        updateFormat: 'yjs-v1' as const,
        v: 1 as const,
      };
      for (const header of [
        {...readable, v: 2},
        {...readable, v: undefined},
        {...readable, updateFormat: 'yjs-v2'},
        {...readable, updateFormat: undefined},
        {...readable, kind: 'future-kind'},
        {...readable, requires: ['future-feature']},
        {...readable, requires: undefined},
      ]) {
        const record = untouchable(header);
        const view = Object.defineProperties(
          {...header},
          Object.getOwnPropertyDescriptors({
            get deltas() {
              return record.deltas;
            },
            get queue() {
              return record.queue;
            },
            get snapshot() {
              return record.snapshot;
            },
          }),
        );
        expect(() => sourceView(view as never)).toThrow(TypeError);
        expect(record.touched()).toBe(0);
      }
      // A readable record is read.
      const doc = sourceView({
        ...readable,
        deltas: [],
        queue: [],
        snapshot: v1Update(gc),
      }).doc;
      expect(doc.get('x').toString()).toBe('text');
      doc.destroy();
    });

    test('createYQuarantineRecord keeps a record it does not read without decoding it', () => {
      for (const input of [
        {kind: 'future-kind'},
        {kind: 'handoff', requires: ['future-feature']},
      ]) {
        const record = createYQuarantineRecord({
          ...input,
          deltas: [NOT_V1],
          receivedAt: 1,
          snapshot: NOT_V1,
          source: SOURCE,
        } as YQuarantineRecordInput);
        expect(record).toMatchObject({
          actionable: true,
          collisions: [],
          complete: false,
          snapshot: NOT_V1,
        });
        // Exported raw: the bytes are kept as they are, and sourceView
        // refuses it.
        expect(record.deltas).toEqual([NOT_V1]);
        expect(() => sourceView(record)).toThrow(TypeError);
      }
    });

    test('createYQuarantineRecord refuses material of another version or update format', () => {
      for (const header of [
        {v: 2},
        {updateFormat: 'yjs-v2'},
        {updateFormat: 'yjs-v1', v: 2},
      ]) {
        expect(() =>
          createYQuarantineRecord({
            ...header,
            kind: 'capture',
            receivedAt: 1,
            snapshot: v1Update(gc),
            source: SOURCE,
          } as unknown as YQuarantineRecordInput),
        ).toThrow(TypeError);
      }
      // The pending form too: its header is checked on the caller's input
      // before the form is chosen, never dropped and restamped.
      const [stored, cut] = [v1Update(gc), v1Update(gc)];
      for (const header of [
        {v: 2},
        {updateFormat: 'yjs-v2'},
        {updateFormat: 'yjs-v1', v: 2},
        {updateFormat: 'yjs-v2', v: 2},
      ]) {
        expect(() =>
          createYQuarantineRecord({
            ...header,
            kind: 'pending',
            pending: cut,
            receivedAt: 1,
            source: SOURCE,
            stored,
          } as unknown as YQuarantineRecordInput),
        ).toThrow(TypeError);
      }
      // Absent or version 1 tags are the local default.
      for (const header of [{}, {updateFormat: 'yjs-v1', v: 1}]) {
        expect(
          createYQuarantineRecord({
            ...header,
            kind: 'pending',
            pending: cut,
            receivedAt: 1,
            source: SOURCE,
            stored,
          } as unknown as YQuarantineRecordInput),
        ).toMatchObject({kind: 'pending', updateFormat: 'yjs-v1', v: 1});
      }
      // Version 1 material, as a capture hands it over, is accepted.
      const capture = createYSessionCapture();
      capture.add(v1Update(gc));
      const record = createYQuarantineRecord({
        ...capture.material(),
        kind: 'capture',
        receivedAt: 1,
        source: SOURCE,
      });
      expect(record).toMatchObject({complete: true, kind: 'capture', v: 1});
    });

    test('capture material is versioned, and a capture resumes only version 1, yjs-v1, leaving any other untouched', () => {
      const capture = createYSessionCapture();
      capture.add(v1Update(gc));
      const material = capture.material();
      expect(material).toMatchObject({
        deltas: [],
        signals: [],
        updateFormat: 'yjs-v1',
        v: 1,
      });
      expect(createYSessionCapture(material).material()).toEqual(material);
      for (const header of [
        {v: 2},
        {v: undefined},
        {updateFormat: 'yjs-v2'},
        {updateFormat: undefined},
      ]) {
        let touched = 0;
        const stored = Object.defineProperties(
          {...material, ...header},
          Object.getOwnPropertyDescriptors({
            get deltas() {
              touched++;
              return [NOT_V1];
            },
            get signals() {
              touched++;
              return [];
            },
            get snapshot() {
              touched++;
              return NOT_V1;
            },
          }),
        );
        expect(() =>
          createYSessionCapture(stored as unknown as YSessionCaptureMaterial),
        ).toThrow(TypeError);
        expect(touched).toBe(0);
      }
    });
  },
);
