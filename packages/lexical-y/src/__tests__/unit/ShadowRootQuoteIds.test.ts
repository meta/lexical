/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Block ids in a quote that holds paragraphs (a shadow root). Text that lands
// directly in such a quote (typed into a paragraph a collaborator moved into
// it) is shown in a paragraph of its own, which is no unit. That paragraph
// gets the id derived from the first item of its text, as a line without a
// marker does, on every client and every read: BlockIdExtension has nothing
// to name (its naming, a follow-up that changes the quote, was not written,
// so each client kept its own unstored name, and a fresh reader made yet
// another). Applying the change writes nothing, not even the quote's storage
// record. A quote in a table cell that comes to hold paragraphs (no
// identified block there) shows no id on a client that read the change in
// place, as on a fresh reader. And the typist's caret stays in the text it
// typed, so the next keystroke goes there too, not into a new paragraph.

import '../utils/blockIdsEnv';

import {
  $getBlockId,
  BlockIdExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createQuoteNode, $isQuoteNode} from '@lexical/rich-text';
import {$createTableNodeWithDimensions} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $parseSerializedNode,
  configExtension,
  defineExtension,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';
import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  NODES,
  type Peer,
  setup,
} from '../utils/harness';

delete process.env.LEXICAL_Y_BLOCK_ID;

function $moveIntoQuote(path: number[]) {
  const p = $block(path);
  const quote = $createQuoteNode({shadowRoot: true});
  p.insertBefore(quote);
  quote.append(p);
}

function $replaceWithQuote(path: number[]) {
  const p = $block(path);
  const quote = $createQuoteNode({shadowRoot: true});
  const inner = $createParagraphNode();
  for (const child of p.getChildren()) {
    inner.append(child);
  }
  quote.append(inner);
  p.replace(quote);
}

/** Every top-level block and quote child: its text and block id. */
function ids(peer: Peer): string {
  return peer.read(() =>
    $getRoot()
      .getChildren()
      .map(b => {
        if ($isQuoteNode(b)) {
          return `quote#${$getBlockId(b)}(${(b as ElementNode)
            .getChildren()
            .map(c => `${JSON.stringify(c.getTextContent())}#${$getBlockId(c)}`)
            .join(', ')})`;
        }
        return `${JSON.stringify(b.getTextContent())}#${$getBlockId(b)}`;
      })
      .join(' / '),
  );
}

/** The id of the quote's child that holds `text`. */
const idOf = (peer: Peer, text: string) =>
  peer.read(() => {
    const quote = $getRoot().getChildren().find($isQuoteNode) as ElementNode;
    const child = quote
      .getChildren()
      .find(c => c.getTextContent().includes(text));
    return child === undefined ? undefined : $getBlockId(child);
  });

/** What a peer's own transactions insert while it applies others' changes. */
function watchWrites(peers: Peer[]): {on: boolean; writes: string[]} {
  const w = {on: false, writes: [] as string[]};
  for (const peer of peers) {
    peer.doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (!w.on || !tr.local || tr.origin === peer.net) {
        return;
      }
      Y.iterateStructsByIdSet(tr, tr.insertSet, s => {
        if (s instanceof Y.Item) {
          w.writes.push(
            `${peer.doc.clientID}: ${s.parentSub === null ? 'insert' : 'attr ' + s.parentSub}`,
          );
        }
      });
    });
  }
  return w;
}

describe('a paragraph a read makes around text in a quote that holds paragraphs', () => {
  for (const n of [2, 3, 33]) {
    for (const order of ['asc', 'desc']) {
      for (const [how, $wrap] of [
        ['moved into', $moveIntoQuote],
        ['replaced by', $replaceWithQuote],
      ] as const) {
        for (const start of ['', 'Lorem']) {
          const who =
            n === 33
              ? '3 clients, the third edits elsewhere and syncs last'
              : `${n} clients`;
          test(`${who} (${order}), the paragraph ${how} a quote while a peer types${start === '' ? ' into it empty' : ''}: one derived id everywhere`, async () => {
            const clientIds = n === 2 ? [1, 2] : [1, 2, 3];
            if (order === 'desc') {
              clientIds.reverse();
            }
            const t = await setup(
              () => $getRoot().append($p('one'), $p(start), $p('end')),
              {ids: clientIds},
            );
            const watch = watchWrites(t.peers);
            t.offline();
            t.a.update(() => $wrap([1]));
            if (n === 33) {
              t.c.update(() => {
                $selectIn([2], 3).insertText('!');
              });
            }
            t.b.update(() => {
              if (start === '') {
                $block([1]).select(0, 0).insertText('qa');
              } else {
                $selectIn([1], start.length).insertText('qa');
              }
            });
            watch.on = true;
            if (n === 33) {
              // A and B exchange first; C (which edited "end") comes in last.
              t.a.online = true;
              t.b.online = true;
              for (const [from, to] of [
                [t.a, t.b],
                [t.b, t.a],
              ] as const) {
                const list = to.pending.get(from) ?? [];
                to.pending.delete(from);
                for (const u of list) {
                  Y.applyUpdate(to.doc, u, to.net);
                }
              }
              await new Promise(r => setTimeout(r, 5));
            }
            await t.sync();
            watch.on = false;
            const fresh = await freshReader(t.a);
            const all = [...t.peers, fresh];
            expect(new Set(all.map(ids)).size).toBe(1);
            // The id derived from the typed text's first item.
            expect(idOf(fresh, 'qa')).toMatch(/^y[0-9a-z]+_[0-9a-z]+$/);
            expect(watch.writes).toEqual([]);
            for (const p of all) {
              expect(p.warnings).toEqual([]);
            }
            await expectConverged(t.peers);
            // A local edit there stores the id it shows: it stays.
            const id = idOf(fresh, 'qa');
            t.peers[t.peers.length - 1].update(() => {
              const quote = $getRoot()
                .getChildren()
                .find($isQuoteNode) as ElementNode;
              const para = quote
                .getChildren()
                .find(c => c.getTextContent().includes('qa')) as ElementNode;
              para.selectEnd().insertText('!');
            });
            await t.sync();
            const fresh2 = await freshReader(t.a);
            for (const p of [...t.peers, fresh2]) {
              expect(idOf(p, 'qa!')).toBe(id);
            }
            expect(new Set([...t.peers, fresh2].map(ids)).size).toBe(1);
          });
        }
      }
    }
  }
});

