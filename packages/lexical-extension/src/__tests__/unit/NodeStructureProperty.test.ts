/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$createCodeNode, CodeNode} from '@lexical/code-core';
import {
  $createHorizontalRuleNode,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  HorizontalRuleExtension,
  NodeStructureExtension,
  NormalizeInlineElementsExtension,
} from '@lexical/extension';
import {
  $createAutoLinkNode,
  $createLinkNode,
  AutoLinkNode,
  LinkExtension,
  LinkNode,
} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
  ListItemNode,
  type ListType,
} from '@lexical/list';
import {$createMarkNode, MarkNode} from '@lexical/mark';
import {$createOverflowNode, OverflowNode} from '@lexical/overflow';
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $isTableNode,
  TableExtension,
} from '@lexical/table';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $isTextNode,
  $parseSerializedNode,
  $setSelection,
  type AnyLexicalExtensionArgument,
  configExtension,
  ElementNode,
  getDeclaredNodeStructure,
  INTERNAL_$normalizeNodeStructure,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  type NodeChildrenConfig,
  type SerializedLexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

/**
 * Property test of NodeStructureExtension over random documents that break
 * every declared rule, nested: blocks in paragraphs, headings, quotes, code,
 * list items and links; paragraphs in quotes, list items and lists; inline
 * content and stray blocks in lists; equal adjacent lists and links; block
 * decorators anywhere in ordered list items; tables, shadow root quotes and
 * the character limit's OverflowNode; empty links, marks and OverflowNodes,
 * which Lexical removes; links, autolinks and marks around blocks; equal
 * adjacent lists whose items at the seam hold a nested list, alone or with
 * other content.
 *
 * `NODE_STRUCTURE_SEEDS` runs more seeds than the default (200), from
 * `NODE_STRUCTURE_FIRST_SEED` (1); run more than 500 in parts.
 */
const SEEDS = Number(process.env.NODE_STRUCTURE_SEEDS || 200);
const FIRST_SEED = Number(process.env.NODE_STRUCTURE_FIRST_SEED || 1);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Editors built for the current seed, disposed after it. */
const built: {dispose: () => void}[] = [];

function disposeBuilt(): void {
  for (const editor of built.splice(0)) {
    editor.dispose();
  }
}

function build(
  structure: 'on' | 'off' | 'disabled',
  extra: AnyLexicalExtensionArgument[] = [],
): LexicalEditor {
  const deps: AnyLexicalExtensionArgument[] = [
    RichTextExtension,
    ListExtension,
    LinkExtension,
    configExtension(TableExtension, {hasHorizontalScroll: false}),
    HorizontalRuleExtension,
    ...extra,
  ];
  if (structure !== 'off') {
    deps.push(
      configExtension(NodeStructureExtension, {
        disabled: structure === 'disabled',
      }),
    );
  }
  const editor = buildEditorFromExtensions({
    dependencies: deps,
    name: 'node-structure-property',
    nodes: [AutoLinkNode, CodeNode, MarkNode, OverflowNode],
    onError: e => {
      throw e;
    },
  });
  built.push(editor);
  return editor;
}

let token = 0;

/** ElementNode's own splice, so that a list can hold what it may not. */
function $put(parent: ElementNode, children: LexicalNode[]): ElementNode {
  ElementNode.prototype.splice.call(
    parent,
    parent.getChildrenSize(),
    0,
    children,
  );
  return parent;
}

/**
 * A random broken subtree. `extended` adds what an editor without the
 * extension throws on or loses content in often enough that its own results
 * cannot serve as a reference: autolinks around blocks, and equal adjacent
 * lists that merge (see `$seamLists`).
 */
function $gen(r: () => number, depth: number, extended = false): LexicalNode {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(r() * items.length)];
  const leaf = (): LexicalNode => {
    const x = r();
    return x < 0.6
      ? $createTextNode(`[${token++}]`)
      : x < 0.75
        ? $createLineBreakNode()
        : $createHorizontalRuleNode();
  };
  if (depth <= 0) {
    return leaf();
  }
  const kids = (n = Math.floor(r() * 4)) =>
    Array.from({length: n}, () => $gen(r, depth - 1, extended));
  switch (Math.floor(r() * (extended ? 19 : 18))) {
    case 0:
    case 1:
      return leaf();
    case 2:
    case 3:
      return $put($createParagraphNode(), kids());
    case 4:
      return $put($createHeadingNode(pick(['h1', 'h2'] as const)), kids());
    case 5:
      return $put($createQuoteNode(), kids());
    case 6:
      return $put($createCodeNode(), kids());
    case 7:
    case 8: {
      const list = $createListNode(
        pick(['number', 'number', 'bullet', 'check'] as ListType[]),
        1 + Math.floor(r() * 5),
      );
      const n = 1 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        $put(list, [
          r() < 0.85
            ? $put($createListItemNode(), kids())
            : $gen(r, depth - 1, extended),
        ]);
      }
      return list;
    }
    case 9:
    case 10:
      return $put($createLinkNode(pick(['https://a', 'https://b'])), kids());
    case 11:
      return $put(
        $createAutoLinkNode('https://a'),
        extended ? kids() : kids(1),
      );
    case 12:
      return $put($createMarkNode([pick(['m1', 'm2'])]), kids());
    case 13:
      return $createTableNode().append(
        $createTableRowNode().append(
          $put($createTableCellNode(), [$put($createParagraphNode(), kids())]),
          $put($createTableCellNode(), kids()),
        ),
      );
    case 14:
      return $put($createOverflowNode(), kids());
    case 15:
      return $put($createQuoteNode({shadowRoot: true} as never), kids());
    case 16:
      // A list item outside a list.
      return $put($createListItemNode(), kids());
    case 17:
      if (!extended) {
        return $createParagraphNode();
      }
      // Equal adjacent lists, in a block that does not hold them (they are
      // lifted out next to each other) or in an inline element.
      return $put(
        pick([
          () => $createParagraphNode(),
          () => $createQuoteNode(),
          () => $createListItemNode(),
          () => $createLinkNode('https://a'),
          () => $createMarkNode(['m1']),
        ])(),
        $seamLists(r, depth - 1),
      );
    default:
      return $createParagraphNode();
  }
}

