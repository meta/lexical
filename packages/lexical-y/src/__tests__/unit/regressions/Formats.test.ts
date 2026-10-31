/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Regression cases for format findings of the #9400 soaks whose original
// repros were not committed. Each case is named after its finding. jsdom:
// the editors are attached to DOM roots, so the reconciler derives elements'
// text fields from the text it renders.

import {$createLinkNode, $isLinkNode, $toggleLink} from '@lexical/link';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {$addMarkID, $removeMarkID} from '@lexical/mark';
import {$patchStyleText} from '@lexical/selection';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $selectIn,
  freshReader,
  type Peer,
  setup,
  shape,
} from '../../utils/harness';

function attach(peer: Peer) {
  const element = document.createElement('div');
  element.contentEditable = 'true';
  document.body.appendChild(element);
  peer.editor.setRootElement(element);
}

function withoutTextFields(json: unknown): unknown {
  if (Array.isArray(json)) {
    return json.map(withoutTextFields);
  }
  if (json !== null && typeof json === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(json)) {
      if (k !== 'textFormat' && k !== 'textStyle') {
        out[k] = withoutTextFields(v);
      }
    }
    return out;
  }
  return json;
}

const $item = (i: number) =>
  ($getRoot().getFirstChildOrThrow() as ElementNode).getChildAtIndex(
    i,
  ) as ElementNode;
const $linkText = (i: number) => {
  const link = $item(i).getFirstChildOrThrow();
  return (
    $isLinkNode(link) && $isElementNode(link)
      ? link.getFirstChildOrThrow()
      : link
  ) as TextNode;
};

// J-1: list items whose only child is a link serialize a textFormat the
// reconciler derives from the link's first text. Two clients formatting the
// first link at once, then each typing a character, made the self-check warn
// on those items' textFormat (locally on an untouched link-only item, and
// remotely on the edited one): every client and a fresh reader must show the
// same document, with no self-check warning.
describe('J-1: concurrent formatting in list items that hold only a link', () => {
  const edits: [string, () => void, () => void][] = [
    [
      'A italicizes "alpha" ‖ B un-bolds "beta gamma"',
      () => $linkText(0).select(0, 5).formatText('italic'),
      () => $linkText(0).select(6, 16).formatText('bold'),
    ],
    [
      'A and B both italicize "alpha"',
      () => $linkText(0).select(0, 5).formatText('italic'),
      () => $linkText(0).select(0, 5).formatText('italic'),
    ],
    [
      'A underlines "gamma" ‖ B italicizes "beta"',
      () => $linkText(0).select(11, 16).formatText('underline'),
      () => $linkText(0).select(6, 10).formatText('italic'),
    ],
  ];
  for (const [name, $editA, $editB] of edits) {
    test(`J-1 ${name}, then each types a character: no self-check warning`, async () => {
      const t = await setup(() => {
        $getRoot().append(
          $createListNode('bullet').append(
            $createListItemNode().append(
              $createLinkNode('https://a.example').append(
                $createTextNode('alpha beta gamma').toggleFormat('bold'),
              ),
            ),
            $createListItemNode().append($createTextNode('plain item')),
            $createListItemNode().append(
              $createLinkNode('https://d.example').append(
                $createTextNode('delta epsilon')
                  .toggleFormat('bold')
                  .toggleFormat('underline'),
              ),
            ),
          ),
        );
      });
      t.peers.forEach(attach);
      await t.sync();
      t.offline();
      t.a.update($editA);
      t.b.update($editB);
      t.a.update(() => $linkText(0).select(0, 0).insertText('x'));
      t.b.update(() => $linkText(0).select(0, 0).insertText('y'));
      t.a.update(() => $setSelection(null));
      t.b.update(() => $setSelection(null));
      await t.sync();
      // Each client derives a link-only item's textFormat from the text it
      // reconciled there (a fresh reader from none), as Lexical does without
      // collaboration: compare the documents without those derived fields.
      const fresh = await freshReader(t.a);
      for (const p of [...t.peers, fresh]) {
        expect(p.errors).toEqual([]);
        expect(p.warnings).toEqual([]);
        expect(withoutTextFields(shape(p))).toEqual(
          withoutTextFields(shape(t.a)),
        );
      }
    });
  }
});

/** Each line's text nodes, with bold (B), italic (I), underline (U) and mark ids. */
function $runs(): string {
  return $getRoot()
    .getChildren()
    .map(p =>
      ($isElementNode(p) ? p.getChildren() : [])
        .map((c: LexicalNode) => {
          const f = $isTextNode(c) ? c.getFormat() : 0;
          const json = c.exportJSON() as {$?: {markIds?: string[]}};
          const tags = [
            f & 1 ? 'B' : '',
            f & 2 ? 'I' : '',
            f & 8 ? 'U' : '',
            json.$?.markIds ? json.$.markIds.join('+') : '',
          ].filter(Boolean);
          return `${JSON.stringify(c.getTextContent())}${tags.length ? '[' + tags.join(',') + ']' : ''}`;
        })
        .join(' '),
    )
    .join(' / ');
}

/** The first line's text node at `index`. */
function $text(index: number): TextNode {
  const t = ($getRoot().getFirstChildOrThrow() as ElementNode).getChildAtIndex(
    index,
  );
  if (!$isTextNode(t)) {
    throw new Error('no text node');
  }
  return t;
}

/** Select line offsets `from` to `to` of the first line. */
function $selectLine(from: number, to: number) {
  const texts = (
    $getRoot().getFirstChildOrThrow() as ElementNode
  ).getAllTextNodes();
  const at = (o: number, later: boolean): [TextNode, number] => {
    let acc = 0;
    for (let i = 0; i < texts.length; i++) {
      const size = texts[i].getTextContentSize();
      if (
        o < acc + size ||
        (o === acc + size && (!later || i === texts.length - 1))
      ) {
        return [texts[i], o - acc];
      }
      acc += size;
    }
    throw new Error('offset');
  };
  const [a, ao] = at(from, true);
  const [b, bo] = at(to, false);
  const sel = $createRangeSelection();
  sel.anchor.set(a.getKey(), ao, 'text');
  sel.focus.set(b.getKey(), bo, 'text');
  return sel;
}

/** A Backspace before first-line offset `at`. */
function backspace(peer: Peer, at: number) {
  peer.update(() => {
    let acc = 0;
    for (const t of (
      $getRoot().getFirstChildOrThrow() as ElementNode
    ).getAllTextNodes()) {
      const size = t.getTextContentSize();
      if (at - 1 < acc + size) {
        t.spliceText(at - 1 - acc, 1, '', true);
        return;
      }
      acc += size;
    }
  });
}

async function merged(t: Awaited<ReturnType<typeof setup>>) {
  await t.sync();
  const fresh = await freshReader(t.a);
  const shown = [t.a, t.b, fresh].map(p => p.read($runs));
  expect(shown[1]).toBe(shown[0]);
  expect(shown[2]).toBe(shown[0]);
  for (const p of [t.a, t.b, fresh]) {
    expect(p.errors).toEqual([]);
    expect(p.warnings.filter(w => w.includes('self-check'))).toEqual([]);
  }
  return shown[0];
}