describe("the typist's caret", () => {
  const $caret = (): string => {
    const s = $getSelection();
    if (!$isRangeSelection(s)) {
      return String(s);
    }
    const node: LexicalNode = s.anchor.getNode();
    const where = $isTextNode(node)
      ? `text(${JSON.stringify(node.getTextContent())})`
      : `${node.getType()}[${$isElementNode(node) ? node.getChildrenSize() : '-'}]`;
    return `${where}@${s.anchor.offset}${s.isCollapsed() ? '' : '~'}`;
  };
  for (const clientIds of [
    [1, 2],
    [2, 1],
  ]) {
    for (const [how, $wrap] of [
      ['moved into', $moveIntoQuote],
      ['replaced by', $replaceWithQuote],
    ] as const) {
      for (const start of ['', 'Lorem']) {
        test(`the paragraph ${how} a quote while a peer types${start === '' ? ' into it empty' : ''} (client ids ${clientIds}): the caret stays in the typed text`, async () => {
          const t = await setup(
            () => $getRoot().append($p('one'), $p(start), $p('end')),
            {ids: clientIds},
          );
          t.offline();
          t.a.update(() => $wrap([1]));
          t.b.update(() => {
            if (start === '') {
              $block([1]).select(0, 0).insertText('qa');
            } else {
              $selectIn([1], start.length).insertText('qa');
            }
          });
          await t.sync();
          expect(t.b.read($caret)).toBe('text("qa")@2');
          // The next keystroke goes there, not into a new paragraph.
          t.b.update(() => {
            const s = $getSelection();
            if ($isRangeSelection(s)) {
              s.insertText('!');
            }
          });
          await t.sync();
          expect(t.b.read($caret)).toBe('text("qa!")@3');
          const fresh = await freshReader(t.a);
          for (const p of [...t.peers, fresh]) {
            // (The order of the two paragraphs depends on the client ids.)
            expect(
              p
                .read(() =>
                  ($getRoot().getChildren().find($isQuoteNode) as ElementNode)
                    .getChildren()
                    .map(c => c.getTextContent()),
                )
                .sort(),
            ).toEqual([start, 'qa!'].sort());
          }
          await expectConverged(t.peers);
        });
      }
    }
  }
});

function mixedPeer(id: number, blockIds: boolean, update: Uint8Array | null) {
  const doc = createYDoc();
  doc.clientID = id;
  if (update !== null) {
    Y.applyUpdate(doc, update);
  }
  const warnings: string[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        ...(blockIds ? [BlockIdExtension] : []),
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
        }),
      ],
      name: `cell-quote/${id}`,
      nodes: NODES,
      onError: e => {
        throw e;
      },
      onWarn: e => warnings.push(String(e)),
    }),
  );
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.binding;
  return {binding, doc, editor, warnings};
}
const idle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

