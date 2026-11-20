/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// data-block-wrapper-id (#9606) on import, where rules other than the list
// importer grow lists or fill items after the nested list was produced:
// linear work, and the id still goes on the item that ends up holding the
// nested list alone.
import {
  $getBlockId,
  $getExtensionOutput,
  BlockIdExtension,
  buildEditorFromExtensions,
} from '@lexical/extension';
import {defineImportRule, DOMImportExtension, sel} from '@lexical/html';
import {BlockIdHTMLExtension} from '@lexical/html/BlockIdHTMLExtension';
import {
  $createListItemNode,
  $createListNode,
  $isListNode,
  ListExtension,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  configExtension,
  ElementNode,
  type LexicalNode,
} from 'lexical';
import {expect, test, vi} from 'vitest';

const growRule = defineImportRule({
  $import: (ctx, el) => {
    const nodes = ctx.$importChildren(el);
    for (const node of nodes)
      if ($isListNode(node)) {
        // Appending at the tail is an insertion-only splice: no scan of old
        // children is needed to construct each new child.
        node.append($createListItemNode().append($createTextNode('x')));
      }
    return nodes;
  },
  match: sel.tag('x-grow'),
  name: 'test/grow',
});

test('a list that grows by one item per element around it is resolved in linear work', () => {
  const counts: number[] = [];
  for (const n of [32, 64, 128]) {
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        ListExtension,
        BlockIdExtension,
        BlockIdHTMLExtension,
        configExtension(DOMImportExtension, {rules: [growRule]}),
      ],
      name: 'test-changing-count',
      onError: e => {
        throw e;
      },
    });
    const dom = new DOMParser().parseFromString(
      '<x-grow>'.repeat(n) +
        '<ul data-block-wrapper-id="foreign"><li>x</li></ul>' +
        '</x-grow>'.repeat(n),
      'text/html',
    );
    let count = 0;
    editor.update(
      () => {
        const original = ElementNode.prototype.getChildrenSize;
        const spy = vi
          .spyOn(ElementNode.prototype, 'getChildrenSize')
          .mockImplementation(function (this: LexicalNode) {
            count++;
            return original.call(this);
          });
        try {
          const nodes =
            $getExtensionOutput(DOMImportExtension).$generateNodesFromDOM(dom);
          expect(nodes).toHaveLength(1);
          expect((nodes[0] as ElementNode).getChildren()).toHaveLength(n + 1);
          expect(nodes[0].getTextContent().replace(/\s/g, '')).toBe(
            'x'.repeat(n + 1),
          );
        } finally {
          spy.mockRestore();
        }
      },
      {discrete: true},
    );
    counts.push(count);
  }
  expect(counts[1]).toBeLessThan(counts[0] * 3);
  expect(counts[2]).toBeLessThan(counts[1] * 3);
});

function buildPopulate(mode: 'parent-growth' | 'holder-growth') {
  let inner: ListNode;
  let parent: ListNode;
  let holder: ListItemNode;
  let i = 0;
  const buildRule = defineImportRule({
    $import: (ctx, el) => {
      inner = ctx.$importChildren(el)[0] as ListNode;
      parent = $createListNode('bullet');
      holder = $createListItemNode();
      if (mode === 'holder-growth') parent.append(holder);
      if (el.hasAttribute('data-early')) {
        holder.append(inner);
        if (mode === 'parent-growth') parent.append(holder);
      }
      return [parent];
    },
    match: sel.tag('x-build'),
    name: 'test/build-empty',
  });
  const populateRule = defineImportRule({
    $import: (ctx, el) => {
      const nodes = ctx.$importChildren(el);
      if (holder.getChildrenSize() === 0) {
        holder.append(inner);
        if (mode === 'parent-growth') parent.append(holder);
      }
      return nodes;
    },
    match: sel.tag('x-populate'),
    name: 'test/populate',
  });
  return buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      RichTextExtension,
      ListExtension,
      configExtension(BlockIdExtension, {generateId: () => `fresh${++i}`}),
      BlockIdHTMLExtension,
      configExtension(DOMImportExtension, {rules: [buildRule, populateRule]}),
    ],
    name: 'test-late-populate',
    onError: e => {
      throw e;
    },
  });
}
function populateResult(
  mode: 'parent-growth' | 'holder-growth',
  early: boolean,
) {
  using editor = buildPopulate(mode);
  const dom = new DOMParser().parseFromString(
    '<x-populate><x-build' +
      (early ? ' data-early' : '') +
      '><ul data-block-wrapper-id="W"><li data-block-id="N">inner</li></ul></x-build></x-populate>',
    'text/html',
  );
  editor.update(
    () => {
      $getRoot().append(
        ...$getExtensionOutput(DOMImportExtension).$generateNodesFromDOM(dom),
      );
    },
    {discrete: true},
  );
  return editor.read(() => {
    const out: {type: string; text: string; id: string | null}[] = [];
    function walk(node: LexicalNode) {
      if ($isElementNode(node)) {
        const id = $getBlockId(node);
        out.push({
          id: id?.startsWith('fresh') ? '<fresh>' : id,
          text: node.getTextContent(),
          type: node.getType(),
        });
        node.getChildren().forEach(walk);
      }
    }
    walk($getRoot());
    return out;
  });
}
for (const mode of ['parent-growth', 'holder-growth'] as const) {
  test(`late population resolves ids exactly like early population (${mode})`, () => {
    const early = populateResult(mode, true);
    const late = populateResult(mode, false);
    expect(late).toEqual(early);
  });
}
