/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A seed is written once and relabeled to the client id derived from it
// (SeedRelabel), where it was written a second time under that id. A
// refactor of what is stored: the bytes must be the ones the second write
// gave, for every node shape and configuration of the catalogs, for a
// client's initialization with its selection, and for every session of the
// fuzz seeds and of random scripts.

import {
  BlockIdExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createLinkNode} from '@lexical/link';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createMarkNode} from '@lexical/mark';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $setSelection,
  configExtension,
  defineExtension,
  type TextNode,
} from 'lexical';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {afterEach, describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';
import {seedYState} from '../../headless';
import {SEED_RELABEL_TEST_HOOKS} from '../../internal/SeedRelabel';
import {
  $appendShapes,
  catalogAppExtension,
  type CatalogConfig,
  NODE_SHAPES,
  type NodeShape,
  shapeDocs,
} from '../catalog';
import {genScript, runScript, type Script} from '../utils/fuzz';
import {flush} from '../utils/harness';

const hooks = SEED_RELABEL_TEST_HOOKS;
afterEach(() => {
  hooks.enabled = true;
});

/** How many seeds were relabeled since the last call. */
function takeRelabeled(): number {
  const n = hooks.relabeled;
  hooks.relabeled = 0;
  return n;
}

/** `fn` run with seeds relabeled, then written twice, and how many relabeled. */
function bothWays<T>(fn: () => T): {relabeled: T; twice: T; count: number} {
  takeRelabeled();
  hooks.enabled = true;
  const relabeled = fn();
  const count = takeRelabeled();
  hooks.enabled = false;
  const twice = fn();
  hooks.enabled = true;
  expect(takeRelabeled()).toBe(0);
  return {count, relabeled, twice};
}

/** Block ids drawn from a counter, so that two seeds name blocks alike. */
function countedIds() {
  let n = 0;
  return configExtension(BlockIdExtension, {
    generateId: () => 'blk' + String(n++).padStart(18, '0'),
  });
}

type Blocks = CatalogConfig['blockIds'];
const BLOCK_IDS: readonly Blocks[] = ['absent', 'enabled', 'disabled'];
const MARKS: readonly NonNullable<CatalogConfig['marks']>[] = [
  'mark-state',
  'mark-flavor',
];

function headlessConfig(
  blockIds: Blocks,
  marks: NonNullable<CatalogConfig['marks']>,
) {
  return {
    extensions: [
      catalogAppExtension({
        blockIds: blockIds === 'enabled' ? 'absent' : blockIds,
        marks,
      }),
      ...(blockIds === 'enabled' ? [countedIds()] : []),
    ],
    schemaVersion: 1,
  };
}

/**
 * What a seed derives from its client id: text with segment keys (token and
 * segmented text), and adjacent equal links at the top level, in a list item
 * and in a table cell, which get instance keys where nothing merged them (an
 * untransformed state). Also adjacent equal marks, which get no instance
 * key (marks are not instance-keyed wrappers).
 */
function $clientDerivedKeys() {
  const $links = () => [
    $createLinkNode('https://example.com/').append($createTextNode('one')),
    $createLinkNode('https://example.com/').append($createTextNode('two')),
    $createLinkNode('https://example.com/').append(
      $createTextNode('three').toggleFormat('bold'),
    ),
  ];
  $getRoot().append(
    $createParagraphNode().append(
      $createTextNode('token').setMode('token'),
      $createTextNode('segmented one').setMode('segmented'),
      $createTextNode(' plain '),
      ...$links(),
    ),
    $createListNode('bullet').append(
      $createListItemNode().append($createTextNode('item '), ...$links()),
    ),
    $createTableNode().append(
      $createTableRowNode().append(
        $createTableCellNode().append(
          $createParagraphNode().append($createTextNode('cell '), ...$links()),
        ),
      ),
    ),
    $createParagraphNode().append(
      $createMarkNode(['c1']).append($createTextNode('marked')),
      $createMarkNode(['c1']).append($createTextNode('again')),
    ),
  );
}

describe('a relabeled seed stores the bytes of a seed written twice', () => {
  const docs = shapeDocs(Math.ceil(NODE_SHAPES.length / 6) + 4, 6, 9817);
  for (const blockIds of BLOCK_IDS) {
    for (const marks of MARKS) {
      test(`headless, every node shape, block ids ${blockIds}, ${marks}`, () => {
        const seed = (shapes: readonly NodeShape[] | null) =>
          seedYState(headlessConfig(blockIds, marks), () =>
            shapes === null ? $clientDerivedKeys() : $appendShapes(shapes),
          );
        for (const shapes of [null, ...docs]) {
          const {count, relabeled, twice} = bothWays(() => seed(shapes));
          expect(count).toBe(1);
          expect(Buffer.from(relabeled).equals(Buffer.from(twice))).toBe(true);
        }
      });
    }
  }

  const inits = BLOCK_IDS.flatMap(blockIds =>
    (
      [
        ['mark-node', null],
        ['mark-state', null],
        ...docs.slice(0, 6).map(doc => ['mark-state', doc] as const),
      ] as const
    ).map(
      ([marks, shapes], i) =>
        [
          `block ids ${blockIds}, ${marks}, ${shapes === null ? 'client-derived keys' : `shape document ${i - 1}`}`,
          blockIds,
          marks,
          shapes,
        ] as const,
    ),
  );
  test.each(inits)(
    'a client initializing its content, with its selection: %s',
    async (_label, blockIds, marks, shapes) => {
      const init = async () => {
        const doc = createYDoc(null);
        doc.clientID = 7;
        const editor = buildEditorFromExtensions(
          defineExtension({
            dependencies: [
              catalogAppExtension({
                blockIds: blockIds === 'enabled' ? 'absent' : blockIds,
                marks,
              }),
              ...(blockIds === 'enabled' ? [countedIds()] : []),
              configExtension(YCollabExtension, {doc, schemaVersion: 1}),
            ],
            name: 'seed-relabel-init',
            onError: (e: Error) => {
              throw e;
            },
          }),
        );
        editor.update(
          () => {
            $getRoot().clear();
            if (shapes === null) {
              $clientDerivedKeys();
            } else {
              $appendShapes(shapes);
            }
            const text = $getRoot()
              .getAllTextNodes()
              .find(t => t.getTextContentSize() > 1) as TextNode | undefined;
            if (text !== undefined) {
              const selection = $createRangeSelection();
              selection.anchor.set(text.getKey(), 1, 'text');
              selection.focus.set(text.getKey(), 1, 'text');
              $setSelection(selection);
            }
          },
          // Untransformed, as a state set whole is: adjacent equal links
          // stay apart (each gets an instance key), as do adjacent equal
          // marks (which get none).
          {discrete: true, skipTransforms: true},
        );
        getExtensionDependencyFromEditor(
          editor,
          YCollabExtension,
        ).output.binding.initialize();
        await flush();
        const result = {
          selection: editor.read(() => {
            const s = $getSelection();
            return s === null
              ? null
              : JSON.stringify(
                  s.getNodes().map(n => [n.getType(), n.getTextContent()]),
                );
          }),
          state: Y.encodeStateAsUpdate(doc),
        };
        editor.dispose();
        return result;
      };
      takeRelabeled();
      const relabeled = await init();
      expect(takeRelabeled()).toBe(1);
      hooks.enabled = false;
      const twice = await init();
      hooks.enabled = true;
      expect(
        Buffer.from(relabeled.state).equals(Buffer.from(twice.state)),
      ).toBe(true);
      expect(relabeled.selection).toBe(twice.selection);
    },
  );

  const FUZZ = path.join(__dirname, '..', 'fuzz');
  const scripts: [string, Script][] = [
    ...fs
      .readdirSync(FUZZ)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(
        f =>
          [f, JSON.parse(fs.readFileSync(path.join(FUZZ, f), 'utf8'))] as [
            string,
            Script,
          ],
      ),
    ...Array.from(
      {length: 40},
      (_, i) => [`random ${i + 1}`, genScript(i + 1)] as [string, Script],
    ),
  ];
  test.each(scripts)('session %s', (file, script) => {
    const prev = process.env.FUZZ_GC;
    process.env.FUZZ_GC = file.startsWith('gc-') ? '1' : '';
    try {
      const {count, relabeled, twice} = bothWays(
        () => runScript(script, false, true).states!,
      );
      expect(count).toBeGreaterThan(0);
      expect(relabeled.length).toBe(twice.length);
      relabeled.forEach((state, i) => {
        expect(Buffer.from(state).equals(Buffer.from(twice[i]))).toBe(true);
      });
    } finally {
      process.env.FUZZ_GC = prev;
    }
  });
});
