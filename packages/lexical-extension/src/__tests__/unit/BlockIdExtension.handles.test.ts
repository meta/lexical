/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

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
  getExtensionDependencyFromEditor,
  type LexicalEditorWithDispose,
  MIN_BLOCK_HANDLE_LENGTH,
} from '@lexical/extension';
import {HeadlessExtension} from '@lexical/headless';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setState,
  COLLABORATION_TAG,
  HISTORY_MERGE_TAG,
  type LexicalEditor,
  type SerializedEditorState,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {
  buildHandleTable,
  HANDLE_KEY_LENGTH,
  handleInTable,
  handleKey,
  idsWithPrefix,
} from '../../internal/blockHandles';

/** A generateId that hands out `ids` in order, then a counter. */
function fixedIds(ids: readonly string[]): () => string {
  let i = 0;
  let n = 0;
  return () => (i < ids.length ? ids[i++] : `zz${++n}`);
}

/**
 * The first content an empty editor gets is a load, which gets positional
 * ids. These editors have had content once, so the blocks the tests add get
 * the ids of `generateId`.
 */
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

function build(
  ids: readonly string[],
  options: {disabled?: boolean; headless?: boolean} = {},
): LexicalEditorWithDispose {
  return asEdited(
    buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        ...(options.headless ? [HeadlessExtension] : []),
        RichTextExtension,
        ListExtension,
        configExtension(BlockIdExtension, {
          disabled: options.disabled || false,
          generateId: fixedIds(ids),
        }),
      ],
      name: '[block-handle-test]',
    }),
  );
}

/** An editor holding one paragraph per id, loaded from JSON. */
function load(
  ids: readonly string[],
  options: {disabled?: boolean} = {},
): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      RichTextExtension,
      configExtension(BlockIdExtension, {disabled: options.disabled || false}),
    ],
    name: '[block-handle-load]',
  });
  editor.setEditorState(
    editor.parseEditorState({
      root: {
        children: ids.map((id, i) => ({
          $: {blockId: id},
          children: [{text: `Block ${i}`, type: 'text'}],
          type: 'paragraph',
        })),
        type: 'root',
      },
    } as never),
  );
  return editor;
}

function update(editor: LexicalEditor, fn: () => void, tag?: string): void {
  editor.update(fn, {discrete: true, tag});
}

/** Appends one paragraph per text and returns their ids. */
function appendParagraphs(editor: LexicalEditor, texts: string[]): string[] {
  update(editor, () => {
    for (const text of texts) {
      $getRoot().append($createParagraphNode().append($createTextNode(text)));
    }
  });
  return editor.read(() =>
    $getRoot()
      .getChildren()
      .slice(-texts.length)
      .map(node => $getBlockId(node)!),
  );
}

/** Id → handle of every top-level block, through $getBlockHandle. */
function handlesOf(editor: LexicalEditor): Record<string, string | null> {
  return editor.read(() =>
    Object.fromEntries(
      $getRoot()
        .getChildren()
        .map(node => [$getBlockId(node), $getBlockHandle(node)]),
    ),
  );
}

function resolve(editor: LexicalEditor, handle: string) {
  return editor.read(() => {
    const result = $resolveBlockHandle(handle);
    return result.status === 'found'
      ? {id: $getBlockId(result.node), status: result.status}
      : result;
  });
}

/** The shortest prefix of `id`'s key, at least 4 long, no other key starts. */
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

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

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

/**
 * The handle lengths of every block, and the one-character typos of their
 * handles that name another block. A typo may name another block only by
 * being that block's handle or a longer prefix of its key.
 */
