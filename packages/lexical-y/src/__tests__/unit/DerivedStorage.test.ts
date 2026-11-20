/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Storage derived from the general $config declarations (inline, children,
// mergeAdjacent, derived), the per-document pin, and the normalization
// every peer runs (NodeStructureExtension's transforms, registered by the
// binding).
import {$createCodeHighlightNode, $createCodeNode} from '@lexical/code-core';
import {$createAutoLinkNode, $createLinkNode, LinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  type ListItemNode,
  type ListType,
} from '@lexical/list';
import {$createOverflowNode, OverflowNode} from '@lexical/overflow';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  ElementNode,
  type Klass,
  type LexicalNode,
  nodeSchema,
  ParagraphNode,
  stringValue,
  withField,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {describeStorage} from '../..';
import {
  $block,
  $createBoxNode,
  $createEquation,
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  NODES,
  type Peer,
  setup,
  shape,
} from '../utils/harness';

/** A small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    p: (x: number) => next() < x,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
  };
}

const CORE_KINDS = {
  autolink: 'nested',
  code: 'line',
  'code-highlight': 'text',
  heading: 'line',
  linebreak: 'text',
  link: 'format',
  list: 'group',
  listitem: 'line',
  mark: 'nested',
  paragraph: 'line',
  quote: 'line',
  tab: 'text',
  table: 'nested',
  tablecell: 'nested',
  tablerow: 'nested',
  text: 'text',
} as const;

describe('describeStorage', () => {
  test("Lexical's own nodes derive their storage from general declarations", async () => {
    const t = await setup(() => $getRoot().append($p('x')));
    const kinds = describeStorage(t.a.editor);
    for (const [type, kind] of Object.entries(CORE_KINDS)) {
      expect([type, kinds[type]]).toEqual([type, kind]);
    }
    // Undeclared test containers and decorators are nested.
    expect(kinds.test_box).toBe('nested');
    expect(kinds.test_widget).toBe('nested');
  });
});

describe('merge methods and OverflowNode', () => {
  class NoMergeLink extends LinkNode {
    $config() {
      return this.config('test_nomerge_link', {extends: LinkNode});
    }
    shouldMergeAdjacentLink(): boolean {
      return false;
    }
  }
  class PlainLink extends LinkNode {
    $config() {
      return this.config('test_plain_link', {extends: LinkNode});
    }
  }

  test('a link subclass that overrides shouldMergeAdjacentLink is stored nested', async () => {
    const t = await setup(() => $getRoot().append($p('x')), {
      nodes: [...NODES, NoMergeLink, PlainLink],
    });
    const kinds = describeStorage(t.a.editor);
    expect(kinds.test_nomerge_link).toBe('nested');
    expect(kinds.test_plain_link).toBe('format');
    t.a.update(() =>
      $getRoot().append(
        $createParagraphNode().append(
          $create(NoMergeLink).setURL(URLS[0]).append($createTextNode('n1')),
          $create(NoMergeLink).setURL(URLS[0]).append($createTextNode('n2')),
        ),
      ),
    );
    await t.sync();
    await expectConverged(t.peers);
    // Its override keeps the two apart on every peer.
    expect(t.b.describe()).toContain(
      'test_nomerge_link<https://a>("n1") test_nomerge_link<https://a>("n2")',
    );
  });

  test('a paragraph holding an OverflowNode stays one line', async () => {
    const t = await setup(() => $getRoot().append($p('x')), {
      nodes: [...NODES, OverflowNode],
    });
    expect(describeStorage(t.a.editor).overflow).toBe('nested');
    t.a.update(() =>
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('within'),
          $createOverflowNode().append($createTextNode('over')),
          $createTextNode('after'),
        ),
      ),
    );
    await t.sync();
    t.b.update(() => $selectIn([1], 0).insertText('B'));
    await t.sync();
    await expectConverged(t.peers);
    for (const peer of [...t.peers, await freshReader(t.a)]) {
      expect(peer.describe()).toBe(
        'paragraph("x") / paragraph("Bwithin" overflow("over") "after")',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Property: write -> read equals the author's normalized tree

const URLS = ['https://a', 'https://b'];
let tokenCounter = 0;
const token = () => `t${tokenCounter++}`;

function $inline(r: ReturnType<typeof rng>, depth: number): LexicalNode[] {
  const out: LexicalNode[] = [];
  const n = 1 + r.int(3);
  for (let i = 0; i < n; i++) {
    const k = r.int(10);
    if (k < 5) {
      const text = $createTextNode(token());
      if (r.p(0.3)) {
        text.setFormat(r.pick([1, 2, 3]));
      }
      out.push(text);
    } else if (k === 5) {
      out.push($createLineBreakNode());
    } else if (k === 6 && depth < 2) {
      // Adjacent links with equal values: merged by the normalization.
      const url = r.pick(URLS);
      out.push($createLinkNode(url).append($createTextNode(token())));
      if (r.p(0.5)) {
        out.push($createLinkNode(url).append($createTextNode(token())));
      }
    } else if (k === 7 && depth < 2) {
      out.push(
        $createAutoLinkNode(r.pick(URLS)).append($createTextNode(token())),
      );
    } else if (k === 8) {
      out.push($createEquation(token()));
    } else {
      out.push($createTextNode(token()));
    }
  }
  return out;
}

function $listOf(r: ReturnType<typeof rng>, depth: number): ElementNode {
  const type: ListType = r.pick(['bullet', 'number', 'check']);
  const list = $createListNode(type, r.p(0.2) ? 3 : 1);
  const n = 1 + r.int(3);
  for (let i = 0; i < n; i++) {
    const item = $createListItemNode();
    if (depth < 2 && r.p(0.25)) {
      item.append($listOf(r, depth + 1));
    } else if (r.p(0.15)) {
      // Paragraphs in an item (splice: append would unwrap them): they
      // become lines of the item.
      item.splice(0, 0, [
        ...$inline(r, depth + 1),
        $p(token()),
        $createParagraphNode(),
        $p(token()),
      ]);
    } else {
      item.append(...$inline(r, depth + 1));
    }
    list.append(item);
  }
  return list;
}

/**
 * A random block, often violating the declarations (a block inside a
 * paragraph, inline content directly in a table cell, adjacent equal
 * lists), which the author's normalization repairs before writing.
 */
function $blockOf(r: ReturnType<typeof rng>, depth: number): LexicalNode[] {
  const k = r.int(12);
  if (k <= 2) {
    const p = $createParagraphNode().append(...$inline(r, depth));
    if (depth < 2 && r.p(0.25)) {
      // A stray block inside a paragraph (raw splice skips any guard).
      p.splice(r.int(p.getChildrenSize() + 1), 0, [
        r.p(0.5) ? $createBoxNode().append($p(token())) : $listOf(r, depth + 1),
      ]);
    }
    return [p];
  }
  if (k === 3) {
    return [
      $createHeadingNode(r.pick(['h1', 'h2'])).append(...$inline(r, depth)),
    ];
  }
  if (k === 4) {
    if (r.p(0.4)) {
      // Paragraphs and a heading in a quote: the paragraphs become lines of
      // the quote, the heading is split around.
      return [
        $createQuoteNode().append(
          $p(token()),
          ...$inline(r, depth),
          $p(token()),
          ...(r.p(0.5)
            ? [$createHeadingNode('h3').append($createTextNode(token()))]
            : []),
          $p(token()),
        ),
      ];
    }
    return [$createQuoteNode().append(...$inline(r, depth))];
  }
  if (k === 5) {
    const lists = [$listOf(r, depth)];
    if (r.p(0.4)) {
      lists.push($listOf(r, depth));
    }
    return lists;
  }
  if (k === 6) {
    return [
      $createCodeNode().append(
        $createCodeHighlightNode(token()),
        $createLineBreakNode(),
        $createTextNode(token()),
      ),
    ];
  }
  if (k === 7 && depth < 2) {
    const cell = $createTableCellNode();
    if (r.p(0.5)) {
      // Inline content directly in a cell: wrapped in a paragraph.
      cell.append(...$inline(r, depth + 1));
    } else {
      cell.append(...$blockOf(r, depth + 1));
    }
    return [$createTableNode().append($createTableRowNode().append(cell))];
  }
  if (k === 8 && depth < 2) {
    return [$createBoxNode().append(...$blockOf(r, depth + 1))];
  }
  if (k === 9 && depth < 2) {
    // An opted-in shadow root quote holds blocks.
    return [
      $createQuoteNode({shadowRoot: true}).append(
        $p(token()),
        ...$blockOf(r, depth + 1),
      ),
    ];
  }
  return [$p(token())];
}

const tokensOf = (s: string) => s.match(/t\d+/g) ?? [];

describe('property: write -> read equals the normalized author tree', () => {
  const SEEDS = Number(process.env.STORAGE_PROP_SEEDS ?? 120);
  test.each(Array.from({length: SEEDS}, (_, i) => i + 1))(
    'seed %i',
    async seed => {
      const r = rng(seed);
      const t = await setup(() => $getRoot().append($p('start')), {
        ids: [1, 2, 3],
      });
      const from = tokenCounter;
      t.a.update(() => {
        const blocks: LexicalNode[] = [];
        const n = 1 + r.int(4);
        for (let i = 0; i < n; i++) {
          blocks.push(...$blockOf(r, 0));
        }
        $getRoot().append(...blocks);
      });
      const written = Array.from(
        {length: tokenCounter - from},
        (_, i) => `t${from + i}`,
      );
      await t.sync();
      // Peers and a fresh reader hold exactly the author's (normalized) tree.
      await expectConverged(t.peers);
      for (const peer of t.peers) {
        expect(peer.warnings).toEqual([]);
      }
      // The normalization moved content and never dropped or copied any.
      const after = tokensOf(JSON.stringify(shape(t.a))).sort();
      expect(after).toEqual([...written].sort());
    },
  );
});

// ---------------------------------------------------------------------------
// Fuzz: peers edit concurrently, normalization included

function $allTexts(): {key: string; size: number}[] {
  return $getRoot()
    .getAllTextNodes()
    .filter(n => n.isSimpleText())
    .map(n => ({key: n.getKey(), size: n.getTextContentSize()}));
}

/** Offsets that do not split a token (text edges and spaces). */
function boundaries(text: string): number[] {
  const out = [0, text.length];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') {
      out.push(i);
    }
  }
  return out;
}

