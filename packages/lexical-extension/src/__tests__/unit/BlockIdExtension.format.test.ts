/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The block id format, frozen: generated ids, and the derivation of the
// positional ids that documents stored without ids get. A change here changes
// the ids every reader gives such documents, so the derivation is checked
// against an independent implementation of its specification (Node's crypto)
// and pinned to literal values.

import {
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  generateBlockId,
} from '@lexical/extension';
import {ListExtension} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {type SerializedLexicalNode} from 'lexical';
import {createHash} from 'node:crypto';
import {afterEach, describe, expect, test, vi} from 'vitest';

import {
  $canonicalDocument,
  $documentKey,
  canonicalJSON,
  deriveDuplicateId,
  derivePositionalId,
  sha256,
  utf8,
} from '../../internal/positionalBlockId';

const ID = /^[A-Za-z0-9_-]{21}$/;

/** The specification of positional ids, written with Node's crypto. */
function specDocumentKey(canonical: string): Buffer {
  return createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest();
}
function specDuplicateId(id: string, ordinal: string): string {
  return createHash('sha256')
    .update(Buffer.from(`dup\u0000${id}\u0000${ordinal}`, 'utf8'))
    .digest('base64url')
    .slice(0, 21);
}
function specPositionalId(documentKey: Buffer, place: string): string {
  return createHash('sha256')
    .update(Buffer.concat([documentKey, Buffer.from(place, 'utf8')]))
    .digest('base64url')
    .slice(0, 21);
}

// A document stored without ids, as compact JSON (what a server might keep).
const STORED = JSON.stringify({
  root: {
    children: [
      {
        children: [{text: 'Hello, wörld 👋', type: 'text'}],
        type: 'paragraph',
      },
      {children: [{text: 'Second', type: 'text'}], tag: 'h2', type: 'heading'},
      {children: [], type: 'paragraph'},
    ],
    type: 'root',
  },
});

function loaded() {
  const editor = buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [RichTextExtension, BlockIdExtension],
    name: '[format]',
  });
  editor.setEditorState(editor.parseEditorState(STORED));
  return editor;
}

