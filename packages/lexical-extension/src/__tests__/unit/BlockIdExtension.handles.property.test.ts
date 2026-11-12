/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Property test of block handles, with fast-check: random documents with
// random ids (random 21-character ids, ids that share long prefixes with
// others, ids shorter than 4 characters) and random edits: inserts, deletes,
// moves, replaces, and blocks given an id that shares an existing prefix.
// After every edit:
//
// - each block's handle is the brute-force shortest unique prefix, at least
//   MIN_BLOCK_HANDLE_LENGTH characters long, of the hash key of its id;
// - each handle, and each whole id, resolves to its own block;
// - the handles of the previous read, resolved with that read, name the
//   blocks they named then, or are not found once those are deleted;
// - consistency of typos with the handle table: a one-character change of a
//   handle (substitute, drop, add) resolves to a different block only as
//   that block's id or a prefix of its key that starts with its current
//   handle. (How rarely that happens, the typo-safety claim, is asserted by
//   the rate checks here and in BlockIdExtension.handles.test.ts.)
//
// The default run is small. Set BLOCK_HANDLE_PROPERTY_RUNS to run more
// documents locally, and BLOCK_HANDLE_TYPO_DOCS to measure and print handle
// lengths and the rate at which a one-character typo names another block in
// documents of 1,000 ids of each shape (random, `@lexical/y`-style derived,
// UUIDv7), skipped otherwise.

import {
  $getBlockById,
  $getBlockHandle,
  $getBlockHandles,
  $getBlockId,
  $resolveBlockHandle,
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  configExtension,
  generateBlockId,
  type LexicalEditorWithDispose,
  MIN_BLOCK_HANDLE_LENGTH,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import * as fc from 'fast-check';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setState,
  HISTORY_MERGE_TAG,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {HANDLE_KEY_LENGTH, handleKey} from '../../internal/blockHandles';

const RUNS = Number(process.env.BLOCK_HANDLE_PROPERTY_RUNS || 15);
const TYPO_DOCS = Number(process.env.BLOCK_HANDLE_TYPO_DOCS || 0);
const TYPO_BLOCKS = 1000;

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const idString = (minLength: number, maxLength: number) =>
  fc.string({maxLength, minLength, unit: fc.constantFrom(...ALPHABET)});

/**
 * An id, resolved against the ids before it: random and 21 characters long,
 * shorter than 4 characters, or a prefix (1 to 10 characters) of an earlier
 * id followed by a random tail.
 */
type IdSpec =
  | {readonly kind: 'random' | 'short'; readonly id: string}
  | {
      readonly kind: 'shared';
      readonly base: number;
      readonly prefix: number;
      readonly tail: string;
    };

const idSpec: fc.Arbitrary<IdSpec> = fc.oneof(
  {
    arbitrary: idString(21, 21).map(id => ({id, kind: 'random' as const})),
    weight: 3,
  },
  {
    arbitrary: idString(1, 3).map(id => ({id, kind: 'short' as const})),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      base: fc.nat(),
      kind: fc.constant('shared' as const),
      prefix: fc.integer({max: 10, min: 1}),
      tail: idString(1, 17),
    }),
    weight: 4,
  },
);

function resolveId(spec: IdSpec, earlier: readonly string[]): string {
  if (spec.kind !== 'shared' || earlier.length === 0) {
    return spec.kind === 'shared' ? spec.tail : spec.id;
  }
  const base = earlier[spec.base % earlier.length];
  return base.slice(0, spec.prefix) + spec.tail;
}

type Edit =
  | {readonly kind: 'insert'; readonly at: number; readonly id: IdSpec}
  | {readonly kind: 'delete' | 'replace'; readonly at: number}
  | {readonly kind: 'move'; readonly at: number; readonly to: number};

const edit: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({at: fc.nat(), id: idSpec, kind: fc.constant('insert' as const)}),
  fc.record({at: fc.nat(), kind: fc.constant('delete' as const)}),
  fc.record({at: fc.nat(), kind: fc.constant('replace' as const)}),
  fc.record({at: fc.nat(), kind: fc.constant('move' as const), to: fc.nat()}),
);

/**
 * The shortest prefix of `id`'s hash key, at least 4 long, that no other
 * id's key starts with (or the whole key).
 */
function bruteForceHandle(id: string, ids: readonly string[]): string {
  const key = handleKey(id);
  const others = ids.filter(other => other !== id).map(handleKey);
  let length = MIN_BLOCK_HANDLE_LENGTH;
  while (
    length < key.length &&
    others.some(other => other.startsWith(key.slice(0, length)))
  ) {
    length++;
  }
  return key.slice(0, length);
}

/** Every string one substitution, deletion or insertion away from `s`. */
function oneCharTypos(s: string): string[] {
  const result = new Set<string>();
  for (let i = 0; i < s.length; i++) {
    result.add(s.slice(0, i) + s.slice(i + 1));
    for (const c of ALPHABET) {
      result.add(s.slice(0, i) + c + s.slice(i + 1));
    }
  }
  for (let i = 0; i <= s.length; i++) {
    for (const c of ALPHABET) {
      result.add(s.slice(0, i) + c + s.slice(i));
    }
  }
  result.delete(s);
  return Array.from(result);
}

