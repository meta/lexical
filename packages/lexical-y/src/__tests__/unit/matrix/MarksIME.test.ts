/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Contract for marks under an input method, over the containers text lives
// in and every mark flavor: text an input method composes over a selection
// (composition start in its own update, then the composed text written at
// the caret, then the end) gets the ids every replaced character had, and
// text outside the selection keeps its ids. Rendered (jsdom), with the core
// composition handlers.

import {buildEditorFromExtensions} from '@lexical/extension';
import {$createLinkNode} from '@lexical/link';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {$addMarkID, $getNodeMarkIDs} from '@lexical/mark';
import {
  $createHeadingNode,
  $createQuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
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
  $getSelection,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  $setSlot,
  COMPOSITION_START_COMMAND,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {CardNode} from '../../../../../lexical-playground/src/plugins/CardExtension/CardNode';
import {catalogAppExtension, CatalogCommentMarks} from '../../catalog';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    c();
  }
});

/** Containers of the text, each returning the block that holds it. */
const CONTAINERS: Record<string, (text: TextNode) => LexicalNode> = {
  'card title slot': t => {
    const card = $create(CardNode).append($createParagraphNode());
    $setSlot(card, 'title', $createParagraphNode().append(t));
    return card;
  },
  heading: t => $createHeadingNode('h2').append(t),
  link: t =>
    $createParagraphNode().append(
      $createLinkNode('https://example.com').append(t),
    ),
  'list item': t =>
    $createListNode('number', 3).append($createListItemNode().append(t)),
  paragraph: t => $createParagraphNode().append(t),
  quote: t => $createQuoteNode().append(t),
  'table cell': t =>
    $createTableNode().append(
      $createTableRowNode().append(
        $createTableCellNode().append($createParagraphNode().append(t)),
      ),
    ),
};

type Case = [string, string, [number, number], [number, number], string];
const CASES: Case[] = [
  ['the end of a run, by longer text', 'abcd', [0, 4], [2, 4], 'cde'],
  ['the end of a run followed by plain text', 'abcd xy', [0, 4], [2, 4], 'cde'],
  ['a word inside a run', 'x teh y', [0, 7], [2, 5], 'the'],
  ['text only partly in the run', 'abcd xy', [0, 4], [2, 6], 'zz'],
];

type Flavor = 'mark-state' | 'mark-flavor';

function build(flavor: Flavor): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        catalogAppExtension({blockIds: 'absent', marks: flavor}),
        RichTextExtension,
      ],
      name: `catalog-ime-marks-${flavor}`,
      onError: e => {
        throw e;
      },
    }),
  );
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  editor.setRootElement(root);
  cleanups.push(() => {
    editor.setRootElement(null);
    root.remove();
    editor.dispose();
  });
  return editor;
}

/** The document's text nodes, in order (slot values first, as stored). */
function $targetTexts(): TextNode[] {
  const out: TextNode[] = [];
  const walk = (node: LexicalNode) => {
    if ($isTextNode(node)) {
      out.push(node);
      return;
    }
    for (const name of $getSlotNames(node)) {
      const slot = $getSlot(node, name);
      if (slot !== null) {
        walk(slot);
      }
    }
    if ($isElementNode(node)) {
      node.getChildren().forEach(walk);
    }
  };
  walk($getRoot());
  return out;
}

function $locate(offset: number): [TextNode, number] {
  const texts = $targetTexts();
  let acc = 0;
  for (let i = 0; i < texts.length; i++) {
    const size = texts[i].getTextContentSize();
    if (
      offset < acc + size ||
      (offset === acc + size && i === texts.length - 1)
    ) {
      return [texts[i], offset - acc];
    }
    acc += size;
  }
  throw new Error(`offset ${offset} out of range`);
}

function $select(start: number, end: number): void {
  const [a, ao] = $locate(start);
  const [f, fo] = $locate(end);
  const s = $createRangeSelection();
  s.anchor.set(a.getKey(), ao, 'text');
  s.focus.set(f.getKey(), fo, 'text');
  $setSelection(s);
}

