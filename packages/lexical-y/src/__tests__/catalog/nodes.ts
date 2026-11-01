/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The node catalog: one entry per node shape the matrix tests, soak
// generators and fuzz draw from. It is built from the code: every class in
// the playground's node list (and the nodes its extensions register) and
// every LexicalNode subclass exported by `lexical` and the `@lexical/*`
// packages is the `classes` of some shape here, or listed in
// NODE_EXCLUSIONS with a reason (NodeCatalog.test.ts checks both).
//
// Every shape builds one root child (`$block`), inside an update of an
// editor that registers CATALOG_NODES; inline shapes also build the inline
// run alone (`$inline`), for helpers that take a block of text.

import {
  $createCodeHighlightNode,
  $createCodeNode,
  CodeHighlightNode,
  CodeNode,
} from '@lexical/code';
import {
  $createHorizontalRuleNode,
  DecoratorTextNode,
  HorizontalRuleNode,
} from '@lexical/extension';
import {$createHashtagNode, HashtagNode} from '@lexical/hashtag';
import {
  $createAutoLinkNode,
  $createLinkNode,
  AutoLinkNode,
  LinkNode,
} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  ListItemNode,
  ListNode,
  type ListType,
} from '@lexical/list';
import {$createMarkNode, MarkNode} from '@lexical/mark';
import {$createOverflowNode, OverflowNode} from '@lexical/overflow';
import {DecoratorBlockNode} from '@lexical/react/LexicalDecoratorBlockNode';
import {
  $createHeadingNode,
  $createQuoteNode,
  HeadingNode,
  QuoteNode,
} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  TableCellHeaderStates,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $setSlot,
  type Klass,
  type LexicalNode,
  LineBreakNode,
  ParagraphNode,
  TabNode,
  TextNode,
} from 'lexical';

import {
  $createDateTimeNode,
  DateTimeNode,
} from '../../../../lexical-playground/src/nodes/DateTimeNode/DateTimeNode';
import {
  $createEmojiNode,
  EmojiNode,
} from '../../../../lexical-playground/src/nodes/EmojiNode';
import {
  $createEquationNode,
  EquationNode,
} from '../../../../lexical-playground/src/nodes/EquationNode';
import {
  $createExcalidrawNode,
  ExcalidrawNode,
} from '../../../../lexical-playground/src/nodes/ExcalidrawNode';
import {
  $createFigmaNode,
  FigmaNode,
} from '../../../../lexical-playground/src/nodes/FigmaNode';
import {
  $createImageNode,
  ImageNode,
} from '../../../../lexical-playground/src/nodes/ImageNode';
import {
  $createKeywordNode,
  KeywordNode,
} from '../../../../lexical-playground/src/nodes/KeywordNode';
import {
  $createLayoutContainerNode,
  LayoutContainerNode,
} from '../../../../lexical-playground/src/nodes/LayoutContainerNode';
import {
  $createLayoutItemNode,
  LayoutItemNode,
} from '../../../../lexical-playground/src/nodes/LayoutItemNode';
import {
  $createMentionNode,
  MentionNode,
} from '../../../../lexical-playground/src/nodes/MentionNode';
import {
  $createPageBreakNode,
  PageBreakNode,
} from '../../../../lexical-playground/src/nodes/PageBreakNode';
import PlaygroundNodes from '../../../../lexical-playground/src/nodes/PlaygroundNodes';
import {
  $createPollNode,
  PollNode,
} from '../../../../lexical-playground/src/nodes/PollNode';
import {
  $createSlotContainerNode,
  SlotContainerNode,
} from '../../../../lexical-playground/src/nodes/SlotContainerNode';
import {
  $createSpecialTextNode,
  SpecialTextNode,
} from '../../../../lexical-playground/src/nodes/SpecialTextNode';
import {
  $createStickyNode,
  StickyNode,
} from '../../../../lexical-playground/src/nodes/StickyNode';
import {
  $createTweetNode,
  TweetNode,
} from '../../../../lexical-playground/src/nodes/TweetNode';
import {
  $createYouTubeNode,
  YouTubeNode,
} from '../../../../lexical-playground/src/nodes/YouTubeNode';
import {CardNode} from '../../../../lexical-playground/src/plugins/CardExtension/CardNode';
import {
  $createCollapsibleContainerNode,
  CollapsibleContainerNode,
} from '../../../../lexical-playground/src/plugins/CollapsibleExtension/CollapsibleContainerNode';
import {
  $createCollapsibleContentNode,
  CollapsibleContentNode,
} from '../../../../lexical-playground/src/plugins/CollapsibleExtension/CollapsibleContentNode';
import {
  $createCollapsibleTitleNode,
  CollapsibleTitleNode,
} from '../../../../lexical-playground/src/plugins/CollapsibleExtension/CollapsibleTitleNode';
import {PageContentNode} from '../../../../lexical-playground/src/plugins/PagesExtension/PageContentNode';
import {
  $createPageNode,
  PageNode,
} from '../../../../lexical-playground/src/plugins/PagesExtension/PageNode';
import {PullQuoteNode} from '../../../../lexical-playground/src/plugins/PullQuoteExtension/PullQuoteNode';
import {
  $createReviewNode,
  ReviewNode,
} from '../../../../lexical-playground/src/plugins/ReviewExtension/ReviewNode';
import {
  $createRubyNode,
  RubyNode,
} from '../../../../lexical-playground/src/plugins/RubyExtension/RubyNode';
import {
  $createDownstreamAtom,
  $createDownstreamCitation,
  $createDownstreamColumns,
  $createDownstreamComponent,
  $createDownstreamImage,
  DOWNSTREAM_NODES,
  DownstreamAtomNode,
  DownstreamCitationNode,
  DownstreamColumnNode,
  DownstreamColumnsNode,
  DownstreamComponentNode,
  DownstreamComponentSlotNode,
  DownstreamImageNode,
} from './downstream';
import {prng} from './ids';