// U23A-2: two peers delete the two characters before a space at once, each
// with its own format items (each text node is a run of its own). Each
// write removed the format items its delete left redundant: one the opener
// of the space's bold (redundant with the run before it), the other that
// run's opener, deleted with its character. The space, which nobody
// touched, lost bold (with mark ids stored per member, a comment): a delete
// keeps the items a concurrent writer relies on (see Cursor#collapseGap).
describe('U23A-2: two concurrent deletes next to a character nobody touched', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`bold over "cd ", italic on "d", underline on the space: the space keeps bold (ids ${ids})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('c').toggleFormat('bold'),
              $createTextNode('d').toggleFormat('bold').toggleFormat('italic'),
              $createTextNode(' ')
                .toggleFormat('bold')
                .toggleFormat('underline'),
            ),
            $createParagraphNode().append($createTextNode('next')),
          );
        },
        {ids},
      );
      t.offline();
      backspace(t.a, 2);
      backspace(t.b, 1);
      expect(await merged(t)).toBe('" "[B,U] / "next"');
    });

    test(`comment s0 over "cd ", s2 on "d", s1 on the space: the space keeps both (ids ${ids})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('cd ')),
            $createParagraphNode().append($createTextNode('next')),
          );
          $addMarkID('s0', $selectLine(0, 3));
          $addMarkID('s2', $selectLine(1, 2));
          $addMarkID('s1', $selectLine(2, 3));
        },
        {ids},
      );
      t.offline();
      backspace(t.a, 2);
      backspace(t.b, 1);
      expect(await merged(t)).toBe('" "[s0+s1] / "next"');
    });
  }
});

// U23A-1: a format removed over a range while a peer types text without it
// inside the range. The remover's write dropped the run's closer as
// redundant, so the typist's restore of the format after its text had no
// end and ran on over the rest of the line and, in the flat layout, over
// the following lines. The remover now keeps the closer (see
// Cursor#format): what follows the range keeps its formats. Still open (y.md,
// Limits, Other races): the part of the range after the typist's text gets the
// format back, from that restore, which the remover's write never saw.
describe('U23A-1: a format removed while a peer types inside it', () => {
  const cases = [
    {
      $edit: () => $text(1).toggleFormat('bold'),
      $init: () =>
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('a '),
            $createTextNode('bold').toggleFormat('bold'),
            $createTextNode(' c'),
          ),
          $createParagraphNode().append($createTextNode('next line')),
        ),
      $type: () => {
        const sel = $selectLine(4, 4);
        sel.format = 0;
        $setSelection(sel);
        sel.insertText('x');
      },
      tag: 'B',
      what: 'bold',
    },
    {
      $edit: () => $removeMarkID('s1'),
      $init: () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('a bold c')),
          $createParagraphNode().append($createTextNode('next line')),
        );
        $addMarkID('s1', $selectLine(2, 6));
      },
      $type: () => {
        const marked = (
          $getRoot().getFirstChildOrThrow() as ElementNode
        ).getChildAtIndex(1) as TextNode;
        const [, right] = marked.splitText(2);
        right.insertBefore($createTextNode('x'));
      },
      tag: 's1',
      what: 'a comment',
    },
  ];
  for (const {$edit, $init, $type, tag, what} of cases) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      const run = async () => {
        const t = await setup($init, {ids});
        t.offline();
        t.a.update($edit);
        t.b.update($type);
        return merged(t);
      };
      test(`${what} removed while a peer types plain "x" inside it: nothing after the range and no other line gets it (ids ${ids})`, async () => {
        const shown = await run();
        expect(shown).toMatch(/^"a box"/);
        expect(shown).not.toContain(`" c"[${tag}`);
        expect(shown).not.toContain(`"ld c"[${tag}`);
        expect(shown).toMatch(/ \/ "next line"$/);
      });
      test.fails(
        `${what} removed while a peer types plain "x" inside it: the rest of the range stays without it (ids ${ids})`,
        async () => {
          expect(await run()).not.toContain(tag);
        },
      );
    }
  }
});

/** Select first-line offsets `from` to `to` and make it the selection. */
function $selectAt(from: number, to: number) {
  const sel = $selectLine(from, to);
  $setSelection(sel);
  return sel;
}

