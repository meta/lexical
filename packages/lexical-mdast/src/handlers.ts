/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  MdastExportContext,
  MdastExportHandler,
  MdastImportContext,
  MdastImportHandler,
  MdastParent,
} from './types';
import type {ListItemNode, ListNode, ListType} from '@lexical/list';
import type {HeadingTagType} from '@lexical/rich-text';
import type {ElementNode, LexicalNode, LineBreakNode} from 'lexical';
import type {
  Blockquote,
  Break,
  Code,
  Delete,
  Emphasis,
  Heading,
  Html,
  InlineCode,
  Link,
  LinkReference,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Strong,
  Text as MdastText,
} from 'mdast';

import {$createCodeNode, $isCodeNode} from '@lexical/code-core';
import {$createLinkNode, $isAutoLinkNode, $isLinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $getTaskListItemChecked,
  $isListItemNode,
  $isListNode,
  $setTaskListItemChecked,
} from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getState,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  $setState,
  INTERNAL_isNodeStructureEnforced,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
} from 'lexical';

import {
  codeFenceState,
  codeMetaState,
  emphasisMarkerState,
  hardLineBreakState,
  linkStyleState,
  listMarkerState,
  orderedMarkerState,
  paragraphBreakState,
  setextState,
  strongMarkerState,
} from './state';

/**
 * Appends `nodes` to `element` via {@link ElementNode.splice} (the primitive
 * `append` delegates to, taking an array directly), returning the element.
 */
export function $append<T extends ElementNode>(
  element: T,
  nodes: LexicalNode[],
): T {
  return element.splice(element.getChildrenSize(), 0, nodes);
}

/**
 * Prepends `nodes` to `element` via {@link ElementNode.splice} (the primitive
 * `append` delegates to, taking an array directly), returning the element.
 */
export function $prepend<T extends ElementNode>(
  element: T,
  nodes: LexicalNode[],
): T {
  return element.splice(0, 0, nodes);
}

/**
 * Whether `node` is a block-level node: a non-inline element *or* a non-inline
 * decorator (e.g. a horizontal rule).
 */
export function $isBlockLevelNode(node: LexicalNode): boolean {
  return ($isElementNode(node) || $isDecoratorNode(node)) && !node.isInline();
}

/**
 * Whether a paragraph boundary is written after `last` (the last node
 * imported into an inline container, a quote or a list item): always after
 * inline content. After a nested block only when the editor does not enforce
 * declared node structure; when it does (`NodeStructureExtension`), the block
 * is lifted out of the container and a break there would be left at the
 * start of the rest as an empty line.
 */
function $breakAfter(last: LexicalNode): boolean {
  return (
    !$isBlockLevelNode(last) || !INTERNAL_isNodeStructureEnforced($getEditor())
  );
}

/** A `LineBreakNode` marking a paragraph boundary inside a container. */
function $createParagraphBreakNode(): LineBreakNode {
  return $setState($createLineBreakNode(), paragraphBreakState, true);
}

/** Reads the first source character of `node` (an inline delimiter, if any). */
export function inlineMarker(
  ctx: MdastImportContext,
  node: {position?: {start: {offset?: number}}},
): string | undefined {
  if (!ctx.source || !node.position || node.position.start.offset == null) {
    return undefined;
  }
  return ctx.source[node.position.start.offset];
}

// The format bit constants rather than `TEXT_TYPE_TO_FORMAT.bold` etc.: a
// module-scope property read is a side effect to bundlers, which would pin
// these (and everything below that uses them) into every bundle.
const FORMAT_BOLD = IS_BOLD;
const FORMAT_ITALIC = IS_ITALIC;
const FORMAT_STRIKETHROUGH = IS_STRIKETHROUGH;
const FORMAT_CODE = IS_CODE;

/**
 * A function declared side-effect free (so the build annotates the call
 * below): a bitwise operation on imported values is a side effect to bundlers
 * (it may invoke `valueOf`), which would pin this module into every bundle.
 *
 * @__NO_SIDE_EFFECTS__
 */
function textFormatMask(): number {
  return FORMAT_BOLD | FORMAT_ITALIC | FORMAT_STRIKETHROUGH | FORMAT_CODE;
}

export const TEXT_FORMAT_MASK = textFormatMask();

/* -------------------------------------------------------------------------- *
 * Import handlers: mdast node -> Lexical node(s)                              *
 * -------------------------------------------------------------------------- */

