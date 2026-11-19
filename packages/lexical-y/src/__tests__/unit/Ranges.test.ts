/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Range deletes across lines, line break NodeState, adjacent links.
// @vitest-environment node

import {$toggleLink} from '@lexical/link';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $setState,
  createState,
  type ElementNode,
  type LineBreakNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $p,
  $selectIn,
  type Delivery,
  expectConverged,
  freshReader,
  setup,
} from '../utils/harness';

const flag = createState('zz-flag', {
  parse: (v: unknown) => v === true,
});

describe('@lexical/y ranges, line breaks and links', () => {
  test('NodeState on a LineBreakNode syncs', async () => {
    const t = await setup(() => {
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('a'),
          $setState($createLineBreakNode(), flag, true),
          $createTextNode('b'),
        ),
      );
    });
    const fresh = await freshReader(t.a);
    const read = (p: typeof t.a) =>
      p.read(() => {
        const para = $getRoot().getFirstChild() as ElementNode;
        return $getState(para.getChildAtIndex(1) as LineBreakNode, flag);
      });
    expect(read(t.a)).toBe(true);
    expect(read(t.b)).toBe(true);
    expect(read(fresh)).toBe(true);
  });

  for (const delivery of ['causal', 'sender'] as Delivery[]) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      test(`range delete across lines ‖ type at end of line 2 (${delivery} ${ids})`, async () => {
        const t = await setup(
          () => $getRoot().append($p('one'), $p('two'), $p('three')),
          {delivery, ids},
        );
        t.offline();
        t.a.update(() => {
          const s = $selectIn([0], 2);
          s.focus.set($block([1]).getFirstDescendant()!.getKey(), 1, 'text');
          s.removeText();
        });
        t.b.update(() => $selectIn([1], 3).insertText('X'));
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.describe()).toBe('paragraph("onwoX") / paragraph("three")');
      });
    }
  }

  test('range delete across lines ‖ type inside the surviving tail', async () => {
    const t = await setup(() =>
      $getRoot().append($p('one'), $p('two'), $p('three')),
    );
    t.offline();
    t.a.update(() => {
      const s = $selectIn([0], 2);
      s.focus.set($block([1]).getFirstDescendant()!.getKey(), 1, 'text');
      s.removeText();
    });
    t.b.update(() => $selectIn([1], 2).insertText('X'));
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.describe()).toBe('paragraph("onwXo") / paragraph("three")');
  });
  test('range delete across lines ‖ bold the surviving tail', async () => {
    const t = await setup(() =>
      $getRoot().append($p('one'), $p('two'), $p('three')),
    );
    t.offline();
    t.a.update(() => {
      const s = $selectIn([0], 2);
      s.focus.set($block([1]).getFirstDescendant()!.getKey(), 1, 'text');
      s.removeText();
    });
    t.b.update(() => $selectIn([1], 1, 3).formatText('bold'));
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.describe()).toBe('paragraph("on" "wo"{1}) / paragraph("three")');
  });
  test('long tail (>= 4 chars) works: range delete ‖ type at end', async () => {
    const t = await setup(() =>
      $getRoot().append($p('one'), $p('twofold'), $p('three')),
    );
    t.offline();
    t.a.update(() => {
      const s = $selectIn([0], 2);
      s.focus.set($block([1]).getFirstDescendant()!.getKey(), 1, 'text');
      s.removeText();
    });
    t.b.update(() => $selectIn([1], 7).insertText('X'));
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.describe()).toBe('paragraph("onwofoldX") / paragraph("three")');
  });

  for (const delivery of ['causal', 'sender'] as Delivery[]) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      // Yjs format semantics (the same on Yjs 13 and 14): a format end of one
      // peer and a format start of the other at the same position are
      // ordered by client id, so part of one side can stay unformatted.
      test(`bold ‖ bold adjacent ranges in one line (${delivery} ${ids})`, async () => {
        const t = await setup(() => $getRoot().append($p('IJ')), {
          delivery,
          ids,
        });
        t.offline();
        t.a.update(() => $selectIn([0], 1, 2).formatText('bold'));
        t.b.update(() => $selectIn([0], 0, 1).formatText('bold'));
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.read(() => $getRoot().getTextContent())).toBe('IJ');
      });
    }
  }
  test('range delete across lines ‖ range delete covering the moved tail (no deleted text comes back)', async () => {
    const t = await setup(() =>
      $getRoot().append($p('AB'), $p('CDEF'), $p('G')),
    );
    t.offline();
    t.a.update(() => {
      const s = $selectIn([0], 2);
      s.focus.set($block([1]).getFirstDescendant()!.getKey(), 2, 'text');
      s.removeText();
    });
    t.b.update(() => {
      const s = $selectIn([0], 1);
      s.focus.set($block([1]).getFirstDescendant()!.getKey(), 4, 'text');
      s.removeText();
    });
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.describe()).toBe('paragraph("A") / paragraph("G")');
  });
  // The joined line ends with the second line's marker (the text kept its
  // items), which the peer removed with that line: the next line joins too.
  // Nothing deleted comes back and nothing typed is lost.
  test('range delete across lines ‖ remove the second line: no deleted text comes back', async () => {
    const t = await setup(() =>
      $getRoot().append($p('AB'), $p('CDE'), $p('FGHI')),
    );
    t.offline();
    t.a.update(() => {
      const s = $selectIn([0], 2);
      s.focus.set($block([1]).getFirstDescendant()!.getKey(), 2, 'text');
      s.removeText();
    });
    t.b.update(() => $block([1]).remove());
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.read(() => $getRoot().getTextContent()).replace(/\n/g, '')).toBe(
      'ABFGHI',
    );
  });

  test('two adjacent links with the same URL (sequential, one writer)', async () => {
    const t = await setup(() => $getRoot().append($p('Second line here.')));
    t.a.update(() => {
      $selectIn([0], 7, 8);
      $toggleLink('https://u');
    });
    t.a.update(() => {
      $selectIn([0], 8, 10);
      $toggleLink('https://u');
    });
    await t.sync();
    const fresh = await freshReader(t.a);
    expect(t.b.json()).toEqual(t.a.json());
    expect(fresh.json()).toEqual(t.a.json());
  });
  test('concurrent overlapping links with the same URL', async () => {
    const t = await setup(() => $getRoot().append($p('Second line here.')), {
      ids: [2, 1],
    });
    t.offline();
    t.a.update(() => {
      $selectIn([0], 7, 8);
      $toggleLink('https://u');
    });
    t.b.update(() => {
      $selectIn([0], 7, 10);
      $toggleLink('https://u');
    });
    await t.sync();
    await expectConverged(t.peers);
  });
});
