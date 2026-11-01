/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {$toggleLink} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $insertList,
  ListExtension,
  type ListItemNode,
} from '@lexical/list';
import {
  $addMarkID,
  $getNodeMarkIDs,
  $wrapSelectionInMarkNode,
} from '@lexical/mark';
import {
  $createHeadingNode,
  $createQuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createTableNodeWithDimensions,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $mergeCells,
  type TableCellNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {YCollabExtension} from '../..';
import {createYDoc, seedYState} from '../../headless';
import {
  $block,
  $createBoxNode,
  $p,
  $selectIn,
  type Delivery,
  describeNode,
  expectConverged,
  type Peer,
  type Setup,
  setup,
} from '../utils/harness';
import {prepareMarkState} from '../utils/sizeOps';

// Concurrent edits racing typing or each other, run
// headless: A and B edit offline, C is a third peer, then all sync. Both id
// orders, causal and per-sender delivery.

const P = 'Revenue grew 4% in Q3.';
const $li = (text: string) =>
  $createListItemNode().append($createTextNode(text));
const $initPara = () => $getRoot().append($p(P));
const $initLinked = () => {
  $initPara();
  $selectIn([0], 8, 15);
  $toggleLink('https://x');
};
const $initList = () =>
  $getRoot().append(
    $createListNode('bullet').append($li('one'), $li('two'), $li('three')),
  );
const $initTable = () => {
  $getRoot().append($createTableNodeWithDimensions(3, 3, false));
  $getRoot().append($createParagraphNode());
};
function $cell(r: number, c: number): ElementNode {
  const t = $getRoot().getChildren().find($isTableNode)!;
  return (t.getChildAtIndex(r) as ElementNode).getChildAtIndex(
    c,
  ) as ElementNode;
}
function $typeInCell(r: number, c: number, text: string) {
  ($cell(r, c).getFirstChild() as ElementNode).selectEnd().insertText(text);
}
function tableText(peer: Peer): string {
  return peer.read(() => {
    const parts: string[] = [];
    for (const n of $getRoot().getChildren()) {
      if ($isTableNode(n)) {
        parts.push(
          'table' +
            JSON.stringify(
              n
                .getChildren()
                .filter($isTableRowNode)
                .map(r =>
                  r
                    .getChildren()
                    .filter($isTableCellNode)
                    .map((cell: LexicalNode) => cell.getTextContent()),
                ),
            ),
        );
      } else {
        parts.push(describeNode(n));
      }
    }
    return parts.join(' / ');
  });
}

type Case = {
  id: string;
  init: () => void;
  a?: () => void;
  b?: () => void;
  run?: (t: Setup) => Promise<void>;
  expected: string | ((t: Setup) => void);
  /** A documented limit: converges without loss, intent not kept. */
  limit?: string;
};

const CASES: Case[] = [
  {
    a: () => $selectIn([0], 13).insertText('by '),
    b: () => {
      $selectIn([0], 8, 15);
      $toggleLink('https://x');
    },
    expected: 'paragraph("Revenue " link<https://x>("grew by 4%") " in Q3.")',
    id: 'link ‖ type inside it',
    init: $initPara,
  },
  {
    a: () => $selectIn([0], 13).insertText('by '),
    b: () => {
      $selectIn([0], 8, 15);
      $toggleLink(null);
    },
    expected: 'paragraph("Revenue grew by 4% in Q3.")',
    id: 'unlink ‖ type',
    init: $initLinked,
  },
  {
    a: () => $selectIn([0], 19).insertText('ZZ'),
    b: () => {
      $selectIn([0], 8, 15);
      $toggleLink('https://x');
    },
    expected: 'paragraph("Revenue " link<https://x>("grew 4%") " in ZZQ3.")',
    id: 'link ‖ type after it',
    init: $initPara,
  },
  {
    expected: 'paragraph("Revenue grew by 4% in Q3.")',
    id: 'undo link after a peer typed in it',
    init: $initPara,
    run: async t => {
      t.a.update(() => {
        $selectIn([0], 8, 15);
        $toggleLink('https://x');
      });
      await t.sync();
      t.b.update(() => $selectIn([0], 13).insertText('by '));
      await t.sync();
      t.a.undo();
      await t.sync();
    },
  },
  {
    a: () => $selectIn([0], 8, 15).formatText('bold'),
    b: () => $selectIn([0], 11, 19).formatText('italic'),
    expected: 'paragraph("Revenue " "gre"{1} "w 4%"{3} " in "{2} "Q3.")',
    id: 'bold ‖ italic overlap',
    init: $initPara,
  },
  {
    a: () => $selectIn([0], 13).insertText('by '),
    b: () => $setBlocksType($selectIn([0], 0), () => $createHeadingNode('h1')),
    expected: 'heading[h1]("Revenue grew by 4% in Q3.")',
    id: 'heading ‖ type',
    init: $initPara,
  },
  {
    a: () => $selectIn([0], 13).insertText('by '),
    b: () => $setBlocksType($selectIn([0], 0), () => $createQuoteNode()),
    expected: 'quote("Revenue grew by 4% in Q3.")',
    id: 'quote ‖ type',
    init: $initPara,
  },
  {
    a: () => $selectIn([0], 8).insertParagraph(),
    b: () => $selectIn([0], 13).insertText('by '),
    expected: 'paragraph("Revenue ") / paragraph("grew by 4% in Q3.")',
    id: 'Enter ‖ type in the tail',
    init: $initPara,
  },
  {
    a: () => $selectIn([1], 0).deleteCharacter(true),
    b: () => $selectIn([1], 7).insertText('really '),
    expected: 'paragraph("Revenue grew 4% in Q3.Second really line.")',
    id: 'Backspace join ‖ type in the second line',
    init: () => $getRoot().append($p(P), $p('Second line.')),
  },
  {
    a: () => {
      $selectIn([0, 1], 3);
      ($block([0, 1]) as ListItemNode).setIndent(1);
    },
    b: () => $selectIn([0, 1], 3).insertText('X'),
    expected:
      'list[bullet](listitem("one") listitem(list[bullet](listitem("twoX"))) listitem("three"))',
    id: 'list indent ‖ type',
    init: $initList,
  },
  {
    a: () => {
      $selectIn([0, 1], 1);
      $insertList('number');
    },
    b: () => $selectIn([0, 1], 3).insertText('X'),
    expected:
      'list[number](listitem("one") listitem("twoX") listitem("three"))',
    id: 'list type ‖ type',
    init: $initList,
  },
  {
    a: () => {
      $selectIn([0, 0, 0, 0], 1);
      $insertList('bullet');
    },
    b: () => $selectIn([0, 0, 0, 0], 3).insertText('X'),
    expected: 'table(tablerow(tablecell(list[bullet](listitem("twoX")))))',
    id: 'list in a table cell ‖ type',
    init: () => {
      const table = $createTableNodeWithDimensions(1, 1, false);
      $getRoot().append(table);
      const cell = $block([0, 0, 0]);
      cell.clear();
      cell.append($p('two'));
    },
  },
  {
    a: () => {
      $selectIn([0, 0], 1);
      $insertList('bullet');
    },
    b: () => $selectIn([0, 0], 3).insertText('X'),
    expected: 'list[bullet](listitem("two"))',
    // Documented (Moves): Lexical replaces the container with the list, a
    // move, so the typing is lost.
    id: 'list in a container that is not a shadow root ‖ type',
    init: () => $getRoot().append($createBoxNode('b').append($p('two'))),
  },
  {
    // Documented (Undo): the undo restores the old block, and the edit of
    // the new block stays next to it.
    expected: 'paragraph("Revenue grew 4% in Q3.by ")',
    id: 'undo of a block replacement after a collaborator edits the new block',
    init: $initPara,
    run: async t => {
      t.a.update(() => $block([0]).replace($p(P)));
      await t.sync();
      t.b.update(() => $selectIn([0], 13).insertText('by '));
      await t.sync();
      t.a.undo();
      await t.sync();
    },
  },
  {
    // Documented (Undo): `replace(node, true)`, which `$setBlocksType`
    // uses, keeps the block's children, so undoing it after a collaborator
    // typed in the block keeps their text once.
    expected: 'paragraph("Revenue grew by 4% in Q3.")',
    id: 'undo of $setBlocksType after a collaborator edits the block',
    init: $initPara,
    run: async t => {
      t.a.update(() => {
        $setBlocksType($selectIn([0], 0), () => $createHeadingNode('h1'));
      });
      await t.sync();
      t.b.update(() => $selectIn([0], 13).insertText('by '));
      await t.sync();
      t.a.undo();
      await t.sync();
    },
  },
  {
    a: () => $block([0]).insertAfter($p('New.')),
    b: () => $selectIn([1], 0).deleteCharacter(true),
    expected: 'paragraph("Revenue grew 4%New.") / paragraph(" in Q3.")',
    // Documented (Other races): the line before joins the inserted block,
    // and the line after stays apart.
    id: 'block inserted at a join ‖ Backspace join',
    init: () => $getRoot().append($p('Revenue grew 4%'), $p(' in Q3.')),
  },
  {
    a: () => $block([0]).insertAfter($p('New.')),
    b: () => $selectIn([1], 0).deleteCharacter(true),
    expected: 'paragraph("Revenue grew 4%New.") / heading[h1](" in Q3.")',
    // Documented (Other races): after a Backspace, the line after takes the
    // type of the line before.
    id: 'block inserted at a join ‖ Backspace join of a heading and a paragraph',
    init: () =>
      $getRoot().append(
        $createHeadingNode('h1').append($createTextNode('Revenue grew 4%')),
        $p(' in Q3.'),
      ),
  },
  {
    expected: 'paragraph("Revenue grew 4%New.") / heading[h2](" in Q3.")',
    // Documented (Other races): undoing a split keeps the type of the line
    // after (here a heading a collaborator made it).
    id: 'block inserted at a join ‖ undo of a split, the line after a heading',
    init: $initPara,
    run: async t => {
      t.a.update(() => void $selectIn([0], 15).insertParagraph());
      await t.sync();
      t.b.update(() => {
        $setBlocksType($selectIn([1], 0), () => $createHeadingNode('h2'));
      });
      await t.sync();
      t.offline();
      t.a.undo();
      t.b.update(() => $block([0]).insertAfter($p('New.')));
      await t.sync();
    },
  },
  {
    a: () => $selectIn([0], 8, 15).formatText('bold'),
    b: () => $selectIn([0], 10).insertText('X'),
    // Documented (Other races): text typed inside a range formatted at the
    // same time takes the format.
    expected: 'paragraph("Revenue " "grXew 4%"{1} " in Q3.")',
    id: 'format ‖ type inside its range',
    init: $initPara,
  },
  {
    a: () => {
      const row = $block([0, 0]);
      $mergeCells([
        row.getChildAtIndex(0) as TableCellNode,
        row.getChildAtIndex(1) as TableCellNode,
      ]);
    },
    b: () => $selectIn([0, 0, 1, 0], 5).insertText('X'),
    // Documented (Moves): merging cells moves the content of the merged-away
    // cell, so the typing in it is lost.
    expected:
      'table(tablerow(tablecell(paragraph("left") paragraph("right"))))',
    id: 'merge cells ‖ type in the cell merged away',
    init: () => {
      const table = $createTableNodeWithDimensions(1, 2, false);
      $getRoot().append(table);
      $block([0, 0, 0]).clear().append($p('left'));
      $block([0, 0, 1]).clear().append($p('right'));
    },
  },
  {
    // Documented (Moves, Undo): the box keeps the moved paragraph once B
    // typed in it, and the undo restores the paragraph next to it.
    expected:
      'test_box[b](paragraph("movedX para")) / paragraph("moved para") / paragraph("end")',
    id: 'undo of a box wrap after a collaborator types in the wrapped block',
    init: () => $getRoot().append($p('moved para'), $p('end')),
    run: async t => {
      t.a.update(() => {
        const box = $createBoxNode('b');
        $block([0]).insertBefore(box);
        box.append($block([1]));
      });
      await t.sync();
      t.b.update(() => $selectIn([0, 0], 5).insertText('X'));
      await t.sync();
      t.a.undo();
      await t.sync();
    },
  },
  {
    a: () => $selectIn([0, 1], 1).insertParagraph(),
    b: () => $selectIn([0, 1], 3).insertText('X'),
    expected:
      'list[bullet](listitem("one") listitem("t") listitem("woX") listitem("three"))',
    id: 'Enter in a list item ‖ type',
    init: $initList,
  },
  {
    a: () => $selectIn([0], 13).insertText('by '),
    b: () => $block([1]).insertAfter($block([0])),
    expected: 'paragraph("Second.") / paragraph("Revenue grew by 4% in Q3.")',
    id: 'move ‖ type',
    init: () => $getRoot().append($p(P), $p('Second.')),
    limit: 'a move is a delete and reinsert: the typing lands in a neighbour',
  },
  {
    a: () => $block([2]).insertAfter($block([0])),
    b: () => $block([0]).insertBefore($block([2])),
    expected: t => {
      const parts = t.a.describe().split(' / ').sort();
      expect(parts).toEqual([
        'paragraph("one")',
        'paragraph("three")',
        'paragraph("two")',
      ]);
    },
    id: 'move ‖ move',
    init: () => $getRoot().append($p('one'), $p('two'), $p('three')),
  },
  {
    expected: t =>
      expect(tableText(t.a)).toBe(
        'table[["","",""],["","x",""],["","",""],["","",""],["","","y"]] / paragraph()',
      ),
    id: 'rows inserted, then typing in cells',
    init: $initTable,
    run: async t => {
      for (let i = 0; i < 2; i++) {
        t.a.update(() => {
          ($cell(0, 0).getFirstChild() as ElementNode).selectEnd();
          $insertTableRowAtSelection(true);
        });
        await t.sync();
      }
      t.b.update(() => $typeInCell(1, 1, 'x'));
      await t.sync();
      t.b.update(() => $typeInCell(4, 2, 'y'));
      await t.sync();
    },
  },
  {
    a: () => {
      $typeInCell(0, 0, 'a');
      $typeInCell(1, 1, 'c');
    },
    b: () => {
      $typeInCell(0, 1, 'b');
      $typeInCell(1, 1, 'd');
    },
    expected: t =>
      expect([
        'table[["a","b",""],["","cd",""],["","",""]] / paragraph()',
        'table[["a","b",""],["","dc",""],["","",""]] / paragraph()',
      ]).toContain(tableText(t.a)),
    id: 'typing in cells ‖ typing in cells',
    init: $initTable,
  },
  {
    a: () => {
      ($cell(0, 0).getFirstChild() as ElementNode).selectEnd();
      $insertTableRowAtSelection(true);
    },
    b: () => {
      ($cell(0, 1).getFirstChild() as ElementNode).selectEnd();
      $insertTableColumnAtSelection(true);
    },
    // Shown as stored: the inserted row lacks the inserted column, until
    // the next table command pads it.
    expected: t =>
      expect(tableText(t.a)).toBe(
        'table[["","","",""],["","",""],["","","",""],["","","",""]] / paragraph()',
      ),
    id: 'row insert ‖ column insert',
    init: $initTable,
  },
  {
    a: () => $selectIn([0], 13).insertText('by '),
    b: () => $wrapSelectionInMarkNode($selectIn([0], 8, 15), false, 'c1'),
    expected: 'paragraph("Revenue " mark<c1>("grew by 4%") " in Q3.")',
    id: 'MarkNode comment ‖ type',
    init: $initPara,
    limit:
      'MarkNode is an inline element with its own content: wrapping moves the text into it',
  },
];

const ORDERS: {name: string; ids: number[]; delivery: Delivery}[] = [
  {delivery: 'causal', ids: [1, 2, 3], name: 'A=1 B=2 causal'},
  {delivery: 'causal', ids: [2, 1, 3], name: 'A=2 B=1 causal'},
  {delivery: 'sender', ids: [1, 2, 3], name: 'A=1 B=2 per-sender'},
  {delivery: 'sender', ids: [2, 1, 3], name: 'A=2 B=1 per-sender'},
];

describe.each(ORDERS)('@lexical/y races, $name', ({ids, delivery}) => {
  for (const k of CASES) {
    test(k.id, async () => {
      const t = await setup(k.init, {delivery, ids});
      if (k.run) {
        await k.run(t);
      } else {
        t.offline();
        t.a.update(k.a!);
        t.b.update(k.b!);
        await t.sync();
      }
      await expectConverged(t.peers);
      if (k.limit !== undefined) {
        // Documented limit: record it, require only convergence.
        return;
      }
      if (typeof k.expected === 'string') {
        expect(t.a.describe()).toBe(k.expected);
      } else {
        k.expected(t);
      }
    });
  }
});

// AUDIT-U1: an undo of a format while a collaborator's plain text inside its
// range restored that format after itself (y.md Limits, Undo). Arriving as
// the undo is made, the restore keeps the format on the text after the
// typing: the undoing client cannot see it. Seen before the undo, the
// undoing client holds the restore and can end the value past it.
describe('@lexical/y undo of a format ‖ plain text typed inside its range', () => {
  const $init = () => $getRoot().append($p('one two'), $p('tail'));
  const bold = (t: Setup) => {
    t.a.update(() => void $selectIn([0], 0, 7).formatText('bold'));
  };
  const typePlain = (t: Setup) => {
    t.b.update(() => {
      const selection = $selectIn([0], 3);
      selection.format = 0;
      selection.insertText(' mid');
    });
  };
  for (const ids of [
    [1, 2, 3],
    [2, 1, 3],
  ]) {
    test(`AUDIT-U1 arriving as the undo is made: the text after the typing keeps the format (${ids})`, async () => {
      const t = await setup($init, {ids});
      bold(t);
      await t.sync();
      t.offline();
      typePlain(t);
      t.a.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toBe(
        'paragraph("one mid" " two"{1}) / paragraph("tail")',
      );
    });
    test(`AUDIT-U1 seen before the undo: the text after the typing keeps the format (${ids})`, async () => {
      // The documented result today (y.md Limits, Undo); the test.fails
      // below flags the fix.
      const t = await setup($init, {ids});
      bold(t);
      await t.sync();
      typePlain(t);
      await t.sync();
      t.a.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toBe(
        'paragraph("one mid" " two"{1}) / paragraph("tail")',
      );
    });
    test.fails(
      `AUDIT-U1 seen before the undo: the undo removes the format everywhere (${ids})`,
      async () => {
        const t = await setup($init, {ids});
        bold(t);
        await t.sync();
        typePlain(t);
        await t.sync();
        t.a.undo();
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.describe()).toBe(
          'paragraph("one mid two") / paragraph("tail")',
        );
      },
    );
  }
});

