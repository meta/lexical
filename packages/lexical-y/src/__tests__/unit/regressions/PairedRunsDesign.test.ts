/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// Paired format runs (layout 3): the outcomes the design states for the
// cases its reviews raised, each gc off and on and in both client id orders
// where ids decide placement. A cell whose outcome is a declared trade says
// so and asserts the trade, so any change to it is seen.

import {$patchStyleText} from '@lexical/selection';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $createBoxNode,
  $locateIn,
  $selectIn,
  expectConverged,
  flush,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';

const LAYOUT_3 = 'lexical-y:3';

const $line = (...nodes: ReturnType<typeof $createTextNode>[]) =>
  $getRoot().append($createParagraphNode().append(...nodes));

/** The root of a peer's document (the binding's default root). */
const rootOf = (peer: Peer) => peer.doc.get('lexical-y');

/** Record layout 3 in `peer`'s document (as a client's first paired write does). */
function upgrade(peer: Peer): void {
  peer.doc.transact(() => rootOf(peer).setAttr(LAYOUT_3, true));
}

function bold(peer: Peer, path: number[], start: number, end: number, on = 1) {
  peer.update(() => {
    $selectIn(path, start, end).formatText('bold', on);
    $setSelection(null);
  });
}

for (const gc of [false, true]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    describe(`gc ${gc ? 'on' : 'off'}, client ids ${ids}`, () => {
      test('a legacy run whose opener lies inside a later removal: the removal keeps the opener (its effect reaches past the range) and splits around it, and the legacy author\'s undo removes exactly its own run (main keeps "c" bold through its restore)', async () => {
        const t = await setup(() => $line($createTextNode('abcd')), {gc, ids});
        // A, before the document records layout 3, bolds "bc".
        bold(t.a, [0], 1, 3);
        await t.sync();
        await expectConverged(t.peers, 'paragraph("a" "bc"{1} "d")');
        // B removes bold from "ab": A's opener is inside B's range.
        bold(t.b, [0], 0, 2, 0);
        await t.sync();
        await expectConverged(t.peers, 'paragraph("ab" "c"{1} "d")');

        t.a.undo();
        await t.sync();
        await expectConverged(t.peers, 'paragraph("abcd")');
      });

      test('a retained run inside a removal is restated over: nothing stays bold', async () => {
        const t = await setup(() => $line($createTextNode('abc')), {gc, ids});
        bold(t.b, [0], 1, 2);
        await t.sync();
        bold(t.a, [0], 0, 3);
        bold(t.a, [0], 0, 3, 0);
        await t.sync();
        await expectConverged(t.peers, 'paragraph("abc")');
      });

      test('an empty paired run strictly inside a range is deleted, opener and first end', async () => {
        const t = await setup(() => $line($createTextNode('abcd')), {gc, ids});
        bold(t.b, [0], 2, 3);
        await t.sync();
        t.a.update(() => {
          $selectIn([0], 2, 3).removeText();
          $setSelection(null);
        });
        await t.sync();
        const live = (peer: Peer) => {
          const out: string[] = [];
          for (let it = rootOf(peer)._start; it; it = it.right) {
            if (!it.deleted && it.content instanceof Y.ContentFormat) {
              out.push(`${it.id.client}:${it.id.clock}`);
            }
          }
          return out;
        };
        const before = live(t.a);
        expect(before.length).toBeGreaterThanOrEqual(2);
        bold(t.a, [0], 0, 3);
        await t.sync();
        for (const id of before) {
          expect(live(t.a)).not.toContain(id);
        }
        await expectConverged(t.peers, 'paragraph("abd"{1})');
        // One segment: an opener and its end.
        expect(live(t.a).length).toBe(2);
      });

      test("a tab written next to another client's tab owns its type: that client's undo leaves it a tab", async () => {
        const t = await setup(() => $line($createTextNode('ab')), {gc, ids});
        t.a.update(() => {
          $selectIn([0], 1, 1).insertNodes([$createTabNode()]);
          $setSelection(null);
        });
        await t.sync();
        t.b.update(() => {
          $selectIn([0], 2, 2).insertNodes([$createTabNode()]);
          $setSelection(null);
        });
        await t.sync();
        t.a.undo();
        await t.sync();
        const types = t.b.read(() =>
          $getRoot()
            .getAllTextNodes()
            .filter($isTextNode)
            .map(n => `${n.getType()}:${JSON.stringify(n.getTextContent())}`),
        );
        expect(types).toContain('tab:"\\t"');
        await expectConverged(t.peers);
      });

      test('declared trade: a concurrent insert at the edge of a run a writer deletes, then that writer undoes', async () => {
        const t = await setup(
          () =>
            $line($createTextNode('ab').setFormat(1), $createTextNode('tail')),
          {gc, ids},
        );
        // A types plain "1" between "a" and "b": A's own [] run.
        t.a.update(() => {
          const s = $selectIn([0], 1, 1);
          s.format = 0;
          s.insertText('1');
          $setSelection(null);
        });
        await t.sync();
        await expectConverged(t.peers, 'paragraph("a"{1} "1" "b"{1} "tail")');
        t.offline();
        bold(t.b, [0], 1, 2);
        t.a.update(() => {
          const s = $selectIn([0], 2, 2);
          s.format = 0;
          s.insertText('3');
          $setSelection(null);
        });
        t.b.undo();
        await t.sync();
        // Converged either way; whether "3" is bold depends on where Yjs
        // places B's restored end against A's "3" (client ids).
        await expectConverged(t.peers);
        const fresh = await freshReader(t.a);
        expect(fresh.describe()).toBe(t.a.describe());
      });

      test("unsupported: an app UndoManager that keeps a run's end and removes its opener reads with today's per-item meaning", async () => {
        const t = await setup(() => $line($createTextNode('abcdtail')), {
          gc,
          ids,
        });
        const app = new Y.UndoManager(t.a.doc, {
          captureTimeout: 0,
          deleteFilter: item =>
            !(
              item.content instanceof Y.ContentFormat &&
              Array.isArray(item.content.value) &&
              item.content.value.length > 0
            ),
          trackedOrigins: new Set([t.a.binding]),
        });
        try {
          bold(t.a, [0], 0, 2);
          await t.sync();
          await expectConverged(t.peers, 'paragraph("ab"{1} "cdtail")');
          app.undo();
          await t.sync();
          await expectConverged(t.peers, 'paragraph("abcdtail")');
          app.redo();
          await t.sync();
          await expectConverged(t.peers, 'paragraph("ab"{1} "cdtail")');
        } finally {
          app.destroy();
        }
      });

      test("a write inside an app's transaction: undoing that transaction cannot remove the layout record", async () => {
        const t = await setup(() => $line($createTextNode('abcd')), {gc, ids});
        const appOrigin = {app: true};
        const app = new Y.UndoManager(t.a.doc, {
          captureTimeout: 0,
          trackedOrigins: new Set<unknown>([appOrigin]),
        });
        try {
          t.a.doc.transact(() => bold(t.a, [0], 0, 2), appOrigin);
          await t.sync();
          expect(rootOf(t.b).getAttr(LAYOUT_3)).toBe(true);
          app.undo();
          await t.sync();
          for (const peer of t.peers) {
            expect(rootOf(peer).getAttr(LAYOUT_3)).toBe(true);
          }
          await expectConverged(t.peers);
        } finally {
          app.destroy();
        }
      });
    });
  }
}

