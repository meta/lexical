/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  $getBlockId,
  $getExtensionOutput,
  BlockIdExtension,
  buildEditorFromExtensions,
} from '@lexical/extension';
import {defineImportRule, DOMImportExtension, sel} from '@lexical/html';
import {BlockIdHTMLExtension} from '@lexical/html/BlockIdHTMLExtension';
import {ListExtension} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $getRoot,
  $isElementNode,
  configExtension,
  ElementNode,
  type LexicalNode,
} from 'lexical';
import {expect, test, vi} from 'vitest';

// data-block-wrapper-id (#9606) on import: the waiting ids are looked up
// from the nodes each element produced, so ids that go on no block cost
// nothing more per element; and they belong to their import session, so an
// import a rule runs inside another does not lose the outer one's.

const reenter = defineImportRule({
  $import: (_ctx, el) => {
    if (el.hasAttribute('data-reenter')) {
      $getExtensionOutput(DOMImportExtension).$generateNodesFromDOM(
        new DOMParser().parseFromString('<p>scratch</p>', 'text/html'),
      );
    }
    return [];
  },
  match: sel.tag('aside'),
  name: 'test/reenter',
});
function build() {
  let n = 0;
  const editor = buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      RichTextExtension,
      ListExtension,
      configExtension(BlockIdExtension, {generateId: () => `fresh${++n}`}),
      BlockIdHTMLExtension,
      configExtension(DOMImportExtension, {rules: [reenter]}),
    ],
    name: 'block-wrapper-id-import',
    onError: e => {
      throw e;
    },
  });
  editor.update(
    () => {
      $getRoot().append($createParagraphNode());
    },
    {discrete: true},
  );
  editor.update(
    () => {
      $getRoot().clear();
    },
    {discrete: true},
  );
  return editor;
}
function append(editor: ReturnType<typeof build>, html: string) {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  editor.update(
    () => {
      $getRoot().append(
        ...$getExtensionOutput(DOMImportExtension).$generateNodesFromDOM(dom),
      );
    },
    {discrete: true},
  );
}
function blocks(editor: ReturnType<typeof build>) {
  return editor.read(() => {
    const out: {type: string; text: string; id: string | null}[] = [];
    function walk(node: LexicalNode) {
      if ($isElementNode(node)) {
        if (node.getType() !== 'root') {
          out.push({
            id: $getBlockId(node),
            text: node.getTextContent(),
            type: node.getType(),
          });
        }
        node.getChildren().forEach(walk);
      }
    }
    walk($getRoot());
    return out;
  });
}

test('wrapper ids that go on no block do not make import quadratic', () => {
  const costs: number[] = [];
  for (const n of [64, 128, 256]) {
    using editor = build();
    const dom = new DOMParser().parseFromString(
      Array.from(
        {length: n},
        (_, i) => `<ul data-block-wrapper-id="foreign${i}"><li>x</li></ul>`,
      ).join(''),
      'text/html',
    );
    let cost = 0;
    editor.update(
      () => {
        const original = ElementNode.prototype.getParent;
        const spy = vi
          .spyOn(ElementNode.prototype, 'getParent')
          .mockImplementation(function (this: LexicalNode) {
            cost++;
            return original.call(this);
          });
        try {
          const nodes =
            $getExtensionOutput(DOMImportExtension).$generateNodesFromDOM(dom);
          expect(nodes).toHaveLength(n);
        } finally {
          spy.mockRestore();
        }
      },
      {discrete: true},
    );
    costs.push(cost);
  }
  // Counting operations, not timing: a doubled linear input costs ~2x,
  // whereas scanning every outstanding wrapper after every element costs ~4x.
  expect(costs[1]).toBeLessThan(costs[0] * 3);
  expect(costs[2]).toBeLessThan(costs[1] * 3);
});

test("an import run inside another keeps the outer import's waiting wrapper id", () => {
  using plain = build();
  using nested = build();
  const fixture = (inner: string) =>
    '<ul data-block-id="L"><li data-block-id="I">text' +
    '<ul data-block-wrapper-id="W"><li data-block-id="N">inner</li></ul>' +
    inner +
    '</li></ul>';
  append(plain, fixture('<aside></aside>'));
  append(nested, fixture('<aside data-reenter></aside>'));
  const a = blocks(plain).map(({type, text, id}) => ({
    id: id?.startsWith('fresh') ? '<fresh>' : id,
    text,
    type,
  }));
  const b = blocks(nested).map(({type, text, id}) => ({
    id: id?.startsWith('fresh') ? '<fresh>' : id,
    text,
    type,
  }));
  expect(b).toEqual(a);
});

test('HTML without wrapper ids reads the same with an import run inside it', () => {
  using plain = build();
  using nested = build();
  const fixture = (inner: string) =>
    '<ul data-block-id="L"><li data-block-id="I">text<ul><li data-block-id="N">inner</li></ul>' +
    inner +
    '</li></ul>';
  append(plain, fixture('<aside></aside>'));
  append(nested, fixture('<aside data-reenter></aside>'));
  expect(blocks(nested)).toEqual(blocks(plain));
});

test('an unknown element that hoists the same list again does not make import look at it again', () => {
  const counts: number[] = [];
  for (const n of [32, 64, 128]) {
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        ListExtension,
        BlockIdExtension,
        BlockIdHTMLExtension,
      ],
      name: 'block-wrapper-id-hoist',
      onError: e => {
        throw e;
      },
    });
    // Each unrecognized wrapper hoists the same ListNode, whose n child
    // items have already been constructed. The valid top-level wrapper
    // id remains unresolved, because no wrapping block is created.
    const dom = new DOMParser().parseFromString(
      '<x-transparent>'.repeat(n) +
        '<ul data-block-wrapper-id="foreign">' +
        '<li>x</li>'.repeat(n) +
        '</ul>' +
        '</x-transparent>'.repeat(n),
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
          expect(nodes[0].getTextContent().replace(/\s/g, '')).toBe(
            'x'.repeat(n),
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

test('wrapper ids inside many unknown elements are looked at a bounded number of times each', () => {
  const counts: number[] = [];
  for (const n of [32, 64, 128]) {
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        ListExtension,
        BlockIdExtension,
        BlockIdHTMLExtension,
      ],
      name: 'block-wrapper-id-deep',
      onError: e => {
        throw e;
      },
    });
    const dom = new DOMParser().parseFromString(
      '<x-transparent>'.repeat(n) +
        Array.from(
          {length: n},
          (_, i) => `<ul data-block-wrapper-id="w${i}"><li>x</li></ul>`,
        ).join('') +
        '</x-transparent>'.repeat(n),
      'text/html',
    );
    let count = 0;
    editor.update(
      () => {
        const original = ElementNode.prototype.getParent;
        const spy = vi
          .spyOn(ElementNode.prototype, 'getParent')
          .mockImplementation(function (this: LexicalNode) {
            count++;
            return original.call(this);
          });
        try {
          $getExtensionOutput(DOMImportExtension).$generateNodesFromDOM(dom);
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
