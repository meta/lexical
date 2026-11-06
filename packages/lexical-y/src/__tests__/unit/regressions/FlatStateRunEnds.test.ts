/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A NodeState value stored flat (`s:<key>`, see Ident.covered) is written by
// main's format rules, as plain values: a run goes on until the next item of
// its key. An undo deleted the null its change wrote to end a run of its own
// (its restore after text it typed inside another client's value), and that
// value then ran on over the rest of the document. The undo now keeps that
// null where a value from before the change would run on without it
// (YBinding#isKeptByUndo). A restore after text typed inside a run its
// writer wrote in segments ends where that segment ends (runOpener: a
// segment reopened right after its own end is no restore). An undo that
// brings back a copy of another client's opener whose end has gone with
// that client's undo still runs on, as on main (`test.fails`).
// Five histories of three clients, each with text entities (hashtags, and
// a keyword and a mention entity), an object and a set-like string value,
// comments, offline edits and undos, end with every line after the edits
// carrying no value, the untouched last line included, on every client and
// a fresh reader.

import {HashtagNode, registerLexicalHashtag} from '@lexical/hashtag';
import {$addMarkID, $getNodeMarkIDs} from '@lexical/mark';
import {registerLexicalTextEntity} from '@lexical/text';
import {mergeRegister} from '@lexical/utils';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $isTextNode,
  $setSelection,
  $setState,
  createState,
  type LexicalEditor,
  type LexicalNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {
  $block,
  $selectIn,
  expectConverged,
  freshReader,
  NODES,
  type Peer,
  setup,
} from '../../utils/harness';
import {prepareMarkState} from '../../utils/sizeOps';

const kvStr = createState('kv-str', {
  parse: (v: unknown) => (typeof v === 'string' ? v : ''),
});
const kvObj = createState('kv-obj', {
  parse: (v: unknown) =>
    v && typeof v === 'object' ? (v as {c: string; z: number}) : null,
});

class KeywordNode extends TextNode {
  $config() {
    return this.config('flat_run_keyword', {extends: TextNode});
  }
  isTextEntity(): true {
    return true;
  }
  canInsertTextBefore(): boolean {
    return false;
  }
  canInsertTextAfter(): boolean {
    return false;
  }
}

class MentionNode extends TextNode {
  $config() {
    return this.config('flat_run_mention', {extends: TextNode});
  }
  isTextEntity(): true {
    return true;
  }
  canInsertTextBefore(): boolean {
    return false;
  }
  canInsertTextAfter(): boolean {
    return false;
  }
}

function matcher(re: RegExp) {
  return (text: string) => {
    const m = re.exec(text);
    return m === null
      ? null
      : {
          end: m.index + m[1].length + m[2].length,
          start: m.index + m[1].length,
        };
  };
}

