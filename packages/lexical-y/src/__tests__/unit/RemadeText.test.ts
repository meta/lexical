/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Text a transform or app code makes again, or moves between nodes, in one
// update, while a peer edits the same text at the same time: the characters
// keep their Yjs items, so the peer's concurrent delete stays deleted and its
// typing stays where it typed it. And a write next to an emoji the line
// keeps never splits it.

import {
  $createHashtagNode,
  HashtagNode,
  registerLexicalHashtag,
} from '@lexical/hashtag';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type TextFormatType,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {freshReader, NODES, type Peer, setup} from '../utils/harness';

const ALL = [...NODES, HashtagNode];
const $line = (n: number) => $getRoot().getChildAtIndex(n) as ElementNode;

/** The ids of the characters of every line. */
function ids(p: Peer): string[] {
  const out: string[] = [];
  const root = p.binding.root as unknown as {_start: Y.Item | null};
  for (let it = root._start; it !== null; it = it.right) {
    if (!it.deleted && it.content instanceof Y.ContentString) {
      for (let k = 0; k < it.length; k++) {
        out.push(`${it.id.client}:${it.id.clock + k}`);
      }
    }
  }
  return out;
}

describe('text a transform moves or makes again keeps its characters', () => {
  // `say ` + a stored hashtag `#fo` + ` lala`: a Backspace before `lala`
  // joins it to the hashtag, which the hashtag plugin grows with
  // setTextContent, moving `lala` out of its sibling (R18A-1).
  const GROW: [string, string, [number, number], string | null, boolean][] = [
    ['peer deletes l', ' lala', [8, 9], null, false],
    ['peer types X in the word', ' lala', [10, 10], 'X', false],
    ['peer deletes l, plugin on both', ' lala', [8, 9], null, true],
    ['more text after, peer deletes l', ' lala now', [8, 9], null, false],
  ];
  for (const [name, rest, [from, to], typed, both] of GROW) {
    test(`Backspace joins the next word to a hashtag: ${name}`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Title')),
            $createParagraphNode().append(
              $createTextNode('say '),
              $createHashtagNode('#fo'),
              $createTextNode(rest),
            ),
          );
        },
        {nodes: ALL},
      );
      const {a, b} = t;
      registerLexicalHashtag(a.editor);
      if (both) {
        registerLexicalHashtag(b.editor);
      }
      const before = ids(a);
      t.offline();
      a.update(() => {
        const s = $createRangeSelection();
        const node = $line(1).getChildAtIndex(2) as TextNode;
        s.anchor.set(node.getKey(), 0, 'text');
        s.focus.set(node.getKey(), 1, 'text');
        $setSelection(s);
        s.removeText();
      });
      // Only the space is deleted.
      expect(ids(a)).toEqual(before.filter((_, i) => i !== 5 + 7));
      b.update(() => {
        const s = $createRangeSelection();
        let pos = 0;
        for (const c of $line(1).getChildren() as TextNode[]) {
          const len = c.getTextContentSize();
          if (from >= pos && to <= pos + len) {
            s.anchor.set(c.getKey(), from - pos, 'text');
            s.focus.set(c.getKey(), to - pos, 'text');
            break;
          }
          pos += len;
        }
        $setSelection(s);
        if (typed === null) {
          s.removeText();
        } else {
          s.insertText(typed);
        }
        $setSelection(null);
      });
      await t.sync();
      const fresh = await freshReader(a, ALL);
      const expected =
        'say #fo' +
        (typed === null ? 'ala' : 'laXla') +
        rest.slice(' lala'.length);
      for (const p of [a, b, fresh]) {
        expect(p.read(() => $line(1).getTextContent())).toBe(expected);
      }
      [...t.peers, fresh].forEach(p => p.stop());
    });
  }

  // A hashtag made from a bold part (a format over its start), then grown
  // out of the plain part after it (R18A-1).
  for (const [line, peer, expected] of [
    ['#fot3z xyzz #folala ', [1, 2], '#ot3z xyzz #folala '],
    ['#fot3z xyzz #folala ', [13, 14], '#fot3z xyzz #olala '],
    ['#fot3z xy😁 #folala ', [1, 2], '#ot3z xy😁 #folala '],
  ] as [string, [number, number], string][]) {
    test(`bold over the end of a hashtag, peer deletes [${peer}] of ${JSON.stringify(line)}`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Title')),
            $createParagraphNode().append($createTextNode(line)),
          );
        },
        {nodes: ALL},
      );
      const {a, b} = t;
      registerLexicalHashtag(a.editor);
      const before = ids(a);
      t.offline();
      a.update(() => {
        const node = $line(1).getFirstChild() as TextNode;
        const s = $createRangeSelection();
        s.anchor.set(node.getKey(), 6, 'text');
        s.focus.set(node.getKey(), 17, 'text');
        $setSelection(s);
        s.formatText('bold' as TextFormatType);
        $setSelection(null);
      });
      expect(ids(a)).toEqual(before);
      b.update(() => {
        const node = $line(1).getFirstChild() as TextNode;
        node.select(peer[0], peer[1]).removeText();
        $setSelection(null);
      });
      await t.sync();
      const fresh = await freshReader(a, ALL);
      for (const p of [a, b, fresh]) {
        expect(p.read(() => $line(1).getTextContent())).toBe(expected);
      }
      [...t.peers, fresh].forEach(p => p.stop());
    });
  }

  // Two lines each make the same hashtag again in one update: each keeps
  // its own line's characters (R18A-2).
  for (const lineDeleted of [1, 2]) {
    test(`two lines remake #a in one update, peer deletes the a of line ${lineDeleted}`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Title')),
            $createParagraphNode().append($createTextNode('x #a y')),
            $createParagraphNode().append($createTextNode('x #a y')),
          );
        },
        {nodes: ALL},
      );
      const {a, b} = t;
      registerLexicalHashtag(a.editor);
      const before = ids(a);
      t.offline();
      a.update(() => {
        for (const n of [1, 2]) {
          ($line(n).getFirstChild() as TextNode).spliceText(6, 0, 'q', false);
        }
        $setSelection(null);
      });
      expect(ids(a).filter(id => before.includes(id))).toEqual(before);
      b.update(() => {
        ($line(lineDeleted).getFirstChild() as TextNode)
          .select(3, 4)
          .removeText();
        $setSelection(null);
      });
      await t.sync();
      const fresh = await freshReader(a, ALL);
      const expected = [1, 2].map(n =>
        n === lineDeleted ? 'x # yq' : 'x #a yq',
      );
      for (const p of [a, b, fresh]) {
        expect(
          p.read(() => [1, 2].map(n => $line(n).getTextContent())),
        ).toEqual(expected);
      }
      [...t.peers, fresh].forEach(p => p.stop());
    });
  }

  // A part split off a text node and made again with its text and format,
  // which the normalization merges back (R18A-3, R18B-F1).
  const REMAKE: [
    string,
    string,
    number,
    number,
    boolean,
    [number, number],
    string,
  ][] = [
    ['[2,4)', 'abcdef', 2, 4, false, [2, 3], 'abdef'],
    ['[2,4), x typed at the end', 'abcdef', 2, 4, true, [2, 3], 'abdefx'],
    ['the tail', 'abc def ghi', 4, 11, false, [4, 5], 'abc ef ghi'],
    ['the middle', 'abc def ghi', 4, 7, false, [4, 5], 'abc ef ghi'],
  ];
  for (const [name, text, from, to, typed, peer, expected] of REMAKE) {
    test(`a part made again with its format: ${name}`, async () => {
      const t = await setup(() => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Title')),
          $createParagraphNode().append($createTextNode(text)),
        );
      });
      const {a, b} = t;
      const before = ids(a);
      t.offline();
      a.update(() => {
        const node = $line(1).getFirstChild() as TextNode;
        if (typed) {
          node.spliceText(text.length, 0, 'x', false);
        }
        const parts = node.splitText(from, to);
        const part = parts[from === 0 ? 0 : 1];
        part.replace($createTextNode(part.getTextContent()));
        $setSelection(null);
      });
      expect(ids(a).filter(id => before.includes(id))).toEqual(before);
      b.update(() => {
        ($line(1).getFirstChild() as TextNode)
          .select(peer[0], peer[1])
          .removeText();
        $setSelection(null);
      });
      await t.sync();
      const fresh = await freshReader(a);
      for (const p of [a, b, fresh]) {
        expect(p.read(() => $line(1).getTextContent())).toBe(expected);
      }
      [...t.peers, fresh].forEach(p => p.stop());
    });
  }
});

