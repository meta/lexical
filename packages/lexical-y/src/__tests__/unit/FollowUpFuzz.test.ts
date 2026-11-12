/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Random follow-ups (updates tagged as BlockIdExtension's naming, which every
// client makes and the binding may not insert for) across node kinds and
// fields: element fields and text fields, NodeState, text typed, deleted and
// formatted, nodes removed, moved, emptied and added, in lines with and
// without a marker, a quote holding a raw run, list items and their wrappers,
// table cells and a callout. Whatever the writer does with each, the author
// shows what a fresh reader of the document shows right after it (the
// follow-up check, see YBinding#$checkFollowUp), and every peer converges.

import {blockIdState} from '@lexical/extension';
import {$createLinkNode} from '@lexical/link';
import {$createListItemNode, $createListNode, $isListNode} from '@lexical/list';
import {$createQuoteNode} from '@lexical/rich-text';
import {$createTableNodeWithDimensions} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isRootNode,
  $isTextNode,
  $setSelection,
  $setState,
  type ElementFormatType,
  type ElementNode,
  type LexicalNode,
  type TextFormatType,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $createBoxNode,
  freshReader,
  type Peer,
  setup,
} from '../utils/harness';

const json = (p: Peer) => JSON.stringify(p.editor.getEditorState().toJSON());

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function $all(): LexicalNode[] {
  const out: LexicalNode[] = [];
  const visit = (n: LexicalNode) => {
    out.push(n);
    if ($isElementNode(n)) {
      for (const c of n.getChildren()) {
        visit(c);
      }
    }
  };
  visit($getRoot());
  return out.filter(n => !$isRootNode(n));
}

const FORMATS: TextFormatType[] = ['bold', 'italic', 'underline', 'code'];
const ALIGN: ElementFormatType[] = ['', 'center', 'right'];

/** One random follow-up change; returns its name. */
function $followUp(r: () => number, k: number): string {
  const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)];
  const nodes = $all();
  const elements = nodes.filter($isElementNode);
  const texts = nodes.filter($isTextNode);
  const blocks = $getRoot().getChildren();
  const op = Math.floor(r() * 12);
  if (op === 0 && elements.length > 0) {
    const e = pick(elements);
    e.setTextFormat(pick([0, 1, 2, 12, 16]));
    return `textFormat ${e.getType()}`;
  }
  if (op === 1 && elements.length > 0) {
    const e = pick(elements);
    e.setTextStyle(pick(['', 'color: red', 'font-size: 20px']));
    return `textStyle ${e.getType()}`;
  }
  // No update stores a link's own alignment, indent and direction, nor a
  // list's own indent (Known limits in #9400): not set there.
  const blocky = elements.filter(n => !n.isInline());
  if (op === 2 && blocky.length > 0) {
    const e = pick(blocky);
    e.setFormat(pick(ALIGN));
    return `format ${e.getType()}`;
  }
  if (op === 3) {
    const e = pick(blocky.filter(n => !$isListNode(n)));
    if (e !== undefined) {
      e.setIndent(Math.floor(r() * 3));
      return `indent ${e.getType()}`;
    }
  }
  if (op === 4 && blocky.length > 0) {
    const e = pick(blocky);
    e.setDirection(pick([null, 'rtl', 'ltr']));
    return `direction ${e.getType()}`;
  }
  if (op === 5 && blocks.length > 0) {
    const b = pick(blocks);
    $setState(b, blockIdState, `id-${k}`);
    return `block id ${b.getType()}`;
  }
  if (op === 6 && texts.length > 0) {
    const t = pick(texts);
    const n = t.getTextContentSize();
    const a = Math.floor(r() * (n + 1));
    t.spliceText(a, Math.floor(r() * (n - a + 1)), pick(['', 'X', 'yz ']));
    return `text ${t.getParent()?.getType()}`;
  }
  if (op === 7 && texts.length > 0) {
    const t = pick(texts);
    t.toggleFormat(pick(FORMATS));
    return `text format ${t.getParent()?.getType()}`;
  }
  if (op === 8 && nodes.length > 0) {
    const n = pick(nodes.filter(x => !$isRootNode(x.getParent())) || nodes);
    if (n !== undefined) {
      n.remove();
      return `remove ${n.getType()}`;
    }
  }
  if (op === 9 && blocks.length > 1) {
    const a = pick(blocks);
    const b = pick(blocks);
    if (!a.is(b)) {
      b.insertBefore(a);
      return `move ${a.getType()}`;
    }
  }
  if (op === 10 && elements.length > 0) {
    const e = pick(elements.filter(x => x.getChildrenSize() > 0));
    if (e !== undefined && e.canBeEmpty()) {
      e.clear();
      return `empty ${e.getType()}`;
    }
  }
  if (op === 11 && blocks.length > 0) {
    pick(blocks).insertAfter(
      $createParagraphNode().append($createTextNode(`new ${k}`)),
    );
    return 'insert';
  }
  return 'none';
}

