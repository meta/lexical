/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {ListNode} from '@lexical/list';
import type {HeadingNode} from '@lexical/rich-text';

import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createHeadingNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  type ElementNode,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, type YDoc} from '../..';
import {migrateYState, type YLayoutMigration} from '../../migrate';
import step1to2 from '../../migrate/1to2';
import {readLayout12} from '../../migrate/1to2/frozen/read';
import {
  quarantineRecord as makeRecord,
  replayYRecovery,
  type YReplayResult,
} from '../../server';
import {
  $block,
  $createBoxNode,
  $selectIn,
  createBoundEditor,
  describeNode,
  NODES,
} from '../utils/harness';

// A peer-free replica whose every client id is its own: base
// values can be exact.
const quarantineRecord = (input: Parameters<typeof makeRecord>[0]) => {
  const parts = [
    ...(input.snapshot == null ? [] : [input.snapshot]),
    ...(input.deltas ?? []),
    ...(input.queue ?? []),
  ];
  const clients = new Set<number>();
  for (const u of parts) {
    for (const c of Y.decodeStateVector(
      Y.encodeStateVectorFromUpdate(u),
    ).keys()) {
      clients.add(c);
    }
  }
  return makeRecord({clients: [...clients], peers: false, ...input});
};

// The replay of a quarantine record onto the current document (design
// 4.6): an offline replica's own changes, by identity, after the room
// migrated in place; per-change decisions against the base and the
// current document; conflicts listed, never dropped; the ledger.

const INC = 'inc-1';
const G0 = `${INC}/-`;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

type Bound = {
  doc: YDoc;
  editor: LexicalEditor;
  stop: () => void;
  undo: () => void;
};

function bind(state: Uint8Array | null, id: number, gc: boolean): Bound {
  const doc = createYDoc(state, {gc});
  doc.clientID = id;
  const b = createBoundEditor(doc, {
    namespace: 'replay',
    nodes: NODES,
    onError: e => {
      throw e;
    },
    onWarn: () => {},
    selfCheck: true,
    withBlockIds: false,
  });
  const stop = b.start();
  b.binding.initialize();
  const undo = () => {
    b.binding.undoManager?.stopCapturing();
    b.binding.undo();
  };
  return {doc, editor: b.editor, stop, undo};
}

function show(editor: LexicalEditor): string {
  return editor
    .getEditorState()
    .read(() => $getRoot().getChildren().map(describeNode).join(' / '));
}

async function read(state: Uint8Array, gc: boolean): Promise<string> {
  const r = bind(state, 9, gc);
  await flush();
  const out = show(r.editor);
  r.stop();
  return out;
}

function edit(b: Bound, fn: () => void) {
  b.editor.update(fn, {discrete: true});
}

/** A test-only in-place step that rewrites every format item (plain runs). */
const rewrite1to2: YLayoutMigration = {
  checkAfter: () => [],
  from: 1,
  id: 'lexical-y/layout/1to2',
  migrateContainer(tr, container) {
    let written = 0;
    let deleted = 0;
    const live: Y.Item[] = [];
    const values = new Map<string, unknown>();
    const runs: {key: string; value: unknown; first: Y.Item; last: Y.Item}[] =
      [];
    const open = new Map<string, (typeof runs)[number]>();
    for (let it = container._start; it !== null; it = it.right) {
      if (it.deleted) {
        continue;
      }
      if (it.content instanceof Y.ContentFormat) {
        const {key, value} = it.content;
        if (value === null) {
          values.delete(key);
        } else {
          values.set(key, value);
        }
        live.push(it);
        continue;
      }
      if (!it.countable) {
        continue;
      }
      for (const [key, run] of open) {
        if (
          !values.has(key) ||
          JSON.stringify(values.get(key)) !== JSON.stringify(run.value)
        ) {
          open.delete(key);
        }
      }
      for (const [key, value] of values) {
        const run = open.get(key);
        if (run === undefined) {
          const next = {first: it, key, last: it, value};
          open.set(key, next);
          runs.push(next);
        } else {
          run.last = it;
        }
      }
    }
    for (const it of live) {
      it.delete(tr);
      deleted++;
    }
    const doc = tr.doc;
    const put = (
      left: Y.Item | null,
      right: Y.Item | null,
      key: string,
      value: unknown,
    ) => {
      const item = new Y.Item(
        Y.createID(doc.clientID, doc.store.getClock(doc.clientID)),
        left,
        left === null ? null : left.lastId,
        right,
        right === null ? null : right.id,
        container,
        null,
        new Y.ContentFormat(key, value as never),
      );
      item.integrate(tr, 0);
      written++;
    };
    for (const run of runs) {
      put(run.first.left, run.first, run.key, run.value);
    }
    for (const run of runs) {
      put(run.last, run.last.right, run.key, null);
    }
    return {deleted, written};
  },
  readAfter: readLayout12,
  readBefore: readLayout12,
  revision: 900,
  rewrites: () => true,
  to: 2,
};

