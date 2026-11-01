/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The agent edit sketches of the server page
// (packages/lexical-website/docs/collaboration/y-server.md), as written there
// (`../utils/agentEditSketch.ts`; the first test checks that the two are the
// same), run over every kind of text node and block they can meet, over
// targets a collaborator changed since the agent's read, and over a store
// that loses the race to a newer state.

import {$createCodeHighlightNode, CodeHighlightNode} from '@lexical/code-core';
import {$getBlockById, $getBlockId, BlockIdExtension} from '@lexical/extension';
import {$createHashtagNode, HashtagNode} from '@lexical/hashtag';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  TableExtension,
} from '@lexical/table';
import {mergeUpdates} from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $getSlot,
  $isTextNode,
  $setSlot,
  defineExtension,
  ElementNode,
  type LexicalNode,
  type LexicalWarning,
  nodeSchema,
  ParagraphNode,
  stringValue,
  TextNode,
  withField,
} from 'lexical';
import fs from 'node:fs';
import {describe, expect, test} from 'vitest';

import {NESTED_FALLBACK_WARNING} from '../..';
import {
  createYWriter,
  editYState,
  type HeadlessYConfig,
  readYState,
  seedYState,
} from '../../headless';
import {
  $blockAt,
  $findWords,
  $plainTextOf,
  $setTextInPlace,
  $subtree,
  applyChecked,
  type DocStore,
} from '../utils/agentEditSketch';
import {SlotBodyNode} from '../utils/slots';

/** An app's own text node, such as a mention. */
class MentionNode extends TextNode {
  $config() {
    return this.config('server-docs-mention', {extends: TextNode});
  }
}

/** A paragraph with a named slot (a title shown with it). */
class TitledParagraphNode extends ParagraphNode {
  $config() {
    return this.config('server-docs-titled-paragraph', {
      extends: ParagraphNode,
      slots: ['title'],
    });
  }
}

/** A block with two named slots, side by side. */
class TwoSlotNode extends ElementNode {
  $config() {
    return this.config('server-docs-two-slots', {
      extends: ElementNode,
      slots: ['left', 'right'],
    });
  }
}

const AppNodes = defineExtension({
  name: 'server-docs-nodes',
  nodes: () => [
    CodeHighlightNode,
    HashtagNode,
    MentionNode,
    SlotBodyNode,
    TitledParagraphNode,
    TwoSlotNode,
  ],
});

/** Each block shape: its name, how to make it, and whether the sketch edits it. */
const SHAPES: [string, () => LexicalNode, boolean][] = [
  [
    'plain text',
    () => $createParagraphNode().append($createTextNode('Old text')),
    true,
  ],
  [
    'bold plain text',
    () =>
      $createParagraphNode().append(
        $createTextNode('Old text').toggleFormat('bold'),
      ),
    true,
  ],
  [
    'token text',
    () =>
      $createParagraphNode().append(
        $createTextNode('Old text').setMode('token'),
      ),
    false,
  ],
  [
    'segmented text',
    () =>
      $createParagraphNode().append(
        $createTextNode('Old text').setMode('segmented'),
      ),
    false,
  ],
  ['a tab', () => $createParagraphNode().append($createTabNode()), false],
  [
    'a hashtag',
    () => $createParagraphNode().append($createHashtagNode('#old')),
    false,
  ],
  [
    'a code token',
    () =>
      $createParagraphNode().append($createCodeHighlightNode('old', 'keyword')),
    false,
  ],
  [
    "an app's text node",
    () =>
      $createParagraphNode().append(
        $create(MentionNode).setTextContent('@old').setMode('token'),
      ),
    false,
  ],
  [
    'text and a tab',
    () =>
      $createParagraphNode().append($createTextNode('Old'), $createTabNode()),
    false,
  ],
  [
    'text and a named slot',
    () => {
      const block = $create(TitledParagraphNode).append(
        $createTextNode('Old text'),
      );
      $setSlot(
        block,
        'title',
        $create(SlotBodyNode).append(
          $createParagraphNode().append($createTextNode('Title')),
        ),
      );
      return block;
    },
    false,
  ],
];

type MemoryStore = DocStore & {
  races: number;
  sent: Uint8Array[];
  state: Uint8Array;
  stores: number;
  version: number;
};

/**
 * A document's storage in memory. `race`, called before each compare-and-set
 * with the stored state, returns a newer state stored meanwhile by someone
 * else (the compare-and-set then fails), or null.
 */