// #9575: writes inside a comment undone (here two collaborators', three
// writes) while another client deletes text across the comment's end. Each
// write ended the comment before its text and restored it after, leaving a
// null of its writer right after the comment's end. The delete's collapse of
// the deleted run kept those nulls but not the comment's own end, and the
// undos then removed them, so the comment ran on; a delete now keeps every
// format item it leaves (D86), so the comment's end stays.
describe('@lexical/y undo of writes inside a comment ‖ delete across its end', () => {
  /** Inserts uncommented `text` in the first line right after `prefix`. */
  function typeAfter(peer: Peer, prefix: string, text: string) {
    peer.update(() => {
      let off = $block([0]).getTextContent().indexOf(prefix) + prefix.length;
      for (const node of $block([0]).getAllTextNodes() as TextNode[]) {
        if (off > 0 && off < node.getTextContentSize()) {
          const [, tail] = node.splitText(off);
          tail.insertBefore($createTextNode(text));
          return;
        }
        off -= node.getTextContentSize();
      }
      throw new Error(`no "${prefix}" inside a text node`);
    });
  }
  function words(peer: Peer, line: number): string {
    return peer.read(() =>
      ($block([line]).getAllTextNodes() as TextNode[])
        .map(
          n =>
            n.getTextContent() + ($getNodeMarkIDs(n).length > 0 ? '[c1]' : ''),
        )
        .join('|'),
    );
  }
  async function run(ids: number[]): Promise<[string, string]> {
    const t = await setup(
      () => $getRoot().append($p('aa Kilometer bb cc dd'), $p('tail line')),
      {ids, prepare: prepareMarkState},
    );
    const [a, b, c, d] = t.peers;
    a.update(() => void $addMarkID('c1', $selectIn([0], 3, 12)));
    await t.sync();
    typeAfter(b, 'K', 'Z');
    await t.sync();
    typeAfter(c, 'KZil', 'X');
    typeAfter(c, 'KZilXome', 'Y');
    await t.sync();
    expect(words(a, 0)).toBe(
      'aa |K[c1]|Z|il[c1]|X|ome[c1]|Y|ter[c1]| bb cc dd',
    );
    t.offline();
    b.undo();
    c.undo();
    c.undo();
    // D, which has not seen the undos, deletes "ter" and then " bb".
    for (const text of ['ter', ' bb']) {
      d.update(() => {
        const at = $block([0]).getTextContent().indexOf(text);
        $selectIn([0], at, at + text.length).removeText();
      });
    }
    await t.sync();
    await expectConverged(t.peers);
    return [words(a, 0), words(a, 1)];
  }
  for (const ids of [
    [1, 2, 3, 4],
    [4, 3, 2, 1],
  ]) {
    test(`#9575: the comment ends where it ended (${ids})`, async () => {
      expect(await run(ids)).toEqual(['aa |Kilome[c1]| cc dd', 'tail line']);
    });
  }
});