describe('a copy of the id such a paragraph shows', () => {
  for (const where of ['before', 'after']) {
    test(`stored by a block ${where} the quote: the first in document order keeps it, on every reader, and nothing is written`, async () => {
      // The race, between two clients without BlockIdExtension.
      const a = mixedPeer(1, false, null);
      a.editor.update(
        () => {
          $getRoot().clear().append($p('one'), $p('Lorem'), $p('end'));
        },
        {discrete: true},
      );
      a.binding.initialize();
      await idle();
      const b = mixedPeer(2, false, Y.encodeStateAsUpdate(a.doc));
      await idle();
      a.editor.update(() => $moveIntoQuote([1]), {discrete: true});
      b.editor.update(
        () => {
          $selectIn([1], 5).insertText('qa');
        },
        {discrete: true},
      );
      await idle();
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
      await idle();
      // A reader with BlockIdExtension shows the paragraph around "qa" with
      // its derived id; a writer without it pastes that paragraph's JSON.
      const c = mixedPeer(3, true, Y.encodeStateAsUpdate(a.doc));
      await idle();
      const shown = c.editor.getEditorState().read(() => {
        const quote = $getRoot().getChildren().find($isQuoteNode)!;
        const para = (quote as ElementNode)
          .getChildren()
          .find(n => n.getTextContent() === 'qa')!;
        return {id: $getBlockId(para)!, json: para.exportJSON()};
      });
      expect(shown.id).toMatch(/^y[0-9a-z]+_[0-9a-z]+$/);
      a.editor.update(
        () => {
          const quote = $getRoot().getChildren().find($isQuoteNode)!;
          const copy = $parseSerializedNode(shown.json);
          if (where === 'before') {
            quote.insertBefore(copy);
          } else {
            quote.insertAfter(copy);
          }
        },
        {discrete: true},
      );
      await idle();
      const before = (c.doc.store.clients.get(c.doc.clientID) ?? []).length;
      Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(a.doc));
      await idle();
      const fresh = mixedPeer(4, true, Y.encodeStateAsUpdate(a.doc));
      await idle();
      const runAndCopy = (p: {
        editor: {getEditorState: () => {read: <T>(f: () => T) => T}};
      }) =>
        p.editor.getEditorState().read(() => {
          const quote = $getRoot().getChildren().find($isQuoteNode)!;
          const run = (quote as ElementNode)
            .getChildren()
            .find(n => n.getTextContent() === 'qa')!;
          const copy = (
            where === 'before'
              ? quote.getPreviousSibling()
              : quote.getNextSibling()
          )!;
          return [$getBlockId(run), $getBlockId(copy)];
        });
      const [run, copy] = runAndCopy(c);
      expect(runAndCopy(fresh)).toEqual([run, copy]);
      if (where === 'before') {
        expect(copy).toBe(shown.id);
        expect(run).toBe(shown.id + '_d');
      } else {
        expect(run).toBe(shown.id);
        expect(copy).not.toBe(shown.id);
      }
      expect((c.doc.store.clients.get(c.doc.clientID) ?? []).length).toBe(
        before,
      );
      expect(c.warnings).toEqual([]);
      expect(fresh.warnings).toEqual([]);
    });
  }
});

describe('a quote in a table cell that comes to hold paragraphs', () => {
  const $quote = () => {
    const table = $assertNodeType(
      $getRoot().getFirstChildOrThrow(),
      $isElementNode,
    );
    const cell = $assertNodeType(
      $assertNodeType(
        table.getFirstChildOrThrow(),
        $isElementNode,
      ).getFirstChildOrThrow(),
      $isElementNode,
    );
    return $assertNodeType(cell.getFirstChildOrThrow(), $isQuoteNode);
  };
  const cellIds = (editor: {
    getEditorState: () => {read: <T>(f: () => T) => T};
  }) =>
    editor.getEditorState().read(() => {
      const q = $quote();
      return `quote#${$getBlockId(q)}(${q
        .getChildren()
        .map(c => `${c.getType()}#${$getBlockId(c)}`)
        .join(', ')})`;
    });

  test('a client that reads the change in place shows what a fresh reader shows (no id on the quote)', async () => {
    // Written by a client without BlockIdExtension, so no id is stored.
    const a = mixedPeer(1, false, null);
    a.editor.update(
      () => {
        const table = $createTableNodeWithDimensions(1, 1, false);
        const cell = $assertNodeType(
          $assertNodeType(
            table.getFirstChildOrThrow(),
            $isElementNode,
          ).getFirstChildOrThrow(),
          $isElementNode,
        );
        cell
          .clear()
          .append($createQuoteNode().append($createTextNode('quoted')));
        $getRoot().clear().append(table, $createParagraphNode());
      },
      {discrete: true},
    );
    a.binding.initialize();
    await idle();
    const b = mixedPeer(2, true, Y.encodeStateAsUpdate(a.doc));
    await idle();
    // A quote that holds text is an identified block in a cell.
    expect(cellIds(b.editor)).toMatch(
      /^quote#y[0-9a-z]+_[0-9a-z]+\(text#null\)$/,
    );
    a.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'b') {
        Y.applyUpdate(b.doc, u, 'a');
      }
    });
    const before = (b.doc.store.clients.get(b.doc.clientID) ?? []).length;
    a.editor.update(
      () => {
        $quote().setIsShadowRoot(true);
      },
      {discrete: true},
    );
    await idle();
    const fresh = mixedPeer(3, true, Y.encodeStateAsUpdate(a.doc));
    await idle();
    expect(cellIds(b.editor)).toBe(cellIds(fresh.editor));
    // A quote that holds paragraphs is no identified block in a cell.
    expect(cellIds(fresh.editor)).toMatch(
      /^quote#null\(paragraph#y[0-9a-z]+_[0-9a-z]+(_l)?\)$/,
    );
    expect((b.doc.store.clients.get(b.doc.clientID) ?? []).length).toBe(before);
    expect(b.warnings).toEqual([]);
    expect(fresh.warnings).toEqual([]);
  });
});
