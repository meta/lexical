/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The layout 4 seed (D22): the seed's own pass writes each container's
// formats, flat NodeState included, as canonical runs interleaved with its
// content (Cursor#insert, Ident.seedRunsOf). It is the one seed path, so its
// bytes are golden per SEED_LAYOUT: every admitted seeder at a seed layout
// writes the same bytes for the same content, and a change to them needs a
// seed-format bump. Layout 4 is one: its seed records `lexical-y:4` alone
// and writes flat NodeState as runs, so these goldens replace layout 3's
// (golden/seed-layout3.json, the same inputs but the last shape). Each
// golden is stored with its input (golden/seed-layout4.json): the nodes its
// shape's builder makes, as the seed reads them, so the bytes come again
// from that input whatever the builders become. It is structurally
// identical to the 3to4 step's writeLayout4Formats's output for the same
// values: the same openers and ends at the same places relative to the
// content, every end naming the same opener, the same reads (only clocks,
// origins and end distances differ).

import {$createLinkNode} from '@lexical/link';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createMarkNode} from '@lexical/mark';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $parseSerializedNode,
  $setState,
  createState,
  ElementNode,
  type LexicalNode,
  type SerializedLexicalNode,
  type StateConfig,
} from 'lexical';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import {createYDoc} from '../..';
import {readYState, seedYState} from '../../headless';
import {covered} from '../../internal/Ident';
import {
  readLayout4Formats,
  writeLayout4Formats,
} from '../../migrate/3to4/frozen/layout4';
import {
  $createNumericFieldWrapper,
  NumericFieldWrapperNode,
} from '../catalog/coveredValues';
import {$createBoxNode, NODES} from '../utils/harness';

const config = {
  nodes: [...NODES, NumericFieldWrapperNode],
  onWarn: () => {},
  schemaVersion: 1,
};

const $t = (text: string, format = 0, style = '') =>
  $createTextNode(text).setFormat(format).setStyle(style);
const BOLD = 1;
const ITALIC = 2;

const tone = createState('tone', {
  parse: v => (typeof v === 'string' ? v : ''),
});
const rank = createState('rank', {
  parse: v => (typeof v === 'number' ? v : 0),
});
const flag = createState('flag', {parse: v => v === true});
const meta = createState('meta', {
  parse: (v): unknown => (v !== null && typeof v === 'object' ? v : null),
});
const tags = createState('tags', {
  parse: (v): unknown[] => (Array.isArray(v) ? v : []),
});
function $stated<N extends LexicalNode, V>(
  node: N,
  state: StateConfig<string, V>,
  value: V,
): N {
  $setState(node, state, value);
  return node;
}
const $toned = <N extends LexicalNode>(node: N, value: string) =>
  $stated(node, tone, value);
const $ranked = <N extends LexicalNode>(node: N, value: number) =>
  $stated(node, rank, value);