/**
 * A raw writer links a format item right before the first live text `text`
 * in `peer`'s root (splitting the text item there).
 */
function rawItem(
  peer: Peer,
  text: string,
  key: string,
  value: unknown,
): Y.Item {
  const doc = peer.doc;
  let item: Y.Item | null = null;
  doc.transact(tr => {
    let right: Y.Item | null = null;
    for (let it = rootOf(peer)._start; it; it = it.right) {
      if (!it.deleted && it.content instanceof Y.ContentString) {
        const at = it.content.str.indexOf(text);
        if (at >= 0) {
          right =
            at === 0
              ? it
              : Y.getItemCleanStart(
                  tr,
                  Y.createID(it.id.client, it.id.clock + at),
                );
          break;
        }
      }
    }
    if (right === null) {
      throw new Error(`no text ${text}`);
    }
    const left: Y.Item | null = right.left;
    item = new Y.Item(
      Y.createID(doc.clientID, doc.store.getClock(doc.clientID)),
      left,
      left && left.lastId,
      right,
      right.id,
      rootOf(peer),
      null,
      new Y.ContentFormat(key, value as object),
    );
    item.integrate(tr, 0);
  }, 'raw');
  return item!;
}

for (const gc of [false, true]) {
  test(`an end that arrives after its opener re-reads from the opener's line (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(
      () => {
        $line($createTextNode('one two'));
        $line($createTextNode('mid'));
        $line($createTextNode('three four'));
        $line($createTextNode('five'));
      },
      {gc, ids: [1, 2, 3]},
    );
    upgrade(t.a);
    await t.sync();
    // A raw writer's unpaired bold over the first three lines, then a []
    // opener before "two" whose end comes in a later transaction, in line 3
    // (the binding never writes a run across lines; a raw writer can).
    t.a.doc.transact(() => rootOf(t.a).format(0, 22, {'f:bold': true}), 'raw');
    await t.sync();
    const opener = rawItem(t.b, 'two', 'f:bold', []);
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("one "{1} "two") / paragraph("mid") / paragraph("three four") / paragraph("five")',
    );
    rawItem(t.b, ' four', 'f:bold', [
      t.b.doc.store.getClock(t.b.doc.clientID) - opener.id.clock,
    ]);
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("one "{1} "two") / paragraph("mid") / paragraph("three" " four"{1}) / paragraph("five")',
    );
  });
}

for (const gc of [false, true]) {
  test(`the record's window: a peer that gets the app undo and the new record one at a time shows its own document at each step (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(
      () => $line($createTextNode('abcd'), $createTextNode('efgh')),
      {gc},
    );
    const appOrigin = {app: true};
    const app = new Y.UndoManager(t.a.doc, {
      captureTimeout: 0,
      trackedOrigins: new Set<unknown>([appOrigin]),
    });
    try {
      // A's first paired write, inside an app transaction: its record joins
      // it, so the app's undo deletes the record and A records it again.
      t.a.doc.transact(() => bold(t.a, [0], 0, 2), appOrigin);
      await t.sync();
      await expectConverged(t.peers, 'paragraph("ab"{1} "cdefgh")');
      t.b.online = false;
      app.undo();
      const updates = t.b.pending.get(t.a) ?? [];
      t.b.pending.delete(t.a);
      expect(updates.length).toBeGreaterThanOrEqual(1);
      for (const update of updates) {
        Y.applyUpdate(t.b.doc, update, t.b.net);
        await new Promise(r => setTimeout(r, 0));
        const fresh = await freshReader(t.b);
        expect(t.b.describe()).toBe(fresh.describe());
        expect(t.b.binding.status).toBe('active');
        // The second record (written after the outer transaction) is live:
        // the undo deleted only the first.
        expect(rootOf(t.b).getAttr(LAYOUT_3)).toBe(true);
      }
      t.b.online = true;
      await t.sync();
      for (const peer of t.peers) {
        expect(rootOf(peer).getAttr(LAYOUT_3)).toBe(true);
      }
      await expectConverged(t.peers, 'paragraph("abcdefgh")');
    } finally {
      app.destroy();
    }
  });
}

