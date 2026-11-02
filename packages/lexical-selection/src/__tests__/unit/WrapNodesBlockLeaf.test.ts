/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  buildEditorFromExtensions,
  HorizontalRuleExtension,
} from '@lexical/extension';
import {$createQuoteNode, QuoteNode} from '@lexical/rich-text';
import {$wrapNodes} from '@lexical/selection';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  defineExtension,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type PointType,
} from 'lexical';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

// #9638: a block leaf (a horizontal rule) in an element that is not a block
// container (a box that declares no structure): $wrapNodes took the box for
// the rule's block, moved all the box's children into one new element, those
// before the range included, and put the new elements next to one of them,
// inside that new element. The update never returned. A block leaf there is
// now wrapped on its own, as in a block container.

/** A plain block element that holds blocks, with no declared structure. */
class BoxNode extends ElementNode {
  $config() {
    return this.config('test_wrap_box', {extends: ElementNode});
  }
}

// A cycle in the tree makes the update walk parents forever: a guard turns
// that into an error, so a hang fails the test instead of the run.
const LIMIT = 1_000_000;
let parentCalls = 0;
const originalGetParent = ElementNode.prototype.getParent;
beforeEach(() => {
  parentCalls = 0;
  ElementNode.prototype.getParent = function (this: ElementNode) {
    if (++parentCalls > LIMIT) {
      throw new Error('getParent called more than a million times: a cycle');
    }
    return originalGetParent.call(this);
  } as typeof ElementNode.prototype.getParent;
});
afterEach(() => {
  ElementNode.prototype.getParent = originalGetParent;
});

function build() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [HorizontalRuleExtension],
      name: 'wrap-block-leaf',
      nodes: [BoxNode, QuoteNode],
    }),
  );
}

/** The texts and rules in document order, and the quotes' texts. */
function outline(editor: LexicalEditor): {
  all: string[];
  quoted: string[];
} {
  return editor.read(() => {
    const all: string[] = [];
    const quoted: string[] = [];
    const walk = (node: LexicalNode, inQuote: boolean) => {
      if ($isTextNode(node)) {
        all.push(node.getTextContent());
        if (inQuote) {
          quoted.push(node.getTextContent());
        }
      } else if ($isHorizontalRuleNode(node)) {
        all.push('<hr>');
        if (inQuote) {
          quoted.push('<hr>');
        }
      } else if ($isElementNode(node)) {
        const quote = inQuote || node.getType() === 'quote';
        node.getChildren().forEach(child => walk(child, quote));
      }
    };
    walk($getRoot(), false);
    return {all, quoted};
  });
}

// Random documents of paragraphs, rules (adjacent ones too), boxes (nested
// up to twice) and, with `directText`, text directly in a box, and random
// ranges between text and element points: the documents where $wrapNodes
// throws (a parent cycle: it would never return) or does not keep every text
// in order.
function wrapFailures(directText: boolean): string[] {
  let seed = 9638;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const failures: string[] = [];
  for (let run = 0; run < 500; run++) {
    parentCalls = 0;
    using editor = build();
    let n = 0;
    const $children = (depth: number): LexicalNode[] => {
      const out: LexicalNode[] = [];
      const count = 1 + Math.floor(random() * 4);
      for (let i = 0; i < count; i++) {
        const r = random();
        if (r < 0.25) {
          out.push($createHorizontalRuleNode());
        } else if (r < 0.4 && depth < 2) {
          out.push($create(BoxNode).append(...$children(depth + 1)));
        } else if (directText && r < 0.55 && depth > 0) {
          // Text directly in a box, next to its blocks.
          out.push($createTextNode(`t${n++}`));
        } else {
          out.push($createParagraphNode().append($createTextNode(`t${n++}`)));
        }
      }
      return out;
    };
    let before: string[] = [];
    let error: unknown = null;
    try {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append(...$children(0));
          before = $getRoot()
            .getAllTextNodes()
            .map(t => t.getTextContent());
          const points: [string, number, 'text' | 'element'][] = [];
          const collect = (node: LexicalNode) => {
            if ($isTextNode(node)) {
              for (let o = 0; o <= node.getTextContentSize(); o++) {
                points.push([node.getKey(), o, 'text']);
              }
            } else if ($isElementNode(node)) {
              for (let o = 0; o <= node.getChildrenSize(); o++) {
                points.push([node.getKey(), o, 'element']);
              }
              node.getChildren().forEach(collect);
            }
          };
          collect($getRoot());
          const a = points[Math.floor(random() * points.length)];
          const b = points[Math.floor(random() * points.length)];
          const selection = $createRangeSelection();
          (selection.anchor as PointType).set(...a);
          (selection.focus as PointType).set(...b);
          $setSelection(selection);
          $wrapNodes(selection, () => $createQuoteNode());
        },
        {discrete: true},
      );
    } catch (e) {
      error = e;
    }
    const after = outline(editor).all.filter(t => t !== '<hr>');
    // Adjacent texts may merge: compare the text in order.
    if (error !== null || after.join('') !== before.join('')) {
      failures.push(`run ${run}: ${String(error ?? after.join())}`);
    }
  }
  return failures;
}