// F23A-1: a block split racing a format change of the text split off. A
// reader that ended every format at a line marker stopped a concurrent
// opener Yjs ordered before the new marker there, and a splitter that
// reopened the formats it saw after its marker overrode a concurrent
// removal. A split asserts no format: the run goes on over the marker, as
// stored.
describe('F23A-1: a block split racing a format change of the text split off', () => {
  const cases: [string, () => void, () => void, string][] = [
    [
      'split at 4 ‖ bold over [4,7)',
      () => $createTextNode('abc def'),
      () => $selectAt(4, 7).formatText('bold'),
      '"abc " / "def"[B]',
    ],
    [
      'split at 4 ‖ a comment over [2,7)',
      () => $createTextNode('abc def'),
      () => $addMarkID('c1', $selectLine(2, 7)),
      '"ab" "c "[c1] / "def"[c1]',
    ],
    [
      'split at 4 in a bold line ‖ unbold "def"',
      () => $createTextNode('abc def').toggleFormat('bold'),
      () => $text(0).splitText(4)[1].toggleFormat('bold'),
      '"abc "[B] / "def"',
    ],
  ];
  for (const [name, $make, $edit, expected] of cases) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      test(`${name} (ids ${ids})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append(($make as () => TextNode)()),
            );
          },
          {ids},
        );
        t.offline();
        t.a.update(() => {
          $selectAt(4, 4).insertParagraph();
          $setSelection(null);
        });
        t.b.update(() => {
          $edit();
          $setSelection(null);
        });
        expect(await merged(t)).toBe(expected);
      });
    }
  }
});

// R23-B: plain text pasted over a range of runs with other formats ‖ Enter
// inside that range. With formats ended at line markers, the pasted text
// took the formats after the new marker and the underline of the text
// after it gained the others.
describe('R23-B: plain text pasted over formatted runs ‖ Enter inside them', () => {
  for (const how of ['insertNodes', 'insertRawText'] as const) {
    for (const at of [13, 15]) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        test(`paste "Q" over [6,20) (${how}) ‖ Enter at ${at} (ids ${ids})`, async () => {
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append(
                  $createTextNode('head '),
                  $createTextNode('abcdef').toggleFormat('bold'),
                  $createTextNode(' ghij ')
                    .toggleFormat('bold')
                    .toggleFormat('italic'),
                  $createTextNode('klmnop').toggleFormat('underline'),
                ),
              );
            },
            {ids},
          );
          t.offline();
          t.a.update(() => {
            const sel = $selectAt(6, 20);
            if (how === 'insertNodes') {
              sel.insertNodes([$createTextNode('Q')]);
            } else {
              sel.insertRawText('Q');
            }
            $setSelection(null);
          });
          t.b.update(() => {
            $selectAt(at, at).insertParagraph();
            $setSelection(null);
          });
          expect(await merged(t)).toBe('"head " "a"[B] / "Q" "nop"[U]');
        });
      }
    }
  }
});

// A delete racing a format change or typing at the edges of the deleted
// run. Each delete removed the format items it found redundant: a peer
// that bolded the text before a deleted bold word ended its run at that
// word's closer, so bold spread over the text after it and the following
// lines; text a peer typed at the end of the deleted word lost the word's
// format. A delete keeps the format items a concurrent writer relies on
// (see Cursor#collapseGap), and a format change bounds its range with items
// of its own (see Cursor#format).
describe('a delete racing a format change or typing at the deleted run', () => {
  const $node = (i: number) =>
    ($getRoot().getFirstChildOrThrow() as ElementNode).getChildAtIndex(
      i,
    ) as TextNode;
  const cases: [string, () => void, () => void, () => void, string][] = [
    [
      'delete a bold word ‖ bold the plain text before it',
      () =>
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('a '),
            $createTextNode('b').toggleFormat('bold'),
            $createTextNode(' c'),
          ),
          $createParagraphNode().append($createTextNode('next')),
        ),
      () => $node(1).remove(),
      () => $node(0).toggleFormat('bold'),
      '"a "[B] " c" / "next"',
    ],
    [
      'delete a bold word ‖ type bold at its end',
      () =>
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('a').toggleFormat('bold'),
            $createTextNode(' '),
            $createTextNode('b').toggleFormat('bold'),
            $createTextNode(' rest'),
          ),
        ),
      () => $node(2).remove(),
      () => $node(2).spliceText(1, 0, 'c', true),
      '"a"[B] " " "c"[B] " rest"',
    ],
    [
      'delete a bold-italic word after bold text ‖ type plain text before it',
      () =>
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('a').toggleFormat('bold'),
            $createTextNode('b').toggleFormat('bold').toggleFormat('italic'),
            $createTextNode(' rest'),
          ),
        ),
      () => $node(1).remove(),
      () => {
        const sel = $node(0).select(1, 1);
        sel.format = 0;
        sel.insertText('x');
      },
      '"a"[B] "x rest"',
    ],
    [
      'delete a bold word ‖ bold the plain text after it',
      () =>
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('a '),
            $createTextNode('b').toggleFormat('bold'),
            $createTextNode('c rest'),
          ),
        ),
      () => $node(1).remove(),
      () => $node(2).splitText(1)[0].toggleFormat('bold'),
      '"a " "c"[B] " rest"',
    ],
  ];
  for (const [name, $init, $delete, $edit, expected] of cases) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      test(`${name} (ids ${ids})`, async () => {
        const t = await setup($init, {ids});
        t.offline();
        t.a.update(() => {
          $delete();
          $setSelection(null);
        });
        t.b.update(() => {
          $edit();
          $setSelection(null);
        });
        expect(await merged(t)).toBe(expected);
      });
    }
  }
});

// S6-2: a format added or removed over two words while a peer splits the
// line between them. With formats ended at line markers, the split-off word
// lost an added format, or got a removed one back up to the line end.
describe('S6-2: a format change over two words ‖ a split between them', () => {
  const $plain = () => $createTextNode('aaa bbb ccc ddd');
  const $bold = () => $createTextNode('aaa bbb ccc ddd').toggleFormat('bold');
  const cases: [string, () => TextNode, () => void, (at: number) => string][] =
    [
      [
        'bold "bbb ccc"',
        $plain,
        () => $selectAt(4, 11).formatText('bold'),
        at =>
          at === 7
            ? '"aaa " "bbb"[B] / " ccc"[B] " ddd"'
            : '"aaa " "bbb "[B] / "ccc"[B] " ddd"',
      ],
      [
        'comment "bbb ccc"',
        $plain,
        () => $addMarkID('c1', $selectLine(4, 11)),
        at =>
          at === 7
            ? '"aaa " "bbb"[c1] / " ccc"[c1] " ddd"'
            : '"aaa " "bbb "[c1] / "ccc"[c1] " ddd"',
      ],
      [
        'unbold "bbb ccc" in a bold line',
        $bold,
        () => $text(0).splitText(4, 11)[1].toggleFormat('bold'),
        at =>
          at === 7
            ? '"aaa "[B] "bbb" / " ccc" " ddd"[B]'
            : '"aaa "[B] "bbb " / "ccc" " ddd"[B]',
      ],
      [
        'resolve a comment over the line',
        $plain,
        () => $removeMarkID('c1'),
        at => (at === 7 ? '"aaa bbb" / " ccc ddd"' : '"aaa bbb " / "ccc ddd"'),
      ],
    ];
  for (const [name, $make, $edit, expected] of cases) {
    for (const at of [7, 8]) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        test(`${name} ‖ split at ${at} (ids ${ids})`, async () => {
          const t = await setup(
            () => {
              $getRoot().append($createParagraphNode().append($make()));
              if (name.startsWith('resolve')) {
                $addMarkID('c1', $selectLine(0, 15));
              }
            },
            {ids},
          );
          t.offline();
          t.a.update(() => {
            $selectAt(at, at).insertParagraph();
            $setSelection(null);
          });
          t.b.update(() => {
            $edit();
            $setSelection(null);
          });
          expect(await merged(t)).toBe(expected(at));
        });
      }
    }
  }
});

// R24B-F1: a comment resolved while a peer types plain text before a space
// the comment covers. The typist restores, after its text, the comments it
// saw there (those of the character before), relying on the space's own
// items to end them; the resolve removed those items and opened the space's
// new value where they had been, before the typed text, so the space took
// the restored comments, one of which it never held. A format change opens
// its value right before its range's first content (see Cursor#format).
describe('R24B-F1: a comment resolved ‖ plain text typed before a character it covers', () => {
  for (const wide of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      test(`${wide ? 'C3 over "b c"' : 'C3 over "b "'} (ids ${ids})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('ab cd')),
            );
          },
          {ids},
        );
        // The comments added one after the other, as users add them.
        t.a.update(() => {
          $addMarkID('S0', $selectLine(1, 2));
          $setSelection(null);
        });
        t.a.update(() => {
          $addMarkID('C3', $selectLine(1, wide ? 4 : 3));
          $setSelection(null);
        });
        await t.sync();
        t.offline();
        t.b.update(() => {
          $removeMarkID('C3');
          $setSelection(null);
        });
        t.c.update(() => {
          $selectAt(2, 2).insertText('x');
          $setSelection(null);
        });
        expect(await merged(t)).toBe('"a" "b"[S0] "x cd"');
      });
    }
  }
});

// F24A-1: every word of another format, comment or NodeState value typed at
// one place and deleted again leaves its two format items (its opener and
// its closer) live: a delete keeps the format items around and inside the
// content it deletes, which a concurrent writer and an undo of the delete
// rely on (D86). So the items grow by exactly two per such word, and by none
// per keystroke of plain text.
describe('F24A-1: words typed and deleted again at one place', () => {
  const live = (peer: Peer) => {
    let n = 0;
    const root = peer.binding.root as unknown as {_start: Y.Item | null};
    for (let it = root._start; it !== null; it = it.right) {
      if (!it.deleted && it.content instanceof Y.ContentFormat) {
        n++;
      }
    }
    return n;
  };
  const FORMATS = [
    'bold',
    'italic',
    'underline',
    'strikethrough',
    'code',
  ] as const;
  for (const pattern of ['formats', 'comments'] as const) {
    test(`leave a bounded number of format items (${pattern})`, async () => {
      const t = await setup(() => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('start middle end')),
        );
      });
      const counts: number[] = [];
      for (let i = 1; i <= 60; i++) {
        t.a.update(() => {
          const sel = $selectAt(6, 6);
          if (pattern === 'formats') {
            sel.format = 0;
            sel.toggleFormat(FORMATS[i % FORMATS.length]);
          }
          sel.insertText('word');
          $setSelection(null);
        });
        if (pattern === 'comments') {
          t.a.update(() => {
            $addMarkID(`c${i}`, $selectLine(6, 10));
            $setSelection(null);
          });
        }
        t.a.update(() => {
          $selectAt(6, 10).removeText();
          $setSelection(null);
        });
        if (i % 20 === 0) {
          counts.push(live(t.a));
        }
      }
      expect(await merged(t)).toBe('"start middle end"');
      // Two per word: 40 after 20 words, 80 after 40, 120 after 60.
      expect(counts).toEqual([40, 80, 120]);
    });
  }
});