describe('block id format', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('sha256 matches the standard on every padding boundary and beyond', () => {
    let seed = 7;
    const next = () => (seed = (seed * 16807) % 2147483647) & 0xff;
    for (const length of [
      0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100_000,
    ]) {
      const bytes = Uint8Array.from({length}, next);
      expect(Buffer.from(sha256(bytes)).toString('hex')).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
    }
    expect(Buffer.from(sha256(utf8('abc'))).toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('utf8 matches the standard, lone surrogates included', () => {
    for (const text of [
      '',
      'ascii',
      'wörld',
      '€ and 👋',
      '\ud83d',
      'a\udc4bb',
      '\ud83d\ud83d\udc4b',
    ]) {
      expect(Buffer.from(utf8(text))).toEqual(Buffer.from(text, 'utf8'));
    }
  });

  test('canonical JSON sorts keys at every level and leaves out undefined', () => {
    // Built from entries, so that the keys are unsorted.
    const unsorted = Object.fromEntries([
      [
        'b',
        [
          Object.fromEntries([
            ['z', 1],
            ['a', undefined],
            ['m', 'x'],
          ]),
        ],
      ],
      ['a', null],
      ['c', 'é"'],
    ]);
    expect(canonicalJSON(unsorted)).toBe(
      '{"a":null,"b":[{"m":"x","z":1}],"c":"é\\""}',
    );
    // Keys that are array indices come first, in numeric order, as
    // ECMAScript orders them, then the others by UTF-16 code units.
    const indices = Object.fromEntries(
      ['b', '10', 'a', '9', 'B', ''].map(key => [key, 1]),
    );
    expect(canonicalJSON(indices)).toBe(
      '{"9":1,"10":1,"":1,"B":1,"a":1,"b":1}',
    );
  });

  test('the document hashed is the compact export without ids', () => {
    const editor = loaded();
    const canonical = editor.read($canonicalDocument);
    // The load named every block, but ids are not part of what is hashed.
    expect(canonical).not.toContain('blockId');
    expect(canonical).toBe(
      canonicalJSON(
        (
          editor.getEditorState().toJSON(true) as unknown as {
            root: {children: {$?: object}[]};
          }
        ).root,
      ).replace(/"\$":\{"blockId":"[A-Za-z0-9_-]{21}"\},/g, ''),
    );
    expect(Buffer.from(editor.read($documentKey))).toEqual(
      specDocumentKey(canonical),
    );
  });

  test('positional ids follow the specification and are pinned', () => {
    const editor = loaded();
    const documentKey = editor.read($documentKey);
    const spec = specDocumentKey(editor.read($canonicalDocument));
    for (const place of ['0', '1', '2', '0.0', '12.3.4', '0#1', '1#2']) {
      expect(derivePositionalId(documentKey, place)).toBe(
        specPositionalId(spec, place),
      );
    }
    const ids = editor.read(() =>
      editor
        .getEditorState()
        .toJSON()
        .root.children.map(child => (child.$ as {blockId: string}).blockId),
    );
    expect(ids).toEqual(
      ['0', '1', '2'].map(place => derivePositionalId(documentKey, place)),
    );
    // Frozen: these are the ids every reader gives this stored document.
    expect(Buffer.from(documentKey).toString('hex')).toMatchInlineSnapshot(
      `"a5b08ad0c2466a1e221f46f78d5aa99a46566c9196b447369d279e01725d6cd3"`,
    );
    expect(ids).toMatchInlineSnapshot(`
      [
        "Obj4Jnk2Uq2o1Jcgsuvda",
        "m81kLbLYKGetZFUBn8iGg",
        "tTZ_qAifsgwmKg2wFCDwn",
      ]
    `);
  });

  test('ids of later holders of a repeated id follow the specification and are pinned', () => {
    for (const [id, ordinal] of [
      ['x', '1'],
      ['x', '2'],
      ['V1StGXR8_Z5jdHi6B-myT', '1'],
      ['wörld 👋', '3'],
      ['y'.repeat(64), '1#1'],
    ]) {
      const derived = deriveDuplicateId(id, ordinal);
      expect(derived).toBe(specDuplicateId(id, ordinal));
      expect(derived).toMatch(ID);
    }
    // Frozen.
    expect([
      deriveDuplicateId('x', '1'),
      deriveDuplicateId('x', '2'),
      deriveDuplicateId('V1StGXR8_Z5jdHi6B-myT', '1'),
    ]).toMatchInlineSnapshot(`
      [
        "-rK-MX7NTIVuS6OIwyd26",
        "I8N4JHaH_LC1SSZw_HJ8r",
        "atPwgUJO7TzlWVO7K9Scw",
      ]
    `);
  });

  test('a loaded document with repeated ids: the first holder keeps the id, the later ones are renamed by ordinal', () => {
    const editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [RichTextExtension, BlockIdExtension],
      name: '[format-dup]',
    });
    const paragraph = (text: string, id: string) => ({
      $: {blockId: id},
      children: [{text, type: 'text'}],
      type: 'paragraph',
    });
    editor.setEditorState(
      editor.parseEditorState(
        JSON.stringify({
          root: {
            children: [
              paragraph('a', 'x'),
              paragraph('b', 'x'),
              paragraph('c', 'y'),
              paragraph('d', 'x'),
            ],
            type: 'root',
          },
        }),
      ),
    );
    const ids = editor
      .getEditorState()
      .toJSON()
      .root.children.map(child => (child.$ as {blockId: string}).blockId);
    expect(ids).toEqual([
      'x',
      specDuplicateId('x', '1'),
      'y',
      specDuplicateId('x', '2'),
    ]);
  });

  // The vector printed under "Id format" in the documentation, so that an
  // implementation in another language can check itself end to end.
  test('the documented end-to-end vector', () => {
    const stored =
      '{"root":{"children":[' +
      '{"$":{"10":1.5,"9":"x","note":"tab\\tquote\\""},' +
      '"children":[{"text":"Hello, wörld 👋","type":"text"}],"type":"paragraph"},' +
      '{"children":[' +
      '{"children":[{"text":"one","type":"text"}],"type":"listitem","value":1},' +
      '{"children":[{"text":"two","type":"text"}],"type":"listitem","value":2}],' +
      '"listType":"bullet","start":1,"tag":"ul","type":"list"},' +
      '{"$":{"blockId":"kept-id"},"children":[],"type":"paragraph"}' +
      '],"type":"root"}}';
    const canonical =
      '{"children":[' +
      '{"$":{"9":"x","10":1.5,"note":"tab\\tquote\\""},' +
      '"children":[{"text":"Hello, wörld 👋","type":"text"}],"type":"paragraph"},' +
      '{"children":[' +
      '{"children":[{"text":"one","type":"text"}],"type":"listitem"},' +
      '{"children":[{"text":"two","type":"text"}],"type":"listitem","value":2}],' +
      '"listType":"bullet","type":"list"},' +
      '{"children":[],"type":"paragraph"}' +
      '],"type":"root"}';
    const key =
      '9fa59b03bb40d3d4ac45b31a472f965a0825ffc10693d4165b1e4dcf956b5dfa';
    const expected = [
      ['0', 'paragraph', 'qfDxX6r4J9KOyXNjM0x2X'],
      ['1', 'list', 'nWeVEnzogQyDvzB4_4gMw'],
      ['1.0', 'listitem', 'L9_QRFvuohaGhhqAlzLEB'],
      ['1.1', 'listitem', 'BCreOq5xUSiXSxTd8xMLr'],
      [null, 'paragraph', 'kept-id'],
    ] as const;

    const editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [RichTextExtension, ListExtension, BlockIdExtension],
      name: '[format-vector]',
    });
    editor.setEditorState(editor.parseEditorState(stored));
    expect(editor.read($canonicalDocument)).toBe(canonical);
    expect(specDocumentKey(canonical).toString('hex')).toBe(key);
    expect(Buffer.from(editor.read($documentKey)).toString('hex')).toBe(key);
    const actual: [string, string][] = [];
    const visit = (node: SerializedLexicalNode) => {
      const id = (node as {$?: {blockId?: string}}).$?.blockId;
      if (id !== undefined) {
        actual.push([node.type, id]);
      }
      for (const child of (node as {children?: SerializedLexicalNode[]})
        .children || []) {
        visit(child);
      }
    };
    editor.getEditorState().toJSON().root.children.forEach(visit);
    expect(actual).toEqual(expected.map(([, type, id]) => [type, id]));
    for (const [place, , id] of expected) {
      if (place !== null) {
        expect(specPositionalId(Buffer.from(key, 'hex'), place)).toBe(id);
      }
    }
  });

  test('positional ids are well formed, use every symbol, and do not repeat', () => {
    const documentKey = sha256(utf8('{}'));
    const seen = new Set<string>();
    const symbols = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      const id = derivePositionalId(documentKey, `${i % 200}.${i}`);
      expect(id).toMatch(ID);
      expect(blockIdState.parse(id)).toBe(id);
      seen.add(id);
      for (const ch of id) {
        symbols.add(ch);
      }
    }
    expect(seen.size).toBe(20_000);
    expect(symbols.size).toBe(64);
  });

  test('generated ids need crypto.getRandomValues: there is no weaker fallback', () => {
    expect(generateBlockId()).toMatch(ID);
    vi.stubGlobal('crypto', undefined);
    expect(() => generateBlockId()).toThrow(
      /crypto.getRandomValues is not available/,
    );
  });
});
