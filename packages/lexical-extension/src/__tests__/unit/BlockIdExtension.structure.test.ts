/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $getBlockById,
  $getBlockId,
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  type LexicalEditorWithDispose,
  NodeStructureExtension,
} from '@lexical/extension';
import {$createLinkNode, LinkExtension} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
} from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  $setState,
  configExtension,
  type ElementNode,
  HISTORY_MERGE_TAG,
  type LexicalNode,
  type SerializedLexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// Block ids in an editor that also enforces declared node structure, whose
// normalization splits, joins, lifts and merges blocks in the same update as
// the change that needs it.

// The order the extensions are listed in, or the structure enabled after the
// editor is built, which registers its normalization after block ids, or no
// structure at all.
type Order =
  | 'block ids first'
  | 'structure first'
  | 'structure enabled later'
  | 'no structure';

function build(
  order: Order = 'block ids first',
  hadContent = true,
): LexicalEditorWithDispose {
  let n = 0;
  const blockIds = configExtension(BlockIdExtension, {
    generateId: () => `g${++n}`,
  });
  const editor = buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      RichTextExtension,
      ListExtension,
      LinkExtension,
      ...(order === 'no structure'
        ? [blockIds]
        : order === 'block ids first'
          ? [blockIds, NodeStructureExtension]
          : order === 'structure first'
            ? [NodeStructureExtension, blockIds]
            : [
                blockIds,
                configExtension(NodeStructureExtension, {disabled: true}),
              ]),
    ],
    name: '[block-id-structure-test]',
  });
  if (order === 'structure enabled later') {
    getExtensionDependencyFromEditor(
      editor,
      NodeStructureExtension,
    ).output.disabled.value = false;
  }
  if (hadContent) {
    // Have had content once, so that new blocks are edits, not a load.
    const options = {discrete: true, tag: HISTORY_MERGE_TAG} as const;
    editor.update(() => $getRoot().append($createParagraphNode()), options);
    editor.update(() => $getRoot().clear(), options);
  }
  return editor;
}

function update(editor: LexicalEditorWithDispose, fn: () => void): void {
  editor.update(fn, {discrete: true});
}

/** `type#id[children]`, with text in quotes and links as `link[...]`. */
function $show(node: LexicalNode): string {
  if ($isTextNode(node)) {
    return JSON.stringify(node.getTextContent());
  }
  if ($isLineBreakNode(node) || !$isElementNode(node)) {
    return node.getType();
  }
  const id = $getBlockId(node);
  const children = node.getChildren().map($show).join(' ');
  return `${node.getType()}${id === null ? '' : `#${id}`}[${children}]`;
}

function shape(editor: LexicalEditorWithDispose): string[] {
  return editor.read(() => $getRoot().getChildren().map($show));
}

/** Every id is unique and the index finds the block that holds it. */
function expectIndexed(editor: LexicalEditorWithDispose): void {
  editor.read(() => {
    const seen = new Set<string>();
    const walk = (node: LexicalNode) => {
      const id = $getBlockId(node);
      if (id !== null) {
        expect(seen.has(id), id).toBe(false);
        seen.add(id);
        expect($getBlockById(id)?.getKey(), id).toBe(node.getKey());
      }
      if ($isElementNode(node)) {
        node.getChildren().forEach(walk);
      }
    };
    walk($getRoot());
  });
}

function $withId<T extends LexicalNode>(node: T, id: string): T {
  $setState(node, blockIdState, id);
  return node;
}

const $t = (text: string) => $createTextNode(text);
const $p = (...children: LexicalNode[]) =>
  $createParagraphNode().append(...children);
const $li = (...children: LexicalNode[]) =>
  $createListItemNode().append(...children);
const $ul = (...children: LexicalNode[]) =>
  $createListNode('bullet').append(...children);
const $block = (id: string) => $getBlockById(id) as ElementNode;

interface Case {
  name: string;
  setup: () => void;
  change: () => void;
  expected: string[];
}