for (const gc of [false, true]) {
  test(`an app UndoManager that undoes a client's first paired write leaves the record live at every step (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(() => $line($createTextNode('abcd')), {gc});
    const app = new Y.UndoManager(t.a.doc, {
      captureTimeout: 0,
      trackedOrigins: new Set<unknown>([t.a.binding, Object, null]),
    });
    try {
      bold(t.a, [0], 0, 2);
      await t.sync();
      t.b.online = false;
      app.undo();
      expect(rootOf(t.a).getAttr(LAYOUT_3)).toBe(true);
      const updates = t.b.pending.get(t.a) ?? [];
      t.b.pending.delete(t.a);
      for (const update of updates) {
        Y.applyUpdate(t.b.doc, update, t.b.net);
        await new Promise(r => setTimeout(r, 0));
        expect(rootOf(t.b).getAttr(LAYOUT_3)).toBe(true);
        expect(t.b.describe()).toBe((await freshReader(t.b)).describe());
      }
      t.b.online = true;
      await t.sync();
      await expectConverged(t.peers, 'paragraph("abcd")');
    } finally {
      app.destroy();
    }
  });
}

/** The live format items of `peer`'s root sequence. */
function liveFormats(peer: Peer): number {
  let n = 0;
  for (let it = rootOf(peer)._start; it; it = it.right) {
    if (!it.deleted && it.content instanceof Y.ContentFormat) {
      n++;
    }
  }
  return n;
}

for (const gc of [false, true]) {
  test(`shrinking prefixes by two writers grow the runs linearly, not geometrically (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(
      () =>
        $line(
          $createTextNode('ab'),
          $createTextNode('cdefghijklmnopqrstuvwxyz0123456789ABCD').setFormat(
            1,
          ),
        ),
      {gc},
    );
    const counts: number[] = [];
    let on = true;
    for (let end = 39; end >= 30; end--) {
      const writer = end % 2 === 0 ? t.a : t.b;
      bold(writer, [0], 0, end, on ? 1 : 0);
      on = !on;
      await t.sync();
      counts.push(liveFormats(t.a));
    }
    await expectConverged(t.peers);
    // Linear: at most a base overlay and a few items per change.
    expect(counts[counts.length - 1]).toBeLessThanOrEqual(
      4 * counts.length + 8,
    );
  });

  test(`declared trade: text a collaborator types exactly at a boundary the overlay splits around takes its value from the boundary's side (gc ${gc ? 'on' : 'off'})`, async () => {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      const t = await setup(() => $line($createTextNode('abcTAIL')), {
        gc,
        ids,
      });
      bold(t.a, [0], 1, 3); // a legacy run over "bc"
      await t.sync();
      t.offline();
      bold(t.b, [0], 0, 2, 0);
      t.a.update(() => {
        const s = $selectIn([0], 1, 1);
        s.format = 1;
        s.insertText('X');
        $setSelection(null);
      });
      await t.sync();
      await expectConverged(t.peers);
      const text = t.a.describe();
      expect(text).toContain('"TAIL"');
      expect(text).toMatch(/"c"\{1\}/);
    }
  });

  test(`a nested first write, a later write, then the app undoes the nested one: every update keeps layout 3 (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(
      () => $line($createTextNode('abcd'), $createTextNode('efgh')),
      {gc},
    );
    const appOrigin = {app: true};
    const app = new Y.UndoManager(t.a.doc, {
      captureTimeout: 0,
      trackedOrigins: new Set<unknown>([appOrigin]),
    });
    try {
      t.a.doc.transact(() => bold(t.a, [0], 0, 2), appOrigin);
      bold(t.a, [0], 4, 6);
      await t.sync();
      t.b.online = false;
      app.undo();
      const updates = t.b.pending.get(t.a) ?? [];
      t.b.pending.delete(t.a);
      for (const update of updates) {
        Y.applyUpdate(t.b.doc, update, t.b.net);
        await new Promise(r => setTimeout(r, 0));
        expect(rootOf(t.b).getAttr(LAYOUT_3)).toBe(true);
        expect(t.b.describe()).toBe((await freshReader(t.b)).describe());
      }
      t.b.online = true;
      await t.sync();
      await expectConverged(t.peers);
    } finally {
      app.destroy();
    }
  });

  test(`content the write does not see yet is not taken by its overlay (gc ${gc ? 'on' : 'off'})`, async () => {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      const t = await setup(() => $line($createTextNode('abc')), {gc, ids});
      // A's format change is queued (not discrete); B's plain "X" after "a"
      // reaches A's document before A's write commits.
      t.a.editor.update(() => {
        $selectIn([0], 0, 3).formatText('bold');
        $setSelection(null);
      });
      t.b.update(() => {
        const s = $selectIn([0], 1, 1);
        s.insertText('X');
        $setSelection(null);
      });
      await t.sync();
      await expectConverged(t.peers, 'paragraph("a"{1} "X" "bc"{1})');
    }
  });
}

for (const gc of [false, true]) {
  test(`an undo and a write in one app transaction: the write sees the undo's end copies repaired (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(
      () => {
        $getRoot().append(
          $createBoxNode().append(
            $createParagraphNode().append($createTextNode('abcd').setFormat(1)),
          ),
          $createParagraphNode().append($createTextNode('tail')),
        );
      },
      {gc},
    );
    // Plain "1234" typed inside the legacy bold run: A's own [] run.
    t.a.update(() => {
      const s = $selectIn([0, 0], 1, 1);
      s.format = 0;
      s.insertText('1234');
      $setSelection(null);
    });
    t.a.update(() => {
      $selectIn([0, 0], 2, 4).removeText();
      $setSelection(null);
    });
    await t.sync();
    await expectConverged(
      t.peers,
      'test_box(paragraph("a"{1} "14" "bcd"{1})) / paragraph("tail")',
    );
    t.a.update(() => {
      $getRoot().getFirstChild()!.remove();
    });
    await t.sync();
    // The undo of the removal (it restores the box and copies of its
    // items, ends included) and a write, in one app transaction.
    t.a.doc.transact(
      () => {
        t.a.undo();
        // The editor does not show the undo yet: "tail" is its only line.
        t.a.update(() => {
          const s = $selectIn([0], 4, 4);
          s.format = 0;
          s.insertText('!');
          $setSelection(null);
        });
      },
      {app: true},
    );
    await t.sync();
    await expectConverged(
      t.peers,
      'test_box(paragraph("a"{1} "14" "bcd"{1})) / paragraph("tail!")',
    );
  });
}

