/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Measures the cost of BlockIdExtension on a 10,000-block document. Timing
// is machine-dependent, so this only runs when BLOCK_ID_PERF=1:
//
//   BLOCK_ID_PERF=1 npx vitest --project unit --no-watch \
//     packages/lexical-extension/src/__tests__/unit/BlockIdExtension.perf.test.ts
//
// An editor with the extension and one without it run the same operations,
// interleaved (alternating which goes first), so that drift in the process
// (garbage collection, JIT state, machine load) affects both alike.

import {
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  configExtension,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setState,
  COLLABORATION_TAG,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalNode,
  type NodeKey,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$documentKey} from '../../internal/positionalBlockId';

const BLOCKS = 10000;
const ROUNDS = 300;
const PASTE_ROUNDS = 50;
const WARMUP_ROUNDS = 30;
const LOAD_ROUNDS = 12;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function documentJSON(): string {
  return JSON.stringify({
    root: {
      children: Array.from({length: BLOCKS}, (_, i) => ({
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: `Block ${i} with some text`,
            type: 'text',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        textFormat: 0,
        textStyle: '',
        type: 'paragraph',
        version: 1,
      })),
      direction: null,
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  });
}

interface Subject {
  editor: LexicalEditorWithDispose;
  /** Keys of the original blocks, in document order. */
  keys: NodeKey[];
  load: number;
  /** A deterministic sequence, the same for both editors. */
  next: () => number;
}

function setUp(withIds: boolean, json: string): Subject {
  const editor = buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      RichTextExtension,
      ...(withIds ? [configExtension(BlockIdExtension, {})] : []),
    ],
    name: '[block-id-perf]',
  });
  const start = performance.now();
  editor.setEditorState(editor.parseEditorState(json));
  const load = performance.now() - start;
  const keys = editor.read(() =>
    $getRoot()
      .getChildren()
      .map(node => node.getKey()),
  );
  let seed = 1;
  const next = () => {
    seed = (seed * 16807) % 2147483647;
    return seed;
  };
  return {editor, keys, load, next};
}

function $caret(subject: Subject): LexicalNode {
  const block = $getNodeByKey(subject.keys[subject.next() % BLOCKS])!;
  const text = $isElementNode(block) ? block.getFirstDescendant() : null;
  if ($isTextNode(text)) {
    text.select(3, 3);
  }
  return block;
}

function time(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

const operations = {
  // A duplicate committed without transforms (as a remote merge is), one
  // third and two thirds into the document; the listener queues the repair
  // update and reading flushes it.
  duplicate: (subject: Subject) => {
    const id = `dup${subject.next()}`;
    subject.editor.update(
      () => {
        for (const at of [
          Math.floor(BLOCKS / 3),
          Math.floor((2 * BLOCKS) / 3),
        ]) {
          const node = $getNodeByKey(subject.keys[at]);
          if (node !== null) {
            $setState(node, blockIdState, id);
          }
        }
      },
      {discrete: true, skipTransforms: true, tag: COLLABORATION_TAG},
    );
    subject.editor.read(() => {});
  },
  // Enter in the middle of a block creates one block.
  enter: (subject: Subject) =>
    subject.editor.update(
      () => {
        $caret(subject);
        subject.editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
      },
      {discrete: true},
    ),
  // Typing creates no block.
  keystroke: (subject: Subject) =>
    subject.editor.update(
      () => {
        $caret(subject);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText('x');
        }
      },
      {discrete: true},
    ),
  // Blocks without ids pasted after a random block get fresh ids, generated
  // in a deterministic order.
  paste20: (subject: Subject) => paste(subject, 20),

  paste50: (subject: Subject) => paste(subject, 50),
};

function paste(subject: Subject, count: number): void {
  subject.editor.update(
    () => {
      const anchor = $caret(subject);
      let previous = anchor;
      for (let i = 0; i < count; i++) {
        const block = $createParagraphNode().append($createTextNode(`p${i}`));
        previous.insertAfter(block);
        previous = block;
      }
    },
    {discrete: true},
  );
}

type Operation = keyof typeof operations;

/** Median time of `op` on each subject, interleaved round by round. */
function compare(
  subjects: [Subject, Subject],
  op: Operation,
  rounds: number,
): [number, number] {
  const times: [number[], number[]] = [[], []];
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? [0, 1] : [1, 0];
    for (const i of order) {
      times[i].push(time(() => operations[op](subjects[i])));
    }
  }
  return [median(times[0]), median(times[1])];
}

