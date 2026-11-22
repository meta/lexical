/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Leftovers (D134): the blocks of a report a replay cannot apply are never
// dropped. replayUnsyncedEdits and recoverYOfflineEdits take a required
// `leftovers`: `{wrap}` writes them into the document in the update that
// replays the rest, `{handle}` gives them to the app. Here: where they are
// written (after the block, at the top, a block that is gone, a nested
// block), the new ids, a wrapper whose output cannot be written, one
// update and one undo step, the capture's lifecycle, the one run-time
// check, and the types. Run with gc off and on (LEXICAL_Y_GC=1).

import {
  $createHorizontalRuleNode,
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createHeadingNode} from '@lexical/rich-text';
import {
  $createTableNodeWithDimensions,
  $isTableCellNode,
  $isTableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setState,
  type AnyLexicalExtensionArgument,
  configExtension,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
  type SerializedLexicalNode,
  type SerializedParagraphNode,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {
  createYDoc,
  yCollab,
  type YCollabBinding,
  YCollabExtension,
} from '../..';
import {
  describeUnsyncedEdits,
  type HeadlessYConfig,
  seedYState,
  type YUnsyncedBlock,
  type YUnsyncedReport,
} from '../../headless';
import {
  attachYOfflineSession,
  loadYOffline,
  openYOfflineStore,
  recoverYOfflineEdits,
  replayUnsyncedEdits,
  wrapLeftoversAsQuote,
  type YAutoReplay,
  type YLeftovers,
  type YLeftoversWrap,
  type YOfflineBinding,
  type YOfflineCapture,
  type YOfflineStore,
  type YReplayResult,
} from '../../offline';
import {catalogAppExtension, catalogHeadlessConfig} from '../catalog/bind';
import {createFakeIndexedDB} from '../utils/fakeIndexedDB';
import {WITH_GC} from '../utils/harness';
import {
  blockIdsIn,
  expectNothingDropped,
  textIn,
} from '../utils/offlineLeftovers';
import {markSynced, trackVerdicts} from '../utils/offlineSync';

const IDS = {blockIds: 'enabled'} as const;
const catalog = {
  config: catalogHeadlessConfig(IDS, {onWarn: () => {}}),
  extension: catalogAppExtension(IDS),
};
/** An editor with the nodes every editor has, and block ids. */
const plain = {
  config: {
    extensions: [BlockIdExtension],
    onWarn: () => {},
    schemaVersion: 1,
  } as HeadlessYConfig,
  extension: BlockIdExtension as AnyLexicalExtensionArgument,
};
const noIds = {
  config: catalogHeadlessConfig({blockIds: 'absent'}, {onWarn: () => {}}),
  extension: catalogAppExtension({blockIds: 'absent'}),
};
/** A paragraph whose JSON parses only with its `strict` field. */
class StrictNode extends ParagraphNode {
  static getType(): string {
    return 'strict';
  }
  static clone(node: StrictNode): StrictNode {
    return new StrictNode(node.__key);
  }
  static importJSON(json: SerializedParagraphNode): StrictNode {
    if ((json as {strict?: unknown}).strict !== true) {
      throw new Error('a strict node needs strict: true');
    }
    return new StrictNode().updateFromJSON(json);
  }
}
const strictExtension = defineExtension({
  dependencies: [catalogAppExtension(IDS)],
  name: 'offline-leftovers-strict',
  nodes: () => [StrictNode],
});
const strict = {
  config: {
    extensions: [strictExtension],
    onWarn: () => {},
    schemaVersion: 1,
  } as HeadlessYConfig,
  extension: strictExtension as AnyLexicalExtensionArgument,
};
type App = typeof catalog;

const LABEL = 'Offline edits that did not merge';
const QUOTE: YLeftovers = {wrap: wrapLeftoversAsQuote(LABEL)};

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const live: {dispose(): void}[] = [];
afterEach(() => {
  for (const editor of live.splice(0)) {
    editor.dispose();
  }
});

interface Tab {
  readonly binding: YCollabBinding;
  readonly doc: Y.Doc;
  readonly editor: LexicalEditor;
  json(): SerializedLexicalNode[];
  /** `[type, text]` of every top-level block. */
  shown(): [string, string][];
}

/** A tab: an editor bound to a document made from `state`. */
function client(state: Uint8Array, app: App = catalog): Tab {
  const doc = createYDoc(state, {gc: WITH_GC});
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        app.extension,
        yCollab({doc, onStatus: () => {}, schemaVersion: 1, synced: true}),
      ],
      name: 'offline-leftovers-test',
      onError: error => {
        throw error;
      },
      onWarn: () => {},
    }),
  );
  live.push(editor);
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.collab;
  const json = () =>
    editor.read(() => editor.getEditorState().toJSON().root.children);
  return {
    binding,
    doc,
    editor,
    json,
    shown: () => json().map(node => [node.type, textIn(node)]),
  };
}

const $withId = <T extends LexicalNode>(node: T, id?: string): T => {
  if (id !== undefined) {
    $setState(node, blockIdState, id);
  }
  return node;
};
const $p = (text: string, id?: string) =>
  $withId($createParagraphNode().append($createTextNode(text)), id);
/** A bullet list `id` of items `[text, id]`. */
const $list = (id: string, items: [string, string][]) =>
  $withId(
    $createListNode('bullet').append(
      ...items.map(([text, itemId]) =>
        $withId($createListItemNode().append($createTextNode(text)), itemId),
      ),
    ),
    id,
  );
/** A one-cell table `id` whose cell holds the paragraph `[text, id]`. */
const $table = (id: string, [text, paragraphId]: [string, string]) => {
  const table = $withId($createTableNodeWithDimensions(1, 1, false), id);
  const row = table.getFirstChild();
  const cell = $isTableRowNode(row) ? row.getFirstChild() : null;
  if (!$isTableCellNode(cell)) {
    throw new Error('expected a cell');
  }
  cell.clear().append($p(text, paragraphId));
  return table;
};

const stored = ($blocks: () => LexicalNode[], app: App = catalog) =>
  seedYState(app.config, () => {
    $getRoot().append(...$blocks());
  });

interface Scenario {
  readonly report: YUnsyncedReport;
  readonly tab: Tab;
  /** Every block id of the three documents, at any depth. */
  readonly known: Set<string>;
}

/** Three stored documents, and a tab on the current one. */
function scenario(
  docs: {
    base: (() => LexicalNode[]) | null;
    yours: () => LexicalNode[];
    now: () => LexicalNode[];
  },
  app: App = catalog,
): Scenario {
  const base = docs.base === null ? null : stored(docs.base, app);
  const yours = stored(docs.yours, app);
  const now = stored(docs.now, app);
  const report = describeUnsyncedEdits({
    base,
    capturedAt: 1700000000000,
    config: app.config,
    current: now,
    edits: {state: yours},
    reason: 'stale',
  });
  const tab = client(now, app);
  const known = new Set(
    blockIdsIn([
      ...report.blocks.flatMap(block => [block.yours, block.base, block.now]),
      ...tab.json(),
    ]),
  );
  return {known, report, tab};
}

const $three = () => [$p('one', 'b1'), $p('two', 'b2'), $p('three', 'b3')];

/** Replay with `leftovers`, and check no block of the report was dropped. */
function replay(
  {report, tab}: Scenario,
  leftovers: YLeftovers = QUOTE,
): YReplayResult {
  const result = replayUnsyncedEdits({
    autoReplay: 'replayable',
    binding: tab.binding,
    leftovers,
    report,
  });
  expectNothingDropped(report, result);
  return result;
}

