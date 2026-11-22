/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A line's text nodes made again with other text (an agent rewriting a
// block from its JSON, a highlighter making the tokens of a line again): the
// text of the nodes made keeps the common start and end it shares with the
// line's text as it was, by character, as the same Yjs items, as
// y-prosemirror does for a text run. A collaborator's concurrent letter in
// an unchanged word stays in that word, and a character a collaborator
// deleted stays deleted, also when the delete reached the writer before its
// editor read it (S9-7, #9556). A replacement still keeps whole words, so
// two concurrent replacements of one token keep both tokens whole.

import {$createLinkNode, LinkExtension} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $parseSerializedNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  createYDoc,
  createYWriter,
  editYState,
  type HeadlessYConfig,
  readYState,
  seedYState,
} from '../../headless';
import {
  $createEquation,
  $selectIn,
  expectConverged,
  flush,
  freshReader,
  type Peer,
  setup,
} from '../utils/harness';

const $line = () => $getRoot().getChildAtIndex(1) as ElementNode;
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

/** Every peer and a fresh reader show `expected` (one of them, if many). */
async function expectEverywhere(peers: Peer[], expected: string | string[]) {
  const fresh = await freshReader(peers[0]);
  const texts = [...peers, fresh].map(lineText);
  if (Array.isArray(expected)) {
    expect(expected).toContain(texts[0]);
  }
  expect(texts).toEqual(
    texts.map(() => (Array.isArray(expected) ? texts[0] : expected)),
  );
  await expectConverged(peers);
  for (const p of peers) {
    expect(p.warnings).toEqual([]);
  }
}

const IDS = [
  [1, 2],
  [2, 1],
];

const $bold = (text: string) => $createTextNode(text).toggleFormat('bold');
const $italic = (text: string) => $createTextNode(text).toggleFormat('italic');
const $plain = (text: string) => $createTextNode(text);

/** A title line, then a line holding `nodes`. */
const $doc = (nodes: () => LexicalNode[]) => () => {
  $getRoot().append(
    $createParagraphNode().append($createTextNode('Title')),
    $createParagraphNode().append(...nodes()),
  );
};

/** The line's children removed, and `texts` made in their place. */
const $remake =
  (...texts: string[]) =>
  () => {
    for (const child of $line().getChildren()) {
      child.remove();
    }
    $line().append(...texts.map(text => $createTextNode(text)));
    $setSelection(null);
  };

describe('S9-7: a line made again with one word changed keeps its other words', () => {
  // The line's text nodes, the word changed and its new text, where the
  // peer edits (a text node, the offset it types "Q" at, the offset of the
  // character it deletes), and the line after each edit.
  const cases: [
    string,
    () => LexicalNode[],
    string,
    string,
    [number, number, number],
    string,
    string,
  ][] = [
    [
      'one node',
      () => [$plain('t63 t71z t13z t69z t15z')],
      't69z',
      't81z',
      [0, 3, 5],
      't63Q t71z t13z t81z t15z',
      't63 t1z t13z t81z t15z',
    ],
    [
      'three nodes, the word in a bold one',
      () => [$plain('t12z '), $bold('t13z t69z'), $plain(' t15z')],
      't69z',
      't81z',
      [1, 2, 2],
      't12z t1Q3z t81z t15z',
      't12z t1z t81z t15z',
    ],
    [
      'three nodes made again as two',
      () => [$plain('t12z '), $bold('t13z t69z'), $plain(' t15z')],
      't69z',
      't81z',
      [2, 3, 2],
      't12z t13z t81z t1Q5z',
      't12z t13z t81z t5z',
    ],
  ];
  for (const [
    name,
    nodes,
    word,
    next,
    [node, at, del],
    typed,
    deleted,
  ] of cases) {
    for (const edit of ['types', 'deletes'] as const) {
      for (const ids of IDS) {
        test(`${name}: the peer ${edit} in an unchanged word (ids ${ids})`, async () => {
          const t = await setup($doc(nodes), {ids});
          const writes = track(t.a.doc);
          t.offline();
          t.a.update(() => {
            const text = $line().getTextContent().replace(word, next);
            if (name.endsWith('as two')) {
              const cut = text.indexOf(next) + next.length;
              $remake(text.slice(0, cut), text.slice(cut))();
            } else {
              $remake(text)();
            }
          });
          const written = {...writes};
          t.b.update(() => {
            const text = $line().getAllTextNodes()[node];
            if (edit === 'types') {
              text.spliceText(at, 0, 'Q', false);
            } else {
              text.spliceText(del, 1, '', false);
            }
            $setSelection(null);
          });
          await t.sync();
          await expectEverywhere(t.peers, edit === 'types' ? typed : deleted);
          // Only the changed word is written.
          expect(written).toEqual({del: word, ins: next});
        });
      }
    }
  }
});

