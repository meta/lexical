/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes while B's R is held, and A's update moves or replaces what the
// hold holds items in. Writing it anew from what A shows would delete R, or
// leave it behind. The edit is refused before it writes anything: no local
// Yjs update that writes content, the clocks unchanged, R kept where it
// was, A's whole local change undone, one UNSUPPORTED_EDIT_WARNING
// (`'held-composition'`). The shapes: A's own edits of the held text in the
// same update (two splices, clearing it), the held text merged into the
// text before it, a node put among the held text or none, a container move
// or a slot's paragraph replaced, and a held R that Yjs merged into one Item
// with text the editor shows.

import {
  $createListItemNode,
  $createListNode,
  type ListNode,
} from '@lexical/list';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  $getSlot,
  $setCompositionKey,
  $setSelection,
  $setSlot,
  DecoratorNode,
  ElementNode,
  ParagraphNode,
  type TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {
  $composed,
  $listDocument,
  $relocate,
  composing,
  GCS,
  held,
  HoldBox,
  ORDERS,
} from '../../utils/composeHold';
import {freshReader, NODES, setup} from '../../utils/harness';

class Box extends ElementNode {
  $config() {
    return this.config('refuse_box', {
      children: 'inline',
      extends: ElementNode,
    });
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

class Chip extends DecoratorNode<null> {
  $config() {
    return this.config('refuse_chip', {extends: DecoratorNode});
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
  decorate() {
    return null;
  }
}

class Host extends ParagraphNode {
  $config() {
    return this.config('refuse_host', {
      extends: ParagraphNode,
      slots: ['title'],
    });
  }
}

type Peer = Awaited<ReturnType<typeof setup>>['a'];

/**
 * The text format and style Lexical derives for an element from its text,
 * which the binding stores when Lexical changes them (the read after a
 * refusal can).
 */
const DERIVED = new Set(['p:textFormat', 'p:textStyle']);

/**
 * Count `peer`'s local Yjs updates that write content (anything but a
 * derived element field, see DERIVED) around `fn`, and read its clocks
 * before and after.
 */
async function writesOf(peer: Peer, fn: () => Promise<void>) {
  const clocks = () =>
    [...peer.doc.store.clients].map(([id, items]) => {
      const last = items[items.length - 1];
      return [id, last.id.clock + last.length];
    });
  let derived = 0;
  const before = clocks();
  let updates = 0;
  const count = (
    _u: Uint8Array,
    _o: unknown,
    _d: unknown,
    tr: {local: boolean; changed: Map<unknown, Set<string | null>>},
  ) => {
    if (!tr.local) {
      return;
    }
    const keys = [...tr.changed.values()].flatMap(set => [...set]);
    if (keys.length > 0 && keys.every(k => k !== null && DERIVED.has(k))) {
      derived++;
    } else {
      updates++;
    }
  };
  peer.doc.on('update', count);
  await fn();
  peer.doc.off('update', count);
  return {
    after: derived > 0 ? null : clocks(),
    before: derived > 0 ? null : before,
    updates,
  };
}

const texts = (p: Peer) =>
  p.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => n.getTextContent())
      .join('|'),
  );

const $first = () => $getRoot().getAllTextNodes()[0] as TextNode;

/**
 * Refused before it wrote anything: no local update writes content, and
 * where nothing derived was stored either, the clocks are unchanged.
 */
function expectRefused(
  a: Peer,
  writes: {after: unknown; before: unknown; updates: number},
) {
  expect(writes.updates).toBe(0);
  expect(writes.after).toEqual(writes.before);
  expect(a.warnings).toHaveLength(1);
  expect(a.warnings[0]).toMatch(
    /would delete or leave behind text a collaborator wrote/,
  );
  a.warnings.length = 0;
}

describe('held text merged into the text before it by an unwrap', () => {
  for (const gc of GCS) {
    for (const ids of ORDERS) {
      for (const bold of [false, true]) {
        for (const edit of ['none', 'delete', 'replace', 'append'] as const) {
          test(`the unwrap ${edit === 'replace' || edit === 'append' ? `with A's ${edit} of the held text is written, the typing kept` : `is refused, ${edit === 'none' ? 'with no edit' : `with A's ${edit} of the held text`}: R${bold ? " and B's bold" : ''} stay in the container`} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
            const t = await composing(
              () =>
                $listDocument(() => [
                  $createTextNode('x'),
                  $create(HoldBox).append($createTextNode('abc')),
                ]),
              gc,
              ids,
            );
            await held(t, () => {
              const n = $composed();
              if (bold) {
                n.setFormat('bold');
              }
              n.spliceText(1, 0, 'R');
            });
            const writes = await writesOf(t.a, async () => {
              t.a.update(() => {
                const n = $composed();
                if (edit === 'delete') {
                  n.spliceText(0, 1, '');
                } else if (edit === 'replace') {
                  n.spliceText(0, 1, 'q');
                } else if (edit === 'append') {
                  n.spliceText(n.getTextContentSize(), 0, 'Z');
                }
                $relocate('unwrap');
              });
              await t.sync();
            });
            if (edit === 'replace' || edit === 'append') {
              // It inserts a character: written as made, the typing kept
              // (see $heldDecision).
              expect(t.a.warnings).toEqual([]);
              t.a.update(() => $setCompositionKey(null));
              await t.sync();
              const fresh = await freshReader(t.a);
              onTestFinished(() => fresh.stop());
              expect(fresh.describe()).toContain(edit === 'append' ? 'Z' : 'q');
              for (const p of t.peers) {
                expect(p.describe()).toBe(fresh.describe());
              }
              return;
            }
            expectRefused(t.a, writes);
            t.a.update(() => $setCompositionKey(null));
            await t.sync();
            const fresh = await freshReader(t.a);
            onTestFinished(() => fresh.stop());
            const shown = t.a.describe();
            expect(shown).toContain(
              `listitem("x" hold_box(${bold ? '"aRbc"{1}' : '"aRbc"'}))`,
            );
            expect(fresh.describe()).toBe(shown);
            for (const p of t.peers) {
              expect(p.describe()).toBe(shown);
            }
            expect(t.a.warnings).toEqual([]);
          });
        }
      }
    }
  }
});

