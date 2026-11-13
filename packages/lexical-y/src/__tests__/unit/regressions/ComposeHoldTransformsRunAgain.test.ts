/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A composes with an input method in a line while B types in it: B's text is
// held on A until the composition ends. The update that ends the composition
// runs A's transforms on the line A showed; an app transform there that moves
// the line is refused for the hold, which keeps B's text where it is. Once the
// hold has ended and A has read the line again, A's transforms run again on it
// as A's own edit (see DECISIONS.md D115): the line, B's text in it, moves
// where the app's transform puts it, on every peer and a fresh reader, as it
// would had the composition been one edit at its end. One undo takes back the
// move (the update that ended the composition wrote nothing of its own: the
// composed text was written as it was typed).
//
// What running the transforms again leaves alone (histories from the
// block-conversion lane, see LaneFuzz.test.ts, each with no finding):
// - a line after the composed line, which a transform restyles only because
//   a change of the composed line marks it dirty (a code block A's
//   highlighter would tokenize, dropping its underline), and the line after
//   a composed line B deletes, into which what A's ending update wrote there
//   survives: read again as stored;
// - an inline decorator in a line B made a code block, which A's highlighter
//   would turn into its text, and a link there, whose text it would take out
//   of the link, dropping the link text's NodeState: nothing is written, as
//   on main;
// - a line an app transform makes around a link of a line made bold (a split
//   that leaves the link alone in a paragraph): Lexical's reconciler gives
//   that paragraph the link's text format, which no reader shows (stored
//   nowhere: text is below it), so nothing is written, as on main.
//
// The line a hold noted is run again only when that hold ends: a hold a read
// recovery drops (rebuilding the editor) leaves it to no later hold.
//
// An inline decorator or an empty inline element (no text of its own) an
// app's transform moves between the composed line and the line after it, as
// the transforms run again, is written where it moves, once, on every peer
// and a fresh reader (main left it where it was, the app's move undone).
//
// A node of equal text an app's transform moves between the composed line and
// the line after it (two `Q`s, one bold and one underlined, swapped) is
// written where it moves, both halves of the move: the line after it keeps
// its text, but its write is not left out. A decorator the transforms remove
// at any depth (in an inline element in an inline element a code highlighter
// takes apart; in a line an app's transform removes) is not lost: nothing is
// written, as on main.

import {$createCodeHighlightNode, $createCodeNode} from '@lexical/code';
import {PrismTokenizer, registerCodeHighlighting} from '@lexical/code-prism';
import {loadCodeLanguage, loadCodeTheme} from '@lexical/code-shiki';
import {$createLinkNode} from '@lexical/link';
import {$createHeadingNode} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $setCompositionKey,
  $setSelection,
  type ElementNode,
  type LexicalEditor,
  TextNode,
} from 'lexical';
import {beforeAll, describe, expect, onTestFinished, test, vi} from 'vitest';

import {Reader} from '../../../internal/Read';
import {HOLD_NODES, HoldBox, HoldChip} from '../../utils/composeHold';
import {expectConverged, freshReader, setup} from '../../utils/harness';
import {type BlockConvConfig, blockConvLane} from '../../utils/lanes/blockconv';
import {type LaneHistory, runSafe} from '../../utils/lanes/common';

/** Moves the block holding `marker` to the end of the root while armed. */
function registerMoveToEnd(
  editor: LexicalEditor,
  marker: string,
  armed: {on: boolean},
) {
  return editor.registerNodeTransform(TextNode, node => {
    if (!armed.on) {
      return;
    }
    const block = node.getTopLevelElement();
    if (block === null || !block.getTextContent().includes(marker)) {
      return;
    }
    const last = $getRoot().getLastChild();
    if (last !== null && !last.is(block)) {
      last.insertAfter(block);
    }
  });
}