// soak9 L2 S9-7 (seed C:8318741), through the headless API: an agent whose
// state lacks a collaborator's last typed letter makes the line again with
// one word changed. The letter stays in its word.
describe('S9-7: a stale agent rewrite keeps a collaborator letter typed into an unchanged word', () => {
  const config: HeadlessYConfig = {
    extensions: [RichTextExtension, LinkExtension],
    onWarn: () => {},
    schemaVersion: 1,
  };
  const text = (state: Uint8Array) =>
    readYState(state, config, () =>
      $getRoot().getChildren()[0].getTextContent(),
    );
  const edit = (state: Uint8Array, who: string, fn: () => void) =>
    editYState(state, config, fn, {writer: createYWriter(who)});
  const $rewrite = (from: string, to: string) => () => {
    const block = $getRoot().getFirstChild() as ElementNode;
    const next = block.getTextContent().replace(from, to);
    for (const child of block.getChildren()) {
      child.remove();
    }
    block.append($createTextNode(next));
  };
  /** Inserts `s` at offset `off` of the first occurrence of `token`. */
  const $insertAt = (token: string, off: number, s: string) => () => {
    const block = $getRoot().getFirstChild() as ElementNode;
    const start = block.getTextContent().indexOf(token) + off;
    let acc = 0;
    for (const leaf of block.getAllTextNodes()) {
      const len = leaf.getTextContentSize();
      if (start <= acc + len) {
        leaf.spliceText(start - acc, 0, s, false);
        return;
      }
      acc += len;
    }
  };
  const $splice = (victim: string, next: string) => () => {
    for (const leaf of $getRoot().getAllTextNodes()) {
      const at = leaf.getTextContent().indexOf(victim);
      if (at >= 0) {
        leaf.spliceText(at, victim.length, next, false);
        return;
      }
    }
  };
  for (const who of ['seed', 'other writer']) {
    for (const where of ['start', 'middle']) {
      test(`one text node, "t63" typed at the ${where} by ${who}, then its "z" racing a stale rewrite`, () => {
        let s = seedYState(config, () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode(
                who === 'seed'
                  ? where === 'start'
                    ? 't63t71z t13z t69z t15z'
                    : 't71z t63t13z t69z t15z'
                  : 't71z t13z t69z t15z',
              ),
            ),
          );
        });
        if (who !== 'seed') {
          s = edit(
            s,
            'p1',
            where === 'start'
              ? $insertAt('t71z', 0, 't63')
              : $insertAt('t13z', 0, 't63'),
          ).state;
        }
        const before = text(s);
        const relay = edit(s, 'p1b', $insertAt('t63', 3, 'z'));
        const stale = edit(s, 'stale-agent', $rewrite('t69z', 't81z'));
        const doc = createYDoc(relay.state);
        Y.applyUpdate(doc, stale.update!);
        expect(text(Y.encodeStateAsUpdate(doc))).toBe(
          before.replace('t63', 't63z').replace('t69z', 't81z'),
        );
      });
    }
  }
  for (const linked of [false, true]) {
    for (const history of ['plain', 'rewritten before']) {
      test(`${linked ? 'linked word' : 'plain line'}, ${history}`, () => {
        let s = seedYState(config, () => {
          const p = $createParagraphNode();
          p.append($createTextNode('t12z '));
          if (linked) {
            p.append(
              $createLinkNode('https://c.test/000').append(
                $createTextNode('t13z t14z'),
              ),
            );
          } else {
            p.append($createTextNode('t13z t14z'));
          }
          p.append($createTextNode(' t15z'));
          $getRoot().append(p);
        });
        s =
          history === 'rewritten before'
            ? edit(s, 'fresh-agent', $rewrite('t14z', 't69z')).state
            : edit(s, 'w', $splice('t14z', 't69z')).state;
        s = edit(s, 'b', $splice('t12z', 't71z')).state;
        s = edit(s, 'p1', () => {
          const first = (
            $getRoot().getFirstChild() as ElementNode
          ).getFirstChild() as TextNode;
          first.spliceText(0, 0, ' t63', false);
        }).state;
        expect(text(s)).toBe(' t63t71z t13z t69z t15z');
        // p1 types its last letter; a stale agent rewrites the block from
        // the state before it.
        const relay = edit(s, 'p1b', $insertAt('t63', 3, 'z'));
        expect(text(relay.state)).toBe(' t63zt71z t13z t69z t15z');
        const stale = edit(s, 'stale-agent', $rewrite('t69z', 't81z'));
        const doc = createYDoc(relay.state);
        Y.applyUpdate(doc, stale.update!);
        expect(text(Y.encodeStateAsUpdate(doc))).toBe(
          ' t63zt71z t13z t81z t15z',
        );
      });
    }
  }
});

