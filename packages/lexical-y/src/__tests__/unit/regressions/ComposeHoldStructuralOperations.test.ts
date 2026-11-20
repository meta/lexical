/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// Every Lexical operation that can change where a shared node lives, or
// replace it, made while A composes and B's R is held, locally or as an
// app's selectionTransform inside a remote read: either it moves, replaces
// or removes what holds R and is refused before it writes anything (one
// `'held-composition'` warning, no local Yjs update that writes content),
// or it leaves what holds R where it is and is written. Either way R is
// kept once and every peer and a fresh reader agree.

import {$createCodeHighlightNode, $createCodeNode} from '@lexical/code';
import {$createLinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getEditor,
  $getRoot,
  $getSlot,
  $hasUpdateTag,
  $removeSlot,
  $setCompositionKey,
  $setSelection,
  $setSlot,
  COLLABORATION_TAG,
  DecoratorNode,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {freshReader, NODES, type Peer, setup} from '../../utils/harness';

class Box extends ElementNode {
  $config() {
    return this.config('audit_box', {children: 'inline', extends: ElementNode});
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
    return this.config('audit_chip', {extends: DecoratorNode});
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
    return this.config('audit_host', {
      extends: ParagraphNode,
      slots: ['title', 'other'],
    });
  }
}

/** A reaction an app runs once, from a selection transform in a read. */
const reactions = new WeakMap<LexicalEditor, () => void>();

/** The composed text: its selection transform runs an app's reaction. */
class Hook extends TextNode {
  $config() {
    return this.config('audit_hook', {extends: TextNode});
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

type Fixture =
  | 'box-between'
  | 'list-box'
  | 'nested-list-box'
  | 'slot'
  | 'table'
  | 'paragraph'
  | 'code';

const $hook = () => $create(Hook).setTextContent('abc');

const FIXTURES: Record<Fixture, () => void> = {
  'box-between': () =>
    $getRoot().append(
      $createParagraphNode().append(
        $createTextNode('left').toggleUnmergeable(),
        $create(Box).append($hook()),
        $createTextNode('right').toggleUnmergeable(),
      ),
      $createParagraphNode().append($createTextNode('after')),
    ),
  code: () =>
    $getRoot().append(
      $createCodeNode('js').append($hook()),
      $createParagraphNode().append($createTextNode('after')),
    ),
  'list-box': () =>
    $getRoot().append(
      $createListNode('number').append(
        $createListItemNode().append($create(Box).append($hook())),
        $createListItemNode().append($createTextNode('tail')),
      ),
      $createParagraphNode().append($createTextNode('after')),
      $createListNode('number', 7).append(
        $createListItemNode().append($createTextNode('other')),
      ),
    ),
  'nested-list-box': () =>
    $getRoot().append(
      $createListNode('number').append(
        $createListItemNode().append($createTextNode('top')),
        $createListItemNode().append(
          $createListNode('number').append(
            $createListItemNode().append($create(Box).append($hook())),
          ),
        ),
      ),
      $createParagraphNode().append($createTextNode('after')),
    ),
  paragraph: () =>
    $getRoot().append(
      $createParagraphNode().append($hook()),
      $createParagraphNode().append($createTextNode('after')),
    ),
  slot: () =>
    $getRoot().append(
      $setSlot($create(Host), 'title', $createParagraphNode().append($hook())),
      $createParagraphNode().append($createTextNode('after')),
    ),
  table: () => {
    const $row = (a: LexicalNode, b: string) =>
      $createTableRowNode().append(
        $createTableCellNode().append($createParagraphNode().append(a)),
        $createTableCellNode().append(
          $createParagraphNode().append($createTextNode(b)),
        ),
      );
    $getRoot().append(
      $createTableNode().append(
        $row($hook(), 'x'),
        $row($createTextNode('y'), 'z'),
      ),
      $createParagraphNode().append($createTextNode('after')),
    );
  },
};

/** The composed text, found by its class. */
const $composed = (): Hook =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n instanceof Hook) as Hook;

const $firstList = () => $getRoot().getFirstChildOrThrow() as ListNode;
const $item = () =>
  $composed().getParentOrThrow().getParentOrThrow() as ListItemNode;
const $host = () => $getRoot().getFirstChildOrThrow() as Host;
const $table = () => $getRoot().getFirstChildOrThrow() as ElementNode;
const $row1 = () => $table().getFirstChildOrThrow() as ElementNode;

type Outcome = 'refused' | 'written';

/**
 * Operations whose read-edit form is a cell of its own: an app's
 * replacement of a slot's value by a new paragraph with the same children,
 * inside a read, shows no change #9788's read edits would write (the
 * block's JSON is the same); it is refused all the same (see the cell
 * below).
 */
const LOCAL_ONLY = new Set([
  "replace the slot's value with a new paragraph of its children",
]);

/** Each operation: the fixture it runs on, what it does, and its outcome. */
const OPS: [string, Fixture, () => void, Outcome][] = [
  [
    'insert a paragraph before the list',
    'list-box',
    () =>
      $firstList().insertBefore(
        $createParagraphNode().append($createTextNode('new')),
      ),
    'written',
  ],
  [
    'append a paragraph to the root',
    'list-box',
    () =>
      $getRoot().append($createParagraphNode().append($createTextNode('new'))),
    'written',
  ],
  [
    'remove the item composed in',
    'list-box',
    () => $item().remove(),
    'refused',
  ],
  [
    'replace the item composed in with a new one, keeping its children',
    'list-box',
    () => {
      const item = $item();
      $setSelection(null);
      item.replace($createListItemNode(), true);
    },
    'refused',
  ],
  [
    'remove the inline container composed in',
    'list-box',
    () => $composed().getParentOrThrow().remove(),
    'refused',
  ],
  [
    'unwrap the inline container composed in',
    'list-box',
    () => {
      const box = $composed().getParentOrThrow();
      for (const child of box.getChildren()) {
        box.insertBefore(child);
      }
      box.remove();
    },
    'refused',
  ],
  [
    'wrap the composed text in a new link inside its container',
    'list-box',
    () => {
      const n = $composed();
      const link = $createLinkNode('https://x.test');
      n.insertBefore(link);
      link.append(n);
    },
    'written',
  ],
  [
    'indent the item composed in',
    'list-box',
    () => $item().setIndent(1),
    'written',
  ],
  [
    'outdent the item composed in',
    'nested-list-box',
    () => $item().setIndent(0),
    'written',
  ],
  [
    'change the list type',
    'list-box',
    () => $firstList().setListType('bullet'),
    'written',
  ],
  [
    'move the item composed in to the other list',
    'list-box',
    () => ($getRoot().getLastChildOrThrow() as ListNode).append($item()),
    'refused',
  ],
  [
    'merge text into the composed text node',
    'list-box',
    () => {
      const n = $composed();
      const x = $createTextNode('x');
      n.insertBefore(x);
      x.getLatest().mergeWithSibling(n.getLatest());
    },
    'written',
  ],
  [
    'split the composed text node',
    'list-box',
    () => {
      $composed().splitText(2);
    },
    'written',
  ],
  [
    'move the inline container composed in to a new line after its own',
    'list-box',
    () => {
      const box = $composed().getParentOrThrow();
      $item().insertAfter($createListItemNode().append(box));
    },
    'written',
  ],
  [
    'move the inline container composed in to the end of the next line',
    'list-box',
    () => {
      const box = $composed().getParentOrThrow();
      ($item().getNextSibling() as ListItemNode).append(box);
    },
    'refused',
  ],
  [
    'move the inline container composed in into the paragraph after the list',
    'list-box',
    () => {
      const box = $composed().getParentOrThrow();
      ($item().getParentOrThrow().getNextSibling() as ElementNode).append(box);
    },
    'refused',
  ],
  [
    'swap the text nodes on both sides of the inline container composed in',
    'box-between',
    () => {
      const box = $composed().getParentOrThrow();
      const left = box.getPreviousSibling()!;
      const right = box.getNextSibling()!;
      box.insertBefore(right);
      box.insertAfter(left);
    },
    'written',
  ],
  [
    'insert a decorator next to the inline container',
    'list-box',
    () => $composed().getParentOrThrow().insertAfter($create(Chip)),
    'written',
  ],
  [
    'cut the item composed in and paste a copy into the other list',
    'list-box',
    () => {
      const text = $composed().getTextContent();
      $item().remove();
      ($getRoot().getLastChildOrThrow() as ListNode).append(
        $createListItemNode().append(
          $create(Box).append($createTextNode(text)),
        ),
      );
    },
    'refused',
  ],
  [
    'move the slot value to another slot of the host',
    'slot',
    () => $setSlot($host(), 'other', $getSlot($host(), 'title')!),
    'refused',
  ],
  [
    'remove the slot',
    'slot',
    () => {
      $setSelection(null);
      $removeSlot($host(), 'title');
    },
    'refused',
  ],
  [
    "replace the slot's value with a new paragraph of its children",
    'slot',
    () => {
      const old = $getSlot($host(), 'title') as ParagraphNode;
      $setSlot(
        $host(),
        'title',
        $createParagraphNode().append(...old.getChildren()),
      );
    },
    'refused',
  ],
  [
    'move the slot value to a new host that replaces the old one',
    'slot',
    () => {
      const host = $host();
      const next = $create(Host);
      $setSlot(next, 'title', $getSlot(host, 'title')!);
      host.replace(next);
    },
    'refused',
  ],
  [
    'move the slot host after the next paragraph',
    'slot',
    () => $getRoot().append($host()),
    'refused',
  ],
  [
    'insert a table row before the row composed in',
    'table',
    () => {
      const row = $createTableRowNode().append(
        $createTableCellNode().append($createParagraphNode()),
        $createTableCellNode().append($createParagraphNode()),
      );
      $row1().insertBefore(row);
    },
    'written',
  ],
  ['delete the row composed in', 'table', () => $row1().remove(), 'refused'],
  [
    'delete the other row',
    'table',
    () => ($table().getLastChildOrThrow() as ElementNode).remove(),
    'written',
  ],
  [
    'move the row composed in after the other row',
    'table',
    () => $table().append($row1()),
    'refused',
  ],
  [
    'insert a cell before the cell composed in',
    'table',
    () =>
      $row1()
        .getFirstChildOrThrow()
        .insertBefore($createTableCellNode().append($createParagraphNode())),
    'written',
  ],
  [
    'delete the cell composed in',
    'table',
    () => $row1().getFirstChildOrThrow().remove(),
    'refused',
  ],
  [
    'change the block type of the paragraph composed in (heading)',
    'paragraph',
    () => {
      const p = $composed().getParentOrThrow();
      p.replace($createHeadingNode('h1'), true);
    },
    'written',
  ],
  [
    'a markdown shortcut turns the paragraph composed in into a quote',
    'paragraph',
    () => {
      const p = $composed().getParentOrThrow();
      p.replace($createQuoteNode(), true);
    },
    'written',
  ],
  [
    'move the paragraph composed in after the next one',
    'paragraph',
    () => $getRoot().append($composed().getParentOrThrow()),
    'refused',
  ],
  [
    'the code highlighter re-tokenizes the composed text',
    'code',
    () => {
      const n = $composed();
      const text = n.getTextContent();
      n.replace($createCodeHighlightNode(text.slice(0, 1))).insertAfter(
        $createCodeHighlightNode(text.slice(1)),
      );
    },
    'written',
  ],
];

/** The JSON of a peer, without the fields Lexical derives as it renders. */
const shape = (p: Peer) =>
  JSON.stringify(p.json(), (k, v) =>
    k === 'textFormat' || k === 'textStyle' ? undefined : v,
  );

const allText = (p: Peer) =>
  p.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => n.getTextContent())
      .join('|'),
  );