/**
 * Where a shape sits in a document:
 * - `text`: a TextNode (or subclass) in a paragraph;
 * - `inline-element`: an inline ElementNode around text in a paragraph;
 * - `inline-decorator`: an inline DecoratorNode in a paragraph;
 * - `line-break`: a LineBreakNode in a paragraph;
 * - `block`: a block that holds inline content;
 * - `container`: a block that holds blocks (lists, tables, quotes of blocks,
 *   collapsibles, layouts, pages);
 * - `block-decorator`: a block DecoratorNode;
 * - `slot-host`: a block with named slots (`$setSlot`).
 */
export type ShapeKind =
  | 'text'
  | 'inline-element'
  | 'inline-decorator'
  | 'line-break'
  | 'block'
  | 'container'
  | 'block-decorator'
  | 'slot-host';

export type TextMode = 'normal' | 'token' | 'segmented';

export interface NodeShape {
  /** Unique, `<class or family>/<variant>`. */
  readonly name: string;
  readonly kind: ShapeKind;
  /** The classes this shape builds (what the completeness test counts). */
  readonly classes: readonly Klass<LexicalNode>[];
  /** Where the classes come from. */
  readonly source:
    | 'lexical'
    | '@lexical/*'
    | 'playground'
    | 'downstream stand-in';
  /** For text shapes: the TextNode mode. */
  readonly textMode?: TextMode;
  /** Free-form tags the matrix selects on (see TAGS). */
  readonly tags: readonly Tag[];
  /** One root child holding the shape (inside an update). */
  readonly $block: () => LexicalNode;
  /** For inline shapes: the inline run alone, for a paragraph. */
  readonly $inline?: () => LexicalNode[];
}

export type Tag =
  /** A TextNode subclass, or a mode other than normal. */
  | 'text-variant'
  /** Refuses text inserted at its edges (canInsertTextBefore/After). */
  | 'refuses-edge-text'
  /** Holds named slots. */
  | 'slots'
  /** Has a field Lexical derives (`{derived: true}`), list numbering. */
  | 'derived'
  | 'list'
  | 'table'
  | 'shadow-root'
  /** Fields stored as NodeState. */
  | 'node-state'
  /** Holds a nested editor (a caption). */
  | 'nested-editor'
  /** Without text content. */
  | 'zero-text';

const $p = (...children: LexicalNode[]) =>
  $createParagraphNode().append(...children);
const $t = (text: string) => $createTextNode(text);

function inline(
  name: string,
  kind: 'text' | 'inline-element' | 'inline-decorator' | 'line-break',
  classes: Klass<LexicalNode>[],
  source: NodeShape['source'],
  tags: Tag[],
  $inline: () => LexicalNode[],
  textMode?: TextMode,
): NodeShape {
  return {
    $block: () => $p($t('before '), ...$inline(), $t(' after')),
    $inline,
    classes,
    kind,
    name,
    source,
    tags,
    textMode,
  };
}