/**
 * Two equal adjacent lists (which merge) whose items at the seam each hold a
 * nested list, alone (they are joined) or with other content before or after
 * it (nothing of which may be lost or moved).
 */
function $seamLists(r: () => number, depth: number): LexicalNode[] {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(r() * items.length)];
  const type = pick(['number', 'bullet'] as ListType[]);
  const nestedType = pick(['number', 'bullet'] as ListType[]);
  const item = () =>
    $put(
      $createListItemNode(),
      Array.from({length: Math.floor(r() * 3)}, () => $gen(r, depth - 1, true)),
    );
  const seamItem = () => {
    const nested = $put($createListNode(nestedType), [item()]);
    if (r() < 0.5) {
      return $put($createListItemNode(), [nested]);
    }
    const other =
      r() < 0.7 ? $createTextNode(`[${token++}]`) : $gen(r, depth - 1, true);
    return $put(
      $createListItemNode(),
      r() < 0.5 ? [nested, other] : [other, nested],
    );
  };
  const first = $put($createListNode(type), [
    ...(r() < 0.5 ? [item()] : []),
    seamItem(),
  ]);
  const second = $put($createListNode(type), [
    seamItem(),
    ...(r() < 0.5 ? [item()] : []),
  ]);
  return [first, second];
}

/**
 * A random broken document: `plain` as an editor without the extension
 * leaves it (its own transforms ran), `input` the same with empty inline
 * elements put in as they are.
 */
function makeInput(seed: number): {
  generated: SerializedLexicalNode[];
  input: SerializedLexicalNode[] | null;
  plain: SerializedLexicalNode[] | null;
} {
  const generated = generateDocument(seed);
  const editor = build('off');
  const r = rng(seed);
  token = 0;
  try {
    editor.update(
      () => {
        const n = 1 + Math.floor(r() * 4);
        for (let i = 0; i < n; i++) {
          let node = $gen(r, 4);
          while (
            $isTextNode(node) ||
            $isLineBreakNode(node) ||
            ($isElementNode(node) && node.isInline())
          ) {
            node = $gen(r, 4);
          }
          $getRoot().append(node);
        }
      },
      {discrete: true},
    );
  } catch (_e) {
    return {generated, input: null, plain: null};
  }
  const plain = editor.getEditorState().toJSON().root
    .children as SerializedLexicalNode[];
  return {generated, input: injectEmptyInlines(plain, seed), plain};
}

/**
 * A random broken document from the extended generator, as it is built
 * (before any transform runs), with equal adjacent lists at the root too.
 */
function generateDocument(seed: number): SerializedLexicalNode[] {
  const r = rng(seed * 2741 + 1);
  token = 0;
  let out: SerializedLexicalNode[] = [];
  build('off').update(
    () => {
      const n = 1 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) {
        if (r() < 0.15) {
          $put($getRoot(), $seamLists(r, 3));
          continue;
        }
        // Not a list item either: one at the root cannot be serialized.
        let node = $gen(r, 4, true);
        while (
          $isTextNode(node) ||
          $isLineBreakNode(node) ||
          node instanceof ListItemNode ||
          ($isElementNode(node) && node.isInline())
        ) {
          node = $gen(r, 4, true);
        }
        $getRoot().append(node);
      }
      out = $getRoot().getChildren().map($toJSON);
    },
    {discrete: true, skipTransforms: true},
  );
  return out;
}

/**
 * An empty inline element that Lexical removes (directly, or once what it
 * holds is removed). Half the time it is the only content of a run next to a
 * block its holder is split around, where whether it is still there decides
 * whether that run's part stays.
 */
function $emptyInline(r: () => number, holder: boolean): LexicalNode {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(r() * items.length)];
  const empty = (): ElementNode =>
    pick([
      () => $createLinkNode(pick(['https://a', 'https://b'])),
      () => $createMarkNode([pick(['m1', 'm2'])]),
      () => $createOverflowNode(),
    ])();
  const outer = empty();
  const nested = r() < 0.5 ? outer : $put(outer, [empty()]);
  if (!holder) {
    return nested;
  }
  const parts: LexicalNode[] = [
    nested,
    r() < 0.5
      ? $createHorizontalRuleNode()
      : $put($createHeadingNode('h1'), [$createTextNode(`[${token++}]`)]),
  ];
  if (r() < 0.5) {
    parts.reverse();
  }
  if (r() < 0.5) {
    parts.push($createTextNode(`[${token++}]`));
  }
  return pick([
    () => $put($createQuoteNode(), parts),
    () => $put($createParagraphNode(), parts),
    () => $put($createListNode('number'), [$put($createListItemNode(), parts)]),
  ])();
}

/**
 * `input` with empty inline elements put in at random places, as they are:
 * the transforms of the editor that generated it would have removed them.
 */
