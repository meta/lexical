/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A composes in bold text. B unbolds it and types R, which A's composition
// holds back, so A still shows the text bold (the deleted bold run is kept
// showing). A then inserts a new text node with an explicit bold format:
// the new node is stored bold, as a run of its own (nested in the kept run
// while the hold lasts), so it stays bold once the hold ends, as on a
// client that held nothing. Old characters A writes again (a node replaced
// by one with the same text, a node split in two) do not bring the old bold
// back, and a character typed into the held text keeps today's result.

import {
  $copyNode,
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getEditor,
  $getRoot,
  $hasUpdateTag,
  $setCompositionKey,
  $setSelection,
  COLLABORATION_TAG,
  ElementNode,
  type LexicalEditor,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {
  expectConverged,
  freshReader,
  NODES,
  type Peer,
  setup,
} from '../../utils/harness';

class KeptBox extends ElementNode {
  $config() {
    return this.config('kept_box', {children: 'inline', extends: ElementNode});
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

/** A reaction an app runs once, from a selection transform in a read. */
const reactions = new WeakMap<LexicalEditor, () => void>();

/** Composed text whose selection transform runs an app's reaction. */
class KeptHook extends TextNode {
  $config() {
    return this.config('kept_hook', {extends: TextNode});
  }
  selectionTransform() {
    const editor = $getEditor();
    const reaction = reactions.get(editor);
    if (reaction !== undefined && $hasUpdateTag(COLLABORATION_TAG)) {
      reactions.delete(editor);
      reaction();
    }
  }
}

const $hook = () =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n instanceof KeptHook)!;

/** Each character with its node's format, in document order. */
const chars = (p: Peer): [string, number][] =>
  p.read(() =>
    $getRoot()
      .getAllTextNodes()
      .flatMap(n =>
        [...n.getTextContent()].map(
          ch => [ch, n.getFormat()] as [string, number],
        ),
      ),
  );

const BOLD = 1;

type Origin = 'stored bold from the start' | 'bolded by B before';

/** What B does to the text A composes in (held at A). */
type Change =
  | 'unbolds it and types R'
  | 'unbolds it'
  | 'unbolds it, then types R'
  | 'undoes its bold';

/** A composes in bold `abc`; B unbolds it and types R (held at A). */
async function start(
  gc: boolean,
  ids: number[],
  origin: Origin,
  change: Change = 'unbolds it and types R',
) {
  const t = await setup(
    () =>
      $getRoot().append(
        $createParagraphNode().append(
          $create(KeptBox).append(
            $create(KeptHook)
              .setTextContent('abc')
              .setFormat(origin === 'bolded by B before' ? 0 : BOLD),
          ),
        ),
        $createParagraphNode().append($createTextNode('separator')),
      ),
    {gc, ids, nodes: [...NODES, KeptBox, KeptHook]},
  );
  onTestFinished(() => t.peers.forEach(p => p.stop()));
  const {a, b} = t;
  if (origin === 'bolded by B before') {
    // B's own bold run, which B's unbold below then removes.
    b.update(() => {
      $hook().setFormat(BOLD);
      $setSelection(null);
    });
    await t.sync();
  }
  a.update(() => {
    $hook().select(1, 1);
    $setCompositionKey($hook().getKey());
  });
  await t.sync();
  if (change === 'undoes its bold') {
    b.undo();
  } else {
    b.update(() => {
      $hook().setFormat(0);
      if (change === 'unbolds it and types R') {
        $hook().spliceText(1, 0, 'R');
      }
      $setSelection(null);
    });
  }
  await t.sync();
  if (change === 'unbolds it, then types R') {
    b.update(() => {
      $hook().spliceText(1, 0, 'R');
      $setSelection(null);
    });
    await t.sync();
  }
  // A still shows the bold text, without R.
  expect(chars(a)).toEqual([
    ['a', BOLD],
    ['b', BOLD],
    ['c', BOLD],
    ...[...'separator'].map(ch => [ch, 0]),
  ]);
  return t;
}

/** Run `op` at A, locally or as an app's edit in a remote change's read. */
async function edit(
  t: Awaited<ReturnType<typeof start>>,
  mode: 'local' | 'in a remote read',
  op: () => void,
) {
  const {a, c} = t;
  if (mode === 'local') {
    a.update(op);
  } else {
    reactions.set(a.editor, op);
    c.update(() => {
      const separator = $getRoot()
        .getAllTextNodes()
        .find(n => n.getTextContent().startsWith('separator'))!;
      separator.spliceText(separator.getTextContentSize(), 0, '!');
      $setSelection(null);
    });
  }
  await t.sync();
}

async function release(t: Awaited<ReturnType<typeof start>>) {
  t.a.update(() => $setCompositionKey(null));
  await t.sync();
  const fresh = await freshReader(t.a);
  onTestFinished(() => fresh.stop());
  await expectConverged(t.peers);
  for (const p of t.peers) {
    expect(chars(p)).toEqual(chars(fresh));
  }
  return chars(fresh);
}

const formatOf = (list: [string, number][], ch: string) =>
  list.filter(([c]) => c === ch).map(([, f]) => f);

describe('an explicit format on a new text node, while a deletion of it is held', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const mode of ['local', 'in a remote read'] as const) {
        for (const origin of [
          'stored bold from the start',
          'bolded by B before',
        ] as const) {
          const id = `${origin}, ${mode} (gc ${gc ? 'on' : 'off'}, ids ${ids})`;

          test(`a new bold node is stored bold, during the hold and after it: ${id}`, async () => {
            const t = await start(gc, ids, origin);
            await edit(t, mode, () => {
              $hook().insertAfter(
                $createTextNode('文').setFormat(BOLD).toggleUnmergeable(),
              );
              $setSelection(null);
            });
            // During the hold: the clients that hold nothing read the new
            // node bold (its own run, nested in the kept one), the rest plain.
            for (const p of [t.b, t.c]) {
              const list = chars(p);
              expect(formatOf(list, '文')).toEqual([BOLD]);
              expect(formatOf(list, 'R')).toEqual([0]);
              expect(formatOf(list, 'b')).toEqual([0]);
              expect(formatOf(list, 'a')[0]).toBe(0);
            }
            expect(formatOf(chars(t.a), '文')).toEqual([BOLD]);
            const after = await release(t);
            expect(formatOf(after, '文')).toEqual([BOLD]);
            for (const ch of 'aRbc') {
              expect(formatOf(after, ch)[0]).toBe(0);
            }
            expect(formatOf(after, 'R')).toHaveLength(1);
          });

          for (const how of [
            'replaced by a new node',
            'split in two',
          ] as const) {
            test(`old characters written again (the held text ${how}) do not bring the old bold back: ${id}`, async () => {
              const t = await start(gc, ids, origin);
              await edit(t, mode, () => {
                const hook = $hook();
                if (how === 'replaced by a new node') {
                  hook.replace(
                    $create(KeptHook).setTextContent('abc').setFormat(BOLD),
                  );
                } else {
                  hook.splitText(1);
                }
                $setSelection(null);
              });
              const after = await release(t);
              for (const ch of 'aRbc') {
                expect(formatOf(after, ch)[0]).toBe(0);
              }
              expect(formatOf(after, 'R')).toHaveLength(1);
            });
          }

          test(`a character typed into the held text keeps today's result: ${id}`, async () => {
            const t = await start(gc, ids, origin);
            await edit(t, mode, () => {
              $hook().spliceText(3, 0, 'Z');
              $setSelection(null);
            });
            const after = await release(t);
            // Typed into the bold text A showed, it is plain once the hold
            // ends, as the text it was typed into.
            expect(formatOf(after, 'Z')).toEqual([0]);
            for (const ch of 'aRbc') {
              expect(formatOf(after, ch)[0]).toBe(0);
            }
          });
        }
      }
    }
  }
});

