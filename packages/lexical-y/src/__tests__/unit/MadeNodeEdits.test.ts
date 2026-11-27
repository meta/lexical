/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Nodes an update makes, and edits on either side of nodes it keeps, are
// written where they are (soak A5):
// - S5-2: a text node made next to an edited one, with its format, which
//   Lexical merges into it, was written as a rewrite of the whole node;
// - S5-5: the same with the caret put inside the made text (a snippet
//   insert) wrote the new text shifted into the equal text before it;
// - a rich paste over a selection ($insertNodes of a text node) rewrote the
//   node;
// - S5-3: two edits on either side of an untouched line break or inline
//   node were written as one rewrite of everything between them;
// - S5-4: a line break typed or inserted right before another was written
//   after it;
// - a node set whole by setTextContent made the node it merged with be
//   rewritten too;
// - a part a transform cuts out of a text node and makes again with its own
//   text (the hashtag plugin, a keyword) was written as new text, which two
//   collaborators editing next to a stored hashtag at once duplicated
//   (R17A-1);
// - text sets next to nodes made or removed in the same update: a hashtag
//   grown over a removed neighbour after a made node merged into it kept the
//   wrong old character (R19A-1); a node made next to a node set whole, or
//   pasted text that grows a stored hashtag (two nodes set whole), wrote the
//   set node's old text anew (R19A-2, R19B-F1).
// In each, a peer's concurrent delete of an untouched character came back,
// or its typing landed elsewhere.

import {
  $createHashtagNode,
  HashtagNode,
  registerLexicalHashtag,
} from '@lexical/hashtag';
import {$createLinkNode} from '@lexical/link';
import * as Y from '@y/y';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $insertNodes,
  $isLineBreakNode,
  $setSelection,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $createEquation,
  freshReader,
  NODES,
  type Peer,
  setup,
} from '../utils/harness';

const $line = () => $getRoot().getChildAtIndex(1) as ElementNode;
const $text = (i = 0) => $line().getAllTextNodes()[i] as TextNode;
const lineText = (p: Peer) => p.read(() => $line().getTextContent());

/** The text a peer's local transactions insert and delete. */
function track(doc: Y.Doc): {ins: string; del: string} {
  const w = {del: '', ins: ''};
  doc.on('afterTransaction', (tr: Y.Transaction) => {
    if (!tr.local) {
      return;
    }
    Y.iterateStructsByIdSet(tr, tr.insertSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
        w.ins += s.content.str;
      }
    });
    Y.iterateStructsByIdSet(tr, tr.deleteSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
        w.del += s.content.str;
      }
    });
  });
  return w;
}

const sorted = (s: string) => [...s].sort().join('');

async function line(children: () => LexicalNode[], ids = [1, 2]) {
  return setup(
    () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Title')),
        $createParagraphNode().append(...children()),
      );
    },
    {ids},
  );
}

/** B deletes the character at `at` of line 1's first text node. */
function $deleteAt(at: number) {
  $text().spliceText(at, 1, '', false);
  $setSelection(null);
}

describe('a node made next to an edited one, merged into it (S5-2, S5-5)', () => {
  const edits: [string, () => void][] = [
    [
      'splice, then a node made after',
      () => {
        $setSelection(null);
        $text().spliceText(2, 0, 'X', false);
        $text().insertAfter($createTextNode('Y'));
      },
    ],
    [
      'a node made after, then splice',
      () => {
        $setSelection(null);
        $text().insertAfter($createTextNode('Y'));
        $text().spliceText(2, 0, 'X', false);
      },
    ],
    [
      'caret typing, then a node made after',
      () => {
        $text().select(2, 2).insertText('X');
        $text().insertAfter($createTextNode('Y'));
      },
    ],
  ];
  for (const [name, edit] of edits) {
    test(`${name}: writes only the new characters, a peer's delete stays`, async () => {
      const t = await line(() => [$createTextNode('abcdef')]);
      const w = track(t.a.doc);
      t.offline();
      t.a.update(edit);
      expect([w.del, sorted(w.ins)]).toEqual(['', 'XY']);
      t.b.update(() => $deleteAt(0));
      await t.sync();
      expect(lineText(t.a)).toBe('bXcdefY');
      expect(lineText(t.b)).toBe('bXcdefY');
    });
  }

  test('the caret put inside the made text: a peer deletes the old "b"', async () => {
    const t = await line(() => [$createTextNode('xab')]);
    t.offline();
    t.a.update(() => {
      const made = $createTextNode('ab');
      $text().insertAfter(made);
      made.select(1, 1);
    });
    t.b.update(() => $deleteAt(2));
    await t.sync();
    expect(lineText(t.a)).toBe('xaab');
    expect(lineText(t.b)).toBe('xaab');
  });

  test('a rich paste over a selection: a peer deletes "f"', async () => {
    const t = await line(() => [$createTextNode('abcdef')]);
    const w = track(t.a.doc);
    t.offline();
    t.a.update(() => {
      const n = $text();
      const s = $createRangeSelection();
      s.anchor.set(n.getKey(), 1, 'text');
      s.focus.set(n.getKey(), 3, 'text');
      $setSelection(s);
      $insertNodes([$createTextNode('XY')]);
    });
    expect([sorted(w.del), sorted(w.ins)]).toEqual(['bc', 'XY']);
    t.b.update(() => $deleteAt(5));
    await t.sync();
    expect(lineText(t.a)).toBe('aXYde');
    expect(lineText(t.b)).toBe('aXYde');
  });
});

