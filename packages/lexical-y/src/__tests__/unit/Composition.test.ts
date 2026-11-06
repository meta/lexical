/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
} from '@lexical/list';
import * as Y from '@y/y';
import {
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  createEditor,
  type ElementNode,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {
  $block,
  $p,
  $selectIn,
  describeNode,
  expectConverged,
  flush,
  NODES,
  type Peer,
  setup,
} from '../utils/harness';

// IME composition, as Lexical sees it: a composition key on the text node,
// the node's text updated at each step (from the DOM), and the key cleared at
// the end. While a peer's remote insert lands in the composing line, the line's
// nodes must not change (the browser composes into that DOM text); the insert
// shows when the composition ends, and nothing is lost or misplaced.

function $text(path: number[]): TextNode {
  const node = ($block(path) as ElementNode).getFirstChild();
  if (!$isTextNode(node)) {
    throw new Error('no text');
  }
  return node;
}

/** Start composing at `offset` of the first text node of line `path`. */
function compositionStart(peer: Peer, path: number[], offset: number) {
  peer.update(() => {
    const node = $text(path);
    node.select(offset, offset);
    $setCompositionKey(node.getKey());
  });
}

/** One composition step: the composed text is now `composed`. */
function compositionStep(
  peer: Peer,
  path: number[],
  at: number,
  previous: string,
  composed: string,
) {
  peer.update(() => {
    const node = $text(path);
    const text = node.getTextContent();
    node.setTextContent(
      text.slice(0, at) + composed + text.slice(at + previous.length),
    );
    node.select(at + composed.length, at + composed.length);
  });
}

function compositionEnd(peer: Peer) {
  peer.update(() => $setCompositionKey(null));
}

function lineText(peer: Peer, path: number[]): string {
  return peer.read(() => $block(path).getTextContent());
}

function caretOffsetAfter(peer: Peer, token: string): boolean {
  return peer.read(() => {
    const s = $getSelection();
    if (!$isRangeSelection(s) || !s.isCollapsed()) {
      return false;
    }
    const node = s.anchor.getNode();
    return node.getTextContent().slice(0, s.anchor.offset).endsWith(token);
  });
}

describe('@lexical/y IME composition with concurrent remote edits', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    for (const [where, at, expected] of [
      ['before', 0, 'XYi1z 東京i2z i3z'],
      ['right before', 3, 'i1zXY 東京i2z i3z'],
      ['after', -1, 'i1z 東京i2z i3zXY'],
    ] as const) {
      test(`a peer inserts ${where} the composition (ids ${ids})`, async () => {
        const t = await setup(() => $getRoot().append($p('i1z i2z i3z')), {
          ids,
        });
        compositionStart(t.a, [0], 4);
        compositionStep(t.a, [0], 4, '', 't');
        await t.sync();
        compositionStep(t.a, [0], 4, 't', 'とう');
        await t.sync();
        const $at = (n: number) =>
          at < 0 ? $block([0]).selectEnd() : $selectIn([0], at + n);
        t.b.update(() => $at(0).insertText('X'));
        await t.sync();
        // The composing line keeps its nodes while composing.
        expect(lineText(t.a, [0])).toBe('i1z とうi2z i3z');
        t.b.update(() => $at(1).insertText('Y'));
        compositionStep(t.a, [0], 4, 'とう', 'とうきょう');
        await t.sync();
        expect(lineText(t.a, [0])).toBe('i1z とうきょうi2z i3z');
        compositionStep(t.a, [0], 4, 'とうきょう', '東京');
        compositionEnd(t.a);
        await t.sync();
        await expectConverged(t.peers, `paragraph("${expected}")`);
        expect(caretOffsetAfter(t.a, '東京')).toBe(true);
        // Typing after the composition lands after it.
        t.a.update(() => {
          const s = $getSelection();
          if ($isRangeSelection(s)) {
            s.insertText('!');
          }
        });
        await t.sync();
        await expectConverged(
          t.peers,
          `paragraph("${expected.replace('東京', '東京!')}")`,
        );
      });
    }

    test(`a peer inserts inside the composed text (ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('ab')), {ids});
      compositionStart(t.a, [0], 1);
      compositionStep(t.a, [0], 1, '', 'にほ');
      await t.sync();
      t.b.update(() => $selectIn([0], 2).insertText('Q'));
      await t.sync();
      expect(lineText(t.a, [0])).toBe('aにほb');
      compositionStep(t.a, [0], 1, 'にほ', '日本');
      compositionEnd(t.a);
      await t.sync();
      // The peer's character stays, next to the replaced composition.
      const text = lineText(t.a, [0]);
      expect(text.includes('Q')).toBe(true);
      expect(text.replace('Q', '')).toBe('a日本b');
      await expectConverged(t.peers);
    });

    test(`other lines update while composing (ids ${ids})`, async () => {
      const t = await setup(
        () => $getRoot().append($p('one'), $p('two'), $p('three')),
        {ids},
      );
      compositionStart(t.a, [1], 3);
      compositionStep(t.a, [1], 3, '', 'k');
      await t.sync();
      t.b.update(() => {
        $selectIn([0], 3).insertText('!');
        $selectIn([2], 0).insertText('>');
        $selectIn([1], 0).insertText('*');
      });
      await t.sync();
      expect(lineText(t.a, [0])).toBe('one!');
      expect(lineText(t.a, [2])).toBe('>three');
      expect(lineText(t.a, [1])).toBe('twok');
      compositionStep(t.a, [1], 3, 'k', 'か');
      compositionEnd(t.a);
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("one!") / paragraph("*twoか") / paragraph(">three")',
      );
    });

    test(`a split of the composing line waits for the composition to end (ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('one two')), {ids});
      compositionStart(t.a, [0], 7);
      compositionStep(t.a, [0], 7, '', 'n');
      await t.sync();
      const key = t.a.read(() => $text([0]).getKey());
      t.b.update(() => $selectIn([0], 3).insertParagraph());
      await t.sync();
      // The composing line keeps its nodes while composing.
      expect(t.a.read(() => $getRoot().getChildrenSize())).toBe(1);
      expect(t.a.read(() => $text([0]).getKey())).toBe(key);
      expect(lineText(t.a, [0])).toBe('one twon');
      t.a.update(() => {
        const node = $text([0]);
        node.setTextContent('one twoに');
        node.select(8, 8);
        $setCompositionKey(null);
      });
      await t.sync();
      await expectConverged(t.peers, 'paragraph("one") / paragraph(" twoに")');
    });

    test(`a deletion in the composing line is read at once (ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('abc def')), {ids});
      compositionStart(t.a, [0], 7);
      compositionStep(t.a, [0], 7, '', 'x');
      await t.sync();
      t.b.update(() => $selectIn([0], 0, 4).removeText());
      await t.sync();
      expect(lineText(t.a, [0])).toBe('defx');
      compositionEnd(t.a);
      await t.sync();
      await expectConverged(t.peers, 'paragraph("defx")');
    });
  }

  test('a composition in a new text node next to formatted text', async () => {
    const t = await setup(() => $getRoot().append($p('ab')));
    t.a.update(() => {
      const line = $block([0]) as ElementNode;
      const node = $createTextNode('k');
      node.toggleFormat('bold');
      line.append(node);
      node.select(1, 1);
      $setCompositionKey(node.getKey());
    });
    t.a.update(() => {
      const node = ($block([0]) as ElementNode).getLastChild() as TextNode;
      node.setTextContent('か');
      node.select(1, 1);
    });
    await t.sync();
    t.b.update(() => $selectIn([0], 0).insertText('Z'));
    await t.sync();
    expect(lineText(t.a, [0])).toBe('abか');
    compositionEnd(t.a);
    await t.sync();
    await expectConverged(t.peers);
    expect(lineText(t.a, [0])).toBe('Zabか');
  });

  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    for (const where of ['start of line 2', 'end of line 1'] as const) {
      test(`a peer joins the lines while composing at the ${where} (ids ${ids})`, async () => {
        const t = await setup(() => $getRoot().append($p('j1z'), $p('j2z')), {
          ids,
        });
        const line = where === 'start of line 2' ? 1 : 0;
        const at = where === 'start of line 2' ? 0 : 3;
        compositionStart(t.a, [line], at);
        compositionStep(t.a, [line], at, '', 'に');
        await t.sync();
        const key = t.a.read(() => $text([line]).getKey());
        // The peer presses Backspace at the start of line 2.
        t.b.update(() => {
          const first = $block([0]) as ElementNode;
          const second = $block([1]) as ElementNode;
          first.append(...second.getChildren());
          second.remove();
        });
        await t.sync();
        // The composed node keeps its key and text (the browser composes
        // into its DOM text node); the peer's text sits next to it.
        t.a.read(() => {
          const node = $getNodeByKey(key);
          expect($isTextNode(node) && node.isAttached()).toBe(true);
          expect((node as TextNode).getTextContent()).toBe(
            where === 'start of line 2' ? 'にj2z' : 'j1zに',
          );
        });
        expect(lineText(t.a, [0])).toBe('j1zにj2z');
        t.a.update(() => {
          const node = $getNodeByKey(key) as TextNode;
          const text = node.getTextContent();
          node.setTextContent(text.replace('に', '日本'));
          node.select(at + 2, at + 2);
        });
        compositionEnd(t.a);
        await t.sync();
        await expectConverged(t.peers, 'paragraph("j1z日本j2z")');
      });
    }
  }

  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`a peer joins the lines after typing into the composing line (ids ${ids})`, async () => {
      // The peer's insert into the composing line is held back (not shown
      // until the composition ends); the join, which cannot be held (Yjs
      // does not keep the deleted line marker), is read at once without it:
      // what the editor shows and what it holds back stay complementary (the
      // self-check compares them on the next local write).
      const t = await setup(() => $getRoot().append($p('j1z'), $p('j2z')), {
        ids,
      });
      compositionStart(t.a, [1], 0);
      compositionStep(t.a, [1], 0, '', 'に');
      await t.sync();
      const key = t.a.read(() => $text([1]).getKey());
      t.b.update(() => $block([1]).selectEnd().insertText('Z'));
      await t.sync();
      expect(lineText(t.a, [1])).toBe('にj2z');
      t.b.update(() => {
        const first = $block([0]) as ElementNode;
        const second = $block([1]) as ElementNode;
        first.append(...second.getChildren());
        second.remove();
      });
      await t.sync();
      expect(lineText(t.a, [0])).toBe('j1zにj2z');
      t.a.update(() => {
        const node = $getNodeByKey(key) as TextNode;
        node.setTextContent(node.getTextContent().replace('に', '日本'));
        node.select(2, 2);
      });
      expect(t.a.warnings).toEqual([]);
      compositionEnd(t.a);
      await t.sync();
      await expectConverged(t.peers, 'paragraph("j1z日本j2zZ")');
    });
  }
});

// Self-check off, as by default: its re-reads must not be what makes these
// converge.
describe('@lexical/y a composed line its own client removes', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`what a peer typed into it while held back shows where it is stored (ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('one'), $p('two')), {
        ids,
      });
      compositionStart(t.a, [1], 3);
      // B types into the composed line: held back on A.
      t.b.update(() => $selectIn([1], 1).insertText('X'));
      await t.sync();
      expect(lineText(t.a, [1])).toBe('two');
      // A removes the line it composes in, then the composition ends.
      t.a.update(() => $block([1]).remove());
      compositionEnd(t.a);
      await t.sync();
      // Delete wins for what A had shown; B's text, which A never deleted,
      // shows on A too, as on every peer and a fresh reader.
      await expectConverged(t.peers, 'paragraph("one") / paragraph("X")');
    });
  }
});

