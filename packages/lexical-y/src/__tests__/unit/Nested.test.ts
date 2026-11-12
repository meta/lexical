/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$toggleLink} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $insertList,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {$wrapSelectionInMarkNode, MarkNode} from '@lexical/mark';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getState,
  $isElementNode,
  $isTextNode,
  $setSelection,
  $setState,
  createState,
  type Klass,
  type LexicalNode,
  ParagraphNode,
  type TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {
  $createBoxNode,
  $createEquation,
  $p,
  BoxNode,
  ColContainerNode,
  ColContentNode,
  ColTitleNode,
  type Delivery,
  EquationNode,
  expectConverged,
  freshReader,
  setup,
} from '../utils/harness';

const $li = (text: string) =>
  $createListItemNode().append($createTextNode(text));
const $box = (tone: string, ...children: LexicalNode[]) =>
  $createBoxNode(tone).append(...children);
const $collapsible = (title: string, ...content: LexicalNode[]) =>
  $create(ColContainerNode).append(
    $create(ColTitleNode).append($createTextNode(title)),
    $create(ColContentNode).append(...content),
  );

/** The text node holding `token`, and the offset of `token` in it. */
function $findText(token: string): [TextNode, number] {
  const visit = (n: LexicalNode): [TextNode, number] | null => {
    if ($isTextNode(n)) {
      const i = n.getTextContent().indexOf(token);
      return i >= 0 ? [n, i] : null;
    }
    if ($isElementNode(n)) {
      for (const c of n.getChildren()) {
        const r = visit(c);
        if (r !== null) {
          return r;
        }
      }
    }
    return null;
  };
  const found = visit($getRoot());
  if (found === null) {
    throw new Error(`token ${token} not found`);
  }
  return found;
}

function $nearest<T extends LexicalNode>(token: string, klass: Klass<T>): T {
  let n: LexicalNode | null = $findText(token)[0];
  while (n !== null && !(n instanceof klass)) {
    n = (n as LexicalNode).getParent();
  }
  if (n === null) {
    throw new Error(`no ${klass.name} around ${token}`);
  }
  return n as T;
}

/** Collapsed selection at `offset` characters after the start of `token`. */
function $at(token: string, offset: number) {
  const [node, i] = $findText(token);
  const sel = $createRangeSelection();
  sel.anchor.set(node.getKey(), i + offset, 'text');
  sel.focus.set(node.getKey(), i + offset, 'text');
  $setSelection(sel);
  return sel;
}

function $range(token: string, from: number, to: number) {
  const [node, i] = $findText(token);
  const sel = $createRangeSelection();
  sel.anchor.set(node.getKey(), i + from, 'text');
  sel.focus.set(node.getKey(), i + to, 'text');
  $setSelection(sel);
  return sel;
}

const ORDERS: {name: string; ids: number[]; delivery: Delivery}[] = [
  {delivery: 'causal', ids: [1, 2], name: 'ids 1,2 causal'},
  {delivery: 'causal', ids: [2, 1], name: 'ids 2,1 causal'},
  {delivery: 'sender', ids: [1, 2], name: 'ids 1,2 per-sender'},
  {delivery: 'sender', ids: [2, 1, 3], name: 'three peers 2,1,3 per-sender'},
];