// S6-8: a line's text deleted while a peer types a word inside it. The
// delete collapsed the format items it left, keeping a few per key, and
// removed the closer of an italic word that the typist, typing plain text
// after it, relied on: the typist's word, written without items of its own,
// became italic on every client. A delete keeps every item it leaves inside
// the content it deletes and at its edges; a later delete in the same run
// collapses them (see Cursor#collapseGap).
describe("S6-8: a line's text deleted ‖ a peer types a word inside it", () => {
  const $line = () => $getRoot().getChildAtIndex(1) as ElementNode;
  const $word = () => {
    const t = $line()
      .getAllTextNodes()
      .find(n => n.getTextContent().includes('t37z'));
    if (t === undefined) {
      return '<none>';
    }
    const json = t.exportJSON() as {$?: {markIds?: string[]}};
    return `f${t.getFormat()} [${(json.$?.markIds ?? []).join('+')}]`;
  };
  for (const comment of [false, true]) {
    for (const at of [0, 5, 10, 15, 20]) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        test(`${comment ? 'a commented' : 'a'} line, B types at ${at} (ids ${ids})`, async () => {
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('t9z t10z ')),
                $createParagraphNode().append(
                  $createTextNode('t14z ').toggleFormat('italic'),
                  $createTextNode('t15z t16z '),
                  $createTextNode('t17z ').toggleFormat('italic'),
                  $createTextNode('t33z '),
                ),
                $createParagraphNode().append($createTextNode('t18z')),
              );
            },
            {ids},
          );
          const $all = () => {
            const ts = $line().getAllTextNodes();
            const sel = $createRangeSelection();
            sel.anchor.set(ts[0].getKey(), 0, 'text');
            sel.focus.set(ts[ts.length - 1].getKey(), 5, 'text');
            $setSelection(sel);
            return sel;
          };
          if (comment) {
            t.a.update(() => {
              $addMarkID('m3', $all());
              $setSelection(null);
            });
            await t.sync();
          }
          t.offline();
          t.a.update(() => {
            $all().removeText();
            $setSelection(null);
          });
          t.b.update(() => {
            let n = at;
            for (const node of $line().getAllTextNodes()) {
              if (n <= node.getTextContentSize()) {
                node.select(n, n).insertText('t37z ');
                break;
              }
              n -= node.getTextContentSize();
            }
            $setSelection(null);
          });
          const typed = t.b.read($word);
          await merged(t);
          for (const p of t.peers) {
            expect(p.read($word)).toBe(typed);
          }
        });
      }
    }
  }
});

// F30A-1: a format change of a range ‖ the same change made again, one of
// them undone. A format change keeps an item after its range that gives
// the content after it the range's value. Where it closed its own range
// before that item with the value from before, an undo of the change that
// wrote the item deleted it, and that closer gave the next character, which
// nobody touched, the value from before. A format change closes its range,
// where the change that gave the range its old value ends right after it,
// with that change's own closing value (see Cursor#format).
describe('F30A-1: undo of a format change ‖ the same change made again', () => {
  const settled = async (t: Awaited<ReturnType<typeof setup>>) => {
    await t.sync();
    const fresh = await freshReader(t.a);
    const shown = [t.a, t.b, t.c, fresh].map(p => p.read($runs));
    for (const view of shown) {
      expect(view).toBe(shown[0]);
    }
    return shown[0];
  };
  const $init = () =>
    $getRoot().append(
      $createParagraphNode().append($createTextNode('ab cd ef')),
      $createParagraphNode().append($createTextNode('next')),
    );
  const cases: [string, () => void, () => void, () => void, string][] = [
    [
      's0 over "b ", s1 over "b"; the addition of s1 undone ‖ s1 resolved',
      () => $addMarkID('s0', $selectLine(1, 3)),
      () => $addMarkID('s1', $selectLine(1, 2)),
      () => $removeMarkID('s1'),
      '"a" "b "[s0] "cd ef" / "next"',
    ],
    [
      's0 over "ab cd", s1 over "b c"; the addition of s1 undone ‖ s1 resolved',
      () => $addMarkID('s0', $selectLine(0, 5)),
      () => $addMarkID('s1', $selectLine(1, 4)),
      () => $removeMarkID('s1'),
      '"ab cd"[s0] " ef" / "next"',
    ],
    [
      'italic over "b ", italic removed from "b"; the removal undone ‖ "b" italic again',
      () => {
        const sel = $selectLine(1, 3);
        $setSelection(sel);
        sel.formatText('italic');
      },
      () => {
        const sel = $selectLine(1, 2);
        sel.format = 2;
        $setSelection(sel);
        sel.formatText('italic');
      },
      () => {
        const sel = $selectLine(1, 2);
        sel.format = 0;
        $setSelection(sel);
        sel.formatText('italic');
      },
      '"a" "b "[I] "cd ef" / "next"',
    ],
  ];
  for (const [name, $first, $second, $again, expected] of cases) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
      [2, 3, 1],
    ]) {
      test(`${name} (ids ${ids})`, async () => {
        const t = await setup($init, {ids});
        t.a.update(() => {
          $first();
          $setSelection(null);
        });
        t.a.update(() => {
          $second();
          $setSelection(null);
        });
        await t.sync();
        t.offline();
        t.a.undo();
        t.c.update(() => {
          $again();
          $setSelection(null);
        });
        expect(await settled(t)).toBe(expected);
      });
    }
  }
  // The closer a format change writes before the item it keeps after its
  // range is what keeps its value off that content where a peer removes
  // the item at the same time.
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`bold over "abc" ‖ "d" after it, bold in a run of its own, unbolded (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('abc'),
              $createTextNode('d').toggleFormat('bold'),
              $createTextNode(' rest'),
            ),
          ),
        {ids},
      );
      t.offline();
      t.a.update(() => {
        $text(0).toggleFormat('bold');
      });
      t.b.update(() => {
        $text(1).toggleFormat('bold');
      });
      expect(await merged(t)).toBe('"abc"[B] "d rest"');
    });
  }
});

// F31A-1: a format change that replaced the item before its range's first
// content (the closer of the run before it) removed it and opened its value
// after it; a collaborator's later change of that run wrote its restore
// between the two, and an undo of the format change brought the removed item
// back before that restore, which then gave the next character the run's
// old value: a color, a link or a comment a collaborator removed came back
// on text that never had it. A format change keeps that item and opens its
// value after it (see Cursor#format).
describe('F31A-1: undo of a second value next to a first a collaborator removed', () => {
  const $line = () => $getRoot().getFirstChildOrThrow() as ElementNode;
  const $styles = () =>
    $line()
      .getAllTextNodes()
      .map(
        n =>
          `${JSON.stringify(n.getTextContent())}${n.getStyle() ? `[${n.getStyle()}]` : ''}`,
      )
      .join(' ');
  const cases: [string, () => void, () => void, () => void, () => string][] = [
    [
      'font color',
      () => $patchStyleText($selectLine(0, 2), {color: 'red'}),
      () => $patchStyleText($selectLine(2, 3), {color: 'blue'}),
      () => $patchStyleText($selectLine(0, 2), {color: null}),
      $styles,
    ],
    [
      'comments stored as one set',
      () => $addMarkID('s0', $selectLine(0, 2)),
      () => $addMarkID('s1', $selectLine(2, 3)),
      () => $removeMarkID('s0'),
      $runs,
    ],
  ];
  for (const [name, $first, $second, $clear, $show] of cases) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
      [2, 3, 1],
    ]) {
      test(`${name}: A sets "la", then the space; C clears "la"; A undoes the space (ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('la x')),
              $createParagraphNode().append($createTextNode('next')),
            ),
          {ids},
        );
        t.a.update($first);
        t.a.update($second);
        await t.sync();
        t.c.update($clear);
        await t.sync();
        t.a.undo();
        await t.sync();
        const fresh = await freshReader(t.a);
        const shown = [t.a, t.b, t.c, fresh].map(p => p.read($show));
        for (const view of shown) {
          expect(view).toBe(shown[0]);
        }
        expect(shown[0]).not.toMatch(/red|blue|s0|s1/);
      });
    }
  }
});