// The rows a review of #9565 found glued or lost there (that change took a
// removed node's edge character for the new text's): the common start and
// end stop at the first character that differs, a separator alone is not
// kept, and these merge as on main.
describe('a separator of the old line is not taken for the new text', () => {
  const ROWS: {
    name: string;
    seed: () => LexicalNode[];
    a: string;
    b: (leaves: TextNode[]) => void;
    expected: string;
  }[] = [
    {
      a: 'truly believable results',
      b: ([note]) => note.remove(),
      expected: 'truly believable results',
      name: '**Note: ** + _un_ + "believable results" as "truly believable results" ‖ the peer deletes "Note: "',
      seed: () => [
        $bold('Note: '),
        $italic('un'),
        $plain('believable results'),
      ],
    },
    {
      a: 'truly believable results',
      b: ([note]) => void note.replace($bold('Tip: ')),
      expected: 'Tip: truly believable results',
      name: 'the same ‖ the peer replaces "Note: " with "Tip: "',
      seed: () => [
        $bold('Note: '),
        $italic('un'),
        $plain('believable results'),
      ],
    },
    {
      a: 'the build is green',
      b: ([, , draft]) => draft.remove(),
      expected: 'the build is green',
      name: '"the build" + _ing_ + " (draft)" as "the build is green" ‖ the peer deletes " (draft)"',
      seed: () => [$plain('the build'), $italic('ing'), $plain(' (draft)')],
    },
    {
      a: 'Run the build.',
      b: ([step]) => step.remove(),
      expected: 'Run the build.',
      name: '**Step 1: ** + _fix_ + "the build." as "Run the build." ‖ the peer deletes "Step 1: "',
      seed: () => [$bold('Step 1: '), $italic('fix'), $plain('the build.')],
    },
  ];
  for (const {name, seed, a, b, expected} of ROWS) {
    for (const ids of IDS) {
      test(`${name} (ids ${ids})`, async () => {
        const t = await setup($doc(seed), {ids});
        t.offline();
        t.a.update($remake(a));
        t.b.update(() => {
          b($line().getChildren().filter($isTextNode));
          $setSelection(null);
        });
        await t.sync();
        await expectEverywhere(t.peers, expected);
      });
    }
  }
});