function memoryStore(
  state: Uint8Array,
  race: (stored: Uint8Array) => Uint8Array | null = () => null,
): MemoryStore {
  const store: MemoryStore = {
    async load() {
      return {state: store.state, version: store.version};
    },
    races: 0,
    send(update) {
      store.sent.push(update);
    },
    sent: [],
    state,
    async storeIf(version, next) {
      const newer = race(store.state);
      if (newer !== null) {
        store.races++;
        store.state = newer;
        store.version++;
      }
      if (version !== store.version) {
        return false;
      }
      store.state = next;
      store.version++;
      store.stores++;
      return true;
    },
    stores: 0,
    version: 0,
  };
  return store;
}

/** The replacements of words of the server page, as written there. */
function replaceWordsBatch(
  store: DocStore,
  config: HeadlessYConfig,
  edits: {from: string; id: string; to: string}[],
) {
  // What each edit's block holds in the latest stored state: a refusal
  // reports it, also for an edit that fails only after an earlier one.
  const stored = new Map<string, string | undefined>();
  const $failure = (index: number, reason: string) => ({
    id: edits[index].id,
    index,
    reason,
    text: stored.get(edits[index].id),
  });
  return applyChecked(
    store,
    config,
    () => {
      for (const edit of edits) {
        stored.set(edit.id, $getBlockById(edit.id)?.getTextContent());
      }
      return edits.flatMap((edit, index) => {
        const found = $findWords(edit.id, edit.from);
        return typeof found === 'string' ? [$failure(index, found)] : [];
      });
    },
    () =>
      edits.flatMap((edit, index) => {
        const found = $findWords(edit.id, edit.from);
        if (typeof found === 'string') {
          return [$failure(index, `${found} after an earlier edit`)];
        }
        found.text.spliceText(found.offset, edit.from.length, edit.to);
        return [];
      }),
  );
}
const replaceWords = (
  store: DocStore,
  config: HeadlessYConfig,
  id: string,
  from: string,
  to: string,
) => replaceWordsBatch(store, config, [{from, id, to}]);

/** Steps 1 and 3 of Edits by block id, as written there. */
function readBlocks(seen: Uint8Array, config: HeadlessYConfig) {
  return readYState(seen, config, () =>
    $getRoot()
      .getChildren()
      .map(node => {
        const id = $getBlockId(node)!;
        return {at: $blockAt(id), id, text: node.getTextContent()};
      }),
  );
}
function answerById(
  store: DocStore,
  config: HeadlessYConfig,
  blocks: ReturnType<typeof readBlocks>,
  ops: {id: string; text: string}[],
) {
  // What each op's block holds in the latest stored state, for a refusal.
  const stored = new Map<string, string | undefined>();
  const $reason = (op: {id: string}) => {
    const at = $blockAt(op.id);
    return ops.filter(other => other.id === op.id).length > 1
      ? 'the block is named twice'
      : at === null
        ? 'the block is gone'
        : at !== blocks.find(block => block.id === op.id)?.at
          ? 'the block changed'
          : $plainTextOf($getBlockById(op.id)) === null
            ? 'not plain text'
            : null;
  };
  const $failure = (index: number, reason: string) => ({
    id: ops[index].id,
    index,
    reason,
    text: stored.get(ops[index].id),
  });
  return applyChecked(
    store,
    config,
    () => {
      for (const op of ops) {
        stored.set(op.id, $getBlockById(op.id)?.getTextContent());
      }
      return ops.flatMap((op, index) => {
        const reason = $reason(op);
        return reason === null ? [] : [$failure(index, reason)];
      });
    },
    () =>
      ops.flatMap((op, index) => {
        const reason = $reason(op);
        if (reason !== null) {
          return [$failure(index, `${reason} after an earlier op`)];
        }
        $setTextInPlace($plainTextOf($getBlockById(op.id))!, op.text);
        return [];
      }),
  );
}

const texts = (state: Uint8Array, config: HeadlessYConfig) =>
  readYState(state, config, () =>
    $getRoot()
      .getChildren()
      .map(node => node.getTextContent()),
  );

const collaborator = createYWriter('server-docs-collaborator');

/** Paragraphs of plain text, with ids. */
function seedLines(config: HeadlessYConfig, lines: string[]) {
  const seen = seedYState(config, () =>
    $getRoot().append(
      ...lines.map(line =>
        $createParagraphNode().append($createTextNode(line)),
      ),
    ),
  );
  const ids = readYState(seen, config, () =>
    $getRoot()
      .getChildren()
      .map(node => $getBlockId(node)!),
  );
  return {ids, seen};
}

const $firstText = (id: string) =>
  ($getBlockById(id) as ElementNode).getFirstChild() as TextNode;