export const $importParagraph: MdastImportHandler<Paragraph> = (node, ctx) =>
  $append($createParagraphNode(), ctx.importChildren(node));

export const $importHeading: MdastImportHandler<Heading> = (node, ctx) => {
  const heading = $createHeadingNode(`h${node.depth}`);
  // A level 1/2 heading that does not start with a valid ATX marker (`#`..
  // `######` followed by whitespace or end of line) was written in setext
  // style. Checking for the trailing boundary matters: `#foo\n===` is a
  // setext heading whose *content* begins with `#`.
  if (ctx.source && node.position && (node.depth === 1 || node.depth === 2)) {
    const offset = node.position.start.offset;
    if (
      offset != null &&
      !/^ {0,3}#{1,6}([ \t\r\n]|$)/.test(ctx.source.slice(offset, offset + 10))
    ) {
      $setState(heading, setextState, true);
    }
  }
  return $append(heading, ctx.importChildren(node));
};

export const $importBlockquote: MdastImportHandler<Blockquote> = (
  node,
  ctx,
) => {
  const quote = $createQuoteNode();
  const children: LexicalNode[] = [];
  for (const child of node.children) {
    if (child.type === 'paragraph') {
      if (children.length > 0 && $breakAfter(children[children.length - 1])) {
        children.push($createParagraphBreakNode());
      }
      children.push(...ctx.importChildren(child));
    } else {
      // Nested blocks (lists, code, nested quotes) are imported as-is so they
      // are not silently flattened to text.
      children.push(...ctx.importNode(child));
    }
  }
  return $append(quote, children);
};

/**
 * Imports each mdast flow child of `parent` as block-level Lexical nodes,
 * wrapping any stray inline output (e.g. from the `html` fallback) in a
 * paragraph — the same normalization the top-level importer applies.
 */
export function $importBlockChildren(
  parent: MdastParent,
  ctx: MdastImportContext,
): LexicalNode[] {
  const blocks: LexicalNode[] = [];
  let pendingParagraph: ElementNode | null = null;
  const flushPending = () => {
    if (pendingParagraph) {
      blocks.push(pendingParagraph);
      pendingParagraph = null;
    }
  };
  for (const child of parent.children) {
    for (const node of ctx.importNode(child)) {
      if ($isBlockLevelNode(node)) {
        flushPending();
        blocks.push(node);
      } else {
        if (!pendingParagraph) {
          pendingParagraph = $createParagraphNode();
        }
        $append(pendingParagraph, [node]);
      }
    }
  }
  flushPending();
  return blocks;
}

/**
 * Opt-in replacement for {@link $importBlockquote} that imports the quote as a
 * shadow root {@link QuoteNode} holding block-level children, so structured
 * blockquotes (multiple paragraphs, nested lists, code) round-trip without
 * being flattened to inline content. See `MdastShadowRootQuoteExtension`.
 */
export const $importShadowRootBlockquote: MdastImportHandler<Blockquote> = (
  node,
  ctx,
) =>
  $append(
    $createQuoteNode({shadowRoot: true}),
    $importBlockChildren(node, ctx),
  );

/**
 * Maps an mdast `list` node to the Lexical {@link ListType} it represents.
 * GFM decides per item whether it is a task, so only an unordered list whose
 * items are all tasks is a check list. Any other list keeps its kind, and its
 * task items become task list items (see `$setTaskListItemChecked`).
 */
export function $listTypeFromMdast(node: List): ListType {
  if (node.ordered) {
    return 'number';
  }
  return node.children.length > 0 &&
    node.children.every(child => child.checked != null)
    ? 'check'
    : 'bullet';
}

