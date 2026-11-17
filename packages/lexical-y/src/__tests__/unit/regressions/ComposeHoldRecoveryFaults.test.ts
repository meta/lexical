/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The recovery of a write that fails part way while a hold is on, at every
// nesting of faults: the guard's stop or a fault right after the write
// copies the container composed in, then possibly another fault where the
// recovery starts (so a further recovery runs). Whichever path finishes the
// write, nothing is lost or duplicated, every peer agrees, the editor shows
// what is stored, and for a change that inserts no character the held R is
// kept once (no recovery copies or deletes what the hold keeps).

import {
  $create,
  $createParagraphNode,
  $getDocument,
  $getRoot,
  $setCompositionKey,
  $setSelection,
  ElementNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test, vi} from 'vitest';

import {Writer} from '../../../internal/Write';
import {freshReader, NODES, type Peer, setup} from '../../utils/harness';

class FaultBox extends ElementNode {
  $config() {
    return this.config('fault_box', {children: 'inline', extends: ElementNode});
  }
  isInline() {
    return true;
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM() {
    return false;
  }
}

const text = (p: Peer) =>
  p.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => n.getTextContent())
      .join('|'),
  );

const $box = () =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n.getParent() instanceof FaultBox)!
    .getParentOrThrow() as FaultBox;

describe('the recovery of a write that fails part way under a hold, at every nesting of faults', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const destination of ['earlier', 'later'] as const) {
        for (const inserting of [false, true]) {
          for (const faults of [
            'the guard stops it, then a fault where the recovery starts',
            'a fault right after its copy',
            'a fault right after its copy, then another where the recovery starts',
          ] as const) {
            // As on main: a write that fails after inserting part of a change
            // is recovered by inserting that content again (#9775).
            const asOnMain =
              inserting &&
              ((destination === 'later' &&
                faults !==
                  'the guard stops it, then a fault where the recovery starts') ||
                faults ===
                  'a fault right after its copy, then another where the recovery starts');
            (asOnMain ? test.fails : test)(
              `${faults}; the container moved to ${destination === 'earlier' ? 'an earlier' : 'a later'} line${inserting ? ', a character typed elsewhere' : ''}${asOnMain ? ' (as on main, see #9775)' : ''} (gc ${gc ? 'on' : 'off'}, ids ${ids})`,
              async () => {
                const t = await setup(
                  () =>
                    $getRoot().append(
                      $createParagraphNode().append(
                        $create(TextNode).setTextContent('x'),
                      ),
                      $createParagraphNode().append(
                        $create(TextNode).setTextContent('left'),
                        $create(FaultBox).append(
                          $create(TextNode).setTextContent('abc'),
                        ),
                      ),
                      $createParagraphNode().append(
                        $create(TextNode).setTextContent('separator'),
                      ),
                    ),
                  {gc, ids, nodes: [...NODES, FaultBox]},
                );
                const {a, b} = t;
                const errors = vi
                  .spyOn(console, 'error')
                  .mockImplementation(() => {});
                onTestFinished(() => errors.mockRestore());
                onTestFinished(() => t.peers.forEach(p => p.stop()));
                a.update(() => {
                  const n = $box().getFirstChildOrThrow() as TextNode;
                  n.select(1, 1);
                  $setCompositionKey(n.getKey());
                });
                await t.sync();
                b.update(() => {
                  ($box().getFirstChildOrThrow() as TextNode).spliceText(
                    1,
                    0,
                    'R',
                  );
                  $setSelection(null);
                });
                await t.sync();
                // The preflight bypassed: the guard and the recoveries decide.
                const endangers = Writer.prototype.$endangersHeld;
                Writer.prototype.$endangersHeld = function (this: Writer) {
                  const decided = endangers.call(this);
                  return this.tr.doc === a.doc ? false : decided;
                };
                const fill = Writer.prototype.$fillNode;
                let first =
                  faults !==
                  'the guard stops it, then a fault where the recovery starts';
                Writer.prototype.$fillNode = function (
                  this: Writer,
                  ...args: Parameters<Writer['$fillNode']>
                ) {
                  fill.apply(this, args);
                  if (
                    first &&
                    this.tr.doc === a.doc &&
                    args[1] instanceof FaultBox
                  ) {
                    first = false;
                    throw new Error('a fault after a copy');
                  }
                };
                const run = Writer.prototype.$run;
                let second = faults !== 'a fault right after its copy';
                Writer.prototype.$run = function (this: Writer) {
                  if (second && this.tr.doc === a.doc && this.rewriteAll) {
                    second = false;
                    throw new Error('a fault where the recovery starts');
                  }
                  return run.call(this);
                };
                onTestFinished(() => {
                  Writer.prototype.$endangersHeld = endangers;
                  Writer.prototype.$fillNode = fill;
                  Writer.prototype.$run = run;
                });
                a.update(() => {
                  const box = $box();
                  if (destination === 'earlier') {
                    ($getRoot().getFirstChildOrThrow() as ElementNode).append(
                      box,
                    );
                  } else {
                    $getRoot()
                      .getLastChildOrThrow()
                      .insertAfter($createParagraphNode().append(box));
                  }
                  if (inserting) {
                    (
                      (
                        $getRoot().getFirstChildOrThrow() as ElementNode
                      ).getFirstChildOrThrow() as TextNode
                    ).spliceText(1, 0, 'Z');
                  }
                  $setSelection(null);
                });
                await t.sync();
                Writer.prototype.$endangersHeld = endangers;
                Writer.prototype.$fillNode = fill;
                Writer.prototype.$run = run;
                a.update(() => $setCompositionKey(null));
                await t.sync();
                const fresh = await freshReader(a);
                onTestFinished(() => fresh.stop());
                const stored = text(fresh);
                expect([...t.peers.map(text)]).toEqual(
                  t.peers.map(() => stored),
                );
                // Nothing duplicated: the container's text once.
                expect(stored.match(/aR?bc/g)).toHaveLength(1);
                expect(stored.split('left')).toHaveLength(2);
                if (inserting) {
                  expect(stored).toContain('xZ');
                } else {
                  expect(stored.split('R')).toHaveLength(2);
                }
              },
            );
          }
        }
      }
    }
  }
});