function asEdited<T extends LexicalEditor>(editor: T): T {
  const options = {discrete: true, tag: HISTORY_MERGE_TAG} as const;
  editor.update(() => {
    $getRoot().append($createParagraphNode());
  }, options);
  editor.update(() => {
    $getRoot().clear();
  }, options);
  return editor;
}

function $paragraph(text: string): LexicalNode {
  return $createParagraphNode().append($createTextNode(text));
}

interface Typo {
  /** Strings tried. */
  tried: number;
  /** Of those, the ones that resolved to another block. */
  hits: number;
  /** Of the hits, the ones that were exactly that block's handle. */
  exact: number;
}

/**
 * Checks every invariant on the current state, the typo property on the
 * blocks `typoSample` picks, and returns the typo counts.
 */
function check(
  editor: LexicalEditor,
  typoSample: (index: number) => boolean,
  context: string,
): Typo {
  return editor.read(() => {
    const blocks = $getRoot().getChildren();
    const ids = blocks.map(node => $getBlockId(node)!);
    expect(new Set(ids).size, context).toBe(ids.length);
    const handles = $getBlockHandles();
    expect(handles.size, context).toBe(ids.length);
    const handleOfId = new Map<string, string>();
    for (let i = 0; i < blocks.length; i++) {
      const id = ids[i];
      const handle = $getBlockHandle(blocks[i])!;
      expect(handle, `${context} handle of ${id}`).toBe(
        bruteForceHandle(id, ids),
      );
      expect(handles.get(id), context).toBe(handle);
      handleOfId.set(id, handle);
      // A whole id is accepted when it is longer than any handle.
      for (const input of id.length > HANDLE_KEY_LENGTH
        ? [handle, id]
        : [handle]) {
        const result = $resolveBlockHandle(input);
        assert(
          result.status === 'found' && result.node.is(blocks[i]),
          `${context}: ${input} → ${JSON.stringify(result.status)}`,
        );
      }
    }
    const typo: Typo = {exact: 0, hits: 0, tried: 0};
    for (let i = 0; i < blocks.length; i++) {
      if (!typoSample(i)) {
        continue;
      }
      for (const s of oneCharTypos(handleOfId.get(ids[i])!)) {
        typo.tried++;
        const result = $resolveBlockHandle(s);
        if (result.status === 'found' && !result.node.is(blocks[i])) {
          typo.hits++;
          const otherId = $getBlockId(result.node)!;
          const otherHandle = handleOfId.get(otherId)!;
          if (s === otherHandle) {
            typo.exact++;
          }
          assert(
            s === otherId ||
              (handleKey(otherId).startsWith(s) && s.startsWith(otherHandle)),
            `${context}: typo ${s} of ${handleOfId.get(ids[i])} named ${otherId} (handle ${otherHandle})`,
          );
        } else if (result.status === 'ambiguous') {
          for (const candidate of result.candidates) {
            expect(Array.from(handleOfId.values()), context).toContain(
              candidate,
            );
          }
        }
      }
    }
    return typo;
  });
}

function runDocument(
  specs: readonly IdSpec[],
  batches: readonly (readonly Edit[])[],
): void {
  const ids: string[] = [];
  for (const spec of specs) {
    const id = resolveId(spec, ids);
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  let n = 0;
  using editor: LexicalEditorWithDispose = asEdited(
    buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        // Only for blocks whose id is taken (edits bring their own ids):
        // longer than any generated id (at most 27 characters), so never one.
        configExtension(BlockIdExtension, {
          generateId: () => `${'F'.repeat(28)}${++n}`,
        }),
      ],
      name: '[block-handle-property]',
    }),
  );
  editor.update(
    () => {
      for (const id of ids) {
        const block = $paragraph(id);
        $setState(block, blockIdState, id);
        $getRoot().append(block);
      }
    },
    {discrete: true},
  );
  let previous = editor.read($getBlockHandles);
  check(editor, () => true, `initial ${JSON.stringify(ids)}`);
  for (const [step, batch] of batches.entries()) {
    // Each batch of edits is one update.
    editor.update(
      () => {
        for (const op of batch) {
          const blocks = $getRoot().getChildren();
          const at = blocks[op.at % blocks.length];
          if (op.kind === 'insert' || blocks.length < 3) {
            // Blocks inserted earlier in this update have no id yet.
            const current = blocks
              .map(block => $getBlockId(block))
              .filter((id): id is string => id !== null);
            const block = $paragraph(`t${step}`);
            if (op.kind === 'insert') {
              $setState(block, blockIdState, resolveId(op.id, current));
            }
            at.insertAfter(block);
          } else if (op.kind === 'delete') {
            at.remove();
          } else if (op.kind === 'move') {
            const target = blocks[op.to % blocks.length];
            if (!target.is(at)) {
              target.insertAfter(at);
            }
          } else {
            at.replace($paragraph(`r${step}`));
          }
        }
      },
      {discrete: true},
    );
    // The handles of the previous read name the blocks they named then,
    // while those exist.
    editor.read(() => {
      for (const [id, handle] of previous) {
        const result = $resolveBlockHandle(handle, {read: previous});
        const node = $getBlockById(id);
        if (node === null) {
          expect(result.status, `step ${step} ${handle}`).toBe('not-found');
        } else {
          assert(
            result.status === 'found' && result.node.is(node),
            `step ${step} ${handle} → ${result.status}`,
          );
        }
      }
    });
    previous = editor.read($getBlockHandles);
    check(
      editor,
      () => true,
      `step ${step} (${batch.map(op => op.kind).join(', ')})`,
    );
  }
}