describe('server page: agent edits', () => {
  test('the sketches are the same in the docs and the tests', () => {
    const read = (path: string) =>
      fs.readFileSync(new URL(path, import.meta.url), 'utf8');
    const page = read(
      '../../../../lexical-website/docs/collaboration/y-server.md',
    );
    const sketch = read('../utils/agentEditSketch.ts').replace(
      /^export /gm,
      '',
    );
    const region = (source: string, start: string, last: string) => {
      const from = source.indexOf(start);
      const end = source.indexOf('\n}\n', source.indexOf(last, from)) + 3;
      return from === -1 ? '' : source.slice(from, end);
    };
    for (const [start, last] of [
      ['// Your storage of one document', 'function $findWords'],
      ["// Changes a text node's text", 'function $blockAt'],
    ]) {
      expect(region(page, start, last)).not.toBe('');
      expect(region(page, start, last)).toBe(region(sketch, start, last));
    }
    // The two uses on the page are the ones in this file.
    const self = read('./ServerDocsAgentEdits.test.ts');
    for (const line of [
      'found.text.spliceText(found.offset, edit.from.length, edit.to);',
      'return [$failure(index, `${found} after an earlier edit`)];',
      "? 'the block is named twice'",
      '$setTextInPlace($plainTextOf($getBlockById(op.id))!, op.text);',
      'return [$failure(index, `${reason} after an earlier op`)];',
      'return {at: $blockAt(id), id, text: node.getTextContent()};',
    ]) {
      expect(page).toContain(line);
      expect(self).toContain(line);
    }
    // The Block IDs page checks the whole block too.
    expect(
      read('../../../../lexical-website/docs/extensions/block-ids.md'),
    ).toContain('if ($blockAt(id) !== read.get(id)) {');
  });

  test('edits blocks by id: plain text in place, every other shape refused, nothing thrown', async () => {
    const warnings: LexicalWarning[] = [];
    const config = {
      extensions: [AppNodes, BlockIdExtension],
      onWarn: (warning: LexicalWarning) => warnings.push(warning),
      schemaVersion: 1,
    };
    const seen = seedYState(config, () =>
      $getRoot().append(...SHAPES.map(([, $make]) => $make())),
    );
    const blocks = readBlocks(seen, config);
    expect(blocks.map(block => block.id)).not.toContain(null);
    const wholeOf = (state: Uint8Array) =>
      readYState(state, config, () =>
        $getRoot()
          .getChildren()
          .map(node => JSON.stringify($subtree(node))),
      );
    const before = wholeOf(seen);
    // One op per shape: plain text is edited, every other shape refused.
    for (const [i, [name, , edited]] of SHAPES.entries()) {
      const store = memoryStore(seen);
      const refused = await answerById(store, config, blocks, [
        {id: blocks[i].id, text: 'New text'},
      ]);
      if (edited) {
        expect(refused, name).toBeNull();
        expect(texts(store.state, config)[i], name).toBe('New text');
      } else {
        expect(refused?.failures, name).toEqual([
          {
            id: blocks[i].id,
            index: 0,
            reason: 'not plain text',
            text: blocks[i].text,
          },
        ]);
        expect(store.stores, name).toBe(0);
      }
    }
    // Every block in one answer: one shape it cannot edit refuses the whole
    // answer, with every failure, and nothing is applied.
    const store = memoryStore(seen);
    const refused = await answerById(
      store,
      config,
      blocks,
      blocks.map(block => ({id: block.id, text: 'New text'})),
    );
    expect(refused?.failures.map(failure => failure.id)).toEqual(
      blocks.filter((_, i) => !SHAPES[i][2]).map(block => block.id),
    );
    expect(store.stores).toBe(0);
    expect(store.sent).toEqual([]);
    expect(wholeOf(store.state)).toEqual(before);
    // The titled paragraph holds text and declares a slot, so it is stored as
    // a node of its own, with a warning that says so.
    expect(
      warnings.filter(warning => warning.code !== NESTED_FALLBACK_WARNING),
    ).toEqual([]);
  });

  test('a replacement of words edits one plain text node in the block read, and refuses a tab, a token or changed words', async () => {
    const warnings: LexicalWarning[] = [];
    const config = {
      extensions: [AppNodes, BlockIdExtension],
      onWarn: (warning: LexicalWarning) => warnings.push(warning),
      schemaVersion: 1,
    };
    // Words the shapes start with.
    const from = 'Old t';
    for (const [name, $make, edited] of SHAPES.slice(0, 8)) {
      for (const changed of [false, true]) {
        const seen = seedYState(config, () => $getRoot().append($make()));
        const id = readYState(
          seen,
          config,
          () => $getBlockId($getRoot().getFirstChildOrThrow())!,
        );
        // The latest state: the agent's read, or that read with its first
        // text node changed by a collaborator.
        const latest = changed
          ? editYState(
              seen,
              config,
              () => {
                const text = $getRoot().getFirstDescendant();
                if ($isTextNode(text) && text.isSimpleText()) {
                  text.setTextContent('Bye');
                }
              },
              {writer: collaborator},
            ).state
          : seen;
        const old = texts(latest, config)[0];
        const store = memoryStore(latest);
        const refused = await replaceWords(store, config, id, from, 'Hi');
        const applies = edited && !changed;
        expect(refused === null, name).toBe(applies);
        expect(texts(store.state, config)[0], name).toBe(
          applies ? 'Hi' + old.slice(from.length) : old,
        );
        if (changed && edited) {
          expect(refused?.failures, name).toEqual([
            {id, index: 0, reason: 'the words changed', text: 'Bye'},
          ]);
        }
      }
    }
    expect(
      warnings.filter(warning => warning.code !== NESTED_FALLBACK_WARNING),
    ).toEqual([]);
  });

  test('a replacement of words refuses words that appear twice in the block or across nodes, and finds the block read by id', async () => {
    const config = {extensions: [BlockIdExtension], schemaVersion: 1};
    const {ids, seen} = seedLines(config, [
      'The red fox and the red hen.',
      'A red fox.',
      'The quick fox.',
    ]);
    // Twice in the block: refused, whatever other blocks hold.
    let store = memoryStore(seen);
    expect(
      (await replaceWords(store, config, ids[0], 'red', 'blue'))?.failures,
    ).toEqual([
      {
        id: ids[0],
        index: 0,
        reason: 'the words appear more than once',
        text: 'The red fox and the red hen.',
      },
    ]);
    expect(store.stores).toBe(0);
    // Once in the block read, though another block holds them too: only
    // that block changes.
    store = memoryStore(seen);
    expect(await replaceWords(store, config, ids[1], 'red', 'blue')).toBeNull();
    expect(texts(store.state, config)).toEqual([
      'The red fox and the red hen.',
      'A blue fox.',
      'The quick fox.',
    ]);
    // A collaborator moved the block: found by id where it is now.
    const moved = editYState(
      seen,
      config,
      () => void $getBlockById(ids[1])!.insertBefore($getBlockById(ids[2])!),
      {writer: collaborator},
    ).state;
    store = memoryStore(moved);
    expect(
      await replaceWords(store, config, ids[2], 'quick', 'slow'),
    ).toBeNull();
    expect(texts(store.state, config)).toEqual([
      'The red fox and the red hen.',
      'The slow fox.',
      'A red fox.',
    ]);
    // A collaborator made part of the words bold: they span two text nodes.
    const bold = editYState(
      seen,
      config,
      () => void $firstText(ids[2]).splitText(6)[1].toggleFormat('bold'),
      {writer: collaborator},
    ).state;
    store = memoryStore(bold);
    expect(
      (await replaceWords(store, config, ids[2], 'quick', 'slow'))?.failures,
    ).toEqual([
      {
        id: ids[2],
        index: 0,
        reason: 'not in one text node',
        text: 'The quick fox.',
      },
    ]);
    // The block is gone.
    const gone = editYState(
      seen,
      config,
      () => void $getBlockById(ids[2])!.remove(),
      {writer: collaborator},
    ).state;
    store = memoryStore(gone);
    expect(
      (await replaceWords(store, config, ids[2], 'quick', 'slow'))?.failures,
    ).toEqual([
      {id: ids[2], index: 0, reason: 'the block is gone', text: undefined},
    ]);
  });

  test('step 3 refuses the whole answer when a target is gone, moved, replaced, typed in, formatted or styled since the read', async () => {
    const config = {extensions: [BlockIdExtension], schemaVersion: 1};
    // "Keep me." is not next to anything the collaborator changes (a block
    // after an inserted, deleted or moved block in its container goes back
    // too).
    const {ids, seen} = seedLines(config, [
      'First line.',
      'Move me.',
      'Last line.',
      'Spacer.',
      'Keep me.',
    ]);
    const blocks = readBlocks(seen, config);
    const $block = (i: number) => $getBlockById(ids[i])!;
    // Each case: what the collaborator does, and the failures it causes.
    const cases: [string, () => void, [number, string][]][] = [
      ['untouched', () => {}, []],
      // A move keeps the id: the target is now after "Last line.".
      [
        'moved',
        () => void $block(2).insertAfter($block(1)),
        [[1, 'the block changed']],
      ],
      [
        'replaced',
        () =>
          void $block(1).replace(
            $createParagraphNode().append($createTextNode('A slow dog.')),
          ),
        [[1, 'the block changed']],
      ],
      [
        'typed in',
        () => void $firstText(ids[1]).spliceText(0, 0, 'Please '),
        [[1, 'the block changed']],
      ],
      // The same text, another format: a rewrite would drop it.
      [
        'formatted',
        () => void $firstText(ids[1]).toggleFormat('bold'),
        [[1, 'the block changed']],
      ],
      [
        'styled',
        () => void $firstText(ids[1]).setStyle('color: red'),
        [[1, 'the block changed']],
      ],
      // A delete before "Keep me." changes its place: it goes back too.
      [
        'deleted',
        () => void $block(1).remove(),
        [
          [1, 'the block is gone'],
          [4, 'the block changed'],
        ],
      ],
    ];
    for (const [name, $collaborate, failures] of cases) {
      const latest = editYState(seen, config, $collaborate, {
        writer: collaborator,
      }).state;
      const store = memoryStore(latest);
      const refused = await answerById(store, config, blocks, [
        {id: ids[1], text: 'Move me now.'},
        {id: ids[4], text: 'Keep me now.'},
      ]);
      expect(
        refused?.failures.map(failure => [
          ids.indexOf(failure.id),
          failure.reason,
        ]) ?? [],
        name,
      ).toEqual(failures);
      if (failures.length === 0) {
        expect(texts(store.state, config), name).toEqual([
          'First line.',
          'Move me now.',
          'Last line.',
          'Spacer.',
          'Keep me now.',
        ]);
      } else {
        // Nothing applied, and each failure carries the block's current
        // text.
        expect(store.stores, name).toBe(0);
        expect(texts(store.state, config), name).toEqual(texts(latest, config));
        for (const failure of refused!.failures) {
          expect(failure.text, name).toBe(
            readYState(latest, config, () =>
              $getBlockById(failure.id)?.getTextContent(),
            ),
          );
        }
      }
    }
    // A target that exists only on the latest state (added after the read)
    // goes back too.
    const added = editYState(
      seen,
      config,
      () => void $block(4).insertAfter($createParagraphNode()),
      {writer: collaborator},
    ).state;
    const newId = readYState(
      added,
      config,
      () => $getBlockId($getRoot().getLastChild()!)!,
    );
    const refused = await answerById(memoryStore(added), config, blocks, [
      {id: newId, text: 'New'},
    ]);
    expect(refused?.failures.map(failure => failure.reason)).toEqual([
      'the block changed',
    ]);
  });

  test('a batch whose earlier edit changes a later target is refused whole: changed words, words now twice, a block named twice', async () => {
    const config = {extensions: [BlockIdExtension], schemaVersion: 1};
    // Each check passes on the stored state, but the first edit changes what
    // the second names: nothing may be stored.
    for (const [name, lines, edits, reason] of [
      [
        'the words the second names changed',
        ['red fox', 'spacer'],
        [
          {from: 'red', to: 'blue'},
          {from: 'red fox', to: 'dog'},
        ],
        'the words changed after an earlier edit',
      ],
      [
        'the words the second names now appear twice',
        ['red fox and hen', 'spacer'],
        [
          {from: 'hen', to: 'red'},
          {from: 'red', to: 'blue'},
        ],
        'the words appear more than once after an earlier edit',
      ],
    ] as const) {
      const {ids, seen} = seedLines(config, [...lines]);
      const store = memoryStore(seen);
      const refused = await replaceWordsBatch(
        store,
        config,
        edits.map(edit => ({...edit, id: ids[0]})),
      );
      // The second edit, with the block as stored, not as the first edit
      // left it in the discarded temporary state.
      expect(refused?.failures, name).toEqual([
        {id: ids[0], index: 1, reason, text: lines[0]},
      ]);
      expect([store.stores, store.sent.length], name).toEqual([0, 0]);
      expect(texts(store.state, config), name).toEqual(lines);
      expect(texts(refused!.latest, config), name).toEqual(lines);
    }
    // Every edit an earlier one invalidates is reported, not only the first.
    {
      const {ids, seen} = seedLines(config, ['red fox and hen', 'spacer']);
      const store = memoryStore(seen);
      const refused = await replaceWordsBatch(store, config, [
        {from: 'red fox and hen', id: ids[0], to: 'blue'},
        {from: 'red', id: ids[0], to: 'dog'},
        {from: 'hen', id: ids[0], to: 'cat'},
      ]);
      expect(refused?.failures).toEqual(
        [1, 2].map(index => ({
          id: ids[0],
          index,
          reason: 'the words changed after an earlier edit',
          text: 'red fox and hen',
        })),
      );
      expect([store.stores, store.sent.length]).toEqual([0, 0]);
      expect(refused!.latest).toEqual(seen);
    }
    // Independent edits of one batch all apply.
    const {ids, seen} = seedLines(config, ['red fox and hen', 'spacer']);
    const store = memoryStore(seen);
    expect(
      await replaceWordsBatch(store, config, [
        {from: 'hen', id: ids[0], to: 'cat'},
        {from: 'red', id: ids[0], to: 'blue'},
        {from: 'spacer', id: ids[1], to: 'gap'},
      ]),
    ).toBeNull();
    expect(texts(store.state, config)).toEqual(['blue fox and cat', 'gap']);
    // An answer by id that names a block twice is refused.
    const blocks = readBlocks(seen, config);
    const byId = memoryStore(seen);
    expect(
      (
        await answerById(byId, config, blocks, [
          {id: ids[0], text: 'One'},
          {id: ids[0], text: 'Two'},
        ])
      )?.failures.map(failure => failure.reason),
    ).toEqual(['the block is named twice', 'the block is named twice']);
    expect(byId.stores).toBe(0);
  });

  test('a stored field the server schema no longer declares is not compared: a rewrite passes over a change to it (the documented scope)', async () => {
    // An older schema stores `note`; the newer one dropped it. A collaborator
    // on the older schema changes the note after the agent's read.
    const noteSchema = nodeSchema<NotedParagraphNode>()({
      note: withField(stringValue(), {field: '__note'}),
    });
    class NotedParagraphNode extends ParagraphNode {
      __note: string = '';
      $config() {
        return this.config('server-docs-noted', {
          extends: ParagraphNode,
          json: noteSchema,
        });
      }
    }
    class UnnotedParagraphNode extends ParagraphNode {
      $config() {
        return this.config('server-docs-noted', {extends: ParagraphNode});
      }
    }
    const configOf = (node: typeof ParagraphNode, schemaVersion: number) => ({
      extensions: [
        BlockIdExtension,
        defineExtension({name: 'server-docs-noted', nodes: () => [node]}),
      ],
      onWarn: () => {},
      schemaVersion,
    });
    const older = configOf(NotedParagraphNode, 1);
    const seen = seedYState(older, () => {
      const block = $create(NotedParagraphNode).append(
        $createTextNode('red fox'),
      );
      block.__note = 'original note';
      $getRoot().append(block);
    });
    const id = readYState(
      seen,
      older,
      () => $getBlockId($getRoot().getFirstChildOrThrow())!,
    );
    const latest = editYState(
      seen,
      older,
      () =>
        void (($getBlockById(id) as NotedParagraphNode).getWritable().__note =
          'changed note'),
      {writer: collaborator},
    ).state;
    const noteOf = (state: Uint8Array) =>
      readYState(
        state,
        configOf(NotedParagraphNode, 2),
        () => ($getBlockById(id) as NotedParagraphNode).__note,
      );
    // A server on a schema that declares the field refuses the rewrite.
    const declares = configOf(NotedParagraphNode, 2);
    let store = memoryStore(latest);
    expect(
      (
        await answerById(store, declares, readBlocks(seen, declares), [
          {id, text: 'swift dog'},
        ])
      )?.failures.map(failure => failure.reason),
    ).toEqual(['the block changed']);
    expect(store.stores).toBe(0);
    // A server on the newer schema does not see the note: the rewrite goes
    // through (in place, so the collaborator's note is kept).
    const dropped = configOf(UnnotedParagraphNode, 2);
    store = memoryStore(latest);
    expect(
      await answerById(store, dropped, readBlocks(seen, dropped), [
        {id, text: 'swift dog'},
      ]),
    ).toBeNull();
    // Read with the older nodes, at the newer schema version.
    expect(texts(store.state, declares)).toEqual(['swift dog']);
    expect(noteOf(store.state)).toBe('changed note');
  });

  test('a format on words the agent names is checked like a replacement and applied where they are on the latest state', async () => {
    const config = {extensions: [BlockIdExtension], schemaVersion: 1};
    const {ids, seen} = seedLines(config, ['t61z t62z t63z', 'spacer']);
    // Strikethrough on the words, found on the latest state.
    const strike = (store: DocStore, word: string) =>
      applyChecked(
        store,
        config,
        () => {
          const found = $findWords(ids[0], word);
          return typeof found === 'string' ? [found] : [];
        },
        () => {
          const found = $findWords(ids[0], word);
          if (typeof found === 'string') {
            return [`${found} after an earlier edit`];
          }
          const parts = found.text.splitText(
            found.offset,
            found.offset + word.length,
          );
          parts[found.offset === 0 ? 0 : 1].toggleFormat('strikethrough');
          return [];
        },
      );
    const struck = (state: Uint8Array) =>
      readYState(state, config, () =>
        ($getBlockById(ids[0]) as ElementNode)
          .getAllTextNodes()
          .filter(text => text.hasFormat('strikethrough'))
          .map(text => text.getTextContent()),
      );
    // A collaborator typed words before it since the read: the format lands
    // on the word where it is now, and on nothing else.
    const typed = editYState(
      seen,
      config,
      () => void $firstText(ids[0]).spliceText(5, 0, 'x1z x2z '),
      {writer: collaborator},
    ).state;
    let store = memoryStore(typed);
    expect(await strike(store, 't62z')).toBeNull();
    expect(struck(store.state)).toEqual(['t62z']);
    expect(texts(store.state, config)).toEqual([
      't61z x1z x2z t62z t63z',
      'spacer',
    ]);
    // A collaborator changed the word: refused, nothing stored.
    const changed = editYState(
      seen,
      config,
      () => void $firstText(ids[0]).spliceText(5, 4, 't99z'),
      {writer: collaborator},
    ).state;
    store = memoryStore(changed);
    expect((await strike(store, 't62z'))?.failures).toEqual([
      'the words changed',
    ]);
    expect([store.stores, struck(store.state)]).toEqual([0, []]);
  });

  test('a lost race starts over on the newer state: applied when the check still holds there, refused when not, never the older edit', async () => {
    const config = {extensions: [BlockIdExtension], schemaVersion: 1};
    const {ids, seen} = seedLines(config, ['The quick fox.', 'Spacer.']);
    // The states stored by someone else, each once, just before the store.
    const raced: Uint8Array[] = [];
    const once = (edit: () => void) => (state: Uint8Array) => {
      if (raced.length > 0 && raced[raced.length - 1] === state) {
        return null;
      }
      const newer = editYState(state, config, edit, {
        writer: collaborator,
      }).state;
      raced.push(newer);
      return newer;
    };
    // Someone types in another block before the store: the check holds on
    // the newer state, and the edit made there keeps their text.
    let store = memoryStore(
      seen,
      once(() => void $firstText(ids[1]).spliceText(0, 0, 'A ')),
    );
    expect(
      await replaceWords(store, config, ids[0], 'quick', 'slow'),
    ).toBeNull();
    expect([store.races, store.stores, store.sent.length]).toEqual([1, 1, 1]);
    expect(texts(store.state, config)).toEqual(['The slow fox.', 'A Spacer.']);
    // The update sent was made on the newer state: it is the agent's edit
    // alone.
    expect(
      texts(
        mergeUpdates([raced[0], store.sent[0]] as Uint8Array<ArrayBuffer>[]),
        config,
      ),
    ).toEqual(['The slow fox.', 'A Spacer.']);
    // Someone changes the words before the store: refused on the newer
    // state, which stays as they left it.
    store = memoryStore(
      seen,
      once(() => void $firstText(ids[0]).spliceText(4, 5, 'swift')),
    );
    expect(
      (await replaceWords(store, config, ids[0], 'quick', 'slow'))?.failures,
    ).toEqual([
      {
        id: ids[0],
        index: 0,
        reason: 'the words changed',
        text: 'The swift fox.',
      },
    ]);
    expect([store.races, store.stores, store.sent.length]).toEqual([1, 0, 0]);
    expect(texts(store.state, config)).toEqual(['The swift fox.', 'Spacer.']);
    // The same for an answer by id: a format made before the store refuses
    // the rewrite.
    const blocks = readBlocks(seen, config);
    store = memoryStore(
      seen,
      once(() => void $firstText(ids[0]).toggleFormat('bold')),
    );
    expect(
      (
        await answerById(store, config, blocks, [
          {id: ids[0], text: 'The slow fox.'},
        ])
      )?.failures.map(failure => failure.reason),
    ).toEqual(['the block changed']);
    expect([store.races, store.stores, store.sent.length]).toEqual([1, 0, 0]);
    // The document keeps changing: after 3 lost races, refused with no
    // failures, nothing stored or sent.
    store = memoryStore(
      seen,
      state =>
        editYState(
          state,
          config,
          () => void $firstText(ids[1]).spliceText(0, 0, 'x'),
          {writer: collaborator},
        ).state,
    );
    const refused = await replaceWords(store, config, ids[0], 'quick', 'slow');
    expect(refused?.failures).toEqual([]);
    expect([store.races, store.stores, store.sent.length]).toEqual([3, 0, 0]);
    // The read it returns is the state that won the last race, not the one
    // that lost it.
    expect(texts(refused!.latest, config)).toEqual([
      'The quick fox.',
      'xxxSpacer.',
    ]);
    // At least one attempt.
    await expect(
      applyChecked(
        store,
        config,
        () => [],
        () => [],
        0,
      ),
    ).rejects.toThrow(RangeError);
    expect(texts(store.state, config)).toEqual([
      'The quick fox.',
      'xxxSpacer.',
    ]);
  });

  test('replacing a line keeps what a collaborator typed at the same time, at the start of the new text (typed at the end, possibly at the end)', () => {
    const config = {extensions: [BlockIdExtension], schemaVersion: 1};
    const seen = seedYState(config, () =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode('The quick brown fox.')),
      ),
    );
    const id = readYState(
      seen,
      config,
      () => $getBlockId($getRoot().getFirstChild()!)!,
    );
    const outcomes = new Map<string, Set<string>>();
    // Fresh writers each round, so both client-id orders occur.
    for (let round = 0; round < 12; round++) {
      for (const [where, offset, typed] of [
        ['start', 0, 'Big '],
        ['middle', 4, 'very '],
        ['end', 20, ' Jumps!'],
      ] as const) {
        const replace = editYState(
          seen,
          config,
          () =>
            void $getBlockById(id)!.replace(
              $createParagraphNode().append(
                $createTextNode('The quick red fox.'),
              ),
            ),
          {writer: createYWriter(`server-docs-agent-${round}`)},
        ).update!;
        const type = editYState(
          seen,
          config,
          () => void $firstText(id).spliceText(offset, 0, typed),
          {writer: createYWriter(`server-docs-collaborator-${round}`)},
        ).update!;
        const text = readYState(
          mergeUpdates([seen, replace, type] as Uint8Array<ArrayBuffer>[]),
          config,
          () => $getRoot().getTextContent(),
        );
        if (!outcomes.has(where)) {
          outcomes.set(where, new Set());
        }
        outcomes.get(where)!.add(text);
      }
    }
    expect([...outcomes.get('start')!]).toEqual(['Big The quick red fox.']);
    expect([...outcomes.get('middle')!]).toEqual(['very The quick red fox.']);
    for (const text of outcomes.get('end')!) {
      expect([
        ' Jumps!The quick red fox.',
        'The quick red fox. Jumps!',
      ]).toContain(text);
    }
  });

  test('step 3 sends back a target moved between table cells, or in a table a collaborator moved', () => {
    const config = {
      extensions: [TableExtension, BlockIdExtension],
      schemaVersion: 1,
    };
    // A table whose cells hold "Target" and "Dest", after a paragraph.
    const seen = seedYState(config, () =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Intro')),
        $createTableNode().append(
          $createTableRowNode().append(
            ...['Target', 'Dest'].map(text =>
              $createTableCellNode().append(
                $createParagraphNode().append($createTextNode(text)),
              ),
            ),
          ),
        ),
        $createParagraphNode().append($createTextNode('Outro')),
      ),
    );
    const $cells = () =>
      (
        (
          $getRoot().getChildAtIndex(1) as ElementNode
        ).getFirstChildOrThrow() as ElementNode
      ).getChildren() as ElementNode[];
    const id = readYState(
      seen,
      config,
      () => $getBlockId($cells()[0].getFirstChildOrThrow())!,
    );
    const cases: [string, () => void, boolean][] = [
      ['untouched', () => {}, true],
      [
        'moved to the next cell',
        () => {
          const [from, to] = $cells();
          to.clear().append(from.getFirstChildOrThrow());
          from.append($createParagraphNode());
        },
        false,
      ],
      [
        'in a table moved below the next paragraph',
        () =>
          void $getRoot()
            .getLastChildOrThrow()
            .insertAfter($getRoot().getChildAtIndex(1)!),
        false,
      ],
    ];
    for (const [name, $collaborate, applies] of cases) {
      const latest = editYState(seen, config, $collaborate, {
        writer: collaborator,
      }).state;
      const wasAt = readYState(seen, config, () => $blockAt(id));
      const isAt = readYState(latest, config, () => $blockAt(id));
      expect(wasAt !== null && wasAt === isAt, name).toBe(applies);
    }
  });

  test('step 3 sends back a target moved from one named slot to another', () => {
    const config = {
      extensions: [AppNodes, BlockIdExtension],
      onWarn: () => {},
      schemaVersion: 1,
    };
    const seen = seedYState(config, () => {
      const host = $create(TwoSlotNode);
      $setSlot(
        host,
        'left',
        $create(SlotBodyNode).append(
          $createParagraphNode().append($createTextNode('Target')),
        ),
      );
      $setSlot(
        host,
        'right',
        $create(SlotBodyNode).append(
          $createParagraphNode().append($createTextNode('Other')),
        ),
      );
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Intro')),
        host,
      );
    });
    const $slot = (name: string) =>
      $getSlot($getRoot().getLastChildOrThrow(), name) as ElementNode;
    const id = readYState(
      seen,
      config,
      () => $getBlockId($slot('left').getFirstChildOrThrow())!,
    );
    const cases: [string, () => void, boolean][] = [
      ['untouched', () => {}, true],
      [
        // First in the other slot, as it was first in its own.
        'moved to the other slot',
        () => {
          const target = $slot('left').getFirstChildOrThrow();
          $slot('right').getFirstChildOrThrow().insertBefore(target);
          $slot('left').append($createParagraphNode());
        },
        false,
      ],
    ];
    for (const [name, $collaborate, applies] of cases) {
      const latest = editYState(seen, config, $collaborate, {
        writer: collaborator,
      }).state;
      const wasAt = readYState(seen, config, () => $blockAt(id));
      const isAt = readYState(latest, config, () => $blockAt(id));
      expect(wasAt !== null && wasAt === isAt, name).toBe(applies);
    }
  });
});