function injectEmptyInlines(
  input: SerializedLexicalNode[],
  seed: number,
): SerializedLexicalNode[] {
  const r = rng(seed * 389);
  type Tree = SerializedLexicalNode & {children?: Tree[]};
  const out = JSON.parse(JSON.stringify(input)) as Tree[];
  build('off').update(
    () => {
      const insert = (children: Tree[], holder: boolean) =>
        children.splice(
          Math.floor(r() * (children.length + 1)),
          0,
          $toJSON($emptyInline(r, holder)) as Tree,
        );
      const walk = (tree: Tree) => {
        if (
          !Array.isArray(tree.children) ||
          tree.type === 'table' ||
          tree.type === 'tablerow'
        ) {
          return;
        }
        tree.children.forEach(walk);
        if (r() < 0.12) {
          insert(tree.children, r() < 0.5);
        }
      };
      out.forEach(walk);
      if (r() < 0.3) {
        insert(out, true);
      }
    },
    {discrete: true, skipTransforms: true},
  );
  return out;
}

function load(editor: LexicalEditor, input: SerializedLexicalNode[]): void {
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append(...input.map(json => $parseSerializedNode(json)));
    },
    {discrete: true},
  );
}

function $allNodes(): LexicalNode[] {
  const out: LexicalNode[] = [];
  const walk = (node: LexicalNode) => {
    out.push(node);
    if ($isElementNode(node)) {
      node.getChildren().forEach(walk);
    }
  };
  $getRoot().getChildren().forEach(walk);
  return out;
}

interface Entry {
  readonly json: SerializedLexicalNode;
  readonly children: Entry[];
}

function entries(json: SerializedLexicalNode): Entry {
  const children = (json as {children?: SerializedLexicalNode[]}).children;
  return {children: (children || []).map(entries), json};
}

/**
 * The orders the nodes of a document are created in (which is the order
 * Lexical runs their transforms in).
 */
type Order = (all: Entry[], seed: number) => Entry[];

/** Each node before its children, in document order: what loading does. */
const outerFirst: Order = all => all;

const orders: Record<string, Order> = {
  // Each node after its children.
  innerFirst: all => {
    const out: Entry[] = [];
    const walk = (e: Entry) => {
      e.children.forEach(walk);
      out.push(e);
    };
    const tops = all.filter(e => !all.some(p => p.children.includes(e)));
    tops.forEach(walk);
    return out;
  },
  outerFirst,
  reverse: all => all.slice().reverse(),
  shuffled: (all, orderSeed) => {
    const r = rng(orderSeed * 7919);
    const c = all.slice();
    for (let i = c.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [c[i], c[j]] = [c[j], c[i]];
    }
    return c;
  },
};

/**
 * Load `input` creating its nodes in `order`, then linking them exactly as
 * `$parseSerializedNode` does (each child appended after its own children).
 */
function loadInOrder(
  editor: LexicalEditor,
  input: SerializedLexicalNode[],
  order: Order,
  seed: number,
  faithful = false,
  skipTransforms = false,
): void {
  const tops = input.map(entries);
  const all: Entry[] = [];
  const walk = (e: Entry) => {
    all.push(e);
    e.children.forEach(walk);
  };
  tops.forEach(walk);
  editor.update(
    () => {
      const nodes = new Map<Entry, LexicalNode>();
      for (const e of order(all, seed)) {
        nodes.set(
          e,
          $parseSerializedNode(
            $isElementJSON(e.json) ? {...e.json, children: []} : e.json,
          ),
        );
      }
      const link = (e: Entry): LexicalNode => {
        const node = nodes.get(e)!;
        for (const child of e.children) {
          if (faithful) {
            $put(node as ElementNode, [link(child)]);
          } else {
            (node as ElementNode).append(link(child));
          }
        }
        return node;
      };
      $getRoot()
        .clear()
        .append(...tops.map(link));
    },
    {discrete: true, skipTransforms: skipTransforms || undefined},
  );
}

/**
 * Load `input` as it is, as an update applied with `skipTransforms` does (no
 * transform runs, so nothing is normalized yet), running `$then` in the same
 * update.
 */
function loadAsIs(
  editor: LexicalEditor,
  input: SerializedLexicalNode[],
  $then: () => void = () => {},
): void {
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append(...input.map($buildAsIs));
      $then();
    },
    {discrete: true, skipTransforms: true},
  );
}

/** The orders in which every node of a loaded document is marked dirty. */
const dirtyOrders: Record<
  string,
  (nodes: LexicalNode[], seed: number) => LexicalNode[]
> = {
  // Each node before its children, in document order.
  forward: nodes => nodes,
  // Each node after its children.
  innerFirst: nodes => {
    const out: LexicalNode[] = [];
    const walk = (node: LexicalNode) => {
      if ($isElementNode(node)) {
        node.getChildren().forEach(walk);
      }
      out.push(node);
    };
    $getRoot().getChildren().forEach(walk);
    return out.filter(n => nodes.includes(n));
  },
  reverse: nodes => nodes.slice().reverse(),
  shuffled: (nodes, orderSeed) => {
    const r = rng(orderSeed * 6271);
    const c = nodes.slice();
    for (let i = c.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [c[i], c[j]] = [c[j], c[i]];
    }
    return c;
  },
};

/**
 * `input` with a style of its own on every text node, so that text
 * normalization never merges two of them: Lexical moves an element point
 * between two text nodes it merges, which is not the normalization's doing.
 */
function withDistinctStyles(
  input: SerializedLexicalNode[],
): SerializedLexicalNode[] {
  let n = 0;
  const copy = JSON.parse(JSON.stringify(input)) as SerializedLexicalNode[];
  const walk = (json: SerializedLexicalNode & {children?: unknown}) => {
    if (json.type === 'text') {
      (json as {style?: string}).style = `--n: ${n++}`;
    }
    if (Array.isArray(json.children)) {
      json.children.forEach(walk);
    }
  };
  copy.forEach(walk);
  return copy;
}