export const $importList: MdastImportHandler<List> = (node, ctx) => {
  const listType = $listTypeFromMdast(node);
  const start = node.ordered && node.start != null ? node.start : 1;
  const list = $createListNode(listType, start);
  // Preserve the literal marker the list used so export can reproduce it.
  // A bounded window is enough: an ordered marker is at most 9 digits plus
  // the delimiter (CommonMark), a bullet is a single character.
  const firstItem = node.children[0];
  const itemOffset =
    ctx.source && firstItem && firstItem.position
      ? firstItem.position.start.offset
      : undefined;
  if (itemOffset != null) {
    const markerWindow = ctx.source.slice(itemOffset, itemOffset + 16);
    if (listType === 'number') {
      const match = markerWindow.match(/^\s*\d+([.)])/);
      const delimiter = match && match[1];
      if (delimiter === '.' || delimiter === ')') {
        $setState(list, orderedMarkerState, delimiter);
      }
    } else {
      const match = markerWindow.match(/^\s*([-*+])/);
      const bullet = match && match[1];
      if (bullet === '-' || bullet === '*' || bullet === '+') {
        $setState(list, listMarkerState, bullet);
      }
    }
  }
  const imported = node.children.map(child => ctx.importNode(child));
  $append(list, imported.flat());
  if (listType !== 'check') {
    // Outside a check list a task item keeps its checkbox as a task list item
    // marker (`checked` only means something in a check list).
    node.children.forEach((child, index) => {
      const item = imported[index][0];
      if (child.checked != null && $isListItemNode(item)) {
        $setTaskListItemChecked(item, child.checked);
      }
    });
  }
  return list;
};

export const $importListItem: MdastImportHandler<ListItem> = (node, ctx) => {
  const item = $createListItemNode(
    typeof node.checked === 'boolean' ? node.checked : undefined,
  );
  const extraItems: ListItemNode[] = [];
  for (const child of node.children) {
    if (child.type === 'list') {
      // A nested list is represented in Lexical as a ListItemNode whose only
      // child is the nested ListNode, appended as a sibling of this item.
      extraItems.push($append($createListItemNode(), ctx.importNode(child)));
    } else if (child.type === 'paragraph') {
      const last = item.getLastChild();
      if (last !== null && $breakAfter(last)) {
        $append(item, [$createParagraphBreakNode()]);
      }
      $append(item, ctx.importChildren(child));
    } else {
      $append(item, ctx.importNode(child));
    }
  }
  return [item, ...extraItems];
};

export const $importCode: MdastImportHandler<Code> = (node, ctx) => {
  const code = $createCodeNode(node.lang || undefined);
  // Preserve the literal fence (e.g. ``` vs ~~~ vs ````) for round-tripping.
  // The fence is on the construct's first line; bound the scan to it.
  if (ctx.source && node.position && node.position.start.offset != null) {
    const offset = node.position.start.offset;
    const lineEnd = ctx.source.indexOf('\n', offset);
    const line = ctx.source.slice(offset, lineEnd === -1 ? undefined : lineEnd);
    const match = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (match) {
      $setState(code, codeFenceState, match[1]);
    }
  }
  // CodeNode only models the language; keep the rest of the info string
  // (` ```js title=x `) as node state so it survives the round-trip.
  if (node.meta) {
    $setState(code, codeMetaState, node.meta);
  }
  if (node.value) {
    $append(code, [$createTextNode(node.value)]);
  }
  return code;
};

export const importText: MdastImportHandler<MdastText> = (node, ctx) =>
  ctx.createText(node.value);

export const importHtml: MdastImportHandler<Html> = (node, ctx) =>
  ctx.createText(node.value);

export const importInlineCode: MdastImportHandler<InlineCode> = (node, ctx) =>
  ctx.createText(node.value, ctx.format | FORMAT_CODE);

/**
 * Builds the emphasis/strong import handler: applies the format bit and
 * records an underscore delimiter (`_em_` / `__b__`) on the resulting text
 * nodes; `*` is the default and isn't stored.
 */
function makeEmphasisImporter(
  format: number,
  markerState: typeof emphasisMarkerState | typeof strongMarkerState,
): MdastImportHandler<Emphasis | Strong> {
  return (node, ctx) => {
    const children = ctx.importChildren(node, format);
    if (inlineMarker(ctx, node) === '_') {
      for (const child of children) {
        if ($isTextNode(child)) {
          $setState(child, markerState, '_');
        }
      }
    }
    return children;
  };
}

export const $importEmphasis: MdastImportHandler<Emphasis | Strong> =
  /* @__PURE__ */ makeEmphasisImporter(FORMAT_ITALIC, emphasisMarkerState);

export const $importStrong: MdastImportHandler<Emphasis | Strong> =
  /* @__PURE__ */ makeEmphasisImporter(FORMAT_BOLD, strongMarkerState);

export const importDelete: MdastImportHandler<Delete> = (node, ctx) =>
  ctx.importChildren(node, FORMAT_STRIKETHROUGH);

