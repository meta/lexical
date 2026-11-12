/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Regression cases for IME composition findings (#9492, the soak7 findings
// S7-8, S7-9, S7-12, S7-15, S7-28 and S7-37, findings R-1 to R-4 of the
// review of the hold-back, and B-2 and MF-1 of a review of it with other
// changes): what a collaborator changes in the
// line being composed is held back until the composition ends, the line
// keeps its nodes meanwhile, and nothing held is lost when the hold ends.
// Each case is named after its finding; the general promise is checked over
// line shapes in CompositionHoldBack.test.ts.

import {$createCodeNode} from '@lexical/code';
import {registerCodeHighlighting} from '@lexical/code-prism';
import {
  $getBlockId,
  BlockIdExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createListItemNode, $createListNode, $isListNode} from '@lexical/list';
import {$addMarkID} from '@lexical/mark';
import {$createHeadingNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import * as Y from '@y/y';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $setCompositionKey,
  $setSelection,
  type ElementNode,
  type NodeKey,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $locateIn,
  $p,
  $selectIn,
  expectConverged,
  flush,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';
import {prepareMarkState} from '../../utils/sizeOps';

const IDS = [
  [1, 2],
  [2, 1],
];

const $first = (path: number[]) =>
  $block(path).getFirstChildOrThrow() as TextNode;

/** Start composing at `offset` of text node `key`. */
function compose(peer: Peer, key: NodeKey, offset: number): NodeKey {
  peer.update(() => {
    ($getNodeByKey(key) as TextNode).select(offset, offset);
    $setCompositionKey(key);
  });
  return key;
}

const keyOf = (peer: Peer, path: number[]) =>
  peer.read(() => $first(path).getKey());

/** A composition step: text `prev` at `at` of node `key` becomes `next`. */
function step(
  peer: Peer,
  key: NodeKey,
  at: number,
  prev: string,
  next: string,
) {
  peer.update(() => {
    const node = $getNodeByKey(key) as TextNode;
    const text = node.getTextContent();
    node.setTextContent(
      text.slice(0, at) + next + text.slice(at + prev.length),
    );
    node.select(at + next.length, at + next.length);
  });
}

const endComposition = (peer: Peer) =>
  peer.update(() => $setCompositionKey(null));

const textOf = (peer: Peer, key: NodeKey) =>
  peer.read(
    () => ($getNodeByKey(key) as TextNode | null)?.getTextContent() ?? null,
  );

describe('#9492: a remote insert into a line made by joining two lines, while composing', () => {
  for (const ids of IDS) {
    for (const at of [1, 8]) {
      test(`waits for the composition to end (insert at ${at}, ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('abc def')),
              $createParagraphNode().append($createTextNode(' ghi')),
            ),
          {ids},
        );
        // A joins the two lines (as Backspace at the start of the second
        // does): the line's stored range holds the deleted marker.
        t.a.update(() => {
          const s = $first([0]).select(7, 7);
          s.focus.set($first([1]).getKey(), 0, 'text');
          s.removeText();
        });
        await t.sync();
        const key = compose(t.a, keyOf(t.a, [0]), 11);
        step(t.a, key, 11, '', 'て');
        await t.sync();
        // B types before or after the join point.
        t.b.update(() => $selectIn([0], at).insertText('XY'));
        await t.sync();
        expect(textOf(t.a, key)).toBe('abc def ghiて');
        step(t.a, key, 11, 'て', '手');
        endComposition(t.a);
        await t.sync();
        await expectConverged(
          t.peers,
          at === 1
            ? 'paragraph("aXYbc def ghi手")'
            : 'paragraph("abc def XYghi手")',
        );
      });
    }
  }
});

describe('S7-8: a peer formats a word of a highlighted code line while A composes in it', () => {
  for (const ids of IDS) {
    for (const [name, composed] of [
      ['completed', ' t87z'],
      ['cut short', ' t87'],
    ] as const) {
      test(`A, B and a fresh read agree after the composition (${name}, ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createCodeNode('javascript').append(
                $createTextNode('const t70z = fetch(t45z);'),
              ),
            ),
          {ids, prepare: editor => void registerCodeHighlighting(editor)},
        );
        const $t70z = () =>
          $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent().includes('t70z'))!;
        const [start, at] = t.a.read(() => {
          const node = $t70z();
          return [node.getKey(), node.getTextContent().indexOf('t70z') + 4];
        });
        const key = compose(t.a, start as NodeKey, at as number);
        let prev = '';
        for (let i = 2; i <= composed.length; i++) {
          step(t.a, key, at as number, prev, composed.slice(0, i));
          prev = composed.slice(0, i);
          await t.sync();
          if (i === 3) {
            t.b.update(() => {
              const node = $t70z();
              const o = node.getTextContent().indexOf('t70z');
              node.select(o, o + 4).formatText('italic');
            });
            await t.sync();
          }
        }
        endComposition(t.a);
        await t.sync();
        await expectConverged(t.peers);
      });
    }
  }
});