// F32A-1: an undo of a format change that kept the restores the change
// wrote after its range let a restore that restated another change's value
// outlive that change's undo: a word bolded, one letter unbolded and that
// undone, then the bold undone, left the rest of the word bold. An undo
// keeps only a null closer that still ends a value (see
// YBinding#isKeptByUndo), and a format change closes its range, where the
// change that gave the range its old value ends right after it, with that
// change's own closing value (see Cursor#format).
describe('F32A-1: undo after a collaborator changed part of the range and undid it', () => {
  const $line = () => $getRoot().getFirstChildOrThrow() as ElementNode;
  const $styles = () =>
    $getRoot()
      .getChildren()
      .map(p =>
        (p as ElementNode)
          .getAllTextNodes()
          .map(
            n =>
              `${JSON.stringify(n.getTextContent())}${n.getFormat() & 1 ? '[B]' : ''}${n.getStyle() ? `[${n.getStyle()}]` : ''}`,
          )
          .join(' '),
      )
      .join(' / ');
  const bold = (from: number, to: number, on: boolean) => () => {
    const sel = $selectLine(from, to);
    sel.format = on ? 0 : 1;
    $setSelection(sel);
    sel.formatText('bold');
    $setSelection(null);
  };
  const color = (from: number, to: number, value: string | null) => () =>
    $patchStyleText($selectLine(from, to), {color: value});
  const cases: [string, ('a' | 'b' | 'c' | [string, () => void])[], string][] =
    [
      [
        'A bolds "fghi"; B unbolds "g" and undoes; A undoes',
        [['a', bold(5, 9, true)], ['b', bold(6, 7, false)], 'b', 'a'],
        '"abcdefghijkl" / "next"',
      ],
      [
        'A colors "fghi" red; B colors "g" green and undoes; A undoes',
        [['a', color(5, 9, 'red')], ['b', color(6, 7, 'green')], 'b', 'a'],
        '"abcdefghijkl" / "next"',
      ],
      [
        'C bolds "i"; A unbolds it; C undoes; A undoes',
        [['c', bold(8, 9, true)], ['a', bold(8, 9, false)], 'c', 'a'],
        '"abcdefgh" "i"[B] "jkl" / "next"',
      ],
      [
        'A colors "ab" red; B colors "b" blue; A undoes',
        [['a', color(0, 2, 'red')], ['b', color(1, 2, 'blue')], 'a'],
        '"a" "b"[color: blue;] "cdefghijkl" / "next"',
      ],
    ];
  for (const [name, steps, expected] of cases) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      test(`${name} (ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('abcdefghijkl')),
              $createParagraphNode().append($createTextNode('next')),
            ),
          {ids},
        );
        for (const step of steps) {
          if (typeof step === 'string') {
            t[step].undo();
          } else {
            const peer = t[step[0] as 'a' | 'b' | 'c'];
            peer.binding.undoManager!.stopCapturing();
            peer.update(step[1]);
            peer.binding.undoManager!.stopCapturing();
          }
          await t.sync();
        }
        const fresh = await freshReader(t.a);
        const shown = [t.a, t.b, t.c, fresh].map(p => p.read($styles));
        for (const view of shown) {
          expect(view).toBe(shown[0]);
        }
        expect(shown[0]).toBe(expected);
        void $line;
      });
    }
  }
});

// A redo makes a new item of each item its undo deleted. The closers an
// undo keeps are known by their item (see Cursor#format and
// YBinding#isKeptByUndo), and a redo's copy of one lost that: a bold made,
// undone and redone, a collaborator's removal of it, then its undo and the
// removal's undo, left the rest of the document bold. A redo's copy of a
// closer is a closer (see YBinding#carryCloserMarks).
describe('undo after a redo of a format change', () => {
  const $styles = () =>
    $getRoot()
      .getChildren()
      .map(p =>
        (p as ElementNode)
          .getAllTextNodes()
          .map(
            n =>
              `${JSON.stringify(n.getTextContent())}${n.getFormat() & 1 ? '[B]' : ''}${n.getStyle() ? `[${n.getStyle()}]` : ''}`,
          )
          .join(' '),
      )
      .join(' / ');
  const bold = (from: number, to: number, on: boolean) => () => {
    const sel = $selectLine(from, to);
    sel.format = on ? 0 : 1;
    $setSelection(sel);
    sel.formatText('bold');
    $setSelection(null);
  };
  const color = (from: number, to: number, value: string | null) => () =>
    $patchStyleText($selectLine(from, to), {color: value});
  const cases: [
    string,
    (
      | 'a'
      | 'b'
      | 'c'
      | ['a' | 'b' | 'c', 'redo']
      | ['a' | 'b' | 'c', () => void]
    )[],
    string,
  ][] = [
    [
      'C bolds "i", undoes and redoes; A unbolds it; C undoes; A undoes',
      [
        ['c', bold(8, 9, true)],
        'c',
        ['c', 'redo'],
        ['a', bold(8, 9, false)],
        'c',
        'a',
      ],
      '"abcdefgh" "i"[B] "jkl" / "next"',
    ],
    [
      'A colors "ab" red, undoes and redoes; B colors "b" blue; A undoes',
      [
        ['a', color(0, 2, 'red')],
        'a',
        ['a', 'redo'],
        ['b', color(1, 2, 'blue')],
        'a',
      ],
      '"a" "b"[color: blue;] "cdefghijkl" / "next"',
    ],
  ];
  for (const [name, steps, expected] of cases) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      test(`${name} (ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('abcdefghijkl')),
              $createParagraphNode().append($createTextNode('next')),
            ),
          {ids},
        );
        for (const step of steps) {
          if (typeof step === 'string') {
            t[step].undo();
          } else if (step[1] === 'redo') {
            t[step[0]].binding.redo();
          } else {
            const peer = t[step[0]];
            peer.binding.undoManager!.stopCapturing();
            peer.update(step[1]);
            peer.binding.undoManager!.stopCapturing();
          }
          await t.sync();
        }
        const fresh = await freshReader(t.a);
        const shown = [t.a, t.b, t.c, fresh].map(p => p.read($styles));
        for (const view of shown) {
          expect(view).toBe(shown[0]);
        }
        expect(shown[0]).toBe(expected);
      });
    }
  }
});