describe('$wrapNodes with a block leaf in an element that is not a block container (#9638)', () => {
  test('a range across a horizontal rule in a box keeps every paragraph', () => {
    using editor = build();
    editor.update(
      () => {
        const bb = $createTextNode('bb');
        const cc = $createTextNode('cc');
        $getRoot()
          .clear()
          .append(
            $create(BoxNode).append(
              $createParagraphNode().append($createTextNode('aa')),
              $createParagraphNode().append(bb),
              $createHorizontalRuleNode(),
              $createParagraphNode().append(cc),
            ),
          );
        const selection = $createRangeSelection();
        selection.anchor.set(bb.getKey(), 1, 'text');
        selection.focus.set(cc.getKey(), 2, 'text');
        $setSelection(selection);
        $wrapNodes(selection, () => $createQuoteNode());
      },
      {discrete: true},
    );
    expect(outline(editor)).toEqual({
      all: ['aa', 'bb', '<hr>', 'cc'],
      quoted: ['bb', '<hr>', 'cc'],
    });
    // The rule stays in the box, next to the paragraphs.
    expect(
      editor.read(() =>
        $getRoot()
          .getChildren()
          .map(n => n.getType()),
      ),
    ).toEqual(['test_wrap_box']);
  });

  test('a range that starts at the rule', () => {
    using editor = build();
    editor.update(
      () => {
        const cc = $createTextNode('cc');
        const box = $create(BoxNode).append(
          $createParagraphNode().append($createTextNode('aa')),
          $createHorizontalRuleNode(),
          $createParagraphNode().append(cc),
        );
        $getRoot().clear().append(box);
        const selection = $createRangeSelection();
        selection.anchor.set(box.getKey(), 1, 'element');
        selection.focus.set(cc.getKey(), 2, 'text');
        $setSelection(selection);
        $wrapNodes(selection, () => $createQuoteNode());
      },
      {discrete: true},
    );
    expect(outline(editor)).toEqual({
      all: ['aa', '<hr>', 'cc'],
      quoted: ['<hr>', 'cc'],
    });
  });

  // A box that holds text directly is the block of that text and of the
  // rules next to it: its children move together, as before.
  for (const backward of [false, true]) {
    test(`a box with text and two rules in it, from the second rule (${backward ? 'backward' : 'forward'})`, () => {
      using editor = build();
      editor.update(
        () => {
          const cc = $createTextNode('cc');
          const box = $create(BoxNode).append(
            $createTextNode('aa'),
            $createHorizontalRuleNode(),
            $createHorizontalRuleNode(),
            cc,
          );
          $getRoot().clear().append(box);
          const selection = $createRangeSelection();
          const [from, to] = backward
            ? [selection.focus, selection.anchor]
            : [selection.anchor, selection.focus];
          from.set(box.getKey(), 2, 'element');
          to.set(cc.getKey(), 2, 'text');
          $setSelection(selection);
          $wrapNodes(selection, () => $createQuoteNode());
        },
        {discrete: true},
      );
      expect(outline(editor).all).toEqual(['aa', '<hr>', '<hr>', 'cc']);
    });
  }

  test('control: the same range without the rule', () => {
    using editor = build();
    editor.update(
      () => {
        const bb = $createTextNode('bb');
        const cc = $createTextNode('cc');
        $getRoot()
          .clear()
          .append(
            $create(BoxNode).append(
              $createParagraphNode().append($createTextNode('aa')),
              $createParagraphNode().append(bb),
              $createParagraphNode().append(cc),
            ),
          );
        const selection = $createRangeSelection();
        selection.anchor.set(bb.getKey(), 1, 'text');
        selection.focus.set(cc.getKey(), 2, 'text');
        $setSelection(selection);
        $wrapNodes(selection, () => $createQuoteNode());
      },
      {discrete: true},
    );
    expect(outline(editor)).toEqual({
      all: ['aa', 'bb', 'cc'],
      quoted: ['bb', 'cc'],
    });
  });

  test('control: a rule at the root', () => {
    using editor = build();
    editor.update(
      () => {
        const bb = $createTextNode('bb');
        const cc = $createTextNode('cc');
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('aa')),
            $createParagraphNode().append(bb),
            $createHorizontalRuleNode(),
            $createParagraphNode().append(cc),
          );
        const selection = $createRangeSelection();
        selection.anchor.set(bb.getKey(), 1, 'text');
        selection.focus.set(cc.getKey(), 2, 'text');
        $setSelection(selection);
        $wrapNodes(selection, () => $createQuoteNode());
      },
      {discrete: true},
    );
    expect(outline(editor)).toEqual({
      all: ['aa', 'bb', '<hr>', 'cc'],
      quoted: ['bb', '<hr>', 'cc'],
    });
  });

  test('property: random box, rule and paragraph mixes', () => {
    expect(wrapFailures(false)).toEqual([]);
  });

  // With text directly in a box next to its blocks, $wrapNodes reorders text
  // or never returns in some documents on main too (#9665): pinned until
  // that is fixed. This change adds no failure there (main fails 8 of these
  // 500 documents, 4 of them by never returning; this change fails 7, 3 by
  // never returning, all of them among main's).
  test.fails('property: with text directly in a box (#9665)', () => {
    expect(wrapFailures(true)).toEqual([]);
  });
});