describe('S7-9: a peer bolds or comments a word in the text node A composes in', () => {
  for (const ids of IDS) {
    for (const kind of ['bold', 'comment'] as const) {
      test(`the composed node keeps its text until the composition ends (${kind}, ids ${ids})`, async () => {
        const t = await setup(() => $getRoot().append($p('alpha beta gamma')), {
          ids,
          prepare: prepareMarkState,
        });
        const key = compose(t.a, keyOf(t.a, [0]), 16);
        step(t.a, key, 16, '', ' に');
        await t.sync();
        t.b.update(() => {
          const s = $selectIn([0], 6, 10);
          if (kind === 'bold') {
            s.formatText('bold');
          } else {
            $addMarkID('c1', s);
          }
        });
        await t.sync();
        expect(textOf(t.a, key)).toBe('alpha beta gamma に');
        step(t.a, key, 16, ' に', ' 日本');
        endComposition(t.a);
        await t.sync();
        await expectConverged(t.peers);
        expect(
          t.a.read(() =>
            $getRoot()
              .getAllTextNodes()
              .map(n => n.getTextContent()),
          ),
        ).toEqual(['alpha ', 'beta', ' gamma 日本']);
      });
    }
  }
});

describe('S7-12: Enter while composing, after a peer typed in the composed line', () => {
  for (const ids of IDS) {
    for (const [name, at, composed, order] of [
      ['Enter at the composition start, then the end', 0, '', 'enter-end'],
      ['Enter after composed text, then the end', 4, 'かん', 'enter-end'],
      ['Enter mid-line, nothing composed, then the end', 4, '', 'enter-end'],
      ['the end, then Enter in the same task', 0, '', 'end-enter'],
    ] as const) {
      test(`the held word shows, and stays (${name}, ids ${ids})`, async () => {
        const t = await setup(() => $getRoot().append($p('s1z s2z s3z ')), {
          ids,
        });
        const key = compose(t.a, keyOf(t.a, [0]), at);
        if (composed !== '') {
          step(t.a, key, at, '', composed);
          await t.sync();
        }
        // B types a word after the composition: held back on A.
        t.b.update(() =>
          $selectIn([0], at + composed.length + 5).insertText('kb5z '),
        );
        await t.sync();
        expect(t.a.read(() => $getRoot().getTextContent())).not.toContain(
          'kb5z',
        );
        const enter = () =>
          t.a.update(() => {
            const s = $getSelection();
            if ($isRangeSelection(s)) {
              s.insertParagraph();
            }
          });
        if (order === 'enter-end') {
          enter();
          endComposition(t.a);
        } else {
          endComposition(t.a);
          enter();
        }
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.read(() => $getRoot().getTextContent())).toContain('kb5z');
        // A's next edit of that line keeps the word.
        t.a.update(() => {
          const last = $getRoot().getLastChildOrThrow() as ElementNode;
          last.selectStart().insertText('new1z ');
        });
        await t.sync();
        await expectConverged(t.peers);
        expect(t.b.read(() => $getRoot().getTextContent())).toContain('kb5z');
      });
    }
  }
});

describe('S7-15: a peer presses Enter later in the line A composes in', () => {
  for (const ids of IDS) {
    test(`the composed node keeps its key, text and line (ids ${ids})`, async () => {
      const t = await setup(
        () => $getRoot().append($p('t4z t5z t6z t7z t8z t9z t10z t11z')),
        {ids},
      );
      const key = compose(t.a, keyOf(t.a, [0]), 3);
      step(t.a, key, 3, '', 'n');
      await t.sync();
      const before = textOf(t.a, key);
      // B presses Enter after "t8z".
      t.b.update(() => $selectIn([0], 20).insertParagraph());
      await t.sync();
      t.a.read(() => {
        const node = $getNodeByKey(key) as TextNode;
        expect(node.isAttached()).toBe(true);
        expect(node.getTopLevelElementOrThrow().getIndexWithinParent()).toBe(0);
        expect(node.getTextContent()).toBe(before);
      });
      step(t.a, key, 3, 'n', '你好');
      endComposition(t.a);
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("t4z你好 t5z t6z t7z t8z") / paragraph(" t9z t10z t11z")',
      );
    });
  }
});

/** How many times `word` is in the document. */
const count = (peer: Peer, word: string) =>
  peer.read(() => $getRoot().getTextContent().split(word).length - 1);