describe('an app transform that moves the line a held composition ends in', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      const variant = `gc ${gc ? 'on' : 'off'}, ids ${ids.join(',')}`;
      test(`moves it, with the text a collaborator typed in it, once the hold ends (${variant})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('intro line')),
              $createParagraphNode().append($createTextNode('see beta')),
              $createParagraphNode().append($createTextNode('tail line')),
            );
          },
          {gc, ids},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        const armed = {on: false};
        onTestFinished(registerMoveToEnd(t.a.editor, 'xyz', armed));
        // A composes `xyz` in `see be|ta`.
        t.a.update(() => {
          const line = $getRoot().getChildAtIndex(1);
          const text = $isElementNode(line) ? line.getFirstChild() : null;
          if (!(text instanceof TextNode)) {
            return;
          }
          text.select(6, 6);
          $setCompositionKey(text.getKey());
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('xyz');
          }
        });
        await t.sync();
        // B types at the start of that line: held on A.
        t.b.update(() => {
          const line = $getRoot().getChildAtIndex(1);
          const text = $isElementNode(line) ? line.getFirstChild() : null;
          if (text instanceof TextNode) {
            text.spliceText(0, 0, 'BB');
          }
          $setSelection(null);
        });
        await t.sync();
        expect(t.a.describe()).not.toContain('BB');
        // The update that ends the composition runs the app's transform.
        armed.on = true;
        t.a.update(() => {
          $setCompositionKey(null);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.anchor.getNode().markDirty();
          }
          $setSelection(null);
        });
        await t.sync();
        await expectConverged(
          t.peers,
          'paragraph("intro line") / paragraph("tail line") / paragraph("BBsee bexyzta")',
        );
        armed.on = false;
        t.a.undo();
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.describe()).toBe(
          'paragraph("intro line") / paragraph("BBsee bexyzta") / paragraph("tail line")',
        );
      });
    }
  }
});

const BASE: BlockConvConfig = {
  align: false,
  autolink: true,
  content: 'url',
  conv: 'heading',
  decor: false,
  deleteHeld: false,
  endBold: false,
  endInsert: false,
  endNote: false,
  endScope: 'node',
  firstBlock: false,
  from: 'paragraph',
  hashtag: true,
  highlighter: 'Prism',
  parentXform: 'none',
  pxScope: 'composer',
  relxform: 'none',
  replacement: 'none',
  rxScope: 'composer',
  scope: 'composer',
  untouched: 'none',
  via: 'code',
  xformScope: 'composer',
};

const LEFT_ALONE: [
  string,
  Partial<BlockConvConfig>,
  number,
  boolean,
  number[],
][] = [
  [
    'the underlined code block after a line B deletes, which what the ending update wrote there joins',
    {
      conv: 'listitem',
      deleteHeld: true,
      endNote: true,
      endScope: 'line',
      scope: 'all',
      untouched: 'code',
    },
    100035,
    false,
    [22, 11],
  ],
  [
    'the underlined code block after a heading B made, which an app transform makes a code block',
    {
      content: 'hashtag',
      endBold: true,
      endInsert: true,
      firstBlock: true,
      highlighter: 'Shiki',
      parentXform: 'bold',
      relxform: 'replace-code',
      replacement: 'withKlass',
      untouched: 'code',
    },
    100061,
    true,
    [22, 11],
  ],
  [
    'the underlined code block after a heading B made, which an app transform splits',
    {
      endInsert: true,
      endScope: 'line',
      firstBlock: true,
      from: 'quote',
      pxScope: 'all',
      relxform: 'split',
      replacement: 'factory',
      rxScope: 'all',
      untouched: 'code',
      via: 'heading',
    },
    100124,
    true,
    [11, 22],
  ],
  [
    'an inline decorator in a line B made a code block',
    {
      content: 'hashtag',
      conv: 'code',
      decor: true,
      endScope: 'line',
      firstBlock: true,
      from: 'listitem',
      parentXform: 'upper',
      replacement: 'factory',
      scope: 'all',
      untouched: 'paragraph',
      via: 'paragraph',
    },
    100042,
    false,
    [11, 22],
  ],
  [
    'an inline decorator in a heading B made, which an app transform makes a code block',
    {
      align: true,
      decor: true,
      firstBlock: true,
      highlighter: 'Shiki',
      pxScope: 'all',
      relxform: 'replace-code',
      replacement: 'chain',
      rxScope: 'all',
    },
    100104,
    true,
    [11, 22],
  ],
  [
    "a link in a quote B made a code block, whose NodeState A's highlighter would drop as it takes the link's text out",
    {
      conv: 'code',
      endScope: 'line',
      firstBlock: true,
      from: 'quote',
      parentXform: 'note',
      pxScope: 'all',
      replacement: 'chain',
      untouched: 'paragraph',
      via: 'paragraph',
    },
    104599,
    false,
    [22, 11],
  ],
  [
    'a link of a line made bold that an app transform splits into a paragraph of its own, whose text format no reader would show',
    {
      align: true,
      endBold: true,
      endScope: 'line',
      firstBlock: true,
      hashtag: false,
      pxScope: 'all',
      relxform: 'split',
      replacement: 'chain',
      untouched: 'paragraph',
      via: 'listitem',
    },
    104133,
    true,
    [22, 11],
  ],
];

describe('running the transforms again after a held composition ends leaves alone', () => {
  beforeAll(async () => {
    await loadCodeLanguage('javascript');
    await loadCodeTheme('one-light');
  });
  for (const [what, cfg, seed, gc, ids] of LEFT_ALONE) {
    test(`${what} (seed ${seed}, gc ${gc ? 'on' : 'off'})`, async () => {
      const history: LaneHistory<BlockConvConfig> = {
        cfg: {...BASE, ...cfg},
        gc,
        ids,
        lane: 'blockconv',
        seed,
      };
      expect(await runSafe(blockConvLane, history)).toEqual([]);
    }, 60_000);
  }
});

describe('the line a hold noted, when a read recovery drops that hold', () => {
  const hiddenOf = (binding: unknown) =>
    (binding as {state: {hidden: unknown}}).state.hidden;
  const $textAt = (index: number): TextNode => {
    const line = $getRoot().getChildAtIndex(index);
    const node = $isElementNode(line) ? line.getFirstChild() : null;
    if (!(node instanceof TextNode)) {
      throw new Error(`no text in line ${index}`);
    }
    return node;
  };
  for (const gc of [false, true]) {
    test(`is not run again when a later hold ends (gc ${gc ? 'on' : 'off'})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('original')),
            $createParagraphNode().append($createTextNode('second')),
            $createParagraphNode().append($createTextNode('trigger')),
          ),
        {gc},
      );
      onTestFinished(() => t.peers.forEach(p => p.stop()));
      // Upper-cases the first line, from before the second composition ends.
      const armed = {on: false};
      onTestFinished(
        t.a.editor.registerNodeTransform(TextNode, node => {
          if (armed.on && node.getTextContent().startsWith('original')) {
            node.setTextContent(node.getTextContent().toUpperCase());
          }
        }),
      );
      await t.sync();
      // A composes in the first line; B aligns it: held, and A writes again.
      t.a.update(() => {
        const n = $textAt(0);
        n.select(8, 8);
        $setCompositionKey(n.getKey());
        n.spliceText(8, 0, 'x');
      });
      await t.sync();
      t.b.update(() => {
        $textAt(0).getParentOrThrow().setFormat('center');
        $setSelection(null);
      });
      await t.sync();
      expect(hiddenOf(t.a.binding)).not.toBe(null);
      t.a.update(() => $textAt(0).spliceText(9, 0, 'z'));
      await t.sync();
      // A read of B's edit elsewhere fails once: A recovers by rebuilding its
      // editor, which drops the hold.
      const spy = vi
        .spyOn(Reader.prototype, '$apply')
        .mockImplementationOnce(() => {
          throw new Error('injected read failure');
        });
      onTestFinished(() => spy.mockRestore());
      t.b.update(() => {
        $textAt(2).spliceText(0, 0, 'B');
        $setSelection(null);
      });
      await t.sync();
      spy.mockRestore();
      expect(t.a.binding.status).toBe('active');
      expect(hiddenOf(t.a.binding)).toBe(null);
      // A composes in the second line, held for B's alignment of it, and
      // ends that composition with the transform armed.
      t.a.update(() => {
        const n = $textAt(1);
        n.select(6, 6);
        $setCompositionKey(n.getKey());
        n.spliceText(6, 0, 'y');
      });
      await t.sync();
      t.b.update(() => {
        $textAt(1).getParentOrThrow().setFormat('right');
        $setSelection(null);
      });
      await t.sync();
      expect(hiddenOf(t.a.binding)).not.toBe(null);
      armed.on = true;
      t.a.update(() => {
        $setCompositionKey(null);
        $textAt(1).markDirty();
        $setSelection(null);
      });
      await t.sync();
      const fresh = await freshReader(t.a);
      onTestFinished(() => fresh.stop());
      for (const peer of [...t.peers, fresh]) {
        expect(peer.read(() => $textAt(0).getTextContent())).toBe('originalxz');
      }
    });
  }
});