describe('edits on either side of a line break or an inline node (S5-3)', () => {
  for (const mid of ['line break', 'inline node'] as const) {
    test(`${mid}: two splices write only their characters, a peer's delete stays`, async () => {
      const t = await line(() => [
        $createTextNode('abc'),
        mid === 'line break' ? $createLineBreakNode() : $createEquation('e'),
        $createTextNode('def'),
      ]);
      const w = track(t.a.doc);
      t.offline();
      t.a.update(() => {
        $setSelection(null);
        $text(0).spliceText(1, 0, 'X', false);
        $text(1).spliceText(1, 0, 'Y', false);
      });
      expect([w.del, sorted(w.ins)]).toEqual(['', 'XY']);
      t.b.update(() => $deleteAt(2));
      await t.sync();
      const out = mid === 'line break' ? 'aXb\ndYef' : 'aXbdYef';
      expect(lineText(t.a)).toBe(out);
      expect(lineText(t.b)).toBe(out);
    });
  }
});

describe('a line break made before another (S5-4)', () => {
  const how: [string, () => void][] = [
    [
      'typed, the caret kept',
      () => {
        $text().select(2, 2).insertLineBreak();
      },
    ],
    [
      'inserted by app code, no caret',
      () => {
        $setSelection(null);
        $line()
          .getChildren()
          .find($isLineBreakNode)!
          .insertBefore($createLineBreakNode());
      },
    ],
  ];
  for (const [name, edit] of how) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      test(`${name} (client ids ${ids}): a peer typing after the old break stays on its line`, async () => {
        const t = await line(
          () => [
            $createTextNode('ab'),
            $createLineBreakNode(),
            $createTextNode('cd'),
          ],
          ids,
        );
        t.offline();
        t.a.update(edit);
        t.b.update(() => {
          $text(1).select(0, 0).insertText('Z');
          $setSelection(null);
        });
        await t.sync();
        expect(lineText(t.a)).toBe('ab\n\nZcd');
        expect(lineText(t.b)).toBe('ab\n\nZcd');
      });
    }
  }
});

test('a node set whole keeps the node it merges with', async () => {
  const t = await line(() => [
    $createTextNode('ab').toggleFormat('bold'),
    $createLineBreakNode(),
    $createTextNode('a X').toggleFormat('bold'),
  ]);
  t.offline();
  t.a.update(() => {
    $setSelection(null);
    $text(1).setTextContent('a ');
    $line().getChildren().find($isLineBreakNode)!.remove();
  });
  t.b.update(() => $deleteAt(0));
  await t.sync();
  expect(lineText(t.a)).toBe('ba ');
  expect(lineText(t.b)).toBe('ba ');
});

/** A keyword highlighter: makes every `KEY` again as a bold node. */
function registerKeyword(editor: LexicalEditor) {
  return editor.registerNodeTransform(TextNode, node => {
    const at = node.getTextContent().indexOf('KEY');
    if (!node.isSimpleText() || node.hasFormat('bold') || at < 0) {
      return;
    }
    const part = node.splitText(at, at + 3)[at === 0 ? 0 : 1];
    part.replace($createTextNode(part.getTextContent()).toggleFormat('bold'));
  });
}

describe('a part a transform makes again with its own text (R17A-1)', () => {
  const cases: [string, string, number, string, number, string][] = [
    // [plugin, line, typed at, typed, peer deletes at, expected]
    ['hashtag', 'hello #fo', 9, 'o', 7, 'hello #oo'],
    ['hashtag', 'say #fo now', 7, 'o', 5, 'say #oo now'],
    ['keyword', 'a KE', 4, 'Y', 2, 'a EY'],
  ];
  for (const [plugin, text, at, typed, del, expected] of cases) {
    test(`${plugin}: "${text}" + "${typed}": every old character keeps its item`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Title')),
            $createParagraphNode().append($createTextNode(text)),
          );
        },
        {nodes: [...NODES, HashtagNode]},
      );
      for (const p of t.peers) {
        if (plugin === 'hashtag') {
          registerLexicalHashtag(p.editor);
        } else {
          registerKeyword(p.editor);
        }
      }
      const w = track(t.a.doc);
      t.offline();
      t.a.update(() => {
        $text().select(at, at).insertText(typed);
      });
      expect([w.del, w.ins]).toEqual(['', typed]);
      t.b.update(() => $deleteAt(del));
      await t.sync();
      const fresh = await freshReader(t.a, [...NODES, HashtagNode]);
      expect(lineText(t.a)).toBe(expected);
      expect(lineText(t.b)).toBe(expected);
      expect(lineText(fresh)).toBe(expected);
      fresh.stop();
    });
  }

  test('two clients edit next to a hashtag at once: it stays once', async () => {
    const t = await setup(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Title')),
          $createParagraphNode().append($createTextNode('t4z #t4z ')),
        );
      },
      {nodes: [...NODES, HashtagNode]},
    );
    t.peers.forEach(p => registerLexicalHashtag(p.editor));
    t.offline();
    t.a.update(() => {
      $text().select(1, 1).insertText('o');
    });
    t.b.update(() => {
      $text().select(8, 9).removeText();
      $setSelection(null);
    });
    await t.sync();
    expect(lineText(t.a)).toBe('to4z #t4z');
    expect(lineText(t.b)).toBe('to4z #t4z');
  });
});