describe('L1C-3: ending composition after a held prefix insert and a mid-line paste', () => {
  for (const ids of IDS) {
    test(`L1C-3: every pasted token is stored once before and after the end (ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('[s1] [s2] [s3] ')), {
        ids,
      });
      const key = compose(t.a, keyOf(t.a, [0]), 10);
      t.b.update(() => $selectIn([0], 0).insertText('[ke4] '));
      await t.sync();
      // The prefix is stored remotely, but still held on the composer.
      expect(textOf(t.a, key)).toBe('[s1] [s2] [s3] ');
      expect(count(t.a, '[ke4]')).toBe(0);
      expect(count(await freshReader(t.a), '[ke4]')).toBe(1);
      t.b.update(() =>
        $selectIn([0], 6).insertNodes([$p('[ke5] [ke6] '), $p('[ke7] [ke8] ')]),
      );
      await t.sync();
      const words = [
        '[ke4]',
        '[ke5]',
        '[ke6]',
        '[ke7]',
        '[ke8]',
        '[s1]',
        '[s2]',
        '[s3]',
      ];
      for (const peer of [...t.peers, await freshReader(t.a)]) {
        for (const word of words) {
          expect(count(peer, word), `before end: ${word}`).toBe(1);
        }
      }
      // No Enter or composition character is needed to duplicate the tail.
      endComposition(t.a);
      await t.sync();
      const fresh = await freshReader(t.a);
      for (const peer of [...t.peers, fresh]) {
        for (const word of words) {
          expect(count(peer, word), `after end: ${word}`).toBe(1);
        }
      }
      expect(t.a.describe()).toBe(fresh.describe());
      await expectConverged(t.peers);
    });
  }
});

describe('L1C-4: a held bold opener survives same-update composition end and Enter', () => {
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
  ]) {
    test(`L1C-4: the formerly plain prefix becomes bold and stays converged (ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('[s1] [s2] [s3] ')), {
        ids,
      });
      const endAndEnter = (peer: Peer) =>
        peer.update(() => {
          $setCompositionKey(null);
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            throw new Error('expected a composition selection');
          }
          selection.insertParagraph();
        });
      // This history matters: a plain prefix inserted before an existing
      // bold run makes the next remote format add only a bold opener.
      t.a.update(() => $selectIn([0], 0, 7).formatText('bold'));
      await t.sync();
      const first = compose(t.b, keyOf(t.b, [0]), 0);
      step(t.b, first, 0, '', 'ㅎ');
      await t.sync();
      endAndEnter(t.b);
      await t.sync();
      t.b.update(() => $selectIn([1], 0).insertText('[kb96] '));
      await t.sync();
      const prefixBold = (peer: Peer, path: number[]) =>
        peer.read(() => $first(path).hasFormat('bold'));
      expect(prefixBold(t.a, [1])).toBe(false);
      const key = compose(t.a, keyOf(t.a, [1]), 0);
      t.c.update(() => $selectIn([1], 0, 7).formatText('bold'));
      await t.sync();
      expect(prefixBold(t.a, [1])).toBe(false);
      expect(prefixBold(await freshReader(t.a), [1])).toBe(true);
      step(t.a, key, 0, '', 'ㄓ');
      await t.sync();
      endAndEnter(t.a);
      await t.sync();
      const fresh = await freshReader(t.a);
      for (const peer of [...t.peers, fresh]) {
        expect(peer.read(() => $first([2]).getTextContent())).toContain(
          '[kb96] ',
        );
        expect(prefixBold(peer, [2]), 'released prefix must be bold').toBe(
          true,
        );
        expect(peer.warnings.filter(w => w.includes('self-check'))).toEqual([]);
      }
      expect(t.a.describe()).toBe(fresh.describe());
      await expectConverged(t.peers);
      // $selectIn creates a plain selection: the new text may be plain,
      // but editing before the released prefix must not undo its bold.
      t.a.update(() => $selectIn([2], 0).insertText('[next] '));
      await t.sync();
      expect(
        t.a.read(() =>
          $block([2])
            .getAllTextNodes()
            .find(node => node.getTextContent().includes('[kb96]'))
            ?.hasFormat('bold'),
        ),
      ).toBe(true);
      expect(count(t.a, '[kb96]')).toBe(1);
      expect(count(t.a, '[next]')).toBe(1);
      expect(t.a.describe()).toBe((await freshReader(t.a)).describe());
      await expectConverged(t.peers);
    });
  }
});

describe('L1C-4: re-splitting a held-derived successor preserves its inherited bold', () => {
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
  ]) {
    for (const clearBeforeSplit of [false, true]) {
      test(`L1C-4: the second successor becomes bold on release (clear before split ${clearBeforeSplit}, ids ${ids})`, async () => {
        const t = await setup(
          () => $getRoot().append($p('[s1] [s2] [s3] '), $p('UNTouched')),
          {ids},
        );
        const untouched = keyOf(t.a, [1]);
        t.a.update(() => $selectIn([0], 0, 7).formatText('bold'));
        await t.sync();
        const first = compose(t.b, keyOf(t.b, [0]), 0);
        step(t.b, first, 0, '', 'ㅎ');
        await t.sync();
        t.b.update(() => {
          $setCompositionKey(null);
          $selectIn([0], 1).insertParagraph();
        });
        await t.sync();
        t.b.update(() => $selectIn([1], 0).insertText('[kb96] '));
        await t.sync();
        const key = compose(t.a, keyOf(t.a, [1]), 0);
        t.c.update(() => $selectIn([1], 0, 7).formatText('bold'));
        await t.sync();
        expect(t.a.read(() => $first([1]).hasFormat('bold'))).toBe(false);
        step(t.a, key, 0, '', 'ㄓ');
        await t.sync();
        // Keep composition in the original owner while its first successor
        // inherits the withheld opener; then split that successor separately.
        t.a.update(() => {
          $selectIn([1], 1).insertParagraph();
          const owner = $first([1]);
          owner.selectEnd();
          $setCompositionKey(owner.getKey());
        });
        await t.sync();
        const hidden = (
          t.a.binding as unknown as {
            state: {hidden: unknown | null};
          }
        ).state.hidden;
        expect(hidden).not.toBeNull();
        t.a.update(() => {
          if (clearBeforeSplit) {
            $setCompositionKey(null);
          }
          $selectIn([2], 3).insertParagraph();
        });
        await t.sync();
        if (!clearBeforeSplit) {
          endComposition(t.a);
          await t.sync();
        }
        const fresh = await freshReader(t.a);
        for (const peer of [...t.peers, fresh]) {
          expect(peer.read(() => $first([3]).getTextContent())).toContain(
            '96] ',
          );
          expect(
            peer.read(() => $first([3]).hasFormat('bold')),
            'second successor must render the inherited bold on release',
          ).toBe(true);
          expect(peer.warnings.filter(w => w.includes('self-check'))).toEqual(
            [],
          );
        }
        expect(t.a.describe()).toBe(fresh.describe());
        expect(keyOf(t.a, [4])).toBe(untouched);
        await expectConverged(t.peers);
      });
    }
  }
});

