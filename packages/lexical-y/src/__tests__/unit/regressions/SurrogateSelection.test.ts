/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A selection an app sets between the two halves of a surrogate pair (#9701,
// D57). Lexical's own input never does this, but code can
// (`anchor.set(key, 3, 'text')`), and Lexical then splits the pair into two
// text nodes or keeps one half. That text is the author's input: the binding
// never throws on it and writes it like any other text. Yjs stores a lone
// half as U+FFFD (its UTF-8 encoding, and its split of a pair inside one
// item), so the expected outcome is Lexical's text with each half that has
// no pair in its text node as U+FFFD, on every client, in a fresh read of the
// author's document, and in the author's own editor (the binding reads the
// line again after such a write, so the author shows what its document
// holds). Before the fix a range starting inside the pair threw
// `@lexical/y: a write splits a surrogate pair` (nothing written), and the
// other edits left the author showing lone halves that no other client had.
// @vitest-environment node

import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setCompositionKey,
  $setSelection,
  $setState,
  createState,
  DEFER_COMPOSITION_MERGE_TAG,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  expectConverged,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';

// "ab😀cd": the emoji is the UTF-16 pair at offsets 2 and 3.
const EMOJI_LINE = 'ab\u{1F600}cd';

type Edit = (node: TextNode) => void;

function $select(node: TextNode, anchor: number, focus: number) {
  const s = $createRangeSelection();
  s.anchor.set(node.getKey(), anchor, 'text');
  s.focus.set(node.getKey(), focus, 'text');
  $setSelection(s);
  return s;
}

const bold =
  (anchor: number, focus: number): Edit =>
  node =>
    $select(node, anchor, focus).formatText('bold');
const type =
  (anchor: number, focus: number, text: string): Edit =>
  node =>
    $select(node, anchor, focus).insertText(text);
const remove =
  (anchor: number, focus: number): Edit =>
  node =>
    $select(node, anchor, focus).removeText();

// [name, edit of the line's first text node, what every client shows]
const EDITS: [string, Edit, string][] = [
  [
    'bold a range that ends inside the emoji',
    bold(0, 3),
    'paragraph("ab\ufffd"{1} "\ufffdcd")',
  ],
  [
    'bold a range that starts inside the emoji',
    bold(3, 6),
    'paragraph("ab\ufffd" "\ufffdcd"{1})',
  ],
  ['bold the high half', bold(2, 3), 'paragraph("ab" "\ufffd"{1} "\ufffdcd")'],
  ['bold the low half', bold(3, 4), 'paragraph("ab\ufffd" "\ufffd"{1} "cd")'],
  [
    'bold backwards from inside the emoji',
    bold(6, 3),
    'paragraph("ab\ufffd" "\ufffdcd"{1})',
  ],
  ['type inside the emoji', type(3, 3, 'X'), 'paragraph("ab\ufffdX\ufffdcd")'],
  ['type over the low half', type(3, 4, 'X'), 'paragraph("ab\ufffdXcd")'],
  ['delete the high half', remove(2, 3), 'paragraph("ab\ufffdcd")'],
  ['delete the low half', remove(3, 4), 'paragraph("ab\ufffdcd")'],
  [
    'delete from inside the emoji to the end',
    remove(3, 6),
    'paragraph("ab\ufffd")',
  ],
  [
    'type a lone high half before the emoji',
    type(2, 2, '\ud83d'),
    'paragraph("ab\ufffd\u{1F600}cd")',
  ],
  [
    'type a lone low half at the end of the line',
    type(6, 6, '\ude00'),
    'paragraph("ab\u{1F600}cd\ufffd")',
  ],
  [
    'split the text node inside the emoji and bold its second half',
    node => node.splitText(3)[1].toggleFormat('bold'),
    'paragraph("ab\ufffd" "\ufffdcd"{1})',
  ],
  // Controls: nothing splits the pair.
  [
    'control: bold a collapsed selection inside the emoji',
    bold(3, 3),
    'paragraph("ab\u{1F600}cd")',
  ],
  [
    'control: bold the whole emoji',
    bold(2, 4),
    'paragraph("ab" "\u{1F600}"{1} "cd")',
  ],
];

// Text nodes of their own around lone halves: a pair split across two text
// nodes, and a lone half typed at the edge of a text node.
const NODE_EDITS: [string, (line: ElementNode) => void, string][] = [
  [
    'a pair split across two text nodes',
    line => {
      line.clear();
      line.append(
        $createTextNode('ab\ud83d').toggleFormat('bold'),
        $createTextNode('\ude00cd'),
      );
    },
    'paragraph("ab\ufffd"{1} "\ufffdcd")',
  ],
  [
    'a lone high half typed at the end of a text node',
    line => {
      const first = line.getFirstChild() as TextNode;
      $select(first, 2, 2).insertText('\ud83d');
    },
    'paragraph("ab\ufffd" "cd"{1})',
  ],
  [
    'a lone low half typed at the start of a text node',
    line => {
      const first = line.getFirstChild() as TextNode;
      $select(first, 0, 0).insertText('\ude00');
    },
    'paragraph("\ufffdab" "cd"{1})',
  ],
];

const settings = [false, true].flatMap(gc =>
  [
    [1, 2],
    [2, 1],
  ].map(ids => ({gc, ids})),
);

async function check(peers: Peer[], expected: string) {
  for (const peer of peers) {
    expect(peer.warnings).toEqual([]);
    // A fresh read of each client's own document, the author's included
    // (expectConverged freshly reads the first client's).
    const fresh = await freshReader(peer);
    expect(fresh.describe()).toBe(peer.describe());
  }
  await expectConverged(peers, expected);
}

describe.each(settings)(
  'a selection inside a surrogate pair (gc $gc, ids $ids)',
  ({gc, ids}) => {
    for (const [name, edit, expected] of EDITS) {
      test(name, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode(EMOJI_LINE)),
            ),
          {gc, ids},
        );
        t.b.update(() => {
          edit($getRoot().getFirstDescendant() as TextNode);
          $setSelection(null);
        });
        await t.sync();
        await check(t.peers, expected);
      });
    }

    for (const [name, edit, expected] of NODE_EDITS) {
      test(name, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode('ab'),
                $createTextNode('cd').toggleFormat('bold'),
              ),
            ),
          {gc, ids},
        );
        t.b.update(() => {
          edit($getRoot().getFirstChild() as ElementNode);
          $setSelection(null);
        });
        await t.sync();
        await check(t.peers, expected);
      });
    }

    test('a collaborator types in the line at the same time', async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode(EMOJI_LINE)),
          ),
        {gc, ids},
      );
      t.offline();
      t.b.update(() => {
        bold(3, 6)($getRoot().getFirstDescendant() as TextNode);
        $setSelection(null);
      });
      t.a.update(() => {
        const node = $getRoot().getFirstDescendant() as TextNode;
        $select(node, 0, 0).insertText('Z');
        $setSelection(null);
      });
      await t.sync();
      await check(t.peers, 'paragraph("Zab\ufffd" "\ufffdcd"{1})');
    });

    test('the author undoes the write', async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode(EMOJI_LINE)),
          ),
        {gc, ids},
      );
      t.b.update(() => {
        bold(3, 6)($getRoot().getFirstDescendant() as TextNode);
        $setSelection(null);
      });
      await t.sync();
      t.b.undo();
      await t.sync();
      // The write replaced the emoji with two U+FFFD (text of its own):
      // undoing it brings the emoji back, on every client.
      await check(t.peers, 'paragraph("ab\u{1F600}cd")');
    });
  },
);