for (const gc of [false, true]) {
  test(`a run with two ends: a change deletes its opener and its first end, and the later end keeps clearing what it cleared (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(() => $line($createTextNode('ab')), {gc});
    upgrade(t.a);
    await t.sync();
    // P "a" end1(P) U end2(P) "b", written by a raw writer: end2 names P
    // after P's run closed, so it clears the unpaired U ("b" plain).
    const p = rawItem(t.a, 'a', 'f:bold', true);
    const rel = () => [t.a.doc.store.getClock(t.a.doc.clientID) - p.id.clock];
    rawItem(t.a, 'b', 'f:bold', rel());
    rawItem(t.a, 'b', 'f:bold', true);
    rawItem(t.a, 'b', 'f:bold', rel());
    await t.sync();
    await expectConverged(t.peers, 'paragraph("a"{1} "b")');
    bold(t.b, [0], 0, 1, 0);
    await t.sync();
    await expectConverged(t.peers, 'paragraph("ab")');
  });

  test(`two undos in one app transaction, a write after each: the write sees every batch of end copies repaired (gc ${gc ? 'on' : 'off'})`, async () => {
    const $box = (text: string) =>
      $createBoxNode().append(
        $createParagraphNode().append($createTextNode(text).setFormat(1)),
      );
    const t = await setup(
      () => {
        $getRoot().append(
          $box('abcd'),
          $box('efgh'),
          $createParagraphNode().append($createTextNode('tail')),
        );
      },
      {gc},
    );
    for (const at of [0, 1]) {
      t.a.update(() => {
        const s = $selectIn([at, 0], 1, 1);
        s.format = 0;
        s.insertText('1234');
        $setSelection(null);
      });
      t.a.update(() => {
        $selectIn([at, 0], 2, 4).removeText();
        $setSelection(null);
      });
    }
    t.a.update(() => {
      $getRoot().getChildAtIndex(1)!.remove();
    });
    t.a.update(() => {
      $getRoot().getFirstChild()!.remove();
    });
    await t.sync();
    t.a.doc.transact(
      () => {
        t.a.undo();
        t.a.update(() => {
          const s = $selectIn([0], 4, 4);
          s.format = 0;
          s.insertText('Y');
          $setSelection(null);
        });
        t.a.undo();
        t.a.update(() => {
          const s = $selectIn([0], 5, 5);
          s.format = 0;
          s.insertText('Z');
          $setSelection(null);
        });
      },
      {app: true},
    );
    await t.sync();
    // As on main (the second write lands where the editor, which has not
    // read the undos yet, put its caret).
    await expectConverged(
      t.peers,
      'test_box(paragraph("a"{1} "14" "bcd"{1})) / test_box(paragraph("e"{1} "14" "fgh"{1})) / paragraph("tailY") / paragraph("Z")',
    );
  });
}

/** The live format items of `peer`'s root whose key starts with `prefix`. */
function liveOf(peer: Peer, prefix: string): number {
  let n = 0;
  for (let it = rootOf(peer)._start; it; it = it.right) {
    if (
      !it.deleted &&
      it.content instanceof Y.ContentFormat &&
      it.content.key.startsWith(prefix)
    ) {
      n++;
    }
  }
  return n;
}

function color(peer: Peer, start: number, end: number, value: string) {
  peer.update(() => {
    $patchStyleText($selectIn([0], start, end), {color: value});
    $setSelection(null);
  });
}

/** The style of each text node of line 0, by text. */
function styles(peer: Peer): string[] {
  return peer.read(() =>
    $block([0])
      .getChildren()
      .filter($isTextNode)
      .map(n => `${n.getTextContent()}|${n.getStyle()}`),
  );
}

for (const gc of [false, true]) {
  const g = `gc ${gc ? 'on' : 'off'}`;

  test(`growth3: recolors around a deleted colored spot keep one color run (${g})`, async () => {
    for (const control of [false, true]) {
      const t = await setup(() => $line($createTextNode('abcdefghijklmnop')), {
        gc,
      });
      if (control) {
        bold(t.a, [0], 4, 6);
      } else {
        color(t.a, 4, 6, 'red');
      }
      t.a.update(() => {
        $selectIn([0], 4, 6).removeText();
        $setSelection(null);
      });
      await t.sync();
      const colors = ['blue', 'green', 'red'];
      for (let i = 0; i < 3; i++) {
        color(t.a, 2, 6, colors[i]);
        await t.sync();
      }
      await expectConverged(t.peers);
      expect(liveOf(t.a, 'p:')).toBe(2);
    }
  });

  test(`deleted text between boundaries an undo restores after a later format takes that format (${g})`, async () => {
    const t = await setup(() => $line($createTextNode('Xaab')), {gc});
    // A legacy history leaving X, null, [space], true, null, b.
    bold(t.a, [0], 1, 3);
    t.a.update(() => {
      const s = $selectIn([0], 2, 2);
      s.format = 0;
      s.insertText(' ');
      $setSelection(null);
    });
    bold(t.a, [0], 1, 4, 0);
    bold(t.a, [0], 4, 5, 0);
    t.a.update(() => {
      $selectIn([0], 3, 4).removeText();
      $selectIn([0], 1, 2).removeText();
      $setSelection(null);
    });
    t.a.update(() => {
      $selectIn([0], 1, 2).removeText();
      $setSelection(null);
    });
    await t.sync();
    await expectConverged(t.peers, 'paragraph("Xb")');
    bold(t.b, [0], 0, 2);
    await t.sync();
    await expectConverged(t.peers, 'paragraph("Xb"{1})');
    t.a.undo();
    await t.sync();
    await expectConverged(t.peers, 'paragraph("X b"{1})');
    // and after a relay's compaction and a fresh load
    const relay = new Y.Doc({gc: true});
    Y.applyUpdate(relay, Y.encodeStateAsUpdate(t.a.doc));
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(relay));
    expect(fresh.get('lexical-y').toString()).toBe(rootOf(t.a).toString());
  });

  test(`an empty run whose interval holds an unpaired item stays: "c" keeps its bold (${g})`, async () => {
    const t = await setup(() => $line($createTextNode('alrbcd')), {gc});
    upgrade(t.a);
    await t.sync();
    // U a R l V r end(R) b c null d; then l and r deleted.
    rawItem(t.a, 'alr', 'f:bold', true);
    const r = rawItem(t.a, 'lrb', 'f:bold', []);
    rawItem(t.a, 'rbc', 'f:bold', null);
    rawItem(t.a, 'bcd', 'f:bold', [
      t.a.doc.store.getClock(t.a.doc.clientID) - r.id.clock,
    ]);
    rawItem(t.a, 'd', 'f:bold', null);
    await t.sync();
    await expectConverged(t.peers, 'paragraph("a"{1} "lr" "bc"{1} "d")');
    t.a.update(() => {
      $selectIn([0], 2, 3).removeText();
      $selectIn([0], 1, 2).removeText();
      $setSelection(null);
    });
    await t.sync();
    await expectConverged(t.peers, 'paragraph("abc"{1} "d")');
    bold(t.b, [0], 0, 2, 0);
    await t.sync();
    await expectConverged(t.peers, 'paragraph("ab" "c"{1} "d")');
  });

  test(`an empty run inside a range: its text an undo restores shows the change's value (${g})`, async () => {
    const t = await setup(() => $line($createTextNode('abcdef')), {gc});
    color(t.a, 2, 4, 'red');
    t.a.update(() => {
      $selectIn([0], 2, 4).removeText();
      $setSelection(null);
    });
    await t.sync();
    color(t.b, 0, 4, 'blue');
    await t.sync();
    t.a.undo();
    await t.sync();
    await expectConverged(t.peers);
    expect(styles(t.a)).toEqual(['abcdef|color: blue;']);
  });

  test(`empty runs at both edges of a range stay (${g})`, async () => {
    const t = await setup(() => $line($createTextNode('xabcdey')), {gc});
    color(t.a, 1, 3, 'red');
    color(t.a, 5, 6, 'red');
    t.a.update(() => {
      $selectIn([0], 5, 6).removeText();
      $selectIn([0], 1, 3).removeText();
      $setSelection(null);
    });
    await t.sync();
    color(t.b, 1, 3, 'blue');
    await t.sync();
    t.a.undo();
    await t.sync();
    await expectConverged(t.peers);
    expect(styles(t.a)).toEqual([
      'x|',
      'ab|color: red;',
      'cd|color: blue;',
      'e|color: red;',
      'y|',
    ]);
  });

  test(`a hot spot with many empty runs: one segment, not one per run (${g})`, async () => {
    const t = await setup(() => $line($createTextNode('abcd')), {gc});
    for (let i = 0; i < 8; i++) {
      t.a.update(() => {
        const s = $selectIn([0], 2, 2);
        s.insertText('x');
        $setSelection(null);
      });
      color(t.a, 2, 3, i % 2 === 0 ? 'red' : 'green');
      t.a.update(() => {
        $selectIn([0], 2, 3).removeText();
        $setSelection(null);
      });
    }
    await t.sync();
    color(t.b, 0, 4, 'blue');
    await t.sync();
    await expectConverged(t.peers);
    expect(liveOf(t.a, 'p:')).toBe(2);
    expect(styles(t.a)).toEqual(['abcd|color: blue;']);
  });
}