describe('S8-4: composition steps after a held prefix and remote paste', () => {
  test('S8-4: the throwing composition step and following step both survive in the own document', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $p('[s1] [s2] [s3] '),
          $p('[s4] 👷‍♀️🚧 [s5] '),
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('[s6] [s7] ')),
            $createListItemNode().append($createTextNode('[s8] ')),
          ),
          $p('[s9] [s10] '),
        ),
      {ids: [1, 2, 3, 4]},
    );
    const d = t.peers[3];
    const $paths = () => {
      const paths: number[][] = [];
      $getRoot()
        .getChildren()
        .forEach((node, i) => {
          if ($isListNode(node)) {
            node.getChildren().forEach((_, j) => paths.push([i, j]));
          } else {
            paths.push([i]);
          }
        });
      return paths;
    };
    const $line = (li: number) => $block($paths()[li]);
    const $selectLine = (li: number, at: number, end = at) => {
      if ($line(li).getAllTextNodes().length === 0) {
        return $line(li).select(0, 0);
      }
      const text = $line(li).getTextContent();
      const clamp = (offset: number) => {
        let value = Math.min(offset, text.length);
        const code = text.charCodeAt(value);
        if (code >= 0xdc00 && code <= 0xdfff) value--;
        return value;
      };
      return $selectIn($paths()[li], clamp(at), clamp(end));
    };
    const $paste = (li: number, at: number, texts: string[], list = false) => {
      const nodes: ElementNode[] = (list ? texts.slice(0, -1) : texts).map($p);
      if (list)
        nodes.push(
          $createListNode('bullet').append(
            $createListItemNode().append(
              $createTextNode(texts[texts.length - 1]),
            ),
          ),
        );
      $selectLine(li, at).insertNodes(nodes);
    };
    const $remove = (li: number) => {
      const line = $line(li);
      const parent = line.getParent();
      $setSelection(null);
      line.remove();
      if ($isListNode(parent) && parent.getChildrenSize() === 0)
        parent.remove();
    };
    const $cross = (li: number, at: number, li2: number, end: number) => {
      const selection = $selectLine(li, at);
      const [node, offset] = $locateIn(
        $line(li2),
        Math.min(end, $line(li2).getTextContentSize()),
      );
      selection.focus.set(node.getKey(), offset, 'text');
      selection.removeText();
    };
    // The reduced report's structural history is necessary: a plain initial
    // line catches duplication, but not the cursor failure of the next step.
    const history: [Peer, () => void][] = [
      [
        t.c,
        () => $paste(0, 11, ['[kc4] [kc5] ', '[kc6] [kc7] ', '[kc8] [kc9] ']),
      ],
      [t.c, () => $selectLine(0, 0).insertParagraph()],
      [d, () => $selectLine(3, 23).insertParagraph()],
      [
        t.c,
        () =>
          $paste(
            8,
            10,
            [
              '[kc106] [kc107] ',
              '[kc108] [kc109] ',
              '[kc110] [kc111] ',
              '[kc112] [kc113] ',
              '[kc114] ',
            ],
            true,
          ),
      ],
      [t.a, () => $cross(1, 0, 2, 0)],
      [t.b, () => $selectLine(10, 16).insertText('[kb131] ')],
      [t.a, () => $cross(4, 0, 5, 8)],
      [d, () => $selectLine(9, 8).insertText('[kd134]🏳️‍🌈 ')],
      [t.b, () => $remove(3)],
      [t.b, () => $cross(5, 40, 6, 0)],
      [d, () => $remove(6)],
      [d, () => $selectLine(6, 30, 38).formatText('bold')],
      [t.c, () => $remove(3)],
      [t.c, () => $remove(3)],
      [d, () => $cross(2, 0, 3, 10)],
      [t.a, () => $selectLine(3, 38).insertText('[ka140] ')],
      [t.b, () => $selectLine(3, 62).insertText('[kb143]🚧 ')],
      [d, () => $selectLine(3, 46).insertText('[kd145] ')],
      [d, () => $paste(0, 0, ['[kd146] [kd147] ', '[kd148] [kd149] '])],
      [t.b, () => $cross(1, 16, 2, 22)],
    ];
    for (const [peer, action] of history) {
      peer.update(action);
      await t.sync();
    }
    const [key, at] = t.b.read(() => {
      const [node, offset] = $locateIn(
        $line(3),
        Math.min(80, $line(3).getTextContentSize()),
      );
      return [node.getKey(), offset] as const;
    });
    compose(t.b, key, at);
    t.a.update(() => $selectLine(3, 0).insertText('[ka156]😀 '));
    await t.sync();
    expect(count(t.b, '[ka156]')).toBe(0);
    t.c.update(() =>
      $paste(3, 18, [
        '[kc157] [kc158] ',
        '[kc159] [kc160] ',
        '[kc161] [kc162] ',
      ]),
    );
    await t.sync();
    step(t.b, key, at, '', 'ㄓ');
    await t.sync();
    expect(t.b.errors).toEqual([]);
    expect(count(t.b, 'ㄓ')).toBe(1);
    expect(count(await freshReader(t.b), 'ㄓ')).toBe(1);
    step(t.b, key, at, 'ㄓ', '中');
    await t.sync();
    expect(count(t.b, '中')).toBe(1);
    expect(count(await freshReader(t.b), '中')).toBe(1);
    endComposition(t.b);
    await t.sync();
    for (const peer of [...t.peers, await freshReader(t.b)]) {
      expect(peer.errors).toEqual([]);
      expect(count(peer, 'ㄓ')).toBe(0);
      for (const token of [
        '中',
        '[ka156]',
        '[kc157]',
        '[kc158]',
        '[kc159]',
        '[kc160]',
        '[kc161]',
        '[kc162]',
      ]) {
        expect(count(peer, token), token).toBe(1);
      }
    }
    expect(t.b.describe()).toBe((await freshReader(t.b)).describe());
    await expectConverged(t.peers);
  });
});

