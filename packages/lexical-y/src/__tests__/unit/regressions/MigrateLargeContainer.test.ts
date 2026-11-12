/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A container with more live countable units than a call can take as
// arguments migrates. Layout 1 and 2 keep the text of every top-level line
// in the root container, so a long document's root holds one unit per
// character plus one per line marker. The runner copied each container's
// per-unit read with `perUnit.push(...strings)`, which passes every unit as
// an argument: past about 122,000 units in one container, Node's main
// thread throws `RangeError: Maximum call stack size exceeded` (an argument
// limit, not recursion), in the before snapshot of the first step. The
// limit depends on the stack the code runs on (a Vitest worker's is larger),
// so the documents here are sized from the limit of the runtime they run
// in. A step that throws, in its read or its write, is reported as a
// YMigrationError whose `cause` is the error it threw.

import * as Y from '@y/y';
import {$getRoot} from 'lexical';
import {describe, expect, test} from 'vitest';

import {readYState} from '../../../headless';
import {createRawYDoc} from '../../../internal/RawYDoc';
import {
  getYLayoutInfo,
  migrateYState,
  type YLayoutMigration,
  YMigrationError,
} from '../../../migrate';
import step1to2 from '../../../migrate/1to2';
import step2to3 from '../../../migrate/2to3';
import {NODES} from '../../utils/harness';

const STEPS = [step1to2, step2to3];
const CONFIG = {nodes: NODES, onWarn: () => {}, schemaVersion: 1};

/** The layout `doc`'s root records (see getYLayoutInfo), or null. */
const recordedLayout = (doc: Y.Doc, root = 'lexical-y'): number | null => {
  const info = getYLayoutInfo(doc, root);
  return 'layout' in info ? info.layout : null;
};

/**
 * A layout 1 document of `lines` top-level paragraphs, each holding `text`:
 * the root container holds each line's text then its line marker, so it
 * has `lines * (text.length + 1)` live countable units.
 */
function layout1Document(lines: number, text: string): Uint8Array {
  const doc = new Y.Doc({gc: false});
  doc.cleanupFormatting = false;
  doc.clientID = 4243;
  const root = doc.get('lexical-y');
  doc.transact(() => {
    root.setAttr('lexical-y:1', true);
    root.setAttr('lexical-y-schema:1', true);
    root.setAttr('k:paragraph', 'line');
    let index = 0;
    for (let i = 0; i < lines; i++) {
      root.insert(index, text);
      index += text.length;
      root.insert(index, [new Y.Node('¶')]);
      index += 1;
    }
  });
  return Y.encodeStateAsUpdate(doc);
}

const rootLength = (state: Uint8Array) =>
  createRawYDoc(state).get('lexical-y').length;

const paragraphs = (state: Uint8Array) =>
  readYState(state, CONFIG, () =>
    $getRoot()
      .getChildren()
      .map(p => p.getTextContent()),
  );

/**
 * The smallest power of two of arguments a spread into a call throws on in
 * this runtime (Node's main thread: 131,072; a Vitest worker: 524,288).
 */
function argumentLimit(): number {
  for (let n = 1 << 16; n <= 1 << 24; n *= 2) {
    const items = new Array<string>(n).fill('x');
    try {
      [].push(...(items as never[]));
    } catch {
      return n;
    }
  }
  throw new Error('no argument limit up to 2^24');
}

describe('a layout 1 root container with more units than a call takes as arguments', () => {
  const limit = argumentLimit();
  const LINE = 'x'.repeat(99);
  const cases: [string, number, string][] = [
    // One unit per character and per marker: 100 units a line.
    [
      `lines of 99 characters, over ${limit} units`,
      Math.floor(limit / 100) + 1,
      LINE,
    ],
    // One string item and its marker.
    [`one line of ${limit} characters`, 1, 'y'.repeat(limit)],
  ];
  for (const [name, lines, text] of cases) {
    const input = layout1Document(lines, text);
    test(`${name}: the root holds more units than a call takes`, () => {
      expect(recordedLayout(createRawYDoc(input))).toBe(1);
      expect(rootLength(input)).toBe(lines * (text.length + 1));
      expect(rootLength(input)).toBeGreaterThan(limit);
    });
    for (const gc of [false, true]) {
      test(`${name}: migrates to layout 3 and reads the same (gc ${gc ? 'on' : 'off'})`, () => {
        const result = migrateYState(input, STEPS, {gc});
        expect(result.receipt.changed).toBe(true);
        expect(result.receipt.roots[0].steps.map(s => s.id)).toEqual([
          'lexical-y/layout/1to2',
          'lexical-y/layout/2to3',
        ]);
        expect(recordedLayout(createRawYDoc(result.state, {gc}))).toBe(3);
        expect(rootLength(result.state)).toBe(rootLength(input));
        const read = paragraphs(result.state);
        expect(read.length).toBe(lines);
        expect(read.every(p => p === text)).toBe(true);
      }, 120_000);
    }
  }
});

/** The error `migrateYState` throws on `steps`, or null. */
function migrationError(steps: YLayoutMigration[]): unknown {
  try {
    migrateYState(layout1Document(1, 'abc'), steps);
  } catch (error) {
    return error;
  }
  return null;
}

describe('a step that throws', () => {
  test('in its read: a YMigrationError whose cause is the error', () => {
    const thrown = new RangeError('the read threw');
    const throwing: YLayoutMigration = {
      ...step1to2,
      readBefore: () => {
        throw thrown;
      },
    };
    const error = migrationError([throwing, step2to3]);
    expect(error).toBeInstanceOf(YMigrationError);
    expect(error).toMatchObject({
      code: 'post-condition',
      message: '@lexical/y: a step threw: RangeError: the read threw',
    });
    expect((error as YMigrationError).cause).toBe(thrown);
  });

  test('in its write: a YMigrationError whose cause is the error', () => {
    const thrown = new RangeError('the write threw');
    const throwing: YLayoutMigration = {
      ...step1to2,
      migrateContainer: () => {
        throw thrown;
      },
    };
    const error = migrationError([throwing, step2to3]);
    expect(error).toBeInstanceOf(YMigrationError);
    expect(error).toMatchObject({
      code: 'post-condition',
      message:
        '@lexical/y: step lexical-y/layout/1to2 failed on root lexical-y: the step threw: RangeError: the write threw',
      problems: ['the step threw: RangeError: the write threw'],
      root: 'lexical-y',
    });
    expect((error as YMigrationError).cause).toBe(thrown);
  });
});