// A separator alone at the edge of a changed word is written with it, but
// not one main keeps (a node of its own, as a tab or a line break), and a
// line break is never taken for a separator: their items stay, so a
// collaborator's concurrent delete of them holds.
describe('a tab or line break alone at the edge of a change keeps its item', () => {
  for (const ids of IDS) {
    test(`tab | "t1z t2z", made again with "t1z" → "t9z" ‖ the peer deletes the tab (ids ${ids})`, async () => {
      const t = await setup(
        $doc(() => [$createTabNode(), $bold('t1z t2z')]),
        {ids},
      );
      t.offline();
      t.a.update(() => {
        for (const child of $line().getChildren()) {
          child.remove();
        }
        $line().append($createTabNode(), $plain('t9z t2z'));
        $setSelection(null);
      });
      t.b.update(() => {
        $line().getChildren()[0].remove();
        $setSelection(null);
      });
      await t.sync();
      await expectEverywhere(t.peers, 't9z t2z');
    });
  }
  for (const ids of IDS) {
    test(`"t1z" | br | **"t2z"**, the br and "t2z" made again as br "t9z" ‖ the peer deletes the br (ids ${ids})`, async () => {
      const t = await setup(
        $doc(() => [$plain('t1z'), $createLineBreakNode(), $bold('t2z')]),
        {ids},
      );
      t.offline();
      t.a.update(() => {
        const [, br, word] = $line().getChildren();
        br.remove();
        word.remove();
        $line().append($createLineBreakNode(), $plain('t9z'));
        $setSelection(null);
      });
      t.b.update(() => {
        $line().getChildren()[1].remove();
        $setSelection(null);
      });
      await t.sync();
      await expectEverywhere(t.peers, 't1zt9z');
    });
  }
});

// Shapes in which a collaborator's delete came back on an earlier version
// of this change, all of which main keeps: a tab, line break or space-only
// node alone at an edge of the change, a text node whose text is the object
// character (not an inline node), and the unchanged word next to an inline
// node (leaving the inline node out of the comparison joined the words on
// its two sides into one).
describe("a collaborator's delete next to a remade word stays deleted", () => {
  const cases: [
    string,
    () => LexicalNode[],
    () => LexicalNode[],
    () => void,
    string,
  ][] = [
    [
      'tab | "alpha", made again as tab | "beta" ‖ the tab deleted',
      () => [$createTabNode(), $plain('alpha')],
      () => [$createTabNode(), $plain('beta')],
      () => $line().getFirstChildOrThrow().remove(),
      'beta',
    ],
    [
      '"alpha" | tab, made again as "beta" | tab ‖ the tab deleted',
      () => [$plain('alpha'), $createTabNode()],
      () => [$plain('beta'), $createTabNode()],
      () => $line().getLastChildOrThrow().remove(),
      'beta',
    ],
    [
      'br | "alpha", made again as br | "beta" ‖ the br deleted',
      () => [$createLineBreakNode(), $plain('alpha')],
      () => [$createLineBreakNode(), $plain('beta')],
      () => $line().getFirstChildOrThrow().remove(),
      'beta',
    ],
    [
      '**" "** | "alpha", made again as **" "** | "beta" ‖ the space deleted',
      () => [$bold(' '), $plain('alpha')],
      () => [$bold(' '), $plain('beta')],
      () => $line().getFirstChildOrThrow().remove(),
      'beta',
    ],
    [
      '"alpha " | **U+FFFC** | " gamma", made again as it was ‖ the U+FFFC deleted',
      () => [$plain('alpha '), $bold('\ufffc'), $plain(' gamma')],
      () => [$plain('alpha '), $bold('\ufffc'), $plain(' gamma')],
      () => $line().getChildAtIndex(1)!.remove(),
      'alpha  gamma',
    ],
    [
      '"alpha" | equation | "beta", made again with "gamma" ‖ the "p" of "alpha" deleted',
      () => [$plain('alpha'), $createEquation('e1'), $plain('beta')],
      () => [$plain('alpha'), $createEquation('e1'), $plain('gamma')],
      () => $line().getAllTextNodes()[0].spliceText(2, 1, '', false),
      'alhagamma',
    ],
  ];
  for (const [name, seed, made, $peer, expected] of cases) {
    for (const ids of IDS) {
      for (const timing of ['concurrent', 'unread'] as const) {
        test(`${name} (${timing}, ids ${ids})`, async () => {
          const t = await setup($doc(seed), {ids});
          const $rewrite = () => {
            for (const child of $line().getChildren()) {
              child.remove();
            }
            $line().append(...made());
            $setSelection(null);
          };
          const $other = () => {
            $peer();
            $setSelection(null);
          };
          t.offline();
          if (timing === 'unread') {
            t.b.update($other);
            t.a.editor.update($rewrite);
            await t.sync();
            await flush();
            await t.sync();
          } else {
            t.a.update($rewrite);
            t.b.update($other);
            await t.sync();
          }
          await expectEverywhere(t.peers, expected);
        });
      }
    }
  }
});