describe('S8-6: BlockIdExtension preserves pasted block NodeState across composition release', () => {
  test('S8-6: pasted block ids agree with own-document readers and peers through following edits', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $p('[s1] [s2] [s3] '),
          $p('[s4] 👷‍♀️🚧 [s5] '),
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('[s6] [s7] ')),
            $createListItemNode().append($createTextNode('[s8] ')),
          ),
          $p('[s9] [s10] '),
        ),
      {ids: [1, 2, 3, 4, 5], withBlockIds: true},
    );
    const e = t.peers[4];
    // Address the same leaf-line indices as the eight-action report, without
    // importing its untracked simulator or changing global environment flags.
    const $paths = () => {
      const paths: number[][] = [];
      $getRoot()
        .getChildren()
        .forEach((node, i) => {
          if ($isListNode(node)) {
            node.getChildren().forEach((_, j) => paths.push([i, j]));
          } else {
            paths.push([i]);
          }
        });
      return paths;
    };
    const $line = (li: number) => $block($paths()[li]);
    const $selectLine = (li: number, at: number) =>
      $selectIn($paths()[li], Math.min(at, $line(li).getTextContentSize()));
    const paste = (
      peer: Peer,
      li: number,
      at: number,
      texts: string[],
      list = false,
    ) =>
      peer.update(() => {
        const nodes: ElementNode[] = (list ? texts.slice(0, -1) : texts).map(
          $p,
        );
        if (list) {
          nodes.push(
            $createListNode('bullet').append(
              $createListItemNode().append(
                $createTextNode(texts[texts.length - 1]),
              ),
            ),
          );
        }
        $selectLine(li, at).insertNodes(nodes);
      });
    for (const peer of t.peers) {
      expect(
        getExtensionDependencyFromEditor(peer.editor, BlockIdExtension).output
          .disabled.value,
      ).toBe(false);
    }
    t.c.update(() => $line(0).remove());
    await t.sync();
    paste(t.c, 0, 30, [
      '[kc7] [kc8] ',
      '[kc9] [kc10] ',
      '[kc11] [kc12] ',
      '[kc13] [kc14] ',
    ]);
    await t.sync();
    paste(e, 4, 10, ['[ke20] [ke21] ', '[ke22] [ke23] ', '[ke24] [ke25] ']);
    await t.sync();
    const key = t.c.read(() => $line(5).getFirstChildOrThrow().getKey());
    compose(t.c, key, 0);
    t.b.update(() => $line(2).remove());
    await t.sync();
    e.update(() => {
      const selection = $selectLine(3, 0);
      selection.focus.set($line(4).getFirstChildOrThrow().getKey(), 0, 'text');
      selection.removeText();
    });
    await t.sync();
    e.update(() => $selectLine(3, 7).insertText('[ke33] '));
    await t.sync();
    paste(
      t.a,
      3,
      14,
      ['[ka34] [ka35] ', '[ka36] [ka37] ', '[ka38] [ka39] ', '[ka40] '],
      true,
    );
    await t.sync();
    endComposition(t.c);
    await t.sync();
    const rows = (peer: Peer) =>
      peer.read(() => {
        const result: {type: string; text: string; id: string | null}[] = [];
        const visit = (block: ElementNode) => {
          result.push({
            id: $getBlockId(block),
            text: block.getTextContent(),
            type: block.getType(),
          });
          for (const child of block.getChildren()) {
            if ($isElementNode(child)) visit(child);
          }
        };
        for (const child of $getRoot().getChildren()) {
          if ($isElementNode(child)) visit(child);
        }
        return result;
      });
    const check = async () => {
      const fresh = await freshReader(t.c);
      expect(
        getExtensionDependencyFromEditor(fresh.editor, BlockIdExtension).output
          .disabled.value,
      ).toBe(false);
      const stored = rows(fresh);
      expect(stored.every(row => row.id !== null)).toBe(true);
      expect(stored.some(row => row.text.includes('[ka40]'))).toBe(true);
      for (const peer of t.peers) {
        expect(rows(peer), 'stored blockId NodeState must match').toEqual(
          stored,
        );
      }
      await expectConverged(t.peers);
    };
    await check();
    t.c.update(() => $selectLine(3, 0).insertText('[next-c] '));
    await t.sync();
    await check();
    t.b.update(() => $selectLine(4, 0).insertText('[next-b] '));
    await t.sync();
    await check();
  });
});