function measure(editor: LexicalEditor): {
  lengths: number[];
  tried: number;
  hits: number;
} {
  return editor.read(() => {
    const handles = $getBlockHandles();
    let tried = 0;
    let hits = 0;
    for (const [id, handle] of handles) {
      for (const typo of oneCharTypos(handle)) {
        tried++;
        const result = $resolveBlockHandle(typo);
        if (result.status === 'found') {
          const other = $getBlockId(result.node)!;
          if (other !== id) {
            hits++;
            assert(
              handleKey(other).startsWith(typo) &&
                typo.startsWith(handles.get(other)!),
              `typo ${typo} of ${handle} named ${other}`,
            );
          }
        }
      }
    }
    return {hits, lengths: Array.from(handles.values(), h => h.length), tried};
  });
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** UUIDv7s in their standard layout, made 0 to 2 ms apart. */
function uuidv7s(count: number): string[] {
  const random = mulberry32(7);
  const hex = (digits: number) =>
    Array.from({length: digits}, () =>
      Math.floor(random() * 16).toString(16),
    ).join('');
  let ms = 1793357300000;
  return Array.from({length: count}, () => {
    ms += Math.floor(random() * 3);
    const time = ms.toString(16).padStart(12, '0');
    const variant = (8 + Math.floor(random() * 4)).toString(16);
    return `${time.slice(0, 8)}-${time.slice(8)}-7${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
  });
}

/** Ids shaped like `@lexical/y`'s derived ids: `y`, a client, `_`, a clock. */
function derivedIds(count: number): string[] {
  const random = mulberry32(36);
  const client = Math.floor(random() * 2 ** 53).toString(36);
  let clock = 0;
  return Array.from({length: count}, () => {
    clock += 10 + Math.floor(random() * 70);
    return `y${client}_${clock.toString(36)}`;
  });
}

const V1ST = 'V1StGXR8_Z5jdHi6B-myT';
const XQE = '9xQeLm2Pq0aK7cTb_wYuA';
const RK8P = 'Rk8pZc41Uo-HsVd2NnFjB';
// Ids picked for their hashes: each of these starts its hash with the same 4
// characters as the one it is named after.
const LIKE_V1ST = 'qfapyr';
const LIKE_XQE = 'q71spi';
// Pairs whose hashes start with the same 4 characters.
const PAIR_A: [string, string] = ['p13e', 'p20d'];
const PAIR_B: [string, string] = ['p1i4', 'p2pq'];
// Eleven ids whose hashes all start with sclT.
const ELEVEN = [
  'same0',
  'same3abof',
  'same4onh9',
  'samesnq2r',
  'samev3hf4',
  'same1acey1',
  'same1lwsd9',
  'same1o9hsa',
  'same1sf64m',
  'same1yzxvi',
  'same1zd3zy',
];

describe('handle computation (pure)', () => {
  test('handleKey: 64 bits of a hash of the id in base64url', () => {
    expect(handleKey(V1ST)).toBe('2bNoqlijdOg');
    expect(handleKey(XQE)).toBe('gTtFDmoxN_s');
    expect(handleKey(RK8P)).toBe('xt6zBAcASRs');
    expect(HANDLE_KEY_LENGTH).toBe(11);
    for (const id of ['', 'a', 'b1', V1ST, 'y'.repeat(64)]) {
      expect(handleKey(id)).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
    // The picked ids do share the start of their hashes.
    expect(handleKey(LIKE_V1ST).slice(0, 4)).toBe('2bNo');
    expect(handleKey(LIKE_XQE).slice(0, 4)).toBe('gTtF');
    for (const [a, b] of [PAIR_A, PAIR_B]) {
      expect(handleKey(a).slice(0, 4)).toBe(handleKey(b).slice(0, 4));
      expect(handleKey(a)[4]).not.toBe(handleKey(b)[4]);
    }
    for (const id of ELEVEN) {
      expect(handleKey(id).slice(0, 4)).toBe('sclT');
    }
  });

  test('handles are the shortest unique prefix of the hash, at least 4 characters', () => {
    expect(
      Object.fromEntries(buildHandleTable([V1ST, XQE, RK8P]).handles),
    ).toEqual({[RK8P]: 'xt6z', [V1ST]: '2bNo', [XQE]: 'gTtF'});
    expect(
      Object.fromEntries(
        buildHandleTable([V1ST, XQE, LIKE_V1ST, LIKE_XQE]).handles,
      ),
    ).toEqual({
      [LIKE_V1ST]: '2bNoV',
      [LIKE_XQE]: 'gTtFc',
      [V1ST]: '2bNoq',
      [XQE]: 'gTtFD',
    });
    expect(MIN_BLOCK_HANDLE_LENGTH).toBe(4);
  });

  test('matches the brute-force definition, whatever the ids look like', () => {
    const ids = [
      'b1',
      'b12',
      'b123',
      'c',
      'cc',
      ...PAIR_A,
      ...PAIR_B,
      ...ELEVEN,
      V1ST,
      LIKE_V1ST,
      ...derivedIds(40),
      ...uuidv7s(40),
    ];
    const table = buildHandleTable(ids);
    for (const id of ids) {
      expect(table.handles.get(id), id).toBe(bruteForceHandle(id, ids));
    }
  });

  test('ids of any shape get handles of 4 or 5 characters', () => {
    const shapes = {
      counter: Array.from(
        {length: 1000},
        (_, i) => `block-${String(i).padStart(6, '0')}`,
      ),
      derived: derivedIds(1000),
      short: Array.from({length: 1000}, (_, i) => `b${(i + 1).toString(36)}`),
      uuidv7: uuidv7s(1000),
    };
    for (const [shape, ids] of Object.entries(shapes)) {
      const lengths = Array.from(
        buildHandleTable(ids).handles.values(),
        h => h.length,
      );
      expect(Math.min(...lengths), shape).toBe(4);
      expect(Math.max(...lengths), shape).toBeLessThanOrEqual(5);
    }
  });

  test('duplicates are counted once', () => {
    const table = buildHandleTable([V1ST, V1ST, XQE]);
    expect(table.sorted).toEqual([handleKey(V1ST), handleKey(XQE)]);
    expect(table.handles.get(V1ST)).toBe('2bNo');
  });

  test('the handle of an id outside the table, against the table', () => {
    const table = buildHandleTable([V1ST, XQE]);
    expect(handleInTable(table, LIKE_V1ST)).toBe('2bNoV');
    expect(handleInTable(table, RK8P)).toBe('xt6z');
    expect(handleInTable(table, XQE)).toBe('gTtF');
  });

  test('idsWithPrefix lists the ids whose hash starts with a prefix', () => {
    const table = buildHandleTable([V1ST, LIKE_V1ST, XQE]);
    expect(idsWithPrefix(table, '2bNo')).toEqual([LIKE_V1ST, V1ST]);
    expect(idsWithPrefix(table, '2bNoq')).toEqual([V1ST]);
    expect(idsWithPrefix(table, 'gTtF')).toEqual([XQE]);
    expect(idsWithPrefix(table, 'zzzz')).toEqual([]);
  });
});

describe('$getBlockHandle', () => {
  test('gives each block its handle', () => {
    using editor = build([V1ST, XQE, RK8P]);
    appendParagraphs(editor, ['Q3 plan', 'Revenue grew 4% in Q3.', 'Hiring']);
    expect(handlesOf(editor)).toEqual({
      [RK8P]: 'xt6z',
      [V1ST]: '2bNo',
      [XQE]: 'gTtF',
    });
    expect(editor.read($getBlockHandles)).toEqual(
      new Map([
        [RK8P, 'xt6z'],
        [V1ST, '2bNo'],
        [XQE, 'gTtF'],
      ]),
    );
  });

  test('short ids, and ids that prefix other ids, get hashed handles too', () => {
    const ids = ['b1', 'b12', 'b123456', 'xy'];
    using editor = build(ids);
    appendParagraphs(editor, ['a', 'b', 'c', 'd']);
    const expected = Object.fromEntries(buildHandleTable(ids).handles);
    expect(handlesOf(editor)).toEqual(expected);
    for (const id of ids) {
      expect(resolve(editor, expected[id])).toEqual({id, status: 'found'});
    }
  });

  test('null for a node without an id or that is not an identified block', () => {
    const ids = ['listid', 'item1', 'item2'];
    const handles = buildHandleTable(ids).handles;
    using editor = build(ids);
    update(editor, () => {
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('one')),
          $createListItemNode().append(
            $createListNode('bullet').append(
              $createListItemNode().append($createTextNode('nested')),
            ),
          ),
        ),
      );
    });
    editor.read(() => {
      const list = $getRoot().getFirstChildOrThrow();
      assert($isElementNode(list));
      const item = list.getFirstChildOrThrow();
      assert($isElementNode(item));
      expect($getBlockHandle(list)).toBe(handles.get('listid'));
      expect($getBlockHandle(item)).toBe(handles.get('item1'));
      // A text node, and a nested list (a wrapper, not identified).
      expect($getBlockHandle(item.getFirstChildOrThrow())).toBe(null);
      const secondItem = list.getLastChildOrThrow();
      assert($isElementNode(secondItem));
      expect($getBlockHandle(secondItem)).toBe(handles.get('item2'));
      const nestedList = secondItem.getFirstChildOrThrow();
      assert($isElementNode(nestedList));
      expect($getBlockHandle(nestedList)).toBe(null);
    });
    // Detached.
    update(editor, () => {
      const list = $getRoot().getFirstChildOrThrow();
      list.remove();
      expect($getBlockHandle(list)).toBe(null);
    });
  });

  test('null for a block named since the last commit', () => {
    using editor = build([V1ST, XQE]);
    appendParagraphs(editor, ['a', 'b']);
    update(editor, () => {
      // Its handle would share 2bNo with V1ST's.
      const block = $createParagraphNode();
      $setState(block, blockIdState, LIKE_V1ST);
      $getRoot().append(block);
      expect($getBlockHandle(block)).toBe(null);
      expect($getBlockById(LIKE_V1ST)).toBe(null);
    });
    // Once committed, both have longer handles.
    expect(handlesOf(editor)).toEqual({
      [LIKE_V1ST]: '2bNoV',
      [V1ST]: '2bNoq',
      [XQE]: 'gTtF',
    });
    expect(resolve(editor, '2bNoV')).toEqual({id: LIKE_V1ST, status: 'found'});
  });

  test('null for a block of an earlier state whose id is gone', () => {
    using editor = build([...PAIR_B, XQE]);
    appendParagraphs(editor, ['a', 'b', 'c']);
    const earlier = editor.getEditorState();
    update(editor, () => {
      $getBlockById(PAIR_B[0])!.remove();
    });
    const handle = earlier.read(
      () => $getBlockHandle($getRoot().getFirstChildOrThrow()),
      {editor},
    );
    expect(handle).toBe(null);
  });

  test('null for a copy whose repeated id awaits its repair', () => {
    using editor = build([V1ST, XQE, 'cccc12345']);
    appendParagraphs(editor, ['a', 'b', 'c']);
    // Read in the commit that brings the duplicate, before the repair update
    // that the extension's own listener (registered first) schedules.
    const seen: unknown[] = [];
    const unregister = editor.registerUpdateListener(({editorState, tags}) => {
      if (tags.has(COLLABORATION_TAG)) {
        editorState.read(
          () => {
            const [first, , last] = $getRoot().getChildren();
            const result = $resolveBlockHandle('2bNo');
            seen.push(
              $getBlockId(last),
              $getBlockHandle(first),
              $getBlockHandle(last),
              result.status === 'found' && result.node.is(first),
            );
          },
          {editor},
        );
      }
    });
    // A duplicate committed without transforms, as a remote merge is.
    editor.update(
      () => {
        $setState($getRoot().getLastChildOrThrow(), blockIdState, V1ST);
      },
      {discrete: true, skipTransforms: true, tag: COLLABORATION_TAG},
    );
    unregister();
    expect(seen).toEqual([V1ST, '2bNo', null, true]);
    // After the repair, the copy has an id and a handle of its own.
    const handles = handlesOf(editor);
    expect(Object.keys(handles)).toHaveLength(3);
    expect(handles[V1ST]).toBe('2bNo');
  });

  test('handles change only when ids do, and at once', () => {
    using editor = build([V1ST, XQE]);
    appendParagraphs(editor, ['a', 'b']);
    const first = handlesOf(editor);
    // Typing changes no id: same handles.
    update(editor, () => {
      const text = $getRoot().getFirstDescendant();
      assert($isTextNode(text));
      text.setTextContent('changed');
    });
    expect(handlesOf(editor)).toEqual(first);
    // A new id whose hash shares 2bNo makes the handle longer at once.
    appendParagraphs(editor, ['c']);
    update(editor, () => {
      $setState($getRoot().getLastChildOrThrow(), blockIdState, LIKE_V1ST);
    });
    expect(handlesOf(editor)).toEqual({
      [LIKE_V1ST]: '2bNoV',
      [V1ST]: '2bNoq',
      [XQE]: 'gTtF',
    });
  });
});

describe('$resolveBlockHandle', () => {
  test('finds the block of a handle, or of a whole id', () => {
    using editor = build([V1ST, XQE, RK8P]);
    appendParagraphs(editor, ['a', 'b', 'c']);
    expect(resolve(editor, 'gTtF')).toEqual({id: XQE, status: 'found'});
    // A longer prefix of the hash (a handle read while another block's hash
    // shared more of it) still finds the block.
    expect(resolve(editor, 'gTtFDmo')).toEqual({id: XQE, status: 'found'});
    expect(resolve(editor, handleKey(XQE))).toEqual({id: XQE, status: 'found'});
    // A string longer than any handle is a whole id.
    expect(resolve(editor, XQE)).toEqual({id: XQE, status: 'found'});
  });

  test('ids of 11 characters or fewer are found by their handle only', () => {
    const ids = ['b1', 'b123456', 'abcdefghijk', 'abcdefghijkl'];
    using editor = build(ids);
    appendParagraphs(editor, ['a', 'b', 'c', 'd']);
    const handles = buildHandleTable(ids).handles;
    for (const id of ids) {
      expect(resolve(editor, handles.get(id)!)).toEqual({id, status: 'found'});
    }
    expect(resolve(editor, 'b1')).toEqual({
      handle: 'b1',
      reason: 'too-short',
      status: 'invalid',
    });
    expect(resolve(editor, 'b123456').status).toBe('not-found');
    expect(resolve(editor, 'abcdefghijk').status).toBe('not-found');
    // 12 characters: a whole id.
    expect(resolve(editor, 'abcdefghijkl')).toEqual({
      id: 'abcdefghijkl',
      status: 'found',
    });
  });

  test('a typo is not found; fewer than 4 characters is too short', () => {
    using editor = build([V1ST, XQE, RK8P]);
    appendParagraphs(editor, ['a', 'b', 'c']);
    expect(resolve(editor, 'gTtG')).toEqual({
      handle: 'gTtG',
      status: 'not-found',
    });
    // Case matters.
    expect(resolve(editor, 'GTTF')).toEqual({
      handle: 'GTTF',
      status: 'not-found',
    });
    // Never a handle: a dropped character, not a deleted block.
    for (const short of ['gTt', 'gT', 'g']) {
      expect(resolve(editor, short)).toEqual({
        handle: short,
        reason: 'too-short',
        status: 'invalid',
      });
    }
  });

  test('invalid input', () => {
    using editor = build([V1ST]);
    appendParagraphs(editor, ['a']);
    for (const input of [
      '',
      '2bNo ',
      ' 2bNo',
      '2bNo!',
      '2bNo/Q',
      'a'.repeat(65),
      '2bNo\n',
      'ß123',
    ]) {
      expect(resolve(editor, input), JSON.stringify(input)).toEqual({
        handle: input,
        reason: 'malformed',
        status: 'invalid',
      });
    }
    // Untrusted input that is not even a string, including objects that
    // cannot be turned into one.
    for (const input of [
      null,
      undefined,
      42,
      {handle: '2bNo'},
      JSON.parse('{"toString":null}'),
      Object.create(null),
    ]) {
      expect(
        editor.read(() => $resolveBlockHandle(input as unknown as string)),
      ).toMatchObject({reason: 'malformed', status: 'invalid'});
    }
    expect(
      editor.read(() =>
        $resolveBlockHandle(JSON.parse('{"toString":null}') as string),
      ),
    ).toEqual({handle: '', reason: 'malformed', status: 'invalid'});
  });

  test('a deleted block is not found', () => {
    using editor = build([V1ST, XQE, RK8P]);
    appendParagraphs(editor, ['a', 'b', 'c']);
    update(editor, () => {
      $getBlockById(RK8P)!.remove();
    });
    expect(resolve(editor, 'xt6z')).toEqual({
      handle: 'xt6z',
      status: 'not-found',
    });
    expect(resolve(editor, RK8P)).toEqual({handle: RK8P, status: 'not-found'});
  });

  test('a block deleted earlier in the same update is not found', () => {
    using editor = build([V1ST, XQE]);
    appendParagraphs(editor, ['a', 'b']);
    update(editor, () => {
      $getBlockById(XQE)!.remove();
      expect($resolveBlockHandle('gTtF')).toEqual({
        handle: 'gTtF',
        status: 'not-found',
      });
      const found = $resolveBlockHandle('2bNo');
      assert(found.status === 'found');
      expect($getBlockId(found.node)).toBe(V1ST);
    });
  });

  test('a new block whose hash starts the same way makes an old handle ambiguous', () => {
    using editor = build([V1ST, XQE, LIKE_V1ST]);
    appendParagraphs(editor, ['Q3 plan', 'Revenue']);
    expect(handlesOf(editor)[V1ST]).toBe('2bNo');
    // A collaborator adds a block whose handle would start with 2bNo too.
    appendParagraphs(editor, ['Q4 plan']);
    expect(resolve(editor, '2bNo')).toEqual({
      candidates: ['2bNoV', '2bNoq'],
      handle: '2bNo',
      status: 'ambiguous',
    });
    // The next handles computed are longer, and each resolves.
    expect(handlesOf(editor)).toEqual({
      [LIKE_V1ST]: '2bNoV',
      [V1ST]: '2bNoq',
      [XQE]: 'gTtF',
    });
    expect(resolve(editor, '2bNoq')).toEqual({id: V1ST, status: 'found'});
    expect(resolve(editor, '2bNoV')).toEqual({id: LIKE_V1ST, status: 'found'});
    // Once the new block is deleted, the old handle works again.
    update(editor, () => {
      $getRoot().getLastChildOrThrow().remove();
    });
    expect(resolve(editor, '2bNo')).toEqual({id: V1ST, status: 'found'});
    expect(resolve(editor, '2bNoq')).toEqual({id: V1ST, status: 'found'});
  });

  test('lists at most 10 candidates', () => {
    using editor = build(ELEVEN);
    appendParagraphs(editor, ELEVEN);
    const table = buildHandleTable(ELEVEN);
    const result = editor.read(() => $resolveBlockHandle('sclT'));
    assert(result.status === 'ambiguous');
    expect(result.candidates).toEqual(
      table.sorted
        .slice(0, 10)
        .map(key => table.handles.get(table.idsOfKey.get(key)![0])),
    );
  });
});

describe('$resolveBlockHandle with the handles of a read', () => {
  function readOf(editor: LexicalEditor): Map<string, string> {
    return editor.read($getBlockHandles);
  }
  function resolveRead(
    editor: LexicalEditor,
    handle: string,
    read: Map<string, string>,
  ) {
    return editor.read(() => {
      const result = $resolveBlockHandle(handle, {read});
      return result.status === 'found'
        ? {id: $getBlockId(result.node), status: result.status}
        : result;
    });
  }

  test('a block deleted since the read is not found, even if a block added since takes its handle', () => {
    using editor = build([PAIR_A[0], XQE, PAIR_A[1]]);
    appendParagraphs(editor, ['a', 'b']);
    const read = readOf(editor);
    expect(read.get(PAIR_A[0])).toBe('0ydd');
    update(editor, () => {
      $getBlockById(PAIR_A[0])!.remove();
    });
    appendParagraphs(editor, ['c']);
    // Without the read, the handle now names the block added since.
    expect(resolve(editor, '0ydd')).toEqual({id: PAIR_A[1], status: 'found'});
    // With it, the block the model read is gone.
    expect(resolveRead(editor, '0ydd', read)).toEqual({
      handle: '0ydd',
      status: 'not-found',
    });
    expect(resolveRead(editor, 'gTtF', read)).toEqual({
      id: XQE,
      status: 'found',
    });
  });

  test('a block added since cannot make the handle ambiguous', () => {
    using editor = build([V1ST, XQE, LIKE_V1ST]);
    appendParagraphs(editor, ['a', 'b']);
    const read = readOf(editor);
    appendParagraphs(editor, ['c']);
    expect(resolve(editor, '2bNo').status).toBe('ambiguous');
    expect(resolveRead(editor, '2bNo', read)).toEqual({
      id: V1ST,
      status: 'found',
    });
    // The whole id of a block the model did not read is not one of its
    // blocks either.
    update(editor, () => {
      const node = $createParagraphNode();
      $setState(node, blockIdState, 'a-whole-id-not-read');
      $getRoot().append(node);
    });
    expect(resolveRead(editor, 'a-whole-id-not-read', read)).toEqual({
      handle: 'a-whole-id-not-read',
      status: 'not-found',
    });
  });

  test('typos fail against the ids of the read', () => {
    using editor = build([V1ST, LIKE_V1ST, XQE]);
    appendParagraphs(editor, ['a', 'b', 'c']);
    const read = readOf(editor);
    expect(resolveRead(editor, 'gTtG', read)).toEqual({
      handle: 'gTtG',
      status: 'not-found',
    });
    // Shorter than the handles shown: the read's handles as candidates.
    expect(resolveRead(editor, '2bNo', read)).toEqual({
      candidates: ['2bNoV', '2bNoq'],
      handle: '2bNo',
      status: 'ambiguous',
    });
    expect(resolveRead(editor, 'gTt', read)).toEqual({
      handle: 'gTt',
      reason: 'too-short',
      status: 'invalid',
    });
    expect(resolveRead(editor, 'gTtF!', read)).toEqual({
      handle: 'gTtF!',
      reason: 'malformed',
      status: 'invalid',
    });
    // A longer prefix of the hash, and the whole id, work.
    expect(resolveRead(editor, 'gTtFDm', read)).toEqual({
      id: XQE,
      status: 'found',
    });
    expect(resolveRead(editor, XQE, read)).toEqual({id: XQE, status: 'found'});
  });

  test('a map changed between calls is read as it is now', () => {
    using editor = build([PAIR_A[0], 'wxyz2222', PAIR_A[1]]);
    appendParagraphs(editor, ['a', 'b']);
    const shown = readOf(editor);
    expect(resolveRead(editor, '0ydd', shown)).toEqual({
      id: PAIR_A[0],
      status: 'found',
    });
    // The same map, refilled from a later read.
    appendParagraphs(editor, ['c']);
    shown.clear();
    for (const [id, handle] of readOf(editor)) {
      shown.set(id, handle);
    }
    const fresh = new Map(shown);
    for (const read of [shown, fresh]) {
      expect(resolveRead(editor, '0ydd', read)).toEqual({
        candidates: ['0yddA', '0yddC'],
        handle: '0ydd',
        status: 'ambiguous',
      });
    }
  });

  test('works with a read of another editor state of the same document', () => {
    using editor = build([V1ST, XQE]);
    appendParagraphs(editor, ['a', 'b']);
    const json = editor.getEditorState().toJSON();
    const read = readOf(editor);
    using other = build([]);
    other.setEditorState(other.parseEditorState(json));
    expect(resolveRead(other, 'gTtF', read)).toEqual({
      id: XQE,
      status: 'found',
    });
  });
});

describe('typo safety and handle length for ids of any shape', () => {
  for (const [shape, ids] of [
    ['UUIDv7', uuidv7s(400)],
    ['derived-like', derivedIds(400)],
    [
      'counter',
      Array.from(
        {length: 400},
        (_, i) => `block-${String(i).padStart(6, '0')}`,
      ),
    ],
  ] as const) {
    test(`${shape} ids`, () => {
      using editor = load(ids);
      const {lengths, tried, hits} = measure(editor);
      expect(lengths).toHaveLength(ids.length);
      expect(Math.min(...lengths)).toBe(4);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(5);
      // About 400 of 64^4 four-character strings are handles.
      expect(hits / tried).toBeLessThan(1e-3);
    });
  }
});

describe('without the index', () => {
  test('a disabled extension falls back to a scan', () => {
    using editor = build([V1ST, XQE]);
    appendParagraphs(editor, ['a', 'b']);
    const before = handlesOf(editor);
    using disabled = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        configExtension(BlockIdExtension, {disabled: true}),
      ],
      name: '[block-handle-disabled]',
    });
    disabled.setEditorState(
      disabled.parseEditorState(editor.getEditorState().toJSON()),
    );
    expect(handlesOf(disabled)).toEqual(before);
    expect(resolve(disabled, 'gTtF')).toEqual({id: XQE, status: 'found'});
    expect(resolve(disabled, '2bNo')).toEqual({id: V1ST, status: 'found'});
    expect(resolve(disabled, 'zzzz')).toEqual({
      handle: 'zzzz',
      status: 'not-found',
    });
    // A block added while disabled gets no id, and no handle.
    update(disabled, () => {
      $getRoot().append($createParagraphNode());
    });
    expect(
      disabled.read(() => $getBlockHandle($getRoot().getLastChildOrThrow())),
    ).toBe(null);
    // Its id set by hand is seen at once by the scan.
    update(disabled, () => {
      $setState($getRoot().getLastChildOrThrow(), blockIdState, LIKE_V1ST);
    });
    expect(handlesOf(disabled)).toEqual({
      [LIKE_V1ST]: '2bNoV',
      [V1ST]: '2bNoq',
      [XQE]: 'gTtF',
    });
    // And an id changed in a nested position, or a block removed.
    update(disabled, () => {
      $getBlockById(LIKE_V1ST)!.remove();
    });
    expect(handlesOf(disabled)).toEqual({[V1ST]: '2bNo', [XQE]: 'gTtF'});
  });

  test('disabling and enabling at runtime', () => {
    using editor = build([V1ST, XQE, LIKE_V1ST]);
    appendParagraphs(editor, ['a', 'b']);
    const {disabled} = getExtensionDependencyFromEditor(
      editor,
      BlockIdExtension,
    ).output;
    disabled.value = true;
    expect(handlesOf(editor)).toEqual({[V1ST]: '2bNo', [XQE]: 'gTtF'});
    update(editor, () => {
      $getRoot().append($createParagraphNode());
      $setState($getRoot().getLastChildOrThrow(), blockIdState, LIKE_V1ST);
    });
    // The scan sees the id set by hand while disabled.
    expect(resolve(editor, '2bNo')).toEqual({
      candidates: ['2bNoV', '2bNoq'],
      handle: '2bNo',
      status: 'ambiguous',
    });
    disabled.value = false;
    // Indexed again, with the same handles.
    expect(handlesOf(editor)).toEqual({
      [LIKE_V1ST]: '2bNoV',
      [V1ST]: '2bNoq',
      [XQE]: 'gTtF',
    });
    expect(resolve(editor, '2bNoV')).toEqual({id: LIKE_V1ST, status: 'found'});
  });

  test('while disabled, a repeated id names its first live holder', () => {
    const id = 'duplicate-id-0001';
    using editor = load([id, XQE, id], {disabled: true});
    const handle = editor.read(() => $getBlockHandles()).get(id)!;
    expect(resolve(editor, handle)).toEqual({id, status: 'found'});
    const holders = () =>
      editor.read(() =>
        $getRoot()
          .getChildren()
          .filter(node => $getBlockId(node) === id)
          .map(node => node.getKey()),
      );
    const [first, second] = holders();
    const keyOf = (input: string) =>
      editor.read(() => {
        const result = $resolveBlockHandle(input);
        return result.status === 'found' ? result.node.getKey() : null;
      });
    expect(keyOf(handle)).toBe(first);
    // The first holder removed: the second one now.
    update(editor, () => {
      $getRoot().getFirstChildOrThrow().remove();
      expect(keyOf(handle)).toBe(second);
    });
    expect(keyOf(handle)).toBe(second);
    expect(
      editor.read(() => $getBlockHandle($getRoot().getLastChildOrThrow())),
    ).toBe(handle);
    // Two holders reordered in an update: the one first now.
    using reordered = load([id, XQE, id], {disabled: true});
    const [a, b] = reordered.read(() =>
      $getRoot()
        .getChildren()
        .filter(node => $getBlockId(node) === id)
        .map(node => node.getKey()),
    );
    update(reordered, () => {
      const root = $getRoot();
      root.getFirstChildOrThrow().insertBefore(root.getLastChildOrThrow());
      const result = $resolveBlockHandle(handle);
      assert(result.status === 'found');
      expect(result.node.getKey()).toBe(b);
      expect($getBlockById(id)!.getKey()).toBe(b);
    });
    expect(a).not.toBe(b);
  });

  test('enabled or disabled, handles come from the last committed state', () => {
    for (const disabled of [false, true]) {
      using editor = load([V1ST, XQE], {disabled});
      const earlier = editor.getEditorState();
      expect(handlesOf(editor)).toEqual({[V1ST]: '2bNo', [XQE]: 'gTtF'});
      update(editor, () => {
        const node = $createParagraphNode();
        $setState(node, blockIdState, LIKE_V1ST);
        $getRoot().append(node);
        // Not committed yet: no handle for the new block, the old ones.
        expect($getBlockHandle(node)).toBe(null);
        expect(Object.fromEntries($getBlockHandles())).toEqual({
          [V1ST]: '2bNo',
          [XQE]: 'gTtF',
        });
      });
      expect(handlesOf(editor)[V1ST]).toBe('2bNoq');
      // An earlier state, read: its blocks that the committed state still
      // has, with the committed state's handles.
      expect(
        earlier.read(() => Object.fromEntries($getBlockHandles()), {editor}),
      ).toEqual({[V1ST]: '2bNoq', [XQE]: 'gTtF'});
      // An id changed below the root (the root itself is not cloned).
      update(editor, () => {
        $setState(
          $getBlockById(XQE) ?? $getRoot().getChildAtIndex(1)!,
          blockIdState,
          LIKE_XQE,
        );
      });
      expect(handlesOf(editor)).toEqual({
        [LIKE_V1ST]: '2bNoV',
        [LIKE_XQE]: 'gTtF',
        [V1ST]: '2bNoq',
      });
    }
  });
});

describe('headless and JSON-only use', () => {
  const stored: SerializedEditorState = {
    root: {
      children: [V1ST, XQE, RK8P].map((id, i) => ({
        $: {blockId: id},
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: `Block ${i}`,
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
  } as unknown as SerializedEditorState;

  test('a headless editor reads handles and applies an edit by handle', () => {
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [HeadlessExtension, RichTextExtension, BlockIdExtension],
      name: '[block-handle-headless]',
    });
    editor.setEditorState(editor.parseEditorState(stored));
    expect(handlesOf(editor)).toEqual({
      [RK8P]: 'xt6z',
      [V1ST]: '2bNo',
      [XQE]: 'gTtF',
    });
    update(editor, () => {
      const result = $resolveBlockHandle('gTtF');
      assert(result.status === 'found' && $isElementNode(result.node));
      const text = result.node.getFirstDescendant();
      assert($isTextNode(text));
      text.setTextContent('Revenue grew 6%.');
    });
    const json = editor.getEditorState().toJSON();
    const second = json.root.children[1] as unknown as {
      $: {blockId: string};
      children: {text: string}[];
    };
    expect(second.$.blockId).toBe(XQE);
    expect(second.children[0].text).toBe('Revenue grew 6%.');
  });

  test('reading handles from a parsed state, without a DOM', () => {
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [RichTextExtension, BlockIdExtension],
      name: '[block-handle-json]',
    });
    const state = editor.parseEditorState(JSON.stringify(stored));
    editor.setEditorState(state);
    const handles = editor
      .getEditorState()
      .read(() => $getBlockHandles(), {editor});
    expect(handles).toEqual(
      new Map([
        [RK8P, 'xt6z'],
        [V1ST, '2bNo'],
        [XQE, 'gTtF'],
      ]),
    );
  });

  test('a document stored without ids gets handles of its positional ids', () => {
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [RichTextExtension, BlockIdExtension],
      name: '[block-handle-positional]',
    });
    const withoutIds = JSON.parse(JSON.stringify(stored));
    for (const child of withoutIds.root.children) {
      delete child.$;
    }
    editor.setEditorState(editor.parseEditorState(withoutIds));
    const handles = handlesOf(editor);
    expect(Object.keys(handles)).toHaveLength(3);
    for (const [id, handle] of Object.entries(handles)) {
      expect(id).toHaveLength(21);
      expect(handle!.length).toBeGreaterThanOrEqual(4);
      expect(handleKey(id).startsWith(handle!)).toBe(true);
      expect(resolve(editor, handle!)).toEqual({id, status: 'found'});
    }
  });
});