/** What a leaf adds to a position in the content: text, a decorator 1. */
function leafSize(node: LexicalNode): number {
  return $isTextNode(node)
    ? node.getTextContentSize()
    : $isDecoratorNode(node)
      ? 1
      : 0;
}

function $sizeOf(node: LexicalNode): number {
  return $isElementNode(node)
    ? node.getChildren().reduce((sum, c) => sum + $sizeOf(c), 0)
    : leafSize(node);
}

/**
 * Where a point is in the content: the size of every leaf before it in
 * document order (line breaks count 0, since joining paragraphs adds them).
 */
function $contentOffset(key: string, offset: number): number {
  let before = 0;
  let found = false;
  const walk = (node: LexicalNode): void => {
    if (found) {
      return;
    }
    if (node.getKey() === key) {
      found = true;
      before += $isElementNode(node)
        ? node
            .getChildren()
            .slice(0, offset)
            .reduce((sum, c) => sum + $sizeOf(c), 0)
        : offset;
      return;
    }
    if ($isElementNode(node)) {
      node.getChildren().forEach(walk);
    } else {
      before += leafSize(node);
    }
  };
  walk($getRoot());
  return found ? before : -1;
}

function $isElementJSON(json: SerializedLexicalNode): boolean {
  return Array.isArray((json as {children?: unknown}).children);
}

interface Leaf {
  key: string;
  desc: string;
  kind: string | null;
  inTable: boolean;
}

/**
 * The block a text node is a line of: its nearest ancestor that is neither
 * inline nor a plain paragraph (which has no kind of its own and becomes
 * lines of the block around it). Its kind must survive the repairs; only a
 * list's stray inline content gains one (it is wrapped in a list item).
 */
function blockKindOf(node: LexicalNode): string {
  for (const p of node.getParents()) {
    if (
      p.getType() === 'paragraph' ||
      p instanceof OverflowNode ||
      p.isInline()
    ) {
      continue;
    }
    return $isHeadingNode(p) ? p.getTag() : p.getType();
  }
  return 'root';
}

function leaves(editor: LexicalEditor): Leaf[] {
  return editor.read(() =>
    $allNodes()
      .filter(n => !$isElementNode(n))
      .map(n => ({
        desc: $isTextNode(n) ? n.getTextContent() : n.getType(),
        inTable: n.getParents().some($isTableNode),
        key: n.getKey(),
        kind: $isTextNode(n) ? blockKindOf(n) : null,
      })),
  );
}

/**
 * Whether `result` keeps every piece of content `kept` has (as many times),
 * in the order `created` has it, and nothing else.
 */
function keepsContent(result: string, created: string, kept: string): boolean {
  const units = (text: string) => text.match(/\[\d+\]|<hr>/g) || [];
  const counts = new Map<string, number>();
  for (const unit of units(result)) {
    counts.set(unit, (counts.get(unit) || 0) + 1);
  }
  for (const unit of units(kept)) {
    const n = counts.get(unit) || 0;
    if (n === 0) {
      return false;
    }
    counts.set(unit, n - 1);
  }
  // A subsequence of what was created.
  const all = units(created);
  let at = 0;
  for (const unit of units(result)) {
    while (at < all.length && all[at] !== unit) {
      at++;
    }
    if (at === all.length) {
      return false;
    }
    at++;
  }
  return true;
}

function tokens(editor: LexicalEditor): string {
  return editor.read(() =>
    $allNodes()
      .map(n =>
        $isTextNode(n) ? n.getTextContent() : $isDecoratorNode(n) ? '<hr>' : '',
      )
      .join(''),
  );
}

/**
 * Each piece of text (a `[n]` token) with the links, autolinks and marks
 * around it, outermost first: what they say about it (a URL, comment ids)
 * must stay on it.
 */
function annotations(editor: LexicalEditor): string[] {
  return editor.read(() => {
    const out: string[] = [];
    for (const node of $allNodes()) {
      if (!$isTextNode(node)) {
        continue;
      }
      const around = node
        .getParents()
        .reverse()
        .flatMap(p =>
          p instanceof MarkNode
            ? [`mark:${p.getIDs().join(',')}`]
            : p instanceof LinkNode
              ? [`${p.getType()}:${p.getURL()}`]
              : [],
        )
        .join('>');
      for (const unit of node.getTextContent().match(/\[\d+\]/g) || []) {
        out.push(`${unit} ${around}`);
      }
    }
    return out;
  });
}

/** The first difference between two lists of annotated text, for a report. */
function firstDifference(a: string[], b: string[]): string {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `${a[i]} -> ${b[i]}`;
    }
  }
  return '';
}

/**
 * Whether Lexical itself throws on `children` without the extension (some
 * random edits trip transforms of their own, such as a list inside a link).
 */
function lexicalRejects(children: SerializedLexicalNode[]): boolean {
  try {
    build('off').update(
      () => {
        $getRoot()
          .clear()
          .append(...children.map($buildAsIs));
      },
      {discrete: true},
    );
    return false;
  } catch (_e) {
    return true;
  }
}

/** A node built from JSON as it is (no override rewrites its children). */
function $buildAsIs(json: SerializedLexicalNode): LexicalNode {
  const children = (json as {children?: SerializedLexicalNode[]}).children;
  if (!Array.isArray(children)) {
    return $parseSerializedNode(json);
  }
  return $put(
    $parseSerializedNode({
      ...json,
      children: [],
    } as SerializedLexicalNode) as ElementNode,
    children.map($buildAsIs),
  );
}

