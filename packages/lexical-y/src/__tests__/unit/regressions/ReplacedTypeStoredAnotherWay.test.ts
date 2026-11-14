/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A node replacement (`{replace, with, withKlass}`) makes an editor build a
// stored type's nodes as another class, with a type of its own. When that
// class cannot be stored the way the document stores the type, the binding
// could not write edits to those nodes. The check that makes a document read
// only when a class's declaration no longer fits its stored kind
// (STORAGE_MISMATCH_WARNING, `'declaration-changed'`) looked at the
// registered class, not at the class nodes are built as, so the binding
// stayed active, showed every edit in the editor and wrote nothing of it:
// typing inside a quote that a container class replaces was lost on reload,
// with no warning. Found by the separate-node-type alternative to layout 5
// for shadow-root quotes (meta/lexical#9906): a quote that holds paragraphs
// as its own container type, replacing QuoteNode, over rooms that store
// such quotes as lines.
//
// Now a read that builds a stored line as a class that cannot be stored as
// a line opens the document read only with that warning, naming the type
// built, and `editYState` and `readYState` refuse it. The class checked is
// the one built: a replacement's `withKlass`, a stricter class its `with`
// returns, or `with` alone. Replacements that can be stored as the type is
// keep writing, as before: a line by a line (a chain of replacements whose
// first hop is a line), a format by a format (with more identity fields
// too), a group by a group, and a nested node by any class.

import {$createLinkNode, LinkNode} from '@lexical/link';
import {$createListItemNode, $createListNode, ListNode} from '@lexical/list';
import {$createQuoteNode, QuoteNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  TableCellNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type ElementFormatType,
  type Klass,
  type LexicalNode,
  type LexicalWarning,
  nodeSchema,
  ParagraphNode,
  type SerializedParagraphNode,
  stringValue,
  withField,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYBinding, createYDoc, STORAGE_MISMATCH_WARNING} from '../../..';
import {
  createYWriter,
  editYState,
  readYState,
  YHeadlessError,
} from '../../../headless';
import {$selectIn, NODES, Peer, setup} from '../../utils/harness';

/** A quote that holds blocks, as its own (container) type. */
class BlockQuoteNode extends QuoteNode {
  $config() {
    return this.config('blockquote', {children: 'block', extends: QuoteNode});
  }
  isShadowRoot(): boolean {
    return true;
  }
}
/** A quote of the app's own that holds inline content (a line). */
class AppQuoteNode extends QuoteNode {
  $config() {
    return this.config('app-quote', {extends: QuoteNode});
  }
}
/** A stricter AppQuoteNode that holds blocks (a container). */
class AppBlockQuoteNode extends AppQuoteNode {
  $config() {
    return this.config('app-block-quote', {
      children: 'block',
      extends: AppQuoteNode,
    });
  }
  isShadowRoot(): boolean {
    return true;
  }
}
const colorSchema = nodeSchema<ColoredLinkNode>()({
  color: withField(stringValue(), {field: '__color'}),
});
/** A link that merges by one more field (a format, identity changed). */
class ColoredLinkNode extends LinkNode {
  __color = '';
  $config() {
    return this.config('colored-link', {
      extends: LinkNode,
      json: colorSchema,
      mergeAdjacent: {by: ['url', 'target', 'rel', 'title', 'color']},
    });
  }
}
/** A list that merges by its start too (a group, identity changed). */
class StartedListNode extends ListNode {
  $config() {
    return this.config('started-list', {
      extends: ListNode,
      mergeAdjacent: {by: ['listType', 'start']},
    });
  }
}
/**
 * A replacement written the classic way (static getType, clone and
 * importJSON, and a hand-written exportJSON): not schema-complete, so it is
 * stored as a nested node.
 */
class ClassicParagraphNode extends ParagraphNode {
  static getType(): string {
    return 'classic-paragraph';
  }
  static clone(node: ClassicParagraphNode): ClassicParagraphNode {
    return new ClassicParagraphNode(node.__key);
  }
  static importJSON(json: SerializedParagraphNode): ClassicParagraphNode {
    return new ClassicParagraphNode().updateFromJSON(json);
  }
  exportJSON(): SerializedParagraphNode {
    return {...super.exportJSON(), type: 'classic-paragraph'};
  }
}
/** A paragraph of the app's own (a line, as a paragraph is). */
class AppParagraphNode extends ParagraphNode {
  $config() {
    return this.config('app-paragraph', {extends: ParagraphNode});
  }
}
/** A link of the app's own (a format, as a link is). */
class AppLinkNode extends LinkNode {
  $config() {
    return this.config('app-link', {extends: LinkNode});
  }
}
/** A cell whose content is inline (a line class) over stored nested cells. */
class LineCellNode extends TableCellNode {
  $config() {
    return this.config('line-cell', {
      children: 'inline',
      extends: TableCellNode,
    });
  }
}