describe('where leftovers are written', () => {
  /** You changed b1 and b2; someone else changed b2 too. */
  const bothChangedB2 = () =>
    scenario({
      base: $three,
      now: () => [$p('one', 'b1'), $p('two, theirs', 'b2'), $p('three', 'b3')],
      yours: () => [
        $p('one, mine', 'b1'),
        $p('two, mine', 'b2'),
        $p('three', 'b3'),
      ],
    });

  test("'after-block' (the default): after the block both sides changed", () => {
    const s = bothChangedB2();
    expect(s.report.blocks.map(b => [b.id, b.replayable])).toEqual([
      ['b1', true],
      ['b2', false],
    ]);
    const result = replay(s);
    expect(result.applied).toEqual(['b1']);
    expect(result.notApplied).toEqual([{id: 'b2', reason: 'not-replayable'}]);
    expect(result.leftovers).toMatchObject([
      {after: 'b2', blocks: ['b2'], fallback: null},
    ]);
    expect(s.tab.shown()).toEqual([
      ['paragraph', 'one, mine'],
      ['paragraph', 'two, theirs'],
      ['paragraph', LABEL],
      ['quote', 'two, mine'],
      ['paragraph', 'three'],
    ]);
    // The ids it reports are the ids of what it wrote.
    const ids = blockIdsIn(s.tab.json());
    expect(result.inserted).toEqual(ids.slice(2, 4));
  });

  test("'top': every leftover at the top of the document, in one call of wrap", () => {
    const s = scenario({
      base: $three,
      now: () => [
        $p('one, theirs', 'b1'),
        $p('two', 'b2'),
        $p('three, theirs', 'b3'),
      ],
      yours: () => [
        $p('one, mine', 'b1'),
        $p('two, mine', 'b2'),
        $p('three, mine', 'b3'),
      ],
    });
    const calls: string[][] = [];
    const quote = wrapLeftoversAsQuote(LABEL);
    const result = replay(s, {
      placement: 'top',
      wrap: (blocks, context) => {
        calls.push(blocks.map(block => block.id));
        expect(context).toMatchObject({after: null, placement: 'top'});
        return quote(blocks, context);
      },
    });
    expect(calls).toEqual([['b1', 'b3']]);
    expect(result.applied).toEqual(['b2']);
    expect(result.leftovers).toMatchObject([
      {after: null, blocks: ['b1', 'b3'], fallback: null},
    ]);
    expect(s.tab.shown()).toEqual([
      ['paragraph', LABEL],
      ['quote', 'one, mine'],
      ['quote', 'three, mine'],
      ['paragraph', 'one, theirs'],
      ['paragraph', 'two, mine'],
      ['paragraph', 'three, theirs'],
    ]);
  });

  test("'after-block': each block after its own, one call of wrap per place", () => {
    const s = scenario({
      base: $three,
      now: () => [
        $p('one, theirs', 'b1'),
        $p('two', 'b2'),
        $p('three, theirs', 'b3'),
      ],
      yours: () => [
        $p('one, mine', 'b1'),
        $p('two', 'b2'),
        $p('three, mine', 'b3'),
      ],
    });
    const result = replay(s);
    expect(result.leftovers.map(place => [place.after, place.blocks])).toEqual([
      ['b1', ['b1']],
      ['b3', ['b3']],
    ]);
    expect(s.tab.shown().map(([, text]) => text)).toEqual([
      'one, theirs',
      LABEL,
      'one, mine',
      'two',
      'three, theirs',
      LABEL,
      'three, mine',
    ]);
  });

  test('a block that is gone: after the nearest block before it that is left', () => {
    // You changed b2 and b3; someone deleted both since.
    const s = scenario({
      base: $three,
      now: () => [$p('one', 'b1'), $p('four, theirs', 'b4')],
      yours: () => [
        $p('one', 'b1'),
        $p('two, mine', 'b2'),
        $p('three, mine', 'b3'),
      ],
    });
    const result = replay(s);
    // Both after b1, so in one wrapper, in your order.
    expect(result.leftovers).toMatchObject([
      {after: 'b1', blocks: ['b2', 'b3'], fallback: null},
    ]);
    expect(s.tab.shown().map(([, text]) => text)).toEqual([
      'one',
      LABEL,
      'two, mine',
      'three, mine',
      'four, theirs',
    ]);
  });

  test('a block that is gone, with none before it left: at the top', () => {
    const s = scenario({
      base: $three,
      now: () => [$p('two', 'b2'), $p('three', 'b3')],
      yours: () => [$p('one, mine', 'b1'), $p('two', 'b2'), $p('three', 'b3')],
    });
    const result = replay(s);
    expect(result.leftovers).toMatchObject([{after: null, blocks: ['b1']}]);
    expect(s.tab.shown().map(([, text]) => text)).toEqual([
      LABEL,
      'one, mine',
      'two',
      'three',
    ]);
  });

  test('the nearest block before it may be one this replay added', () => {
    // You added n1 after b1 and changed b2; someone deleted b1 and b2.
    const s = scenario({
      base: $three,
      now: () => [$p('three', 'b3')],
      yours: () => [
        $p('one', 'b1'),
        $p('new, mine', 'n1'),
        $p('two, mine', 'b2'),
        $p('three', 'b3'),
      ],
    });
    const result = replay(s);
    expect(result.applied).toEqual(['n1']);
    expect(result.leftovers).toMatchObject([{after: 'n1', blocks: ['b2']}]);
    expect(s.tab.shown().map(([, text]) => text)).toEqual([
      'new, mine',
      LABEL,
      'two, mine',
      'three',
    ]);
  });

  test('a nested block: after the top-level block it is in (a list item)', () => {
    // Someone turned the paragraph b2 into an item of a list.
    const s = scenario({
      base: $three,
      now: () => [
        $p('one', 'b1'),
        $list('l1', [
          ['zero', 'i0'],
          ['two', 'b2'],
        ]),
        $p('three', 'b3'),
      ],
      yours: () => [$p('one', 'b1'), $p('two, mine', 'b2'), $p('three', 'b3')],
    });
    const result = replay(s);
    expect(result.leftovers).toMatchObject([
      {after: 'l1', blocks: ['b2'], fallback: null},
    ]);
    expect(s.tab.shown()).toEqual([
      ['paragraph', 'one'],
      ['list', 'zerotwo'],
      ['paragraph', LABEL],
      ['quote', 'two, mine'],
      ['paragraph', 'three'],
    ]);
  });

  test("a nested block: after the top-level block it is in (a table cell's paragraph)", () => {
    const s = scenario({
      base: $three,
      now: () => [
        $p('one', 'b1'),
        $table('t1', ['two', 'b2']),
        $p('three', 'b3'),
      ],
      yours: () => [$p('one', 'b1'), $p('two, mine', 'b2'), $p('three', 'b3')],
    });
    const result = replay(s);
    expect(result.leftovers).toMatchObject([{after: 't1', blocks: ['b2']}]);
    expect(s.tab.shown()).toEqual([
      ['paragraph', 'one'],
      ['table', 'two'],
      ['paragraph', LABEL],
      ['quote', 'two, mine'],
      ['paragraph', 'three'],
    ]);
  });

  test('a block that is gone, whose nearest block before it is nested now', () => {
    // b1 is in a list now, and b2 is gone.
    const s = scenario({
      base: $three,
      now: () => [$list('l1', [['one', 'b1']]), $p('three', 'b3')],
      yours: () => [$p('one', 'b1'), $p('two, mine', 'b2'), $p('three', 'b3')],
    });
    const result = replay(s);
    expect(result.leftovers.map(place => [place.after, place.blocks])).toEqual([
      ['l1', ['b2']],
    ]);
    expect(s.tab.shown()).toEqual([
      ['list', 'one'],
      ['paragraph', LABEL],
      ['quote', 'two, mine'],
      ['paragraph', 'three'],
    ]);
  });

  test('without a base nothing is replayable: every block you had that differs is written', () => {
    const s = scenario({
      base: null,
      now: () => [$p('one', 'b1'), $p('two, theirs', 'b2')],
      yours: () => [
        $p('one', 'b1'),
        $p('two, mine', 'b2'),
        $p('new, mine', 'n1'),
      ],
    });
    expect(s.report.baseAvailable).toBe(false);
    const result = replay(s);
    expect(result.applied).toEqual([]);
    expect(result.leftovers).toMatchObject([
      {after: 'b2', blocks: ['b2', 'n1']},
    ]);
    expect(s.tab.shown().map(([, text]) => text)).toEqual([
      'one',
      'two, theirs',
      LABEL,
      'two, mine',
      'new, mine',
    ]);
  });

  test('without block ids: written at the top, named by position', () => {
    const s = scenario(
      {
        base: () => [$p('one'), $p('two')],
        now: () => [$p('one'), $p('two')],
        yours: () => [$p('one'), $p('two, mine')],
      },
      noIds,
    );
    expect(s.report.blocks.map(b => [b.id, b.replayable])).toEqual([
      ['#1', false],
    ]);
    const result = replay(s);
    expect(result.leftovers).toMatchObject([
      {after: null, blocks: ['#1'], inserted: ['#0', '#1']},
    ]);
    expect(s.tab.shown().map(([, text]) => text)).toEqual([
      LABEL,
      'two, mine',
      'one',
      'two',
    ]);
  });

  // CodeBunny on #9924: paired by position, one block added or removed
  // offline made every later block a change, and wrap wrote them all again.
  test('without block ids, a block added offline: only it is written (the shifted blocks are found by content)', () => {
    const four = () => [$p('one'), $p('two'), $p('three'), $p('four')];
    const s = scenario(
      {base: four, now: four, yours: () => [$p('new, mine'), ...four()]},
      noIds,
    );
    const result = replay(s);
    expect(s.tab.shown().map(([, text]) => text)).toEqual([
      LABEL,
      'new, mine',
      'one',
      'two',
      'three',
      'four',
    ]);
    expect(
      result.notApplied.filter(n => n.reason === 'in-document'),
    ).toHaveLength(4);
  });

  test('without block ids, a block deleted offline: nothing is written', () => {
    const four = () => [$p('one'), $p('two'), $p('three'), $p('four')];
    const s = scenario(
      {
        base: four,
        now: four,
        yours: () => [$p('two'), $p('three'), $p('four')],
      },
      noIds,
    );
    const before = s.tab.json();
    const result = replay(s);
    expect(result.inserted).toEqual([]);
    expect(s.tab.json()).toEqual(before);
  });

  // Identity on #9924: an added copy of a block the document holds once is
  // not in the document (the user's unchanged copy is that one).
  test.each([
    ['in the middle', ['a', 'a', 'b']],
    ['at the end', ['a', 'b', 'b']],
    ['a blank line next to a blank line', ['a', '', '', 'b']],
  ])(
    'without block ids, an added copy of a block (%s) is written, not taken for the one there',
    (_name, mine) => {
      const s = scenario(
        {
          base: () =>
            mine.includes('') ? [$p('a'), $p(''), $p('b')] : [$p('a'), $p('b')],
          now: () =>
            mine.includes('') ? [$p('a'), $p(''), $p('b')] : [$p('a'), $p('b')],
          yours: () => mine.map(text => $p(text)),
        },
        noIds,
      );
      const result = replay(s);
      expect(result.inserted.length).toBeGreaterThan(0);
      const shown = s.tab.shown().map(([, text]) => text);
      const copies = (text: string) => shown.filter(t => t === text).length;
      for (const text of new Set(mine)) {
        expect(copies(text), `"${text}"`).toBeGreaterThanOrEqual(
          mine.filter(t => t === text).length,
        );
      }
    },
  );

  // CodeBunny on #9924: the same loss with a repeated paragraph and a
  // repeated horizontal rule, through a recovery that would then have
  // deleted the capture.
  test.each([
    [
      'a paragraph pasted again',
      () => [$p('Action items'), $p('two')],
      () => [$p('Action items'), $p('two'), $p('Action items')],
    ],
    [
      'a horizontal rule repeated',
      () => [$p('one'), $createHorizontalRuleNode()],
      () => [
        $p('one'),
        $createHorizontalRuleNode(),
        $createHorizontalRuleNode(),
      ],
    ],
  ])(
    'without block ids, %s is a block the capture keeps and wrap writes',
    (_name, base, mine) => {
      const s = scenario({base, now: base, yours: mine}, noIds);
      expect(s.report.shifted).toEqual([]);
      const result = replay(s);
      expect(result.inserted.length).toBeGreaterThan(0);
      // The two blocks there, the label, and the repeated block.
      expect(s.tab.json().length).toBe(4);
    },
  );

  test('a block you deleted that someone changed stays: nothing of yours to write', () => {
    const s = scenario({
      base: $three,
      now: () => [$p('one', 'b1'), $p('two, theirs', 'b2'), $p('three', 'b3')],
      yours: () => [$p('one', 'b1'), $p('three', 'b3')],
    });
    const before = s.tab.json();
    const calls: unknown[] = [];
    const result = replay(s, {
      wrap: blocks => {
        calls.push(blocks);
        return [];
      },
    });
    expect(result).toEqual({
      applied: [],
      handled: [],
      inserted: [],
      leftovers: [],
      notApplied: [{id: 'b2', reason: 'not-replayable'}],
    });
    expect(calls).toEqual([]);
    expect(s.tab.json()).toEqual(before);
  });

  test('a block the document already holds as you had it is not written again', () => {
    const s = scenario({
      base: $three,
      now: () => [$p('one', 'b1'), $p('two, same', 'b2'), $p('three', 'b3')],
      yours: () => [$p('one', 'b1'), $p('two, same', 'b2'), $p('three', 'b3')],
    });
    const before = s.tab.json();
    const result = replay(s);
    expect(result.notApplied).toEqual([{id: 'b2', reason: 'in-document'}]);
    expect(result.inserted).toEqual([]);
    expect(s.tab.json()).toEqual(before);
  });
});

