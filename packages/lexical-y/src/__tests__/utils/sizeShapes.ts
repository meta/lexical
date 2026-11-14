/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Documents with more content in one container than a call can take as
// arguments, through every path that reads or writes a whole container:
// the binding's first write (writer), a fresh binding's load (reader), an
// edit both ways, the headless read, seed and edit, a migration from
// layout 1, and 3to4 on a layout 3 document with flat NodeState. The `unit-size` project runs this file on a child process's main
// thread, whose argument limit (131,072 on Node) is the one production code
// runs under; the documents are sized past the limit of the runtime they run
// in, and past 130,000 units in any case. A list of content spread into a
// call's arguments throws `RangeError: Maximum call stack size exceeded`
// here (#9880 was one in the migration runner).

//
// Each file under __tests__/size/ registers one shape or one migration
// (describeShape, describeMigration, describeMigration3to4), so the project
// runs them in parallel.

import {$createLinkNode} from '@lexical/link';
import * as Y from '@y/y';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  createEditor,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  createYWriter,
  editYState,
  readYState,
  seedYState,
} from '../../headless';
import {createRawYDoc} from '../../internal/RawYDoc';
import {migrateYState} from '../../migrate';
import step1to2 from '../../migrate/1to2';
import step2to3 from '../../migrate/2to3';
import step3to4 from '../../migrate/3to4';
import {freshReader, NODES, setup} from './harness';

/**
 * The smallest power of two of arguments a spread into a call throws on in
 * this runtime (Node's main thread: 131,072; a worker thread: 524,288).
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

export const LIMIT = argumentLimit();
/** Units in the one container: past the limit, and past 130,000. */
export const UNITS = Math.max(130_000, LIMIT) + 4_096;

const CONFIG = {nodes: NODES, onWarn: () => {}, schemaVersion: 1};
const WRITER = createYWriter('lexical-y-size-test');

/** A document shape: how to build it, and how many units its line holds. */
export type Shape = {
  name: string;
  $build: () => void;
};

export const SHAPES: Shape[] = [
  {
    // One string item: the line's text is one unit per character.
    $build: () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('y'.repeat(UNITS))),
      );
    },
    name: `one line of ${UNITS} characters`,
  },
  {
    // The root's lines: each line's text and its marker.
    $build: () => {
      const lines = Math.ceil(UNITS / 3);
      const paragraphs: LexicalNode[] = [];
      for (let i = 0; i < lines; i++) {
        paragraphs.push($createParagraphNode().append($createTextNode('ab')));
      }
      appendAll($getRoot(), paragraphs);
    },
    name: `${Math.ceil(UNITS / 3)} lines of 2 characters`,
  },
  {
    // More lines than a call takes: one child of the root each.
    $build: () => {
      const paragraphs: LexicalNode[] = [];
      for (let i = 0; i < UNITS; i++) {
        paragraphs.push($createParagraphNode().append($createTextNode('c')));
      }
      appendAll($getRoot(), paragraphs);
    },
    name: `${UNITS} lines of 1 character`,
  },
  {
    // One line of many inline nodes: a text and a line break each.
    $build: () => {
      const children: LexicalNode[] = [];
      for (let i = 0; i < UNITS / 2; i++) {
        children.push($createTextNode('d'), $createLineBreakNode());
      }
      $getRoot().append(appendAll($createParagraphNode(), children));
    },
    name: `one line of ${UNITS / 2} texts and line breaks`,
  },
  {
    // One line holding a link of many inline nodes.
    $build: () => {
      const children: LexicalNode[] = [];
      for (let i = 0; i < UNITS / 2; i++) {
        children.push($createTextNode('e'), $createLineBreakNode());
      }
      $getRoot().append(
        $createParagraphNode().append(
          appendAll($createLinkNode('https://example.com'), children),
        ),
      );
    },
    name: `one line holding a link of ${UNITS / 2} texts and line breaks`,
  },
];

/** `parent.append(...nodes)` for any number of nodes (a test's own build). */
function appendAll(parent: ElementNode, nodes: LexicalNode[]): ElementNode {
  for (let i = 0; i < nodes.length; i += 4096) {
    parent.append(...nodes.slice(i, i + 4096));
  }
  return parent;
}

/** The root's block at `index` (from the end when negative). */
function $block(index: number): ElementNode {
  const root = $getRoot();
  const block = root.getChildAtIndex(
    index < 0 ? root.getChildrenSize() + index : index,
  );
  if (!$isElementNode(block)) {
    throw new Error(`no block at ${index}`);
  }
  return block;
}

/** A compact description of the root: block count, text and line breaks. */
function $summary(): {blocks: number; text: number; breaks: number} {
  let text = 0;
  let breaks = 0;
  const stack: LexicalNode[] = [$getRoot()];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        stack.push(child);
      }
    } else if ($isLineBreakNode(node)) {
      breaks++;
    } else {
      text += node.getTextContentSize();
    }
  }
  return {blocks: $getRoot().getChildrenSize(), breaks, text};
}

/** The summary of `shape` built in a plain editor. */
function expectedOf(shape: Shape): ReturnType<typeof $summary> {
  const editor = createEditor({
    namespace: 'size',
    nodes: NODES,
    onError: error => {
      throw error;
    },
  });
  editor.update(
    () => {
      $getRoot().clear();
      shape.$build();
    },
    {discrete: true},
  );
  return editor.read($summary);
}