/** Serialize a subtree, children included, before any transform runs. */
function $toJSON(node: LexicalNode): SerializedLexicalNode {
  const json = node.exportJSON() as SerializedLexicalNode & {
    children?: SerializedLexicalNode[];
  };
  if ($isElementNode(node)) {
    json.children = node.getChildren().map($toJSON);
  }
  return json;
}

/** A random broken subtree inserted at a random place of `root`. */
function randomEdit(
  root: SerializedLexicalNode & {children: SerializedLexicalNode[]},
  seed: number,
  extended = false,
): null | {
  path: number[];
  index: number;
  node: SerializedLexicalNode;
  edited: {children: SerializedLexicalNode[]};
} {
  const r = rng(seed * 104729);
  type Tree = SerializedLexicalNode & {children?: Tree[]};
  const targets: [number[], Tree & {children: Tree[]}][] = [];
  const walk = (tree: Tree, path: number[]) => {
    if (
      Array.isArray(tree.children) &&
      tree.type !== 'table' &&
      tree.type !== 'tablerow'
    ) {
      targets.push([path, tree as Tree & {children: Tree[]}]);
      tree.children.forEach((c, i) => walk(c, [...path, i]));
    }
  };
  walk(root, []);
  const [path, target] = targets[Math.floor(r() * targets.length)];
  const index = Math.floor(r() * (target.children.length + 1));
  let node: SerializedLexicalNode | null = null;
  const scratch = build('off');
  scratch.update(
    () => {
      token = 100000;
      let n = $gen(r, 2, extended);
      while (path.length === 0 && isInlineNode(n)) {
        n = $gen(r, 2, extended);
      }
      node = $toJSON(n);
    },
    {discrete: true},
  );
  if (node === null) {
    return null;
  }
  const edited = JSON.parse(JSON.stringify(root));
  let at: Tree & {children: Tree[]} = edited;
  for (const i of path) {
    at = at.children[i] as Tree & {children: Tree[]};
  }
  at.children.splice(index, 0, node);
  return {edited, index, node, path};
}

function isInlineNode(node: LexicalNode): boolean {
  return (
    $isTextNode(node) ||
    $isLineBreakNode(node) ||
    ($isElementNode(node) && node.isInline())
  );
}

function withoutDerived(editor: LexicalEditor): string {
  const derived = getDeclaredNodeStructure(ListItemNode).derived;
  return JSON.stringify(editor.getEditorState().toJSON(), (key, value) =>
    derived.has(key) ? undefined : value,
  );
}

function stateJSON(editor: LexicalEditor): string {
  return JSON.stringify(editor.getEditorState().toJSON());
}

function allows(children: NodeChildrenConfig, child: LexicalNode): boolean {
  const inline =
    $isTextNode(child) ||
    $isLineBreakNode(child) ||
    child instanceof OverflowNode ||
    child.isInline();
  if (child instanceof OverflowNode) {
    return true;
  }
  if (children === 'inline') {
    return inline;
  }
  if (children === 'block') {
    return !inline;
  }
  return inline
    ? children.includes('inline')
    : children.some(e => e !== 'inline' && child instanceof e);
}

/** Violations left in the document (it must be a fixed point). */
function violations(editor: LexicalEditor): string[] {
  return editor.read(() => {
    const out: string[] = [];
    for (const node of [$getRoot(), ...$allNodes()]) {
      if (!$isElementNode(node)) {
        continue;
      }
      const klass = node.constructor as Klass<LexicalNode>;
      const children = $isRootOrShadowRoot(node)
        ? 'block'
        : getDeclaredNodeStructure(klass).children;
      if (
        node.isEmpty() &&
        !$isRootOrShadowRoot(node) &&
        (node instanceof OverflowNode ||
          (node.isInline() && !node.canBeEmpty()))
      ) {
        out.push(`empty ${node.getType()}`);
      }
      for (const child of node.getChildren()) {
        if (children !== undefined && !allows(children, child)) {
          out.push(`${node.getType()} holds ${child.getType()}`);
        }
        const next = child.getNextSibling();
        const declared = getDeclaredNodeStructure(
          child.constructor as Klass<LexicalNode>,
        );
        if (
          next !== null &&
          next.constructor === child.constructor &&
          declared.mergeAdjacent !== undefined &&
          declared.declaredBy.mergeAdjacent === child.constructor
        ) {
          const a = child.exportJSON() as unknown as Record<string, unknown>;
          const b = next.exportJSON() as unknown as Record<string, unknown>;
          if (
            declared.mergeAdjacent.by.every(
              k =>
                typeof k === 'string' &&
                JSON.stringify(a[k]) === JSON.stringify(b[k]),
            )
          ) {
            out.push(`equal adjacent ${child.getType()}`);
          }
        }
      }
    }
    return out;
  });
}

/**
 * Three carets placed at random in `doc` as it is (loaded without any
 * transform) keep their place in the content: after the normalization each
 * is at the same offset in document order, and valid.
 */
