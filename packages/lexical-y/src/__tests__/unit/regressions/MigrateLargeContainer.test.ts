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
//
// The same for the 3to4 step: a layout 3 root container past the
// limit, with flat NodeState over it (rewritten) and without (left as it
// is, step 0), as one long line and as many short lines, migrates to layout
// 4 and reads the same; the layout 4 reader reads it and the writer edits
// it. Run this file with `--pool=forks` too: its stack is the main
// thread's, whose argument limit is the smallest.

import * as Y from '@y/y';
import {
  $createTextNode,
  $getRoot,
  $getState,
  $isElementNode,
  $isTextNode,
  $setState,
  createState,
  type ElementNode,
  stringValue,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {editYState, readYState} from '../../../headless';
import {createRawYDoc} from '../../../internal/RawYDoc';
import {
  getYLayoutInfo,
  migrateYState,
  type YLayoutMigration,
  type YLayoutStep,
  YMigrationError,
} from '../../../migrate';
import step1to2 from '../../../migrate/1to2';
import step2to3 from '../../../migrate/2to3';
import step3to4 from '../../../migrate/3to4';
import step4to5 from '../../../migrate/4to5';
import {NODES} from '../../utils/harness';

const STEPS = [step1to2, step2to3, step3to4, step4to5];
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
      test(`${name}: migrates to layout 5 and reads the same (gc ${gc ? 'on' : 'off'})`, () => {
        const result = migrateYState(input, STEPS, {gc});
        expect(result.receipt.changed).toBe(true);
        expect(result.receipt.roots[0].steps.map(s => s.id)).toEqual([
          'lexical-y/layout/1to2',
          'lexical-y/layout/2to3',
          'lexical-y/layout/3to4',
          'lexical-y/layout/4to5',
        ]);
        expect(recordedLayout(createRawYDoc(result.state, {gc}))).toBe(5);
        expect(rootLength(result.state)).toBe(rootLength(input));
        const read = paragraphs(result.state);
        expect(read.length).toBe(lines);
        expect(read.every(p => p === text)).toBe(true);
      }, 120_000);
    }
  }
});

const color = createState('color', {parse: stringValue()});

/**
 * A layout 3 document from `layout1Document(lines, text)` (2to3's output,
 * gc off), with a raw writer's flat NodeState (`s:color`, plain values, as
 * layout 3 stored it) over every `every`-th stretch of 50 units when
 * `every` is not null.
 */
function layout3Document(
  lines: number,
  text: string,
  every: number | null,
): Uint8Array {
  const three = migrateYState(layout1Document(lines, text), STEPS, {
    gc: false,
    to: 3,
  }).state;
  if (every === null) {
    return three;
  }
  const doc = createRawYDoc(three, {gc: false});
  doc.clientID = 4244;
  const root = doc.get('lexical-y');
  const n = root.length;
  doc.transact(() => {
    for (let at = 1; at + 50 < n; at += every) {
      root.format(at, 50, {'s:color': at % 2 === 0 ? 'red' : 'blue'});
    }
  });
  return Y.encodeStateAsUpdate(doc);
}

/** The text nodes' colors, as runs "color x length". */
const colorRuns = (state: Uint8Array) =>
  readYState(state, CONFIG, () => {
    const out: string[] = [];
    for (const p of $getRoot().getChildren()) {
      if (!$isElementNode(p)) {
        continue;
      }
      for (const t of p.getChildren()) {
        if ($isTextNode(t)) {
          out.push(`${$getState(t, color) || '-'} x ${t.getTextContentSize()}`);
        }
      }
    }
    return out;
  });

describe('3to4 on a layout 3 root container with more units than a call takes', () => {
  const limit = Math.max(argumentLimit(), 130_000);
  const LINE = 'x'.repeat(99);
  const cases: [string, number, string][] = [
    [
      `lines of 99 characters, over ${limit} units`,
      Math.floor(limit / 100) + 1,
      LINE,
    ],
    [`one line of ${limit} characters`, 1, 'y'.repeat(limit)],
  ];
  for (const [name, lines, text] of cases) {
    for (const every of [null, 997]) {
      const what = every === null ? 'no flat state' : 'flat state';
      const input = layout3Document(lines, text, every);
      for (const gc of [false, true]) {
        test(`${name}, ${what}: migrates to layout 4, reads the same, and edits (gc ${gc ? 'on' : 'off'})`, () => {
          expect(recordedLayout(createRawYDoc(input))).toBe(3);
          expect(rootLength(input)).toBeGreaterThan(limit);
          const result = migrateYState(input, [step3to4, step4to5], {gc});
          expect(result.receipt.roots[0].steps.map(s => s.id)).toEqual([
            'lexical-y/layout/3to4',
            'lexical-y/layout/4to5',
          ]);
          expect(recordedLayout(createRawYDoc(result.state, {gc}))).toBe(5);
          expect(rootLength(result.state)).toBe(rootLength(input));
          const read = paragraphs(result.state);
          expect(read.length).toBe(lines);
          expect(read.every(p => p === text)).toBe(true);
          const runs = colorRuns(result.state);
          if (every === null) {
            expect(runs.every(r => r.startsWith('- '))).toBe(true);
          } else {
            expect(
              runs.filter(r => r.startsWith('red ')).length,
            ).toBeGreaterThan(10);
          }
          // The writer: a value over the last line's end and a word after it.
          const edited = editYState(
            result.state,
            CONFIG,
            () => {
              const last = $getRoot().getLastChildOrThrow() as ElementNode;
              const t = last.getLastChildOrThrow();
              if ($isTextNode(t)) {
                const [, tail] = t.splitText(t.getTextContentSize() - 3);
                $setState(tail, color, 'green');
              }
              last.append($createTextNode(' end'));
            },
            {writer: null},
          );
          const after = paragraphs(edited.state);
          expect(after[after.length - 1]).toBe(text + ' end');
          expect(colorRuns(edited.state).some(r => r === 'green x 3')).toBe(
            true,
          );
        }, 300_000);
      }
    }
  }
});

/** The error `migrateYState` throws on `steps`, or null. */
function migrationError(steps: YLayoutStep[]): unknown {
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
    const error = migrationError([throwing, step2to3, step3to4, step4to5]);
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
    const error = migrationError([throwing, step2to3, step3to4, step4to5]);
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
