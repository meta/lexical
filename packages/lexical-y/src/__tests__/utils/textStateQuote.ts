/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Documents with NodeState on text in and around a quote that holds
// paragraphs, as an extension that anchors comments stores it: a flat
// string (`anchor`) and a set of ids (`markIds`, set-valued like
// MarkStateExtension's), on the same text. Shared by the 4to5 golden inputs
// (Migrate4to5.test.ts) and the split and join cases
// (ShadowRootQuoteTextState.test.ts).

import {$createQuoteNode} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setState,
  arraySetValue,
  createState,
  type LexicalNode,
  stringValue,
  type TextNode,
} from 'lexical';

export const anchorState = createState('anchor', {
  parse: v => (typeof v === 'string' ? v : ''),
});
export const markIdsState = createState('markIds', {
  parse: arraySetValue(stringValue()),
});

/** Text carrying both states for comment `id`. */
export function $stated(text: string, id: string): TextNode {
  return $setState(
    $setState($createTextNode(text), anchorState, id),
    markIdsState,
    [id],
  );
}

const $para = (...children: (string | LexicalNode)[]) =>
  $createParagraphNode().append(
    ...children.map(c => (typeof c === 'string' ? $createTextNode(c) : c)),
  );

export type TextStateDoc = {
  name: string;
  $init: () => void;
  /** The quote's two paragraphs. */
  first: number[];
  second: number[];
  /** A caret inside the stated text of the first paragraph, and a later one. */
  split: number;
  typeAfterSplit: number;
  /** An offset inside the second paragraph (in its stated text, if any). */
  typeInSecond: number;
};

export const TEXT_STATE_DOCS: readonly TextStateDoc[] = [
  {
    // (a) A stated run wholly inside one paragraph of the quote.
    $init: () =>
      $getRoot().append(
        $para('title'),
        $createQuoteNode({shadowRoot: true}).append(
          $para('before ', $stated('anchored text', 'c1'), ' after'),
          $para('second'),
        ),
        $para('end'),
      ),
    first: [1, 0],
    name: 'inside-one-paragraph',
    second: [1, 1],
    split: 11,
    typeAfterSplit: 17,
    typeInSecond: 3,
  },
  {
    // (b) One comment's text across both paragraphs of the quote.
    $init: () =>
      $getRoot().append(
        $para('title'),
        $createQuoteNode({shadowRoot: true}).append(
          $para('first ', $stated('tail of one', 'c2')),
          $para($stated('head of two', 'c2'), ' rest'),
        ),
        $para('end'),
      ),
    first: [1, 0],
    name: 'across-two-paragraphs',
    second: [1, 1],
    split: 10,
    typeAfterSplit: 14,
    typeInSecond: 5,
  },
  {
    // (c) One comment's text from a root paragraph into the quote.
    $init: () =>
      $getRoot().append(
        $para('title'),
        $para('root ', $stated('root tail', 'c3')),
        $createQuoteNode({shadowRoot: true}).append(
          $para($stated('quote head', 'c3'), ' more'),
          $para('last'),
        ),
        $para('end'),
      ),
    first: [2, 0],
    name: 'from-the-root-into-the-quote',
    second: [2, 1],
    split: 3,
    typeAfterSplit: 7,
    typeInSecond: 2,
  },
];