export const $importBreak: MdastImportHandler<Break> = (node, ctx) => {
  // An mdast `break` is always a HARD break; preserve whether it was written
  // as `\` or as trailing spaces, defaulting to `\` when the literal cannot
  // be recovered. (Soft breaks are newlines inside text values and stay
  // unmarked, serializing back to a plain newline.)
  let marker = '\\';
  if (ctx.source && node.position) {
    const {start, end} = node.position;
    if (start.offset != null && end.offset != null) {
      const raw = ctx.source.slice(start.offset, end.offset).replace(/\n$/, '');
      if (/^ {2,}$/.test(raw)) {
        marker = raw;
      }
    }
  }
  return [$setState($createLineBreakNode(), hardLineBreakState, marker)];
};

export const $importLink: MdastImportHandler<Link> = (node, ctx) => {
  const link = $append(
    $createLinkNode(node.url, {
      title: node.title == null ? undefined : node.title,
    }),
    ctx.importChildren(node),
  );
  // Preserve the syntax the link was written in (`[text](url)` vs `<url>`
  // vs a bare GFM autolink literal) so it round-trips unchanged.
  if (ctx.source && node.position && node.position.start.offset != null) {
    const first = ctx.source[node.position.start.offset];
    $setState(
      link,
      linkStyleState,
      first === '[' ? 'inline' : first === '<' ? 'autolink' : 'literal',
    );
  }
  return link;
};

/**
 * CommonMark reference links (`[text][id]`, `[id][]`, `[id]`) resolve against
 * the document's definitions. An unresolved reference is literal text per the
 * spec, so it is re-emitted verbatim.
 */
export const $importLinkReference: MdastImportHandler<LinkReference> = (
  node,
  ctx,
) => {
  const definition = ctx.getDefinition(node.identifier);
  if (definition) {
    return $append(
      $createLinkNode(definition.url, {
        title: definition.title == null ? undefined : definition.title,
      }),
      ctx.importChildren(node),
    );
  }
  const {position} = node;
  if (ctx.source && position && position.start.offset != null) {
    return ctx.createText(
      ctx.source.slice(position.start.offset, position.end.offset),
    );
  }
  // Approximate the literal when the source is unavailable.
  return [
    ...ctx.createText('['),
    ...ctx.importChildren(node),
    ...ctx.createText(']'),
  ];
};

/**
 * Definitions (`[id]: url "title"`) are consumed by {@link collectDefinitions}
 * before the walk; the node itself produces no content.
 */
export const importDefinition: MdastImportHandler = () => [];

/* -------------------------------------------------------------------------- *
 * Export handlers: Lexical node -> mdast node(s)                             *
 * -------------------------------------------------------------------------- */

export const exportParagraph: MdastExportHandler = (node, ctx) => {
  if (!$isParagraphNode(node)) {
    return null;
  }
  return {
    children: ctx.exportInline(node),
    type: 'paragraph',
  };
};

const HEADING_DEPTHS: Record<HeadingTagType, Heading['depth']> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

export const $exportHeading: MdastExportHandler = (node, ctx) => {
  if (!$isHeadingNode(node)) {
    return null;
  }
  const heading: Heading = {
    children: ctx.exportInline(node),
    depth: HEADING_DEPTHS[node.getTag()],
    type: 'heading',
  };
  // Only pin the style when it is known; nodes created in the editor defer
  // to the document-level serialization options.
  if ($getState(node, setextState)) {
    heading.data = {mdastSetext: true};
  }
  return heading;
};

export const exportQuote: MdastExportHandler = (node, ctx) => {
  if (!$isQuoteNode(node)) {
    return null;
  }
  // A shadow root quote holds block-level children that dispatch directly;
  // a legacy quote holds inline content that must be reassembled into
  // paragraphs. Branching per node lets both forms coexist in one document.
  // Children of a shadow root quote dispatch through the registry, which
  // erases types; block-level output is the dispatch contract here.
  return {
    children: node.isShadowRoot()
      ? (ctx.exportChildren(node) as Blockquote['children'])
      : ctx.exportBlocks(node),
    type: 'blockquote',
  };
};