/** One random edit; never deletes text (so loss or duplication shows). */
function $edit(r: ReturnType<typeof rng>, typed: string[]): string {
  const texts = $allTexts();
  const root = $getRoot();
  const k = r.int(9);
  if (k <= 2 && texts.length > 0) {
    const target = r.pick(texts);
    const tok = token();
    typed.push(tok);
    const node = root.getAllTextNodes().find(n => n.getKey() === target.key)!;
    node.spliceText(r.pick(boundaries(node.getTextContent())), 0, ` ${tok} `);
    return `type ${tok}`;
  }
  const blocks = root.getChildren();
  const block = r.pick(blocks) as ElementNode;
  if (k === 3) {
    // A stray block put into a block's content: lifted out.
    if (block.getChildrenSize() > 0 && !block.isShadowRoot()) {
      const tok = token();
      typed.push(tok);
      block.splice(r.int(block.getChildrenSize() + 1), 0, [
        $createBoxNode().append($p(tok)),
      ]);
      return `stray box ${tok} into ${block.getType()}`;
    }
  } else if (k === 4) {
    // A list next to a list of the same type: merged.
    const tok = token();
    typed.push(tok);
    block.insertAfter(
      $createListNode('bullet').append(
        $createListItemNode().append($createTextNode(tok)),
      ),
    );
    return `list ${tok} after ${block.getType()}`;
  } else if (k === 5) {
    // A link next to an equal one: merged.
    const tok = token();
    typed.push(tok);
    const links = root
      .getAllTextNodes()
      .map(n => n.getParent())
      .filter((p): p is LinkNode => p instanceof LinkNode);
    const link = links.length > 0 ? r.pick(links) : null;
    const created = $createLinkNode(link ? link.getURL() : URLS[0]).append(
      $createTextNode(tok),
    );
    if (link) {
      link.insertAfter(created);
    } else if (texts.length > 0) {
      root
        .getAllTextNodes()
        .find(n => n.getKey() === texts[0].key)!
        .insertAfter(created);
    }
    return `link ${tok}`;
  } else if (k === 6) {
    // Indent or outdent a list item.
    const items = root
      .getAllTextNodes()
      .map(n => n.getParent())
      .filter((p): p is ListItemNode => $isListItemNode(p));
    if (items.length > 0) {
      const item = r.pick(items);
      const to = Math.max(0, item.getIndent() + (r.p(0.6) ? 1 : -1));
      item.setIndent(to);
      return `indent ${item.getTextContent().slice(0, 12)} -> ${to}`;
    }
  } else if (k === 7) {
    // Enter: split a text block.
    if (texts.length > 0) {
      const target = r.pick(texts);
      const node = root.getAllTextNodes().find(n => n.getKey() === target.key)!;
      const at = r.pick(boundaries(node.getTextContent()));
      const sel = node.select(at, at);
      sel.insertParagraph();
      return `enter in ${node.getTextContent().slice(0, 12)}`;
    }
  } else {
    // Retype a paragraph as a heading (or back).
    if (block instanceof ParagraphNode) {
      block.replace($createHeadingNode('h2'), true);
      return `heading ${block.getTextContent().slice(0, 12)}`;
    }
  }
  return 'noop';
}

