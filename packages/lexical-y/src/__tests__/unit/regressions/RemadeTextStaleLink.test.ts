/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A line holding a link is made again as one plain text node with a word
// changed at each end (an agent rewriting a block: the link goes away),
// while a stale edit computed before the rewrite formats a range of it. The
// rewrite keeps the unchanged words between the changes as the same
// characters (#9621), as it keeps a line's unchanged start or end with one
// changed word (#9598). A stale format whose range reaches past the link
// does not restate the link on them (#9597: it writes no value for the
// link), so the removed link stays removed.

import {$createLinkNode, $isLinkNode, LinkExtension} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type LexicalNode,
  type TextFormatType,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  createYDoc,
  createYWriter,
  editYState,
  type HeadlessYConfig,
  readYState,
  seedYState,
} from '../../../headless';

const config: HeadlessYConfig = {
  extensions: [RichTextExtension, LinkExtension],
  onWarn: () => {},
  schemaVersion: 1,
};

const edit = (state: Uint8Array, who: string, fn: () => void) =>
  editYState(state, config, fn, {writer: createYWriter(who)}).update!;

/** The words shown inside a link. */
const linkedWords = (state: Uint8Array) =>
  readYState(state, config, () => {
    const out: string[] = [];
    for (const leaf of $getRoot().getAllTextNodes()) {
      let node: LexicalNode | null = leaf.getParent();
      while (node !== null && !$isLinkNode(node)) {
        node = node.getParent();
      }
      if (node !== null) {
        out.push(...leaf.getTextContent().split(/\s+/).filter(Boolean));
      }
    }
    return out;
  });

/** Selects the characters of words `from` to `to` of the line. */
function $selectWords(from: string, to: string) {
  const block = $getRoot().getFirstChildOrThrow() as ElementNode;
  const text = block.getTextContent();
  const start = text.indexOf(from);
  const end = text.indexOf(to) + to.length;
  const at = (offset: number, isStart: boolean): [string, number] => {
    let acc = 0;
    for (const leaf of block.getAllTextNodes()) {
      const n = leaf.getTextContentSize();
      if (isStart ? offset < acc + n : offset <= acc + n) {
        return [leaf.getKey(), offset - acc];
      }
      acc += n;
    }
    throw new Error('no text node');
  };
  const selection = $createRangeSelection();
  selection.anchor.set(...at(start, true), 'text');
  selection.focus.set(...at(end, false), 'text');
  $setSelection(selection);
  return selection;
}

const WORDS = ['t23z', 't24z', 't25z', 't26z', 't27z'];

for (const link of [['t25z', 't26z'], ['t24z', 't25z'], ['t25z']]) {
  for (const format of ['bold', 'italic'] as TextFormatType[]) {
    for (const range of [
      ['t24z', 't25z'],
      ['t25z', 't25z'],
      ['t23z', 't26z'],
    ]) {
      for (const order of ['rewrite first', 'format first']) {
        test(`link on ${link.join(' ')}, a stale ${format} of ${range.join('..')}, ${order}: the removed link stays removed`, () => {
          const s0 = seedYState(config, () => {
            const p = $createParagraphNode();
            const i = WORDS.indexOf(link[0]);
            const j = WORDS.indexOf(link[link.length - 1]);
            if (i > 0) {
              p.append($createTextNode(WORDS.slice(0, i).join(' ') + ' '));
            }
            p.append(
              $createLinkNode('https://example.com').append(
                $createTextNode(link.join(' ')),
              ),
            );
            if (j < WORDS.length - 1) {
              p.append($createTextNode(' ' + WORDS.slice(j + 1).join(' ')));
            }
            $getRoot().append(p);
          });
          const rewrite = edit(s0, 'rewrite', () => {
            const block = $getRoot().getFirstChildOrThrow() as ElementNode;
            const next = block
              .getTextContent()
              .replace('t23z', 't66z')
              .replace('t27z', 't68z');
            for (const child of block.getChildren()) {
              child.remove();
            }
            block.append($createTextNode(next));
          });
          const stale = edit(s0, 'stale', () => {
            $selectWords(range[0], range[1]).formatText(format);
          });
          const doc = createYDoc(s0);
          for (const u of order === 'rewrite first'
            ? [rewrite, stale]
            : [stale, rewrite]) {
            Y.applyUpdate(doc, u);
          }
          const alone = createYDoc(s0);
          Y.applyUpdate(alone, rewrite);
          expect(linkedWords(Y.encodeStateAsUpdate(alone))).toEqual([]);
          expect(linkedWords(Y.encodeStateAsUpdate(doc))).toEqual([]);
        });
      }
    }
  }
}