export const $exportCode: MdastExportHandler = node => {
  if (!$isCodeNode(node)) {
    return null;
  }
  const code: Code = {
    lang: node.getLanguage() || null,
    type: 'code',
    value: node.getTextContent(),
  };
  // The info-string tail is a first-class mdast field; to-markdown emits it
  // after the language (and forces fenced style).
  const meta = $getState(node, codeMetaState);
  if (meta) {
    code.meta = meta;
  }
  // `data.mdastFence` is read back by the exporter's to-markdown wrapper.
  // Only pin the fence when known; editor-created code blocks defer to the
  // document-level serialization options.
  const fence = $getState(node, codeFenceState);
  if (fence) {
    code.data = {mdastFence: fence};
  }
  return code;
};

export const $exportLink: MdastExportHandler = (node, ctx) => {
  if (!$isLinkNode(node) || $isAutoLinkNode(node)) {
    return null;
  }
  const link: Link = {
    children: ctx.exportInline(node),
    title: node.getTitle() ?? null,
    type: 'link',
    url: node.getURL(),
  };
  // Only pinned when known — editor-created links defer to the default
  // serialization (autolink form when the text is the URL).
  const style = $getState(node, linkStyleState);
  if (style) {
    link.data = {mdastLinkStyle: style};
  }
  return link;
};

function $exportListNode(node: ListNode, ctx: MdastExportContext): List {
  const listType = node.getListType();
  const list: List = {
    children: [],
    ordered: listType === 'number',
    spread: false,
    start: listType === 'number' ? node.getStart() : undefined,
    type: 'list',
  };
  // Preserve the marker the list used; read back by the exporter's
  // to-markdown wrapper. Only pinned when known — editor-created lists defer
  // to the document-level serialization options.
  if (listType === 'number') {
    const marker = $getState(node, orderedMarkerState);
    if (marker) {
      list.data = {mdastBulletOrdered: marker};
    }
  } else {
    const marker = $getState(node, listMarkerState);
    if (marker) {
      list.data = {mdastBullet: marker};
    }
  }
  let previousItem: ListItem | null = null;
  for (const child of node.getChildren()) {
    // Structural iteration bypasses the walk's selection filter, so items a
    // selection export does not reach are skipped here.
    if (!$isListItemNode(child) || !ctx.isIncluded(child)) {
      continue;
    }
    const firstChild = child.getFirstChild();
    // A list item whose sole child is a nested list represents nesting: attach
    // the nested list to the previous item's children.
    if (child.getChildrenSize() === 1 && $isListNode(firstChild)) {
      const nested = $exportListNode(firstChild, ctx);
      if (previousItem) {
        previousItem.children.push(nested);
      } else {
        list.children.push({
          children: [nested],
          spread: false,
          type: 'listItem',
        });
      }
      continue;
    }
    const item: ListItem = {
      // Defined for every item of a check list, and for a task item of a
      // bullet or number list.
      checked: $getTaskListItemChecked(child) ?? null,
      children: ctx.exportBlocks(child),
      spread: false,
      type: 'listItem',
    };
    list.children.push(item);
    previousItem = item;
  }
  // The GFM task list writer only adds a box after a `.` delimiter, so an
  // ordered list with task items is written with `.` to keep its boxes.
  if (list.ordered && list.children.some(item => item.checked != null)) {
    list.data = {mdastBulletOrdered: '.'};
  }
  return list;
}

export const $exportList: MdastExportHandler = (node, ctx) => {
  if (!$isListNode(node)) {
    return null;
  }
  return $exportListNode(node, ctx);
};

/**
 * Wraps a plain string in the mdast phrasing nodes implied by a Lexical text
 * format bitmask (code span innermost, then strong, emphasis, strikethrough:
 * emphasis around strong is how CommonMark reads `***x***`, which
 * mdast-util-to-markdown writes back as `***x***` when both markers are
 * `*`).
 * The emphasis/strong *delimiter* (`*` vs `_`) is a document-level to-markdown
 * option (see the exporter) rather than per-node, because mixing delimiters in
 * one document desyncs to-markdown's character escaping.
 */
export function phrasingFromFormattedText(
  value: string,
  format: number,
): PhrasingContent {
  let content: PhrasingContent =
    format & FORMAT_CODE ? {type: 'inlineCode', value} : {type: 'text', value};
  if (format & FORMAT_BOLD) {
    content = {children: [content], type: 'strong'};
  }
  if (format & FORMAT_ITALIC) {
    content = {children: [content], type: 'emphasis'};
  }
  if (format & FORMAT_STRIKETHROUGH) {
    content = {children: [content], type: 'delete'};
  }
  return content;
}