describe('A edits the held text and moves its item in one update', () => {
  for (const gc of GCS) {
    for (const ids of ORDERS) {
      for (const shape of ['box', 'line'] as const) {
        for (const move of [false, true]) {
          for (const edit of ['disjoint', 'empty', 'merged-source'] as const) {
            const what =
              edit === 'disjoint'
                ? 'two splices of the held text'
                : edit === 'empty'
                  ? 'the held text cleared'
                  : "B's shown text and held R in one Item";
            const outcome =
              move && edit === 'disjoint'
                ? 'written, the typing kept'
                : move || (edit === 'empty' && shape === 'box')
                  ? 'refused, R kept'
                  : 'control, no move';
            test(`${what} (${shape}): ${outcome} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
              const initial = edit === 'disjoint' ? 'abcde' : 'abc';
              const t = await setup(
                () => {
                  const n = $createTextNode(initial);
                  $getRoot().append(
                    $createListNode('number').append(
                      $createListItemNode().append(
                        shape === 'box' ? $create(Box).append(n) : n,
                      ),
                      $createListItemNode().append($createTextNode('tail')),
                    ),
                  );
                },
                {gc, ids, nodes: [...NODES, Box]},
              );
              const {a, b} = t;
              const dom = document.createElement('div');
              dom.contentEditable = 'true';
              document.body.append(dom);
              a.editor.setRootElement(dom);
              dom.focus();
              onTestFinished(() => {
                a.editor.setRootElement(null);
                dom.remove();
                t.peers.forEach(p => p.stop());
              });
              if (edit === 'merged-source') {
                b.update(() => {
                  const n = $first();
                  n.spliceText(n.getTextContentSize(), 0, 'XYZ');
                  $setSelection(null);
                });
                await t.sync();
              }
              a.update(() => {
                const n = $first();
                n.select(1, 1);
                $setCompositionKey(n.getKey());
              });
              await t.sync();
              b.update(() => {
                const n = $first();
                n.spliceText(
                  edit === 'merged-source'
                    ? n.getTextContentSize()
                    : edit === 'disjoint'
                      ? 2
                      : 1,
                  0,
                  'R',
                );
                $setSelection(null);
              });
              await t.sync();
              const writes = await writesOf(a, async () => {
                a.update(() => {
                  const n = $first();
                  if (edit === 'disjoint') {
                    n.spliceText(0, 1, '');
                    n.spliceText(n.getTextContentSize(), 0, 'Z');
                  } else if (edit === 'empty') {
                    n.spliceText(0, n.getTextContentSize(), '');
                  }
                  if (move) {
                    const list = $getRoot().getFirstChildOrThrow() as ListNode;
                    list.append(list.getFirstChildOrThrow());
                  }
                });
                await t.sync();
              });
              // Clearing the held text of an inline container removes its
              // text node: refused too (its text could have gone into
              // another node, see $changesHeldStructure).
              // With the typed Z: written as made (it inserts a character,
              // see $heldDecision), the typing kept.
              if (move && edit === 'disjoint') {
                expect(a.warnings).toEqual([]);
                a.update(() => $setCompositionKey(null));
                await t.sync();
                const fresh = await freshReader(a);
                onTestFinished(() => fresh.stop());
                expect(texts(fresh)).toContain('Z');
                for (const p of t.peers) {
                  expect(p.describe()).toBe(fresh.describe());
                }
                return;
              }
              const refused = move || (edit === 'empty' && shape === 'box');
              if (refused) {
                expectRefused(a, writes);
              }
              a.update(() => $setCompositionKey(null));
              await t.sync();
              const fresh = await freshReader(a);
              onTestFinished(() => fresh.stop());
              expect(a.describe()).toBe(fresh.describe());
              for (const p of t.peers) {
                expect(p.describe()).toBe(a.describe());
              }
              const want = refused
                ? edit === 'disjoint'
                  ? 'abRcde|tail'
                  : edit === 'empty'
                    ? 'aRbc|tail'
                    : 'abcXYZR|tail'
                : edit === 'disjoint'
                  ? 'bRcdeZ'
                  : edit === 'empty'
                    ? 'R'
                    : 'abcXYZR';
              expect(texts(a)).toBe(
                refused ? want : move ? `tail|${want}` : `${want}|tail`,
              );
              expect(a.warnings).toEqual([]);
            });
          }
        }
      }
    }
  }
  for (const gc of GCS) {
    for (const ids of ORDERS) {
      for (const move of [false, true]) {
        test(`two splices of the held text after B undid a bold A still shows: ${move ? 'with the move, written (it types Z), the typing kept' : 'control, no move, and the text it kept stays plain'} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $createListNode('number').append(
                  $createListItemNode().append(
                    $create(Box).append($createTextNode('abcde')),
                  ),
                  $createListItemNode().append($createTextNode('tail')),
                ),
              ),
            {gc, ids, nodes: [...NODES, Box]},
          );
          const {a, b} = t;
          const dom = document.createElement('div');
          dom.contentEditable = 'true';
          document.body.append(dom);
          a.editor.setRootElement(dom);
          dom.focus();
          onTestFinished(() => {
            a.editor.setRootElement(null);
            dom.remove();
            t.peers.forEach(p => p.stop());
          });
          b.update(() => $first().setFormat('bold'));
          await t.sync();
          a.update(() => {
            const n = $first();
            n.select(1, 1);
            $setCompositionKey(n.getKey());
          });
          await t.sync();
          b.undo();
          await t.sync();
          b.update(() => {
            $first().spliceText(2, 0, 'R');
            $setSelection(null);
          });
          await t.sync();
          await writesOf(a, async () => {
            a.update(() => {
              const n = $first();
              n.spliceText(0, 1, '');
              n.spliceText(n.getTextContentSize(), 0, 'Z');
              if (move) {
                const list = $getRoot().getFirstChildOrThrow() as ListNode;
                list.append(list.getFirstChildOrThrow());
              }
            });
            await t.sync();
          });
          if (move) {
            // With the typed Z: written as made (see $heldDecision).
            expect(a.warnings).toEqual([]);
            a.update(() => $setCompositionKey(null));
            await t.sync();
            const fresh = await freshReader(a);
            onTestFinished(() => fresh.stop());
            expect(texts(fresh)).toContain('Z');
            for (const p of t.peers) {
              expect(p.describe()).toBe(fresh.describe());
            }
            return;
          }
          a.update(() => $setCompositionKey(null));
          await t.sync();
          const fresh = await freshReader(a);
          onTestFinished(() => fresh.stop());
          expect(a.describe()).toBe(fresh.describe());
          for (const p of t.peers) {
            expect(p.describe()).toBe(a.describe());
          }
          const flat = a.read(() =>
            $getRoot()
              .getAllTextNodes()
              .flatMap(n =>
                [...n.getTextContent()].map(ch => [ch, n.getFormat()] as const),
              ),
          );
          expect(
            flat
              .filter(([ch]) => 'bcde'.includes(ch))
              .every(([, format]) => format === 0),
          ).toBe(true);
          expect(texts(a)).toBe(move ? 'abRcde|tail' : 'bRcdeZ|tail');
          expect(a.warnings).toEqual([]);
        });
      }
    }
  }
});