const SHAPES: [string, () => LexicalNode[]][] = [
  [
    'overlapping keys and styles',
    () => [
      $createParagraphNode().append(
        $t('ab', BOLD),
        $t('cd', BOLD | ITALIC),
        $t('ef', ITALIC, 'color: red'),
        $t('gh', 0, 'color: red'),
        $t('ij'),
      ),
    ],
  ],
  [
    'wrappers and marks',
    () => [
      $createParagraphNode().append(
        $createLinkNode('https://x.test').append($t('ab'), $t('cd', BOLD)),
        $createMarkNode(['c1']).append($t('ef', BOLD)),
        $t('gh'),
      ),
    ],
  ],
  [
    'nested containers',
    () => [
      $createHeadingNode('h1').append($t('title', ITALIC)),
      $createQuoteNode().append($t('q', ITALIC), $t('r')),
      $createListNode('bullet').append(
        $createListItemNode().append($t('one', BOLD)),
        $createListItemNode().append($t('two', BOLD)),
      ),
      $createBoxNode('blue').append(
        $createParagraphNode().append($t('in box', BOLD)),
      ),
    ],
  ],
  [
    'table',
    () => [
      $createTableNode().append(
        $createTableRowNode().append(
          $createTableCellNode().append(
            $createParagraphNode().append($t('a1', BOLD)),
          ),
          $createTableCellNode().append(
            $createParagraphNode().append($t('a2', BOLD)),
          ),
        ),
        $createTableRowNode().append(
          $createTableCellNode().append(
            $createParagraphNode().append($t('b1')),
          ),
          $createTableCellNode().append(
            $createParagraphNode().append($t('b2', ITALIC)),
          ),
        ),
      ),
    ],
  ],
  [
    'a tab and a line break',
    () => [
      $createParagraphNode().append(
        $t('x', BOLD),
        $createTabNode().setFormat(BOLD),
        $t('y', BOLD),
        $createLineBreakNode(),
        $t('z', BOLD),
      ),
    ],
  ],
  // A wrapper whose class declares a field named `0`: its value is the
  // object {"0": 3}, a value like any other.
  [
    'a wrapper with a numeric field name',
    () => [
      $createParagraphNode().append(
        $t('before '),
        $createNumericFieldWrapper($t('ab'), $t('c', BOLD)),
        $t(' after'),
      ),
    ],
  ],
  // Flat NodeState on text and on a line break (layout 4's covered names):
  // a string, a number, a boolean, an object and an array, alone, together
  // and under a text format.
  [
    'flat NodeState',
    () => [
      $createParagraphNode().append(
        $t('plain '),
        $toned($t('warm'), 'warm'),
        $toned($t(' bold-cold', BOLD), 'cold'),
        $ranked($t(' ranked'), 3),
        $ranked($toned($t(' both'), 'warm'), 7),
        $stated($createLineBreakNode(), tone, 'break'),
        $stated($t('flagged'), flag, true),
        $stated($t(' object'), meta, {a: 'x', b: [1, 2]}),
        $stated($t(' array'), tags, ['z', 'a']),
        $t(' tail'),
      ),
    ],
  ],
];

/** Every container under `node`, in document order (sequence, then map). */
function containers(node: Y.Node, out: Y.Node[] = []): Y.Node[] {
  out.push(node);
  for (
    let it = node._start as Y.Item | null;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    const c = it.content as unknown as {type?: unknown};
    if (!it.deleted && c.type instanceof Y.Node) {
      containers(c.type, out);
    }
  }
  for (const key of [...node._map.keys()].sort()) {
    const it = node._map.get(key)!;
    const c = it.content as unknown as {type?: unknown};
    if (!it.deleted && c.type instanceof Y.Node) {
      containers(c.type, out);
    }
  }
  return out;
}

/**
 * A container's covered layout relative to its content: one `u` per
 * countable unit, each covered item as `{key=value}`, an end as
 * `{key=>n}` (n: its opener's position in this list).
 */
function structure(container: Y.Node): string[] {
  const out: string[] = [];
  const at = new Map<string, number>();
  for (
    let it = container._start as Y.Item | null;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof Y.ContentFormat) {
      const {key, value} = it.content;
      if (!covered(key)) {
        continue;
      }
      if (Array.isArray(value) && value.length > 0) {
        const opener =
          value.length === 1
            ? `${it.id.client}:${it.id.clock - (value[0] as number)}`
            : `${value[0]}:${value[1]}`;
        out.push(`{${key}=>${at.get(opener) ?? '?'}}`);
      } else {
        at.set(`${it.id.client}:${it.id.clock}`, out.length);
        out.push(`{${key}=${JSON.stringify(value)}}`);
      }
    } else if (it.countable) {
      for (let i = 0; i < it.length; i++) {
        out.push('u');
      }
    }
  }
  return out;
}

const fresh = (state: Uint8Array) =>
  readYState(state, config, () => JSON.stringify($getRoot().exportJSON()));

/**
 * Golden seed bytes per shape (base64), the canonical (full-map) form, each
 * stored beside its input: the nodes its shape's builder made, as the seed
 * reads them (see $inputJSON), which the bytes are seeded from. A change to
 * the bytes at layout 3 needs a seed-format bump. Written once
 * (SEED_GOLDEN_WRITE=1 adds a shape that has none, then format the file with
 * prettier and pin its new hash below), never regenerated.
 */
const GOLDEN = path.join(__dirname, 'golden', 'seed-layout4.json');

type Golden = {name: string; input: SerializedLexicalNode[]; bytes: string};

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/**
 * A node with its children as the seed reads it: its class's schema JSON
 * (LexicalNode's own exportJSON, compact), which parses back to the same
 * fields. (A class's exportJSON can add more: ParagraphNode's adds the
 * first text's format, which parses back as the paragraph's own.)
 */
