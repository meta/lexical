/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Where a write stores paired runs, nothing infers which write made an item
// from its client and clocks: format items
// are grouped by position (a family's items right after one another, up to
// another family, a held or gone item or content), and a node's opener is
// found by position and stored pairing (pre-upgrade headers included).
// Main's rules stay below layout 3 and for uncovered keys. So the same shape
// written as one write, or as two writes from two clients, reads and edits
// the same (with the same clients in the same roles).

import {$addMarkID} from '@lexical/mark';
import * as Y from '@y/y';
import {
  $createRangeSelection,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $isTabNode,
  $isTextNode,
  $setSelection,
  type TextNode,
} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {createYDoc} from '../../..';
import {
  $p,
  expectConverged,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';
import {
  setFormatIdentityWrites,
  setFormatIdentityWritesDefault,
} from '../../utils/noSwitch';
import {prepareMarkState as prepare} from '../../utils/sizeOps';

afterEach(() => {
  setFormatIdentityWritesDefault(false);
});

function $text(token: string): TextNode {
  for (const n of $getRoot().getAllTextNodes()) {
    if ($isTextNode(n) && n.getTextContent().includes(token)) {
      return n;
    }
  }
  throw new Error(`no ${token}`);
}

function $comment(id: string, token: string) {
  const n = $text(token);
  const i = n.getTextContent().indexOf(token);
  const sel = $createRangeSelection();
  sel.anchor.set(n.getKey(), i, 'text');
  sel.focus.set(n.getKey(), i + token.length, 'text');
  $addMarkID(id, sel);
  $setSelection(null);
}

/** Insert a plain text node "Z" right after the text node holding `token`. */
function $typePlainAfter(token: string) {
  const n = $text(token);
  n.insertAfter($createTextNode('Z'));
  $setSelection(null);
}

const shown = (peer: Peer): [string, number, string][] =>
  peer.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map((n): [string, number, string] => [
        $isTabNode(n) ? '\t' : n.getTextContent(),
        n.getFormat(),
        JSON.stringify(
          (n.exportJSON() as {$?: Record<string, unknown>}).$ ?? {},
        ),
      ]),
  );

async function settle(t: Awaited<ReturnType<typeof setup>>) {
  await t.sync();
  const fresh = await freshReader(t.a);
  await expectConverged([...t.peers, fresh]);
  return shown(t.c);
}

