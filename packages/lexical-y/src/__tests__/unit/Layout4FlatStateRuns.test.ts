/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Layout 4 (D120): a flat NodeState value on text (`s:<key>`) is a covered
// name, stored as paired runs like formats: overlapping values of one key
// set at once nest, a case whose outcome layout 4 keeps, and the stored
// shape of a value removed from part of a run (an end naming its opener
// instead of a plain null).

import {ContentFormat, type Item} from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $isElementNode,
  $isTextNode,
  $setState,
  createState,
  type ElementNode,
  type LexicalNode,
  stringValue,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {expectConverged, freshReader, type Peer, setup} from '../utils/harness';

const color = createState('color', {parse: stringValue()});

/** Each character with its `color` ('-' for none), in document order. */
function colors(peer: Peer): string {
  return peer.read(() => {
    const out: string[] = [];
    const visit = (n: LexicalNode) => {
      if ($isElementNode(n)) {
        n.getChildren().forEach(visit);
      } else if ($isTextNode(n)) {
        const v = $getState(n, color) || '-';
        for (const ch of n.getTextContent()) {
          out.push(`${ch}:${v}`);
        }
      }
    };
    visit($getRoot());
    return out.join(' ');
  });
}

/** The live `s:color` format items of the root's own sequence. */
function colorItems(peer: Peer): unknown[] {
  const root = peer.doc.get('lexical-y');
  const out: unknown[] = [];
  for (let it = root._start as Item | null; it !== null; it = it.right) {
    if (
      !it.deleted &&
      it.content instanceof ContentFormat &&
      it.content.key === 's:color'
    ) {
      out.push(it.content.value);
    }
  }
  return out;
}

const $text = (): TextNode =>
  (
    $getRoot().getFirstChildOrThrow() as ElementNode
  ).getFirstChildOrThrow() as TextNode;

/** Set `color` to `value` on characters [from, to) of the line's text. */
function $color(from: number, to: number, value: string | null) {
  const node = $text();
  const parts = node.splitText(from, to);
  const target = from === 0 ? parts[0] : parts[1];
  // The default ('') is no value: it is not stored.
  $setState(target, color, value ?? '');
}

describe('layout 4: flat NodeState on text as paired runs', () => {
  test('a value is stored as an opener and an end naming it, never a plain null', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode('abcdefgh')),
      ),
    );
    t.a.update(() => $color(2, 5, 'red'));
    await t.sync();
    const items = colorItems(t.a);
    expect(items).toHaveLength(2);
    expect(items[0]).toBe('red');
    expect(Array.isArray(items[1]) && (items[1] as unknown[]).length).toBe(1);
    expect(items).not.toContain(null);
    expect(colors(t.b)).toBe('a:- b:- c:red d:red e:red f:- g:- h:-');
    await expectConverged(t.peers);
  });

  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`overlapping runs nest instead of being cut short (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('abcdefgh')),
          ),
        {ids},
      );
      t.offline();
      t.a.update(() => $color(0, 5, 'red'));
      t.b.update(() => $color(3, 8, 'blue'));
      await t.sync();
      const want = 'a:red b:red c:red d:blue e:blue f:blue g:blue h:blue';
      expect(colors(t.a)).toBe(want);
      expect(colors(t.b)).toBe(want);
      expect(colors(await freshReader(t.a))).toBe(want);
      // No plain null anywhere: every item is an opener or an end.
      expect(colorItems(t.a)).not.toContain(null);
      await expectConverged(t.peers);
    });

    test(`an undone value goes from text typed inside its run (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('abcdefgh')),
          ),
        {ids},
      );
      t.a.update(() => $color(0, 8, 'red'));
      await t.sync();
      t.offline();
      t.a.undo();
      // B types X after d, inheriting red as typed text does.
      t.b.update(() => {
        $text().select(4, 4).insertText('X');
      });
      await t.sync();
      const want = 'a:- b:- c:- d:- X:- e:- f:- g:- h:-';
      expect(colors(t.a)).toBe(want);
      expect(colors(t.b)).toBe(want);
      expect(colors(await freshReader(t.a))).toBe(want);
      await expectConverged(t.peers);
    });
  }
});