describe.skipIf(process.env.BLOCK_ID_PERF !== '1')(
  'BlockIdExtension perf',
  () => {
    test(
      `${BLOCKS} blocks: keystroke, Enter, paste and repair overhead`,
      {timeout: 600000},
      () => {
        const json = documentJSON();
        // Warm up the JIT on both configurations first.
        for (const withIds of [false, true, false, true]) {
          setUp(withIds, json).editor.dispose();
        }
        const subjects: [Subject, Subject] = [
          setUp(false, json),
          setUp(true, json),
        ];
        for (const op of Object.keys(operations) as Operation[]) {
          compare(subjects, op, WARMUP_ROUNDS);
        }
        const keystroke = compare(subjects, 'keystroke', ROUNDS);
        const enter = compare(subjects, 'enter', ROUNDS);
        const paste20 = compare(subjects, 'paste20', PASTE_ROUNDS);
        const paste50 = compare(subjects, 'paste50', PASTE_ROUNDS);
        const duplicate = compare(subjects, 'duplicate', PASTE_ROUNDS);
        for (const {editor} of subjects) {
          editor.dispose();
        }
        // A first load of a document stored without ids, in a new editor:
        // with the extension, every block gets a positional id, which hashes
        // the whole document once.
        const loads: [number[], number[]] = [[], []];
        for (let round = 0; round < LOAD_ROUNDS; round++) {
          for (const i of round % 2 === 0 ? [0, 1] : [1, 0]) {
            const subject = setUp(i === 1, json);
            loads[i].push(subject.load);
            subject.editor.dispose();
          }
        }
        const load: [number, number] = [median(loads[0]), median(loads[1])];
        // The same document stored with its ids: nothing to name, so no
        // document key.
        const named = setUp(true, json);
        const withIdsJSON = JSON.stringify(
          named.editor.getEditorState().toJSON(),
        );
        named.editor.dispose();
        const namedLoads: [number[], number[]] = [[], []];
        for (let round = 0; round < LOAD_ROUNDS; round++) {
          for (const i of round % 2 === 0 ? [0, 1] : [1, 0]) {
            const subject = setUp(i === 1, withIdsJSON);
            namedLoads[i].push(subject.load);
            subject.editor.dispose();
          }
        }
        const namedLoad: [number, number] = [
          median(namedLoads[0]),
          median(namedLoads[1]),
        ];
        // Of which: the document key (compact export, canonical JSON,
        // SHA-256 of about 1 MB).
        const keyed = setUp(true, json);
        const keyTimes: number[] = [];
        for (let round = 0; round < LOAD_ROUNDS; round++) {
          keyTimes.push(time(() => keyed.editor.read($documentKey)));
        }
        keyed.editor.dispose();
        const keyTime = median(keyTimes);
        const row = (name: string, [a, b]: [number, number]) =>
          `${name.padEnd(24)} ${a.toFixed(3).padStart(9)} ms ${b
            .toFixed(3)
            .padStart(9)} ms ${(b - a).toFixed(3).padStart(9)} ms`;
        // eslint-disable-next-line no-console
        console.log(
          [
            `${BLOCKS} blocks, median, interleaved  without      with     delta`,
            row(`keystroke (${ROUNDS})`, keystroke),
            row(`Enter (${ROUNDS})`, enter),
            row(`paste 20 blocks (${PASTE_ROUNDS})`, paste20),
            row(`paste 50 blocks (${PASTE_ROUNDS})`, paste50),
            row(`remote duplicate (${PASTE_ROUNDS})`, duplicate),
            row(`first load, no ids (${LOAD_ROUNDS})`, load),
            `  of which document key: ${keyTime.toFixed(3)} ms`,
            row(`load, ids stored (${LOAD_ROUNDS})`, namedLoad),
          ].join('\n'),
        );
        // Typing creates no block: no measurable cost.
        expect(keystroke[1]).toBeLessThan(keystroke[0] * 1.05 + 0.5);
        // Enter assigns one id. The extension's own work is ~0.1 ms here; the
        // rest is Lexical running the root transforms a second time because a
        // transform changed a node (see the PR for the profile).
        expect(enter[1]).toBeLessThan(enter[0] * 1.25 + 0.5);
        // Pasting assigns ids to the new blocks only.
        expect(paste50[1]).toBeLessThan(paste50[0] * 1.25 + 1);
      },
    );
  },
);