for (const gc of [false, true]) {
  test(`two comments ending at one place: typed plain text there reads the same, one write or two (gc ${gc ? 'on' : 'off'})`, async () => {
    setFormatIdentityWritesDefault(true);
    const results: unknown[] = [];
    for (const two of [false, true]) {
      const t = await setup(() => $getRoot().append($p('ab cd')), {
        gc,
        ids: [1, 2, 3],
        prepare,
      });
      if (two) {
        t.a.update(() => $comment('c1', 'ab'));
        await t.sync();
        t.b.update(() => $comment('c2', 'ab'));
      } else {
        t.a.update(() => {
          $comment('c1', 'ab');
          $comment('c2', 'ab');
        });
      }
      await t.sync();
      t.c.update(() => $typePlainAfter('ab'));
      const out = await settle(t);
      expect(out.find(r => r[0].includes('Z'))?.[2]).toBe('{}');
      results.push(out);
    }
    expect(results[1]).toEqual(results[0]);
  });

  test(`a bold tab: plain text typed before it reads the same, one write or two (gc ${gc ? 'on' : 'off'})`, async () => {
    setFormatIdentityWritesDefault(true);
    const results: unknown[] = [];
    for (const two of [false, true]) {
      const t = await setup(() => $getRoot().append($p('ab')), {
        gc,
        ids: [1, 2, 3],
      });
      if (two) {
        t.a.update(() => {
          $text('ab').insertAfter($createTabNode());
          $setSelection(null);
        });
        await t.sync();
        t.b.update(() => {
          const tab = $getRoot().getAllTextNodes().find($isTabNode)!;
          tab.select(0, 1).formatText('bold');
          $setSelection(null);
        });
      } else {
        t.a.update(() => {
          const tab = $createTabNode();
          tab.toggleFormat('bold');
          $text('ab').insertAfter(tab);
          $setSelection(null);
        });
      }
      await t.sync();
      t.c.update(() => $typePlainAfter('ab'));
      const out = await settle(t);
      expect(out.map(r => [r[0], r[1]])).toEqual([
        ['abZ', 0],
        ['\t', 1],
      ]);
      results.push(out);
    }
    expect(results[1]).toEqual(results[0]);
  });

  test(`a family's items apart in a gap are not one unit: typed plain text stops before the first (gc ${gc ? 'on' : 'off'})`, async () => {
    // A counterexample: the gap s:markIds␟a = true, f:bold = true,
    // s:markIds␟a = null (and bold's closer) before "y". Grouping the
    // comment's items over the whole gap would step over the first only and
    // type inside the comment.
    setFormatIdentityWritesDefault(true);
    const t = await setup(() => $getRoot().append($p('t'), $p('xy')), {
      gc,
      prepare,
    });
    t.a.update(() => {
      $text('t').select(0, 1).formatText('italic');
      $setSelection(null);
    });
    await t.sync();
    expect(t.a.doc.get('lexical-y').getAttr('lexical-y:3')).toBe(true);
    const raw = createYDoc(null, {gc});
    raw.clientID = 777;
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(t.a.doc));
    const root = raw.get('lexical-y');
    let at = 0;
    for (let it = root._start; it !== null; it = it.right) {
      if (it.deleted || !it.countable) {
        continue;
      }
      const str = (it.content as unknown as {str?: string}).str;
      if (str !== undefined && str.includes('xy')) {
        at += str.indexOf('xy') + 1;
        break;
      }
      at += it.length;
    }
    raw.transact(() => root.insert(at, 'Q'));
    raw.transact(() => root.format(at, 1, {'s:markIds\u001fa': true}));
    raw.transact(() => root.format(at, 1, {'f:bold': true}));
    raw.transact(() => root.delete(at, 1));
    Y.applyUpdate(
      t.a.doc,
      Y.encodeStateAsUpdate(raw, Y.encodeStateVector(t.a.doc)),
    );
    await t.sync();
    t.b.update(() => $typePlainAfter('x'));
    await t.sync();
    const fresh = await freshReader(t.a);
    await expectConverged([...t.peers, fresh]);
    for (const peer of [t.a, t.b, fresh]) {
      const z = shown(peer).find(r => r[0].includes('Z'));
      expect(z?.[1]).toBe(0);
      expect(z?.[2]).toBe('{}');
    }
  });

  test(`a bold tab written before the upgrade (unpaired header): bold text typed before it reads the same, one write or two (gc ${gc ? 'on' : 'off'})`, async () => {
    const results: unknown[] = [];
    for (const two of [false, true]) {
      const t = await setup(() => $getRoot().append($p('ab'), $p('q')), {
        gc,
        ids: [1, 2, 3],
      });
      // Below layout 3: the tab's t and k are unpaired.
      if (two) {
        t.a.update(() => {
          $text('ab').insertAfter($createTabNode());
          $setSelection(null);
        });
        await t.sync();
        t.b.update(() => {
          const tab = $getRoot().getAllTextNodes().find($isTabNode)!;
          tab.select(0, 1).formatText('bold');
          $setSelection(null);
        });
      } else {
        t.a.update(() => {
          const tab = $createTabNode();
          tab.toggleFormat('bold');
          $text('ab').insertAfter(tab);
          $setSelection(null);
        });
      }
      await t.sync();
      // The upgrade: a paired write on the second line.
      for (const peer of t.peers) {
        setFormatIdentityWrites(peer.doc, true);
      }
      t.a.update(() => {
        $text('q').select(0, 1).formatText('italic');
        $setSelection(null);
      });
      await t.sync();
      expect(t.a.doc.get('lexical-y').getAttr('lexical-y:3')).toBe(true);
      t.c.update(() => {
        const z = $createTextNode('Z');
        z.toggleFormat('bold');
        $text('ab').insertAfter(z);
        $setSelection(null);
      });
      const out = await settle(t);
      expect(out.map(r => [r[0], r[1]])).toEqual([
        ['ab', 0],
        ['Z', 1],
        ['\t', 1],
        ['q', 2],
      ]);
      results.push(out);
    }
    expect(results[1]).toEqual(results[0]);
  });

  test(`two comments opening at one place: text typed there inside both is placed the same, one write or two (gc ${gc ? 'on' : 'off'})`, async () => {
    setFormatIdentityWritesDefault(true);
    const results: unknown[] = [];
    const written: number[] = [];
    for (const two of [false, true]) {
      const t = await setup(() => $getRoot().append($p('ab cd')), {
        gc,
        ids: [1, 2, 3],
        prepare,
      });
      if (two) {
        t.a.update(() => $comment('c1', 'ab'));
        await t.sync();
        t.b.update(() => $comment('c2', 'ab'));
      } else {
        t.a.update(() => {
          $comment('c1', 'ab');
          $comment('c2', 'ab');
        });
      }
      await t.sync();
      const before = t.c.doc.store.getClock(t.c.doc.clientID);
      // "Z" typed at the start of "ab", inside both comments.
      t.c.update(() => {
        $text('ab').select(0, 0).insertText('Z');
        $setSelection(null);
      });
      written.push(t.c.doc.store.getClock(t.c.doc.clientID) - before);
      const out = await settle(t);
      expect(out.find(r => r[0].includes('Zab'))?.[2]).toBe(
        JSON.stringify({markIds: ['c1', 'c2']}),
      );
      results.push(out);
    }
    expect(results[1]).toEqual(results[0]);
    // The same items: no format item of its own in either (the comments'
    // openers are stepped over as one unit, whoever wrote them).
    expect(written[1]).toBe(written[0]);
  });
}
