/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes with an input method in a line while B makes it a block of
// another type: the update that ends the composition re-types the line as A's
// editor showed it, which is not written (DECISIONS.md D115); the line is read
// again as stored and its transforms run again on it, as A's own edit, and
// the writer writes what they make where it stays in that line, in place.
// Where they would change anything else, nothing is written and the line
// stays as stored, as on main. Histories from the block-conversion lane (see
// LaneFuzz.test.ts), each with no finding, which writing everything the
// transforms make got wrong:
// - an inline decorator in a line B made a code block, which A's highlighter
//   turns into its text, and one in a heading an app's transform makes a code
//   block;
// - the underlined code block after a heading B made, which an app's
//   transform that splits, replaces or unwraps that heading marks dirty, and
//   which A's highlighter would tokenize, dropping its underline.
// And a decorator two inline elements deep in a line B made a code block,
// which A's highlighter would take apart, is kept.

import {$createCodeHighlightNode, $createCodeNode} from '@lexical/code';
import {PrismTokenizer, registerCodeHighlighting} from '@lexical/code-prism';
import {loadCodeLanguage, loadCodeTheme} from '@lexical/code-shiki';
import {
  $createHashtagNode,
  HashtagNode,
  registerLexicalHashtag,
} from '@lexical/hashtag';
import {$createLinkNode} from '@lexical/link';
import {$createListItemNode, $createListNode, $insertList} from '@lexical/list';
import {$createHeadingNode} from '@lexical/rich-text';
import {$createTableNodeWithDimensions} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isElementNode,
  $setCompositionKey,
  $setSelection,
  $setState,
  createState,
  type ElementNode,
  TextNode,
} from 'lexical';
import {beforeAll, describe, expect, onTestFinished, test} from 'vitest';

import {HOLD_NODES, HoldBox, HoldChip} from '../../utils/composeHold';
import {expectConverged, freshReader, NODES, setup} from '../../utils/harness';
import {type BlockConvConfig, blockConvLane} from '../../utils/lanes/blockconv';
import {type LaneHistory, runSafe} from '../../utils/lanes/common';

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
    "an inline decorator in a line B made a code block, which A's highlighter would turn into its text",
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
    "an inline decorator in a heading B made, which an app's transform makes a code block",
    {
      align: true,
      autolink: false,
      content: 'hashtag',
      decor: true,
      endBold: true,
      endScope: 'line',
      from: 'listitem',
      highlighter: 'Shiki',
      parentXform: 'bold',
      relxform: 'replace-code',
      rxScope: 'all',
      untouched: 'code',
    },
    101554,
    false,
    [11, 22],
  ],
  [
    "the underlined code block after a heading B made, which an app's transform splits",
    {
      align: true,
      content: 'hashtag',
      firstBlock: true,
      from: 'code',
      parentXform: 'bold',
      pxScope: 'all',
      relxform: 'split',
      replacement: 'factory',
      untouched: 'code',
      via: 'listitem',
    },
    100392,
    true,
    [11, 22],
  ],
  [
    "the underlined code block after a heading B made, which an app's transform replaces",
    {
      align: true,
      content: 'hashtag',
      decor: true,
      endBold: true,
      endNote: true,
      endScope: 'line',
      firstBlock: true,
      highlighter: 'Shiki',
      parentXform: 'note',
      pxScope: 'all',
      relxform: 'replace',
      replacement: 'chain',
      scope: 'all',
      untouched: 'code',
    },
    100453,
    true,
    [22, 11],
  ],
  [
    "the underlined code block after a heading B made, which an app's transform unwraps into the line before it",
    {
      align: true,
      autolink: false,
      content: 'hashtag',
      decor: true,
      endBold: true,
      highlighter: 'Shiki',
      pxScope: 'all',
      relxform: 'unwrap',
      untouched: 'code',
    },
    103172,
    true,
    [11, 22],
  ],
];