function $inputJSON(node: LexicalNode): SerializedLexicalNode {
  const json = ElementNode.prototype.exportJSON.call(
    node,
    true,
  ) as SerializedLexicalNode & {children?: SerializedLexicalNode[]};
  if ($isElementNode(node)) {
    json.children = node.getChildren().map($inputJSON);
  }
  return json;
}

/** The input a shape's builder makes, as the seed's own update has it. */
function inputOf($build: () => LexicalNode[]): SerializedLexicalNode[] {
  let input: SerializedLexicalNode[] = [];
  seedYState(config, () => {
    $getRoot().append(...$build());
    input = $getRoot().getChildren().map($inputJSON);
  });
  return JSON.parse(JSON.stringify(input));
}

/** The seed of a stored input. */
const seedOf = (input: SerializedLexicalNode[]) =>
  seedYState(config, () =>
    $getRoot().append(...input.map(c => $parseSerializedNode(c))),
  );

function load(): Golden[] {
  const fixtures: Golden[] = fs.existsSync(GOLDEN)
    ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))
    : [];
  if (process.env.SEED_GOLDEN_WRITE === '1') {
    let added = false;
    for (const [name, $build] of SHAPES) {
      if (!fixtures.some(f => f.name === name)) {
        const input = inputOf($build);
        fixtures.push({bytes: b64(seedOf(input)), input, name});
        added = true;
      }
    }
    if (added) {
      fs.writeFileSync(GOLDEN, JSON.stringify(fixtures, null, 2) + '\n');
    }
  }
  return fixtures;
}

const FIXTURES = load();

describe('the layout 4 seed', () => {
  test('one stored input and golden per shape, unchanged', () => {
    expect(FIXTURES.map(f => f.name)).toEqual(SHAPES.map(([name]) => name));
    expect(
      createHash('sha256').update(fs.readFileSync(GOLDEN)).digest('hex'),
    ).toBe('7708ee53e92b5dd307b9889b9bc65fcaa373bc5c67c52fbfa4da3b7257e79e8c');
  });

  for (const [name, $build] of SHAPES) {
    test(`${name}: its builder makes the stored input`, () => {
      const golden = FIXTURES.find(f => f.name === name);
      expect(golden).toBeDefined();
      expect(inputOf($build)).toEqual(golden!.input);
    });

    test(`${name}: golden seed bytes, from the stored input and from the builder`, () => {
      const golden = FIXTURES.find(f => f.name === name)!;
      const seed = seedOf(golden.input);
      expect(seedOf(golden.input)).toEqual(seed);
      expect(b64(seed)).toBe(golden.bytes);
      const built = seedYState(config, () => $getRoot().append(...$build()));
      expect(b64(built)).toBe(golden.bytes);
    });

    test(`${name}: structurally identical to writeLayout4Formats`, () => {
      const seed = seedYState(config, () => $getRoot().append(...$build()));
      const doc = createYDoc(seed, {gc: false});
      const copy = createYDoc(seed, {gc: false});
      copy.clientID = 424242;
      const mine = containers(doc.get('lexical-y'));
      const theirs = containers(copy.get('lexical-y'));
      expect(theirs.length).toBe(mine.length);
      let covering = 0;
      copy.transact(tr => {
        mine.forEach((c, i) => {
          const values = readLayout4Formats(c);
          covering += values.filter(v => v.size > 0).length;
          writeLayout4Formats(tr, theirs[i], values);
        });
      });
      expect(covering).toBeGreaterThan(0);
      mine.forEach((c, i) => {
        if (process.env.SEED_STRUCT_PRINT === '1') {
          // eslint-disable-next-line no-console
          console.log('STRUCT', name, i, structure(c).join(' '));
        }
        expect(structure(theirs[i])).toEqual(structure(c));
        expect(readLayout4Formats(theirs[i])).toEqual(readLayout4Formats(c));
      });
      // The binding's read of both documents is the same.
      expect(fresh(Y.encodeStateAsUpdate(copy))).toBe(
        fresh(Y.encodeStateAsUpdate(doc)),
      );
    });
  }
});