type Scenario = {
  init: () => void;
  /** The offline replica's edits (on the old generation). */
  offline: (b: Bound) => void;
  /** Current-generation edits after the migration (racing writers). */
  theirs?: (c: Bound) => void;
};

async function runScenario(
  s: Scenario,
  gc: boolean,
  step: YLayoutMigration,
  opts: {ledger?: Map<string, string>; current?: Uint8Array} = {},
) {
  // The room at the source generation: A seeded it, B synced.
  const a = bind(null, 1000, gc);
  edit(a, () => {
    $getRoot().clear();
    s.init();
  });
  a.editor.update(() => {}, {discrete: true});
  await flush();
  const base = Y.encodeStateAsUpdate(a.doc);
  a.stop();
  const b = bind(base, 2000, gc);
  await flush();
  s.offline(b);
  await flush();
  const snapshot = Y.encodeStateAsUpdate(b.doc);
  b.stop();
  // The authority migrates in place; current writers may edit after.
  const migrated = migrateYState(base, [step], {gc, to: 2}).state;
  let current = opts.current ?? migrated;
  // The live-merge control: the same current edits on the old layout,
  // merged with the record as an unfenced room would.
  let live = Y.mergeUpdates([base, snapshot]);
  if (s.theirs !== undefined && opts.current === undefined) {
    const c = bind(migrated, 3000, gc);
    await flush();
    s.theirs(c);
    await flush();
    current = Y.encodeStateAsUpdate(c.doc);
    c.stop();
    const o = bind(base, 3000, gc);
    await flush();
    s.theirs(o);
    await flush();
    live = Y.mergeUpdates([Y.encodeStateAsUpdate(o.doc), snapshot]);
    o.stop();
  }
  const record = quarantineRecord({
    kind: 'handoff',
    receivedAt: 0,
    snapshot,
    source: {
      generation: G0,
      incarnation: INC,
      layouts: [1, 2],
      renderer: null,
      schemaVersion: 1,
    },
  });
  const result = replayYRecovery(record, base, current, {
    baseGeneration: G0,
    gc,
    generation: `${INC}/x`,
    inPlace: true,
    incarnation: INC,
    ledger: opts.ledger,
  });
  const out = {
    base,
    // The control: the record merged into the base on the old layout.
    control: await read(Y.mergeUpdates([base, snapshot]), gc),

    current,
    live: await read(live, gc),
    record,
    result,
    shown: await read(result.state, gc),
    snapshot,
  };
  if (process.env.REPLAY_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        conflicts: result.conflicts,
        control: out.control,
        current: await read(current, gc),
        live: out.live,
        shown: out.shown,
      }),
    );
  }
  return out;
}

function $text(i: number): TextNode {
  return (
    $getRoot().getChildAtIndex(i) as ElementNode
  ).getFirstChild() as TextNode;
}

function $type(path: number[], at: number, s: string) {
  $selectIn(path, at);
  const sel = $getSelection();
  if ($isRangeSelection(sel)) {
    sel.insertText(s);
  }
}

const $_P2 = () =>
  $getRoot().append(
    $createParagraphNode().append($createTextNode('alpha beta gamma')),
    $createParagraphNode().append($createTextNode('second line')),
  );

const statusOf = (r: YReplayResult, kind: string) =>
  r.receipt.changes.filter(c => c.kind === kind).map(c => c.status);