for (const [what, Kind] of [
  ['an inline decorator', HoldChip],
  ['an empty inline element', HoldBox],
] as const) {
  describe(`${what} the transforms run again move between the composed line and the next`, () => {
    const $lineAt = (index: number): ElementNode => {
      const line = $getRoot().getChildAtIndex(index);
      if (!$isElementNode(line)) {
        throw new Error(`no line ${index}`);
      }
      return line;
    };
    const $chips = () =>
      $getRoot()
        .getChildren()
        .map(line =>
          $isElementNode(line)
            ? line.getChildren().filter(c => c instanceof Kind).length
            : 0,
        )
        .join(',');
    for (const direction of ['out of', 'into'] as const) {
      for (const gc of [false, true]) {
        for (const ids of [
          [1, 2],
          [2, 1],
        ]) {
          test(`moved ${direction} the composed line, ${direction === 'out of' ? 'is written where it moves, once' : 'from the line after it, is not written: it stays where it is stored, once'} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
            const t = await setup(
              () =>
                $getRoot().append(
                  $createParagraphNode().append(
                    $createTextNode('see beta'),
                    ...(direction === 'out of' ? [new Kind()] : []),
                  ),
                  $createParagraphNode().append(
                    $createTextNode('tail line'),
                    ...(direction === 'into' ? [new Kind()] : []),
                  ),
                ),
              {gc, ids, nodes: HOLD_NODES},
            );
            onTestFinished(() => t.peers.forEach(p => p.stop()));
            // An app's transform: a centred line gives its chip to the next
            // line (out of), or takes the next line's chip (into). Only the
            // transforms run again see the line centred.
            onTestFinished(
              t.a.editor.registerNodeTransform(TextNode, node => {
                const line = node.getParent();
                const next = $isElementNode(line)
                  ? line.getNextSibling()
                  : null;
                if (
                  !$isElementNode(line) ||
                  line.getFormatType() !== 'center' ||
                  !$isElementNode(next)
                ) {
                  return;
                }
                const [from, to] =
                  direction === 'out of' ? [line, next] : [next, line];
                for (const child of from.getChildren()) {
                  if (child instanceof Kind) {
                    to.append(child);
                  }
                }
              }),
            );
            t.a.update(() => {
              const text = $lineAt(0).getFirstChild();
              if (!(text instanceof TextNode)) {
                throw new Error('no text');
              }
              text.select(6, 6);
              $setCompositionKey(text.getKey());
              text.spliceText(6, 0, 'xyz');
            });
            await t.sync();
            t.b.update(() => {
              $lineAt(0).setFormat('center');
              $setSelection(null);
            });
            await t.sync();
            expect(
              (t.a.binding as unknown as {state: {hidden: unknown}}).state
                .hidden,
            ).not.toBe(null);
            t.a.update(() => {
              $setCompositionKey(null);
              $lineAt(0).getFirstChildOrThrow().markDirty();
              $setSelection(null);
            });
            await t.sync();
            await t.sync();
            await expectConverged(t.peers);
            const fresh = await freshReader(t.a);
            onTestFinished(() => fresh.stop());
            // Into the next line, written with the composed line; out of
            // it, not written at all (a node of a line the transforms do not
            // run on left it), so it stays in that line.
            for (const peer of [...t.peers, fresh]) {
              expect(peer.read($chips)).toBe('0,1');
            }
          });
        }
      }
    }
  });
}

describe('the transforms run again, against nodes that hold no text of their own or move with equal text', () => {
  const $lineAt = (index: number): ElementNode => {
    const line = $getRoot().getChildAtIndex(index);
    if (!$isElementNode(line)) {
      throw new Error(`no line ${index}`);
    }
    return line;
  };
  for (const operation of ['swap', 'remove-box', 'remove-line'] as const) {
    for (const gc of [false, true]) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        test(`${operation} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await setup(
            () => {
              const held = $createParagraphNode().append(
                $createTextNode('see beta'),
              );
              if (operation === 'swap') {
                held.append($createTextNode('Q').setFormat('bold'));
              } else {
                held.append(
                  new HoldBox().append(new HoldBox().append(new HoldChip())),
                );
              }
              $getRoot().append(
                held,
                $createParagraphNode().append(
                  operation === 'swap'
                    ? $createTextNode('Q').setFormat('underline')
                    : $createTextNode('tail'),
                ),
              );
            },
            {gc, ids, nodes: HOLD_NODES},
          );
          onTestFinished(() => t.peers.forEach(p => p.stop()));
          // An app's transform, once, on the line B centred: it swaps its
          // last child with the next line's, removes its last child, or
          // removes the line.
          let ran = false;
          onTestFinished(
            t.a.editor.registerNodeTransform(TextNode, node => {
              const line = node.getParent();
              if (
                ran ||
                !$isElementNode(line) ||
                line.getFormatType() !== 'center'
              ) {
                return;
              }
              ran = true;
              if (operation === 'remove-line') {
                line.remove();
              } else if (operation === 'remove-box') {
                line.getLastChildOrThrow().remove();
              } else {
                const mine = line.getLastChildOrThrow();
                const theirs = $lineAt(1).getLastChildOrThrow();
                line.append(theirs);
                $lineAt(1).append(mine);
              }
            }),
          );
          t.a.update(() => {
            const text = $lineAt(0).getAllTextNodes()[0];
            text.select(3, 3);
            $setCompositionKey(text.getKey());
            text.spliceText(3, 0, 'xyz');
          });
          await t.sync();
          t.b.update(() => {
            $lineAt(0).setFormat('center');
            $setSelection(null);
          });
          await t.sync();
          expect(
            (t.a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
          ).not.toBe(null);
          t.a.update(() => {
            $setCompositionKey(null);
            $lineAt(0).getAllTextNodes()[0].markDirty();
            $setSelection(null);
          });
          await t.sync();
          await t.sync();
          await expectConverged(t.peers);
          const fresh = await freshReader(t.a);
          onTestFinished(() => fresh.stop());
          for (const peer of [...t.peers, fresh]) {
            if (operation === 'swap') {
              // Not written: a node of the line after the composed line left
              // it. Each Q stays where it is stored, once.
              expect(
                peer.read(() =>
                  $getRoot()
                    .getChildren()
                    .map(line =>
                      ($isElementNode(line) ? line.getAllTextNodes() : [])
                        .filter(n => n.getTextContent() === 'Q')
                        .map(n => n.getFormat())
                        .join(','),
                    )
                    .join('/'),
                ),
              ).toBe('1/8');
            } else {
              expect(peer.describe()).toContain('hold_chip');
            }
          }
        });
      }
    }
  }
  test.each([false, true])(
    'a decorator two inline elements deep, which a code highlighter takes apart in a line B made a code block, is kept (gc %s)',
    async gc => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('let beta = 1;'),
              new HoldBox().append(new HoldBox().append(new HoldChip())),
            ),
            $createParagraphNode().append($createTextNode('tail')),
          ),
        {gc, nodes: HOLD_NODES},
      );
      onTestFinished(() => t.peers.forEach(p => p.stop()));
      onTestFinished(registerCodeHighlighting(t.a.editor, PrismTokenizer));
      t.a.update(() => {
        const text = $getRoot().getAllTextNodes()[0];
        text.select(5, 5);
        $setCompositionKey(text.getKey());
        text.spliceText(5, 0, 'xyz');
      });
      await t.sync();
      t.b.update(() => {
        const line = $lineAt(0);
        line.replace(
          $createCodeNode('javascript').append(...line.getChildren()),
        );
        $setSelection(null);
      });
      await t.sync();
      expect(
        (t.a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
      ).not.toBe(null);
      t.a.update(() => {
        $setCompositionKey(null);
        $getRoot().getAllTextNodes()[0].markDirty();
        $setSelection(null);
      });
      await t.sync();
      await t.sync();
      await expectConverged(t.peers);
      const fresh = await freshReader(t.a);
      onTestFinished(() => fresh.stop());
      for (const peer of [...t.peers, fresh]) {
        expect(peer.describe()).toContain('hold_chip');
      }
    },
  );
});