// Containers that wrap containers.
describe.each(ORDERS)(
  '@lexical/y nested containers, $name',
  ({ids, delivery}) => {
    const opts = {delivery, ids};

    test('collapsible: Enter mid content line ‖ type its tail', async () => {
      const t = await setup(
        () => $getRoot().append($collapsible('Title', $p('Alpha beta'))),
        opts,
      );
      t.offline();
      t.a.update(() => $at('Alpha', 5).insertParagraph());
      t.b.update(() => $at('beta', 4).insertText('!'));
      await t.sync();
      await expectConverged(
        t.peers,
        'test_col(test_col_title("Title") test_col_content(paragraph("Alpha") paragraph(" beta!")))',
      );
    });

    test('collapsible: content line -> heading ‖ type in it', async () => {
      const t = await setup(
        () => $getRoot().append($collapsible('Title', $p('Alpha beta'))),
        opts,
      );
      t.offline();
      t.a.update(() =>
        $setBlocksType($at('Alpha', 0), () => $createHeadingNode('h2')),
      );
      t.b.update(() => $at('beta', 4).insertText('!'));
      await t.sync();
      await expectConverged(
        t.peers,
        'test_col(test_col_title("Title") test_col_content(heading[h2]("Alpha beta!")))',
      );
    });

    test('collapsible: content line -> list ‖ type, title typing ‖ quote', async () => {
      const t = await setup(
        () =>
          $getRoot().append($collapsible('Title', $p('Alpha'), $p('Gamma'))),
        opts,
      );
      t.offline();
      t.a.update(() => {
        $at('Alpha', 0);
        $insertList('bullet');
      });
      t.a.update(() => $at('Title', 5).insertText('!'));
      t.b.update(() => $at('Alpha', 5).insertText('X'));
      t.b.update(() =>
        $setBlocksType($at('Gamma', 0), () => $createQuoteNode()),
      );
      await t.sync();
      await expectConverged(
        t.peers,
        'test_col(test_col_title("Title!") test_col_content(list[bullet](listitem("AlphaX")) quote("Gamma")))',
      );
    });

    test('collapsible in a table cell in a collapsible: Enter ‖ type ‖ type outer', async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $collapsible(
              'Outer',
              $createTableNode().append(
                $createTableRowNode().append(
                  $createTableCellNode().append(
                    $collapsible('Inner', $p('Deep line here')),
                  ),
                ),
              ),
              $p('Outer line'),
            ),
          ),
        opts,
      );
      t.offline();
      t.a.update(() => $at('Deep', 4).insertParagraph());
      t.b.update(() => $at('here', 4).insertText('!'));
      t.b.update(() => $at('Outer line', 10).insertText('?'));
      await t.sync();
      await expectConverged(
        t.peers,
        'test_col(test_col_title("Outer") test_col_content(table(tablerow(tablecell(test_col(test_col_title("Inner") test_col_content(paragraph("Deep") paragraph(" line here!")))))) paragraph("Outer line?")))',
      );
    });

    test('box > box: Enter in inner ‖ type tail; tone outer ‖ tone inner', async () => {
      const t = await setup(
        () => $getRoot().append($box('o', $box('i', $p('Inner text')))),
        opts,
      );
      t.offline();
      t.a.update(() => $at('Inner', 5).insertParagraph());
      t.a.update(() =>
        $assertNodeType(
          $nearest('Inner', BoxNode).getParentOrThrow(),
          (node): node is BoxNode => node instanceof BoxNode,
        ).setTone('O2'),
      );
      t.b.update(() => $at('text', 4).insertText('!'));
      t.b.update(() => $nearest('Inner', BoxNode).setTone('I2'));
      await t.sync();
      await expectConverged(
        t.peers,
        'test_box[O2](test_box[I2](paragraph("Inner") paragraph(" text!")))',
      );
    });

    test('box with one empty line: both type', async () => {
      const t = await setup(
        () => $getRoot().append($box('o', $createParagraphNode()), $p('after')),
        opts,
      );
      t.offline();
      t.a.update(() =>
        $assertNodeType(
          (
            $nearest('after', ParagraphNode).getPreviousSibling() as BoxNode
          ).getFirstChildOrThrow(),
          $isElementNode,
        )
          .selectStart()
          .insertText('A'),
      );
      t.b.update(() =>
        $assertNodeType(
          (
            $nearest('after', ParagraphNode).getPreviousSibling() as BoxNode
          ).getFirstChildOrThrow(),
          $isElementNode,
        )
          .selectStart()
          .insertText('B'),
      );
      await t.sync();
      await expectConverged(t.peers);
      const text = t.a.read(() => $getRoot().getTextContent());
      expect(text.includes('A') && text.includes('B')).toBe(true);
      expect(text.split('A').length).toBe(2);
    });

    test('six-level list in a collapsible: outdent ‖ type ‖ indent sibling', async () => {
      const t = await setup(() => {
        let inner: ListNode = $createListNode('bullet').append(
          $li('L5 a'),
          $li('L5 b'),
        );
        for (let level = 4; level >= 0; level--) {
          inner = $createListNode('bullet').append(
            $li(`L${level}`),
            $createListItemNode().append(inner),
          );
        }
        $getRoot().append($collapsible('T', inner));
      }, opts);
      t.offline();
      t.a.update(() => $nearest('L5 a', ListItemNode).setIndent(3));
      t.b.update(() => $at('L5 a', 4).insertText('!'));
      t.b.update(() => $nearest('L5 b', ListItemNode).setIndent(6));
      await t.sync();
      await expectConverged(t.peers);
      expect(
        t.a.read(() => $getRoot().getTextContent()).includes('L5 a!'),
      ).toBe(true);
    });
  },
);