type Nodes = Klass<LexicalNode>[];
const $p = (text: string) =>
  $createParagraphNode().append($createTextNode(text));
const REPLACED_QUOTE = [
  ...NODES,
  BlockQuoteNode,
  {
    replace: QuoteNode,
    with: () => new BlockQuoteNode(),
    withKlass: BlockQuoteNode,
  },
] as unknown as Nodes;

/** A room written by an editor without the replacement. */
async function storedRoom(init: () => void): Promise<Uint8Array> {
  const t = await setup(init);
  return Y.encodeStateAsUpdate(t.a.doc);
}

/** A client of the app with `nodes`, bound to a copy of `state`. */
async function bindTo(state: Uint8Array, nodes: Nodes): Promise<Peer> {
  const peer = new Peer(
    5,
    {delivery: 'causal', peers: [], pumping: false, queue: []},
    nodes,
  );
  Y.applyUpdate(peer.doc, state, 'load');
  peer.binding.initialize();
  await new Promise(resolve => setTimeout(resolve, 0));
  return peer;
}

const codes = (peer: Peer) =>
  peer.warningEvents.map(e => (e as LexicalWarning).code);

const $quoteRoom = () =>
  $getRoot().append(
    $p('title'),
    $createQuoteNode({shadowRoot: true}).append($p('Lorem ipsum'), $p('dolor')),
    $p('end'),
  );