describe('ids', () => {
  test('everything written has a new id: none of the document, none of the capture', () => {
    // You changed a list (its items have ids) and a paragraph; so did
    // someone else.
    const s = scenario({
      base: () => [
        $p('one', 'b1'),
        $list('l1', [
          ['a', 'i1'],
          ['b', 'i2'],
        ]),
      ],
      now: () => [
        $p('one, theirs', 'b1'),
        $list('l1', [
          ['a, theirs', 'i1'],
          ['b', 'i2'],
        ]),
      ],
      yours: () => [
        $p('one, mine', 'b1'),
        $list('l1', [
          ['a', 'i1'],
          ['b, mine', 'i2'],
          ['c, mine', 'i3'],
        ]),
      ],
    });
    const before = blockIdsIn(s.tab.json());
    expect([...s.known].sort()).toEqual(['b1', 'i1', 'i2', 'i3', 'l1']);
    // A wrapper that leaves the ids it was given in its output.
    const result = replay(s, {
      placement: 'top',
      wrap: blocks => blocks.map(block => block.yours),
    });
    const after = blockIdsIn(s.tab.json());
    // Every block has an id, and none twice.
    expect(new Set(after).size).toBe(after.length);
    // The document's own blocks keep theirs.
    expect(after.filter(id => s.known.has(id))).toEqual(before);
    // Five new ones: the paragraph, the list and its three items.
    const minted = after.filter(id => !s.known.has(id));
    expect(minted.length).toBe(5);
    expect(result.inserted.length).toBe(2);
    for (const id of result.inserted) {
      expect(minted).toContain(id);
      expect(s.known.has(id)).toBe(false);
    }
    // The top-level blocks written are the first two of the document.
    expect(result.inserted).toEqual([after[0], after[1]]);
  });

  test('a block written where the replay removed one does not continue the removed id', () => {
    // You joined b3 into b2 (b3 is deleted, b2 changed); someone changed
    // b2. The replay removes b3 and writes your b2 where b3 was: left to
    // BlockIdExtension, the first block written would continue b3's id.
    const s = scenario({
      base: $three,
      now: () => [$p('one', 'b1'), $p('two, theirs', 'b2'), $p('three', 'b3')],
      yours: () => [$p('one', 'b1'), $p('twothree', 'b2')],
    });
    const result = replay(s);
    expect(result.applied).toEqual(['b3']);
    expect(result.leftovers).toMatchObject([{after: 'b2', blocks: ['b2']}]);
    expect(s.tab.shown().map(([, text]) => text)).toEqual([
      'one',
      'two, theirs',
      LABEL,
      'twothree',
    ]);
    expect(result.inserted.length).toBe(2);
    for (const id of result.inserted) {
      expect(s.known.has(id)).toBe(false);
    }
    expect(blockIdsIn(s.tab.json()).slice(0, 2)).toEqual(['b1', 'b2']);
  });

  test("the editor's generateId makes the ids, and one already used is made again", () => {
    // A counter that starts on ids the document and the capture hold.
    const made: string[] = [];
    const candidates = ['b1', 'b2', 'mine2', 'fresh1', 'fresh1', 'fresh2'];
    const counting = defineExtension({
      dependencies: [
        configExtension(BlockIdExtension, {
          generateId: () => {
            const id = candidates[made.length] ?? `later${made.length}`;
            made.push(id);
            return id;
          },
        }),
      ],
      name: 'offline-leftovers-counting',
    });
    const app = {
      config: {
        extensions: [counting],
        onWarn: () => {},
        schemaVersion: 1,
      } as HeadlessYConfig,
      extension: counting as AnyLexicalExtensionArgument,
    };
    const s = scenario(
      {
        base: () => [$p('one', 'b1'), $p('two', 'b2')],
        now: () => [$p('one', 'b1'), $p('two, theirs', 'b2')],
        yours: () => [
          $p('one', 'b1'),
          $p('two, mine', 'b2'),
          $p('new, mine', 'mine2'),
        ],
      },
      app,
    );
    made.length = 0;
    // b2 cannot be replayed; mine2 is added by the replay.
    const result = replay(s);
    expect(result.applied).toEqual(['mine2']);
    // The label and your b2: the first two ids nothing holds.
    expect(result.inserted).toEqual(['fresh1', 'fresh2']);
    expect(blockIdsIn(s.tab.json())).toEqual([
      'b1',
      'b2',
      'fresh1',
      'fresh2',
      'mine2',
    ]);
  });

  test('the same capture written into two tabs gets different ids in each', () => {
    const docs = {
      base: $three,
      now: () => [$p('one', 'b1'), $p('two, theirs', 'b2'), $p('three', 'b3')],
      yours: () => [$p('one', 'b1'), $p('two, mine', 'b2'), $p('three', 'b3')],
    };
    const a = replay(scenario(docs));
    const b = replay(scenario(docs));
    expect(a.inserted.length).toBe(2);
    for (const id of a.inserted) {
      expect(b.inserted).not.toContain(id);
    }
  });
});

describe('a wrapper whose output cannot be written: the blocks are written as they are, and the result says why', () => {
  const docs = {
    base: $three,
    now: () => [$p('one', 'b1'), $p('two, theirs', 'b2'), $p('three', 'b3')],
    yours: () => [$p('one', 'b1'), $p('two, mine', 'b2'), $p('three', 'b3')],
  };
  const paragraph = (text: string, children?: unknown) =>
    ({
      children: children ?? [
        {
          detail: 0,
          format: 0,
          mode: 'normal',
          style: '',
          text,
          type: 'text',
          version: 1,
        },
      ],
      direction: null,
      format: '',
      indent: 0,
      type: 'paragraph',
      version: 1,
    }) as SerializedLexicalNode;
  const cases: [string, YLeftoversWrap, RegExp][] = [
    [
      'a node type the editor has not registered',
      blocks => [
        {
          children: blocks.map(block => block.yours),
          type: 'my-app-collapsible',
          version: 1,
        } as SerializedLexicalNode,
      ],
      /returned 'my-app-collapsible', which is not a node type this editor has; register the node/,
    ],
    [
      'JSON that does not parse',
      blocks => [
        ...blocks.map(block => block.yours),
        // Registered, but its importJSON refuses this.
        {
          children: [],
          type: 'strict',
          version: 1,
        } as SerializedLexicalNode,
      ],
      /does not parse with this editor's nodes .*return what node\.exportJSON\(\) returns/,
    ],
    [
      'children that are not an array',
      blocks => [paragraph('', 'two, mine'), ...blocks.map(b => b.yours)],
      /a 'paragraph' whose children is not an array/,
    ],
    [
      'no array',
      () => null as unknown as SerializedLexicalNode[],
      /returned null; return an array of serialized top-level blocks/,
    ],
    [
      'a wrapper that throws',
      () => {
        throw new Error('no label');
      },
      /leftovers\.wrap threw \(Error: no label\)/,
    ],
    [
      'a wrapper that drops the block',
      () => [paragraph(LABEL)],
      /does not hold the text of block b2 as a node of its own .*; keep every block it is given/,
    ],
    [
      'a wrapper that returns nothing',
      () => [],
      /does not hold the text of block b2/,
    ],
    [
      'a top-level node that is not a block',
      // Every block, then a text node at the top level.
      blocks => [
        ...blocks.map(block => block.yours),
        ...blocks.flatMap(
          block =>
            (block.yours as unknown as {children: SerializedLexicalNode[]})
              .children,
        ),
      ],
      /returned a top-level 'text', which is not a block; return block nodes/,
    ],
  ];
  test.each(cases)('%s', (_name, wrap, why) => {
    const s = scenario(docs, strict);
    const result = replay(s, {wrap});
    expect(result.leftovers.length).toBe(1);
    const [place] = result.leftovers;
    expect(place.fallback).toMatch(why);
    expect(place.fallback).toMatch(
      /The blocks were written as they are instead\.$/,
    );
    expect(place.blocks).toEqual(['b2']);
    expect(place.inserted.length).toBe(1);
    // Still written, as you had it, after its block, under a new id.
    expect(s.tab.shown()).toEqual([
      ['paragraph', 'one'],
      ['paragraph', 'two, theirs'],
      ['paragraph', 'two, mine'],
      ['paragraph', 'three'],
    ]);
    expect(s.known.has(place.inserted[0])).toBe(false);
  });

  test('a block without text must be in the output as it is', () => {
    const $rule = () => $withId($createHorizontalRuleNode(), 'b2');
    const s = scenario({
      base: () => [$p('one', 'b1'), $p('two', 'b2')],
      now: () => [$p('one', 'b1'), $p('two, theirs', 'b2')],
      yours: () => [$p('one', 'b1'), $rule()],
    });
    const quote = wrapLeftoversAsQuote(LABEL);
    // Kept: the default wrapper leaves a block that is not a paragraph.
    expect(replay(s, {wrap: quote}).leftovers[0].fallback).toBeNull();
    expect(s.tab.shown().map(([type]) => type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
      'horizontalrule',
    ]);
    // Dropped: refused, and written as it is.
    const again = scenario({
      base: () => [$p('one', 'b1'), $p('two', 'b2')],
      now: () => [$p('one', 'b1'), $p('two, theirs', 'b2')],
      yours: () => [$p('one', 'b1'), $rule()],
    });
    const result = replay(again, {
      wrap: (_blocks, context) => quote([], context),
    });
    expect(result.leftovers[0].fallback).toMatch(
      /does not hold block b2 \(a horizontalrule without text, after the one before it\); put each block\.yours in the output as it is, in the order given/,
    );
    expect(again.tab.shown().map(([type]) => type)).toEqual([
      'paragraph',
      'paragraph',
      'horizontalrule',
    ]);
  });

  test('a block the editor cannot build is written as a paragraph of its text', () => {
    const s = scenario(docs);
    const report: YUnsyncedReport = {
      ...s.report,
      blocks: s.report.blocks.map(
        (block): YUnsyncedBlock => ({
          ...block,
          yours: {
            ...block.yours!,
            type: 'a-node-of-a-later-release',
          },
        }),
      ),
    };
    const result = replayUnsyncedEdits({
      autoReplay: 'replayable',
      binding: s.tab.binding,
      leftovers: QUOTE,
      report,
    });
    expectNothingDropped(report, result);
    expect(result.leftovers[0].fallback).toMatch(
      /'a-node-of-a-later-release', which is not a node type this editor has/,
    );
    expect(s.tab.shown()).toEqual([
      ['paragraph', 'one'],
      ['paragraph', 'two, theirs'],
      ['paragraph', 'two, mine'],
      ['paragraph', 'three'],
    ]);
  });

  test('one wrapper refused does not refuse the others', () => {
    const s = scenario({
      base: $three,
      now: () => [
        $p('one, theirs', 'b1'),
        $p('two', 'b2'),
        $p('three, theirs', 'b3'),
      ],
      yours: () => [
        $p('one, mine', 'b1'),
        $p('two', 'b2'),
        $p('three, mine', 'b3'),
      ],
    });
    const quote = wrapLeftoversAsQuote(LABEL);
    const result = replay(s, {
      wrap: (blocks, context) =>
        context.after === 'b1' ? [] : quote(blocks, context),
    });
    expect(result.leftovers.map(place => place.fallback === null)).toEqual([
      false,
      true,
    ]);
    expect(s.tab.shown().map(([, text]) => text)).toEqual([
      'one, theirs',
      'one, mine',
      'two',
      'three, theirs',
      LABEL,
      'three, mine',
    ]);
  });
});