// Mixed inline and block content, emptied containers, list numbering.
describe('@lexical/y mixed content', () => {
  test('a quote holding text then a list: readers see the writer tree', async () => {
    const t = await setup(() => $getRoot().append($p('before')));
    t.a.update(() =>
      $getRoot().append(
        $createQuoteNode().append(
          $createTextNode('QTEXT'),
          new ListNode('bullet', 1).append($li('QLI')),
        ),
      ),
    );
    await t.sync();
    await expectConverged(
      t.peers,
      // The quote holds inline content: the list is lifted out of it.
      'paragraph("before") / quote("QTEXT") / list[bullet](listitem("QLI"))',
    );
  });

  test('a container holding [p, text, p]: readers see the writer tree', async () => {
    const t = await setup(() => $getRoot().append($p('before')));
    t.a.update(() =>
      $getRoot().append(
        $box('x', $p('LINEONE'), $createTextNode('LOOSE'), $p('LINETWO')),
      ),
    );
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("before") / test_box[x](paragraph("LINEONE") "LOOSE" paragraph("LINETWO"))',
    );
  });

  test('a list item holding text then a nested list', async () => {
    const t = await setup(() => $getRoot().append($p('before')));
    t.a.update(() => {
      const item = new ListItemNode();
      item.append(
        $createTextNode('PARENT'),
        new ListNode('bullet', 1).append($li('CHILD')),
      );
      $getRoot().append(new ListNode('bullet', 1).append(item));
    });
    await t.sync();
    await expectConverged(t.peers);
  });

  test('a container emptied while a peer types: text lands in a paragraph', async () => {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      const t = await setup(
        () =>
          $getRoot().append(
            $box('outer', $box('inner', $p('INONE one'), $p('INTWO two'))),
            $p('after'),
          ),
        {ids},
      );
      t.offline();
      t.a.update(() => $nearest('INONE', BoxNode).clear());
      t.b.update(() => $at('INTWO', 5).insertText('zqb'));
      await t.sync();
      await expectConverged(t.peers);
      const inner = t.a.read(() =>
        (($getRoot().getFirstChild() as BoxNode).getFirstChild() as BoxNode)
          .getChildren()
          .map(c => c.getType()),
      );
      expect(inner.every(type => type !== 'text')).toBe(true);
    }
  });

  test('a merged list holding a block item: same item values everywhere', async () => {
    const t = await setup(() =>
      $getRoot().append(
        new ListNode('number', 1).append($li('FIRST a')),
        $p('BETWEEN'),
        new ListNode('number', 1).append(
          new ListItemNode().append($box('b', $p('BOXED'))),
          $li('LAST z'),
        ),
      ),
    );
    t.a.update(() => $nearest('BETWEEN', ParagraphNode).remove());
    await t.sync();
    const values = (p: typeof t.a) =>
      p.read(() =>
        ($getRoot().getFirstChild() as ListNode)
          .getChildren()
          .map(c => (c as ListItemNode).getValue()),
      );
    await expectConverged(t.peers);
    expect(values(t.b)).toEqual(values(t.a));
    expect(values(await freshReader(t.a))).toEqual(values(t.a));
  });
});