describe('random follow-ups', () => {
  const SEEDS = Number(process.env.FOLLOWUP_FUZZ_SEEDS ?? 120);
  for (let seed = 1; seed <= SEEDS; seed++) {
    test(`seed ${seed}`, async () => {
      const r = rng(seed * 7919);
      const t = await setup(() => {
        const nested = $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('n1')),
        );
        const table = $createTableNodeWithDimensions(1, 2, false);
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Title')),
          $createParagraphNode().append(
            $createTextNode('one '),
            $createTextNode('bold').toggleFormat('bold'),
            $createLinkNode('https://x.example').append(
              $createTextNode(' link'),
            ),
          ),
          $createParagraphNode(),
          $createListNode('number').append(
            $createListItemNode().append($createTextNode('i1')),
            $createListItemNode().append(nested),
          ),
          table,
          $createBoxNode('info').append(
            $createParagraphNode().append($createTextNode('b1')),
          ),
          $createQuoteNode({shadowRoot: true}).append(
            $createParagraphNode().append($createTextNode('q1')),
          ),
          $createParagraphNode().append(
            $createLinkNode('https://y.example').append(
              $createTextNode('only a link'),
            ),
          ),
          $createParagraphNode().append($createTextNode('two')),
        );
      });
      // Shapes concurrent edits leave: a line without a marker (A removes
      // the last line while B types into it), a raw run in a quote (A moves
      // a line into a quote while B types into it).
      const shape = Math.floor(r() * 3);
      if (shape > 0) {
        t.offline();
        if (shape === 1) {
          t.a.update(() => {
            $getRoot().getLastChild()!.remove();
            $setSelection(null);
          });
          t.b.update(() => {
            ($getRoot().getLastChild() as ElementNode)
              .selectEnd()
              .insertText(' XX');
            $setSelection(null);
          });
        } else {
          t.a.update(() => {
            const para = $block([1]);
            const quote = $createQuoteNode({shadowRoot: true});
            para.insertBefore(quote);
            quote.append(para);
            $setSelection(null);
          });
          t.b.update(() => {
            $block([1]).selectStart().insertText('t5z ');
            $setSelection(null);
          });
        }
        await t.sync();
      }
      const done: string[] = [];
      for (let k = 0; k < 6; k++) {
        const author = r() < 0.5 ? t.a : t.b;
        let what = 'none';
        author.update(() => {
          try {
            what = $followUp(r, k);
          } catch (e) {
            what = `threw ${String(e).slice(0, 40)}`;
          }
          $setSelection(null);
        }, 'block-id-repair');
        done.push(what);
        const fresh = await freshReader(author);
        expect(json(author), `${done.join(' ; ')}`).toBe(json(fresh));
        await t.sync();
        const a = json(t.a);
        expect(json(t.b), `${done.join(' ; ')}`).toBe(a);
        expect(json(await freshReader(t.a)), `${done.join(' ; ')}`).toBe(a);
      }
    });
  }
});