function count(haystack: string, tok: string): number {
  return tokensOf(haystack).filter(x => x === tok).length;
}

describe('fuzz: concurrent edits with normalization', () => {
  const SEEDS = Number(process.env.STORAGE_FUZZ_SEEDS ?? 60);
  test.each(Array.from({length: SEEDS}, (_, i) => i + 1))(
    'seed %i',
    async seed => {
      const r = rng(1000 + seed);
      const t = await setup(
        () => {
          $getRoot().append(
            $p('alpha beta'),
            $createListNode('bullet').append(
              $createListItemNode().append($createTextNode('one')),
              $createListItemNode().append($createTextNode('two')),
            ),
            $createParagraphNode().append(
              $createLinkNode(URLS[0]).append($createTextNode('link')),
              $createTextNode(' tail'),
            ),
          );
        },
        {ids: [1, 2, 3]},
      );
      const typed: string[] = [];
      const trace: string[] = [];
      for (let round = 0; round < 3; round++) {
        t.offline();
        for (const [pi, peer] of t.peers.entries()) {
          const n = 1 + r.int(3);
          for (let i = 0; i < n; i++) {
            peer.update(() => {
              trace.push(`r${round} p${pi + 1}: ${$edit(r, typed)}`);
            });
          }
          trace.push(`  p${pi + 1} = ${peer.describe()}`);
        }
        await t.sync();
        trace.push(`synced = ${t.a.describe()}`);
      }
      if (process.env.STORAGE_FUZZ_TRACE === String(seed)) {
        // eslint-disable-next-line no-console
        console.log(trace.join('\n'));
      }
      await expectConverged(t.peers);
      const text = JSON.stringify(shape(t.a));
      const lost = typed.filter(tok => count(text, tok) === 0);
      const dup = typed.filter(tok => count(text, tok) > 1);
      expect({dup, lost}).toEqual({dup: [], lost: []});
    },
  );
});