describe('structural operations under a composer hold', () => {
  for (const [name, fixture, $op, outcome] of OPS) {
    for (const mode of ['local', 'read-edit'] as const) {
      if (mode === 'read-edit' && LOCAL_ONLY.has(name)) {
        continue;
      }
      for (const gc of [false, true]) {
        for (const ids of [
          [1, 2, 3],
          [3, 2, 1],
        ]) {
          test(`${name}: ${outcome} (${mode}, gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
            const t = await setup(FIXTURES[fixture], {
              gc,
              ids,
              nodes: [...NODES, Box, Chip, Host, Hook],
            });
            const {a, b, c} = t;
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
            a.update(() => {
              const n = $composed();
              n.select(1, 1);
              $setCompositionKey(n.getKey());
            });
            await t.sync();
            b.update(() => {
              $composed().spliceText(1, 0, 'R');
              $setSelection(null);
            });
            await t.sync();
            expect(allText(a)).not.toContain('R');
            // A's local updates that write content (derived element fields
            // aside).
            let content = 0;
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
              if (
                keys.length === 0 ||
                !keys.every(k => k === 'p:textFormat' || k === 'p:textStyle')
              ) {
                content++;
              }
            };
            a.doc.on('update', count);
            if (mode === 'local') {
              a.update($op);
            } else {
              reactions.set(a.editor, $op);
              c.update(() => {
                const after = $getRoot()
                  .getAllTextNodes()
                  .find(n => n.getTextContent() === 'after')!;
                after.spliceText(5, 0, '!');
                $setSelection(null);
              });
            }
            await t.sync();
            a.doc.off('update', count);
            if (outcome === 'refused') {
              expect(a.warnings).toHaveLength(1);
              expect(a.warnings[0]).toMatch(
                /would delete or leave behind text a collaborator wrote/,
              );
              expect(content).toBe(0);
              a.warnings.length = 0;
            } else {
              expect(a.warnings).toEqual([]);
            }
            a.update(() => $setCompositionKey(null));
            await t.sync();
            const fresh = await freshReader(a);
            onTestFinished(() => fresh.stop());
            const text = allText(fresh);
            expect(text.split('R')).toHaveLength(2);
            for (const p of t.peers) {
              expect(allText(p)).toBe(text);
              expect(shape(p)).toBe(shape(fresh));
            }
            expect(a.warnings).toEqual([]);
          });
        }
      }
    }
  }
});

class Group extends ElementNode {
  $config() {
    return this.config('audit_group', {
      children: 'block',
      extends: ElementNode,
    });
  }
  createDOM() {
    return $getDocument().createElement('div');
  }
  updateDOM() {
    return false;
  }
}

/** A composes `abc` (bold where `bold`), B unbolds it and types R, held. */
async function holding(
  init: () => void,
  bold: boolean,
  gc: boolean,
  ids: number[],
) {
  const t = await setup(init, {
    gc,
    ids,
    nodes: [...NODES, Box, Chip, Host, Hook, Group],
  });
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
  a.update(() => {
    const n = $composed();
    n.select(1, 1);
    $setCompositionKey(n.getKey());
  });
  await t.sync();
  b.update(() => {
    const n = $composed();
    if (bold) {
      n.setFormat(0);
    }
    n.spliceText(1, 0, 'R');
    $setSelection(null);
  });
  await t.sync();
  return t;
}

/** Run `$op` on A locally, or as a reaction to C's change in a read. */
async function act(
  t: Awaited<ReturnType<typeof holding>>,
  mode: 'local' | 'read-edit',
  $op: () => void,
) {
  if (mode === 'local') {
    t.a.update($op);
  } else {
    reactions.set(t.a.editor, $op);
    t.c.update(() => {
      const after = $getRoot()
        .getAllTextNodes()
        .find(n => n.getTextContent() === 'after')!;
      after.spliceText(5, 0, '!');
      $setSelection(null);
    });
  }
  await t.sync();
}

describe('the composed paragraph moved to another slot of its host, or a nested move', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const mode of ['local', 'read-edit'] as const) {
        for (const bold of [false, true]) {
          test(`moving the slot value to another slot is refused: R stays once, ${bold ? "and B's unbold is not undone" : 'plain'} (${mode}, gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
            const t = await holding(
              () =>
                $getRoot().append(
                  $setSlot(
                    $create(Host),
                    'title',
                    $createParagraphNode().append(
                      $hook().setFormat(bold ? 'bold' : 0),
                    ),
                  ),
                  $createParagraphNode().append($createTextNode('after')),
                ),
              bold,
              gc,
              ids,
            );
            await act(t, mode, () => {
              const n = $composed();
              const host = $getRoot().getFirstChildOrThrow() as Host;
              $setSlot(host, 'other', $getSlot(host, 'title')!);
              n.select(1, 1);
              $setCompositionKey(n.getKey());
            });
            expect(t.a.warnings).toHaveLength(1);
            expect(t.a.warnings[0]).toMatch(
              /would delete or leave behind text a collaborator wrote/,
            );
            t.a.warnings.length = 0;
            t.a.update(() => $setCompositionKey(null));
            await t.sync();
            const fresh = await freshReader(t.a);
            onTestFinished(() => fresh.stop());
            const nodes = (p: Peer) =>
              p.read(() =>
                $getRoot()
                  .getAllTextNodes()
                  .map(n => [n.getTextContent(), n.getFormat()]),
              );
            const want = nodes(fresh);
            for (const p of t.peers) {
              expect(nodes(p)).toEqual(want);
              expect(shape(p)).toBe(shape(fresh));
            }
            expect(
              want
                .map(([text]) => text)
                .join('')
                .split('R'),
            ).toHaveLength(2);
            expect(want.every(([, format]) => format === 0)).toBe(true);
          });
        }
        test(`moving the composed paragraph into another group is refused, and R stays once (${mode}, gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await holding(
            () =>
              $getRoot().append(
                $create(Group).append(
                  $create(Group).append($createParagraphNode().append($hook())),
                ),
                $create(Group).append(
                  $createParagraphNode().append($createTextNode('tail')),
                ),
                $createParagraphNode().append($createTextNode('after')),
              ),
            false,
            gc,
            ids,
          );
          await act(t, mode, () => {
            const n = $composed();
            const first = $getRoot().getFirstChildOrThrow() as Group;
            const target = $getRoot().getChildren()[1] as Group;
            target.append(first.getFirstChildOrThrow());
            n.select(1, 1);
            $setCompositionKey(n.getKey());
          });
          expect(t.a.warnings).toHaveLength(1);
          t.a.warnings.length = 0;
          t.a.update(() => $setCompositionKey(null));
          await t.sync();
          const fresh = await freshReader(t.a);
          onTestFinished(() => fresh.stop());
          const text = allText(fresh);
          expect(text.split('R')).toHaveLength(2);
          for (const p of t.peers) {
            expect(shape(p)).toBe(shape(fresh));
          }
        });
      }
      test(`undo and redo of a structural edit made before composing keep R once (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(FIXTURES['list-box'], {
          gc,
          ids,
          nodes: [...NODES, Box, Chip, Host, Hook],
        });
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
        a.update(() =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('new')),
          ),
        );
        await t.sync();
        a.update(() => {
          const n = $composed();
          n.select(1, 1);
          $setCompositionKey(n.getKey());
        });
        await t.sync();
        b.update(() => {
          $composed().spliceText(1, 0, 'R');
          $setSelection(null);
        });
        await t.sync();
        a.undo();
        await t.sync();
        a.binding.redo();
        await t.sync();
        a.update(() => $setCompositionKey(null));
        await t.sync();
        const fresh = await freshReader(a);
        onTestFinished(() => fresh.stop());
        const text = allText(fresh);
        expect(text.split('R')).toHaveLength(2);
        for (const p of t.peers) {
          expect(allText(p)).toBe(text);
          expect(shape(p)).toBe(shape(fresh));
        }
      });
      test(`an app's replacement of a slot's value by a new paragraph with the same children, inside a read, is refused, and the composer reads the document again (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await holding(FIXTURES.slot, false, gc, ids);
        await act(t, 'read-edit', () => {
          const host = $getRoot().getFirstChildOrThrow() as Host;
          const old = $getSlot(host, 'title') as ParagraphNode;
          $setSlot(
            host,
            'title',
            $createParagraphNode().append(...old.getChildren()),
          );
        });
        expect(t.a.warnings).toHaveLength(1);
        t.a.warnings.length = 0;
        t.a.update(() => $setCompositionKey(null));
        await t.sync();
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        expect(allText(t.a)).toBe(allText(fresh));
        expect(allText(fresh).split('R')).toHaveLength(2);
      });
    }
  }
});