// The update that shows what a composition held back waits for the editor
// to be idle; a composition that starts before then, in another line, does
// not take it.
describe('@lexical/y a composition that starts before the last one showed what it held back', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`what was held back shows (ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('one'), $p('two')), {
        ids,
      });
      compositionStart(t.a, [0], 3);
      // B types into the composed line: held back on A.
      t.b.update(() => $selectIn([0], 0).insertText('X'));
      expect(lineText(t.a, [0])).toBe('one');
      // In the same task, A ends that composition and starts one in the
      // other line, which B then changes (so A reads that line in full).
      compositionEnd(t.a);
      compositionStart(t.a, [1], 3);
      t.b.update(() => $block([1]).setFormat('center'));
      expect(lineText(t.a, [0])).toBe('Xone');
      compositionEnd(t.a);
      await t.sync();
      await expectConverged(t.peers, 'paragraph("Xone") / paragraph("two")');
    });
  }
});

describe('@lexical/y a held-back insert survives a read that keeps the composed line', () => {
  type Client = {doc: Y.Doc; editor: LexicalEditor; binding: YBinding};
  const client = (id: number, state?: Uint8Array): Client => {
    const doc = createYDoc(null, {gc: false});
    doc.clientID = id;
    if (state !== undefined) {
      Y.applyUpdate(doc, state, 'load');
    }
    const editor = createEditor({
      namespace: 'b1',
      nodes: NODES,
      onError: e => {
        throw e;
      },
    });
    const binding = new YBinding(editor, doc, {schemaVersion: 1});
    binding.start();
    return {binding, doc, editor};
  };
  const show = (c: Client) =>
    c.editor
      .getEditorState()
      .read(() => $getRoot().getChildren().map(describeNode).join(' / '));
  const edit = (c: Client, fn: () => void) =>
    c.editor.update(fn, {discrete: true});
  const $five = (): TextNode =>
    $getRoot()
      .getAllTextNodes()
      .find(n => n.getTextContent().includes('five'))!;
  const exchange = async (clients: Client[]) => {
    for (let round = 0; round < 3; round++) {
      for (const a of clients) {
        for (const b of clients) {
          if (a !== b) {
            Y.applyUpdate(
              b.doc,
              Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
              'net',
            );
            await flush();
          }
        }
      }
    }
  };
  const expectSame = (clients: Client[], expected: string) => {
    const fresh = client(99, Y.encodeStateAsUpdate(clients[0].doc));
    fresh.binding.initialize();
    for (const c of [...clients, fresh]) {
      expect(show(c)).toBe(expected);
    }
  };

  // A list `four`, `five`. C composes in `five` while it receives B's `X`
  // typed at the start of `five` (held back until the composition ends) and
  // D's indent of `four`, whose read pulls the composed line in to regroup
  // the list without reading its content: the `X` must stay held back, then
  // show, and C's later offsets in that line must count it.
  for (const indentAt of [0, 1, 2]) {
    for (const typeAt of [0, 1, 2]) {
      for (const order of ['indent first', 'type first']) {
        for (const at of ['end', 'start'] as const) {
          test(`indent at phase ${indentAt}, type at phase ${typeAt}, ${order}, composing at the ${at}`, async () => {
            const p1 = client(1);
            edit(p1, () =>
              $getRoot().append(
                $createListNode('bullet').append(
                  $createListItemNode().append($createTextNode('four')),
                  $createListItemNode().append($createTextNode('five')),
                ),
              ),
            );
            p1.binding.initialize();
            await flush();
            const base = Y.encodeStateAsUpdate(p1.doc);
            const [d, b, c] = [2, 3, 4].map(id => client(id, base));
            for (const x of [d, b, c]) {
              x.binding.initialize();
            }
            await flush();
            const sv = Y.encodeStateVector(p1.doc);
            edit(d, () => ($block([0, 0]) as ListItemNode).setIndent(1));
            edit(b, () => $five().select(0, 0).insertText('X'));
            await flush();
            const indent = Y.encodeStateAsUpdate(d.doc, sv);
            const type = Y.encodeStateAsUpdate(b.doc, sv);
            const deliver = async (phase: number) => {
              const list: [number, Uint8Array][] =
                order === 'indent first'
                  ? [
                      [indentAt, indent],
                      [typeAt, type],
                    ]
                  : [
                      [typeAt, type],
                      [indentAt, indent],
                    ];
              for (const [p, u] of list) {
                if (p === phase) {
                  Y.applyUpdate(c.doc, u, 'net');
                  await flush();
                }
              }
            };
            await deliver(0);
            edit(c, () => {
              const t = $five();
              $setCompositionKey(t.getKey());
              const offset = at === 'end' ? t.getTextContentSize() : 0;
              t.select(offset, offset);
            });
            await flush();
            await deliver(1);
            edit(c, () => $setCompositionKey(null));
            await flush();
            await deliver(2);
            const clients = [p1, d, b, c];
            await exchange(clients);
            const list = (text: string) =>
              `list[bullet](listitem(list[bullet](listitem("four"))) listitem("${text}"))`;
            expectSame(clients, list('Xfive'));
            // C types at the end of the line, then at its start.
            edit(c, () => {
              const t = $five();
              t.select(t.getTextContentSize(), t.getTextContentSize());
              $getSelection()!.insertText('Y');
            });
            await exchange(clients);
            edit(c, () => $five().select(0, 0).insertText('Z'));
            await exchange(clients);
            expectSame(clients, list('ZXfiveY'));
          });
        }
      }
    }
  }
});

// Two mergeable text nodes whose NodeState is an equal object parsed apart
// (Lexical compares such values by reference, so it keeps the nodes apart):
// every reader shows one run, and so does the author once it is not
// composing in either (R11-B F-03). The update that ends the composition
// changes the composed node alone; it is written so that the author reads
// the line back, as any other write of such a pair is.
describe('@lexical/y two runs that one composition kept apart', () => {
  const $opaque = (text: string) =>
    $createTextNode(text).updateFromJSON({
      $: {opaque: {nested: {level: 7}, tag: 'equal'}},
      detail: 0,
      format: 0,
      mode: 'normal',
      style: '',
      text,
    });
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`are one run on every client after the composition ends (ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('')), {ids});
      t.a.update(() => {
        const p = $block([0]);
        p.clear().append($opaque('on'));
      });
      await t.sync();
      // A composition in "on", during which an app appends "two".
      t.a.update(() => {
        const node = $text([0]);
        node.select(2, 2);
        $setCompositionKey(node.getKey());
      });
      t.a.update(() => {
        const node = $text([0]);
        node.setTextContent('one');
        node.select(3, 3);
      });
      t.a.update(() => {
        $block([0]).append($opaque('two'));
      });
      await t.sync();
      compositionEnd(t.a);
      await t.sync();
      const runs = (peer: Peer) =>
        peer.read(() =>
          $block([0])
            .getChildren()
            .map(n => n.getTextContent()),
        );
      // The author kept ['one', 'two'] here.
      expect(runs(t.a)).toEqual(['onetwo']);
      expect(runs(t.b)).toEqual(['onetwo']);
      await expectConverged(t.peers);
      // And the next keystroke stays one run.
      t.a.update(() => {
        const node = $text([0]);
        node.select(3, 3);
        $getSelection()!.insertText('!');
      });
      await t.sync();
      expect(runs(t.a)).toEqual(['one!two']);
      await expectConverged(t.peers);
    });
  }
});