// ---------------------------------------------------------------------------
// ListItemNode indentation without a `nested` flag

describe('list nesting is derived (a line holding its own group)', () => {
  test('indent, outdent and a 3-level list round trip; levels stored on items', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createListNode('number').append(
          $createListItemNode().append($createTextNode('a')),
          $createListItemNode().append($createTextNode('b')),
          $createListItemNode().append($createTextNode('c')),
          $createListItemNode().append($createTextNode('d')),
        ),
      ),
    );
    t.a.update(() => {
      const list = $block([0]);
      (list.getChildAtIndex(1) as ListItemNode).setIndent(1);
      (list.getChildAtIndex(2) as ListItemNode).setIndent(2);
    });
    await t.sync();
    await expectConverged(t.peers);
    expect(t.b.describe()).toBe(
      'list[number](listitem("a") listitem(list[number](listitem("b") listitem(list[number](listitem("c"))))) listitem("d"))',
    );
    // No list is stored as a node: nesting is a level on the item markers.
    const names = (
      t.a.binding.root.toArray().filter(c => c instanceof Y.Node) as Y.Node[]
    ).map(n => n.name);
    expect(names.every(n => n === '\u00b6')).toBe(true);
    t.b.update(() => {
      const item = $block([0])
        .getAllTextNodes()
        .find(n => n.getTextContent() === 'c')!
        .getParent() as ListItemNode;
      item.setIndent(0);
    });
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.read(() => $getRoot().getTextContent())).toContain('c');
  });

  test.each([
    [1, 2],
    [2, 1],
  ])('indent ‖ typing in the item keeps the text (ids %i,%i)', async (x, y) => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('one')),
            $createListItemNode().append($createTextNode('two')),
          ),
        ),
      {ids: [x, y]},
    );
    t.offline();
    t.a.update(() =>
      ($block([0]).getChildAtIndex(1) as ListItemNode).setIndent(1),
    );
    t.b.update(() => $selectIn([0, 1], 3).insertText('!'));
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.describe()).toBe(
      'list[bullet](listitem("one") listitem(list[bullet](listitem("two!"))))',
    );
  });
});