const CASES: Case[] = [
  {
    change: () =>
      $block('A').append(
        $withId($createQuoteNode().append($t('q')), 'Q'),
        $t('b'),
      ),
    expected: ['paragraph#A["a"]', 'quote#Q["q"]', 'paragraph#g1["b"]'],
    name: 'a paragraph split around a block lifted out of it: the first piece keeps the id',
    setup: () => $getRoot().append($withId($p($t('a')), 'A')),
  },
  {
    change: () => $block('H').append($ul($withId($li($t('x')), 'L')), $t('b')),
    expected: ['heading#H["a"]', 'list#g1[listitem#L["x"]]', 'heading#g2["b"]'],
    name: 'a heading split around a list: the list and the second piece get new ids',
    setup: () =>
      $getRoot().append($withId($createHeadingNode('h1').append($t('a')), 'H')),
  },
  {
    change: () => {
      const paragraph = $block('A');
      paragraph.clear();
      paragraph.append($createQuoteNode().append($t('q')));
    },
    expected: ['quote#A["q"]'],
    name: 'a block lifted out of a paragraph it emptied takes its place and its id',
    setup: () => $getRoot().append($withId($p($t('x')), 'A')),
  },
  {
    change: () => {
      const paragraph = $block('A');
      paragraph.clear();
      paragraph.append(
        $createLinkNode('https://lexical.dev').append(
          $ul($withId($li($t('x')), 'L1'), $withId($li($t('y')), 'L2')),
        ),
      );
    },
    expected: ['list#A[listitem#L1[link["x"]] listitem#L2[link["y"]]]'],
    name: 'a list lifted out of a link: the items keep their ids and the link',
    setup: () => $getRoot().append($withId($p($t('z')), 'A')),
  },
  {
    change: () =>
      $block('H').append(
        $withId($p($t('a')), 'PA'),
        $withId($p($t('b')), 'PB'),
      ),
    expected: ['heading#H["h" linebreak "a" linebreak "b"]'],
    name: 'paragraphs joined as lines: the block that absorbs them keeps its id',
    setup: () =>
      $getRoot().append($withId($createHeadingNode('h1').append($t('h')), 'H')),
  },
  {
    change: () => $block('SEP').remove(),
    expected: ['list#U1[listitem#LA["a"] listitem#LB["b"]]'],
    name: 'equal adjacent lists merge: the first keeps its id',
    setup: () =>
      $getRoot().append(
        $withId($ul($withId($li($t('a')), 'LA')), 'U1'),
        $withId($p($t('sep')), 'SEP'),
        $withId($ul($withId($li($t('b')), 'LB')), 'U2'),
      ),
  },
  {
    change: () => $block('SEP').remove(),
    expected: ['list#U1[listitem#W1[list[listitem#NA["a"] listitem#NB["b"]]]]'],
    name: 'nested lists joined at a seam: the first item keeps its id',
    setup: () =>
      $getRoot().append(
        $withId(
          $ul($withId($li($ul($withId($li($t('a')), 'NA'))), 'W1')),
          'U1',
        ),
        $withId($p($t('sep')), 'SEP'),
        $withId(
          $ul($withId($li($ul($withId($li($t('b')), 'NB'))), 'W2')),
          'U2',
        ),
      ),
  },
  {
    change: () => $block('U1').insertBefore($ul($li($t('new')))),
    expected: [
      'paragraph#Z["z"]',
      'list#U1[listitem#g1["new"] listitem#LA["a"]]',
    ],
    name: 'a new list without an id merged with the list after it continues that list',
    setup: () =>
      $getRoot().append(
        $withId($p($t('z')), 'Z'),
        $withId($ul($withId($li($t('a')), 'LA')), 'U1'),
      ),
  },
  {
    change: () =>
      $block('U1').insertBefore($withId($ul($li($t('new'))), 'NEW')),
    expected: [
      'paragraph#Z["z"]',
      'list#NEW[listitem#g1["new"] listitem#LA["a"]]',
    ],
    name: 'a new list with an id merged with the list after it keeps its own id',
    setup: () =>
      $getRoot().append(
        $withId($p($t('z')), 'Z'),
        $withId($ul($withId($li($t('a')), 'LA')), 'U1'),
      ),
  },
  {
    change: () =>
      // A copy of list L, with L's ids, pasted right above the equal list M.
      $block('M').insertBefore($withId($ul($withId($li($t('l')), 'LL')), 'L')),
    expected: [
      'list#L[listitem#LL["l"]]',
      'paragraph#SEP["sep"]',
      'list#M[listitem#g1["l"] listitem#MM["m"]]',
    ],
    name: 'a copy of a list merged with the equal list after it continues that list',
    setup: () =>
      $getRoot().append(
        $withId($ul($withId($li($t('l')), 'LL')), 'L'),
        $withId($p($t('sep')), 'SEP'),
        $withId($ul($withId($li($t('m')), 'MM')), 'M'),
      ),
  },
];