// An object NodeState Lexical compares by reference: two text nodes with
// equal values stay apart in the editor, and are stored as one run.
const objectState = createState('surrogate-selection-object', {
  parse: (v: unknown) => (v !== null && typeof v === 'object' ? v : null),
});

describe.each(settings)(
  'a pair split across text nodes stored as one run, and compositions (gc $gc, ids $ids)',
  ({gc, ids}) => {
    test('two text nodes that store the same attributes hold the halves', async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode(EMOJI_LINE)),
          ),
        {gc, ids},
      );
      t.b.update(() => {
        ($getRoot().getFirstChild() as ElementNode)
          .clear()
          .append(
            $setState($createTextNode('ab\ud83d'), objectState, {v: 1}),
            $setState($createTextNode('\ude00cd'), objectState, {v: 1}),
          );
        $setSelection(null);
      });
      await t.sync();
      const fresh = await freshReader(t.b);
      expect(fresh.read(() => $getRoot().getTextContent())).toBe(
        'ab\ufffd\ufffdcd',
      );
      await check(t.peers, t.a.describe());
      expect(t.b.read(() => $getRoot().getTextContent())).toBe(
        'ab\ufffd\ufffdcd',
      );
    });

    test('a split inside the emoji while it is composed', async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode(EMOJI_LINE)),
          ),
        {gc, ids},
      );
      t.b.update(() => {
        const node = $getRoot().getFirstDescendant() as TextNode;
        node.select(3, 3);
        $setCompositionKey(node.getKey());
      });
      t.b.update(() => {
        ($getRoot().getFirstDescendant() as TextNode).splitText(3);
        $setSelection(null);
      }, DEFER_COMPOSITION_MERGE_TAG);
      await t.sync();
      const fresh = await freshReader(t.b);
      expect(fresh.read(() => $getRoot().getTextContent())).toBe(
        'ab\ufffd\ufffdcd',
      );
      t.b.update(() => $setCompositionKey(null));
      await t.sync();
      await check(t.peers, 'paragraph("ab\ufffd\ufffdcd")');
    });

    for (const [anchor, focus, expected] of [
      [0, 3, 'paragraph("ab\ufffd"{1} "\ufffdcd\u3066")'],
      [3, 6, 'paragraph("ab\ufffd" "\ufffdcd\u3066"{1})'],
    ] as const) {
      test(`a collaborator composes at the end of the line while the author bolds [${anchor}, ${focus})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode(EMOJI_LINE)),
            ),
          {gc, ids},
        );
        t.a.update(() => {
          const node = $getRoot().getFirstDescendant() as TextNode;
          node.select(6, 6);
          $setCompositionKey(node.getKey());
        });
        t.b.update(() => {
          bold(anchor, focus)($getRoot().getFirstDescendant() as TextNode);
          $setSelection(null);
        });
        await t.sync();
        t.a.update(() => {
          const node = $getRoot().getLastDescendant() as TextNode;
          node.spliceText(node.getTextContentSize(), 0, '\u3066');
        });
        await t.sync();
        t.a.update(() => {
          $setCompositionKey(null);
          $setSelection(null);
        });
        await t.sync();
        await check(t.peers, expected);
      });
    }
  },
);