// An edit computed before the update (a stale agent's find and replace)
// replaces the old word by deleting exactly its characters. A word the
// update changed by an insertion or deletion inside it is written whole, so
// the stale edit takes nothing out of the new word (`t9z` made again as
// `t90z` kept `t`, `9` and `z`, and a stale `t9z` → `t94z` left `0t94z`:
// soak L2 8345429).
//
// Where a node boundary cut the old word, main keeps the removed node before
// it whole (the `t` of `t4z`, a comment starting at `4z`), as the first
// character of the new word, and the stale edit takes it, here as on main
// (main shows `t98z96z`, whose `t` is the one t98z brought: soak L2
// 8138978). This change keeps what main keeps; writing that piece again
// would also write again the whole code tokens a paste next to them keeps
// (#9585), so the case is left as on main and pinned here.
describe('a stale replacement of an old word takes nothing out of the new word', () => {
  for (const ids of IDS) {
    test.fails(
      `"t3z t" | **"4z t70z"** | " t5z" made again as "t3z t96z t70z t5z" ‖ t4z → t98z from before the bold (ids ${ids}): as on main, t96z loses its t`,
      async () => {
        const t = await setup(
          $doc(() => [$plain('t3z t4z t70z t5z')]),
          {ids},
        );
        t.offline();
        t.b.update(() => {
          const node = $line().getFirstChildOrThrow() as TextNode;
          node.spliceText(4, 3, 't98z', false);
          $setSelection(null);
        });
        t.a.update(() => {
          const node = $line().getFirstChildOrThrow() as TextNode;
          const [, mid] = node.splitText(5, 12);
          mid.toggleFormat('bold');
          $setSelection(null);
        });
        t.a.update($remake('t3z t96z t70z t5z'));
        await t.sync();
        const fresh = await freshReader(t.a);
        for (const p of [...t.peers, fresh]) {
          const words = lineText(p)
            .split(/(?=t)|\s+/)
            .filter(Boolean);
          expect(words).toContain('t96z');
          expect(words).toContain('t98z');
        }
        await expectConverged(t.peers);
      },
    );

    test(`"t8z t9z t10z" made again from its JSON with t9z → t90z ‖ t9z → t94z (ids ${ids})`, async () => {
      const t = await setup(
        $doc(() => [$plain('t8z '), $bold('t9z t10z')]),
        {ids},
      );
      t.offline();
      t.b.update(() => {
        const node = $line().getLastChildOrThrow() as TextNode;
        node.spliceText(0, 3, 't94z', false);
        $setSelection(null);
      });
      t.a.update(() => {
        for (const leaf of $line().getChildren()) {
          if ($isTextNode(leaf)) {
            const json = leaf.exportJSON();
            json.text = json.text.replace('t9z', 't90z');
            leaf.replace($parseSerializedNode(json));
          }
        }
        $setSelection(null);
      });
      await t.sync();
      const fresh = await freshReader(t.a);
      for (const p of [...t.peers, fresh]) {
        const words = lineText(p)
          .split(/(?=t)|\s+/)
          .filter(Boolean);
        expect(words).toContain('t90z');
        expect(words).toContain('t94z');
      }
      await expectConverged(t.peers);
    });
  }
});