// Content inside inline elements.
describe('@lexical/y inline elements', () => {
  const $markOf = (ids: string[], ...children: LexicalNode[]) =>
    new MarkNode(ids).append(...children);

  test('a keystroke inside a mark keeps a link and an equation inside it', async () => {
    const t = await setup(() => {
      const link = $createTextNode('linked');
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('x '),
          $markOf(
            ['c0'],
            $createTextNode('see '),
            $createEquation('E=mc2'),
            $createTextNode(' now '),
            link,
          ),
          $createTextNode(' y'),
        ),
      );
      $range('linked', 0, 6);
      $toggleLink('https://l');
    });
    t.a.update(() => $at('see', 2).insertText('Q'));
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("x " mark<c0>("seQe " eq[E=mc2] " now " link<https://l>("linked")) " y")',
    );
  });

  test('nested marks: a keystroke in the outer mark keeps the inner one', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createParagraphNode().append(
          $markOf(
            ['c0'],
            $createTextNode('ma'),
            $markOf(['c1'], $createTextNode('rked')),
            $createTextNode(' words'),
          ),
        ),
      ),
    );
    t.a.update(() => $at('words', 2).insertText('Q'));
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph(mark<c0>("ma" mark<c1>("rked") " woQrds"))',
    );
  });

  test('typing ‖ adding a second comment inside a mark loses no text', async () => {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('Revenue '),
              $markOf(['c1'], $createTextNode('grew 4%')),
              $createTextNode(' in Q3.'),
            ),
          ),
        {ids},
      );
      t.offline();
      t.a.update(() => $at('grew', 4).insertText(' by'));
      t.b.update(() =>
        $wrapSelectionInMarkNode($range('grew', 0, 7), false, 'c2'),
      );
      await t.sync();
      await expectConverged(t.peers);
      const text = t.a.read(() => $getRoot().getTextContent());
      expect(text.includes(' by')).toBe(true);
      expect(text.replace(' by', '')).toBe('Revenue grew 4% in Q3.');
    }
  });

  test('comment state on text survives a concurrent link wrap of part of it', async () => {
    const comments = createState('comments', {
      parse: v => (typeof v === 'string' ? v : ''),
    });
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      const t = await setup(
        () => {
          const text = $createTextNode('Revenue grew 4% in Q3.');
          $setState(text, comments, 'c1');
          $getRoot().append($createParagraphNode().append(text));
        },
        {ids},
      );
      t.offline();
      t.a.update(() => {
        $range('grew', 0, 4);
        $toggleLink('https://x');
      });
      t.b.update(() => $at('Q3', 2).insertText('!'));
      await t.sync();
      await expectConverged(t.peers);
      const states = t.a.read(() =>
        $getRoot()
          .getAllTextNodes()
          .map(n => [n.getTextContent(), $getState(n, comments)]),
      );
      expect(states.every(([, s]) => s === 'c1')).toBe(true);
      expect(states.map(([s]) => s).join('')).toBe(
        'Revenue grew 4% in Q3!.'.replace('Q3!.', 'Q3!.'),
      );
    }
  });

  test('an equation at line end: Enter after it ‖ edit the equation', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('x '),
          $createEquation('a'),
        ),
      ),
    );
    t.offline();
    t.a.update(() =>
      $assertNodeType($getRoot().getFirstChildOrThrow(), $isElementNode)
        .selectEnd()
        .insertParagraph(),
    );
    t.b.update(() => {
      const eq = $assertNodeType(
        $assertNodeType(
          $getRoot().getFirstChildOrThrow(),
          $isElementNode,
        ).getLastChildOrThrow(),
        (node): node is EquationNode => node instanceof EquationNode,
      );
      eq.getWritable().__equation = 'b';
    });
    await t.sync();
    await expectConverged(t.peers, 'paragraph("x " eq[b]) / paragraph()');
  });
});