for (const gc of [false, true]) {
  const g = `gc ${gc ? 'on' : 'off'}`;

  test(`v4: a deleted unpaired value buried below a retained paired run that ends past the range is restored after that run (${g})`, async () => {
    const t = await setup(() => $line($createTextNode('abcde')), {gc});
    upgrade(t.a);
    await t.sync();
    // a U P b c d end(P) e: U (true) unpaired, P ([]) paired over "bcd".
    rawItem(t.a, 'bcde', 'f:bold', true);
    const p = rawItem(t.a, 'bcde', 'f:bold', []);
    rawItem(t.a, 'e', 'f:bold', [
      t.a.doc.store.getClock(t.a.doc.clientID) - p.id.clock,
    ]);
    await t.sync();
    await expectConverged(t.peers, 'paragraph("abcd" "e"{1})');
    // Bold "ab": U (inside the range) is deleted; "e" keeps U's value.
    bold(t.b, [0], 0, 2);
    await t.sync();
    await expectConverged(t.peers, 'paragraph("ab"{1} "cd" "e"{1})');
  });

  test(`v4: a deleted invalid end that cleared an outside unpaired value: the clearing is restored after the range (${g})`, async () => {
    const t = await setup(() => $line($createTextNode('abc')), {gc});
    upgrade(t.a);
    await t.sync();
    // U a X b c: U (true) unpaired before the range; X an invalid end.
    rawItem(t.a, 'abc', 'f:bold', true);
    rawItem(t.a, 'bc', 'f:bold', [1, 999999]);
    await t.sync();
    await expectConverged(t.peers, 'paragraph("a"{1} "bc")');
    bold(t.b, [0], 0, 2);
    await t.sync();
    await expectConverged(t.peers, 'paragraph("ab"{1} "c")');
  });
}