describe('block handles: property', () => {
  test(
    'handles, resolution and typo safety under random ids and edits',
    () => {
      fc.assert(
        fc.property(
          fc.array(idSpec, {maxLength: 40, minLength: 3}),
          fc.array(fc.array(edit, {maxLength: 3, minLength: 1}), {
            maxLength: 10,
          }),
          (specs, batches) => runDocument(specs, batches),
        ),
        {
          // Also: an insert that repeats an id (its copy gets a fallback id),
          // with every short counter-like id already taken.
          examples: [
            [
              Array.from({length: 32}, (_, i) => ({
                id: `zz${i + 1}`,
                kind: 'random' as const,
              })),
              [
                [
                  {
                    at: 0,
                    id: {id: 'zz1', kind: 'short' as const},
                    kind: 'insert',
                  },
                ],
              ],
            ],
          ],
          numRuns: RUNS,
        },
      );
    },
    Math.max(5000, RUNS * 100),
  );

  // Ids of one shape for a typo-rate document: random 21-character ids,
  // `@lexical/y`-style derived ids (one client, increasing clocks), and
  // UUIDv7s made 0 to 2 ms apart.
  const shapes: Record<string, (doc: number) => string[]> = {
    derived: doc => {
      const client = (doc * 7919 + 104729) * 2 ** 20;
      let clock = 0;
      return Array.from({length: TYPO_BLOCKS}, (_, i) => {
        clock += 10 + ((i * 37) % 70);
        return `y${client.toString(36)}_${clock.toString(36)}`;
      });
    },
    random: () => Array.from({length: TYPO_BLOCKS}, generateBlockId),
    uuidv7: doc => {
      let ms = 1793357300000 + doc * 10000000;
      return Array.from({length: TYPO_BLOCKS}, (_, i) => {
        ms += i % 3;
        const time = ms.toString(16).padStart(12, '0');
        const rest = generateBlockId()
          .split('')
          .map(c => (c.charCodeAt(0) % 16).toString(16))
          .join('');
        return `${time.slice(0, 8)}-${time.slice(8)}-7${rest.slice(0, 3)}-a${rest.slice(3, 6)}-${rest.slice(6, 18)}`;
      });
    },
  };

  test.skipIf(TYPO_DOCS === 0)(
    `one-character typo rate and handle length, ${TYPO_BLOCKS}-block documents`,
    () => {
      const lines: string[] = [];
      for (const [shape, makeIds] of Object.entries(shapes)) {
        let tried = 0;
        let hits = 0;
        let exact = 0;
        const lengths: number[] = [];
        for (let doc = 0; doc < TYPO_DOCS; doc++) {
          using editor = buildEditorFromExtensions({
            $initialEditorState: null,
            dependencies: [RichTextExtension, BlockIdExtension],
            name: '[block-handle-typo-rate]',
          });
          editor.setEditorState(
            editor.parseEditorState({
              root: {
                children: makeIds(doc).map((id, i) => ({
                  $: {blockId: id},
                  children: [{text: `Block ${i}`, type: 'text'}],
                  type: 'paragraph',
                })),
                type: 'root',
              },
            } as never),
          );
          const typo = check(editor, () => true, `${shape} doc ${doc}`);
          tried += typo.tried;
          hits += typo.hits;
          exact += typo.exact;
          for (const handle of editor.read($getBlockHandles).values()) {
            lengths.push(handle.length);
          }
        }
        // Handles are almost all 4 characters long, whatever the ids look
        // like. A one-character change gives a 3-character string (never a
        // handle), or a 4- or 5-character one that names another block only
        // if it is that block's handle (about 1,000 of 64^4 four-character
        // strings).
        expect(hits / tried, shape).toBeLessThan(1e-3);
        expect(Math.max(...lengths), shape).toBeLessThanOrEqual(6);
        const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
        lines.push(
          `${shape}: handle length mean ${mean.toFixed(2)}, max ` +
            `${Math.max(...lengths)}; ${hits} of ${tried} one-character ` +
            `typos named another block: ${(hits / tried).toExponential(2)} ` +
            `(${exact} of them exactly that block's handle)`,
        );
      }
      // Only when asked for (BLOCK_HANDLE_TYPO_DOCS), so nothing is printed
      // on an ordinary run.
      // eslint-disable-next-line no-console
      console.log(
        `block handles, ${TYPO_DOCS} × ${TYPO_BLOCKS} blocks per shape:\n` +
          lines.join('\n'),
      );
    },
    60000 * Math.max(TYPO_DOCS, 1),
  );
});
