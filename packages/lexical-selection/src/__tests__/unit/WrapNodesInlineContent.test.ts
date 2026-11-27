/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  buildEditorFromExtensions,
  NodeStructureExtension,
} from '@lexical/extension';
import {$createLinkNode, LinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {$createMarkNode, MarkNode} from '@lexical/mark';
import {$createOverflowNode, OverflowNode} from '@lexical/overflow';
import {$createQuoteNode, QuoteNode} from '@lexical/rich-text';
import {$wrapNodes} from '@lexical/selection';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getSlot,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  $setSlot,
  ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {
  $createTestShadowRootNode,
  TestShadowRootNode,
} from 'lexical/src/__tests__/utils';
import {LexicalNode as LexicalNodeClass} from 'lexical/src/LexicalNode';
import {describe, expect, test, vi} from 'vitest';

// #9612: $wrapNodes moves the content of each selected text's block into a
// new element. It took that block to be the text's parent, or its
// grandparent when the parent is inline, so an inline element two levels
// up (a link inside a mark) or one that is inline content although its
// isInline() is false (the character limit's OverflowNode) became a "block":
// the paragraph was split and the inline element dropped. The block of a
// selected node is its nearest ancestor that is not inline content.
//
// Input space: every nesting of up to three inline wrappers (link, mark,
// overflow) around the inner text; the selection as a caret before the
// wrappers, a caret inside the innermost text, the whole paragraph, a range
// from inside the innermost text to the end, and a range over this paragraph
// and the next; at the root and inside a shadow root; with and without
// NodeStructureExtension; with and without a wrapping element (a quote).

type Wrapper = 'link' | 'mark' | 'overflow';
const WRAPPERS: Wrapper[] = ['link', 'mark', 'overflow'];

function nestings(depth: number): Wrapper[][] {
  if (depth === 0) {
    return [[]];
  }
  return nestings(depth - 1).flatMap(rest => WRAPPERS.map(w => [w, ...rest]));
}
const SHAPES: Wrapper[][] = [1, 2, 3].flatMap(nestings);

function $wrapper(kind: Wrapper): ElementNode {
  switch (kind) {
    case 'link':
      return $createLinkNode('https://example.net');
    case 'mark':
      return $createMarkNode(['c1']);
    case 'overflow':
      return $createOverflowNode();
  }
}

function $paragraph(shape: Wrapper[]): ElementNode {
  let inner: LexicalNode = $createTextNode('inner');
  for (let i = shape.length - 1; i >= 0; i--) {
    inner = $wrapper(shape[i]).append(inner);
  }
  return $createParagraphNode().append(
    $createTextNode('abc '),
    inner,
    $createTextNode(' end'),
  );
}

/** A block's content as a string: types, nesting and text. */
function $content(node: LexicalNode): string {
  if ($isElementNode(node)) {
    return `${node.getType()}(${node.getChildren().map($content).join(',')})`;
  }
  return $isTextNode(node)
    ? JSON.stringify(node.getTextContent())
    : node.getType();
}

function $textOf(parent: ElementNode, text: string): TextNode {
  const found = parent
    .getAllTextNodes()
    .find(node => node.getTextContent() === text);
  if (!found) {
    throw new Error(`no text node ${text}`);
  }
  return found;
}

const WHERE = [
  'caret before the wrappers',
  'caret inside the inner text',
  'the whole paragraph',
  'from the inner text to the end',
  'this paragraph and the next',
] as const;

const CONTEXTS = ['root', 'shadow root'] as const;

describe('$wrapNodes keeps the inline content of the blocks it wraps (#9612)', () => {
  for (const structure of [false, true]) {
    // Under NodeStructureExtension a quote holds inline content only, so a
    // quote wrapping quotes is not a shape it allows.
    for (const wrapping of structure ? [false] : [false, true]) {
      for (const context of CONTEXTS) {
        for (const where of WHERE) {
          for (const shape of SHAPES) {
            test(`${shape.join(' > ')}, ${where}, in the ${context}${structure ? ', NodeStructureExtension' : ''}${wrapping ? ', with a wrapping element' : ''}`, () => {
              using editor = buildEditorFromExtensions({
                dependencies: structure ? [NodeStructureExtension] : [],
                name: '@wrapNodes-inline-content-test',
                nodes: [
                  LinkNode,
                  MarkNode,
                  OverflowNode,
                  QuoteNode,
                  TestShadowRootNode,
                ],
              });
              let expected = '';
              editor.update(
                () => {
                  $getRoot().clear();
                  const first = $paragraph(shape);
                  const second = $createParagraphNode().append(
                    $createTextNode('next'),
                  );
                  const holder =
                    context === 'root'
                      ? $getRoot()
                      : $createTestShadowRootNode();
                  holder.append(first, second);
                  if (context !== 'root') {
                    $getRoot().append(holder);
                  }
                },
                {discrete: true},
              );
              editor.update(
                () => {
                  const holder =
                    context === 'root'
                      ? $getRoot()
                      : ($getRoot().getFirstChildOrThrow() as ElementNode);
                  const first = holder.getFirstChildOrThrow() as ElementNode;
                  const second = first.getNextSibling() as ElementNode;
                  const inner = $textOf(first, 'inner');
                  const abc = $textOf(first, 'abc ');
                  const end = $textOf(first, ' end');
                  const selection = $createRangeSelection();
                  switch (where) {
                    case 'caret before the wrappers':
                      selection.anchor.set(abc.getKey(), 2, 'text');
                      selection.focus.set(abc.getKey(), 2, 'text');
                      break;
                    case 'caret inside the inner text':
                      selection.anchor.set(inner.getKey(), 2, 'text');
                      selection.focus.set(inner.getKey(), 2, 'text');
                      break;
                    case 'the whole paragraph':
                      selection.anchor.set(abc.getKey(), 0, 'text');
                      selection.focus.set(end.getKey(), 4, 'text');
                      break;
                    case 'from the inner text to the end':
                      selection.anchor.set(inner.getKey(), 2, 'text');
                      selection.focus.set(end.getKey(), 4, 'text');
                      break;
                    case 'this paragraph and the next': {
                      const next = $textOf(second, 'next');
                      selection.anchor.set(inner.getKey(), 2, 'text');
                      selection.focus.set(next.getKey(), 2, 'text');
                      break;
                    }
                  }
                  $setSelection(selection);
                  const wraps =
                    where === 'this paragraph and the next'
                      ? [first, second]
                      : [first];
                  const quoted = wraps
                    .map(
                      block =>
                        `quote(${block.getChildren().map($content).join(',')})`,
                    )
                    .join(',');
                  const rest =
                    wraps.length === 1 ? [$content(second)] : ([] as string[]);
                  expected = (
                    wrapping ? [`quote(${quoted})`, ...rest] : [quoted, ...rest]
                  ).join(',');
                  $wrapNodes(
                    selection,
                    () => $createQuoteNode(),
                    wrapping ? $createQuoteNode() : null,
                  );
                },
                {discrete: true},
              );
              const actual = editor.read(() => {
                const holder =
                  context === 'root'
                    ? $getRoot()
                    : ($getRoot().getFirstChildOrThrow() as ElementNode);
                return holder.getChildren().map($content).join(',');
              });
              expect(actual).toBe(expected);
            });
          }
        }
      }
    }
  }
});

// The walk up to a selected node's block never leaves the block container
// that holds the node: an inline shadow root inside a paragraph is a scope of
// its own, so the quote goes inside it and the paragraph around it stays.
// Input space: a shadow root that is inline (in the paragraph's text, inside
// a mark in it) or a block (at the root, or the paragraph's named slot
// value; a slot value is never inline); empty, holding a paragraph, or
// holding text directly; the
// selection as a caret in it (in the empty scope, or in the inner text) or
// the whole inner text; with and without NodeStructureExtension.
/** A block's content as $content prints it, with the scope's own content left out. */
function $outside(node: LexicalNode, scopeKey: string): string {
  if (node.getKey() === scopeKey) {
    return 'scope';
  }
  if ($isElementNode(node)) {
    return `${node.getType()}(${node
      .getChildren()
      .map(child => $outside(child, scopeKey))
      .join(',')})`;
  }
  return $content(node);
}

class InlineShadowNode extends ElementNode {
  $config() {
    return this.config('test_wrap_inline_shadow', {extends: ElementNode});
  }
  isInline(): true {
    return true;
  }
  isShadowRoot(): true {
    return true;
  }
  canBeEmpty(): true {
    return true;
  }
}

const SCOPES = [
  'inline, in the paragraph',
  'inline, in a mark in the paragraph',
  'block, at the root',
  "block, the paragraph's slot value",
] as const;

describe('$wrapNodes keeps a selection in a shadow root inside that scope', () => {
  for (const structure of [false, true]) {
    for (const scope of SCOPES) {
      for (const content of [
        'empty',
        'holding a paragraph',
        'holding text',
      ] as const) {
        const filled = content !== 'empty';
        for (const where of filled
          ? ['caret in the inner text', 'the whole inner text']
          : ['caret in the empty scope']) {
          test(`${scope}, ${content}, ${where}${structure ? ', NodeStructureExtension' : ''}`, () => {
            using editor = buildEditorFromExtensions({
              dependencies: structure ? [NodeStructureExtension] : [],
              name: '@wrapNodes-shadow-scope-test',
              nodes: [
                InlineShadowNode,
                MarkNode,
                QuoteNode,
                TestShadowRootNode,
              ],
            });
            let outside = '';
            let parentKey = '';
            let scopeKey = '';
            editor.update(
              () => {
                $getRoot().clear();
                const shadow = scope.startsWith('inline')
                  ? $create(InlineShadowNode)
                  : $createTestShadowRootNode();
                if (content === 'holding a paragraph') {
                  shadow.append(
                    $createParagraphNode().append($createTextNode('inside')),
                  );
                } else if (content === 'holding text') {
                  shadow.append($createTextNode('inside'));
                }
                // Token mode keeps the two outside texts apart when nothing
                // is left between them.
                const parent = $createParagraphNode().append(
                  $createTextNode('outside before').setMode('token'),
                );
                if (scope === 'inline, in the paragraph') {
                  parent.append(shadow);
                } else if (scope === 'inline, in a mark in the paragraph') {
                  parent.append($createMarkNode(['c1']).append(shadow));
                } else if (scope.endsWith('slot value')) {
                  $setSlot(parent, 'scope', shadow);
                }
                parent.append(
                  $createTextNode('outside after').setMode('token'),
                );
                $getRoot().append(parent);
                if (scope === 'block, at the root') {
                  $getRoot().append(shadow);
                }
                parentKey = parent.getKey();
                scopeKey = shadow.getKey();
                outside = $outside(parent, scopeKey);
              },
              {discrete: true},
            );
            editor.update(
              () => {
                const shadow = $getNodeByKey(scopeKey) as ElementNode;
                const selection = $createRangeSelection();
                if (!filled) {
                  selection.anchor.set(scopeKey, 0, 'element');
                  selection.focus.set(scopeKey, 0, 'element');
                } else {
                  const inside = $textOf(shadow, 'inside');
                  const caret = where === 'caret in the inner text';
                  selection.anchor.set(inside.getKey(), caret ? 3 : 0, 'text');
                  selection.focus.set(inside.getKey(), caret ? 3 : 6, 'text');
                }
                $setSelection(selection);
                $wrapNodes(selection, () => $createQuoteNode());
              },
              {discrete: true},
            );
            editor.read(() => {
              const parent = $getNodeByKey(parentKey) as ElementNode;
              const shadow = $getNodeByKey(scopeKey) as ElementNode;
              expect(parent.isAttached()).toBe(true);
              expect($outside(parent, scopeKey)).toBe(outside);
              if (scope.endsWith('slot value')) {
                expect($getSlot(parent, 'scope')?.getKey()).toBe(scopeKey);
              }
              expect($content(shadow)).toBe(
                `${shadow.getType()}(quote(${filled ? '"inside"' : ''}))`,
              );
            });
          });
        }
      }
    }
  }
});

// Each selected node's block is found by walking up its inline ancestors; the
// walks share what they found, so a whole paragraph with content nested n
// inline elements deep costs parent lookups linear in n.
class DeepInlineNode extends ElementNode {
  $config() {
    return this.config('test_wrap_deep_inline', {extends: ElementNode});
  }
  isInline(): true {
    return true;
  }
}

type Place = 'in a paragraph' | "directly in a paragraph's slot shadow root";

function parentLookups(
  depth: number,
  place: Place,
): {calls: number; nodes: number} {
  using editor = buildEditorFromExtensions({
    dependencies: [NodeStructureExtension],
    name: '@wrapNodes-depth-cost-test',
    nodes: [DeepInlineNode, QuoteNode, TestShadowRootNode],
  });
  let calls = 0;
  let nodes = 0;
  editor.update(
    () => {
      $getRoot().clear();
      let inner: LexicalNode = $createTextNode('inner');
      for (let i = 0; i < depth; i++) {
        inner = $create(DeepInlineNode).append(inner);
      }
      const content = [
        $createTextNode('prefix').setMode('token'),
        inner,
        $createTextNode('suffix').setMode('token'),
      ];
      if (place === 'in a paragraph') {
        $getRoot().append($createParagraphNode().append(...content));
      } else {
        const host = $createParagraphNode().append($createTextNode('host'));
        $setSlot(host, 'body', $createTestShadowRootNode().append(...content));
        $getRoot().append(host);
      }
    },
    {discrete: true},
  );
  editor.update(
    () => {
      const host = $getRoot().getFirstChildOrThrow() as ElementNode;
      const paragraph =
        place === 'in a paragraph'
          ? host
          : ($getSlot(host, 'body') as ElementNode);
      // From the start of the first text to the end of the last.
      const texts = paragraph.getAllTextNodes();
      const last = texts[texts.length - 1];
      const selection = $createRangeSelection();
      selection.anchor.set(texts[0].getKey(), 0, 'text');
      selection.focus.set(last.getKey(), last.getTextContentSize(), 'text');
      $setSelection(selection);
      nodes = selection.getNodes().length;
      const getParent = LexicalNodeClass.prototype.getParent;
      const spy = vi
        .spyOn(LexicalNodeClass.prototype, 'getParent')
        .mockImplementation(function (this: LexicalNode) {
          calls++;
          return getParent.call(this);
        });
      try {
        $wrapNodes(selection, () => $createQuoteNode());
      } finally {
        spy.mockRestore();
      }
    },
    {discrete: true},
  );
  return {calls, nodes};
}

for (const place of [
  'in a paragraph',
  "directly in a paragraph's slot shadow root",
] as const) {
  test(`$wrapNodes looks up parents linearly in the inline nesting depth (${place})`, () => {
    const [d32, d64, d128] = [32, 64, 128].map(depth =>
      parentLookups(depth, place),
    );
    expect(d128.nodes).toBeGreaterThan(d64.nodes);
    // Doubling the depth at most a little more than doubles the lookups (a
    // walk per node from scratch quadruples them).
    expect(d128.calls / d64.calls).toBeLessThan(2.5);
    expect(d64.calls / d32.calls).toBeLessThan(2.5);
  });
}

// A block container whose children mix inline content and blocks: each run
// of inline content (see $inlineRun) and each block is wrapped on its own,
// in document order, and every text node keeps its identity and place.
// Input space: the container is a block shadow root at the root, a block
// shadow root that is a paragraph's named slot value, or an inline shadow
// root in a paragraph; its children are one of several mixes of direct text
// and paragraphs (one with a mark), only text, or only paragraphs; the
// selection runs over all of it, from its first text to the middle, or from
// the middle to its last text, forward and backward; with and without
// NodeStructureExtension.
const MIXES: (string | string[])[][] = [
  ['AA', ['BB'], 'CC'],
  [['AA'], 'BB', ['CC']],
  ['AA', 'BB', ['CC'], 'DD'],
  [['AA'], ['BB'], 'CC'],
  ['AA', 'BB', 'CC'],
  [['AA'], ['BB'], ['CC']],
];
const CONTAINERS = [
  'block shadow root at the root',
  "block shadow root, a paragraph's slot value",
  'inline shadow root in a paragraph',
] as const;
const SPANS = [
  'all of it',
  'first text to the middle',
  'middle to the last text',
] as const;

/** The text nodes under `node`, in document order, as key:text. */
function $texts(node: LexicalNode): string[] {
  if ($isElementNode(node)) {
    return node.getChildren().flatMap($texts);
  }
  return $isTextNode(node) ? [`${node.getKey()}:${node.getTextContent()}`] : [];
}

describe('$wrapNodes over a block container that mixes inline content and blocks', () => {
  for (const structure of [false, true]) {
    for (const container of CONTAINERS) {
      for (const [m, mix] of MIXES.entries()) {
        for (const span of SPANS) {
          for (const backward of [false, true]) {
            test(`${container}, mix ${m}, ${span}${backward ? ', backward' : ''}${structure ? ', NodeStructureExtension' : ''}`, () => {
              using editor = buildEditorFromExtensions({
                dependencies: structure ? [NodeStructureExtension] : [],
                name: '@wrapNodes-mixed-container-test',
                nodes: [
                  InlineShadowNode,
                  MarkNode,
                  QuoteNode,
                  TestShadowRootNode,
                ],
              });
              let scopeKey = '';
              let before: string[] = [];
              editor.update(
                () => {
                  $getRoot().clear();
                  const scope = container.startsWith('inline')
                    ? $create(InlineShadowNode)
                    : $createTestShadowRootNode();
                  for (const [i, part] of mix.entries()) {
                    if (typeof part === 'string') {
                      scope.append($createTextNode(part).setMode('token'));
                    } else {
                      const text = $createTextNode(part[0]).setMode('token');
                      scope.append(
                        $createParagraphNode().append(
                          i === 1 ? $createMarkNode(['c1']).append(text) : text,
                        ),
                      );
                    }
                  }
                  const host = $createParagraphNode().append(
                    $createTextNode('outside').setMode('token'),
                  );
                  if (container === 'block shadow root at the root') {
                    $getRoot().append(host, scope);
                  } else if (container.startsWith('inline')) {
                    host.append(scope);
                    $getRoot().append(host);
                  } else {
                    $setSlot(host, 'body', scope);
                    $getRoot().append(host);
                  }
                  scopeKey = scope.getKey();
                },
                {discrete: true},
              );
              editor.update(
                () => {
                  const scope = $getNodeByKey(scopeKey) as ElementNode;
                  before = $texts(scope);
                  const texts = scope.getAllTextNodes();
                  const middle = texts[Math.floor(texts.length / 2)];
                  const [start, end] =
                    span === 'all of it'
                      ? [texts[0], texts[texts.length - 1]]
                      : span === 'first text to the middle'
                        ? [texts[0], middle]
                        : [middle, texts[texts.length - 1]];
                  const selection = $createRangeSelection();
                  const [anchor, focus] = backward
                    ? [end, start]
                    : [start, end];
                  selection.anchor.set(
                    anchor.getKey(),
                    backward ? anchor.getTextContentSize() : 0,
                    'text',
                  );
                  selection.focus.set(
                    focus.getKey(),
                    backward ? 0 : focus.getTextContentSize(),
                    'text',
                  );
                  $setSelection(selection);
                  $wrapNodes(selection, () => $createQuoteNode());
                },
                {discrete: true},
              );
              editor.read(() => {
                const scope = $getNodeByKey(scopeKey) as ElementNode;
                expect(scope.isAttached()).toBe(true);
                expect($texts(scope)).toEqual(before);
              });
            });
          }
        }
      }
    }
  }
});

// A range with one end in a list item's text and the other an element point
// on the list itself, in either direction and at every offset: $wrapNodes
// does not throw, and every text stays, in order.
describe('$wrapNodes over a range from a list item to an element point on its list', () => {
  for (const structure of [false, true]) {
    for (const item of [0, 1, 2]) {
      for (const offset of [0, 1, 2, 3]) {
        for (const backward of [false, true]) {
          test(`item ${item}, list offset ${offset}${backward ? ', backward' : ''}${structure ? ', NodeStructureExtension' : ''}`, () => {
            using editor = buildEditorFromExtensions({
              dependencies: structure ? [NodeStructureExtension] : [],
              name: '@wrapNodes-list-point-test',
              nodes: [ListNode, ListItemNode, QuoteNode],
            });
            editor.update(
              () => {
                const list = $createListNode('bullet').append(
                  ...['aa', 'bb', 'cc'].map(text =>
                    $createListItemNode().append($createTextNode(text)),
                  ),
                );
                $getRoot()
                  .clear()
                  .append(
                    $createParagraphNode().append($createTextNode('before')),
                    list,
                  );
                const text = (
                  list.getChildAtIndex(item) as ElementNode
                ).getFirstDescendant()!;
                const selection = $createRangeSelection();
                const [textPoint, listPoint] = backward
                  ? [selection.focus, selection.anchor]
                  : [selection.anchor, selection.focus];
                textPoint.set(text.getKey(), 1, 'text');
                listPoint.set(list.getKey(), offset, 'element');
                $setSelection(selection);
                $wrapNodes(selection, () => $createQuoteNode());
              },
              {discrete: true},
            );
            expect(
              editor.read(() =>
                $getRoot()
                  .getAllTextNodes()
                  .map(node => node.getTextContent()),
              ),
            ).toEqual(['before', 'aa', 'bb', 'cc']);
          });
        }
      }
    }
  }
});

// A range that starts at the end of a block (an element point after its
// last child) selects nothing of that block: the block stays as it is and
// where it is, and the blocks after it keep their order. Input space: the
// first block is a list or a paragraph; the range ends in a later
// paragraph's text, in an empty paragraph, in an empty paragraph inside a
// shadow root, or in text inside a shadow root; forward and backward; with
// and without NodeStructureExtension.
const ENDS = [
  'text in a paragraph',
  'an empty paragraph',
  'an empty paragraph in a shadow root',
  'text in a shadow root',
] as const;

describe('$wrapNodes over a range that starts at the end of a block', () => {
  for (const structure of [false, true]) {
    for (const first of ['list', 'paragraph'] as const) {
      for (const end of ENDS) {
        for (const backward of [false, true]) {
          test(`${first}, to ${end}${backward ? ', backward' : ''}${structure ? ', NodeStructureExtension' : ''}`, () => {
            using editor = buildEditorFromExtensions({
              dependencies: structure ? [NodeStructureExtension] : [],
              name: '@wrapNodes-start-at-block-end-test',
              nodes: [ListNode, ListItemNode, QuoteNode, TestShadowRootNode],
            });
            let firstKey = '';
            let before: string[] = [];
            editor.update(
              () => {
                const block =
                  first === 'list'
                    ? $createListNode('bullet').append(
                        $createListItemNode().append($createTextNode('aa')),
                        $createListItemNode().append($createTextNode('bb')),
                      )
                    : $createParagraphNode().append($createTextNode('aa bb'));
                const empty = $createParagraphNode();
                const ee = $createTextNode('ee');
                const tail = end.endsWith('shadow root')
                  ? [
                      $createTestShadowRootNode().append(
                        empty,
                        $createParagraphNode().append(ee),
                      ),
                    ]
                  : [empty, $createParagraphNode().append(ee)];
                $getRoot()
                  .clear()
                  .append(
                    block,
                    $createParagraphNode().append($createTextNode('cc')),
                    $createParagraphNode().append($createTextNode('dd')),
                    ...tail,
                    $createParagraphNode().append($createTextNode('ff')),
                  );
                firstKey = block.getKey();
                before = $texts($getRoot());
                const selection = $createRangeSelection();
                const [atEnd, other] = backward
                  ? [selection.focus, selection.anchor]
                  : [selection.anchor, selection.focus];
                atEnd.set(block.getKey(), block.getChildrenSize(), 'element');
                if (end.startsWith('text')) {
                  other.set(ee.getKey(), 1, 'text');
                } else {
                  other.set(empty.getKey(), 0, 'element');
                }
                $setSelection(selection);
                $wrapNodes(selection, () => $createQuoteNode());
              },
              {discrete: true},
            );
            editor.read(() => {
              expect($texts($getRoot())).toEqual(before);
              const block = $getRoot().getFirstChildOrThrow();
              expect(block.getKey()).toBe(firstKey);
              expect(block.getType()).toBe(first);
            });
          });
        }
      }
    }
  }
});

// The selection after the content moved is valid: no point is past the end
// of its node (the root, whose three paragraphs went into one quote), and
// where main succeeds it is collapsed as on main, so typing next keeps the
// wrapped text.
describe('$wrapNodes leaves the selection inside the new tree', () => {
  for (const structure of [false, true]) {
    for (const backward of [false, true]) {
      test(`three root paragraphs, from the first text to the root's end${backward ? ', backward' : ''}${structure ? ', NodeStructureExtension' : ''}`, () => {
        using editor = buildEditorFromExtensions({
          dependencies: structure ? [NodeStructureExtension] : [],
          name: '@wrapNodes-selection-restore-test',
          nodes: [QuoteNode],
        });
        editor.update(
          () => {
            const paragraphs = ['aa', 'bb', 'cc'].map(text =>
              $createParagraphNode().append($createTextNode(text)),
            );
            $getRoot()
              .clear()
              .append(...paragraphs);
            const selection = $createRangeSelection();
            const [textPoint, rootPoint] = backward
              ? [selection.focus, selection.anchor]
              : [selection.anchor, selection.focus];
            textPoint.set(
              paragraphs[0].getFirstChildOrThrow().getKey(),
              0,
              'text',
            );
            rootPoint.set($getRoot().getKey(), 3, 'element');
            $setSelection(selection);
            $wrapNodes(selection, () => $createQuoteNode());
            const after = $getSelection();
            expect($isRangeSelection(after)).toBe(true);
            if ($isRangeSelection(after)) {
              for (const point of [after.anchor, after.focus]) {
                const node = point.getNode();
                expect(node.isAttached()).toBe(true);
                const size = $isElementNode(node)
                  ? node.getChildrenSize()
                  : node.getTextContentSize();
                expect(point.offset).toBeLessThanOrEqual(size);
              }
            }
          },
          {discrete: true},
        );
        expect(
          editor.read(() =>
            $getRoot()
              .getAllTextNodes()
              .map(node => node.getTextContent()),
          ),
        ).toEqual(['aa', 'bb', 'cc']);
      });
    }
  }
});

describe('$wrapNodes over the whole root, with a wrapping element', () => {
  for (const structure of [false, true]) {
    for (const backward of [false, true]) {
      test(`root element points 0 to 3${backward ? ', backward' : ''}${structure ? ', NodeStructureExtension' : ''}`, () => {
        using editor = buildEditorFromExtensions({
          dependencies: structure ? [NodeStructureExtension] : [],
          name: '@wrapNodes-root-points-test',
          nodes: [QuoteNode, TestShadowRootNode],
        });
        let selected = '';
        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                ...['aa', 'bb', 'cc'].map(text =>
                  $createParagraphNode().append($createTextNode(text)),
                ),
              );
            const root = $getRoot().getKey();
            const selection = $createRangeSelection();
            selection.anchor.set(root, backward ? 3 : 0, 'element');
            selection.focus.set(root, backward ? 0 : 3, 'element');
            $setSelection(selection);
            $wrapNodes(
              selection,
              () => $createQuoteNode(),
              $createTestShadowRootNode(),
            );
            const after = $getSelection();
            if ($isRangeSelection(after)) {
              const {anchor, focus} = after;
              const inRange = [anchor, focus].every(point => {
                const node = point.getNode();
                return (
                  node.isAttached() &&
                  point.offset <=
                    ($isElementNode(node)
                      ? node.getChildrenSize()
                      : node.getTextContentSize())
                );
              });
              selected = `${after.isCollapsed() ? 'collapsed' : 'range'} ${inRange ? 'in range' : 'out of range'}`;
              after.insertText('Z');
            }
          },
          {discrete: true},
        );
        // As on main: a collapsed selection, so typing keeps the wrapped text.
        expect(selected).toBe('collapsed in range');
        // The typed text goes next to the wrapped text, not over it.
        const texts = editor.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(node => node.getTextContent()),
        );
        expect(texts.filter(text => text !== 'Z')).toEqual(['aa', 'bb', 'cc']);
        expect(texts).toContain('Z');
      });
    }
  }
});