// B's change without R typed in it: its unbold (or the undo of its own bold)
// deletes the bold run's items, which the hold keeps showing (Hidden#keep)
// with nothing else held; with R typed in a later change, both.
describe("an explicit format on a new text node, whatever B's held change", () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const mode of ['local', 'in a remote read'] as const) {
        for (const [origin, change] of [
          ['stored bold from the start', 'unbolds it'],
          ['stored bold from the start', 'unbolds it, then types R'],
          ['bolded by B before', 'unbolds it'],
          ['bolded by B before', 'unbolds it, then types R'],
          ['bolded by B before', 'undoes its bold'],
        ] as const) {
          const typed = change === 'unbolds it, then types R';
          test(`B ${change} (${origin}): a new bold node is stored bold after the hold, ${mode} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
            const t = await start(gc, ids, origin, change);
            await edit(t, mode, () => {
              $hook().insertAfter(
                $createTextNode('文').setFormat(BOLD).toggleUnmergeable(),
              );
              $setSelection(null);
            });
            for (const p of [t.b, t.c]) {
              expect(formatOf(chars(p), '文')).toEqual([BOLD]);
            }
            const after = await release(t);
            expect(formatOf(after, '文')).toEqual([BOLD]);
            for (const ch of 'abc') {
              expect(formatOf(after, ch)[0]).toBe(0);
            }
            expect(formatOf(after, 'R')).toHaveLength(typed ? 1 : 0);
          });

          test(`B ${change} (${origin}): a character typed into the held text keeps today's result, ${mode} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
            const t = await start(gc, ids, origin, change);
            await edit(t, mode, () => {
              $hook().spliceText($hook().getTextContentSize(), 0, 'Z');
              $setSelection(null);
            });
            const after = await release(t);
            expect(formatOf(after, 'Z')).toEqual([0]);
          });
        }
      }
    }
  }
});