describe.each([false, true])('gc %s', gc => {
  describe.each([
    ['1to2', step1to2],
    ['rewrite', rewrite1to2],
  ] as const)('step %s', (_name, step) => {
    test('offline typing lands at its place, once', async () => {
      const r = await runScenario(
        {init: $_P2, offline: b => edit(b, () => $type([0], 5, 'XYZ'))},
        gc,
        step,
      );
      expect(r.result.eligible).toBe(true);
      expect(r.shown).toBe(r.control);
      expect(r.shown).toContain('alphaXYZ beta');
      expect(r.shown.split('XYZ').length).toBe(2);
      expect(r.result.conflicts).toEqual([]);
    });

    test('offline deletion applies; a deletion already made is unchanged', async () => {
      const r = await runScenario(
        {
          init: $_P2,
          offline: b => edit(b, () => $text(0).spliceText(5, 5, '')),
          theirs: c => edit(c, () => $text(1).spliceText(0, 7, '')),
        },
        gc,
        step,
      );
      expect(r.shown).toBe('paragraph("alpha gamma") / paragraph("line")');
      expect(statusOf(r.result, 'delete')).toContain('applied');
    });

    test('offline bold applies where the current document did not change it', async () => {
      const r = await runScenario(
        {
          init: $_P2,
          offline: b =>
            edit(b, () => {
              $selectIn([0], 11, 16);
              const sel = $getSelection();
              if ($isRangeSelection(sel)) {
                sel.formatText('bold');
              }
            }),
          theirs: c =>
            edit(c, () => {
              $selectIn([1], 0, 6);
              const sel = $getSelection();
              if ($isRangeSelection(sel)) {
                sel.formatText('italic');
              }
            }),
        },
        gc,
        step,
      );
      expect(r.shown).toBe(
        'paragraph("alpha beta " "gamma"{1}) / paragraph("second"{2} " line")',
      );
      expect(r.result.conflicts).toEqual([]);
    });

    test('formats of different keys both survive', async () => {
      const r = await runScenario(
        {
          init: () =>
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode('alpha beta gamma'),
              ),
            ),
          offline: b =>
            edit(b, () => {
              $selectIn([0], 6, 10);
              const sel = $getSelection();
              if ($isRangeSelection(sel)) {
                sel.formatText('bold');
              }
            }),
          theirs: c =>
            edit(c, () => {
              $selectIn([0], 6, 10);
              const sel = $getSelection();
              if ($isRangeSelection(sel)) {
                sel.formatText('code');
              }
            }),
        },
        gc,
        step,
      );
      expect(r.shown).toBe('paragraph("alpha " "beta"{17} " gamma")');
      expect(r.result.conflicts).toEqual([]);
    });

    test('a current writer that changed the same key wins where mine agreed or did not change it', async () => {
      const r = await runScenario(
        {
          init: () =>
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode('alpha beta gamma'),
              ),
            ),
          offline: b =>
            edit(b, () => {
              $selectIn([0], 6, 10);
              const sel = $getSelection();
              if ($isRangeSelection(sel)) {
                sel.formatText('bold');
              }
            }),
          theirs: c =>
            edit(c, () => {
              $selectIn([0], 0, 16);
              const sel = $getSelection();
              if ($isRangeSelection(sel)) {
                sel.formatText('bold');
              }
            }),
        },
        gc,
        step,
      );
      // An unfenced merge drops the current writer's bold after "beta"
      // (mine's closing item wins there); replay keeps it.
      expect(r.shown).toBe('paragraph("alpha beta gamma"{1})');
      expect(r.live).not.toBe(r.shown);
      expect(r.result.conflicts).toEqual([]);
    });

    test('the same key changed to another value since: a conflict, the current value kept', async () => {
      const r = await runScenario(
        {
          init: () =>
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode('alpha'),
                $createTextNode(' beta').setStyle('color: green'),
              ),
            ),
          offline: b =>
            edit(b, () =>
              ($text(0).getNextSibling() as TextNode).setStyle('color: blue'),
            ),
          theirs: c =>
            edit(c, () =>
              ($text(0).getNextSibling() as TextNode).setStyle('color: red'),
            ),
        },
        gc,
        step,
      );
      const json = r.shown;
      expect(json).toBe(await read(r.current, gc));
      expect(r.result.conflicts.length).toBeGreaterThan(0);
      expect(
        r.result.conflicts.every(
          c => c.kind === 'format' && c.reason === 'changed since',
        ),
      ).toBe(true);
      void json;
    });

    test('an insert into a line deleted since lands as a live merge places it', async () => {
      const r = await runScenario(
        {
          init: $_P2,
          offline: b => edit(b, () => $type([1], 6, 'QQ')),
          theirs: c => edit(c, () => $getRoot().getChildAtIndex(1)!.remove()),
        },
        gc,
        step,
      );
      expect(r.shown).toBe(r.live);
      expect(r.shown.split('QQ').length).toBe(2);
    });

    test('an insert into a container deleted since is a conflict, listed, not applied', async () => {
      const r = await runScenario(
        {
          init: () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('before')),
              $createBoxNode('t').append(
                $createParagraphNode().append($createTextNode('inside box')),
              ),
            ),
          offline: b =>
            edit(b, () => {
              const box = $getRoot().getChildAtIndex(1) as ElementNode;
              const t = (
                box.getFirstChild() as ElementNode
              ).getFirstChild() as TextNode;
              t.select(6, 6);
              const sel = $getSelection();
              if ($isRangeSelection(sel)) {
                sel.insertText('QQ');
              }
            }),
          theirs: c => edit(c, () => $getRoot().getChildAtIndex(1)!.remove()),
        },
        gc,
        step,
      );
      expect(r.shown).not.toContain('QQ');
      expect(r.shown).toBe('paragraph("before")');
      expect(r.result.conflicts.some(c => c.kind === 'insert')).toBe(true);
    });

    test('a block attribute: applied when current kept the base, a conflict when it changed', async () => {
      const $initBlocks = () =>
        $getRoot().append(
          $createHeadingNode('h1').append($createTextNode('title')),
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('item')),
          ),
        );
      const mine = (b: Bound) =>
        edit(b, () => {
          ($getRoot().getChildAtIndex(0) as HeadingNode).setTag('h2');
          ($getRoot().getChildAtIndex(1) as ListNode).setListType('number');
        });
      const kept = await runScenario(
        {init: $initBlocks, offline: mine},
        gc,
        step,
      );
      expect(kept.shown).toBe(kept.control);
      expect(kept.shown).toContain('heading[h2]');
      expect(kept.shown).toContain('list[number]');
      const raced = await runScenario(
        {
          init: $initBlocks,
          offline: mine,
          theirs: c =>
            edit(c, () =>
              ($getRoot().getChildAtIndex(0) as HeadingNode).setTag('h3'),
            ),
        },
        gc,
        step,
      );
      expect(raced.shown).toContain('heading[h3]');
      expect(raced.shown).toContain('list[number]');
      expect(raced.result.conflicts.length).toBeGreaterThan(0);
    });

    test('text typed then partly deleted offline, and text anchored to it', async () => {
      const r = await runScenario(
        {
          init: $_P2,
          offline: b => {
            edit(b, () => $type([0], 16, ' one two'));
            edit(b, () => $text(0).spliceText(16, 4, ''));
            edit(b, () => $type([0], 20, '!'));
          },
        },
        gc,
        step,
      );
      expect(r.shown).toBe(r.control);
      expect(r.shown).toContain('alpha beta gamma two!');
    });

    test('new blocks with formatted text', async () => {
      const r = await runScenario(
        {
          init: $_P2,
          offline: b =>
            edit(b, () => {
              const t = $createTextNode('fresh');
              t.toggleFormat('bold');
              $getRoot()
                .getChildAtIndex(0)!
                .insertAfter(
                  $createParagraphNode().append(t, $createTextNode(' tail')),
                );
            }),
        },
        gc,
        step,
      );
      expect(r.shown).toBe(r.control);
    });

    test('the ledger: a second replay writes nothing; the same inputs give the same update', async () => {
      const s: Scenario = {
        init: $_P2,
        offline: b => edit(b, () => $type([0], 0, 'Z')),
      };
      const first = await runScenario(s, gc, step);
      const again = await runScenario(s, gc, step);
      expect(again.result.update).toEqual(first.result.update);
      const ledger = new Map(
        first.result.receipt.ledger.map(([x, y]) => [x, y] as [string, string]),
      );
      const second = replayYRecovery(
        first.record,
        first.base,
        first.result.state,
        {
          baseGeneration: G0,
          gc,
          generation: `${INC}/x`,
          inPlace: true,
          incarnation: INC,
          ledger,
        },
      );
      expect(second.update).toBeNull();
      expect(await read(second.state, gc)).toBe(first.shown);
    });

    test('overlapping records (the same items, split differently): each unit once', async () => {
      // Record 1: the replica after typing "ab"; record 2: after "abc" (its
      // items merge into one struct): the ledger skips "ab" and applies "c".
      const a = bind(null, 1000, gc);
      edit(a, () => {
        $getRoot().clear();
        $_P2();
      });
      await flush();
      const base = Y.encodeStateAsUpdate(a.doc);
      a.stop();
      const b = bind(base, 2000, gc);
      await flush();
      edit(b, () => $type([0], 0, 'ab'));
      await flush();
      const snap1 = Y.encodeStateAsUpdate(b.doc);
      edit(b, () => $type([0], 2, 'c'));
      await flush();
      const snap2 = Y.encodeStateAsUpdate(b.doc);
      b.stop();
      const current = migrateYState(base, [step], {gc, to: 2}).state;
      const rec = (snapshot: Uint8Array) =>
        quarantineRecord({
          kind: 'handoff',
          receivedAt: 0,
          snapshot,
          source: {
            generation: G0,
            incarnation: INC,
            layouts: [1, 2],
            renderer: null,
            schemaVersion: 1,
          },
        });
      const cfg = {
        baseGeneration: G0,
        gc,
        generation: `${INC}/x`,
        inPlace: true,
        incarnation: INC,
      };
      const r1 = replayYRecovery(rec(snap1), base, current, cfg);
      const ledger = new Map(
        r1.receipt.ledger.map(([x, y]) => [x, y] as [string, string]),
      );
      const r2 = replayYRecovery(rec(snap2), base, r1.state, {...cfg, ledger});
      expect(await read(r2.state, gc)).toBe(
        'paragraph("abcalpha beta gamma") / paragraph("second line")',
      );
    });

    test.each([
      ['a container', 'box'],
      ['a line', 'line'],
      ['text', 'text'],
    ] as const)(
      '%s removed then restored by undo offline',
      async (_l, what) => {
        const r = await runScenario(
          {
            init: () =>
              $getRoot().append(
                $createParagraphNode().append($createTextNode('before')),
                $createBoxNode('t').append(
                  $createParagraphNode().append($createTextNode('inside box')),
                ),
                $createParagraphNode().append($createTextNode('after line')),
              ),
            offline: b => {
              b.undo();
              edit(b, () => {
                if (what === 'box') {
                  $getRoot().getChildAtIndex(1)!.remove();
                } else if (what === 'line') {
                  $getRoot().getChildAtIndex(2)!.remove();
                } else {
                  $text(2).spliceText(0, 6, '');
                }
              });
              b.undo();
            },
          },
          gc,
          step,
        );
        expect(r.shown).toBe(r.control);
        expect(r.shown).toContain('inside box');
        expect(r.shown).toContain('after line');
      },
    );

    test('eligibility: another incarnation or a fresh document goes to the recovery view', async () => {
      const r = await runScenario(
        {init: $_P2, offline: b => edit(b, () => $type([0], 0, 'Z'))},
        gc,
        step,
      );
      const other = replayYRecovery(r.record, r.base, r.current, {
        baseGeneration: G0,
        generation: 'inc-2/-',
        inPlace: true,
        incarnation: 'inc-2',
      });
      expect(other.eligible).toBe(false);
      const fresh = replayYRecovery(r.record, r.base, r.current, {
        baseGeneration: G0,
        generation: `${INC}/x`,
        inPlace: false,
        incarnation: INC,
      });
      expect(fresh.eligible).toBe(false);
    });

    test('a draft-only record is shown, never applied', async () => {
      const r = await runScenario({init: $_P2, offline: () => {}}, gc, step);
      const draftOnly = quarantineRecord({
        draft: {differs: true, json: {root: 'x'}},
        kind: 'handoff',
        receivedAt: 0,
        source: {
          generation: G0,
          incarnation: INC,
          layouts: [1, 2],
          renderer: null,
          schemaVersion: 1,
        },
      });
      const out = replayYRecovery(draftOnly, r.base, r.current, {
        baseGeneration: G0,
        generation: `${INC}/x`,
        inPlace: true,
        incarnation: INC,
      });
      expect(out.update).toBeNull();
      expect(out.receipt.changes.map(c => [c.kind, c.status])).toEqual([
        ['draft', 'shown'],
      ]);
    });

    test.each([
      ['no current writer', 'none'],
      ['a current writer on other lines', 'disjoint'],
      ['a current writer anywhere', 'overlap'],
    ] as const)(
      'random offline sessions: %s',
      async (_label, mode) => {
        const N = Number(process.env.REPLAY_SEEDS ?? 12);
        for (let seed = 1; seed <= N; seed++) {
          let x =
            (seed * 2654435761 +
              (mode === 'none' ? 0 : mode === 'disjoint' ? 7 : 13)) >>>
            0;
          const rand = () => {
            x = (Math.imul(x ^ (x >>> 15), 2246822519) + 0x6d2b79f5) >>> 0;
            return x / 4294967296;
          };
          let n = 0;
          const ops = (
            b: Bound,
            mark: string,
            lines: (i: number) => boolean,
            count: number,
            next: () => number,
          ) => {
            for (let i = 0; i < count; i++) {
              edit(b, () => {
                const blocks = (
                  $getRoot().getChildren() as ElementNode[]
                ).filter((_, k) => lines(k));
                const block = blocks[Math.floor(next() * blocks.length)];
                if (block === undefined) {
                  return;
                }
                const texts = block.getAllTextNodes().filter($isTextNode);
                const t = texts[Math.floor(next() * texts.length)];
                if (t === undefined) {
                  return;
                }
                const len = t.getTextContentSize();
                const op = next();
                if (op < 0.4) {
                  const at = Math.floor(next() * (len + 1));
                  t.select(at, at);
                  const sel = $getSelection();
                  if ($isRangeSelection(sel)) {
                    sel.insertText(`${mark}${n++}`);
                  }
                } else if (op < 0.6 && len > 2) {
                  t.spliceText(Math.floor(next() * (len - 2)), 2, '');
                } else if (op < 0.85 && len > 2) {
                  const a = Math.floor(next() * (len - 1));
                  t.select(a, Math.min(len, a + 1 + Math.floor(next() * 3)));
                  const sel = $getSelection();
                  if ($isRangeSelection(sel)) {
                    sel.formatText(next() < 0.5 ? 'bold' : 'italic');
                  }
                } else if (op < 0.95) {
                  block.insertAfter(
                    $createParagraphNode().append(
                      $createTextNode(`${mark}${n++}`),
                    ),
                  );
                } else if (mark === '@' && $getRoot().getChildrenSize() > 2) {
                  block.remove();
                }
              });
            }
          };
          const mineLines = (k: number) => mode !== 'disjoint' || k < 2;
          const theirLines = (k: number) => mode === 'overlap' || k >= 2;
          const r = await runScenario(
            {
              init: () => {
                $_P2();
                const t = $createTextNode('bold run');
                t.toggleFormat('bold');
                $getRoot().append(
                  $createParagraphNode().append(t, $createTextNode(' plain')),
                );
                $getRoot().append(
                  $createParagraphNode().append($createTextNode('fourth line')),
                );
              },
              offline: b => ops(b, '#', mineLines, 8, rand),
              theirs:
                mode === 'none'
                  ? undefined
                  : c => {
                      // Called twice (current and the live-merge control): the
                      // same ops each time.
                      let y = (seed * 40503 + 99) >>> 0;
                      n = 1000;
                      ops(c, '@', theirLines, 6, () => {
                        y =
                          (Math.imul(y ^ (y >>> 15), 2246822519) +
                            0x6d2b79f5) >>>
                          0;
                        return y / 4294967296;
                      });
                    },
            },
            gc,
            step,
          );
          const tokens = (text: string, mark: string): string[] =>
            text.match(new RegExp(`\\${mark}\\d+`, 'g')) ?? [];
          const shownMine = tokens(r.shown, '#');
          // Every replayed token is present once.
          expect([seed, new Set(shownMine).size]).toEqual([
            seed,
            shownMine.length,
          ]);
          // Nothing of the current writer is lost.
          const cur = await read(r.current, gc);
          for (const tok of tokens(cur, '@')) {
            expect([seed, r.shown.includes(tok)]).toEqual([seed, true]);
          }
          // Mine's tokens: present, or a conflict is listed.
          const missing = tokens(r.control, '#').filter(
            tok => !shownMine.includes(tok),
          );
          if (missing.length > 0) {
            expect([seed, r.result.conflicts.length > 0]).toEqual([seed, true]);
          }
          if (mode !== 'overlap') {
            expect([seed, r.shown]).toEqual([
              seed,
              mode === 'none' ? r.control : r.live,
            ]);
            expect(r.result.conflicts).toEqual([]);
          }
        }
      },
      300_000,
    );
  });
});

void $block;