// F23aLane seed 535: a format change of a space right before a run with its
// value ‖ a removal of that value from the run. The format change kept the
// run's opener as the item after its range and, taking that opener and the
// closer of the run before the space (one client wrote both, in one write)
// for the end and start of one change, closed its range with nothing; the
// removal deleted the run's opener, and the space's value ran on over the
// run. A format change takes an item after its range for the end of the
// change that gave its range the old value only where its walk over the
// range passed that change's item (see Cursor#format, rule 3).
describe("a format change before a run ‖ the run's value removed", () => {
  const $line = () => $getRoot().getFirstChildOrThrow() as ElementNode;
  const $show = () =>
    $line()
      .getAllTextNodes()
      .map(
        n =>
          `${JSON.stringify(n.getTextContent())}${n.getFormat() & 2 ? '[I]' : ''}`,
      )
      .join(' ');
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`italic "a", " b ", italic "cd"; A italicizes the space before "cd" ‖ B removes italic from "cd" (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('a').toggleFormat('italic'),
              $createTextNode(' b '),
              $createTextNode('cd').toggleFormat('italic'),
            ),
          ),
        {ids},
      );
      t.offline();
      t.a.update(() => {
        const sel = $selectLine(3, 4);
        $setSelection(sel);
        sel.formatText('italic');
        $setSelection(null);
      });
      t.b.update(() => {
        const sel = $selectLine(4, 6);
        sel.format = 2;
        $setSelection(sel);
        sel.formatText('italic');
        $setSelection(null);
      });
      await t.sync();
      const fresh = await freshReader(t.a);
      const shown = [t.a, t.b, fresh].map(p => p.read($show));
      for (const view of shown) {
        expect(view).toBe(shown[0]);
      }
      expect(shown[0]).toBe('"a"[I] " b" " "[I] "cd"');
    });
    // The items the format change itself writes are not another change's:
    // a comment added on a space right before a word whose comment the same
    // client added before closed its range with that comment, and a
    // collaborator's resolve of it left it on the word (F23aLane seed 659).
    test(`s0 on "b" by A; A comments the space before "b" ‖ B resolves s0 (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('a b')),
            $createParagraphNode().append($createTextNode('next')),
          ),
        {ids},
      );
      t.a.update(() => {
        $addMarkID('s0', $selectLine(2, 3));
        $setSelection(null);
      });
      await t.sync();
      t.offline();
      t.a.update(() => {
        $addMarkID('c1', $selectLine(1, 2));
        $setSelection(null);
      });
      t.b.update(() => {
        $removeMarkID('s0');
      });
      expect(await merged(t)).toBe('"a" " "[c1] "b" / "next"');
    });
  }
});

// F32aSeqUndo seed 1776, with clients taking turns: a format change of part
// of another client's range, ending where that range ends, then that
// client's undo. The format change kept the other change's restore as the
// item after its range and closed its range before it with the old value;
// the undo removed the restore, and that closer gave the next character,
// outside both ranges, the undone value. The item that gave the range its
// old value and the restore are of one client, which wrote no content
// between them: the format change takes the restore for that change's end
// (see Cursor#format, rule 3).
describe('a format change inside the end of another one, then its undo', () => {
  const $styles = () =>
    ($getRoot().getFirstChildOrThrow() as ElementNode)
      .getAllTextNodes()
      .map(
        n =>
          `${JSON.stringify(n.getTextContent())}${n.getStyle() ? `[${n.getStyle()}]` : ''}`,
      )
      .join(' ');
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`B blue [6,10), A green [4,9), B blue [5,9), A undoes (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('abcdefghijkl')),
          ),
        {ids},
      );
      const color =
        (peer: Peer, from: number, to: number, value: string) => async () => {
          peer.binding.undoManager!.stopCapturing();
          peer.update(() =>
            $patchStyleText($selectLine(from, to), {color: value}),
          );
          peer.binding.undoManager!.stopCapturing();
          await t.sync();
        };
      await color(t.b, 6, 10, 'blue')();
      await color(t.a, 4, 9, 'green')();
      await color(t.b, 5, 9, 'blue')();
      t.a.undo();
      await t.sync();
      const fresh = await freshReader(t.a);
      const shown = [t.a, t.b, fresh].map(p => p.read($styles));
      for (const view of shown) {
        expect(view).toBe(shown[0]);
      }
      expect(shown[0]).toBe('"abcde" "fghij"[color: blue;] "kl"');
    });
  }
});

// Issue #9493: an undo of a format change ‖ a collaborator's removal of the
// same change, and its undo. The collaborator's undo brought back the
// opener its removal had deleted, and the closer that ended that opener's
// run was the first change's, which its concurrent undo removed: the value
// ran on to the end of the document. A run an undo brings back ends with an
// item of the undoing client's own (see YBinding#closeRestoredRuns).
describe('an undo of a format change ‖ its removal by a collaborator, undone', () => {
  const $bold = () => {
    const sel = $selectLine(1, 2);
    sel.format = $text(0).getFormat();
    const node = ($getRoot().getFirstChildOrThrow() as ElementNode)
      .getAllTextNodes()
      .find(n => n.getTextContent().includes('y'));
    if (node !== undefined) {
      sel.format = node.getFormat();
    }
    $setSelection(sel);
    sel.formatText('bold');
    $setSelection(null);
  };
  // "y" keeps the value: the collaborator's undo brought it back.
  const cases: [string, () => void, () => void, string][] = [
    ['bold', $bold, $bold, '"x" "y"[B] "ab cd" / "ef"'],
    [
      'a comment',
      () => {
        $addMarkID('c1', $selectLine(1, 2));
        $setSelection(null);
      },
      () => $removeMarkID('c1'),
      '"x" "y"[c1] "ab cd" / "ef"',
    ],
  ];
  for (const [name, $add, $remove, expected] of cases) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      test(`${name} on "y" undone ‖ removed and that undone (ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('xyab cd')),
              $createParagraphNode().append($createTextNode('ef')),
            ),
          {ids},
        );
        t.a.update($add);
        await t.sync();
        t.offline();
        t.a.undo();
        t.c.update($remove);
        t.c.undo();
        await t.sync();
        const fresh = await freshReader(t.a);
        const shown = [t.a, t.b, t.c, fresh].map(p => p.read($runs));
        for (const view of shown) {
          expect(view).toBe(shown[0]);
        }
        expect(shown[0]).toBe(expected);
      });
    }
  }
});