// #9591: nested lists of the same type in adjacent list items are stored as
// one list (y.md, Adjacent equal links merge), so a bound editor merges a
// nested list turned into that type into the previous item's nested list,
// where an editor without collaboration keeps them apart.
test.fails(
  '#9591: $insertList gives the same result in a bound editor as in an unbound one',
  async () => {
    const extensions = [RichTextExtension, ListExtension];
    const config = {extensions, onWarn: () => {}, schemaVersion: 1};
    // A number list whose item holds only a check list (start 99) holding an
    // item with only a number list (start 0, one empty item) and an item with
    // only a bullet list (start 99, the item "t5043z").
    const $build = () => {
      const inner1 = $createListNode('number', 0).append($createListItemNode());
      const inner2 = $createListNode('bullet', 99).append(
        $createListItemNode().append($createTextNode('t5043z')),
      );
      const check = $createListNode('check', 99).append(
        $createListItemNode().append(inner1),
        $createListItemNode().append(inner2),
      );
      $getRoot()
        .clear()
        .append(
          $createListNode('number', 1).append(
            $createListItemNode().append(check),
          ),
        );
    };
    const json = (editor: LexicalEditor) =>
      JSON.stringify(editor.getEditorState().toJSON(), (k, v) =>
        k === '$' ? undefined : v,
      );
    const doc = createYDoc(seedYState(config, $build));
    const bound = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [
          ...extensions,
          configExtension(YCollabExtension, {doc, schemaVersion: 1}),
        ],
        name: 'bound',
      }),
    );
    const unbound = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: $build,
        dependencies: extensions,
        name: 'unbound',
      }),
    );
    await Promise.resolve();
    expect(json(bound)).toBe(json(unbound));
    for (const editor of [bound, unbound]) {
      editor.update(
        () => {
          const t = $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent() === 't5043z')!;
          t.select(6, 6);
          $insertList('number');
        },
        {discrete: true},
      );
    }
    await Promise.resolve();
    expect(json(bound)).toBe(json(unbound));
  },
);