describe('the default wrapper', () => {
  test('needs only paragraphs and text: without quotes, the blocks stay paragraphs', () => {
    const s = scenario(
      {
        base: $three,
        now: () => [
          $p('one', 'b1'),
          $p('two, theirs', 'b2'),
          $p('three', 'b3'),
        ],
        yours: () => [
          $p('one', 'b1'),
          $p('two, mine', 'b2'),
          $p('three', 'b3'),
        ],
      },
      plain,
    );
    const result = replay(s);
    expect(result.leftovers).toMatchObject([{blocks: ['b2'], fallback: null}]);
    expect(s.tab.shown()).toEqual([
      ['paragraph', 'one'],
      ['paragraph', 'two, theirs'],
      ['paragraph', LABEL],
      ['paragraph', 'two, mine'],
      ['paragraph', 'three'],
    ]);
  });

  test('an empty paragraph stays a paragraph: only as itself can it be told to be in the output', () => {
    // You split b2 at its start (b2 is empty now); someone changed b2.
    const s = scenario({
      base: $three,
      now: () => [$p('one', 'b1'), $p('two, theirs', 'b2'), $p('three', 'b3')],
      yours: () => [
        $p('one', 'b1'),
        $withId($createParagraphNode(), 'b2'),
        $p('two', 'n1'),
        $p('three', 'b3'),
      ],
    });
    const result = replay(s);
    expect(result.applied).toEqual(['n1']);
    expect(result.leftovers).toMatchObject([{blocks: ['b2'], fallback: null}]);
    expect(s.tab.shown()).toEqual([
      ['paragraph', 'one'],
      ['paragraph', 'two, theirs'],
      ['paragraph', LABEL],
      ['paragraph', ''],
      ['paragraph', 'two'],
      ['paragraph', 'three'],
    ]);
  });

  test('a block that is not a paragraph stays as it was; the label can name the time', () => {
    const s = scenario({
      base: () => [
        $withId($createHeadingNode('h2').append($createTextNode('Title')), 'h'),
        $list('l1', [['a', 'i1']]),
      ],
      now: () => [
        $withId(
          $createHeadingNode('h2').append($createTextNode('Title, theirs')),
          'h',
        ),
        $list('l1', [['a, theirs', 'i1']]),
      ],
      yours: () => [
        $withId(
          $createHeadingNode('h2').append($createTextNode('Title, mine')),
          'h',
        ),
        $list('l1', [['a, mine', 'i1']]),
      ],
    });
    const result = replay(s, {
      placement: 'top',
      wrap: wrapLeftoversAsQuote(
        ({capturedAt, reason}) => `Not merged (${reason}) · ${capturedAt}`,
      ),
    });
    expect(result.leftovers[0].fallback).toBeNull();
    expect(s.tab.shown()).toEqual([
      ['paragraph', 'Not merged (stale) · 1700000000000'],
      ['heading', 'Title, mine'],
      ['list', 'a, mine'],
      ['heading', 'Title, theirs'],
      ['list', 'a, theirs'],
    ]);
  });
});