describe('BlockIdExtension with NodeStructureExtension', () => {
  for (const order of [
    'block ids first',
    'structure first',
    'structure enabled later',
  ] as const) {
    describe(order, () => {
      test.each(CASES)('$name', ({setup, change, expected}) => {
        using editor = build(order);
        update(editor, setup);
        update(editor, change);
        expect(shape(editor)).toEqual(expected);
        expectIndexed(editor);
      });
      test('copies of a list, one apart and one on each side of it: the merged list keeps its id', () => {
        using editor = build(order);
        update(editor, () =>
          $getRoot().append(
            $withId($p($t('z')), 'Z'),
            $withId($createHeadingNode('h1').append($t('h')), 'H'),
            $withId($ul($withId($li($t('a')), 'A')), 'U'),
          ),
        );
        update(editor, () => {
          // Copies of list U, with U's ids.
          const $copy = () => $withId($ul($withId($li($t('a')), 'A')), 'U');
          $block('Z').insertAfter($copy());
          $block('H').insertAfter($copy());
          $block('U').insertAfter($copy());
        });
        // Generated ids (`g<n>`) depend on how many were discarded.
        expect(
          shape(editor).map(block => block.replace(/#g\d+/g, '#g')),
        ).toEqual([
          'paragraph#Z["z"]',
          'list#g[listitem#g["a"]]',
          'heading#H["h"]',
          'list#U[listitem#g["a"] listitem#A["a"] listitem#g["a"]]',
        ]);
        expectIndexed(editor);
      });
    });
  }
});

/** A document as an editor without either extension stores it, unrepaired. */
function storedJSON($build: () => void): string {
  using writer = buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [RichTextExtension, ListExtension, LinkExtension],
    name: '[block-id-structure-test-writer]',
  });
  writer.update($build, {discrete: true, skipTransforms: true});
  return JSON.stringify(writer.getEditorState().toJSON());
}

/** The blocks a load of `json` gives, all with positional ids. */
function loadedIds(order: Order, json: string): string[] {
  using editor = build(order, false);
  editor.setEditorState(editor.parseEditorState(json));
  expectIndexed(editor);
  const blocks = shape(editor);
  // No generated (`g<n>`) or missing ids.
  expect(blocks.join(' ')).not.toMatch(
    /#g\d|(paragraph|quote|list|listitem)\[/,
  );
  return blocks;
}

/**
 * The ids an editor without NodeStructureExtension derives for the document
 * that `order` loads `json` into, stored again without ids: the positional
 * ids of the loaded document.
 */
function idsOfLoadedDocument(order: Order, json: string): string[] {
  using editor = build(order, false);
  editor.setEditorState(editor.parseEditorState(json));
  const loaded = editor.getEditorState().toJSON();
  const strip = (node: SerializedLexicalNode & {children?: unknown[]}) => {
    if (node.$ !== undefined) {
      delete node.$.blockId;
    }
    for (const child of node.children ?? []) {
      strip(child as SerializedLexicalNode);
    }
  };
  strip(loaded.root);
  return loadedIds('no structure', JSON.stringify(loaded));
}

describe('BlockIdExtension with NodeStructureExtension: loads', () => {
  const lists = storedJSON(() =>
    $getRoot().append($p($t('z')), $ul($li($t('x'))), $ul($li($t('y')))),
  );
  const quote = storedJSON(() =>
    $getRoot().append(
      $p($t('a'), $createQuoteNode().append($t('q')), $t('b')),
      $p($t('c')),
    ),
  );
  for (const order of ['block ids first', 'structure first'] as const) {
    test(`${order}: equal adjacent lists get the ids of the merged document, as without the structure`, () => {
      const ids = loadedIds(order, lists);
      expect(ids).toEqual(idsOfLoadedDocument(order, lists));
      expect(ids).toEqual(loadedIds('no structure', lists));
      expect(ids.map(block => block.replace(/#[\w-]+/g, ''))).toEqual([
        'paragraph["z"]',
        'list[listitem["x"] listitem["y"]]',
      ]);
    });
    test(`${order}: a split document gets the ids of the document the load ends with`, () => {
      const ids = loadedIds(order, quote);
      expect(ids).toEqual(idsOfLoadedDocument(order, quote));
      expect(ids.map(block => block.replace(/#[\w-]+/g, ''))).toEqual([
        'paragraph["a"]',
        'quote["q"]',
        'paragraph["b"]',
        'paragraph["c"]',
      ]);
    });
  }
  test('both orders derive the same ids', () => {
    expect(loadedIds('block ids first', quote)).toEqual(
      loadedIds('structure first', quote),
    );
    expect(loadedIds('block ids first', lists)).toEqual(
      loadedIds('structure first', lists),
    );
  });
});