function checkCarets(
  doc: SerializedLexicalNode[],
  seed: number,
  caretSeed: number,
  label: string,
  fail: (kind: string, failedSeed: number, msg?: string) => void,
): void {
  const styled = withDistinctStyles(doc);
  const probe = build('off');
  const points: [number[], number, 'text' | 'element'][] = [];
  loadAsIs(probe, styled, () => {
    const walk = (node: LexicalNode, path: number[]) => {
      if ($isTextNode(node)) {
        for (let i = 0; i <= node.getTextContentSize(); i++) {
          points.push([path, i, 'text']);
        }
      } else if ($isElementNode(node)) {
        for (let i = 0; i <= node.getChildrenSize(); i++) {
          points.push([path, i, 'element']);
        }
        node.getChildren().forEach((c, i) => walk(c, [...path, i]));
      }
    };
    walk($getRoot(), []);
  });
  const r = rng(caretSeed);
  for (let k = 0; k < 3 && points.length > 0; k++) {
    const [path, offset, type] = points[Math.floor(r() * points.length)];
    const editor = build('on');
    let before = -1;
    let where = '';
    try {
      loadAsIs(editor, styled, () => {
        let node: LexicalNode = $getRoot();
        for (const i of path) {
          node = (node as ElementNode).getChildAtIndex(i)!;
        }
        const selection = $createRangeSelection();
        selection.anchor.set(node.getKey(), offset, type);
        selection.focus.set(node.getKey(), offset, type);
        $setSelection(selection);
        before = $contentOffset(node.getKey(), offset);
        where = `${node.getType()}[${path}]@${offset}`;
      });
      editor.update(() => $allNodes().forEach(n => n.markDirty()), {
        discrete: true,
      });
    } catch (e) {
      fail(`throws (caret${label})`, seed, String(e));
      break;
    }
    const after = editor.read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
        return 'no collapsed range selection';
      }
      const {anchor} = selection;
      const node = anchor.getNode();
      const valid =
        node.isAttached() &&
        ($isTextNode(node)
          ? anchor.type === 'text' && anchor.offset <= node.getTextContentSize()
          : $isElementNode(node) && anchor.offset <= node.getChildrenSize());
      return valid
        ? $contentOffset(anchor.key, anchor.offset)
        : `invalid ${anchor.type} point in ${node.getType()}`;
    });
    if (after !== before) {
      fail(`caret moved${label}`, seed, `${where}: ${before} -> ${after}`);
    }
  }
}

/**
 * A local edit that breaks the normalized document `state` (inserting a
 * random broken subtree), where only the nodes it writes are dirty, gives
 * what loading the edited document gives, with every node dirty (as if it
 * arrived unrepaired), and leaves a fixed point.
 */
function checkLocalEdit(
  state: string,
  editSeed: number,
  label: string,
  fail: (kind: string, failedSeed: number, msg?: string) => void,
  seed = editSeed,
): void {
  const children = JSON.parse(state).root.children;
  const edit = randomEdit(JSON.parse(state).root, editSeed, label !== '');
  if (edit === null || lexicalRejects(edit.edited.children)) {
    return;
  }
  const local = build('on');
  const fresh = build('on');
  try {
    local.update(
      () => {
        $getRoot()
          .clear()
          .append(...children.map($buildAsIs));
      },
      {discrete: true},
    );
    local.update(
      () => {
        let target: ElementNode = $getRoot();
        for (const i of edit.path) {
          target = target.getChildAtIndex(i) as ElementNode;
        }
        $put(target, []);
        ElementNode.prototype.splice.call(target, edit.index, 0, [
          $buildAsIs(edit.node),
        ]);
      },
      {discrete: true},
    );
    fresh.update(
      () => {
        $getRoot()
          .clear()
          .append(...edit.edited.children.map($buildAsIs));
      },
      {discrete: true},
    );
  } catch (e) {
    fail(`throws on an edit${label}`, seed, String(e));
    return;
  }
  // Derived values (a list item's number) are recomputed by their class's
  // own transform when it runs, which this edit (as without the extension)
  // does not always trigger: compare the rest.
  if (withoutDerived(fresh) !== withoutDerived(local)) {
    fail(`a local edit and a fresh load disagree${label}`, seed);
  }
  const asBuilt = build('off');
  loadAsIs(asBuilt, edit.edited.children);
  if (tokens(local) !== tokens(asBuilt)) {
    fail(`content lost by a local edit${label}`, seed);
  }
  const remaining = violations(local);
  if (remaining.length > 0) {
    fail(
      `not a fixed point after a local edit${label}`,
      seed,
      remaining.join(', '),
    );
  }
}