// An insertion or deletion at a word's edge keeps every character: next to
// punctuation or an emoji it is not inside a word (round 2 review). Where
// the caret placed an insertion or deletion among equal text, it stays
// there.
describe('an insertion or deletion in a remade line keeps the words around it', () => {
  for (const ids of IDS) {
    test(`"foo.bar" made again as "fooX.bar" ‖ the peer deletes "bar" (ids ${ids})`, async () => {
      const t = await setup(
        $doc(() => [$plain('foo.bar')]),
        {ids},
      );
      t.offline();
      t.a.update($remake('fooX.bar'));
      t.b.update(() => {
        ($line().getFirstChildOrThrow() as TextNode).spliceText(
          4,
          3,
          '',
          false,
        );
        $setSelection(null);
      });
      await t.sync();
      await expectEverywhere(t.peers, 'fooX.');
    });

    test(`"😀😁 tail" made again as "😀X😁 tail" ‖ the peer deletes 😀 (ids ${ids})`, async () => {
      const t = await setup(
        $doc(() => [$plain('😀😁 tail')]),
        {ids},
      );
      t.offline();
      t.a.update($remake('😀X😁 tail'));
      t.b.update(() => {
        ($line().getFirstChildOrThrow() as TextNode).spliceText(
          0,
          2,
          '',
          false,
        );
        $setSelection(null);
      });
      await t.sync();
      await expectEverywhere(t.peers, 'X😁 tail');
    });

    test(`"aa a aa" made again as "aa aa" with the caret after the first a ‖ the peer types Q after the single a (ids ${ids})`, async () => {
      const t = await setup(
        $doc(() => [$plain('aa a aa')]),
        {ids},
      );
      t.offline();
      t.a.update(() => {
        for (const child of $line().getChildren()) {
          child.remove();
        }
        $line().append($plain('aa aa'));
        $selectIn([1], 1);
      });
      t.b.update(() => {
        ($line().getFirstChildOrThrow() as TextNode).spliceText(
          4,
          0,
          'Q',
          false,
        );
        $setSelection(null);
      });
      await t.sync();
      await expectEverywhere(t.peers, 'aaQ aa');
    });
  }
});

// An insertion or deletion at a word's edge, or next to punctuation, keeps
// the old characters, as typed text does: a collaborator's concurrent
// replacement of that word takes them out of the new one. main wrote a word
// that was a node of its own whole and kept both words; writing such a word
// whole here would also write again a collaborator's delete in a word joined
// to it by punctuation (`foo.bar`, above), so the typed-text merge is kept
// and pinned.
describe("an edit at a word's edge merges as typed text does", () => {
  const ROWS: [string, string, string, string, string, string][] = [
    ['x ', 't49z', ' y', 't49', 't77z', 'x t77z y'],
    ['x ', 'file', ' y', 'files', 'note', 'x notes y'],
    ['use ', 'v1.2.3', ' now', 'v1.20.3', 'v2.0.0', 'use 0v2.0.0 now'],
  ];
  for (const [pre, word, post, made, replaced, expected] of ROWS) {
    for (const ids of IDS) {
      test(`"${pre}" | **"${word}"** | "${post}" made again as "${pre}${made}${post}" ‖ the peer replaces "${word}" with "${replaced}" (ids ${ids})`, async () => {
        const t = await setup(
          $doc(() => [$plain(pre), $bold(word), $plain(post)]),
          {ids},
        );
        t.offline();
        t.a.update($remake(pre + made + post));
        t.b.update(() => {
          ($line().getChildAtIndex(1) as TextNode).spliceText(
            0,
            word.length,
            replaced,
            false,
          );
          $setSelection(null);
        });
        await t.sync();
        await expectEverywhere(t.peers, expected);
      });
    }
  }
});