function $ids(flavor: Flavor, node: TextNode): string[] {
  return flavor === 'mark-flavor'
    ? $getNodeMarkIDs(CatalogCommentMarks, node)
    : $getNodeMarkIDs(node);
}

/** Per character of the target text: its ids. */
function $charIds(flavor: Flavor): string[][] {
  return $targetTexts().flatMap(t =>
    Array.from({length: t.getTextContentSize()}, () => $ids(flavor, t)),
  );
}

describe('marks under an input method: composed text gets the ids all of the replaced text had', () => {
  for (const flavor of ['mark-state', 'mark-flavor'] as Flavor[]) {
    for (const [container, $wrap] of Object.entries(CONTAINERS)) {
      for (const [label, text, [ms, me], [rs, re], composed] of CASES) {
        test(`${flavor}, ${container}: ${label}`, () => {
          const editor = build(flavor);
          const u = (fn: () => void) => editor.update(fn, {discrete: true});
          u(() => {
            $getRoot()
              .clear()
              .append($wrap($createTextNode(text)));
          });
          u(() => {
            $select(ms, me);
            const s = $getSelection()!;
            if (flavor === 'mark-flavor') {
              $addMarkID(CatalogCommentMarks, 'c1', s);
            } else {
              $addMarkID('c1', s);
            }
          });
          const before = editor.read(() => $charIds(flavor));
          u(() => $select(rs, re));
          // The composition starts in its own update, as a browser fires it.
          u(() => {
            editor.dispatchCommand(COMPOSITION_START_COMMAND, {
              data: '',
              timeStamp: Number.MAX_SAFE_INTEGER,
            } as CompositionEvent);
          });
          // The input method writes at the caret, over the placeholder.
          u(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) {
              throw new Error('no selection');
            }
            const target = selection.anchor.getNode() as TextNode;
            const content = target.getTextContent();
            let at = selection.anchor.offset;
            if (content[at] !== '\u200b' && content[at - 1] === '\u200b') {
              at--;
            }
            target.spliceText(
              at,
              content[at] === '\u200b' ? 1 : 0,
              composed,
              true,
            );
          });
          u(() => $setCompositionKey(null));
          const after = editor.read(() => $charIds(flavor));
          const afterText = editor.read(() =>
            $targetTexts()
              .map(t => t.getTextContent())
              .join(''),
          );
          const expectedText = text.slice(0, rs) + composed + text.slice(re);
          const problems: string[] = [];
          if (afterText !== expectedText) {
            problems.push(
              `text ${JSON.stringify(afterText)} != ${JSON.stringify(expectedText)}`,
            );
          } else {
            // Untouched text keeps its ids; composed text gets the ids every
            // replaced character had.
            const replaced = before.slice(rs, re);
            const common =
              replaced.length === 0
                ? []
                : replaced[0].filter(id => replaced.every(r => r.includes(id)));
            for (let i = 0; i < rs; i++) {
              if (JSON.stringify(after[i]) !== JSON.stringify(before[i])) {
                problems.push(
                  `char ${i} ids ${JSON.stringify(after[i])} != ${JSON.stringify(before[i])}`,
                );
              }
            }
            for (let i = 0; i < composed.length; i++) {
              const got = after[rs + i];
              if (!common.every(id => got.includes(id))) {
                problems.push(
                  `composed char ${i} ${JSON.stringify(composed[i])} ids ${JSON.stringify(got)}, expected ${JSON.stringify(common)}`,
                );
              }
            }
            for (let j = 1; j <= text.length - re; j++) {
              const a = before[text.length - j];
              const b = after[afterText.length - j];
              if (JSON.stringify(a) !== JSON.stringify(b)) {
                problems.push(
                  `trailing char ids ${JSON.stringify(b)} != ${JSON.stringify(a)}`,
                );
              }
            }
          }
          expect(problems).toEqual([]);
        });
      }
    }
  }
});