// S7-24, S7-7, S7-10, S7-20, S7-26: a value one client restates (the restore
// after its typed text or its format range, or a value its undo brings back)
// ended at the closer of the change that gave it. The undo of that change by
// its author deleted the closer, and the restated value ran on to the end of
// the document. A run that one client restates now ends with an item of that
// client's own, right after the closer it relied on (see Cursor#restatedEnd
// and YBinding#closeRestoredRuns), for every kind of value: text formats,
// styles, NodeState and its set members, and links.
describe('a value one client restates ‖ the undo of the change that gave it', () => {
  const twoLines = (first: string, second: string) => () =>
    $getRoot().append(
      $createParagraphNode().append($createTextNode(first)),
      $createParagraphNode().append($createTextNode(second)),
    );
  // As the toolbar does: on where the first character lacks it, off otherwise.
  const $format =
    (format: 'bold' | 'italic' | 'underline', from: number, to: number) =>
    () => {
      const sel = $selectLine(from, to);
      sel.format = (sel.anchor.getNode() as TextNode).getFormat();
      $setSelection(sel);
      sel.formatText(format);
      $setSelection(null);
    };
  const $comment = (id: string, from: number, to: number) => () => {
    $addMarkID(id, $selectLine(from, to));
    $setSelection(null);
  };
  // Plain text typed at first-line offset `at`: a text node of its own, with
  // no format or NodeState (as a comment's end does not extend to it).
  const $typePlain = (at: number, text: string) => () => {
    let acc = 0;
    for (const node of (
      $getRoot().getFirstChildOrThrow() as ElementNode
    ).getAllTextNodes()) {
      const size = node.getTextContentSize();
      if (at <= acc + size) {
        const [before] = at - acc < size ? node.splitText(at - acc) : [node];
        before.insertAfter($createTextNode(text));
        return;
      }
      acc += size;
    }
    throw new Error('offset');
  };
  // Blocks pasted at first-line offset `at`.
  const $paste =
    (at: number, ...blocks: (() => LexicalNode)[]) =>
    () => {
      const sel = $selectLine(at, at);
      $setSelection(sel);
      sel.insertNodes(blocks.map(block => block()));
      $setSelection(null);
    };
  // Each line's links' text.
  const $links = () =>
    $getRoot()
      .getChildren()
      .map(p =>
        ($isElementNode(p) ? p.getChildren() : [])
          .filter($isLinkNode)
          .map(link => link.getTextContent())
          .join(' '),
      )
      .join(' / ');
  const $link = (from: number, to: number) => () => {
    $setSelection($selectLine(from, to));
    $toggleLink('https://u1.test');
    $setSelection(null);
  };
  const $list = () =>
    $createListNode('bullet').append(
      $createListItemNode().append($createTextNode('t20z t67z')),
      $createListItemNode().append($createTextNode('t23z')),
    );
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    // S7-24: A formats, then undoes, while B types inside the range.
    for (const [name, $add, expected] of [
      [
        'italic',
        $format('italic', 0, 9),
        '"t56z t85z" " t57z"[I] " t59z t60z" / "t78z t79z"',
      ],
      [
        'a comment',
        $comment('c1', 0, 9),
        '"t56z t85z" " t57z"[c1] " t59z t60z" / "t78z t79z"',
      ],
    ] as const) {
      test(`S7-24: A adds ${name} on "t56z t57z" and undoes it ‖ B types plain text after "t56z" (ids ${ids})`, async () => {
        const t = await setup(twoLines('t56z t57z t59z t60z', 't78z t79z'), {
          ids,
        });
        t.a.update($add);
        await t.sync();
        t.offline();
        t.a.undo();
        t.b.update($typePlain(4, ' t85z'));
        expect(await merged(t)).toBe(expected);
      });
    }
    // S7-7: a comment's undo ‖ plain text typed right after it, where
    // other values (a comment of a set's other member, bold) end too.
    for (const [name, $others, expected] of [
      [
        'another comment',
        [$comment('c5', 10, 14)],
        '"t31z t32z " "t33z"[c5] " t1012z t1008z" / "t34z t35z t1005z"',
      ],
      [
        'two other comments',
        [$comment('c5', 10, 14), $comment('c6', 0, 14)],
        '"t31z t32z "[c6] "t33z"[c5+c6] " t1012z t1008z" / "t34z t35z t1005z"',
      ],
      [
        'bold',
        [$format('bold', 10, 14)],
        '"t31z t32z " "t33z"[B] " t1012z t1008z" / "t34z t35z t1005z"',
      ],
    ] as const) {
      test(`S7-7: B comments "t32z t33z", where ${name} ends, and undoes it ‖ A types after "t33z" (ids ${ids})`, async () => {
        const t = await setup(
          twoLines('t31z t32z t33z t1008z', 't34z t35z t1005z'),
          {ids},
        );
        for (const $other of $others) {
          t.a.update($other);
        }
        await t.sync();
        t.b.update($comment('c4', 5, 14));
        await t.sync();
        t.offline();
        t.b.undo();
        t.a.update($typePlain(14, ' t1012z'));
        expect(await merged(t)).toBe(expected);
      });
    }
    // S7-10: a format's undo ‖ its removal from part of the range (the part
    // after it keeps the format, up to the end of the range), or from all of
    // it, and then the removal's undo (which brings the format back on the
    // range).
    for (const [format, tag] of [
      ['bold', 'B'],
      ['underline', 'U'],
    ] as const) {
      test(`S7-10: B ${format}s "t6z t7z t8z" and undoes it ‖ A removes it from "t7z" (ids ${ids})`, async () => {
        const t = await setup(twoLines('t5z t6z t7z t8z t9z', 'tail line'), {
          ids,
        });
        t.b.update($format(format, 4, 15));
        await t.sync();
        t.offline();
        t.a.update($format(format, 8, 11));
        t.b.undo();
        expect(await merged(t)).toBe(
          `"t5z t6z t7z" " t8z"[${tag}] " t9z" / "tail line"`,
        );
      });
      test(`S7-10: B ${format}s "t6z t7z t8z" and undoes it ‖ A removes it, then A undoes that (ids ${ids})`, async () => {
        const t = await setup(twoLines('t5z t6z t7z t8z t9z', 'tail line'), {
          ids,
        });
        t.b.update($format(format, 4, 15));
        await t.sync();
        t.offline();
        t.a.update($format(format, 4, 15));
        t.b.undo();
        await t.sync();
        t.a.undo();
        expect(await merged(t)).toBe(
          `"t5z " "t6z t7z t8z"[${tag}] " t9z" / "tail line"`,
        );
      });
    }
    test(`S7-10: B comments "t9z" and undoes it ‖ A resolves it, then A undoes that (ids ${ids})`, async () => {
      const t = await setup(twoLines('t5z t6z t7z t8z t9z', 'tail line'), {
        ids,
      });
      t.b.update($comment('c2', 16, 19));
      await t.sync();
      t.offline();
      t.a.update(() => $removeMarkID('c2'));
      t.b.undo();
      await t.sync();
      t.a.undo();
      expect(await merged(t)).toBe(
        '"t5z t6z t7z t8z " "t9z"[c2] / "tail line"',
      );
    });
    // The nulls an undo writes after itself (see closeRestoredRuns) are read
    // as part of that undo: the selection it puts back stays, also where the
    // undo runs inside an editor update (as UNDO_COMMAND's handler does).
    for (const nested of [false, true]) {
      test(`S7-10: A's undo of a removal of B's undone bold puts back A's selection (${nested ? 'inside an update' : 'direct'}, ids ${ids})`, async () => {
        const t = await setup(twoLines('t5z t6z t7z t8z t9z', 'tail line'), {
          ids,
        });
        t.b.update(() => {
          $selectIn([0], 4, 15).formatText('bold');
          $setSelection(null);
        });
        await t.sync();
        t.offline();
        t.a.update(() => void $selectIn([0], 4, 15));
        t.a.update(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel)) {
            throw new Error('no range selection');
          }
          sel.format = 1;
          sel.formatText('bold');
          $selectIn([0], 0, 0);
        });
        t.b.undo();
        await t.sync();
        if (nested) {
          t.a.editor.update(() => void t.a.binding.undo(), {discrete: true});
        } else {
          t.a.binding.undo();
        }
        const offsets = t.a.read(() => {
          const sel = $getSelection();
          const texts = $getRoot().getAllTextNodes();
          const at = (key: string, offset: number) => {
            let acc = 0;
            for (const text of texts) {
              if (text.getKey() === key) {
                return acc + offset;
              }
              acc += text.getTextContentSize();
            }
            return -1;
          };
          return $isRangeSelection(sel)
            ? [
                at(sel.anchor.key, sel.anchor.offset),
                at(sel.focus.key, sel.focus.offset),
              ]
            : null;
        });
        expect(offsets).toEqual([4, 15]);
        expect(await merged(t)).toBe(
          '"t5z " "t6z t7z t8z"[B] " t9z" / "tail line"',
        );
      });
    }
    // S7-20: a comment's undo ‖ a list pasted inside the commented words.
    test(`S7-20: A comments "t59z t60z t61z" and undoes it ‖ B pastes a list after "t60z" (ids ${ids})`, async () => {
      const t = await setup(twoLines('t58z t59z t60z t61z t62z', 't78z t79z'), {
        ids,
      });
      t.a.update($comment('c9', 5, 19));
      await t.sync();
      t.offline();
      t.a.undo();
      t.b.update($paste(14, $list));
      expect(await merged(t)).toBe(
        '"t58z t59z t60z" / "t20z t67z" "t23z" / " t61z"[c9] " t62z" / "t78z t79z"',
      );
    });
    // S7-26: a link's undo ‖ a format change over the link's start, which
    // also sets the link's textFormat (RangeSelection#formatText). That
    // write restated the link over its text and kept it there; a link's
    // textFormat is no longer stored while it has text (#9597), so the
    // format change writes no link and B's undo removes it on every peer.
    for (const format of ['italic', 'bold'] as const) {
      test(`S7-26: B links "t7z t8z t9z" and undoes it ‖ A makes "t5z t6z t7z" ${format} (ids ${ids})`, async () => {
        const t = await setup(
          twoLines('t1z t2z t3z t4z t5z t6z t7z t8z t9z', 'tail line'),
          {ids},
        );
        t.b.update(() => {
          $setSelection($selectLine(24, 35));
          $toggleLink('https://u0.test');
          $setSelection(null);
        });
        await t.sync();
        t.offline();
        t.a.update($format(format, 16, 27));
        t.b.undo();
        await merged(t);
        const fresh = await freshReader(t.a);
        for (const p of [t.a, t.b, fresh]) {
          expect(p.read($links)).toBe(' / ');
        }
      });
    }
  }
  // S7-26, links only: the run a write opens ends at another client's
  // change end, which it reuses as its own closer: it gets a null of its own
  // after it too, so that change's undo does not take the run's end away.
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
  ]) {
    test(`S7-26: B links "t2z t3z t4z" ‖ C links "t3z"; then B undoes it ‖ C links "t2z t3z t4z" (ids ${ids})`, async () => {
      const t = await setup(
        twoLines('t1z t2z t3z t4z t5z t6z t7z t8z t9z', 'tail line'),
        {ids},
      );
      t.offline();
      t.b.update($link(4, 15));
      t.c.update($link(8, 11));
      await t.sync();
      t.offline();
      t.b.undo();
      t.c.update($link(4, 15));
      await merged(t);
      const fresh = await freshReader(t.a);
      for (const p of [t.a, t.b, t.c, fresh]) {
        expect(p.read($links)).toBe('t3z t4z / ');
      }
    });
  }
});