describe('S7-28: a peer pastes paragraphs into the composed line, then types in them', () => {
  for (const ids of IDS) {
    for (const [name, steps] of [
      ['one composition step', ['k']],
      ['two steps', ['k', '漢']],
    ] as const) {
      test(`every word is stored once (${name}, ids ${ids})`, async () => {
        const t = await setup(
          () => $getRoot().append($p('p0z '), $p('t9z t10z ')),
          {
            ids,
          },
        );
        const key = compose(t.a, keyOf(t.a, [1]), 9);
        // B pastes two paragraphs at the start of that line (lines made
        // before it, the last one's text joins it), then types in them.
        t.b.update(() => {
          $selectIn([1], 0).insertNodes([$p('pa1z pa2z '), $p('pb1z pb2z ')]);
        });
        await t.sync();
        t.b.update(() => $selectIn([2], 5).insertText('kb140z '));
        await t.sync();
        let prev = '';
        for (const next of steps) {
          step(t.a, key, 9, prev, next);
          prev = next;
          await t.sync();
        }
        endComposition(t.a);
        await t.sync();
        await expectConverged(t.peers);
        for (const word of ['kb140z', 'pa1z', 'pb2z', 't10z']) {
          expect(count(t.a, word)).toBe(1);
        }
      });
    }
  }
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
  ]) {
    test(`edits made offline at the start of an emptied line, composed in (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('[s1] [s2] [s3] '),
            $p('[s4] xxxxxxx [s5] '),
            $p('[s6] [s7] '),
          ),
        {ids: [...ids, 4]},
      );
      const [a, b, c, d] = t.peers;
      // C deletes most of line 2; B deletes line 1 up to line 2, which
      // joins it, and then what is left of it: an empty line.
      c.update(() => $selectIn([1], 14, 18).removeText());
      await t.sync();
      c.update(() => $selectIn([1], 7, 14).removeText());
      await t.sync();
      b.update(() => {
        const s = $selectIn([0], 0);
        s.focus.set($first([1]).getKey(), 0, 'text');
        s.removeText();
      });
      await t.sync();
      b.update(() => $selectIn([0], 0, 7).removeText());
      await t.sync();
      // Offline, D types at the line's start and presses Enter there, and A
      // types at the line's start and starts composing there.
      t.offline();
      d.update(() => $block([0]).select(0, 0).insertText('[kd29] '));
      d.update(() => $selectIn([0], 0).insertParagraph());
      a.update(() => $block([0]).select(0, 0).insertText('[ka39] '));
      const key = compose(a, keyOf(a, [0]), 0);
      await t.sync();
      // B types in the line, and A composes a step.
      b.update(() => {
        const line = $block([1]);
        const size = line.getTextContentSize();
        const s =
          size === 0 ? line.select(0, 0) : $selectIn([1], Math.min(22, size));
        s.insertText('[kb42] ');
      });
      await t.sync();
      step(a, key, 0, '', 'ㅎ');
      await t.sync();
      endComposition(a);
      await t.sync();
      await expectConverged(t.peers);
      for (const word of ['[kb42]', '[ka39]', '[kd29]']) {
        expect(count(a, word)).toBe(1);
      }
    });
    test(`a line made by joining two, with a bold first word (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('[s1] [s2] [s3] '),
            $p('[s4] [s5] '),
            $p('[s9] '),
          ),
        {ids},
      );
      t.c.update(() => $selectIn([0], 0, 5).formatText('bold'));
      // A joins the two lines after "[s1] ".
      t.a.update(() => {
        const s = $selectIn([0], 5);
        s.focus.set($first([1]).getKey(), 0, 'text');
        s.removeText();
      });
      t.c.update(() => $selectIn([0], 0).insertText('[kd6] '));
      await t.sync();
      // B composes at the line start while A and C type in the line.
      const key = compose(
        t.b,
        t.b.read(() => $block([0]).getFirstDescendant()!.getKey()),
        0,
      );
      step(t.b, key, 0, '', 'ㅎ');
      await t.sync();
      t.c.update(() => $selectIn([0], 7).insertText('[kd14] '));
      t.a.update(() => $selectIn([0], 19).insertText('[ka15] '));
      await t.sync();
      step(t.b, key, 0, 'ㅎ', '하');
      await t.sync();
      endComposition(t.b);
      await t.sync();
      await expectConverged(t.peers);
      for (const word of ['[ka15]', '[kd14]', '[kd6]']) {
        expect(count(t.a, word)).toBe(1);
      }
    });
  }
});

describe('S7-37: a peer types a word in the composed line and deletes text after it, then another types inside the word', () => {
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
    [2, 1, 3],
  ]) {
    test(`every word is stored once (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('[s1] [s2] '),
            $p('[s4] ').append(
              $createTextNode('xyzw yy ').toggleFormat('italic'),
              $createTextNode('[s5] [s6] [s7] '),
            ),
          ),
        {ids},
      );
      // A composes at the start of the line; B types a word in it (held
      // back) and deletes text after the italic run (read at once).
      const key = compose(t.a, keyOf(t.a, [1]), 0);
      t.b.update(() => $selectIn([1], 5).insertText('[ke5] '));
      t.b.update(() => $selectIn([1], 11, 16).removeText());
      await t.sync();
      // C types inside B's word, and A composes a step.
      t.c.update(() => $selectIn([1], 6).insertText('[kd10] '));
      await t.sync();
      step(t.a, key, 0, '', 'n');
      await t.sync();
      endComposition(t.a);
      await t.sync();
      await expectConverged(t.peers);
      for (const word of ['[kd10]', '[s5]', 'ke5]']) {
        expect(count(t.a, word)).toBe(1);
      }
    });
  }
});

describe('R-1: a peer deletes the end of the text node A composes in, after a line break', () => {
  for (const ids of IDS) {
    test(`the composed node keeps its key, and the next step writes into it (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('first').append(
              $createLineBreakNode(),
              $createTextNode('second'),
            ),
          ),
        {ids},
      );
      const key = compose(
        t.a,
        t.a.read(() => $block([0]).getLastChildOrThrow().getKey()),
        4,
      );
      // "first", the line break and "second" are one Yjs string.
      t.b.update(() =>
        ($block([0]).getLastChildOrThrow() as TextNode)
          .select(4, 6)
          .removeText(),
      );
      await t.sync();
      expect(textOf(t.a, key)).toBe('seco');
      step(t.a, key, 4, '', 'に');
      endComposition(t.a);
      await t.sync();
      await expectConverged(t.peers, 'paragraph("first" br "secoに")');
    });
  }
});