// A replacement keeps whole words: a token made again with one piece
// changed while a collaborator replaces the old token ends with both tokens
// whole, as two concurrent replacements of one token always do (in client
// id order), never with a mix of the two.
describe('a token made again while a collaborator replaces it keeps both whole', () => {
  const ROWS: [string, () => LexicalNode[], string, string, string][] = [
    ['pi is 3.14 ok', () => [$plain('pi is 3.14 ok')], '3.14', '3.15', '2.71'],
    [
      'pi is **3.14** ok',
      () => [$plain('pi is '), $bold('3.14'), $plain(' ok')],
      '3.14',
      '3.15',
      '2.71',
    ],
    [
      "I don't know",
      () => [$plain("I don't know")],
      "don't",
      "won't",
      'do not',
    ],
    [
      'use v1.2.3 now',
      () => [$plain('use v1.2.3 now')],
      'v1.2.3',
      'v1.2.4',
      'v2.0.0',
    ],
  ];
  for (const [name, seed, token, next, other] of ROWS) {
    for (const ids of IDS) {
      test(`${name}: made again with "${next}" ‖ the peer replaces "${token}" with "${other}" (ids ${ids})`, async () => {
        const t = await setup($doc(seed), {ids});
        const line = t.a.read(() => $line().getTextContent());
        t.offline();
        t.a.update($remake(line.replace(token, next)));
        t.b.update(() => {
          for (const leaf of $line().getAllTextNodes()) {
            const at = leaf.getTextContent().indexOf(token);
            if (at >= 0) {
              leaf.spliceText(at, token.length, other, false);
              break;
            }
          }
          $setSelection(null);
        });
        await t.sync();
        await expectEverywhere(t.peers, [
          line.replace(token, next + other),
          line.replace(token, other + next),
        ]);
      });
    }
  }
});

// A collaborator's delete that reached the writer before its editor read it
// (a provider applying a remote change in the same task as a local update,
// before its commit): the write is made on the document as the editor shows
// it, so what it keeps that the delete took stays deleted.
describe('a delete the editor has not read yet stays deleted', () => {
  const ROWS: {
    name: string;
    seed: () => LexicalNode[];
    a: () => void;
    b: () => void;
    expected: string;
  }[] = [
    {
      a: $remake('t63 t71z t13z t81z t15z'),
      b: () => void $line().getAllTextNodes()[0].spliceText(5, 1, '', false),
      expected: 't63 t1z t13z t81z t15z',
      name: 'one node made again with "t69z" → "t81z" ‖ the "7" of "t71z" deleted',
      seed: () => [$plain('t63 t71z t13z t69z t15z')],
    },
    {
      a: $remake('t12z t13z t81z t15z'),
      b: () => void $line().getAllTextNodes()[1].spliceText(1, 2, '', false),
      expected: 't12z tz t81z t15z',
      name: 'three nodes made again as one ‖ "13" of "t13z" deleted',
      seed: () => [$plain('t12z '), $bold('t13z t69z'), $plain(' t15z')],
    },
    {
      a: () => {
        $line().getAllTextNodes()[0].remove();
        $line().getAllTextNodes()[0].setTextContent('one twoX');
        $setSelection(null);
      },
      b: () => void $line().getAllTextNodes()[1].spliceText(1, 1, '', false),
      expected: 'oe twoX',
      name: 'a removed node before a node set whole ‖ the "n" deleted',
      seed: () => [$bold('xyz '), $plain('one two')],
    },
  ];
  for (const {name, seed, a, b, expected} of ROWS) {
    for (const ids of IDS) {
      test(`${name} (ids ${ids})`, async () => {
        const t = await setup($doc(seed), {ids});
        t.offline();
        t.b.update(() => {
          b();
          $setSelection(null);
        });
        // A's update commits in a microtask; B's delete reaches A in this
        // task, before the commit.
        t.a.editor.update(a);
        await t.sync();
        await flush();
        await t.sync();
        await expectEverywhere(t.peers, expected);
      });
    }
  }
});

/** A seeded random number generator (mulberry32). */
function random(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return n => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), s | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n);
  };
}

/** `text` cut into 1 to `most` pieces at random places. */
function cuts(rnd: (n: number) => number, text: string, most: number) {
  const at = new Set<number>();
  const count = rnd(most);
  for (let i = 0; i < count && text.length > 1; i++) {
    at.add(1 + rnd(text.length - 1));
  }
  const sorted = [...at].sort((x, y) => x - y);
  const out: string[] = [];
  let prev = 0;
  for (const c of [...sorted, text.length]) {
    out.push(text.slice(prev, c));
    prev = c;
  }
  return out;
}

const SEEDS = Number(process.env.LEXICAL_Y_SEEDS || 120);