function prepare(editor: LexicalEditor) {
  prepareMarkState(editor);
  mergeRegister(
    registerLexicalHashtag(editor),
    ...registerLexicalTextEntity(
      editor,
      matcher(/(^|[^a-z0-9#])(w\d+ab)(?=[^a-z0-9]|$)/),
      KeywordNode,
      node => $create(KeywordNode).setTextContent(node.getTextContent()),
    ),
    ...registerLexicalTextEntity(
      editor,
      matcher(/(^|[^a-z0-9#@])(q\d+)(?=[^a-z0-9]|$)/),
      MentionNode,
      node => $create(MentionNode).setTextContent(node.getTextContent()),
    ),
  );
}

/** What a reader sees: per line, runs "text{format}[ids and values]". */
const view = (peer: Peer) =>
  peer.read(() =>
    $getRoot()
      .getChildren()
      .map(p =>
        ($block([p.getIndexWithinParent()]).getAllTextNodes() as TextNode[])
          .map(n => {
            const ids = [...$getNodeMarkIDs(n as LexicalNode)];
            const s = $getState(n, kvStr);
            if (s) {
              ids.push('ss=' + s);
            }
            const o = $getState(n, kvObj);
            if (o) {
              ids.push(`so=${o.c}/${o.z}`);
            }
            ids.sort();
            return `${JSON.stringify(n.getTextContent())}${n.getFormat() ? '{' + n.getFormat() + '}' : ''}${ids.length ? '[' + ids.join(',') + ']' : ''}`;
          })
          .join(''),
      )
      .join(' / '),
  );

function $insertPlainAt(line: number, off: number, text: string) {
  for (const node of $block([line]).getAllTextNodes() as TextNode[]) {
    const size = node.getTextContentSize();
    if (off > 0 && off < size) {
      const [, tail] = node.splitText(off);
      tail.insertBefore($createTextNode(text));
      return;
    }
    if (off === size) {
      node.insertAfter($createTextNode(text));
      return;
    }
    off -= size;
  }
}

type Step =
  | ['ostate', number, number, number, number, string, number]
  | ['sstate', number, number, number, number, string]
  | ['comment', number, number, number, number, string]
  | ['del', number, number, number, number]
  | ['plain' | 'inherit', number, number, number, string]
  | ['undo', number]
  | ['redo', number]
  | ['offline']
  | ['sync'];

interface History {
  readonly ids: number[];
  readonly words: string[][];
  readonly formats: number[][];
  readonly steps: Step[];
  // Still runs on, as on main: the undo brings back a copy of another
  // client's opener whose run's end has gone with that client's undo.
  readonly fails?: boolean;
}

const HISTORIES: Record<string, History> = {
  // B's comment writes another value over A's opener (rule 1).
  "a comment's value over another client's opener": {
    fails: true,
    formats: [
      [0, 0, 1, 0, 0, 2],
      [8, 0, 0, 8],
    ],
    ids: [3, 2, 1],
    steps: [
      ['ostate', 0, 0, 4, 13, 'red', 10],
      ['offline'],
      ['plain', 0, 0, 7, '#h11'],
      ['del', 1, 0, 4, 9],
      ['del', 1, 0, 4, 5],
      ['sync'],
      ['offline'],
      ['undo', 0],
      ['comment', 1, 0, 0, 11, 'c12'],
      ['sync'],
      ['undo', 0],
      ['undo', 1],
    ],
    words: [
      ['w0a', 'w1abc', 'w2a', 'w3abc', 'w4abcd', 'w5ab'],
      ['w6ab', 'w7abc', 'w8a', 'w9abcd'],
    ],
  },

  // A's range ends right before C's restore of its value (rule 3), which C's
  // undo removes with C's end of the run.
  "a range ending at another client's restore of its value": {
    formats: [
      [2, 1, 2, 8, 2, 0, 2],
      [0, 2, 2, 0, 2, 0],
    ],
    ids: [3, 2, 1],
    steps: [
      ['ostate', 0, 0, 7, 16, 'red', 10],
      ['offline'],
      ['undo', 0],
      ['inherit', 2, 0, 8, 'k10'],
      ['plain', 0, 0, 4, '#h13'],
      ['del', 1, 0, 0, 6],
      ['del', 1, 0, 0, 1],
      ['sync'],
      ['ostate', 0, 0, 0, 11, 'red', 10],
      ['undo', 2],
    ],
    words: [
      ['w0abcd', 'w1abc', 'w2a', 'w3a', 'w4a', 'w5ab', 'w6a'],
      ['w7a', 'w8ab', 'w9abc', 'w10abc', 'w11ab', 'w12ab'],
    ],
  },
  // The same, then C redoes and undoes again: the value its undo gives back
  // past its items is part of the step, and comes back with it.
  "a range ending at another client's restore of its value, undone, redone and undone again":
    {
      formats: [
        [2, 1, 2, 8, 2, 0, 2],
        [0, 2, 2, 0, 2, 0],
      ],
      ids: [3, 2, 1],
      steps: [
        ['ostate', 0, 0, 7, 16, 'red', 10],
        ['offline'],
        ['undo', 0],
        ['inherit', 2, 0, 8, 'k10'],
        ['plain', 0, 0, 4, '#h13'],
        ['del', 1, 0, 0, 6],
        ['del', 1, 0, 0, 1],
        ['sync'],
        ['ostate', 0, 0, 0, 11, 'red', 10],
        ['undo', 2],
        ['sync'],
        ['redo', 2],
        ['sync'],
        ['undo', 2],
      ],
      words: [
        ['w0abcd', 'w1abc', 'w2a', 'w3a', 'w4a', 'w5ab', 'w6a'],
        ['w7a', 'w8ab', 'w9abc', 'w10abc', 'w11ab', 'w12ab'],
      ],
    },
  // The same, with A giving the second line blue while C, offline, undoes:
  // the value C's undo gives back past its items does not clear A's blue.
  "a range ending at another client's restore of its value, with a value given concurrently past it":
    {
      formats: [
        [2, 1, 2, 8, 2, 0, 2],
        [0, 2, 2, 0, 2, 0],
      ],
      ids: [3, 2, 1],
      steps: [
        ['ostate', 0, 0, 7, 16, 'red', 10],
        ['offline'],
        ['undo', 0],
        ['inherit', 2, 0, 8, 'k10'],
        ['plain', 0, 0, 4, '#h13'],
        ['del', 1, 0, 0, 6],
        ['del', 1, 0, 0, 1],
        ['sync'],
        ['ostate', 0, 0, 0, 11, 'red', 10],
        ['offline'],
        ['ostate', 0, 1, 0, 6, 'blue', 1],
        ['undo', 2],
      ],
      words: [
        ['w0abcd', 'w1abc', 'w2a', 'w3a', 'w4a', 'w5ab', 'w6a'],
        ['w7a', 'w8ab', 'w9abc', 'w10abc', 'w11ab', 'w12ab'],
      ],
    },
  // C types inside the later segment of B's value (the restated end).
  "typing inside a later segment of another client's value": {
    formats: [
      [0, 8, 0, 0, 2, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    ids: [3, 1, 2],
    steps: [
      ['plain', 2, 1, 15, 'Q 4'],
      ['plain', 2, 1, 3, ' q5'],
      ['plain', 0, 1, 19, ' q12'],
      ['del', 0, 1, 19, 23],
      ['plain', 0, 1, 19, ' q13'],
      ['del', 0, 1, 19, 23],
      ['undo', 0],
      ['offline'],
      ['plain', 0, 1, 11, '#h17'],
      ['del', 1, 1, 8, 19],
      ['del', 1, 1, 8, 9],
      ['undo', 2],
      ['sync'],
      ['ostate', 0, 1, 5, 14, 'red', 10],
      ['offline'],
      ['plain', 1, 1, 11, 'xq19'],
      ['del', 0, 1, 5, 13],
      ['sync'],
      ['offline'],
      ['del', 0, 1, 1, 5],
      ['plain', 1, 1, 14, 'X26'],
      ['sstate', 1, 1, 5, 19, 'blue'],
      ['sync'],
      ['offline'],
      ['undo', 1],
      ['plain', 2, 1, 6, ' yz28'],
    ],
    words: [
      ['w0ab', 'w1a', 'w2ab', 'w3abc', 'w4a', 'w5abcd', 'w6ab', 'w7ab'],
      ['w8ab', 'w9ab', 'w10ab', 'w11ab'],
    ],
  },
  // A types plain text inside B's value, whose run B's change ended with a
  // restore of A's value (which A had undone meanwhile); B undoes.
  "typing inside another client's value that ends at its restore of another": {
    formats: [
      [1, 0, 0, 2, 1, 0, 0, 0],
      [8, 0, 0, 0, 0],
    ],
    ids: [3, 1, 2],
    steps: [
      ['sstate', 0, 1, 5, 18, 'green'],
      ['offline'],
      ['undo', 0],
      ['sstate', 1, 1, 0, 11, 'blue'],
      ['sync'],
      ['plain', 0, 1, 4, ' q10'],
      ['undo', 1],
    ],
    words: [
      ['w0abcd', 'w1ab', 'w2ab', 'w3ab', 'w4abc', 'w5abcd', 'w6a', 'w7abc'],
      ['w8abc', 'w9abc', 'w10abc', 'w11abc', 'w12ab'],
    ],
  },
  // The same, with a comment over B's undone value.
  "typing inside another client's value with a comment over it": {
    formats: [
      [0, 0, 0, 0, 2, 0, 0],
      [0, 2, 0, 8, 0, 0, 0, 0],
    ],
    ids: [2, 3, 1],
    steps: [
      ['del', 0, 1, 2, 12],
      ['sstate', 0, 1, 22, 33, 'red'],
      ['offline'],
      ['plain', 0, 1, 23, '#h8'],
      ['del', 1, 1, 22, 23],
      ['sync'],
      ['offline'],
      ['undo', 0],
      ['undo', 0],
      ['comment', 2, 1, 3, 16, 'c10'],
      ['sync'],
      ['undo', 2],
    ],
    words: [
      ['w0a', 'w1abc', 'w2a', 'w3abc', 'w4abcd', 'w5ab', 'w6abcd'],
      [
        'w7abc',
        'w8abcd',
        'w9abcd',
        'w10abc',
        'w11a',
        'w12abc',
        'w13a',
        'w14abcd',
      ],
    ],
  },
};

function run(peer: Peer, fn: () => void) {
  try {
    peer.update(fn);
  } catch (_e) {
    // A step that does not apply (as on any client): skipped.
  }
}

describe("a flat NodeState value never runs on past another client's undone run", () => {
  for (const [name, h] of Object.entries(HISTORIES)) {
    for (const gc of [false, true]) {
      (h.fails ? test.fails : test)(
        `${name}${h.fails ? ' (known limit, DECISIONS.md D65)' : ''} (gc ${gc ? 'on' : 'off'})`,
        async () => {
          const t = await setup(
            () => {
              h.words.forEach((words, l) => {
                const p = $createParagraphNode();
                words.forEach((w, i) =>
                  p.append(
                    $createTextNode(
                      w + (i < words.length - 1 ? ' ' : ''),
                    ).setFormat(h.formats[l][i]),
                  ),
                );
                $getRoot().append(p);
              });
              $getRoot().append(
                $createParagraphNode().append(
                  $createTextNode('tail sentinel line'),
                ),
              );
            },
            {
              gc,
              ids: h.ids,
              nodes: [...NODES, HashtagNode, KeywordNode, MentionNode],
              prepare,
            },
          );
          onTestFinished(() => t.peers.forEach(p => p.stop()));
          for (const step of h.steps) {
            if (step[0] === 'offline') {
              t.offline();
              continue;
            }
            if (step[0] === 'sync') {
              await t.sync();
              continue;
            }
            const peer = t.peers[step[1]];
            if (step[0] === 'undo') {
              peer.undo();
            } else if (step[0] === 'redo') {
              peer.binding.undoManager!.stopCapturing();
              peer.binding.redo();
            } else if (step[0] === 'del') {
              const [, , l, a, b] = step;
              run(peer, () => void $selectIn([l], a, b).removeText());
            } else if (step[0] === 'plain') {
              const [, , l, at, text] = step;
              run(peer, () => $insertPlainAt(l, at, text));
            } else if (step[0] === 'inherit') {
              const [, , l, at, text] = step;
              run(peer, () => void $selectIn([l], at, at).insertText(text));
            } else if (step[0] === 'comment') {
              const [, , l, a, b, mark] = step;
              run(peer, () => void $addMarkID(mark, $selectIn([l], a, b)));
            } else if (step[0] === 'sstate') {
              const [, , l, a, b, v] = step;
              run(peer, () => {
                for (const n of $selectIn([l], a, b).extract()) {
                  if ($isTextNode(n)) {
                    $setState(n, kvStr, v);
                  }
                }
              });
            } else {
              const [, , l, a, b, c, z] = step as [
                'ostate',
                number,
                number,
                number,
                number,
                string,
                number,
              ];
              run(peer, () => {
                for (const n of $selectIn([l], a, b).extract()) {
                  if ($isTextNode(n)) {
                    $setState(n, kvObj, {c, z});
                  }
                }
              });
            }
          }
          await t.sync();
          const views = t.peers.map(view);
          const fresh = await freshReader(t.a);
          onTestFinished(() => fresh.stop());
          expect(views.every(v => v === views[0])).toBe(true);
          expect(view(fresh)).toBe(views[0]);
          expect(views[0].split(' / ').at(-1)).toBe('"tail sentinel line"');
        },
      );
    }
  }
});

const TRIPLES = [
  [1, 2, 3],
  [3, 2, 1],
];

const scalar = createState('run-end-scalar', {
  parse: (v: unknown) => (typeof v === 'string' ? v : ''),
});
const boxed = createState('run-end-object', {
  parse: (v: unknown) =>
    v && typeof v === 'object' ? (v as {v: string}) : null,
});

describe("a range inside another client's value ends where that client's undo leaves the run", () => {
  for (const kind of ['string', 'object'] as const) {
    const $put = (start: number, end: number, value: string) => {
      for (const n of $selectIn([0], start, end).extract()) {
        if ($isTextNode(n)) {
          if (kind === 'string') {
            $setState(n, scalar, value);
          } else {
            $setState(n, boxed, value === '' ? null : {v: value});
          }
        }
      }
      $setSelection(null);
    };
    const $values = () =>
      ($block([0]).getAllTextNodes() as TextNode[])
        .flatMap(n =>
          [...n.getTextContent()].map(() =>
            kind === 'string'
              ? $getState(n, scalar) || '-'
              : ($getState(n, boxed)?.v ?? '-'),
          ),
        )
        .join('');
    for (const unmergeable of [false, true]) {
      for (const gc of [false, true]) {
        for (const ids of TRIPLES) {
          // B gives "abcdefghij" v, then "cdef" w; A gives "ef" v (A's range
          // ends where B's w run ends, at B's restore of v); B undoes its w.
          // B's v comes back on "cd", and the text after A's range keeps it.
          test(`B's undo of a value around A's range leaves the value from before after it (${kind}${unmergeable ? ', unmergeable' : ''}, gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
            const t = await setup(
              () => {
                const text = $createTextNode('abcdefghijklmno');
                if (unmergeable) {
                  text.toggleUnmergeable();
                }
                $getRoot().append(
                  $createParagraphNode().append(text),
                  $createParagraphNode().append($createTextNode('tail line')),
                );
              },
              {gc, ids},
            );
            onTestFinished(() => t.peers.forEach((p: Peer) => p.stop()));
            const [a, b] = t.peers;
            b.update(() => $put(0, 10, 'v'));
            await t.sync();
            b.update(() => $put(2, 6, 'w'));
            await t.sync();
            a.update(() => $put(4, 6, 'v'));
            await t.sync();
            expect(a.read($values)).toBe('vvwwvvvvvv-----');
            b.undo();
            await t.sync();
            await expectConverged(t.peers);
            expect(a.read($values)).toBe('vvvvvvvvvv-----');
            const fresh = await freshReader(a);
            onTestFinished(() => fresh.stop());
            expect(fresh.read($values)).toBe('vvvvvvvvvv-----');
          });
        }
      }
    }
  }
});

describe("a flat value's run ends only where its writer ended it", () => {
  const $put = (start: number, end: number, value: string) => {
    for (const n of $selectIn([0], start, end).extract()) {
      if ($isTextNode(n)) {
        $setState(n, scalar, value);
      }
    }
    $setSelection(null);
  };
  const $values = () =>
    ($block([0]).getAllTextNodes() as TextNode[])
      .flatMap(n =>
        [...n.getTextContent()].map(() => $getState(n, scalar) || '-'),
      )
      .join('');
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      // B gives "abcdefghij" v, then, in a later change, "i" w; A types a
      // plain X inside B's v (which restores v after it); B undoes its w.
      // The clocks do not tell B's later change from the one that gave v:
      // A's restore is not ended at B's w, and "ij" keep v.
      test(`a restore inside a value is not ended by a later change of the same client (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode('abcdefghijklmnop'),
              ),
            );
          },
          {gc, ids},
        );
        onTestFinished(() => t.peers.forEach((p: Peer) => p.stop()));
        const [a, b] = t.peers;
        b.update(() => $put(0, 10, 'v'));
        await t.sync();
        b.update(() => $put(8, 9, 'w'));
        await t.sync();
        a.update(() => {
          $selectIn([0], 4, 4).insertNodes([$createTextNode('X')]);
          $setSelection(null);
        });
        await t.sync();
        b.undo();
        await t.sync();
        await expectConverged(t.peers);
        expect(a.read($values)).toBe('vvvv-vvvvvv------');
        const fresh = await freshReader(a);
        onTestFinished(() => fresh.stop());
        expect(fresh.read($values)).toBe(a.read($values));
      });
      // A gives "e" w, then "ab" w; offline, A gives "f" v while B gives
      // "bcde" w (its range ends at A's w on "e", which goes on with it).
      // B's write adds no end of its own after A's: "f" keeps A's v.
      test(`a range that ends at another client's run adds no end after it (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('abcdef')),
            );
          },
          {gc, ids},
        );
        onTestFinished(() => t.peers.forEach((p: Peer) => p.stop()));
        const [a, b] = t.peers;
        a.update(() => $put(4, 5, 'w'));
        await t.sync();
        a.update(() => $put(0, 2, 'w'));
        await t.sync();
        t.offline();
        a.update(() => $put(5, 6, 'v'));
        b.update(() => $put(1, 5, 'w'));
        await t.sync();
        await expectConverged(t.peers);
        expect(a.read($values)).toBe('wwwwwv');
        const fresh = await freshReader(a);
        onTestFinished(() => fresh.stop());
        expect(fresh.read($values)).toBe('wwwwwv');
      });
    }
  }
});

describe('sequential histories keep what main shows (D26)', () => {
  const $put = (start: number, end: number, value: string) => {
    for (const n of $selectIn([0], start, end).extract()) {
      if ($isTextNode(n)) {
        $setState(n, scalar, value);
      }
    }
    $setSelection(null);
  };
  const $typeZ = (at: number) => {
    $selectIn([0], at, at).insertNodes([$createTextNode('Z')]);
    $setSelection(null);
  };
  // A node given v and a plain one after it, inserted at `at` in one update.
  const $insertValuedAndPlain = (at: number) => {
    const valued = $createTextNode('VV');
    $setState(valued, scalar, 'v');
    $selectIn([0], at, at).insertNodes([valued, $createTextNode('PP')]);
    $setSelection(null);
  };
  const $values = () =>
    ($block([0]).getAllTextNodes() as TextNode[])
      .flatMap(n =>
        [...n.getTextContent()].map(() => $getState(n, scalar) || '-'),
      )
      .join('');
  type Act = (t: Awaited<ReturnType<typeof setup>>) => Promise<void> | void;
  const CASES: [string, Act[], string][] = [
    [
      'a clear undone after a plain insert before it brings the value back',
      [
        t => t.peers[1].update(() => $put(0, 19, 'x')),
        t => t.peers[1].update(() => $put(10, 14, '')),
        t => t.peers[0].update(() => $typeZ(5)),
        t => t.peers[1].undo(),
      ],
      'xxxxx-xxxxxxxxxxxxxx',
    ],
    [
      'a plain insert given the value and undone leaves the value',
      [
        t => t.peers[0].update(() => $put(0, 19, 'x')),
        t => t.peers[1].update(() => $typeZ(10)),
        t => t.peers[0].update(() => $put(10, 11, 'x')),
        t => t.peers[1].undo(),
      ],
      'xxxxxxxxxxxxxxxxxxx',
    ],
    [
      'another value undone after a plain insert brings the first back',
      [
        t => t.peers[1].update(() => $put(0, 19, 'x')),
        t => t.peers[1].update(() => $put(10, 19, 'w')),
        t => t.peers[0].update(() => $typeZ(5)),
        t => t.peers[1].undo(),
      ],
      'xxxxx-xxxxxxxxxxxxxx',
    ],
    [
      'a clear to the end undone after a plain insert brings the value back',
      [
        t => t.peers[1].update(() => $put(0, 19, 'x')),
        t => t.peers[1].update(() => $put(10, 19, '')),
        t => t.peers[0].update(() => $typeZ(5)),
        t => t.peers[1].undo(),
      ],
      'xxxxx-xxxxxxxxxxxxxx',
    ],
    // An end a change writes after a value it gives, or a clear it makes,
    // goes with its undo: the value from before comes back on that text.
    [
      'an insert of a valued node and a plain one, undone, brings the value back',
      [
        t => t.peers[0].update(() => $put(0, 19, 'x')),
        t => t.peers[0].update(() => $insertValuedAndPlain(5)),
        t => t.peers[0].undo(),
      ],
      'xxxxxxxxxxxxxxxxxxx-----',
    ],
    [
      'a value and a clear after it in one update, undone, bring the value back',
      [
        t => t.peers[0].update(() => $put(0, 19, 'x')),
        t =>
          t.peers[0].update(() => {
            $put(5, 10, 'v');
            $put(10, 15, '');
          }),
        t => t.peers[0].undo(),
      ],
      'xxxxxxxxxxxxxxxxxxx-----',
    ],
    [
      'a value and a clear to the end in one update, undone, bring the value back',
      [
        t => t.peers[0].update(() => $put(0, 24, 'x')),
        t =>
          t.peers[0].update(() => {
            $put(12, 17, 'v');
            $put(17, 24, '');
          }),
        t => t.peers[0].undo(),
      ],
      'xxxxxxxxxxxxxxxxxxxxxxxx',
    ],
    [
      "an insert of a valued node and a plain one inside another client's value, undone, brings the value back",
      [
        t => t.peers[1].update(() => $put(0, 19, 'x')),
        t => t.peers[0].update(() => $insertValuedAndPlain(5)),
        t => t.peers[0].undo(),
      ],
      'xxxxxxxxxxxxxxxxxxx-----',
    ],
  ];
  for (const [name, acts, expected] of CASES) {
    for (const gc of [false, true]) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        test(`${name} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append(
                  $createTextNode('aaaa bbbb cccc dddd eeee'),
                ),
              );
            },
            {gc, ids},
          );
          onTestFinished(() => t.peers.forEach((p: Peer) => p.stop()));
          for (const act of acts) {
            await act(t);
            await t.sync();
          }
          await expectConverged(t.peers);
          const fresh = await freshReader(t.a);
          onTestFinished(() => fresh.stop());
          for (const shown of [...t.peers, fresh].map(p => p.read($values))) {
            expect(shown.slice(0, expected.length)).toBe(expected);
          }
        });
      }
    }
  }
});

describe("a kept end never cuts another client's value", () => {
  const $put = (start: number, end: number, value: string) => {
    for (const n of $selectIn([0], start, end).extract()) {
      if ($isTextNode(n)) {
        $setState(n, scalar, value);
      }
    }
    $setSelection(null);
  };
  const $typeAt = (at: number, text: string) => {
    $selectIn([0], at, at).insertNodes([$createTextNode(text)]);
    $setSelection(null);
  };
  const $values = () =>
    ($block([0]).getAllTextNodes() as TextNode[])
      .flatMap(n =>
        [...n.getTextContent()].map(() => $getState(n, scalar) || '-'),
      )
      .join('');
  // Rounds of steps; each round runs offline, its steps at the same time.
  type RoundStep = [number, 'undo' | 'redo' | (() => void)];
  const CASES: [string, RoundStep[][], string][] = [
    // A's restore after its Z ends where B's change ended B's v; B gives w
    // over all of it meanwhile. A's undo leaves B's w to B's own end.
    [
      "an undo of typing inside a value another client gave again meanwhile leaves that client's value",
      [
        [[1, () => $put(0, 10, 'v')]],
        [
          [0, () => $typeAt(4, 'Z')],
          [1, () => $put(0, 20, 'w')],
        ],
        [[0, 'undo']],
      ],
      'wwwwwwwwwwwwwwwwwwww----',
    ],
    [
      "an undo of typing inside a value a third client gave again meanwhile leaves that client's value",
      [
        [[1, () => $put(0, 10, 'v')]],
        [
          [0, () => $typeAt(4, 'Z')],
          [2, () => $put(2, 20, 'w')],
        ],
        [[0, 'undo']],
      ],
      'vvwwwwwwwwwwwwwwwwww----',
    ],
    // C's restore after its k ends where A's change ended A's r, which A
    // undoes meanwhile; C undoes and redoes, then A gives r again up to the
    // middle of C's restore, and C undoes: the redone end still counts as
    // the restore's own end, and r stops where A's first change ended it.
    [
      'a redone end of a restore is kept by the next undo, as the first was',
      [
        [[0, () => $put(7, 16, 'r')]],
        [
          [0, 'undo'],
          [2, () => $typeAt(8, 'k')],
        ],
        [[2, 'undo']],
        [[2, 'redo']],
        [[0, () => $put(0, 9, 'r')]],
        [[2, 'undo']],
      ],
      'rrrrrrrrrrrrrrrr--------',
    ],
  ];
  for (const [name, rounds, expected] of CASES) {
    for (const gc of [false, true]) {
      for (const ids of [
        [1, 2, 3],
        [3, 2, 1],
      ]) {
        test(`${name} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append(
                  $createTextNode('aaaa bbbb cccc dddd eeee'),
                ),
                $createParagraphNode().append($createTextNode('tail')),
              );
            },
            {gc, ids},
          );
          onTestFinished(() => t.peers.forEach((p: Peer) => p.stop()));
          for (const round of rounds) {
            t.offline();
            for (const [who, step] of round) {
              const p = t.peers[who];
              if (step === 'undo') {
                p.undo();
              } else if (step === 'redo') {
                p.binding.undoManager!.stopCapturing();
                p.binding.redo();
              } else {
                p.update(step);
              }
            }
            await t.sync();
          }
          await expectConverged(t.peers);
          const fresh = await freshReader(t.a);
          onTestFinished(() => fresh.stop());
          for (const p of [...t.peers, fresh]) {
            expect(p.read($values)).toBe(expected);
          }
        });
      }
    }
  }
});

describe('overlapping boolean anchors of two clients stay on their text', () => {
  const anchor1 = createState<string, boolean>('anchor:c:1', {
    parse: (v: unknown) => v === true,
  });
  const anchor2 = createState<string, boolean>('anchor:c:2', {
    parse: (v: unknown) => v === true,
  });
  const $anchor = (state: typeof anchor1, start: number, end: number) => {
    for (const n of $selectIn([0], start, end).extract()) {
      if ($isTextNode(n)) {
        $setState(n, state, true);
      }
    }
    $setSelection(null);
  };
  const $type = (at: number, text: string) => {
    $selectIn([0], at, at).insertText(text);
    $setSelection(null);
  };
  // Per character: 1 and 2 for the anchors on it, '-' for none.
  const $shown = () =>
    [0, 1]
      .map(l =>
        ($block([l]).getAllTextNodes() as TextNode[])
          .flatMap(n => {
            const tag =
              ($getState(n, anchor1) ? '1' : '') +
                ($getState(n, anchor2) ? '2' : '') || '-';
            return [...n.getTextContent()].map(ch => ch + tag);
          })
          .join(''),
      )
      .join(' / ');
  // Each step: who, and what (anchor, type at an anchor's end, undo, redo).
  type Act = [number, 'undo' | 'redo' | ((p: Peer) => void)];
  const ANCHOR_HISTORIES: [string, Act[][]][] = [
    [
      'anchors, typing at their ends, undos and redos on both sides',
      [
        [
          [0, p => p.update(() => $anchor(anchor1, 2, 8))],
          [1, p => p.update(() => $anchor(anchor2, 5, 12))],
        ],
        [
          [0, p => p.update(() => $type(8, 'xy'))],
          [1, p => p.update(() => $type(12, 'zw'))],
        ],
        [
          [0, 'undo'],
          [1, 'undo'],
        ],
        [
          [0, 'undo'],
          [1, 'redo'],
        ],
        [
          [0, 'redo'],
          [1, 'undo'],
        ],
        [
          [0, 'undo'],
          [1, 'undo'],
        ],
      ],
    ],
  ];
  for (const [name, rounds] of ANCHOR_HISTORIES) {
    for (const gc of [false, true]) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        test(`${name} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append(
                  $createTextNode('aaaa bbbb cccc dddd'),
                ),
                $createParagraphNode().append($createTextNode('tail')),
              );
            },
            {gc, ids},
          );
          onTestFinished(() => t.peers.forEach((p: Peer) => p.stop()));
          for (const round of rounds) {
            // Each round's steps run offline, at the same time.
            t.offline();
            for (const [who, act] of round) {
              const p = t.peers[who];
              if (act === 'undo') {
                p.undo();
              } else if (act === 'redo') {
                p.binding.undoManager!.stopCapturing();
                p.binding.redo();
              } else {
                act(p);
              }
            }
            await t.sync();
            await expectConverged(t.peers);
            const shown = t.a.read($shown);
            // No anchor runs on onto the next line.
            expect(shown.split(' / ')[1]).toBe('t-a-i-l-');
            const fresh = await freshReader(t.a);
            onTestFinished(() => fresh.stop());
            expect(fresh.read($shown)).toBe(shown);
          }
          // Every change undone: no anchor is left.
          expect(t.a.read($shown)).toBe(
            'a-a-a-a- -b-b-b-b- -c-c-c-c- -d-d-d-d- / t-a-i-l-',
          );
        });
      }
    }
  }
});