describe('NodeStructureExtension properties', () => {
  test(`random broken documents (${SEEDS} seeds)`, () => {
    const failures: Record<string, string[]> = {};
    const fail = (kind: string, failedSeed: number, msg = '') => {
      (failures[kind] ||= []).push(`${failedSeed} ${msg}`.slice(0, 300));
    };
    let checked = 0;
    let generatedChecked = 0;
    for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
      disposeBuilt();
      const {input, plain, generated} = makeInput(seed);
      generatedChecked++;
      // The document as generated, before any transform ran: links,
      // autolinks and marks around blocks (which an editor without the
      // extension lifts blocks out of only in part, or throws on), and equal
      // adjacent lists whose items at the seam hold a nested list. Nothing is
      // lost, duplicated or reordered, every piece of text keeps the links,
      // autolinks and marks around it, and the result is a fixed point that
      // depends on the document only. (`INTERNAL_$normalizeNodeStructure` is
      // checked on the documents above only: in an update without
      // transforms, Lexical's own, such as the one that puts a list item
      // outside a list into a list, do not run.)
      {
        const asBuilt = build('off');
        loadAsIs(asBuilt, generated);
        const rawTokens = tokens(asBuilt);
        const rawAnnotations = annotations(asBuilt);
        const editor = build('on');
        let reference: string | null = null;
        try {
          editor.update(
            () => {
              $getRoot()
                .clear()
                .append(...generated.map($buildAsIs));
            },
            {discrete: true},
          );
          reference = stateJSON(editor);
        } catch (e) {
          fail('throws (generated)', seed, String(e));
        }
        if (reference !== null) {
          if (tokens(editor) !== rawTokens) {
            fail('content lost, duplicated or reordered (generated)', seed);
          }
          const got = annotations(editor);
          if (got.join('\n') !== rawAnnotations.join('\n')) {
            fail(
              'annotation lost (generated)',
              seed,
              firstDifference(rawAnnotations, got),
            );
          }
          const remaining = violations(editor);
          if (remaining.length > 0) {
            fail('not a fixed point (generated)', seed, remaining.join(', '));
          }
          editor.update(() => $allNodes().forEach(n => n.markDirty()), {
            discrete: true,
          });
          if (stateJSON(editor) !== reference) {
            fail('not idempotent (generated)', seed);
          }
          for (const [name, order] of Object.entries(orders)) {
            const other = build('on');
            try {
              loadInOrder(other, generated, order, seed, true);
            } catch (e) {
              fail(`throws (generated, ${name})`, seed, String(e));
              continue;
            }
            if (stateJSON(other) !== reference) {
              fail(`result depends on dirty order (generated, ${name})`, seed);
            }
          }
          for (const [name, order] of Object.entries(dirtyOrders)) {
            const other = build('on');
            try {
              loadAsIs(other, generated);
              other.update(
                () => order($allNodes(), seed).forEach(n => n.markDirty()),
                {discrete: true},
              );
            } catch (e) {
              fail(`throws (generated, dirty ${name})`, seed, String(e));
              continue;
            }
            if (stateJSON(other) !== reference) {
              fail(
                `result depends on dirty order (generated, dirty ${name})`,
                seed,
              );
            }
          }
          const later = build('disabled');
          loadAsIs(later, generated);
          getExtensionDependencyFromEditor(
            later,
            NodeStructureExtension,
          ).output.disabled.value = false;
          later.read(() => {});
          if (stateJSON(later) !== reference) {
            fail(
              'result differs when enforcement is turned on (generated)',
              seed,
            );
          }
        }
        checkCarets(generated, seed, seed * 7741, ' (generated)', fail);
        if (reference !== null) {
          checkLocalEdit(reference, seed * 31 + 7, ' (generated)', fail, seed);
        }
      }
      if (plain === null || input === null) {
        // Lexical's own transforms reject the document without the extension
        // (a list inside a link): there is no reference to compare with.
        continue;
      }
      // Loading with the extension: everything is created, outer nodes
      // first. A document Lexical's own transforms reject without the
      // extension (a list inside a link) is skipped.
      const off = build('off');
      try {
        load(off, plain);
      } catch (_e) {
        continue;
      }
      checked++;
      const loaded = build('on');
      try {
        load(loaded, plain);
      } catch (e) {
        fail('throws on load', seed, String(e));
        continue;
      }
      if (tokens(loaded) !== tokens(off)) {
        fail('content lost, duplicated or reordered on load', seed);
      }
      // What a link, autolink or mark says about the text it holds stays on
      // it, as it does without the extension.
      if (annotations(loaded).join('\n') !== annotations(off).join('\n')) {
        fail(
          'annotation lost on load',
          seed,
          firstDifference(annotations(off), annotations(loaded)),
        );
      }
      const want = stateJSON(loaded);
      const left = violations(loaded);
      if (left.length > 0) {
        fail('not a fixed point', seed, left.join(', '));
      }
      // Idempotence: everything dirty again changes nothing.
      loaded.update(() => $allNodes().forEach(n => n.markDirty()), {
        discrete: true,
      });
      if (stateJSON(loaded) !== want) {
        fail('not idempotent', seed);
      }
      // Idempotence of the whole normalization on its own result.
      loaded.update(() => INTERNAL_$normalizeNodeStructure($getRoot()), {
        discrete: true,
      });
      if (stateJSON(loaded) !== want) {
        fail('not idempotent (INTERNAL_$normalizeNodeStructure)', seed);
      }
      // The same document with its nodes created in other orders.
      for (const [name, order] of Object.entries(orders)) {
        const editor = build('on');
        try {
          loadInOrder(editor, plain, order, seed);
        } catch (e) {
          fail(`throws (${name})`, seed, String(e));
          continue;
        }
        if (stateJSON(editor) !== want) {
          fail(`result depends on dirty order (${name})`, seed);
        }
      }
      // The document with empty inline elements put in, loaded as it is (as
      // an update applied with skipTransforms leaves it), then every node
      // marked dirty, in several orders: the same result whichever
      // transforms run first (the normalization's, or Lexical's own, such as
      // the removal of an empty inline element), with the same content.
      const raw = build('off');
      loadAsIs(raw, input);
      const content = tokens(raw);
      let asIsReference: LexicalEditor | null = null;
      {
        let reference: string | null = null;
        for (const [name, order] of Object.entries(dirtyOrders)) {
          const editor = build('on');
          try {
            loadAsIs(editor, input);
            editor.update(
              () => order($allNodes(), seed).forEach(n => n.markDirty()),
              {discrete: true},
            );
          } catch (e) {
            fail(`throws (dirty ${name})`, seed, String(e));
            break;
          }
          const result = stateJSON(editor);
          if (reference === null) {
            reference = result;
            asIsReference = editor;
            if (tokens(editor) !== content) {
              fail('content lost, duplicated or reordered (as is)', seed);
            }
            const remaining = violations(editor);
            if (remaining.length > 0) {
              fail('not a fixed point (dirty)', seed, remaining.join(', '));
            }
          } else if (result !== reference) {
            fail(`result depends on dirty order (dirty ${name})`, seed);
          }
        }
      }
      // The same document created in every order, through the methods
      // loading uses: the same result, keeping the content loading builds
      // (before any transform runs) in its order, except what Lexical's own
      // transforms drop without the extension too (the rows of a table put
      // in a list).
      {
        const asBuilt = build('off');
        const injectedOff = build('off');
        let rejected = false;
        try {
          loadInOrder(asBuilt, input, outerFirst, seed, false, true);
          load(injectedOff, input);
        } catch (_e) {
          rejected = true;
        }
        let reference: string | null = null;
        for (const [name, order] of rejected ? [] : Object.entries(orders)) {
          const editor = build('on');
          try {
            loadInOrder(editor, input, order, seed);
          } catch (e) {
            fail(`throws (empty inline, ${name})`, seed, String(e));
            break;
          }
          if (reference === null) {
            reference = stateJSON(editor);
            if (
              !keepsContent(
                tokens(editor),
                tokens(asBuilt),
                tokens(injectedOff),
              )
            ) {
              fail('content lost (empty inline)', seed);
            }
          } else if (stateJSON(editor) !== reference) {
            fail(`result depends on dirty order (empty inline, ${name})`, seed);
          }
        }
      }
      // A caret anywhere in the document keeps its place in the content.
      checkCarets(input, seed, seed * 7727, '', fail);
      // The document as an editor without enforcement leaves it, which is
      // then turned on: every leaf kept exactly once, in order, in a block of
      // the same kind, and the same result as loading it with enforcement.
      {
        const editor = build('disabled');
        load(editor, plain);
        const before = leaves(editor);
        getExtensionDependencyFromEditor(
          editor,
          NodeStructureExtension,
        ).output.disabled.value = false;
        editor.read(() => {});
        if (stateJSON(editor) !== want) {
          fail('result differs when enforcement is turned on later', seed);
        }
        const after = leaves(editor).filter(
          l => l.desc !== 'linebreak' || before.some(b => b.key === l.key),
        );
        const describeLeaves = (ls: Leaf[]) =>
          ls.map(l => `${l.key}:${l.desc}`).join(' ');
        if (describeLeaves(after) !== describeLeaves(before)) {
          fail('leaf lost, duplicated or reordered', seed);
        }
        const byKey = new Map(after.map(l => [l.key, l]));
        for (const b of before) {
          const a = byKey.get(b.key);
          if (
            a &&
            a.kind !== b.kind &&
            !(b.kind === 'list' && a.kind === 'listitem')
          ) {
            fail('block kind lost', seed, `${b.desc}: ${b.kind} -> ${a.kind}`);
            break;
          }
          if (a && b.inTable && !a.inTable) {
            fail('left its table', seed, b.desc);
            break;
          }
        }
      }
      // The document as it is, in an editor that turns enforcement on
      // before any transform ran: the same result.
      {
        const editor = build('disabled');
        loadAsIs(editor, input);
        getExtensionDependencyFromEditor(
          editor,
          NodeStructureExtension,
        ).output.disabled.value = false;
        editor.read(() => {});
        if (
          asIsReference !== null &&
          stateJSON(editor) !== stateJSON(asIsReference)
        ) {
          fail('result differs when enforcement is turned on (as is)', seed);
        }
      }
      // The internal entry point that normalizes a subtree now: on the root
      // of the document as an editor without enforcement leaves it, and on
      // the document as it is, in an update that runs no transform (list
      // numbers, which the list's own transform recomputes, are left out).
      {
        const editor = build('off');
        load(editor, plain);
        editor.update(() => INTERNAL_$normalizeNodeStructure($getRoot()), {
          discrete: true,
        });
        if (stateJSON(editor) !== want) {
          fail('INTERNAL_$normalizeNodeStructure differs', seed);
        }
        const asIs = build('off');
        loadAsIs(asIs, input, () =>
          INTERNAL_$normalizeNodeStructure($getRoot()),
        );
        if (
          asIsReference !== null &&
          withoutDerived(asIs) !== withoutDerived(asIsReference)
        ) {
          fail('INTERNAL_$normalizeNodeStructure differs (as is)', seed);
        }
        const remaining = violations(asIs);
        if (remaining.length > 0) {
          fail(
            'not a fixed point (INTERNAL_$normalizeNodeStructure, as is)',
            seed,
            remaining.join(', '),
          );
        }
      }
      // A local edit that breaks the normalized document, where only the
      // nodes it writes are dirty, gives what loading the edited document
      // gives, with every node dirty (as if it arrived unrepaired).
      checkLocalEdit(want, seed, '', fail);
      try {
        const withInline = build('on', [NormalizeInlineElementsExtension]);
        load(withInline, plain);
        if (tokens(withInline) !== tokens(off)) {
          fail('content lost with NormalizeInlineElements', seed);
        }
      } catch (e) {
        fail('throws with NormalizeInlineElements', seed, String(e));
      }
    }
    disposeBuilt();
    const summary = Object.fromEntries(
      Object.entries(failures).map(([k, v]) => [
        k,
        {count: v.length, first: v.slice(0, 3)},
      ]),
    );
    if (process.env.NODE_STRUCTURE_SEEDS) {
      // eslint-disable-next-line no-console
      console.log(
        `node structure property: ${checked} documents checked, ${generatedChecked} generated, failures: ${JSON.stringify(summary, null, 1)}`,
      );
    }
    expect(checked).toBeGreaterThan(SEEDS * 0.75);
    expect(summary).toEqual({});
  }, 600_000);
});