describe('R-2: a peer centers the line A composes in, then a read regroups the lines around it', () => {
  for (const ids of IDS) {
    test(`the line shows the alignment when the composition ends, not before (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createListNode('bullet').append(
              ...['pre', 'composed', 'next'].map(s =>
                $createListItemNode().append($createTextNode(s)),
              ),
            ),
          ),
        {ids},
      );
      const line = t.a.read(() => $block([0, 1]).getKey());
      const key = compose(t.a, keyOf(t.a, [0, 1]), 8);
      const format = () =>
        t.a.read(() => ($getNodeByKey(line) as ElementNode).getFormatType());
      t.b.update(() => $block([0, 1]).setFormat('center'));
      await t.sync();
      expect(format()).toBe('');
      // Enter at the end of the item before: the read regroups the list.
      t.b.update(() => $block([0, 0]).selectEnd().insertParagraph());
      await t.sync();
      expect(format()).toBe('');
      step(t.a, key, 8, '', 'に');
      endComposition(t.a);
      await t.sync();
      await expectConverged(t.peers);
      expect(format()).toBe('center');
    });
  }
});

describe('R-3: a peer realigns the line A composes in while a local edit of A waits to be written', () => {
  for (const ids of IDS) {
    test(`the later alignment wins (ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('composed')), {ids});
      const key = compose(t.a, keyOf(t.a, [0]), 8);
      const format = () => t.a.read(() => $block([0]).getFormatType());
      t.b.update(() => $block([0]).setFormat('center'));
      await t.sync();
      expect(format()).toBe('');
      // A composes in an update that is not discrete: it is written when
      // B's next change arrives, before that change is read.
      t.a.editor.update(() => {
        const node = $getNodeByKey(key) as TextNode;
        node.setTextContent('composedに');
        node.select(9, 9);
      });
      t.b.update(() => $block([0]).setFormat('right'));
      await t.sync();
      endComposition(t.a);
      await t.sync();
      await expectConverged(t.peers);
      expect(format()).toBe('right');
    });
  }
});

describe('R-4: A joins the line it composes in into the line before, which a peer realigned or retyped', () => {
  for (const ids of IDS) {
    for (const field of ['alignment', 'type'] as const) {
      test(`the line before keeps its own ${field} (ids ${ids})`, async () => {
        const t = await setup(
          () => $getRoot().append($p('pre'), $p('composed')),
          {
            ids,
          },
        );
        const key = compose(t.a, keyOf(t.a, [1]), 1);
        t.b.update(() => {
          if (field === 'alignment') {
            $block([1]).setFormat('center');
          } else {
            $setBlocksType($selectIn([1], 0), () => $createHeadingNode('h2'));
          }
        });
        await t.sync();
        // Backspace at the start of the line.
        t.a.update(() =>
          ($getNodeByKey(key) as TextNode).select(0, 0).deleteCharacter(true),
        );
        await t.sync();
        endComposition(t.a);
        await t.sync();
        await expectConverged(t.peers, 'paragraph("precomposed")');
        expect(t.a.read(() => $block([0]).getFormatType())).toBe('');
      });
    }
  }
});

/** The markers of `peer`'s document, in order. */
const markersOf = (peer: Peer) =>
  peer.binding.root.toArray().filter(c => c instanceof Y.Node) as Y.Node[];