// A new node whose text descends from the held node (the node replaced by
// one with a new key, a copy of it, the tail of a split, each with a
// character added): not text of its own, so it is written as before, and
// B's unbold holds for all of it after the hold, the added character too.
describe('a new node that carries the held text on', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const mode of ['local', 'in a remote read'] as const) {
        for (const how of [
          'replaced by a new node',
          'copied',
          'split, with text added to its tail',
        ] as const) {
          test(`the held text ${how}: plain after the hold, ${mode} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
            const t = await start(gc, ids, 'stored bold from the start');
            await edit(t, mode, () => {
              const hook = $hook();
              if (how === 'split, with text added to its tail') {
                const tail = hook.splitText(1).at(-1)!;
                tail.spliceText(tail.getTextContentSize(), 0, '文');
              } else {
                const next =
                  how === 'copied'
                    ? $copyNode(hook).setTextContent('abc文')
                    : $create(KeptHook)
                        .setTextContent('abc文')
                        .setFormat(hook.getFormat());
                hook.replace(next);
              }
              $setSelection(null);
            });
            const after = await release(t);
            for (const ch of 'aRbc文') {
              expect(formatOf(after, ch)[0]).toBe(0);
            }
            expect(formatOf(after, '文')).toHaveLength(1);
          });
        }
      }
    }
  }
});

// Old characters carried into a new node in the same update that removes or
// cuts them from the held node (cut out and carried on, the held node then
// filled to the same length or longer; a character cut out of its middle;
// the held text re-made as new nodes): not text of their own, so written as
// before, and B's unbold holds for them after the hold, as on main.
describe('old characters carried into a new node', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const mode of ['local', 'in a remote read'] as const) {
        for (const how of [
          'a cut out and carried on, 文 typed in its place',
          'a cut out and carried on, 文文 typed in its place',
          'b cut out of the middle into a node of its own',
          'abc re-made as new nodes a and bc文',
        ] as const) {
          test(`${how}: the carried characters plain after the hold, ${mode} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
            const t = await start(gc, ids, 'stored bold from the start');
            await edit(t, mode, () => {
              const hook = $hook();
              const format = hook.getFormat();
              if (how === 'b cut out of the middle into a node of its own') {
                hook.spliceText(1, 1, '');
                hook.insertAfter(
                  $create(KeptHook).setTextContent('b').setFormat(format),
                );
              } else if (how === 'abc re-made as new nodes a and bc文') {
                const a = $create(KeptHook)
                  .setTextContent('a')
                  .setFormat(format);
                hook.replace(a);
                a.insertAfter(
                  $create(KeptHook).setTextContent('bc文').setFormat(format),
                );
              } else {
                hook.spliceText(
                  0,
                  1,
                  how.endsWith('文文 typed in its place') ? '文文' : '文',
                );
                hook.insertAfter(
                  $create(KeptHook).setTextContent('a').setFormat(format),
                );
              }
              $setSelection(null);
            });
            const after = await release(t);
            for (const [, f] of after.filter(([ch]) => 'abc'.includes(ch))) {
              expect(f).toBe(0);
            }
            if (how === 'abc re-made as new nodes a and bc文') {
              expect(formatOf(after, '文')).toEqual([0]);
            }
          });
        }
      }
    }
  }
});