function block(
  name: string,
  kind: 'block' | 'container' | 'block-decorator' | 'slot-host',
  classes: Klass<LexicalNode>[],
  source: NodeShape['source'],
  tags: Tag[],
  $block: () => LexicalNode,
): NodeShape {
  return {$block, classes, kind, name, source, tags};
}

/** Three items of `type` from `start`; the second holds a nested list. */
export function $catalogList(
  type: ListType,
  start = 1,
  nested = false,
): ListNode {
  const item = (text: string) =>
    $createListItemNode(
      type === 'check' ? text.length % 2 === 0 : undefined,
    ).append($t(text));
  const list = $createListNode(type, start).append(
    item(`first ${type}`),
    item(`second ${type}`),
    item(`third ${type}`),
  );
  if (nested) {
    list.splice(2, 0, [
      $createListItemNode().append(
        $createListNode(type, 1).append(item('inner one'), item('inner two')),
      ),
    ]);
  }
  return list;
}

function $table(merged: boolean): TableNode {
  const cell = (text: string, header = false, colSpan = 1) =>
    $createTableCellNode(
      header ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS,
      colSpan,
    ).append($p($t(text)));
  const table = $createTableNode();
  if (merged) {
    const span = cell('spans two rows');
    span.setRowSpan(2);
    table.append(
      $createTableRowNode().append(cell('wide header', true, 2), cell('h3')),
      $createTableRowNode().append(span, cell('b'), cell('c')),
      $createTableRowNode().append(
        cell('d'),
        $createTableCellNode().append($catalogList('bullet')),
      ),
    );
  } else {
    table.append(
      $createTableRowNode().append(cell('h1', true), cell('h2', true)),
      $createTableRowNode().append(
        cell('a'),
        $createTableCellNode().append(
          $catalogList('number', 3),
          $p($t('after')),
        ),
      ),
    );
  }
  return table;
}