describe('text sets resolved with all the text that left (R19A-1, R19A-2, R19B-F1)', () => {
  const HASHTAG = [...NODES, HashtagNode];

  // A node made before "b" (a paste, or app code without a caret) merges
  // into it; the hashtag plugin makes it a hashtag and grows it over the
  // bold "ab" after it (a text set, and "ab" removed): "bab" are old.
  for (const paste of [false, true]) {
    for (const [peer, expected] of [
      ['types between "b" and "ab"', 'la #agbZab'],
      ['deletes the first "b"', 'la #agab'],
    ] as const) {
      test(`${paste ? 'a paste' : 'no caret'}: a hashtag grown over a removed neighbour, a peer ${peer}`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('Title')),
              $createParagraphNode().append(
                $createLinkNode('https://x.y/').append($createTextNode('la ')),
                $createTextNode('b'),
                $createTextNode('ab').toggleFormat('bold'),
              ),
            );
          },
          {nodes: HASHTAG},
        );
        t.peers.forEach(p => registerLexicalHashtag(p.editor));
        t.offline();
        t.a.update(() => {
          if (paste) {
            $text(1)
              .select(0, 0)
              .insertNodes([$createTextNode('#ag')]);
          } else {
            $setSelection(null);
            $text(1).insertBefore($createTextNode('#ag'));
          }
        });
        t.b.update(() => {
          if (expected === 'la #agbZab') {
            $text(1).select(1, 1).insertText('Z');
          } else {
            $text(1).select(0, 1).removeText();
          }
          $setSelection(null);
        });
        await t.sync();
        const fresh = await freshReader(t.a, HASHTAG);
        expect([t.a, t.b, fresh].map(lineText)).toEqual([
          expected,
          expected,
          expected,
        ]);
        fresh.stop();
      });
    }
  }

  test("a node set whole and a node made after it: a peer's delete stays", async () => {
    const t = await line(() => [$createTextNode('one two')]);
    t.offline();
    t.a.update(() => {
      $setSelection(null);
      $text().setTextContent('one twoX');
      $text().insertAfter($createTextNode('NEW').toggleFormat('bold'));
    });
    t.b.update(() => $deleteAt(1));
    await t.sync();
    expect(lineText(t.a)).toBe('oe twoXNEW');
    expect(lineText(t.b)).toBe('oe twoXNEW');
  });

  // The paste merges with " tail"; the plugin moves "la" into the hashtag
  // and sets the pasted node to the rest: two nodes set whole.
  for (const how of ['insertRawText', 'insertNodes'] as const) {
    for (const [what, expected] of [
      ['the hashtag', 'say #oola  tail'],
      ['the tail', 'say #foola  ail'],
    ] as const) {
      test(`${how} grows a stored hashtag: a peer deletes in ${what}`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('Title')),
              $createParagraphNode().append(
                $createTextNode('say '),
                $createHashtagNode('#foo'),
                $createTextNode(' tail'),
              ),
            );
          },
          {nodes: HASHTAG},
        );
        t.peers.forEach(p => registerLexicalHashtag(p.editor));
        const w = track(t.a.doc);
        t.offline();
        t.a.update(() => {
          const sel = $text(1).select(4, 4);
          if (how === 'insertRawText') {
            sel.insertRawText('la ');
          } else {
            sel.insertNodes([$createTextNode('la ')]);
          }
          $setSelection(null);
        });
        expect([w.del, sorted(w.ins)]).toEqual(['', sorted('la ')]);
        t.b.update(() => {
          $text(what === 'the hashtag' ? 1 : 2)
            .select(1, 2)
            .removeText();
          $setSelection(null);
        });
        await t.sync();
        const fresh = await freshReader(t.a, HASHTAG);
        expect([t.a, t.b, fresh].map(lineText)).toEqual([
          expected,
          expected,
          expected,
        ]);
        fresh.stop();
      });
    }
  }

  test("a node removed before a node set whole: the set keeps its own text, a peer's delete stays", async () => {
    const t = await line(() => [
      $createTextNode('xyz ').toggleFormat('bold'),
      $createTextNode('one two'),
    ]);
    t.offline();
    t.a.update(() => {
      $setSelection(null);
      $text(0).remove();
      $text(0).setTextContent('one twoX');
    });
    t.b.update(() => {
      $text(1).spliceText(1, 1, '', false);
      $setSelection(null);
    });
    await t.sync();
    expect(lineText(t.a)).toBe('oe twoX');
    expect(lineText(t.b)).toBe('oe twoX');
  });
});