describe('a link in the line after the composed line, marked dirty by the transforms run again', () => {
  const $lineAt = (index: number): ElementNode => {
    const line = $getRoot().getChildAtIndex(index);
    if (!$isElementNode(line)) {
      throw new Error(`no line ${index}`);
    }
    return line;
  };
  for (const dom of [false, true]) {
    for (const gc of [false, true]) {
      for (const secondBold of [false, true]) {
        test(`does not keep them from being written where its first text is plain (${dom ? 'with' : 'without'} a DOM, gc ${gc ? 'on' : 'off'}, second link ${secondBold ? 'bold' : 'plain'})`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $createParagraphNode().append($createTextNode('see beta')),
                $createParagraphNode().append(
                  $createLinkNode('https://a.test').append(
                    $createTextNode('plain'),
                  ),
                  $createLinkNode('https://b.test').append(
                    $createTextNode('bold').setFormat(secondBold ? 'bold' : 0),
                  ),
                ),
              ),
            {gc},
          );
          onTestFinished(() => t.peers.forEach(p => p.stop()));
          if (dom) {
            const host = document.createElement('div');
            document.body.append(host);
            t.a.editor.setRootElement(host);
            onTestFinished(() => {
              t.a.editor.setRootElement(null);
              host.remove();
            });
          }
          // A's tokenizer for the composed line, armed for the update that
          // ends the composition: it re-types the line and marks the line
          // after it dirty (without a DOM, it gives the second link the
          // text format the reconciler gives it with one).
          let armed = false;
          onTestFinished(
            t.a.editor.registerNodeTransform(TextNode, node => {
              if (
                !armed ||
                node.getType() !== 'text' ||
                !node.getTextContent().includes('see')
              ) {
                return;
              }
              node.replace(
                $createCodeHighlightNode(node.getTextContent(), 'keyword'),
              );
              const other = $lineAt(1);
              other.markDirty();
              if (!dom) {
                (other.getLastChildOrThrow() as ElementNode).setTextFormat(
                  secondBold ? 1 : 0,
                );
              }
            }),
          );
          t.a.update(() => {
            const text = $lineAt(0).getAllTextNodes()[0];
            text.select(3, 3);
            $setCompositionKey(text.getKey());
            text.spliceText(3, 0, 'xyz');
          });
          await t.sync();
          t.b.update(() => {
            const line = $lineAt(0);
            line.replace(
              $createHeadingNode('h2').append(...line.getChildren()),
            );
            $setSelection(null);
          });
          await t.sync();
          expect(
            (t.a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
          ).not.toBe(null);
          armed = true;
          t.a.update(() => {
            $setCompositionKey(null);
            $lineAt(0).getAllTextNodes()[0].markDirty();
            $setSelection(null);
          });
          await t.sync();
          await t.sync();
          await expectConverged(t.peers);
          for (const peer of t.peers) {
            expect(
              peer.read(() =>
                $lineAt(0)
                  .getAllTextNodes()
                  .map(n => n.getType()),
              ),
            ).toEqual(['code-highlight']);
          }
        });
      }
    }
  }
});