export const NODE_SHAPES: readonly NodeShape[] = [
  // Text and its modes.
  inline('text/normal', 'text', [TextNode], 'lexical', [], () => [$t('plain')]),
  inline('text/formatted', 'text', [TextNode], 'lexical', [], () => [
    $t('bold').setFormat('bold'),
    $t(' styled').setStyle('color: red'),
    $t(' code').setFormat('code'),
  ]),
  inline(
    'text/token',
    'text',
    [TextNode],
    'lexical',
    ['text-variant'],
    () => [$t('token').setMode('token')],
    'token',
  ),
  inline(
    'text/segmented',
    'text',
    [TextNode],
    'lexical',
    ['text-variant'],
    () => [$t('two segments').setMode('segmented')],
    'segmented',
  ),
  inline(
    'tab/alone',
    'text',
    [TabNode],
    'lexical',
    ['text-variant'],
    () => [$createTabNode()],
    'normal',
  ),
  inline(
    'tab/between-text',
    'text',
    [TabNode],
    'lexical',
    ['text-variant'],
    () => [$t('a'), $createTabNode(), $t('b')],
    'normal',
  ),
  inline(
    'linebreak/between-text',
    'line-break',
    [LineBreakNode],
    'lexical',
    [],
    () => [$t('line one'), $createLineBreakNode(), $t('line two')],
  ),
  inline(
    'hashtag/text',
    'text',
    [HashtagNode],
    '@lexical/*',
    ['text-variant'],
    () => [$createHashtagNode('#tag')],
  ),
  inline(
    'keyword/text',
    'text',
    [KeywordNode],
    'playground',
    ['text-variant'],
    () => [$createKeywordNode('congrats')],
  ),
  inline(
    'mention/segmented',
    'text',
    [MentionNode],
    'playground',
    ['text-variant'],
    () => [$createMentionNode('Ada Lovelace')],
    'segmented',
  ),
  inline(
    'emoji/token',
    'text',
    [EmojiNode],
    'playground',
    ['text-variant'],
    () => [$createEmojiNode('emoji happysmile', '🙂')],
    'token',
  ),
  inline(
    'special-text/text',
    'text',
    [SpecialTextNode],
    'playground',
    ['text-variant'],
    () => [$createSpecialTextNode('[special]')],
  ),
  inline(
    'ruby/token',
    'text',
    [RubyNode],
    'playground',
    ['text-variant'],
    () => [$createRubyNode('漢字', 'かんじ')],
    'token',
  ),
  // Inline elements.
  inline(
    'link/text',
    'inline-element',
    [LinkNode],
    '@lexical/*',
    ['refuses-edge-text'],
    () => [$createLinkNode('https://example.com').append($t('a link'))],
  ),
  inline(
    'autolink/text',
    'inline-element',
    [AutoLinkNode],
    '@lexical/*',
    ['refuses-edge-text'],
    () => [
      $createAutoLinkNode('https://example.org').append(
        $t('https://example.org'),
      ),
    ],
  ),
  inline(
    'mark/text',
    'inline-element',
    [MarkNode],
    '@lexical/*',
    ['refuses-edge-text'],
    () => [$createMarkNode(['comment-1']).append($t('commented'))],
  ),
  inline(
    'mark/overlapping',
    'inline-element',
    [MarkNode],
    '@lexical/*',
    ['refuses-edge-text'],
    () => [
      $createMarkNode(['comment-1', 'comment-2']).append($t('two comments')),
      $createMarkNode(['comment-2']).append($t(' one')),
    ],
  ),
  inline(
    'link/in-mark',
    'inline-element',
    [LinkNode, MarkNode],
    '@lexical/*',
    ['refuses-edge-text'],
    () => [
      $createMarkNode(['comment-3']).append(
        $createLinkNode('https://example.net').append($t('linked comment')),
      ),
    ],
  ),
  inline(
    'overflow/text',
    'inline-element',
    [OverflowNode],
    '@lexical/*',
    [],
    () => [$createOverflowNode().append($t('over the limit'))],
  ),
  // Inline decorators.
  inline(
    'equation/inline',
    'inline-decorator',
    [EquationNode],
    'playground',
    [],
    () => [$createEquationNode('x^2', true)],
  ),
  inline(
    'datetime/decorator-text',
    'inline-decorator',
    [DateTimeNode, DecoratorTextNode],
    'playground',
    [],
    () => [$createDateTimeNode(new Date(Date.UTC(2026, 9, 30, 12)))],
  ),
  inline(
    'downstream/citation',
    'inline-decorator',
    [DownstreamCitationNode],
    'downstream stand-in',
    ['node-state'],
    () => [$createDownstreamCitation('[1]')],
  ),
  inline(
    'downstream/atom',
    'inline-decorator',
    [DownstreamAtomNode],
    'downstream stand-in',
    ['node-state', 'zero-text'],
    () => [$createDownstreamAtom('due-date')],
  ),
  // Blocks of inline content.
  block(
    'paragraph/empty',
    'block',
    [ParagraphNode],
    'lexical',
    ['zero-text'],
    () => $p(),
  ),
  block(
    'paragraph/indented-aligned',
    'block',
    [ParagraphNode],
    'lexical',
    [],
    () => $p($t('indented')).setIndent(2).setFormat('center'),
  ),
  // The element's textFormat/textStyle are derived from its first text when
  // it renders; a headless writer stores them as 0 and ''.
  block(
    'paragraph/formatted-first-text',
    'block',
    [ParagraphNode],
    'lexical',
    [],
    () =>
      $p(
        $t('bold start').setFormat('bold').setStyle('color: red'),
        $t(' plain'),
      ),
  ),
  block(
    'heading/formatted-first-text',
    'block',
    [HeadingNode],
    '@lexical/*',
    [],
    () =>
      $createHeadingNode('h3').append($t('italic heading').setFormat('italic')),
  ),
  block('heading/h2', 'block', [HeadingNode], '@lexical/*', [], () =>
    $createHeadingNode('h2').append($t('Heading')),
  ),
  block('quote/text', 'block', [QuoteNode], '@lexical/*', [], () =>
    $createQuoteNode().append($t('quoted')),
  ),
  block(
    'code/highlighted',
    'block',
    [CodeNode, CodeHighlightNode, TabNode, LineBreakNode],
    '@lexical/*',
    ['text-variant'],
    () =>
      $createCodeNode('javascript').append(
        $createCodeHighlightNode('const', 'keyword'),
        $createCodeHighlightNode(' x = '),
        $createCodeHighlightNode('1', 'number'),
        $createLineBreakNode(),
        $createTabNode(),
        $createCodeHighlightNode('return', 'keyword'),
      ),
  ),
  block('code/plain-text', 'block', [CodeNode], '@lexical/*', [], () =>
    $createCodeNode().append($t('plain code')),
  ),
  // Lists: every type, custom start, nesting.
  ...(['bullet', 'number', 'check'] as const).flatMap(type => [
    block(
      `list/${type}`,
      'container',
      [ListNode, ListItemNode],
      '@lexical/*',
      ['list', 'derived'],
      () => $catalogList(type),
    ),
    block(
      `list/${type}-start-5`,
      'container',
      [ListNode, ListItemNode],
      '@lexical/*',
      ['list', 'derived'],
      () => $catalogList(type, 5),
    ),
    block(
      `list/${type}-nested`,
      'container',
      [ListNode, ListItemNode],
      '@lexical/*',
      ['list', 'derived'],
      () => $catalogList(type, 3, true),
    ),
  ]),
  // Tables.
  block(
    'table/list-in-cell',
    'container',
    [TableNode, TableRowNode, TableCellNode],
    '@lexical/*',
    ['table', 'list', 'derived'],
    () => $table(false),
  ),
  block(
    'table/merged-cells',
    'container',
    [TableNode, TableRowNode, TableCellNode],
    '@lexical/*',
    ['table', 'list', 'derived'],
    () => $table(true),
  ),
  // Containers of blocks.
  block(
    'collapsible/open',
    'container',
    [CollapsibleContainerNode, CollapsibleTitleNode, CollapsibleContentNode],
    'playground',
    ['shadow-root', 'list', 'derived'],
    () =>
      $createCollapsibleContainerNode(true).append(
        $createCollapsibleTitleNode().append($t('Details')),
        $createCollapsibleContentNode().append(
          $p($t('hidden text')),
          $catalogList('number', 2),
        ),
      ),
  ),
  block(
    'layout/two-columns',
    'container',
    [LayoutContainerNode, LayoutItemNode],
    'playground',
    ['shadow-root', 'list', 'derived'],
    () =>
      $createLayoutContainerNode('1fr 1fr').append(
        $createLayoutItemNode().append($p($t('left'))),
        $createLayoutItemNode().append($catalogList('bullet')),
      ),
  ),
  block(
    'page/content',
    'container',
    [PageNode, PageContentNode],
    'playground',
    ['shadow-root'],
    () => {
      const page = $createPageNode();
      (page.getFirstChildOrThrow() as PageContentNode).append(
        $p($t('page text')),
      );
      return page;
    },
  ),
  block(
    'downstream/columns',
    'container',
    [DownstreamColumnsNode, DownstreamColumnNode],
    'downstream stand-in',
    ['shadow-root', 'list', 'derived'],
    () =>
      $createDownstreamColumns([
        [$p($t('column one'))],
        [$catalogList('number', 4), $p($t('column two'))],
      ]),
  ),
  // Named slots.
  block(
    'card/declared-slot',
    'slot-host',
    [CardNode],
    'playground',
    ['slots', 'shadow-root'],
    () => {
      const card = $create(CardNode).append($p($t('card body')));
      $setSlot(card, 'title', $p($t('Card title')));
      return card;
    },
  ),
  block(
    'review/declared-slot',
    'slot-host',
    [ReviewNode],
    'playground',
    ['slots', 'shadow-root'],
    () => $createReviewNode(),
  ),
  block(
    'pullquote/declared-slots',
    'slot-host',
    [PullQuoteNode, SlotContainerNode],
    'playground',
    ['slots', 'shadow-root'],
    () => {
      const host = $create(PullQuoteNode);
      $setSlot(
        host,
        'quote',
        $createSlotContainerNode().append($p($t('quote'))),
      );
      $setSlot(
        host,
        'attribution',
        $createSlotContainerNode().append($p($t('someone'))),
      );
      return host;
    },
  ),
  block(
    'downstream/component-slots',
    'slot-host',
    [DownstreamComponentNode, DownstreamComponentSlotNode],
    'downstream stand-in',
    ['slots', 'shadow-root', 'node-state', 'list', 'derived'],
    () =>
      $createDownstreamComponent('callout', {
        body: [$p($t('in the callout')), $catalogList('number', 7)],
        title: [$p($t('Note'))],
      }),
  ),
  // Block decorators.
  block(
    'horizontal-rule/block',
    'block-decorator',
    [HorizontalRuleNode],
    '@lexical/*',
    ['zero-text'],
    () => $createHorizontalRuleNode(),
  ),
  block(
    'page-break/block',
    'block-decorator',
    [PageBreakNode],
    'playground',
    ['zero-text'],
    () => $createPageBreakNode(),
  ),
  block(
    'equation/block',
    'block-decorator',
    [EquationNode],
    'playground',
    [],
    () => $createEquationNode('e = mc^2', false),
  ),
  block(
    'image/caption-editor',
    'block-decorator',
    [ImageNode],
    'playground',
    ['nested-editor'],
    () =>
      $createImageNode({
        altText: 'alt',
        height: 100,
        src: 'https://example.com/a.png',
        width: 200,
      }),
  ),
  block(
    'sticky/nested-editor',
    'block-decorator',
    [StickyNode],
    'playground',
    ['nested-editor'],
    () => $createStickyNode(10, 20),
  ),
  block('poll/options', 'block-decorator', [PollNode], 'playground', [], () =>
    $createPollNode('Lunch?', [
      {text: 'Yes', uid: 'catalog-yes', votes: []},
      {text: 'No', uid: 'catalog-no', votes: ['someone']},
    ]),
  ),
  block(
    'excalidraw/data',
    'block-decorator',
    [ExcalidrawNode],
    'playground',
    [],
    () => $createExcalidrawNode('[]'),
  ),
  block(
    'decorator-block/tweet',
    'block-decorator',
    [TweetNode, DecoratorBlockNode],
    'playground',
    [],
    () => $createTweetNode('1234567890'),
  ),
  block(
    'decorator-block/youtube',
    'block-decorator',
    [YouTubeNode, DecoratorBlockNode],
    'playground',
    [],
    () => $createYouTubeNode('dQw4w9WgXcQ').setFormat('center'),
  ),
  block(
    'decorator-block/figma',
    'block-decorator',
    [FigmaNode, DecoratorBlockNode],
    'playground',
    [],
    () => $createFigmaNode('figma-doc'),
  ),
  block(
    'downstream/image',
    'block-decorator',
    [DownstreamImageNode],
    'downstream stand-in',
    ['node-state', 'zero-text'],
    () => $createDownstreamImage('https://example.com/b.png', 'a picture'),
  ),
];