for (const gc of [false, true]) {
  test(`legacy: a legacy opener between the previous content and the range's first content reaches past the range, so it stays; a concurrent bold insert at it races the overlay's opener by client id (a declared trade; main: "aXb" in every order) (gc ${gc ? 'on' : 'off'})`, async () => {
    for (const [ids, want] of [
      [[1, 2, 3], 'paragraph("aXb" "c"{1} "TAIL")'],
      [[3, 2, 1], 'paragraph("a" "X"{1} "b" "c"{1} "TAIL")'],
      [[2, 3, 1], 'paragraph("a" "X"{1} "b" "c"{1} "TAIL")'],
    ] as [number[], string][]) {
      const t = await setup(() => $line($createTextNode('abcTAIL')), {
        gc,
        ids,
      });
      const [l, w, c] = t.peers;
      bold(l, [0], 1, 3);
      await t.sync();
      await expectConverged(t.peers, 'paragraph("a" "bc"{1} "TAIL")');
      t.offline();
      // W removes bold from "ab" (Lexical reports only "b" changed).
      bold(w, [0], 0, 2, 0);
      c.update(() => {
        const s = $selectIn([0], 1, 1);
        s.format = 1;
        s.insertText('X');
        $setSelection(null);
      });
      await t.sync();
      await expectConverged(t.peers, want);
    }
  });
}

for (const gc of [false, true]) {
  test(`a legacy value buried below a retained paired run stays (it reaches past the range) and shows after the run; its author's undo removes exactly its own value (gc ${gc ? 'on' : 'off'})`, async () => {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      const t = await setup(() => $line($createTextNode('xabcde')), {
        gc,
        ids,
      });
      upgrade(t.a);
      await t.sync();
      // x RED BLUE a b c end(BLUE) d null e: a legacy red opener (unpaired)
      // in the gap before the range, a native blue run over "abc" above it.
      const red = rawItem(t.a, 'abcde', 'p:style', 'color: red;');
      const blue = rawItem(t.a, 'abcde', 'p:style', 'color: blue;');
      rawItem(t.a, 'de', 'p:style', [
        t.a.doc.store.getClock(t.a.doc.clientID) - blue.id.clock,
      ]);
      const redEnd = rawItem(t.a, 'e', 'p:style', null);
      await t.sync();
      const want = [
        'x|',
        'ab|color: green;',
        'c|color: blue;',
        'd|color: red;',
        'e|',
      ];
      // W colors "ab" green.
      color(t.b, 1, 3, 'green');
      await t.sync();
      await expectConverged(t.peers);
      expect(styles(t.a)).toEqual(want);
      // The legacy author's undo of its red: both of its items go.
      t.a.doc.transact(() => {
        red.delete(t.a.doc._transaction!);
        redEnd.delete(t.a.doc._transaction!);
      });
      await t.sync();
      await expectConverged(t.peers);
      expect(styles(t.a)).toEqual([
        'x|',
        'ab|color: green;',
        'c|color: blue;',
        'de|',
      ]);
    }
  });
}