describe('a node put among the held text as its container moves or its slot is replaced', () => {
  for (const gc of GCS) {
    for (const ids of ORDERS) {
      for (const path of ['sequence', 'map'] as const) {
        for (const insert of [false, true]) {
          test(`${path === 'sequence' ? 'a move of the container composed in' : "a replaced slot's paragraph"} ${insert ? 'with an inline node put among the held text' : 'alone'} is refused, and keeps R (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
            const t = await setup(
              () => {
                const children = [
                  $createTextNode('ab'),
                  $createTextNode('cd').setFormat('bold'),
                ];
                if (path === 'sequence') {
                  $getRoot().append(
                    $createListNode('number').append(
                      $createListItemNode().append(
                        $create(Box).append(...children),
                      ),
                      $createListItemNode().append($createTextNode('tail')),
                    ),
                  );
                } else {
                  $getRoot().append(
                    $setSlot(
                      $create(Host),
                      'title',
                      $createParagraphNode().append(...children),
                    ),
                  );
                }
              },
              {gc, ids, nodes: [...NODES, Box, Chip, Host]},
            );
            const {a, b} = t;
            const dom = document.createElement('div');
            dom.contentEditable = 'true';
            document.body.append(dom);
            a.editor.setRootElement(dom);
            dom.focus();
            onTestFinished(() => {
              a.editor.setRootElement(null);
              dom.remove();
              t.peers.forEach(p => p.stop());
            });
            a.warnings.length = 0;
            const $firstA = () =>
              $getRoot()
                .getAllTextNodes()
                .find(n => n.getTextContent().startsWith('a'))!;
            a.update(() => {
              const n = $firstA();
              n.select(1, 1);
              $setCompositionKey(n.getKey());
            });
            await t.sync();
            b.update(() => {
              $firstA().spliceText(1, 0, 'R');
              $setSelection(null);
            });
            await t.sync();
            const writes = await writesOf(a, async () => {
              a.update(() => {
                if (insert) {
                  $firstA().insertAfter($create(Chip));
                }
                if (path === 'sequence') {
                  const list = $getRoot().getFirstChildOrThrow() as ListNode;
                  list.append(list.getFirstChildOrThrow());
                } else {
                  const host = $getRoot().getFirstChildOrThrow() as Host;
                  const slot = $getSlot(host, 'title') as ParagraphNode;
                  $setSlot(
                    host,
                    'title',
                    $createParagraphNode().append(...slot.getChildren()),
                  );
                }
              });
              await t.sync();
            });
            expectRefused(a, writes);
            a.update(() => $setCompositionKey(null));
            await t.sync();
            const fresh = await freshReader(a);
            onTestFinished(() => fresh.stop());
            expect(a.describe()).toBe(fresh.describe());
            for (const p of t.peers) {
              expect(p.describe()).toBe(a.describe());
            }
            expect(
              a.read(() =>
                $getRoot()
                  .getAllTextNodes()
                  .map(n => n.getTextContent())
                  .join(''),
              ),
            ).toContain('aRbcd');
            expect(a.describe()).not.toContain('refuse_chip');
            expect(a.warnings).toEqual([]);
          });
        }
      }
    }
  }
});