/**
 * Every class an editor needs to build every shape: the playground's list,
 * the nodes its extensions register, and the stand-ins.
 */
export const CATALOG_NODES: readonly Klass<LexicalNode>[] = Array.from(
  new Set<Klass<LexicalNode>>([
    ...PlaygroundNodes,
    RubyNode,
    PageNode,
    PageContentNode,
    ...DOWNSTREAM_NODES,
  ]),
);

/**
 * Node classes the catalog does not build, each with the reason. The
 * completeness test fails for a class that is neither here nor in a shape.
 */
export const NODE_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  ['RootNode', 'the root: every document has exactly one'],
  ['ElementNode', 'abstract base class: its subclasses are the shapes'],
  ['DecoratorNode', 'abstract base class: its subclasses are the shapes'],
  [
    'ArtificialNode__DO_NOT_USE',
    'internal to the DOM import of lexical; never in an editor state',
  ],
  [
    'HorizontalRuleNode@react',
    "the deprecated @lexical/react subclass of @lexical/extension's HorizontalRuleNode with the same type; an editor registers one of the two",
  ],
]);

/** The shapes whose tags include every tag of `tags`. */
export function shapesWith(...tags: Tag[]): NodeShape[] {
  return NODE_SHAPES.filter(s => tags.every(tag => s.tags.includes(tag)));
}

/** The shape named `name` (throws for an unknown name). */
export function shape(name: string): NodeShape {
  const found = NODE_SHAPES.find(s => s.name === name);
  if (found === undefined) {
    throw new Error(`catalog: no node shape named ${name}`);
  }
  return found;
}

/** Appends every shape's block to the root, in order. */
export function $appendShapes(shapes: readonly NodeShape[]): void {
  $getRoot().append(...shapes.map(s => s.$block()));
}

/**
 * Documents that, together, hold every shape at least once, each of `size`
 * shapes, deterministic for `seed`: every shape appears in the first
 * ceil(shapes / size) documents, the rest are random draws.
 */
export function shapeDocs(
  count: number,
  size: number,
  seed: number,
  shapes: readonly NodeShape[] = NODE_SHAPES,
): NodeShape[][] {
  const rand = prng(seed);
  const order = [...shapes];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const docs: NodeShape[][] = [];
  for (let i = 0; i < order.length; i += size) {
    docs.push(order.slice(i, i + size));
  }
  while (docs.length < count) {
    docs.push(
      Array.from(
        {length: size},
        () => shapes[Math.floor(rand() * shapes.length)],
      ),
    );
  }
  return docs;
}