// The property: a line of unique words in 1 to 4 text nodes is made again
// as 1 to 3 nodes with one word edit (a word replaced, inserted or
// deleted), while a collaborator deletes characters of a word the edit does
// not change, as a concurrent edit or as one the writer has not read yet.
// No character the collaborator deleted comes back, every word of the new
// line is there whole, and every client and a fresh reader agree.
describe('nothing a collaborator deleted comes back', () => {
  for (const timing of ['unread', 'concurrent'] as const) {
    test(`${timing}: random lines made again with one word edit ‖ a delete in an unchanged word`, async () => {
      const failures: string[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        const rnd = random(seed * 7919 + (timing === 'unread' ? 17 : 0));
        const count = 3 + rnd(5);
        const numbers = new Set<number>();
        while (numbers.size < count + 1) {
          numbers.add(1 + rnd(99));
        }
        const [fresh, ...rest] = [...numbers].map(n => `t${n}z`);
        const words = rest;
        const old = words.join(' ');
        const target = rnd(count);
        const kind = (['replace', 'insert', 'delete'] as const)[rnd(3)];
        const next =
          kind === 'replace'
            ? words.map((w, i) => (i === target ? fresh : w))
            : kind === 'insert'
              ? [...words.slice(0, target), fresh, ...words.slice(target)]
              : words.filter((_, i) => i !== target);
        const unchanged = words.filter(
          (_, i) => kind === 'insert' || i !== target,
        );
        const victim = unchanged[rnd(unchanged.length)];
        const from = rnd(victim.length);
        const len = 1 + rnd(victim.length - from);
        const left = victim.slice(0, from) + victim.slice(from + len);
        const oldPieces = cuts(rnd, old, 4);
        const formats = oldPieces.map(() => rnd(3));
        const newPieces = cuts(rnd, next.join(' '), 3);
        const ids = rnd(2) === 0 ? [1, 2] : [2, 1];
        const t = await setup(
          $doc(() =>
            oldPieces.map((text, i) =>
              formats[i] === 1
                ? $bold(text)
                : formats[i] === 2
                  ? $italic(text)
                  : $plain(text),
            ),
          ),
          {ids},
        );
        const $delete = () => {
          const at = old.indexOf(victim) + from;
          // The pieces holding characters `at` to `at + len` of the line.
          let acc = 0;
          const spans: [TextNode, number, number][] = [];
          for (const leaf of $line().getAllTextNodes()) {
            const n = leaf.getTextContentSize();
            const s0 = Math.max(at, acc);
            const s1 = Math.min(at + len, acc + n);
            if (s1 > s0) {
              spans.push([leaf, s0 - acc, s1 - s0]);
            }
            acc += n;
          }
          for (const [leaf, offset, n] of spans.reverse()) {
            leaf.spliceText(offset, n, '', false);
          }
          $setSelection(null);
        };
        t.offline();
        if (timing === 'unread') {
          t.b.update($delete);
          t.a.editor.update($remake(...newPieces));
          await t.sync();
          await flush();
          await t.sync();
        } else {
          t.a.update($remake(...newPieces));
          t.b.update($delete);
          await t.sync();
        }
        const fresh2 = await freshReader(t.a);
        const texts = [...t.peers, fresh2].map(lineText);
        const got = texts[0].split(' ');
        const problems: string[] = [];
        if (new Set(texts).size > 1) {
          problems.push(`diverged ${JSON.stringify(texts)}`);
        }
        if (got.includes(victim)) {
          problems.push(`"${victim}" came back whole`);
        }
        if (left !== '' && !got.includes(left)) {
          problems.push(`"${left}" missing`);
        }
        for (const w of next) {
          if (w !== victim && !got.includes(w)) {
            problems.push(`"${w}" not whole`);
          }
        }
        const warnings = t.peers.flatMap(p => p.warnings);
        if (warnings.length > 0) {
          problems.push(`warnings ${warnings.length}`);
        }
        if (problems.length > 0) {
          failures.push(
            `seed ${seed} ${kind} ${JSON.stringify(oldPieces)} -> ${JSON.stringify(newPieces)}; deletes "${victim.slice(from, from + len)}" of "${victim}": ${JSON.stringify(texts[0])}: ${problems.join(', ')}`,
          );
        }
      }
      expect(failures).toEqual([]);
    }, 120_000);
  }
});