// The undo race matrix of soak7: A adds bold or a comment on "t56z t57z"
// and removes it (an undo, or the opposite change) while B edits inside the
// range. Nothing outside the range gets the value.
describe('a format or comment removed ‖ an edit inside its range', () => {
  const $outside = () =>
    $getRoot()
      .getAllTextNodes()
      .filter(
        n =>
          /t(59|60|78|79)z/.test(n.getTextContent()) &&
          (n.hasFormat('bold') ||
            ((n.exportJSON() as {$?: {markIds?: string[]}}).$?.markIds ?? [])
              .length > 0),
      )
      .map(n => n.getTextContent());
  const $at = (at: number) => {
    const sel = $selectLine(at, at);
    $setSelection(sel);
    return sel;
  };
  const edits: [string, () => void][] = [
    [
      'types plain text',
      () => {
        const sel = $at(4);
        sel.format = 0;
        sel.insertText(' t85z');
      },
    ],
    ['presses Enter', () => void $at(4).insertParagraph()],
    [
      'pastes two paragraphs',
      () =>
        void $at(4).insertNodes([
          $createParagraphNode().append($createTextNode('t20z')),
          $createParagraphNode().append($createTextNode('t23z')),
        ]),
    ],
    [
      'pastes a list',
      () =>
        void $at(4).insertNodes([
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('t20z')),
            $createListItemNode().append($createTextNode('t23z')),
          ),
        ]),
    ],
    ['deletes "t56z"', () => void $selectLine(0, 5).removeText()],
  ];
  const kinds: [string, () => void, () => void][] = [
    [
      'bold',
      () => $selectLine(0, 9).formatText('bold'),
      () => {
        const sel = $selectLine(0, 9);
        sel.format = 1;
        sel.formatText('bold');
      },
    ],
    [
      'a comment',
      () => $addMarkID('c1', $selectLine(0, 9)),
      () => $removeMarkID('c1'),
    ],
  ];
  for (const [kind, $add, $remove] of kinds) {
    for (const undo of [true, false]) {
      for (const [edit, $edit] of edits) {
        for (const ids of [
          [1, 2],
          [2, 1],
        ]) {
          test(`A adds ${kind} on "t56z t57z" and ${undo ? 'undoes it' : 'removes it'} ‖ B ${edit} after "t56z" (ids ${ids})`, async () => {
            const t = await setup(
              () =>
                $getRoot().append(
                  $createParagraphNode().append(
                    $createTextNode('t56z t57z t59z t60z'),
                  ),
                  $createParagraphNode().append($createTextNode('t78z t79z')),
                ),
              {ids},
            );
            t.a.update(() => {
              $add();
              $setSelection(null);
            });
            await t.sync();
            t.offline();
            if (undo) {
              t.a.undo();
            } else {
              t.a.update(() => {
                $remove();
                $setSelection(null);
              });
            }
            t.b.update(() => {
              $edit();
              $setSelection(null);
            });
            await merged(t);
            expect(t.a.read($outside)).toEqual([]);
          });
        }
      }
    }
  }
});

// L1B-1: J typed plain text right after a word two comments cover, which
// ends each comment with a null of J's own after the end its author wrote
// (see Cursor#format, rule 5). C pasted over J's word, and the delete
// collapsed the format items after it keeping only J's null of the first
// comment; J's concurrent undo of its typing deleted that null, and the
// comment covered the rest of the document.
describe('L1B-1: undo of plain text typed after a word two comments cover ‖ a paste over that text', () => {
  for (const ids of [
    [1, 2, 3, 4],
    [4, 3, 2, 1],
    [2, 4, 1, 3],
    [3, 1, 4, 2],
  ]) {
    for (const sameClient of [true, false]) {
      test(`L1B-1: the comments end after the word, from ${sameClient ? 'one client' : 'two clients'} (ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('t1z t2')),
              $createParagraphNode().append($createTextNode('t3z')),
            ),
          {ids},
        );
        const [a, b, c, j] = t.peers;
        const $comment = (id: string) => () => {
          $addMarkID(id, $selectLine(0, 3));
          $setSelection(null);
        };
        a.update($comment('c4'));
        await t.sync();
        (sameClient ? a : b).update($comment('c12'));
        await t.sync();
        for (const peer of t.peers) {
          peer.binding.undoManager?.clear();
        }
        // Plain text typed right after "t1z", a text node of its own.
        j.update(() => {
          const [word] = (
            $getRoot().getFirstChildOrThrow() as ElementNode
          ).getAllTextNodes();
          word.splitText(3)[0].insertAfter($createTextNode(' t1011z'));
        });
        await t.sync();
        t.offline();
        j.undo();
        c.update(() => {
          const sel = $selectLine(4, 10);
          $setSelection(sel);
          sel.insertText('t1013z');
          $setSelection(null);
        });
        expect(await merged(t)).toBe('"t1zt1013z"[c12+c4] " t2" / "t3z"');
      });
    }
  }
});