describe('a write never splits a surrogate pair', () => {
  // `aa😀` + bold `fo` made again plain (merged with its neighbours, its
  // text of unknown origin) + `😀la QA` + underlined `la aa`, with `o`
  // typed after `aa😀` and `Z` in `la aa`: the emoji the line keeps between
  // the edits was kept by two islands and split (R18A-4).
  test('an emoji kept between edits around a part made again', async () => {
    const t = await setup(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Title')),
        $createParagraphNode().append(
          $createTextNode('aa😀'),
          $createTextNode('fo').toggleFormat('bold'),
          $createTextNode('😀la QA'),
          $createTextNode('la aa').toggleFormat('underline'),
        ),
      );
    });
    const {a} = t;
    const payloads = new Map<string, string>();
    const changed: string[] = [];
    const check = () => {
      const root = a.binding.root as unknown as {_start: Y.Item | null};
      for (let it = root._start; it !== null; it = it.right) {
        if (it.content instanceof Y.ContentString) {
          for (let k = 0; k < it.length; k++) {
            const id = `${it.id.client}:${it.id.clock + k}`;
            const was = payloads.get(id);
            const now = it.content.str[k];
            if (was === undefined) {
              payloads.set(id, now);
            } else if (was !== now) {
              changed.push(id);
            }
          }
        }
      }
    };
    check();
    a.update(() => {
      const [first, mid, , last] = $line(1).getChildren() as TextNode[];
      mid.replace($createTextNode(mid.getTextContent()));
      first.spliceText(first.getTextContentSize(), 0, 'o', false);
      last.spliceText(2, 0, 'Z', false);
      $setSelection(null);
    });
    check();
    const fresh = await freshReader(a);
    expect(changed).toEqual([]);
    expect(fresh.read(() => $line(1).getTextContent())).toBe(
      'aa😀ofo😀la QAlaZ aa',
    );
    expect(a.read(() => $line(1).getTextContent())).toBe(
      'aa😀ofo😀la QAlaZ aa',
    );
    [...t.peers, fresh].forEach(p => p.stop());
  });
});