describe('B-2: a peer realigns or retypes the line A composes in, then A presses Enter mid-line while composing', () => {
  for (const ids of IDS) {
    for (const change of [
      'center',
      'heading',
      'center, then A aligns it left',
    ] as const) {
      test(`both halves keep it, the other lines do not get it (${change}, ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append($p('pre'), $p('alpha beta gamma'), $p('omega')),
          {ids},
        );
        const key = compose(t.a, keyOf(t.a, [1]), 6);
        step(t.a, key, 6, '', 'に');
        await t.sync();
        t.b.update(() => {
          if (change === 'heading') {
            $setBlocksType($selectIn([1], 0), () => $createHeadingNode('h2'));
          } else {
            $block([1]).setFormat('center');
          }
        });
        await t.sync();
        if (change === 'center, then A aligns it left') {
          // An explicit local change of the held attribute wins.
          t.a.update(() => $block([1]).setFormat('left'));
          await t.sync();
        }
        // Enter after the composed text.
        t.a.update(() => {
          ($getNodeByKey(key) as TextNode).select(7, 7).insertParagraph();
        });
        await t.sync();
        endComposition(t.a);
        await t.sync();
        await expectConverged(t.peers);
        const lines = t.b.read(() =>
          $getRoot()
            .getChildren()
            .map(n =>
              [
                n.getType(),
                (n as ElementNode).getFormatType(),
                n.getTextContent(),
              ].join(':'),
            ),
        );
        const [type, format] =
          change === 'heading'
            ? ['heading', '']
            : change === 'center'
              ? ['paragraph', 'center']
              : ['paragraph', 'left'];
        expect(lines).toEqual([
          'paragraph::pre',
          `${type}:${format}:alpha に`,
          `${type}:${format}:beta gamma`,
          'paragraph::omega',
        ]);
      });
    }
  }
});

describe('MF-1: a newer client sets a field A does not know on the line A composes in', () => {
  // What A holds back while composing in the line, and what each marker
  // stores (the field, and the alignment) once A has pressed Enter in the
  // middle of the line and the room has converged.
  const run = async (composing: boolean, withOwned: boolean, ids: number[]) => {
    const t = await setup(
      () => $getRoot().append($p('pre'), $p('alpha beta gamma'), $p('omega')),
      {ids},
    );
    const key = keyOf(t.a, [1]);
    if (composing) {
      compose(t.a, key, 6);
    }
    step(t.a, key, 6, '', 'に');
    await t.sync();
    // B writes the field to the line's marker (as a client whose class
    // declares it), and an alignment A knows.
    const marker = markersOf(t.b)[1];
    t.b.doc.transact(() => {
      marker.setAttr('p:future', 'x');
      if (withOwned) {
        marker.setAttr('p:format', 'center');
      }
    });
    await t.sync();
    const hidden = (
      t.a.binding as unknown as {
        state: {
          hidden: {marker: {was: Map<string, unknown>} | null} | null;
        };
      }
    ).state.hidden;
    const held =
      hidden === null || hidden.marker === null
        ? []
        : [...hidden.marker.was.keys()];
    t.a.update(() => {
      ($getNodeByKey(key) as TextNode).select(7, 7).insertParagraph();
    });
    await t.sync();
    if (composing) {
      endComposition(t.a);
      await t.sync();
    }
    await expectConverged(t.peers);
    const markers = markersOf(t.a).map(m => [
      m.getAttr('p:future'),
      m.getAttr('p:format'),
    ]);
    return {held, markers};
  };
  for (const ids of IDS) {
    for (const withOwned of [false, true]) {
      test(`A holds nothing of it, and Enter stores it as without a composition (${withOwned ? 'with an alignment' : 'alone'}, ids ${ids})`, async () => {
        const composed = await run(true, withOwned, ids);
        const plain = await run(false, withOwned, ids);
        expect(composed.held).toEqual(withOwned ? ['p:format'] : []);
        expect(plain.held).toEqual([]);
        // The composition changes nothing A stores. The field is on both
        // halves of the split either way (see N1 in SchemaSkew.test.ts).
        expect(composed.markers).toEqual(plain.markers);
        if (withOwned) {
          expect(
            composed.markers.filter(([, format]) => format === 'center'),
          ).toHaveLength(2);
        }
      });
    }
  }
});

// N2: a composition step committed and written before a remote change the
// binding has not read yet (see Unread) is written on the document its
// editor shows: the alignment a collaborator's change set, which the
// composition holds back, is not written again as A's own, so the room ends
// as it does without the step.
describe('N2: a composition step written before an unread change of the held alignment', () => {
  const run = async (ids: number[], stepInWindow: boolean) => {
    const t = await setup(
      () => $getRoot().append($p('pre'), $p('alpha beta gamma'), $p('omega')),
      {ids},
    );
    const key = compose(t.a, keyOf(t.a, [1]), 6);
    step(t.a, key, 6, '', 'に');
    await t.sync();
    t.b.update(() => $block([1]).setFormat('center'));
    await t.sync();
    // B and C align the line at the same time, offline.
    t.offline();
    const before = Y.encodeStateVector(t.b.doc);
    t.b.update(() => $block([1]).setFormat('right'));
    t.c.update(() => $block([1]).setFormat('justify'));
    await flush();
    const change = Y.encodeStateAsUpdate(t.b.doc, before);
    if (stepInWindow) {
      // Not committed yet when B's change arrives in this task: it is
      // committed and written first, and the change is read after it.
      t.a.editor.update(() => {
        const node = $getNodeByKey(key) as TextNode;
        const text = node.getTextContent();
        node.setTextContent(text.slice(0, 7) + 'ほ' + text.slice(7));
        node.select(8, 8);
      });
    }
    Y.applyUpdate(t.a.doc, change);
    await flush();
    let own = 0;
    const items = markersOf(t.a)[1]._map;
    for (let it = items.get('p:format') ?? null; it !== null; it = it.left) {
      if (it.id.client === t.a.doc.clientID) {
        own++;
      }
    }
    await t.sync();
    endComposition(t.a);
    await t.sync();
    await expectConverged(t.peers);
    const formats = t.b.read(() =>
      $getRoot()
        .getChildren()
        .map(n => (n as ElementNode).getFormatType()),
    );
    return {formats, own};
  };
  for (const ids of [
    [3, 1, 2],
    [2, 1, 3],
    [1, 2, 3],
  ]) {
    test(`writes no alignment of its own and ends as without the step (ids ${ids})`, async () => {
      const withStep = await run(ids, true);
      const without = await run(ids, false);
      expect(withStep.own).toBe(0);
      expect(withStep.formats).toEqual(without.formats);
    });
  }
});