// Content written without the normalization (normalized by its author,
// shown as written by the others until then) is covered by
// NormalizationConvergence.test.ts.

// ---------------------------------------------------------------------------
// Per-document pins

const pinSchema = nodeSchema<PinnedLine>()({
  tone: withField(stringValue(), {field: '__tone'}),
});
/** Declares inline content: derives as a line. */
class PinnedLine extends ElementNode {
  __tone = '';
  $config() {
    return this.config('pin_block', {
      children: 'inline',
      extends: ElementNode,
      json: pinSchema,
    });
  }
}
/** The same type without the declaration (an older version): nested. */
class PinnedNested extends ElementNode {
  __tone = '';
  $config() {
    return this.config('pin_block', {extends: ElementNode, json: pinSchema});
  }
}
/** The same type declared to hold blocks: cannot be stored as a line. */
class PinnedBlocks extends ElementNode {
  __tone = '';
  $config() {
    return this.config('pin_block', {
      children: 'block',
      extends: ElementNode,
      json: pinSchema,
    });
  }
}

async function twoClients(
  first: Klass<LexicalNode>,
  second: Klass<LexicalNode>,
): Promise<[Peer, Peer]> {
  const t = await setup(
    () =>
      $getRoot().append(
        $create(first as Klass<ElementNode>).append($createTextNode('pinned')),
      ),
    {nodes: [...NODES, first]},
  );
  const other = await freshReader(t.a, [...NODES, second]);
  return [t.a, other];
}

describe('per-document pin', () => {
  test('the first write records the kind; a client deriving another kind uses it', async () => {
    // Written by the version that derives `nested`...
    const [a, b] = await twoClients(PinnedNested, PinnedLine);
    expect(a.binding.root.getAttr('k:pin_block')).toBe('nested');
    expect(describeStorage(b.editor).pin_block).toBe('line');
    // ...read by a version that derives `line`: it keeps the recorded kind.
    expect(describeStorage(b.editor, b.binding).pin_block).toBe('nested');
    expect(b.binding.status).toBe('active');
    expect(b.describe()).toBe(a.describe());
  });

  test('a recorded line is used by a client that can store the class as a line', async () => {
    const [a, b] = await twoClients(PinnedLine, PinnedNested);
    expect(a.binding.root.getAttr('k:pin_block')).toBe('line');
    expect(describeStorage(b.editor, b.binding).pin_block).toBe('line');
    expect(b.binding.status).toBe('active');
  });

  test('a client that cannot store the recorded kind opens read only', async () => {
    const [a, b] = await twoClients(PinnedLine, PinnedBlocks);
    expect(a.binding.root.getAttr('k:pin_block')).toBe('line');
    expect(b.binding.status).toBe('readonly');
    expect(b.warnings.join('\n')).toContain(
      "pin_block is stored as line, its class as nested. A document keeps the kind its first write of a type recorded, so this editor is read only: restore the class's previous node structure declaration, or reseed the content into a new room with seedYState to adopt the new one",
    );
  });

  test('list identity is the declared fields only (NodeState does not split a list)', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('a')),
          $createListItemNode().append($createTextNode('b')),
        ),
      ),
    );
    expect(t.a.binding.root.getAttr('k:list')).toBe('group|listType');
  });
});