describe('nodes the transforms run again remake and swap between the composed line and the next', () => {
  const $lineAt = (index: number): ElementNode => {
    const line = $getRoot().getChildAtIndex(index);
    if (!$isElementNode(line)) {
      throw new Error(`no line ${index}`);
    }
    return line;
  };
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      test(`keep each of their formats once: the re-run is not written (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode('see beta'),
                $createTextNode('Q').setFormat('bold'),
              ),
              $createParagraphNode().append(
                $createTextNode('Q').setFormat('underline'),
              ),
            ),
          {gc, ids},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        // An app's transform, once, on the line B centred: it remakes its
        // last child and the next line's (new nodes, same text and format)
        // and swaps them.
        let ran = false;
        onTestFinished(
          t.a.editor.registerNodeTransform(TextNode, node => {
            const line = node.getParent();
            if (
              ran ||
              !$isElementNode(line) ||
              line.getFormatType() !== 'center'
            ) {
              return;
            }
            ran = true;
            const mine = line.getLastChildOrThrow() as TextNode;
            const theirs = $lineAt(1).getLastChildOrThrow() as TextNode;
            const mineAgain = $createTextNode(mine.getTextContent()).setFormat(
              mine.getFormat(),
            );
            const theirsAgain = $createTextNode(
              theirs.getTextContent(),
            ).setFormat(theirs.getFormat());
            mine.replace(mineAgain);
            theirs.replace(theirsAgain);
            line.append(theirsAgain);
            $lineAt(1).append(mineAgain);
          }),
        );
        t.a.update(() => {
          const text = $lineAt(0).getAllTextNodes()[0];
          text.select(3, 3);
          $setCompositionKey(text.getKey());
          text.spliceText(3, 0, 'xyz');
        });
        await t.sync();
        t.b.update(() => {
          $lineAt(0).setFormat('center');
          $setSelection(null);
        });
        await t.sync();
        expect(
          (t.a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
        ).not.toBe(null);
        t.a.update(() => {
          $setCompositionKey(null);
          $lineAt(0).getAllTextNodes()[0].markDirty();
          $setSelection(null);
        });
        await t.sync();
        await t.sync();
        await expectConverged(t.peers);
        const fresh = await freshReader(t.a);
        onTestFinished(() => fresh.stop());
        for (const peer of [...t.peers, fresh]) {
          expect(
            peer.read(
              () =>
                $getRoot()
                  .getAllTextNodes()
                  .filter(
                    n => n.getTextContent() === 'Q' && n.hasFormat('bold'),
                  ).length,
            ),
          ).toBe(1);
        }
      });
    }
  }
});