/** A contiguous stretch of plain text sharing one Lexical format bitmask. */
export interface TextRun {
  format: number;
  value: string;
}

/**
 * Emphasis-family format bits eligible for cross-run grouping, in tie-break
 * order matching the single-run nesting of {@link phrasingFromFormattedText}
 * (emphasis outside strong).
 */
const EMPHASIS_FORMATS: readonly [number, 'strong' | 'emphasis'][] = [
  [FORMAT_ITALIC, 'emphasis'],
  [FORMAT_BOLD, 'strong'],
];

/**
 * Converts a segment of strikethrough-free (or strikethrough-stripped) runs
 * into nested emphasis/strong phrasing. At each position the wrapper is
 * chosen greedily: the format bit shared by the longest stretch of upcoming
 * runs becomes the outer container (ties fall back to emphasis-outside-strong,
 * matching the single-run nesting), and the covered runs recurse with that
 * bit cleared. Overlap is not always fully expressible as nesting — the
 * format that extends furthest keeps a single pair of delimiters and the
 * other side splits.
 */
function phrasingFromEmphasisRuns(runs: readonly TextRun[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (let i = 0; i < runs.length; ) {
    const {format, value} = runs[i];
    let wrapper: 'strong' | 'emphasis' | null = null;
    let wrapperBit = 0;
    let end = i + 1;
    for (const [bit, type] of EMPHASIS_FORMATS) {
      if ((format & bit) === 0) {
        continue;
      }
      let bitEnd = i + 1;
      while (bitEnd < runs.length && runs[bitEnd].format & bit) {
        bitEnd++;
      }
      if (wrapper === null || bitEnd > end) {
        wrapper = type;
        wrapperBit = bit;
        end = bitEnd;
      }
    }
    if (wrapper === null) {
      out.push(
        format & FORMAT_CODE
          ? {type: 'inlineCode', value}
          : {type: 'text', value},
      );
      i++;
    } else {
      out.push({
        children: phrasingFromEmphasisRuns(
          runs
            .slice(i, end)
            .map(run => ({format: run.format & ~wrapperBit, value: run.value})),
        ),
        type: wrapper,
      });
      i = end;
    }
  }
  return out;
}

/**
 * Converts a sequence of text runs into properly *nested* mdast phrasing.
 * Runs whose formats overlap (e.g. `llo` bold, `wor` bold+italic, `ld`
 * italic) must share a container wherever they share a format bit — emitting
 * each run as its own fully-wrapped sibling produces adjacent delimiter runs
 * (`**llo*****wor****ld*`) that CommonMark resolves differently, so the
 * output would not re-parse to the same formatting (issue #4895).
 *
 * Strikethrough segments the sequence first and always wraps outermost (the
 * single-run nesting order): a `~~` delimiter is only reliably flanking next
 * to text, so `delete` must never land *inside* an emphasis/strong group
 * where a `*` marker would abut it (`*ld~~**llo**~~*` does not re-parse).
 * Bold/italic overlap is then grouped greedily within each segment by
 * {@link phrasingFromEmphasisRuns}.
 */
export function phrasingFromTextRuns(
  runs: readonly TextRun[],
): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (let i = 0; i < runs.length; ) {
    const strike = (runs[i].format & FORMAT_STRIKETHROUGH) !== 0;
    let end = i + 1;
    while (
      end < runs.length &&
      ((runs[end].format & FORMAT_STRIKETHROUGH) !== 0) === strike
    ) {
      end++;
    }
    const segment = runs.slice(i, end);
    if (strike) {
      out.push({
        children: phrasingFromEmphasisRuns(
          segment.map(run => ({
            format: run.format & ~FORMAT_STRIKETHROUGH,
            value: run.value,
          })),
        ),
        type: 'delete',
      });
    } else {
      out.push(...phrasingFromEmphasisRuns(segment));
    }
    i = end;
  }
  return out;
}

export const exportText = (node: LexicalNode): PhrasingContent | null => {
  if (!$isTextNode(node)) {
    return null;
  }
  return phrasingFromFormattedText(
    node.getTextContent(),
    node.getFormat() & TEXT_FORMAT_MASK,
  );
};

export const $exportLineBreak = (node: LexicalNode): Break | null =>
  $isLineBreakNode(node)
    ? {
        data: {mdastBreak: $getState(node, hardLineBreakState)},
        type: 'break',
      }
    : null;