describe('the transforms run again on a line read as stored after its re-typing was not written leave alone', () => {
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
  test.each([false, true])(
    'a decorator two inline elements deep in a line B made a code block, which a code highlighter would take apart (gc %s)',
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
      const $lineAt = (index: number): ElementNode => {
        const line = $getRoot().getChildAtIndex(index);
        if (!$isElementNode(line)) {
          throw new Error(`no line ${index}`);
        }
        return line;
      };
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

describe('another block the transforms run again only mark dirty', () => {
  const $lineAt = (index: number): ElementNode => {
    const line = $getRoot().getChildAtIndex(index);
    if (!$isElementNode(line)) {
      throw new Error(`no line ${index}`);
    }
    return line;
  };
  // With a DOM, a block holding only a link whose text is bold or styled
  // takes that format from Lexical's reconciler, which the binding does not
  // store (text is below it): a self-check finding on main as well, apart
  // from this, so those two run without a DOM only.
  for (const gc of [false, true]) {
    for (const dom of [false, true]) {
      for (const other of (dom
        ? ['list', 'plain link']
        : ['bold link', 'styled link', 'list', 'plain link']) as (
        | 'bold link'
        | 'styled link'
        | 'list'
        | 'plain link'
      )[]) {
        test(`does not keep the hashtag made again in a line B made a heading from being written: a ${other} (gc ${gc ? 'on' : 'off'}, ${dom ? 'with' : 'without'} a DOM)`, async () => {
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('#tag')),
              );
              if (other === 'list') {
                $getRoot().append(
                  $createListNode('bullet').append(
                    $createListItemNode().append($createTextNode('tail')),
                  ),
                );
              } else {
                $getRoot().append(
                  $createParagraphNode().append(
                    $createLinkNode('https://a.test').append(
                      $createTextNode('tail')
                        .setFormat(other === 'bold link' ? 'bold' : 0)
                        .setStyle(other === 'styled link' ? 'color:red' : ''),
                    ),
                  ),
                );
              }
            },
            {gc, nodes: [...NODES, HashtagNode]},
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
          // A's transform makes a hashtag of the line's text once armed, and
          // marks the block after it dirty where the line is a heading.
          let armed = false;
          onTestFinished(
            t.a.editor.registerNodeTransform(TextNode, node => {
              if (
                !armed ||
                node.getType() !== 'text' ||
                !node.getTextContent().startsWith('#')
              ) {
                return;
              }
              const inHeading = node.getParent()?.getType() === 'heading';
              node.replace($createHashtagNode(node.getTextContent()));
              if (inHeading) {
                $lineAt(1).markDirty();
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
          const before = await freshReader(t.a);
          const otherBefore = before.read(() => $lineAt(1).exportJSON());
          before.stop();
          armed = true;
          t.a.update(() => {
            $setCompositionKey(null);
            $lineAt(0).getAllTextNodes()[0].markDirty();
            $setSelection(null);
          });
          await t.sync();
          await t.sync();
          await expectConverged(t.peers);
          expect(t.b.read(() => $lineAt(1).exportJSON())).toEqual(otherBefore);
          for (const peer of t.peers) {
            expect(
              peer.read(() =>
                $lineAt(0)
                  .getAllTextNodes()
                  .map(n => n.getType()),
              ),
            ).toEqual(['hashtag']);
          }
        });
      }
    }
  }
});

describe('nodes the transforms run again move between lines', () => {
  const $lineAt = (index: number): ElementNode => {
    const line = $getRoot().getChildAtIndex(index);
    if (!$isElementNode(line)) {
      throw new Error(`no line ${index}`);
    }
    return line;
  };
  const note = createState('in-place-note', {
    parse: (v: unknown) => (typeof v === 'string' ? v : ''),
  });
  for (const race of ['insert', 'format', 'state'] as const) {
    for (const gc of [false, true]) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        test(`a swap of text of equal JSON with the next line is not written, and keeps B's ${race} there (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $createParagraphNode().append($createTextNode('#tag')),
                $createParagraphNode().append($createTextNode('#taxyzg')),
              ),
            {gc, ids, nodes: [...NODES, HashtagNode], withBlockIds: false},
          );
          onTestFinished(() => t.peers.forEach(p => p.stop()));
          // Once armed, A's transform swaps the text of the line B made a
          // heading with the next line's (the same text, as JSON) and makes
          // a hashtag of it.
          let armed = false;
          let swapped = false;
          onTestFinished(
            t.a.editor.registerNodeTransform(TextNode, node => {
              if (
                !armed ||
                node.getType() !== 'text' ||
                node.getParent()?.getKey() !== $lineAt(0).getKey()
              ) {
                return;
              }
              let source: TextNode = node;
              if (!swapped && node.getParent()?.getType() === 'heading') {
                swapped = true;
                const other = $lineAt(1).getFirstChildOrThrow() as TextNode;
                $lineAt(1).append(node);
                $lineAt(0).append(other);
                source = other;
              }
              source.replace($createHashtagNode(source.getTextContent()));
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
          // B's change of the next line, delivered after A's re-run.
          t.offline();
          t.b.update(() => {
            const text = $lineAt(1).getAllTextNodes()[0];
            if (race === 'insert') {
              text.spliceText(3, 0, 'REMOTE');
            } else if (race === 'format') {
              text.setFormat('bold');
            } else {
              $setState(text, note, 'B');
            }
            $setSelection(null);
          });
          armed = true;
          t.a.update(() => {
            $setCompositionKey(null);
            $lineAt(0).getAllTextNodes()[0].markDirty();
            $setSelection(null);
          });
          await new Promise(resolve => setTimeout(resolve, 20));
          armed = false;
          await t.sync();
          await t.sync();
          await expectConverged(t.peers);
          expect(t.a.read(() => $lineAt(0).getTextContent())).toBe('#taxyzg');
          expect(t.a.read(() => $lineAt(1).getTextContent())).toBe(
            race === 'insert' ? '#taREMOTExyzg' : '#taxyzg',
          );
          if (race === 'format') {
            expect(
              t.a.read(() =>
                $lineAt(1)
                  .getAllTextNodes()
                  .every(n => n.hasFormat('bold')),
              ),
            ).toBe(true);
          }
          if (race === 'state') {
            expect(
              t.a.read(() =>
                $lineAt(1)
                  .getAllTextNodes()
                  .every(n => $getState(n, note) === 'B'),
              ),
            ).toBe(true);
          }
        });
      }
    }
  }

  for (const gc of [false, true]) {
    test(`text moved from the second heading B split off the held line into the first is not written (gc ${gc ? 'on' : 'off'})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('#tag one')),
          ),
        {gc, nodes: [...NODES, HashtagNode], withBlockIds: false},
      );
      onTestFinished(() => t.peers.forEach(p => p.stop()));
      let armed = false;
      let moved = false;
      onTestFinished(
        t.a.editor.registerNodeTransform(TextNode, node => {
          if (
            !armed ||
            node.getType() !== 'text' ||
            !node.getTextContent().startsWith('#')
          ) {
            return;
          }
          const parent = node.getParentOrThrow();
          if (parent.getType() === 'heading' && !moved) {
            moved = true;
            parent.append($lineAt(1).getFirstChildOrThrow());
          }
          node.replace($createHashtagNode(node.getTextContent()));
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
        const old = $lineAt(0);
        const heading = $createHeadingNode('h2').append(...old.getChildren());
        old.replace(heading);
        const parts = heading.getAllTextNodes()[0].splitText(7);
        heading.insertAfter($createHeadingNode('h2').append(parts[1]));
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
      expect(t.a.read(() => $lineAt(1).getTextContent())).toBe(' one');
    });
  }
});

describe('a line B made a list item, made bold in the update that ends the composition, without a DOM', () => {
  for (const table of [false, true]) {
    for (const gc of [false, true]) {
      test(`gets the hashtag A's transforms make again written, undone with that update (${table ? 'in a table cell' : 'in the root'}, gc ${gc ? 'on' : 'off'})`, async () => {
        const $line = () => $getRoot().getAllTextNodes()[0].getParentOrThrow();
        const t = await setup(
          () => {
            if (table) {
              const node = $createTableNodeWithDimensions(1, 1);
              node.getAllTextNodes()[0].setTextContent('see ');
              $getRoot().append(node);
            } else {
              $getRoot().append(
                $createParagraphNode().append($createTextNode('see ')),
              );
            }
          },
          {gc, nodes: [...NODES, HashtagNode]},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        onTestFinished(registerLexicalHashtag(t.a.editor));
        t.a.update(() => {
          const text = $getRoot().getAllTextNodes()[0];
          text.selectEnd();
          $setCompositionKey(text.getKey());
          $getSelection()!.insertText('#tag');
        });
        await t.sync();
        t.b.update(() => {
          $line().selectStart();
          $insertList('bullet');
          $setSelection(null);
        });
        await t.sync();
        expect(
          (t.a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
        ).not.toBe(null);
        t.a.update(() => {
          $setCompositionKey(null);
          for (const text of $line().getAllTextNodes()) {
            text.setFormat('bold');
          }
          $setSelection(null);
        });
        await t.sync();
        await t.sync();
        await expectConverged(t.peers);
        const texts = () =>
          t.a.read(() =>
            $getRoot()
              .getAllTextNodes()
              .map(n => [n.getType(), n.getTextContent(), n.getFormat()]),
          );
        expect(texts()).toEqual([
          ['text', 'see ', 1],
          ['hashtag', '#tag', 1],
        ]);
        t.a.undo();
        await t.sync();
        await expectConverged(t.peers);
        expect(texts()).toEqual([['text', 'see #tag', 0]]);
      });
    }
  }
});

describe('text the transforms run again move within the line or remake across lines, while B edits it', () => {
  const $lineAt = (index: number): ElementNode => {
    const line = $getRoot().getChildAtIndex(index);
    if (!$isElementNode(line)) {
      throw new Error(`no line ${index}`);
    }
    return line;
  };
  const note = createState('in-place-race-note', {
    parse: (v: unknown) => (typeof v === 'string' ? v : ''),
  });
  const $race = (text: TextNode, kind: 'insert' | 'format' | 'state'): void => {
    if (kind === 'insert') {
      text.spliceText(3, 0, 'REMOTE');
    } else if (kind === 'format') {
      text.setFormat('bold');
    } else {
      $setState(text, note, 'B');
    }
  };
  for (const kind of ['insert', 'format', 'state'] as const) {
    for (const gc of [false, true]) {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        test(`a swap of equal text between the line and an inline element in it is not written, and keeps B's ${kind} in the inline element (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const $box = (): ElementNode =>
            $lineAt(0)
              .getChildren()
              .find(n => n instanceof HoldBox) as ElementNode;
          const t = await setup(
            () =>
              $getRoot().append(
                $createParagraphNode().append(
                  $createTextNode('#tag'),
                  new HoldBox().append($createTextNode('#taxyzg')),
                ),
              ),
            {gc, ids, nodes: [...HOLD_NODES, HashtagNode], withBlockIds: false},
          );
          onTestFinished(() => t.peers.forEach(p => p.stop()));
          let armed = false;
          let swapped = false;
          onTestFinished(
            t.a.editor.registerNodeTransform(TextNode, node => {
              if (
                !armed ||
                node.getType() !== 'text' ||
                node.getParent()?.getKey() !== $lineAt(0).getKey()
              ) {
                return;
              }
              let source: TextNode = node;
              if (!swapped && node.getParent()?.getType() === 'heading') {
                swapped = true;
                const other = $box().getFirstChildOrThrow() as TextNode;
                $box().insertBefore(other);
                $box().append(node);
                source = other;
              }
              source.replace($createHashtagNode(source.getTextContent()));
            }),
          );
          t.a.update(() => {
            const text = $lineAt(0).getFirstChildOrThrow() as TextNode;
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
          t.offline();
          t.b.update(() => {
            $race($box().getAllTextNodes()[0], kind);
            $setSelection(null);
          });
          armed = true;
          t.a.update(() => {
            $setCompositionKey(null);
            ($lineAt(0).getFirstChildOrThrow() as TextNode).markDirty();
            $setSelection(null);
          });
          await new Promise(resolve => setTimeout(resolve, 20));
          armed = false;
          await t.sync();
          await t.sync();
          await expectConverged(t.peers);
          expect(t.a.read(() => $box().getTextContent())).toBe(
            kind === 'insert' ? '#taREMOTExyzg' : '#taxyzg',
          );
          if (kind === 'format') {
            expect(
              t.a.read(() =>
                $box()
                  .getAllTextNodes()
                  .every(n => n.hasFormat('bold')),
              ),
            ).toBe(true);
          }
          if (kind === 'state') {
            expect(
              t.a.read(() =>
                $box()
                  .getAllTextNodes()
                  .every(n => $getState(n, note) === 'B'),
              ),
            ).toBe(true);
          }
        });

        test(`a swap, as new nodes, of text equal but for case between the two headings B split the held line into is not written, and keeps B's ${kind} in the second (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $createParagraphNode().append($createTextNode('#tag#TAXYZG')),
              ),
            {gc, ids, nodes: [...NODES, HashtagNode], withBlockIds: false},
          );
          onTestFinished(() => t.peers.forEach(p => p.stop()));
          let armed = false;
          let swapped = false;
          onTestFinished(
            t.a.editor.registerNodeTransform(TextNode, node => {
              if (
                !armed ||
                node.getType() !== 'text' ||
                !node.getTextContent().startsWith('#')
              ) {
                return;
              }
              if (node.getParent()?.getType() === 'heading' && !swapped) {
                swapped = true;
                const first = $lineAt(0).getAllTextNodes()[0];
                const second = $lineAt(1).getAllTextNodes()[0];
                const firstAgain = $createHashtagNode(
                  second.getTextContent(),
                ).setFormat(second.getFormat());
                $setState(firstAgain, note, $getState(second, note));
                const secondAgain = $createHashtagNode(
                  first.getTextContent(),
                ).setFormat(first.getFormat());
                $setState(secondAgain, note, $getState(first, note));
                first.replace(firstAgain);
                second.replace(secondAgain);
                return;
              }
              node.replace($createHashtagNode(node.getTextContent()));
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
            const old = $lineAt(0);
            const heading = $createHeadingNode('h2').append(
              ...old.getChildren(),
            );
            old.replace(heading);
            const parts = heading.getAllTextNodes()[0].splitText(7);
            heading.insertAfter($createHeadingNode('h2').append(parts[1]));
            $setSelection(null);
          });
          await t.sync();
          expect(
            (t.a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
          ).not.toBe(null);
          t.offline();
          t.b.update(() => {
            $race($lineAt(1).getAllTextNodes()[0], kind);
            $setSelection(null);
          });
          armed = true;
          t.a.update(() => {
            $setCompositionKey(null);
            $lineAt(0).getAllTextNodes()[0].markDirty();
            $setSelection(null);
          });
          await new Promise(resolve => setTimeout(resolve, 20));
          armed = false;
          await t.sync();
          await t.sync();
          await expectConverged(t.peers);
          expect(t.a.read(() => $lineAt(1).getTextContent())).toBe(
            kind === 'insert' ? '#TAREMOTEXYZG' : '#TAXYZG',
          );
          if (kind === 'format') {
            expect(
              t.a.read(() =>
                $lineAt(1)
                  .getAllTextNodes()
                  .every(n => n.hasFormat('bold')),
              ),
            ).toBe(true);
          }
          if (kind === 'state') {
            expect(
              t.a.read(() =>
                $lineAt(1)
                  .getAllTextNodes()
                  .every(n => $getState(n, note) === 'B'),
              ),
            ).toBe(true);
          }
        });
      }
    }
  }
});