/** Registers a shape's tests (each file under size/ registers one). */
export function describeShape(shape: Shape): void {
  describe('the runtime this file runs in', () => {
    test('takes no more arguments than a main thread', () => {
      expect(LIMIT).toBeLessThanOrEqual(131_072);
      expect(UNITS).toBeGreaterThan(130_000);
    });
  });
  describe(shape.name, () => {
    for (const gc of [false, true]) {
      test(`binding write, fresh load, edits both ways, headless read/seed/edit (gc ${gc ? 'on' : 'off'})`, async () => {
        const {a, sync} = await setup(shape.$build, {gc, ids: [1]});
        expect(a.errors).toEqual([]);
        const expected = a.read($summary);
        const root = a.doc.get('lexical-y');
        expect(root.length).toBeGreaterThan(LIMIT);

        // A fresh binding loads it.
        const b = await freshReader(a);
        expect(b.errors).toEqual([]);
        expect(b.read($summary)).toEqual(expected);

        // An edit in the loaded editor, deep in the container, reaches A.
        b.update(() => {
          const last = $block(-1);
          last.append($createTextNode('!'));
          $block(0).append($createTextNode('?'));
        });
        Y.applyUpdate(
          a.doc,
          Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)),
        );
        await sync();
        const edited = {...expected, text: expected.text + 2};
        expect(a.read($summary)).toEqual(edited);
        expect(b.read($summary)).toEqual(edited);

        // And one from A reaches B.
        a.update(() => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('end')),
          );
        });
        Y.applyUpdate(
          b.doc,
          Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
        );
        await sync();
        const appended = {
          ...edited,
          blocks: edited.blocks + 1,
          text: edited.text + 3,
        };
        expect(b.read($summary)).toEqual(appended);
        expect(a.errors).toEqual([]);
        expect(b.errors).toEqual([]);

        // Saved, it reads headless the same, and a headless edit writes.
        const saved = Y.encodeStateAsUpdate(a.doc);
        expect(readYState(saved, CONFIG, $summary)).toEqual(appended);
        const result = editYState(
          saved,
          CONFIG,
          () => {
            $block(0).append($createTextNode('#'));
          },
          {writer: WRITER},
        );
        expect(result.update).not.toBeNull();
        const after = Y.mergeUpdates([
          saved as Uint8Array<ArrayBuffer>,
          result.update as Uint8Array<ArrayBuffer>,
        ]);
        expect(readYState(after, CONFIG, $summary)).toEqual({
          ...appended,
          text: appended.text + 1,
        });
      }, 600_000);
    }

    test('headless seed reads back the same', () => {
      const seeded = seedYState(CONFIG, shape.$build);
      expect(readYState(seeded, CONFIG, $summary)).toEqual(expectedOf(shape));
    }, 600_000);
  });
}

/**
 * A layout 1 document of `lines` top-level paragraphs, each holding `text`
 * (see MigrateLargeContainer.test.ts).
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

/** Registers a migration's tests: `lines` lines of `text`, from layout 1. */
export function describeMigration(lines: number, text: string): void {
  const name =
    lines === 1
      ? `one line of ${text.length} characters`
      : `${lines} lines of ${text.length} characters`;
  describe('a layout 1 document past the limit migrates on the main thread', () => {
    test('the runtime takes no more arguments than a main thread', () => {
      expect(LIMIT).toBeLessThanOrEqual(131_072);
      expect(UNITS).toBeGreaterThan(130_000);
    });
    for (const gc of [false, true]) {
      test(`${name} (gc ${gc ? 'on' : 'off'})`, () => {
        const input = layout1Document(lines, text);
        const result = migrateYState(input, [step1to2, step2to3, step3to4], {
          gc,
        });
        expect(result.receipt.changed).toBe(true);
        const read = readYState(result.state, CONFIG, () =>
          $getRoot()
            .getChildren()
            .map(p => p.getTextContent()),
        );
        expect(read.length).toBe(lines);
        expect(read.every(p => p === text)).toBe(true);
      }, 600_000);
    }
  });
}

/**
 * A layout 3 document of `lines` lines of `text` (2to3's output, gc off),
 * with a raw writer's flat NodeState (`s:color`, plain values, as layout 3
 * stored it) over a stretch of 50 units every 997 units.
 */
function layout3Document(lines: number, text: string): Uint8Array {
  const three = migrateYState(
    layout1Document(lines, text),
    [step1to2, step2to3],
    {gc: false, to: 3},
  ).state;
  const doc = createRawYDoc(three, {gc: false});
  doc.clientID = 4244;
  const root = doc.get('lexical-y');
  const n = root.length;
  doc.transact(() => {
    for (let at = 1; at + 50 < n; at += 997) {
      root.format(at, 50, {'s:color': at % 2 === 0 ? 'red' : 'blue'});
    }
  });
  return Y.encodeStateAsUpdate(doc);
}

/**
 * Registers 3to4's tests: a layout 3 document of `lines` lines of `text`
 * with flat NodeState over it, rewritten as paired runs.
 */
export function describeMigration3to4(lines: number, text: string): void {
  const name =
    lines === 1
      ? `one line of ${text.length} characters`
      : `${lines} lines of ${text.length} characters`;
  describe('a layout 3 document past the limit migrates to layout 4 on the main thread', () => {
    test('the runtime takes no more arguments than a main thread', () => {
      expect(LIMIT).toBeLessThanOrEqual(131_072);
      expect(UNITS).toBeGreaterThan(130_000);
    });
    const input = layout3Document(lines, text);
    for (const gc of [false, true]) {
      test(`${name}, flat NodeState (gc ${gc ? 'on' : 'off'})`, () => {
        const result = migrateYState(input, [step3to4], {gc});
        expect(result.receipt.roots[0].steps.map(s => s.id)).toEqual([
          'lexical-y/layout/3to4',
        ]);
        const read = readYState(result.state, CONFIG, () =>
          $getRoot()
            .getChildren()
            .map(p => p.getTextContent()),
        );
        expect(read.length).toBe(lines);
        expect(read.every(p => p === text)).toBe(true);
      }, 600_000);
    }
  });
}