describe('a replaced type stored another way', () => {
  const READ_ONLY: {
    name: string;
    nodes: Nodes;
    built: string;
  }[] = [
    {
      built: 'blockquote',
      name: 'withKlass, a container class',
      nodes: REPLACED_QUOTE,
    },
    {
      built: 'app-block-quote',
      name: '`with` returning a container subclass of a line withKlass',
      nodes: [
        ...NODES,
        AppQuoteNode,
        AppBlockQuoteNode,
        {
          replace: QuoteNode,
          with: () => new AppBlockQuoteNode(),
          withKlass: AppQuoteNode,
        },
      ] as unknown as Nodes,
    },
    {
      built: 'blockquote',
      name: '`with` alone, returning a container class',
      nodes: [
        ...NODES,
        BlockQuoteNode,
        {replace: QuoteNode, with: () => new BlockQuoteNode()},
      ] as unknown as Nodes,
    },
  ];
  for (const c of READ_ONLY) {
    test(`a quote stored as a line, replaced by ${c.name}: read only, naming the type built`, async () => {
      const state = await storedRoom($quoteRoom);
      const peer = await bindTo(state, c.nodes);
      expect(peer.binding.status).toBe('readonly');
      expect(codes(peer)).toContain(STORAGE_MISMATCH_WARNING);
      expect(
        peer.warningEvents
          .map(e => e as LexicalWarning)
          .find(e => e.code === STORAGE_MISMATCH_WARNING)!.data,
      ).toEqual({
        declared: {kind: 'nested'},
        reason: 'declaration-changed',
        replacement: c.built,
        stored: {kind: 'line'},
        type: 'quote',
      });
      // The content still shows, as the type built.
      expect(peer.describe()).toBe(
        `paragraph("title") / ${c.built}(paragraph("Lorem ipsum") paragraph("dolor")) / paragraph("end")`,
      );
      // An edit writes nothing to the document (it was lost silently before:
      // shown in the editor, never stored).
      const before = Y.encodeStateVector(peer.doc);
      peer.update(() => {
        $selectIn([1, 0], 2).insertText('XY');
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(Y.encodeStateVector(peer.doc)).toEqual(before);
    });
  }

  test('a classic replacement class (stored as a nested node) over paragraphs stored as lines: read only', async () => {
    // On main such a client wrote each line it edited as a nested node: one
    // writer's edits kept, but two clients converting at once wrote the
    // content twice (see D132).
    const state = await storedRoom(() =>
      $getRoot().append($p('Lorem ipsum'), $p('dolor')),
    );
    const peer = await bindTo(state, [
      ...NODES,
      ClassicParagraphNode,
      {
        replace: ParagraphNode,
        with: () => new ClassicParagraphNode(),
        withKlass: ClassicParagraphNode,
      },
    ] as unknown as Nodes);
    expect(peer.binding.status).toBe('readonly');
    expect(
      peer.warningEvents
        .map(e => e as LexicalWarning)
        .find(e => e.code === STORAGE_MISMATCH_WARNING)!.data,
    ).toEqual({
      declared: {kind: 'nested'},
      reason: 'declaration-changed',
      replacement: 'classic-paragraph',
      stored: {kind: 'line'},
      type: 'paragraph',
    });
  });

  test('a quote line a peer writes while the client is active: read only from that read', async () => {
    const t = await setup(() => $getRoot().append($p('title')));
    const peer = await bindTo(Y.encodeStateAsUpdate(t.a.doc), REPLACED_QUOTE);
    expect(peer.binding.status).toBe('active');
    const before = Y.encodeStateVector(t.a.doc);
    t.a.update(() => {
      $getRoot().append(
        $createQuoteNode({shadowRoot: true}).append($p('Lorem ipsum')),
      );
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(t.a.doc, before), 'remote');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(peer.binding.status).toBe('readonly');
    expect(codes(peer)).toContain(STORAGE_MISMATCH_WARNING);
  });

  test('the collab status names the replacement', async () => {
    const state = await storedRoom($quoteRoom);
    const editor = createEditor({
      namespace: 'replaced',
      nodes: REPLACED_QUOTE,
      onError: e => {
        throw e;
      },
      onWarn: () => {},
    });
    const binding = createYBinding(editor, {
      doc: createYDoc(state),
      onStatus: () => {},
      schemaVersion: 1,
      synced: true,
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(binding.status).toEqual({
      cause: {
        code: 'storage-mismatch',
        declared: 'nested',
        replacement: 'blockquote',
        stored: 'line',
        type: 'quote',
      },
      kind: 'readonly',
    });
    binding.dispose();
  });

  test('a chain whose first hop is a line: a write that rewrites the line as the first hop makes a fresh client read only', async () => {
    // The first hop's type is recorded as a line (`k:app-quote`); a fresh
    // client builds app-quote through the second hop, a container. Safe:
    // read only, nothing lost.
    const nodes = [
      ...NODES,
      AppQuoteNode,
      AppBlockQuoteNode,
      {
        replace: QuoteNode,
        with: () => new AppQuoteNode(),
        withKlass: AppQuoteNode,
      },
      {
        replace: AppQuoteNode,
        with: () => new AppBlockQuoteNode(),
        withKlass: AppBlockQuoteNode,
      },
    ] as unknown as Nodes;
    const state = await storedRoom($quoteRoom);
    const peer = await bindTo(state, nodes);
    expect(peer.binding.status).toBe('active');
    peer.update(() => {
      ($getRoot().getChildAtIndex(1) as AppQuoteNode).setFormat(
        'center' as ElementFormatType,
      );
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const fresh = await bindTo(Y.encodeStateAsUpdate(peer.doc), nodes);
    expect(fresh.binding.status).toBe('readonly');
    expect(codes(fresh)).toContain(STORAGE_MISMATCH_WARNING);
  });

  test('editYState and readYState refuse the room, naming the replacement', async () => {
    const state = await storedRoom($quoteRoom);
    const config = {
      nodes: REPLACED_QUOTE,
      schemaVersion: 1,
    };
    expect(() =>
      editYState(
        state,
        config,
        () => {
          $getRoot().append($p('agent'));
        },
        {writer: createYWriter('Writing assistant')},
      ),
    ).toThrow(YHeadlessError);
    expect(() =>
      editYState(state, config, () => {}, {
        writer: createYWriter('Writing assistant'),
      }),
    ).toThrow(/quote is stored as line.*builds its nodes as blockquote/);
    expect(() => readYState(state, config, () => null)).toThrow(YHeadlessError);
  });

  const KEEPS_WRITING: {
    name: string;
    $init: () => void;
    nodes: Nodes;
    path: number[];
    expected: string;
  }[] = [
    {
      $init: () => $getRoot().append($p('title'), $p('Lorem ipsum'), $p('end')),
      expected: 'title\n\nLoXYrem ipsum\n\nend',
      name: 'a line by a line (paragraph by app-paragraph)',
      nodes: [
        ...NODES,
        AppParagraphNode,
        {
          replace: ParagraphNode,
          with: () => new AppParagraphNode(),
          withKlass: AppParagraphNode,
        },
      ] as unknown as Nodes,
      path: [1],
    },
    {
      $init: () =>
        $getRoot().append(
          $p('title'),
          $createParagraphNode().append(
            $createTextNode('see '),
            $createLinkNode('https://a.example').append(
              $createTextNode('Lorem ipsum'),
            ),
          ),
          $p('end'),
        ),
      expected: 'title\n\nsee LoXYrem ipsum\n\nend',
      name: 'a format by a format (link by app-link)',
      nodes: [
        ...NODES,
        AppLinkNode,
        {
          replace: LinkNode,
          with: (node: LinkNode) => new AppLinkNode(node.getURL()),
          withKlass: AppLinkNode,
        },
      ] as unknown as Nodes,
      path: [1, 1],
    },
    {
      $init: () =>
        $getRoot().append(
          $p('title'),
          $createTableNode().append(
            $createTableRowNode().append(
              $createTableCellNode().append($p('Lorem ipsum')),
            ),
          ),
          $p('end'),
        ),
      expected: 'title\n\nLoXYrem ipsum\n\nend',
      name: 'a nested node by a line class (tablecell by line-cell)',
      nodes: [
        ...NODES,
        LineCellNode,
        {
          replace: TableCellNode,
          with: () => new LineCellNode(),
          withKlass: LineCellNode,
        },
      ] as unknown as Nodes,
      path: [1, 0, 0, 0],
    },
  ];
  KEEPS_WRITING.push(
    {
      $init: $quoteRoom,
      expected: 'title\n\nLoXYrem ipsum\n\ndolor\n\nend',
      name: 'a chain whose first hop is a line (quote by app-quote, then app-block-quote), text typed',
      nodes: [
        ...NODES,
        AppQuoteNode,
        AppBlockQuoteNode,
        {
          replace: QuoteNode,
          with: () => new AppQuoteNode(),
          withKlass: AppQuoteNode,
        },
        {
          replace: AppQuoteNode,
          with: () => new AppBlockQuoteNode(),
          withKlass: AppBlockQuoteNode,
        },
      ] as unknown as Nodes,
      path: [1, 0],
    },
    {
      $init: () =>
        $getRoot().append(
          $p('title'),
          $createParagraphNode().append(
            $createTextNode('see '),
            $createLinkNode('https://a.example').append(
              $createTextNode('Lorem ipsum'),
            ),
          ),
          $p('end'),
        ),
      expected: 'title\n\nsee LoXYrem ipsum\n\nend',
      name: 'a format by a format with more identity fields (link by colored-link)',
      nodes: [
        ...NODES,
        ColoredLinkNode,
        {
          replace: LinkNode,
          with: () => new ColoredLinkNode(),
          withKlass: ColoredLinkNode,
        },
      ] as unknown as Nodes,
      path: [1, 1],
    },
    {
      $init: () =>
        $getRoot().append(
          $p('title'),
          $createListNode('number', 2).append(
            $createListItemNode().append($createTextNode('Lorem ipsum')),
          ),
          $p('end'),
        ),
      expected: 'title\n\nLoXYrem ipsum\n\nend',
      name: 'a group by a group with more identity fields (list by started-list)',
      nodes: [
        ...NODES,
        StartedListNode,
        {
          replace: ListNode,
          with: () => new StartedListNode(),
          withKlass: StartedListNode,
        },
      ] as unknown as Nodes,
      path: [1, 0],
    },
  );
  for (const c of KEEPS_WRITING) {
    test(`control, ${c.name}: keeps writing`, async () => {
      const state = await storedRoom(c.$init);
      const peer = await bindTo(state, c.nodes);
      expect(peer.binding.status).toBe('active');
      expect(codes(peer)).not.toContain(STORAGE_MISMATCH_WARNING);
      peer.update(() => {
        $selectIn(c.path, 2).insertText('XY');
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      const stored = readYState(
        Y.encodeStateAsUpdate(peer.doc),
        {
          nodes: c.nodes,
          schemaVersion: 1,
        },
        () => $getRoot().getTextContent(),
      );
      expect(stored).toBe(c.expected);
    });
  }
});