describe('one update, one undo step', () => {
  const docs = {
    base: $three,
    now: () => [$p('one', 'b1'), $p('two, theirs', 'b2'), $p('three', 'b3')],
    yours: () => [
      $p('one, mine', 'b1'),
      $p('two, mine', 'b2'),
      $p('three', 'b3'),
      $p('four, mine', 'b4'),
    ],
  };

  test('a collaborator sees one change, with the replayed and the inserted blocks', async () => {
    const s = scenario(docs);
    const peer = client(Y.encodeStateAsUpdate(s.tab.doc));
    await flush();
    // The binding's writes of content (its own origin). Its first write
    // also records its schema version, in a transaction of its own that
    // holds nothing of the document.
    const writes: Uint8Array[] = [];
    s.tab.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === s.tab.binding.binding) {
        writes.push(update);
      }
    });
    let editorUpdates = 0;
    const off = s.tab.editor.registerUpdateListener(({dirtyElements}) => {
      if (dirtyElements.size > 0) {
        editorUpdates++;
      }
    });
    const result = replay(s);
    await flush();
    off();
    expect(result.applied).toEqual(['b1', 'b4']);
    expect(result.inserted.length).toBe(2);
    expect(editorUpdates).toBe(1);
    expect(writes.length).toBe(1);
    // The collaborator gets that one update, as one change, and holds the
    // same document: the replayed and the inserted blocks, ids included.
    let peerChanges = 0;
    peer.editor.registerUpdateListener(({dirtyElements}) => {
      if (dirtyElements.size > 0) {
        peerChanges++;
      }
    });
    Y.applyUpdate(peer.doc, writes[0], 'provider');
    await flush();
    expect(peerChanges).toBe(1);
    expect(peer.json()).toEqual(s.tab.json());
    expect(peer.shown().map(([, text]) => text)).toEqual([
      'one, mine',
      'two, theirs',
      LABEL,
      'two, mine',
      'three',
      'four, mine',
    ]);
  });

  test('one undo takes back the replayed and the inserted blocks; redo puts both back', async () => {
    const s = scenario(docs);
    const before = s.tab.json();
    replay(s);
    const after = s.tab.json();
    expect(after).not.toEqual(before);
    const history = s.tab.binding.history!;
    expect(history.undo()).toBe(true);
    await flush();
    expect(s.tab.json()).toEqual(before);
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toBe(true);
    await flush();
    expect(s.tab.shown()).toEqual(after.map(node => [node.type, textIn(node)]));
  });

  test('an update that fails writes nothing: with wrap it throws (no result is the only place of a block), and a handler gets every block with content', () => {
    const s = scenario(docs);
    const before = s.tab.json();
    // The editor's onError swallows; the update fails after it ran.
    const failing = (tab: Tab): YOfflineBinding => {
      const editor = new Proxy(tab.editor, {
        get(target, name) {
          if (name === 'update') {
            return (fn: () => void, options: object) => {
              try {
                target.update(() => {
                  fn();
                  throw new Error('injected: the update failed');
                }, options);
              } catch {
                // The editor's onError would have swallowed it.
              }
            };
          }
          const value = Reflect.get(target, name);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return {
        binding: new Proxy(tab.binding.binding, {
          get(target, name) {
            return name === 'editor' ? editor : Reflect.get(target, name);
          },
        }),
        freeze: () => tab.binding.freeze(),
        get status() {
          return tab.binding.status;
        },
      } as YOfflineBinding;
    };
    const NOT_WRITTEN = ['b1', 'b2', 'b4'].map(id => ({
      id,
      reason: 'not-written',
    }));
    expect(() =>
      replayUnsyncedEdits({
        autoReplay: 'replayable',
        binding: failing(s.tab),
        leftovers: QUOTE,
        report: s.report,
      }),
    ).toThrow(
      /editor update failed .* nothing of the report was applied or inserted: call it again with the same report/,
    );
    expect(s.tab.json()).toEqual(before);
    const handled: string[][] = [];
    expect(
      replayUnsyncedEdits({
        autoReplay: 'replayable',
        binding: failing(s.tab),
        leftovers: {handle: blocks => handled.push(blocks.map(b => b.id))},
        report: s.report,
      }),
    ).toMatchObject({
      applied: [],
      handled: ['b2', 'b1', 'b4'],
      notApplied: NOT_WRITTEN,
    });
    // The replayable blocks too: none was applied.
    expect(handled).toEqual([['b2', 'b1', 'b4']]);
    expect(s.tab.json()).toEqual(before);
    // Written by a later call.
    replay(s);
    expect(s.tab.shown().map(([, text]) => text)).toEqual([
      'one, mine',
      'two, theirs',
      LABEL,
      'two, mine',
      'three',
      'four, mine',
    ]);
  });
});

describe('the capture', () => {
  const unwrap = <T>(
    result: {ok: true; value: T} | {ok: false; error: {message: string}},
  ): T => {
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value;
  };
  const sync = (a: Y.Doc, b: Y.Doc) => {
    const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    Y.applyUpdate(b, toB, 'provider');
    Y.applyUpdate(a, toA, 'provider');
  };
  const edit = (tab: Tab, fn: () => void) =>
    tab.editor.update(fn, {discrete: true});
  const $block = (id: string) => {
    const found = $getRoot()
      .getChildren()
      .find(node => blockIdsIn([node.exportJSON()])[0] === id);
    if (found === undefined) {
      throw new Error(`no block ${id}`);
    }
    return found;
  };

  /**
   * A tab at e1 changed b1, added b4, deleted b2 and changed b3; the room
   * moved to e2, where someone else changed b3.
   */
  async function moved(clock?: () => number) {
    const fake = createFakeIndexedDB();
    const store: YOfflineStore = unwrap(
      await openYOfflineStore({idb: fake.idb, locks: fake.locks}),
    );
    const room = client(stored($three));
    await flush();
    const tab = client(Y.encodeStateAsUpdate(room.doc));
    await flush();
    const session = attachYOfflineSession({
      binding: tab.binding,
      epoch: 'e1',
      key: 'doc',
      loaded: null,
      now: clock,
      offline: {persist: 'document', stage: 'persist', store},
      onError: error => {
        throw new Error(error.message);
      },
      stopSync: () => {},
    });
    const confirmed = await session.serverEpoch('e1');
    if (confirmed.kind === 'same') {
      confirmed.markSynced();
    }
    edit(tab, () => {
      $block('b1').replace($p('one, mine', 'b1'));
      $block('b1').insertAfter($p('four, mine', 'b4'));
      $block('b2').remove();
      $block('b3').replace($p('three, mine', 'b3'));
    });
    const verdict = await session.serverEpoch('e2');
    if (verdict.kind !== 'moved' || verdict.capture === null) {
      throw new Error('expected a capture');
    }
    const next = client(Y.encodeStateAsUpdate(room.doc));
    await flush();
    edit(next, () => $block('b3').replace($p('three, theirs', 'b3')));
    const fresh = client(Y.encodeStateAsUpdate(next.doc));
    await flush();
    const recover = (
      leftovers: YLeftovers,
      options: {
        stage?: 'persist' | 'replay';
        autoReplay?: YAutoReplay;
        at?: number;
      } = {},
    ) =>
      recoverYOfflineEdits({
        autoReplay: options.autoReplay ?? 'replayable',
        binding: fresh.binding,
        config: catalog.config,
        epoch: 'e2',
        key: 'doc',
        leftovers,
        now: () => options.at ?? 1234,
        stage: options.stage ?? 'replay',
        store,
      });
    return {capture: verdict.capture, fresh, next, recover, room, store, sync};
  }

  const AFTER = [
    'one, mine',
    'four, mine',
    'three, theirs',
    LABEL,
    'three, mine',
  ];

  const holds = (tab: Tab, id: string) => blockIdsIn(tab.json()).includes(id);
  const count = (tab: Tab, text: string) =>
    tab.shown().filter(([, shownText]) => shownText === text).length;
  /** `store`, with putCapture refusing every capture marked resolved. */
  const refusingResolved = (store: YOfflineStore): YOfflineStore =>
    new Proxy(store, {
      get(target, name) {
        if (name === 'putCapture') {
          return async (capture: YOfflineCapture) =>
            capture.resolved !== undefined
              ? {error: {code: 'failed', message: 'refused'}, ok: false}
              : target.putCapture(capture);
        }
        const value = Reflect.get(target, name);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  test('a write the binding refuses (a wrapper output it cannot store) is not resolved: the replay throws, and the capture is kept and released', async () => {
    const {fresh, store} = await moved();
    // Passes the wrap check (registered types, every block's text), but
    // the binding cannot store a slot on a paragraph: it turns read only.
    const slotOnALine: YLeftovers = {
      wrap: blocks => [
        {
          $slots: {
            note: {
              children: [],
              direction: null,
              format: '',
              indent: 0,
              type: 'paragraph',
              version: 1,
            },
          },
          children: [],
          direction: null,
          format: '',
          indent: 0,
          type: 'paragraph',
          version: 1,
        } as SerializedLexicalNode,
        ...blocks.map(block => block.yours),
      ],
    };
    const session = trackVerdicts(
      attachYOfflineSession({
        binding: fresh.binding,
        epoch: 'e2',
        key: 'doc',
        loaded: null,
        offline: {persist: 'captures-only', stage: 'replay', store},
        onError: () => {},
        stopSync: () => {},
      }),
    );
    await markSynced(session);
    const recovered = unwrap(
      await recoverYOfflineEdits({
        autoReplay: 'replayable',
        binding: fresh.binding,
        config: catalog.config,
        epoch: 'e2',
        key: 'doc',
        leftovers: slotOnALine,
        now: () => 1234,
        session,
        stage: 'replay',
        store,
      }),
    );
    expect(fresh.binding.status.kind).toBe('readonly');
    expect(recovered[0].replay).toBeNull();
    expect(recovered[0].report.ok).toBe(false);
    expect(
      recovered[0].report.ok ? '' : recovered[0].report.error.message,
    ).toMatch(/the binding did not store replayUnsyncedEdits' update/);
    const [kept] = unwrap(await store.captures('doc'));
    expect(kept.resolved).toBeUndefined();
    expect(kept.claimed).toBe(false);
    session.dispose();
  });

  test('the mark after the write is lost: a retake a minute later sees the write in the document and resolves without writing again', async () => {
    const {fresh, store} = await moved();
    const first = await recoverYOfflineEdits({
      autoReplay: 'replayable',
      binding: fresh.binding,
      config: catalog.config,
      epoch: 'e2',
      key: 'doc',
      leftovers: QUOTE,
      now: () => 1234,
      stage: 'replay',
      store: refusingResolved(store),
    });
    expect(first.ok).toBe(false);
    expect(count(fresh, 'three, mine')).toBe(1);
    const [kept] = unwrap(await store.captures('doc'));
    expect(kept.claimed).toBe(true);
    expect(kept.resolved).toBeUndefined();
    expect(kept.claimedWrite!.ids).toHaveLength(16);
    // The first block written for the leftovers has the first id recorded.
    expect(holds(fresh, kept.claimedWrite!.ids[0])).toBe(true);
    // A minute on, in a tab that holds the first write (it synced).
    const other = client(Y.encodeStateAsUpdate(fresh.doc));
    await flush();
    for (const tab of [fresh, other]) {
      const [entry] = unwrap(
        await recoverYOfflineEdits({
          autoReplay: 'replayable',
          binding: tab.binding,
          config: catalog.config,
          epoch: 'e2',
          key: 'doc',
          leftovers: QUOTE,
          now: () => (kept.claimedAt ?? 0) + 60000,
          stage: 'replay',
          store,
        }),
      );
      expect(entry.replay).toBeNull();
      expect(entry.capture.resolved).toBeDefined();
      expect(count(tab, 'three, mine')).toBe(1);
      expect(count(tab, LABEL)).toBe(1);
    }
  });

  test('the mark after the write is lost and a collaborator deletes the label: a retake finds the write by the other ids it recorded', async () => {
    const {fresh, store} = await moved();
    await recoverYOfflineEdits({
      autoReplay: 'replayable',
      binding: fresh.binding,
      config: catalog.config,
      epoch: 'e2',
      key: 'doc',
      leftovers: QUOTE,
      now: () => 1234,
      stage: 'replay',
      store: refusingResolved(store),
    });
    const [kept] = unwrap(await store.captures('doc'));
    expect(count(fresh, LABEL)).toBe(1);
    edit(fresh, () => {
      const label = $getRoot()
        .getChildren()
        .find(node => node.getTextContent() === LABEL);
      label!.remove();
    });
    expect(count(fresh, LABEL)).toBe(0);
    const [entry] = unwrap(
      await recoverYOfflineEdits({
        autoReplay: 'replayable',
        binding: fresh.binding,
        config: catalog.config,
        epoch: 'e2',
        key: 'doc',
        leftovers: QUOTE,
        now: () => (kept.claimedAt ?? 0) + 60000,
        stage: 'replay',
        store,
      }),
    );
    expect(entry.replay).toBeNull();
    expect(entry.capture.resolved).toBeDefined();
    expect(count(fresh, 'three, mine')).toBe(1);
  });

  test('the update fails, the release is refused, and the user then types: a retake a minute later writes the capture (its first leftover is not in the document)', async () => {
    const {fresh, store} = await moved();
    // The editor's onError swallows; the update fails after it ran.
    const editor = new Proxy(fresh.editor, {
      get(target, name) {
        if (name === 'update') {
          return (fn: () => void, options: object) => {
            try {
              target.update(() => {
                fn();
                throw new Error('injected: the update failed');
              }, options);
            } catch {
              // The editor's onError would have swallowed it.
            }
          };
        }
        const value = Reflect.get(target, name);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const failing = {
      binding: new Proxy(fresh.binding.binding, {
        get(target, name) {
          return name === 'editor' ? editor : Reflect.get(target, name);
        },
      }),
      freeze: () => fresh.binding.freeze(),
      get status() {
        return fresh.binding.status;
      },
    } as YOfflineBinding;
    const refusingRelease: YOfflineStore = new Proxy(store, {
      get(target, name) {
        if (name === 'putCapture') {
          return async (capture: YOfflineCapture) =>
            capture.claimed === false
              ? {error: {code: 'quota', message: 'refused'}, ok: false}
              : target.putCapture(capture);
        }
        const value = Reflect.get(target, name);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await recoverYOfflineEdits({
      autoReplay: 'replayable',
      binding: failing,
      config: catalog.config,
      epoch: 'e2',
      key: 'doc',
      leftovers: QUOTE,
      now: () => 1234,
      stage: 'replay',
      store: refusingRelease,
    });
    const [kept] = unwrap(await store.captures('doc'));
    // Still claimed, with where its write would have been.
    expect(kept.claimed).toBe(true);
    expect(kept.claimedWrite!.ids).toHaveLength(16);
    expect(count(fresh, 'three, mine')).toBe(0);
    // The user types: this client's clock moves past the one recorded.
    edit(fresh, () => $block('b1').insertAfter($p('typed later', 't1')));
    const [entry] = unwrap(
      await recoverYOfflineEdits({
        autoReplay: 'replayable',
        binding: fresh.binding,
        config: catalog.config,
        epoch: 'e2',
        key: 'doc',
        leftovers: QUOTE,
        now: () => (kept.claimedAt ?? 0) + 60000,
        stage: 'replay',
        store,
      }),
    );
    expect(entry.replay).not.toBeNull();
    expect(count(fresh, 'three, mine')).toBe(1);
    expect(count(fresh, 'one, mine')).toBe(1);
    expect(entry.capture.resolved).toBeDefined();
  });

  test('the mark after the write is lost and the write is not in this document (its tab closed before it synced): a retake writes it', async () => {
    const {next, store} = await moved();
    const lost = client(Y.encodeStateAsUpdate(next.doc));
    await flush();
    const first = await recoverYOfflineEdits({
      autoReplay: 'replayable',
      binding: lost.binding,
      config: catalog.config,
      epoch: 'e2',
      key: 'doc',
      leftovers: QUOTE,
      now: () => 1234,
      stage: 'replay',
      store: refusingResolved(store),
    });
    expect(first.ok).toBe(false);
    expect(count(lost, 'three, mine')).toBe(1);
    const [kept] = unwrap(await store.captures('doc'));
    // Another tab, which never got that write.
    const other = client(Y.encodeStateAsUpdate(next.doc));
    await flush();
    const [entry] = unwrap(
      await recoverYOfflineEdits({
        autoReplay: 'replayable',
        binding: other.binding,
        config: catalog.config,
        epoch: 'e2',
        key: 'doc',
        leftovers: QUOTE,
        now: () => (kept.claimedAt ?? 0) + 60000,
        stage: 'replay',
        store,
      }),
    );
    expect(entry.replay).not.toBeNull();
    expect(count(other, 'three, mine')).toBe(1);
  });

  test('wrap: everything of it is in the document, and the capture is resolved', async () => {
    const {capture, fresh, recover, store} = await moved();
    const recovered = unwrap(await recover(QUOTE));
    expect(recovered.length).toBe(1);
    const [entry] = recovered;
    expect(entry.replay).toMatchObject({
      applied: ['b1', 'b4', 'b2'],
      handled: [],
      leftovers: [{after: 'b3', blocks: ['b3'], fallback: null}],
      notApplied: [{id: 'b3', reason: 'not-replayable'}],
    });
    expect(fresh.shown().map(([, text]) => text)).toEqual(AFTER);
    // Nothing is left to show.
    const report = unwrap(entry.report);
    expect(report.blocks).toEqual([]);
    expect(report.fragment).toEqual([]);
    // Resolved, in the result and in the store.
    const resolved = {
      at: 1234,
      inserted: entry.replay!.inserted,
      vector: expect.any(Uint8Array),
    };
    expect(entry.capture).toMatchObject({claimed: true, id: capture.id});
    expect(entry.capture.resolved).toEqual(resolved);
    expect(entry.replay!.inserted.length).toBe(2);
    const kept = unwrap(await store.captures('doc'));
    expect(kept).toMatchObject([{claimed: true, id: capture.id}]);
    expect(kept[0].resolved).toEqual(resolved);
  });

  test('wrap: a second call writes nothing again, and the capture goes once the server holds the document', async () => {
    const {fresh, next, store} = await moved();
    const now = trackVerdicts(
      attachYOfflineSession({
        binding: fresh.binding,
        epoch: 'e2',
        key: 'doc',
        loaded: null,
        offline: {persist: 'captures-only', stage: 'replay', store},
        onError: () => {},
        stopSync: () => {},
      }),
    );
    await markSynced(now);
    const recover = () =>
      recoverYOfflineEdits({
        autoReplay: 'replayable',
        binding: fresh.binding,
        config: catalog.config,
        epoch: 'e2',
        key: 'doc',
        leftovers: QUOTE,
        session: now,
        stage: 'replay',
        store,
      });
    const first = unwrap(await recover());
    expect(first[0].replay!.inserted.length).toBe(2);
    expect(fresh.shown().map(([, text]) => text)).toEqual(AFTER);
    // Before the server has it (a panel refresh): kept, nothing to show,
    // and nothing written twice.
    expect(now.hasUnsyncedEdits).toBe(true);
    const again = unwrap(await recover());
    expect(again.length).toBe(1);
    expect(again[0].replay).toBeNull();
    expect(unwrap(again[0].report).blocks).toEqual([]);
    expect(again[0].capture.resolved).toEqual(first[0].capture.resolved);
    expect(fresh.shown().map(([, text]) => text)).toEqual(AFTER);
    // Someone changes a block the replay wrote: still nothing to show, the
    // capture is resolved.
    sync(fresh.doc, next.doc);
    await flush();
    edit(next, () => $block('b1').replace($p('one, theirs later', 'b1')));
    sync(fresh.doc, next.doc);
    await flush();
    await markSynced(now);
    // The server holds it: nothing is left in storage.
    expect(unwrap(await recover())).toEqual([]);
    expect(unwrap(await store.captures('doc'))).toEqual([]);
    expect(unwrap(await store.slots('doc'))).toEqual([]);
    expect(fresh.shown().map(([, text]) => text)).toEqual([
      'one, theirs later',
      ...AFTER.slice(1),
    ]);
    expect(next.json()).toEqual(fresh.json());
    now.dispose();
  });

  test('wrap: a capture with only blocks that cannot be replayed is written too', async () => {
    const fake = createFakeIndexedDB();
    const store = unwrap(
      await openYOfflineStore({idb: fake.idb, locks: fake.locks}),
    );
    // A document that never synced: no base, so nothing is replayable.
    const tab = client(stored(() => [$p('draft, mine', 'd1')]));
    await flush();
    const session = attachYOfflineSession({
      binding: tab.binding,
      epoch: null,
      key: 'doc',
      loaded: null,
      offline: {persist: 'document', stage: 'persist', store},
      onError: () => {},
      stopSync: () => {},
    });
    unwrap(await session.flush());
    session.dispose();
    await flush();
    const fresh = client(stored($three));
    await flush();
    const recovered = unwrap(
      await recoverYOfflineEdits({
        autoReplay: 'replayable',
        binding: fresh.binding,
        config: catalog.config,
        epoch: 'e1',
        key: 'doc',
        leftovers: QUOTE,
        stage: 'replay',
        store,
      }),
    );
    expect(recovered.length).toBe(1);
    expect(recovered[0].replay).toMatchObject({
      applied: [],
      leftovers: [{after: null, blocks: ['d1']}],
    });
    expect(fresh.shown().map(([, text]) => text)).toEqual([
      LABEL,
      'draft, mine',
      'one',
      'two',
      'three',
    ]);
    expect(recovered[0].capture.resolved).toBeDefined();
  });

  test('wrap: a capture claimed by a tab that closed before it wrote it is taken again once the claim is old', async () => {
    const {capture, fresh, store} = await moved();
    // A tab claimed it, and closed before its replay.
    expect(unwrap(await store.claimCapture('doc', capture.id))).toBe(true);
    const claimedAt = unwrap(await store.captures('doc'))[0].claimedAt!;
    expect(typeof claimedAt).toBe('number');
    const before = fresh.json();
    const recover = (at: number) =>
      recoverYOfflineEdits({
        autoReplay: 'replayable',
        binding: fresh.binding,
        config: catalog.config,
        epoch: 'e2',
        key: 'doc',
        leftovers: QUOTE,
        now: () => at,
        stage: 'replay',
        store,
      });
    // A claim that may be being written now is left alone: listed, and
    // still stored.
    const soon = unwrap(await recover(claimedAt + 59999));
    expect(soon[0].replay).toBeNull();
    expect(unwrap(soon[0].report).blocks.length).toBe(4);
    expect(fresh.json()).toEqual(before);
    expect(unwrap(await store.captures('doc'))[0].resolved).toBeUndefined();
    // An old one is taken again, and written.
    const later = unwrap(await recover(claimedAt + 60000));
    expect(later[0].replay).toMatchObject({
      applied: ['b1', 'b4', 'b2'],
      leftovers: [{after: 'b3', blocks: ['b3']}],
    });
    expect(fresh.shown().map(([, text]) => text)).toEqual(AFTER);
    expect(later[0].capture.resolved).toBeDefined();
    // Once.
    expect(unwrap(await recover(claimedAt + 200000))[0].replay).toBeNull();
    expect(fresh.shown().map(([, text]) => text)).toEqual(AFTER);
  });

  test('an app that moves from handle to wrap: what its handler was given is written', async () => {
    const {fresh, recover, store} = await moved();
    const handed: string[][] = [];
    unwrap(
      await recover({handle: blocks => handed.push(blocks.map(b => b.id))}),
    );
    expect(handed).toEqual([['b3']]);
    expect(fresh.shown().map(([, text]) => text)).toEqual([
      'one, mine',
      'four, mine',
      'three, theirs',
    ]);
    const {claimedAt} = unwrap(await store.captures('doc'))[0];
    // The next release of the app passes wrap (and has no panel).
    const later = unwrap(
      await recoverYOfflineEdits({
        autoReplay: 'replayable',
        binding: fresh.binding,
        config: catalog.config,
        epoch: 'e2',
        key: 'doc',
        leftovers: QUOTE,
        now: () => claimedAt! + 60000,
        stage: 'replay',
        store,
      }),
    );
    expect(later[0].replay).toMatchObject({
      applied: [],
      leftovers: [{after: 'b3', blocks: ['b3']}],
    });
    expect(fresh.shown().map(([, text]) => text)).toEqual(AFTER);
    expect(later[0].capture.resolved).toBeDefined();
  });

  test("wrap at stage 'persist': nothing is written, and the capture stays stored", async () => {
    const {capture, fresh, recover, store} = await moved();
    const before = fresh.json();
    const recovered = unwrap(await recover(QUOTE, {stage: 'persist'}));
    expect(recovered[0].replay).toBeNull();
    expect(unwrap(recovered[0].report).blocks.length).toBe(4);
    expect(fresh.json()).toEqual(before);
    const kept = unwrap(await store.captures('doc'));
    expect(kept).toMatchObject([{claimed: false, id: capture.id}]);
    expect(kept[0].resolved).toBeUndefined();
    // Raising the stage writes it.
    unwrap(await recover(QUOTE));
    expect(fresh.shown().map(([, text]) => text)).toEqual(AFTER);
  });

  test('handle: the handler receives exactly the blocks that were not replayed, and the capture stays', async () => {
    const {capture, fresh, recover, store} = await moved();
    const calls: {ids: string[]; captureId: string | null}[] = [];
    const handler: YLeftovers = {
      handle: (blocks, context) => {
        calls.push({
          captureId: context.captureId,
          ids: blocks.map(block => block.id),
        });
        expect(context.report.blocks).toBe(blocks);
      },
    };
    const recovered = unwrap(await recover(handler));
    expect(calls).toEqual([{captureId: capture.id, ids: ['b3']}]);
    expect(recovered[0].replay).toEqual({
      applied: ['b1', 'b4', 'b2'],
      handled: ['b3'],
      inserted: [],
      leftovers: [],
      notApplied: [{id: 'b3', reason: 'not-replayable'}],
    });
    // Nothing of b3 was written.
    expect(fresh.shown().map(([, text]) => text)).toEqual([
      'one, mine',
      'four, mine',
      'three, theirs',
    ]);
    // The capture stays, unresolved, for the app's panel; every later call
    // hands the block over again.
    const kept = unwrap(await store.captures('doc'));
    expect(kept).toMatchObject([{claimed: true, id: capture.id}]);
    expect(kept[0].resolved).toBeUndefined();
    const again = unwrap(await recover(handler));
    expect(again[0].replay).toBeNull();
    expect(unwrap(again[0].report).blocks.map(b => b.id)).toEqual(['b3']);
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  test("handle at stage 'persist': the handler receives every block of the capture", async () => {
    const {recover} = await moved();
    const calls: string[][] = [];
    unwrap(
      await recover(
        {handle: blocks => calls.push(blocks.map(block => block.id))},
        {stage: 'persist'},
      ),
    );
    expect(calls).toEqual([['b1', 'b4', 'b3', 'b2']]);
  });

  test('handle, called directly: every block not applied, once', async () => {
    const s = scenario({
      base: $three,
      now: () => [$p('one', 'b1'), $p('two, theirs', 'b2')],
      yours: () => [
        $p('one, mine', 'b1'),
        $p('two, mine', 'b2'),
        $p('three, mine', 'b3'),
      ],
    });
    const calls: YUnsyncedBlock[][] = [];
    const result = replay(s, {
      handle: (blocks, context) => {
        calls.push([...blocks]);
        expect(context).toEqual({captureId: null, report: s.report});
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].map(block => block.id)).toEqual(['b2', 'b3']);
    expect(result).toMatchObject({
      applied: ['b1'],
      handled: ['b2', 'b3'],
      inserted: [],
    });
    expect(s.tab.shown().map(([, text]) => text)).toEqual([
      'one, mine',
      'two, theirs',
    ]);
  });

  describe('autoReplay: which blocks are written over the document by themselves', () => {
    const DAY = 24 * 3600 * 1000;
    const ALL_IN = [
      'one',
      LABEL,
      'one, mine',
      'four, mine',
      'two',
      'three, theirs',
      LABEL,
      'three, mine',
    ];

    test("the capture records when its base was on the server (the session's markSynced)", async () => {
      const {capture} = await moved(() => 1000);
      expect(capture.baseAt).toBe(1000);
    });

    test('a stored slot knows when its base was stored, and a capture made from it carries that', async () => {
      const fake = createFakeIndexedDB();
      const store: YOfflineStore = unwrap(
        await openYOfflineStore({idb: fake.idb, locks: fake.locks}),
      );
      const tab = client(stored($three));
      await flush();
      const session = trackVerdicts(
        attachYOfflineSession({
          binding: tab.binding,
          epoch: 'e1',
          key: 'doc',
          loaded: null,
          offline: {persist: 'document', stage: 'persist', store},
          onError: error => {
            throw new Error(error.message);
          },
          stopSync: () => {},
        }),
      );
      const before = Date.now();
      await markSynced(session);
      unwrap(await session.flush());
      const after = Date.now();
      edit(tab, () => $block('b1').replace($p('one, mine', 'b1')));
      unwrap(await session.flush());
      const loaded = unwrap(
        await loadYOffline({epoch: 'e1', key: 'doc', store}),
      );
      expect(loaded.hasUnsyncedEdits).toBe(true);
      expect(loaded.baseAt).toBeGreaterThanOrEqual(before);
      expect(loaded.baseAt).toBeLessThanOrEqual(after);
      // The tab goes; a recovery at e2 captures its rows from storage.
      session.dispose();
      const fresh = client(stored($three));
      await flush();
      unwrap(
        await recoverYOfflineEdits({
          autoReplay: 'none',
          binding: fresh.binding,
          config: catalog.config,
          epoch: 'e2',
          key: 'doc',
          leftovers: {handle: () => {}},
          stage: 'persist',
          store,
        }),
      );
      const [capture] = unwrap(await store.captures('doc'));
      expect(capture.baseAt).toBe(loaded.baseAt);
    });

    test("'none': nothing is replayed, every block you added or changed is written under the wrapper, and the capture is resolved", async () => {
      const {fresh, recover} = await moved(() => 1000);
      const [entry] = unwrap(await recover(QUOTE, {autoReplay: 'none'}));
      expect(entry.replay).toMatchObject({applied: [], handled: []});
      expect(entry.replay!.notApplied).toEqual(
        expect.arrayContaining([
          {id: 'b1', reason: 'not-auto-replayed'},
          {id: 'b4', reason: 'not-auto-replayed'},
          // A block you deleted stays: there is nothing of yours to write.
          {id: 'b2', reason: 'not-auto-replayed'},
          {id: 'b3', reason: 'not-replayable'},
        ]),
      );
      expect(fresh.shown().map(([, text]) => text)).toEqual(ALL_IN);
      expect(entry.capture.resolved).toBeDefined();
      expect(entry.replay!.leftovers.flatMap(place => place.blocks)).toEqual([
        'b1',
        'b4',
        'b3',
      ]);
    });

    test('{maxBaseAge}: a copy at most that old is replayed; an older one is written under the wrapper', async () => {
      const young = await moved(() => 1000);
      const [recent] = unwrap(
        await young.recover(QUOTE, {
          at: 1000 + 3 * DAY,
          autoReplay: {maxBaseAge: 3 * DAY},
        }),
      );
      expect(recent.replay!.applied).toEqual(['b1', 'b4', 'b2']);
      expect(young.fresh.shown().map(([, text]) => text)).toEqual(AFTER);

      const old = await moved(() => 1000);
      const [stale] = unwrap(
        await old.recover(QUOTE, {
          at: 1000 + 3 * DAY + 1,
          autoReplay: {maxBaseAge: 3 * DAY},
        }),
      );
      expect(stale.replay!.applied).toEqual([]);
      expect(old.fresh.shown().map(([, text]) => text)).toEqual(ALL_IN);
    });

    test('{maxBaseAge}: a capture whose base time is unknown counts as older', async () => {
      const {capture, fresh, recover, store} = await moved(() => 1000);
      // As a capture of an earlier release, or of a store of your own.
      const {baseAt: _unknown, ...earlier} = capture;
      unwrap(await store.putCapture(earlier));
      const [entry] = unwrap(
        await recover(QUOTE, {at: 1001, autoReplay: {maxBaseAge: DAY}}),
      );
      expect(entry.replay!.applied).toEqual([]);
      expect(fresh.shown().map(([, text]) => text)).toEqual(ALL_IN);
    });

    test("handle with 'none': the handler gets every block, and the capture is not claimed", async () => {
      const {fresh, recover, store} = await moved(() => 1000);
      const given: string[][] = [];
      const [entry] = unwrap(
        await recover(
          {handle: blocks => given.push(blocks.map(block => block.id))},
          {autoReplay: 'none'},
        ),
      );
      expect(given.map(ids => [...ids].sort())).toEqual([
        ['b1', 'b2', 'b3', 'b4'],
      ]);
      expect(entry.replay).toBe(null);
      expect(fresh.shown().map(([, text]) => text)).toEqual([
        'one',
        'two',
        'three, theirs',
      ]);
      expect(unwrap(await store.captures('doc'))).toMatchObject([
        {claimed: false},
      ]);
    });

    test('a JavaScript caller without autoReplay gets a TypeError naming the choices, before anything is read or written', async () => {
      const {fresh, recover, store} = await moved(() => 1000);
      const before = fresh.shown();
      await expect(
        recoverYOfflineEdits({
          binding: fresh.binding,
          config: catalog.config,
          epoch: 'e2',
          key: 'doc',
          leftovers: QUOTE,
          stage: 'replay',
          store,
        } as never),
      ).rejects.toThrow(
        /recoverYOfflineEdits needs autoReplay \(got undefined\): pass autoReplay: 'replayable' .*, 'none' .* or \{maxBaseAge: <milliseconds>\}.*Nothing was read or written\.$/,
      );
      for (const autoReplay of ['auto', {maxBaseAge: '3d'}, {maxBaseAge: -1}]) {
        await expect(
          recover(QUOTE, {autoReplay: autoReplay as never}),
        ).rejects.toThrow(/needs autoReplay/);
      }
      expect(fresh.shown()).toEqual(before);
      expect(unwrap(await store.captures('doc'))).toMatchObject([
        {claimed: false},
      ]);
    });
  });
});

describe('the one run-time check: a JavaScript caller without leftovers', () => {
  const docs = {
    base: $three,
    now: () => [$p('one', 'b1'), $p('two, theirs', 'b2'), $p('three', 'b3')],
    yours: () => [
      $p('one, mine', 'b1'),
      $p('two, mine', 'b2'),
      $p('three', 'b3'),
    ],
  };
  const FIX =
    /pass leftovers: \{wrap: wrapLeftoversAsQuote\('Offline edits that did not merge'\)\} to write the blocks that cannot be replayed into the document .*, or leftovers: \{handle: blocks => showInYourPanel\(blocks\)\} to take them yourself\. Nothing was read or written\.$/;
  const wrap = wrapLeftoversAsQuote(LABEL);
  const malformed: [string, unknown, RegExp][] = [
    [
      'undefined',
      undefined,
      /replayUnsyncedEdits needs leftovers \(got undefined\)/,
    ],
    ['null', null, /needs leftovers \(got null\)/],
    ['a function', wrap, /needs leftovers \(got function\)/],
    ['an empty object', {}, /leftovers needs wrap or handle/],
    ['both', {handle: () => {}, wrap}, /one of wrap and handle, not both/],
    [
      'a wrap that is no function',
      {wrap: 'quote'},
      /leftovers\.wrap is not a function \(got string\)/,
    ],
    [
      'a handle that is no function',
      {handle: true},
      /leftovers\.handle is not a function \(got boolean\)/,
    ],
    [
      'an unknown placement',
      {placement: 'bottom', wrap},
      /leftovers\.placement is 'after-block' \(the default\) or 'top'; got bottom/,
    ],
    [
      'a placement for a handler',
      {handle: () => {}, placement: 'top'},
      /leftovers\.placement is only for wrap/,
    ],
  ];

  test.each(malformed)(
    'replayUnsyncedEdits with %s throws before anything is written, and names the fix',
    (_name, leftovers, what) => {
      const s = scenario(docs);
      const before = s.tab.json();
      let updates = 0;
      s.tab.doc.on('update', () => updates++);
      const call = () =>
        replayUnsyncedEdits({
          autoReplay: 'replayable',
          binding: s.tab.binding,
          leftovers,
          report: s.report,
        } as never);
      expect(call).toThrow(TypeError);
      expect(call).toThrow(what);
      expect(call).toThrow(FIX);
      expect(s.tab.json()).toEqual(before);
      expect(updates).toBe(0);
      expect(s.tab.binding.history!.canUndo).toBe(false);
    },
  );

  test('replayUnsyncedEdits without the property throws the same', () => {
    const s = scenario(docs);
    const before = s.tab.json();
    expect(() =>
      replayUnsyncedEdits({
        autoReplay: 'replayable',
        binding: s.tab.binding,
        report: s.report,
      } as never),
    ).toThrow(FIX);
    expect(() => replayUnsyncedEdits(undefined as never)).toThrow(FIX);
    expect(s.tab.json()).toEqual(before);
  });

  test.each(['off', 'persist', 'replay'] as const)(
    "recoverYOfflineEdits at stage '%s' without leftovers throws before the store is read",
    async stage => {
      const fake = createFakeIndexedDB();
      const opened = await openYOfflineStore({
        idb: fake.idb,
        locks: fake.locks,
      });
      if (!opened.ok) {
        throw new Error(opened.error.message);
      }
      const reads: string[] = [];
      const store = new Proxy(opened.value, {
        get: (target, name, receiver) => {
          reads.push(String(name));
          return Reflect.get(target, name, receiver);
        },
      });
      const s = scenario(docs);
      const before = s.tab.json();
      await expect(
        recoverYOfflineEdits({
          autoReplay: 'replayable',
          binding: s.tab.binding,
          config: catalog.config,
          epoch: 'e2',
          key: 'doc',
          stage,
          store,
        } as never),
      ).rejects.toThrow(FIX);
      await expect(
        recoverYOfflineEdits({
          autoReplay: 'replayable',
          binding: s.tab.binding,
          config: catalog.config,
          epoch: 'e2',
          key: 'doc',
          leftovers: {wrap: 'quote'},
          stage,
          store,
        } as never),
      ).rejects.toThrow(
        /recoverYOfflineEdits's leftovers\.wrap is not a function/,
      );
      expect(reads).toEqual([]);
      expect(s.tab.json()).toEqual(before);
    },
  );
});

// Compile-time claims (checked by `pnpm run tsc`; nothing here runs).
export function typeTests(
  binding: YCollabBinding,
  report: YUnsyncedReport,
  store: YOfflineStore,
): void {
  const wrap = wrapLeftoversAsQuote(LABEL);
  const recover = {
    binding,
    config: catalog.config,
    epoch: 'e2',
    key: 'doc',
    stage: 'replay',
    store,
  } as const;

  // The two shapes.
  replayUnsyncedEdits({
    autoReplay: 'replayable',
    binding,
    leftovers: {wrap},
    report,
  });
  replayUnsyncedEdits({
    autoReplay: 'replayable',
    binding,
    leftovers: {placement: 'top', wrap},
    report,
  });
  replayUnsyncedEdits({
    autoReplay: 'replayable',
    binding,
    leftovers: {handle: blocks => blocks},
    report,
  });
  void recoverYOfflineEdits({
    autoReplay: 'replayable',
    ...recover,
    leftovers: {wrap},
  });
  void recoverYOfflineEdits({
    autoReplay: 'replayable',
    ...recover,
    leftovers: {handle: () => {}},
  });

  // Omitted: "Property 'leftovers' is missing ... but required in type
  // 'YLeftoversRequiredPassWrapOrHandle'".
  // @ts-expect-error leftovers is required
  replayUnsyncedEdits({autoReplay: 'replayable', binding, report});
  // @ts-expect-error leftovers is required
  void recoverYOfflineEdits(recover);
  // @ts-expect-error leftovers is required at every stage
  void recoverYOfflineEdits({
    autoReplay: 'replayable',
    ...recover,
    stage: 'off',
  });
  // @ts-expect-error leftovers is required at every stage
  void recoverYOfflineEdits({
    autoReplay: 'replayable',
    ...recover,
    stage: 'persist',
  });

  // The same checks through a parameter of the type (one line each, so
  // the directive sits on the line of the error).
  const replayWith = (leftovers: YLeftovers) =>
    replayUnsyncedEdits({autoReplay: 'replayable', binding, leftovers, report});
  const handle = () => {};
  replayWith({wrap});
  replayWith({handle});

  // No way to pass "nothing".
  // @ts-expect-error undefined is not a choice
  replayWith(undefined);
  // @ts-expect-error null is not a choice
  replayWith(null);
  // @ts-expect-error neither wrap nor handle
  replayWith({});
  // @ts-expect-error a placement alone writes nothing
  replayWith({placement: 'top'});
  // @ts-expect-error there is no report-only mode
  replayWith('report-only');
  // @ts-expect-error there is no report-only mode
  replayWith(false);
  replayUnsyncedEdits({
    autoReplay: 'replayable',
    binding,
    // @ts-expect-error undefined is not a choice, in the call itself
    leftovers: undefined,
    report,
  });
  void recoverYOfflineEdits({
    autoReplay: 'replayable',
    ...recover,
    // @ts-expect-error there is no report-only mode, in a recovery
    leftovers: false,
  });

  // Invalid shapes.
  // @ts-expect-error one of wrap and handle, not both
  replayWith({handle, wrap});
  // @ts-expect-error a handler writes nothing, so it has no placement
  replayWith({handle, placement: 'top'});
  // @ts-expect-error placement is 'after-block' or 'top'
  replayWith({placement: 'bottom', wrap});
  // @ts-expect-error wrap is a function made by wrapLeftoversAsQuote(label)
  replayWith({wrap: wrapLeftoversAsQuote});
  // @ts-expect-error wrap returns serialized blocks
  replayWith({wrap: () => 'text'});
  // @ts-expect-error the default wrapper needs its label
  wrapLeftoversAsQuote();

  // A wrapper is given blocks that have content.
  replayUnsyncedEdits({
    autoReplay: 'replayable',
    binding,
    leftovers: {
      wrap: blocks => blocks.map((block): SerializedLexicalNode => block.yours),
    },
    report,
  });
  // A handler is given every block, a deletion included.
  replayUnsyncedEdits({
    autoReplay: 'replayable',
    binding,
    leftovers: {
      handle: blocks => {
        // @ts-expect-error yours is null for a block the user deleted
        const yours: SerializedLexicalNode = blocks[0].yours;
        return yours;
      },
    },
    report,
  });
}
