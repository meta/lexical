/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// A follow-up whose change the binding does not write is read again, and the
// re-read refreshes the derived fields of the groups it rebuilds (list
// numbering), as every read does. To cut off a loop (a group's own transform
// that rewrites the same content on every run, an app's listener that
// answers every refresh with such a follow-up), the fourth re-read in a row
// runs no refresh. That leaves derived values stale after four follow-ups in
// a row (#9632), an accepted limit (DECISIONS.md D90, y.md's Limits): those
// cells are `test.fails`, so that a change of the limit shows here.

import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  ListNode,
} from '@lexical/list';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $setSelection,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

import {freshReader, NODES, type Peer, setup} from '../../utils/harness';

const NAMING = 'block-id-repair';

const json = (p: Peer) => JSON.stringify(p.editor.getEditorState().toJSON());

/** The `value` of every item of the document's number list. */
const values = (p: Peer) =>
  p.editor.getEditorState().read(() =>
    (
      $getRoot()
        .getChildren()
        .find(c => c.getType() === 'list') as ElementNode
    )
      .getChildren()
      .map(c => ($isListItemNode(c) ? c.getValue() : -1)),
  );

function $init(): void {
  $getRoot().append(
    $createParagraphNode().append($createTextNode('first')),
    $createListNode('number').append(
      $createListItemNode().append($createTextNode('i1')),
      $createListItemNode().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('n1')),
        ),
      ),
    ),
    $createParagraphNode().append($createTextNode('last')),
  );
}

function $numberList(): ElementNode {
  return $getRoot()
    .getChildren()
    .find(c => c.getType() === 'list') as ElementNode;
}

// `before` follow-ups that insert a paragraph (not written: a follow-up may
// only set attributes or delete) and then one that empties the list item
// holding the nested list, all by one client: after each, its editor shows
// what a fresh reader of its document shows, list numbering included.
describe('list numbering after follow-ups in a row that are read again', () => {
  for (const before of [0, 1, 2, 3, 4, 6]) {
    for (const tag of [NAMING, undefined]) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        // #9632 (D90, accepted limit): the fourth re-read in a row runs no
        // refresh.
        const known = tag === NAMING && before >= 3;
        (known ? test.fails : test)(
          `${before} before, tag ${tag ?? 'none'}, ids ${ids}`,
          async () => {
            const t = await setup($init, {ids});
            expect(values(t.a)).toEqual([1, 2]);
            const steps: [string, () => void][] = [];
            for (let i = 0; i < before; i++) {
              steps.push([
                `insert ${i}`,
                () =>
                  $getRoot()
                    .getLastChildOrThrow()
                    .insertBefore(
                      $createParagraphNode().append($createTextNode(`p${i}`)),
                    ),
              ]);
            }
            steps.push([
              'empty the item holding the nested list',
              () => ($numberList().getChildAtIndex(1) as ElementNode).clear(),
            ]);
            for (const [what, $step] of steps) {
              t.a.update(() => {
                $step();
                $setSelection(null);
              }, tag);
              const fresh = await freshReader(t.a);
              expect(values(t.a), what).toEqual(values(fresh));
              expect(json(t.a), what).toBe(json(fresh));
              await t.sync();
              expect(json(t.b), what).toBe(json(t.a));
            }
          },
        );
      }
    }
  }
});

let looping: LexicalEditor | null = null;
let runs = 0;

/** A list whose own transform adds an item every time it runs. */
class GrowingListNode extends ListNode {
  $config() {
    return this.config('test-growing-list', {
      $transform: (node: GrowingListNode) => {
        if ($getEditor() === looping) {
          runs++;
          node.append($createListItemNode().append($createTextNode('more')));
        }
      },
      extends: ListNode,
    });
  }
}

test('a refresh that keeps changing what it may not write is cut off, and the editor shows the document', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const t = await setup(
      () => {
        $getRoot().append(
          $create(GrowingListNode)
            .setListType('bullet')
            .append($createListItemNode().append($createTextNode('one'))),
        );
      },
      {nodes: [...NODES, GrowingListNode]},
    );
    looping = t.a.editor;
    runs = 0;
    // B adds an item: A's read refreshes the list, whose transform adds
    // another one, which is not written and is read again, and so on.
    t.b.update(() => {
      ($getRoot().getFirstChildOrThrow() as ElementNode).append(
        $createListItemNode().append($createTextNode('two')),
      );
    });
    await t.sync();
    await new Promise(resolve => setTimeout(resolve, 20));
    looping = null;
    // The first refresh and the one after each of the re-reads before the
    // last (MAX_REREADS = 3); the last runs none.
    expect(runs).toBe(4);
    expect(
      warn.mock.calls.filter(([m]) =>
        String(m).includes('follow-ups keep changing content'),
      ).length,
    ).toBe(1);
    const fresh = await freshReader(t.a);
    expect(json(t.a)).toBe(json(fresh));
    expect(json(t.b)).toBe(json(t.a));
  } finally {
    looping = null;
    warn.mockRestore();
  }
});