for (const gc of [false, true]) {
  const g = `gc ${gc ? 'on' : 'off'}`;
  const orders = [
    [1, 2, 3],
    [3, 2, 1],
  ];

  test(`AM25 (automerge mark_contracts): text typed bold at the end of a legacy bold run while another client unbolds its start stays bold, as on main (${g})`, async () => {
    for (const ids of orders) {
      const t = await setup(
        () => $line($createTextNode('hello').setFormat(1)),
        {
          gc,
          ids,
        },
      );
      t.offline();
      bold(t.a, [0], 0, 3, 0);
      t.b.update(() => {
        const s = $selectIn([0], 5, 5);
        s.format = 1;
        s.insertText('!');
        $setSelection(null);
      });
      await t.sync();
      await expectConverged(t.peers, 'paragraph("hel" "lo!"{1})');
    }
  });

  test(`AM25 mirror (trade c, gone under layout 3): text typed bold at the end of a seeded bold run while another client unbolds that end is plain in both orders, as on main (${g})`, async () => {
    for (const ids of orders) {
      const t = await setup(
        () => $line($createTextNode('hello').setFormat(1)),
        {
          gc,
          ids,
        },
      );
      t.offline();
      bold(t.a, [0], 3, 5, 0);
      t.b.update(() => {
        const s = $selectIn([0], 5, 5);
        s.format = 1;
        s.insertText('!');
        $setSelection(null);
      });
      await t.sync();
      // Layout 3: the seed's bold is a paired run of its own, so the order
      // no longer depends on client ids: plain in both orders, as on main
      // (the client-id race arose for legacy runs only).
      await expectConverged(t.peers, 'paragraph("hel"{1} "lo!")');
    }
  });

  test(`plain text typed right after the legacy run's closer shows plain, and a new bold run there stays bold (${g})`, async () => {
    for (const ids of orders) {
      const t = await setup(
        () =>
          $line(
            $createTextNode('hello').setFormat(1),
            $createTextNode(' world'),
          ),
        {gc, ids},
      );
      t.offline();
      bold(t.a, [0], 0, 3, 0);
      t.b.update(() => {
        const s = $selectIn([0], 6, 6);
        s.format = 0;
        s.insertText('Z');
        $setSelection(null);
      });
      bold(t.c, [0], 7, 9);
      await t.sync();
      await expectConverged(t.peers);
      const text = t.a.describe();
      expect(text).toContain('"hel"');
      expect(text).toMatch(/"lo"\{1\}/);
      expect(text).not.toMatch(/Z[^"]*"\{1\}/);
      expect(text).toMatch(/"or"\{1\}/);
    }
  });

  test(`the legacy run's author undoes it after a paired change unbolded its start: exactly its run goes (main keeps "lo" bold through its restore) (${g})`, async () => {
    for (const ids of orders) {
      const t = await setup(() => $line($createTextNode('hello world')), {
        gc,
        ids,
      });
      // L (legacy) bolds "hello": its null after "o" is the departure item.
      bold(t.c, [0], 0, 5);
      await t.sync();
      bold(t.a, [0], 0, 3, 0);
      await t.sync();
      await expectConverged(t.peers, 'paragraph("hel" "lo"{1} " world")');
      t.c.undo();
      await t.sync();
      await expectConverged(t.peers, 'paragraph("hello world")');
    }
  });
}

// a deleted run must not change how far an item the
// change keeps reaches, nothing is copied past the range, and a range ending
// right before an unpaired item with its value is written as main's rule 3.
for (const gc of [false, true]) {
  const g = `gc ${gc ? 'on' : 'off'}`;
  const orders = [
    [1, 2, 3],
    [3, 2, 1],
    [2, 3, 1],
    [1, 3, 2],
  ];

  test(`a run whose interval holds a clearer is kept: the clearer's reach is unchanged (${g})`, async () => {
    for (const ids of orders) {
      const t = await setup(() => $line($createTextNode('xabc')), {gc, ids});
      upgrade(t.a);
      await t.sync();
      // U(red) x R(blue) S(green) /S a b /S /R c: the second /S names a run
      // already closed (a clearer).
      rawItem(t.a, 'xabc', 'p:style', 'color: red;');
      const r = rawItem(t.a, 'abc', 'p:style', 'color: blue;');
      const sg = rawItem(t.a, 'abc', 'p:style', 'color: green;');
      const end = (opener: Y.Item) => [
        t.a.doc.store.getClock(t.a.doc.clientID) - opener.id.clock,
      ];
      rawItem(t.a, 'abc', 'p:style', end(sg));
      rawItem(t.a, 'c', 'p:style', end(sg));
      rawItem(t.a, 'c', 'p:style', end(r));
      await t.sync();
      await expectConverged(t.peers);
      expect(styles(t.a)).toEqual([
        'x|color: red;',
        'ab|color: blue;',
        'c|color: red;',
      ]);
      color(t.b, 1, 3, 'orange');
      await t.sync();
      await expectConverged(t.peers);
      // = main: "c" keeps red.
      expect(styles(t.a)).toEqual([
        'x|color: red;',
        'ab|color: orange;',
        'c|color: red;',
      ]);
    }
  });

  test(`a run whose interval holds a held item is kept: after the release "c" keeps its value (${g})`, async () => {
    for (const ids of orders) {
      const t = await setup(() => $line($createTextNode('xabcdZ')), {
        gc,
        ids,
      });
      upgrade(t.a);
      await t.sync();
      // U(blue) x R(green) a b /R c d Z
      rawItem(t.a, 'xabcdZ', 'p:style', 'color: blue;');
      const r = rawItem(t.a, 'abcdZ', 'p:style', 'color: green;');
      rawItem(t.a, 'cdZ', 'p:style', [
        t.a.doc.store.getClock(t.a.doc.clientID) - r.id.clock,
      ]);
      await t.sync();
      await expectConverged(t.peers);
      // W composes "Y" after "Z".
      t.b.update(() => {
        const [node, offset] = $locateIn($block([0]), 6);
        node.select(offset, offset);
        $setCompositionKey(node.getKey());
        node.spliceText(offset, 0, 'Y', true);
      });
      await flush();
      // A legacy writer's H(red) before "b" and H(null) before "d" reach W
      // while it composes: held.
      rawItem(t.a, 'b', 'p:style', 'color: red;');
      rawItem(t.a, 'dZ', 'p:style', null);
      await flush();
      expect(
        (t.b.binding as unknown as {state: {hidden: unknown}}).state.hidden,
      ).not.toBeNull();
      // W colors "ab" orange while the items are held.
      color(t.b, 1, 3, 'orange');
      t.b.update(() => $setCompositionKey(null));
      await t.sync();
      await expectConverged(t.peers);
      // The full fold: "c" blue (/R removes H(red)), "d" unstyled (H(null)).
      expect(styles(t.a)).toEqual([
        'x|color: blue;',
        'ab|color: orange;',
        'c|color: blue;',
        'dZY|',
      ]);
    }
  });

  test(`nothing is copied past the range: a concurrent color of the next character keeps its value in both id orders, as on main (${g})`, async () => {
    for (const ids of [
      [1, 2, 3],
      [1, 3, 2],
    ]) {
      const t = await setup(() => $line($createTextNode('xbcd')), {gc, ids});
      const [l, w, c] = t.peers;
      // x U(red) b N(null) c d, as a legacy client writes it.
      color(l, 1, 2, 'red');
      await t.sync();
      t.offline();
      color(w, 1, 2, 'green');
      color(c, 2, 3, 'blue');
      await t.sync();
      await expectConverged(t.peers);
      expect(styles(l)).toEqual([
        'x|',
        'b|color: green;',
        'c|color: blue;',
        'd|',
      ]);
    }
  });

  test(`a retained paired end inside the last segment does not cut the change short: "b" takes its value, as on main (${g})`, async () => {
    for (const ids of orders) {
      const t = await setup(() => $line($createTextNode('xabc')), {gc, ids});
      upgrade(t.a);
      await t.sync();
      // U(blue) R(green) x a /R b V(orange) c
      rawItem(t.a, 'xabc', 'p:style', 'color: blue;');
      const r = rawItem(t.a, 'xabc', 'p:style', 'color: green;');
      rawItem(t.a, 'bc', 'p:style', [
        t.a.doc.store.getClock(t.a.doc.clientID) - r.id.clock,
      ]);
      rawItem(t.a, 'c', 'p:style', 'color: orange;');
      await t.sync();
      await expectConverged(t.peers);
      expect(styles(t.a)).toEqual([
        'xa|color: green;',
        'b|color: blue;',
        'c|color: orange;',
      ]);
      color(t.b, 1, 3, 'orange');
      await t.sync();
      await expectConverged(t.peers);
      expect(styles(t.a)).toEqual(['x|color: green;', 'abc|color: orange;']);
    }
  });

  test(`identity clients' changes and an undo after the upgrade: the undo brings back the older value, as on main (${g})`, async () => {
    for (const ids of [
      [1, 2, 3, 4],
      [4, 3, 2, 1],
    ]) {
      const t = await setup(() => $line($createTextNode('xbcdef')), {gc, ids});
      const [l, a, b, w] = t.peers;
      // A main-produced document: blue "xbcdef", "d" red.
      color(l, 0, 6, 'blue');
      await t.sync();
      color(l, 3, 4, 'red');
      await t.sync();
      color(a, 1, 3, 'red');
      await t.sync();
      color(b, 2, 4, 'blue');
      await t.sync();
      color(w, 1, 2, 'green');
      await t.sync();
      await expectConverged(t.peers);
      expect(styles(l)).toEqual([
        'x|color: blue;',
        'b|color: green;',
        'cdef|color: blue;',
      ]);
      b.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(styles(l)).toEqual([
        'x|color: blue;',
        'b|color: green;',
        'cd|color: red;',
        'ef|color: blue;',
      ]);
    }
  });

  test(`a concurrent change deleting the item after a range does not let the range's value escape, as on main (${g})`, async () => {
    for (const ids of orders) {
      const t = await setup(() => $line($createTextNode('xabcd')), {gc, ids});
      const [l, w, c] = t.peers;
      color(l, 0, 5, 'blue');
      await t.sync();
      // A legacy client colors "c" green while an identity client colors
      // "abc" violet.
      t.offline();
      color(l, 3, 4, 'green');
      color(w, 1, 4, 'violet');
      await t.sync();
      await expectConverged(t.peers);
      // W colors "ab" green while C deletes "ab" and colors "c" red.
      t.offline();
      color(w, 1, 3, 'green');
      c.update(() => {
        $selectIn([0], 1, 3).removeText();
        $setSelection(null);
      });
      color(c, 1, 2, 'red');
      await t.sync();
      await expectConverged(t.peers);
      expect(styles(l)).toEqual([
        'x|color: blue;',
        'c|color: red;',
        'd|color: blue;',
      ]);
    }
  });

  test(`(documented outcome) text deleted from a run the change wholly formats comes back plain after its undo, as on main (${g})`, async () => {
    for (const ids of orders) {
      const t = await setup(() => $line($createTextNode('xabc')), {gc, ids});
      const [r, d, w] = t.peers;
      bold(r, [0], 1, 3);
      await t.sync();
      d.update(() => {
        $selectIn([0], 1, 2).removeText();
        $setSelection(null);
      });
      await t.sync();
      bold(w, [0], 1, 2, 0);
      await t.sync();
      d.undo();
      await t.sync();
      // = main, gc off and on: the run is deleted with the change (spec
      // deleted content does not keep a run), so the text comes back
      // plain.
      await expectConverged(t.peers, 'paragraph("xabc")');
    }
  });

  test(`redo (documented outcome): text typed with the run's value, undone, then redone after a change that formats the rest of the run: as above (${g})`, async () => {
    for (const ids of orders) {
      const t = await setup(() => $line($createTextNode('xbc')), {gc, ids});
      const [r, d, w] = t.peers;
      bold(r, [0], 1, 2);
      await t.sync();
      d.update(() => {
        const s = $selectIn([0], 1, 1);
        s.format = 1;
        s.insertText('a');
        $setSelection(null);
      });
      await t.sync();
      d.undo();
      await t.sync();
      bold(w, [0], 1, 2, 0);
      await t.sync();
      d.binding.undoManager!.stopCapturing();
      expect(d.binding.redo()).toBe(true);
      await t.sync();
      // = main, gc off and on: the run is deleted with the change (spec
      // deleted content does not keep a run), so the text comes back
      // plain.
      await expectConverged(t.peers, 'paragraph("xabc")');
    }
  });

  test(`bold: a legacy bold "b" unbolded while a collaborator bolds "c": both keep their values in every id order, as on main (${g})`, async () => {
    for (const ids of orders) {
      const t = await setup(() => $line($createTextNode('xbcd')), {gc, ids});
      const [l, w, c] = t.peers;
      bold(l, [0], 1, 2);
      await t.sync();
      t.offline();
      bold(w, [0], 1, 2, 0);
      bold(c, [0], 2, 3);
      await t.sync();
      await expectConverged(t.peers, 'paragraph("xb" "c"{1} "d")');
    }
  });
}
