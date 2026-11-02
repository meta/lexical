/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$isAutoLinkNode, $isLinkNode} from '@lexical/link';
import {$sliceSelectedTextNodeContent} from '@lexical/selection';
import {
  $getRoot,
  $getState,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  type BaseSelection,
  type ElementNode,
  type LexicalNode,
  type LineBreakNode,
  type NodeKey,
  type TextFormatType,
  type TextNode,
} from 'lexical';

import {
  type ElementTransformer,
  getCodeSpanDelimiter,
  hardLineBreakState,
  type MultilineElementTransformer,
  type TextFormatTransformer,
  type TextMatchTransformer,
  type Transformer,
} from './MarkdownTransformers';
import {isEmptyParagraph, PUNCTUATION, transformersByType} from './utils';

/**
 * Renders string from markdown. The selection is moved to the start after the operation.
 */
export function createMarkdownExport(
  transformers: Transformer[],
  shouldPreserveNewLines: boolean = false,
): (node?: ElementNode) => string {
  const byType = transformersByType(transformers);
  const elementTransformers = [...byType.multilineElement, ...byType.element];
  const isNewlineDelimited = !shouldPreserveNewLines;

  // Export only uses text formats that are responsible for single format
  // e.g. it will filter out *** (bold, italic) and instead use separate ** and *
  const textFormatTransformers = byType.textFormat
    .filter(transformer => transformer.format.length === 1)
    // Make sure all text transformers that contain 'code' in their format are at the end of the array. Otherwise, formatted code like
    // <strong><code>code</code></strong> will be exported as `**Bold Code**`, as the code format will be applied first, and the bold format
    // will be applied second and thus skipped entirely, as the code format will prevent any further formatting.
    .sort((a, b) => {
      return (
        Number(a.format.includes('code')) - Number(b.format.includes('code'))
      );
    });

  return node =>
    withBracketContext(byType.textMatch, () => {
      const output = [];
      const children = (node || $getRoot()).getChildren();

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const result = $exportTopLevelElements(
          child,
          elementTransformers,
          textFormatTransformers,
          byType.textMatch,
          shouldPreserveNewLines,
        );

        if (result != null) {
          output.push(
            // separate consecutive group of texts with a line break: eg. ["hello", "world"] -> ["hello", "/nworld"]
            isNewlineDelimited &&
              i > 0 &&
              !isEmptyParagraph(child) &&
              !isEmptyParagraph(children[i - 1])
              ? '\n'.concat(result)
              : result,
          );
        }
      }
      // Ensure consecutive groups of texts are at least \n\n apart while each empty paragraph render as a newline.
      // Eg. ["hello", "", "", "hi", "\nworld"] -> "hello\n\n\nhi\n\nworld"
      return output.join('\n');
    });
}

/**
 * Creates a markdown export function that only exports selected content.
 * Uses a recursive structure similar to $appendNodesToHTML to support
 * extractWithChild for proper handling of partial selections within
 * inline elements like links.
 */
export function createSelectionMarkdownExport(
  transformers: Transformer[],
  shouldPreserveNewLines: boolean = false,
): (selection: BaseSelection) => string {
  const byType = transformersByType(transformers);
  const elementTransformers = [...byType.multilineElement, ...byType.element];
  const isNewlineDelimited = !shouldPreserveNewLines;

  const textFormatTransformers = byType.textFormat
    .filter(transformer => transformer.format.length === 1)
    .sort((a, b) => {
      return (
        Number(a.format.includes('code')) - Number(b.format.includes('code'))
      );
    });

  return exportedSelection =>
    withBracketContext(byType.textMatch, () => {
      // Every node asks whether it is selected, which reads the selection's
      // nodes. A read-only selection doesn't cache them, so this works on a
      // copy that does, instead of recomputing them for every node.
      // Its direction is cached too, since slicing a node asks for it.
      const nodes = exportedSelection.getNodes();
      const selection = exportedSelection.clone();
      selection.setCachedNodes(nodes);
      if ($isRangeSelection(selection)) {
        selection._cachedIsBackward = exportedSelection.isBackward();
      }
      const output = [];
      // The separator depends on the previously *emitted* block, not on the
      // previous root child: unselected children produce no output, so keying
      // off the child index would prefix a newline to the first emitted block
      // whenever the selection starts below the top of the document.
      let previousExported: LexicalNode | null = null;

      for (const child of $getRoot().getChildren()) {
        const {shouldInclude, markdown} = $processNodeForSelection(
          child,
          selection,
          elementTransformers,
          textFormatTransformers,
          byType.textMatch,
          shouldPreserveNewLines,
        );

        if (shouldInclude && markdown != null) {
          output.push(
            isNewlineDelimited &&
              previousExported !== null &&
              !isEmptyParagraph(child) &&
              !isEmptyParagraph(previousExported)
              ? '\n'.concat(markdown)
              : markdown,
          );
          previousExported = child;
        }
      }
      return output.join('\n');
    });
}

function $processNodeForSelection(
  node: LexicalNode,
  selection: BaseSelection,
  elementTransformers: (ElementTransformer | MultilineElementTransformer)[],
  textFormatTransformers: TextFormatTransformer[],
  textMatchTransformers: TextMatchTransformer[],
  shouldPreserveNewLines: boolean,
): {shouldInclude: boolean; markdown: string | null} {
  let shouldInclude = node.isSelected(selection);

  // For element transformers (heading, quote, list, code block, etc.)
  for (const transformer of elementTransformers) {
    if (!transformer.export) {
      continue;
    }
    const result = transformer.export(
      node,
      node_ =>
        $exportChildrenForSelection(
          node_,
          selection,
          textFormatTransformers,
          textMatchTransformers,
          shouldPreserveNewLines,
        ).markdown,
      selection,
    );

    if (result != null) {
      if (!shouldInclude) {
        // Check if any descendant is selected
        if ($isElementNode(node)) {
          const childResult = $exportChildrenForSelection(
            node,
            selection,
            textFormatTransformers,
            textMatchTransformers,
            shouldPreserveNewLines,
          );
          if (childResult.shouldInclude) {
            shouldInclude = true;
          }
        }
      }
      return {markdown: result, shouldInclude};
    }
  }

  if ($isElementNode(node)) {
    const childResult = $exportChildrenForSelection(
      node,
      selection,
      textFormatTransformers,
      textMatchTransformers,
      shouldPreserveNewLines,
    );
    return {
      markdown: childResult.markdown,
      shouldInclude: shouldInclude || childResult.shouldInclude,
    };
  } else if ($isDecoratorNode(node)) {
    return {markdown: node.getTextContent(), shouldInclude};
  } else {
    return {markdown: null, shouldInclude};
  }
}

interface OpenTag {
  format: TextFormatType;
  tag: string;
  /** `$continuesTag`'s answers so far, by node key. */
  answers: Map<NodeKey, boolean>;
}

function $exportChildrenForSelection(
  node: ElementNode,
  selection: BaseSelection,
  textFormatTransformers: TextFormatTransformer[],
  textMatchTransformers: TextMatchTransformer[],
  shouldPreserveNewLines: boolean,
  unclosedTags?: OpenTag[],
  unclosableTags?: OpenTag[],
): {shouldInclude: boolean; markdown: string} {
  const {pieces, shouldInclude} = $exportChildPiecesForSelection(
    node,
    selection,
    textFormatTransformers,
    textMatchTransformers,
    shouldPreserveNewLines,
    unclosedTags,
    unclosableTags,
  );
  return {
    markdown: joinPieces(keepTagRunsFlanking(pieces)),
    shouldInclude,
  };
}

/** The selected inline Markdown of `node`'s children, as pieces. */
function $exportChildPiecesForSelection(
  node: ElementNode,
  selection: BaseSelection,
  textFormatTransformers: TextFormatTransformer[],
  textMatchTransformers: TextMatchTransformer[],
  shouldPreserveNewLines: boolean,
  unclosedTags?: OpenTag[],
  unclosableTags?: OpenTag[],
): {shouldInclude: boolean; pieces: Piece[]} {
  const output: Piece[] = [];
  const children = node.getChildren();
  let anyChildIncluded = false;

  if (!unclosedTags) {
    unclosedTags = [];
  }
  if (!unclosableTags) {
    unclosableTags = [];
  }

  mainLoop: for (const child of children) {
    let childIncluded = child.isSelected(selection);

    // Try text match transformers (links, etc.)
    for (const transformer of textMatchTransformers) {
      if (!transformer.export) {
        continue;
      }

      const result = transformer.export(
        child,
        parentNode =>
          $exportChildrenForSelection(
            parentNode,
            selection,
            textFormatTransformers,
            textMatchTransformers,
            shouldPreserveNewLines,
            unclosedTags,
            [...unclosableTags, ...unclosedTags],
          ).markdown,
        textNode =>
          $exportTextFormat(
            textNode,
            $exportedText(textNode, selection),
            textFormatTransformers,
            unclosedTags,
            unclosableTags,
            shouldPreserveNewLines,
            selection,
          ),
      );

      if (result != null) {
        // Check extractWithChild if this node wasn't directly selected
        if (
          !childIncluded &&
          $isElementNode(child) &&
          child.getChildren().some(c => c.isSelected(selection)) &&
          child.extractWithChild(child, selection, 'html')
        ) {
          childIncluded = true;
        }
        if (childIncluded) {
          output.push(other(result));
          anyChildIncluded = true;
        }
        continue mainLoop;
      }
    }

    if ($isLineBreakNode(child)) {
      if (childIncluded) {
        output.push(other($exportLineBreak(child)));
        anyChildIncluded = true;
      }
    } else if ($isTextNode(child)) {
      if (childIncluded) {
        output.push(
          ...$exportTextPieces(
            child,
            $exportedText(child, selection),
            textFormatTransformers,
            unclosedTags,
            unclosableTags,
            shouldPreserveNewLines,
            selection,
          ),
        );
        anyChildIncluded = true;
      }
    } else if ($isElementNode(child)) {
      const childResult = $exportChildPiecesForSelection(
        child,
        selection,
        textFormatTransformers,
        textMatchTransformers,
        shouldPreserveNewLines,
        unclosedTags,
        unclosableTags,
      );

      // extractWithChild: if child has selected descendants, ask parent if it should be included
      if (
        !childIncluded &&
        childResult.shouldInclude &&
        child.extractWithChild(child, selection, 'html')
      ) {
        childIncluded = true;
      }

      if (childIncluded || childResult.shouldInclude) {
        output.push(...childResult.pieces);
        anyChildIncluded = true;
      }
    } else if ($isDecoratorNode(child)) {
      if (childIncluded) {
        output.push(other(child.getTextContent()));
        anyChildIncluded = true;
      }
    }
  }

  return {pieces: output, shouldInclude: anyChildIncluded};
}

function $exportTopLevelElements(
  node: LexicalNode,
  elementTransformers: (ElementTransformer | MultilineElementTransformer)[],
  textTransformersIndex: TextFormatTransformer[],
  textMatchTransformers: TextMatchTransformer[],
  shouldPreserveNewLines: boolean,
): string | null {
  for (const transformer of elementTransformers) {
    if (!transformer.export) {
      continue;
    }
    const result = transformer.export(node, _node =>
      $exportChildren(
        _node,
        textTransformersIndex,
        textMatchTransformers,
        undefined,
        undefined,
        shouldPreserveNewLines,
      ),
    );

    if (result != null) {
      return result;
    }
  }

  if ($isElementNode(node)) {
    return $exportChildren(
      node,
      textTransformersIndex,
      textMatchTransformers,
      undefined,
      undefined,
      shouldPreserveNewLines,
    );
  } else if ($isDecoratorNode(node)) {
    return node.getTextContent();
  } else {
    return null;
  }
}

function $exportChildren(
  node: ElementNode,
  textTransformersIndex: TextFormatTransformer[],
  textMatchTransformers: TextMatchTransformer[],
  unclosedTags?: OpenTag[],
  unclosableTags?: OpenTag[],
  shouldPreserveNewLines: boolean = false,
): string {
  return joinPieces(
    keepTagRunsFlanking(
      $exportChildPieces(
        node,
        textTransformersIndex,
        textMatchTransformers,
        unclosedTags,
        unclosableTags,
        shouldPreserveNewLines,
      ),
    ),
  );
}

/** The inline Markdown of `node`'s children, as pieces (see Piece). */
function $exportChildPieces(
  node: ElementNode,
  textTransformersIndex: TextFormatTransformer[],
  textMatchTransformers: TextMatchTransformer[],
  unclosedTags?: OpenTag[],
  unclosableTags?: OpenTag[],
  shouldPreserveNewLines: boolean = false,
): Piece[] {
  const output: Piece[] = [];
  const children = node.getChildren();
  // keep track of unclosed tags from the very beginning
  if (!unclosedTags) {
    unclosedTags = [];
  }
  if (!unclosableTags) {
    unclosableTags = [];
  }

  mainLoop: for (const child of children) {
    for (const transformer of textMatchTransformers) {
      if (!transformer.export) {
        continue;
      }

      const result = transformer.export(
        child,
        parentNode =>
          $exportChildren(
            parentNode,
            textTransformersIndex,
            textMatchTransformers,
            unclosedTags,
            // Add current unclosed tags to the list of unclosable tags - we don't want nested tags from
            // textmatch transformers to close the outer ones, as that may result in invalid markdown.
            // E.g. **text [text**](https://lexical.io)
            // is invalid markdown, as the closing ** is inside the link.
            //
            [...unclosableTags, ...unclosedTags],
            shouldPreserveNewLines,
          ),
        (textNode, textContent) =>
          $exportTextFormat(
            textNode,
            textContent,
            textTransformersIndex,
            unclosedTags,
            unclosableTags,
            shouldPreserveNewLines,
            null,
          ),
      );

      if (result != null) {
        output.push(other(result));
        continue mainLoop;
      }
    }

    if ($isLineBreakNode(child)) {
      output.push(other($exportLineBreak(child)));
    } else if ($isTextNode(child)) {
      output.push(
        ...$exportTextPieces(
          child,
          child.getTextContent(),
          textTransformersIndex,
          unclosedTags,
          unclosableTags,
          shouldPreserveNewLines,
          null,
        ),
      );
    } else if ($isElementNode(child)) {
      // empty paragraph returns ""
      output.push(
        ...$exportChildPieces(
          child,
          textTransformersIndex,
          textMatchTransformers,
          unclosedTags,
          unclosableTags,
          shouldPreserveNewLines,
        ),
      );
    } else if ($isDecoratorNode(child)) {
      output.push(other(child.getTextContent()));
    }
  }

  return output;
}

function $exportLineBreak(node: LineBreakNode): string {
  return $getState(node, hardLineBreakState) + '\n';
}

function $exportTextFormat(
  node: TextNode,
  textContent: string,
  textTransformers: TextFormatTransformer[],
  unclosedTags: OpenTag[],
  unclosableTags: OpenTag[],
  shouldPreserveNewLines: boolean,
  selection: BaseSelection | null,
): string {
  return joinPieces(
    $exportTextPieces(
      node,
      textContent,
      textTransformers,
      unclosedTags,
      unclosableTags,
      shouldPreserveNewLines,
      selection,
    ),
  );
}

function $exportTextPieces(
  node: TextNode,
  textContent: string,
  textTransformers: TextFormatTransformer[],
  // unclosed tags include the markdown tags that haven't been closed yet, and their associated formats
  unclosedTags: OpenTag[],
  unclosableTags: OpenTag[],
  shouldPreserveNewLines: boolean,
  // the selection being exported, which ends the text a tag can extend over
  selection: BaseSelection | null,
): Piece[] {
  // This function handles the case of a string looking like this: "   foo   "
  // Where it would be invalid markdown to generate: "**   foo   **"
  // so the tags go inside the whitespace instead: "   **foo**   ".

  const isCode = node.hasFormat('code');

  let output = textContent;
  if (!isCode) {
    // Preserve literal backslashes when preserving source newlines.
    // Default mode guards numeric references; named references keep legacy output.
    // Numeric escapes avoid changing emphasis flanking beside formatting.
    // Guard ambiguous '<' and '&' at node ends for constructs split across nodes.
    if (shouldPreserveNewLines) {
      output = output.replace(/([*_`~])/g, '\\$1');
    } else {
      output = $escapeLiteralBrackets(
        node,
        output.replace(/([*_`~\\]|<(?=\S|$)|&(?=#|$))/g, character =>
          /[*_`~\\]/.test(character)
            ? `\\${character}`
            : `&#${character.charCodeAt(0)};`,
        ),
        selection,
      );
    }
  }

  const holdsTag = canHoldTag(textContent);

  // the opening tags to be added to the result
  const openingTags: string[] = [];
  // the closing tags to be added to the result
  const closingTagsBefore: string[] = [];
  const closingTagsAfter: string[] = [];

  const prevNode = getTextSibling(node, true);

  const applied = new Set();

  for (const transformer of textTransformers) {
    const format = transformer.format[0];
    const tag = transformer.tag;

    // Inline code uses a content-derived fence handled below, not a static tag.
    if (format === 'code') {
      continue;
    }

    // dedup applied formats
    if (holdsTag && node.hasFormat(format) && !applied.has(format)) {
      applied.add(format);

      // append the tag to openingTags, if it's not applied to the previous nodes,
      // or the nodes before that (which would result in an unclosed tag).
      // A whitespace-only previous node with the format keeps the tag open
      // without emitting it, so it counts as applied here.
      if (
        !hasFormat(prevNode, format) ||
        !unclosedTags.find(element => element.tag === tag)
      ) {
        unclosedTags.push({answers: new Map(), format, tag});
        openingTags.push(tag);
      }
    }
  }

  // close any tags in the same order they were applied, if necessary
  for (let i = 0; i < unclosedTags.length; i++) {
    const nodeHasFormat = hasFormat(node, unclosedTags[i].format);
    // prevent adding closing tag if later text with the format will do it
    if (nodeHasFormat && $continuesTag(node, unclosedTags[i], selection)) {
      continue;
    }

    const unhandledUnclosedTags = [...unclosedTags]; // Shallow copy to avoid modifying the original array

    while (unhandledUnclosedTags.length > i) {
      const unclosedTag = unhandledUnclosedTags.pop();

      // If tag is unclosable, don't close it and leave it in the original array,
      // So that it can be closed when it's no longer unclosable
      if (
        unclosedTag &&
        unclosableTags.find(element => element.tag === unclosedTag.tag)
      ) {
        continue;
      }

      if (unclosedTag && typeof unclosedTag.tag === 'string') {
        if (!nodeHasFormat) {
          // Handles cases where the tag has not been closed before, e.g. if the previous node
          // was a text match transformer that did not account for closing tags of the next node (e.g. a link)
          closingTagsBefore.push(unclosedTag.tag);
        } else {
          closingTagsAfter.push(unclosedTag.tag);
        }
      }
      // Mutate the original array to remove the closed tag
      unclosedTags.pop();
    }
    break;
  }
  const closing = (tags: string[]): Piece[] =>
    tags.map(text => ({kind: 'tag', opens: false, text}));
  if (isCode && textContent !== '') {
    // Inline code is an atomic literal span with a content-derived fence, so
    // its whitespace stays inside the fence and other formats wrap around it.
    const {fence, padded} = getCodeSpanDelimiter(textContent);
    output = fence + padded + fence;
  } else if (!holdsTag) {
    // If the node is entirely whitespace, we don't apply opening/closing tags
    // around it, but it must still output any closing tags.
    return [
      ...closing(closingTagsBefore),
      ...closing(closingTagsAfter),
      other(output),
    ];
  }

  // Flanking Compliance: CommonMark flanking rules require formatting tags to be
  // adjacent to non-whitespace characters, so openingTags and closingTagsAfter
  // are placed INSIDE the whitespace boundaries!
  // (Trimming rather than a regex keeps this linear in long whitespace runs.)
  const trimmedStart = output.trimStart();
  const trimmedOutput = trimmedStart.trimEnd();
  const leadingSpace = output.slice(0, output.length - trimmedStart.length);
  const trailingSpace = trimmedStart.slice(trimmedOutput.length);
  return [
    ...closing(closingTagsBefore),
    other(leadingSpace),
    ...openingTags.map((text): Piece => ({kind: 'tag', opens: true, text})),
    ...(isCode ? [other(trimmedOutput)] : textPieces(trimmedOutput)),
    ...closing(closingTagsAfter),
    other(trailingSpace),
  ];
}

/**
 * Escape only the literal brackets that would otherwise turn into Markdown
 * syntax, and leave every other bracket as typed, so `[1]` citations and
 * `array[0]` keep their exported text.
 *
 * Outside a link a bracket matters in three places, and escaping the `]` is
 * enough in each:
 *
 * - a `]` followed by `(` closes the text of an inline link or image
 *   (https://spec.commonmark.org/0.31.2/#inline-link);
 * - a `]` followed by `:` closes the label of a link reference definition
 *   when its `[` starts a line after at most three spaces, with no bracket in
 *   between (https://spec.commonmark.org/0.31.2/#link-reference-definitions);
 * - `[ ]`, `[x]` or `[]` at the start of a line, followed by whitespace, is
 *   read back as a check list item by `CHECK_LIST`, and as a task list item
 *   by GFM.
 *
 * Inside a link's text, brackets are allowed only as matched pairs
 * (https://spec.commonmark.org/0.31.2/#link-text), and a pair followed by `(`
 * would read as a nested link. Those brackets, and unmatched ones, are
 * escaped; other matched pairs stay as typed.
 *
 * The characters around this node come from the exported text next to it in
 * the same block, read through inline elements other than links, so a
 * construct split across text nodes or around a comment mark is still caught.
 * Where that text is unknown (a decorator) the bracket is escaped.
 */
function $escapeLiteralBrackets(
  node: TextNode,
  text: string,
  selection: BaseSelection | null,
): string {
  if (!/[[\]]/.test(text)) {
    return text;
  }
  const isInLink = $isInsideLink(node);
  const escaped = isInLink
    ? linkTextBracketsToEscape(text, $nextExportedChar(node, selection))
    : $literalBracketsToEscape(
        $lineStateBefore(node, selection),
        text,
        $nextExportedChar(node, selection),
        budget => $labelClosesInCodeAfter(node, selection, budget),
      );
  if (escaped.size === 0) {
    return text;
  }
  let output = '';
  for (let index = 0; index < text.length; index++) {
    output += escaped.has(index) ? `&#${text.charCodeAt(index)};` : text[index];
  }
  return output;
}

/** Stands for exported text that cannot be part of a label: a link. */
const BARRIER = '\u0001';
/**
 * Stands for exported text this pass cannot see: a decorator, or a node a
 * text match transformer writes in its own syntax.
 */
const UNKNOWN = '\u0002';
/**
 * How far a label's `]` can be from its `[`: 999 characters of label
 * (https://spec.commonmark.org/0.31.2/#link-label) and the `[` itself.
 */
const MAX_LABEL_DISTANCE = 1000;

/** Typed text that matches a sentinel is read as an ordinary character. */
function asLiteral(text: string): string {
  return text.includes(BARRIER) || text.includes(UNKNOWN)
    ? text.split(BARRIER).join('\uFFFD').split(UNKNOWN).join('\uFFFD')
    : text;
}

/**
 * Where a line of exported text stands so far: only whitespace and the
 * markers a block container can start with (`>`, `-`, `*`, `+`, `1.`, `1)`),
 * each followed by whitespace, in the middle of such a marker, or past them.
 * A `[` that comes while the line is still at its start may begin a link
 * reference definition or a task marker, here or inside the container the
 * markers would open.
 */
type LinePhase = 'start' | 'bullet' | 'digits' | 'text';

/**
 * What the exported text so far in a block says about the next character:
 * the phase of its line, and how far back the nearest `[`, link or unknown
 * text is, with the character after it and whether it came at a line start.
 */
interface LineState {
  phase: LinePhase;
  /** -1 when there is none within MAX_LABEL_DISTANCE. */
  openerDistance: number;
  openerChar: string;
  openerNext: string;
  openerAtLineStart: boolean;
}

const BLOCK_START: LineState = {
  openerAtLineStart: false,
  openerChar: '',
  openerDistance: -1,
  openerNext: '',
  phase: 'start',
};

function nextLinePhase(phase: LinePhase, character: string): LinePhase {
  if (character === UNKNOWN) {
    // Unknown text may end with a line break, so what follows may start a line.
    return 'start';
  }
  // `CHECK_LIST` and the list transformers accept any `\s` as indentation.
  const isSpace = /\s/.test(character);
  switch (phase) {
    case 'start':
      return isSpace || character === '>'
        ? 'start'
        : character === '-' || character === '*' || character === '+'
          ? 'bullet'
          : character >= '0' && character <= '9'
            ? 'digits'
            : 'text';
    case 'bullet':
      return isSpace ? 'start' : 'text';
    case 'digits':
      return character >= '0' && character <= '9'
        ? 'digits'
        : character === '.' || character === ')'
          ? 'bullet'
          : 'text';
    default:
      return 'text';
  }
}

/** Advance `state` over one character of exported text, in place. */
function advanceLineState(state: LineState, character: string): void {
  if (state.openerDistance !== -1) {
    state.openerDistance++;
    if (state.openerDistance === 1) {
      state.openerNext = character;
    } else if (state.openerDistance > MAX_LABEL_DISTANCE) {
      state.openerDistance = -1;
    }
  }
  if (character === '\n') {
    state.phase = 'start';
    return;
  }
  if (character === '[' || character === BARRIER || character === UNKNOWN) {
    // Unknown text inside a label that starts a line keeps its line start.
    const keepsLineStart =
      character === UNKNOWN &&
      state.openerDistance !== -1 &&
      state.openerChar !== BARRIER &&
      state.openerAtLineStart;
    state.openerDistance = 0;
    state.openerChar = character;
    state.openerNext = '';
    state.openerAtLineStart = state.phase === 'start' || keepsLineStart;
  }
  state.phase = nextLinePhase(state.phase, character);
}

function linkTextBracketsToEscape(text: string, nextChar: string): Set<number> {
  const escaped = new Set<number>();
  const openers: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '[') {
      openers.push(index);
    } else if (character === ']') {
      const opener = openers.pop();
      const after = index + 1 < text.length ? text[index + 1] : nextChar;
      if (opener === undefined) {
        escaped.add(index);
      } else if (after === '(' || after === UNKNOWN) {
        escaped.add(opener);
        escaped.add(index);
      }
    }
  }
  for (const opener of openers) {
    escaped.add(opener);
  }
  return escaped;
}

/**
 * The indexes in `text` of the `]` characters to escape outside a link, given
 * the state of the exported text before it in its block and the exported
 * character after it.
 */
function $literalBracketsToEscape(
  before: LineState,
  text: string,
  nextChar: string,
  $labelClosesAfter: (budget: number) => boolean,
): Set<number> {
  const escaped = new Set<number>();
  const lineStartOpeners: number[] = [];
  const state = {...before};
  for (let index = 0; index < text.length; index++) {
    const character = asLiteral(text[index]);
    if (character === ']') {
      const after = index + 1 < text.length ? text[index + 1] : nextChar;
      // The distance to the nearest opener, counting this `]`.
      const distance =
        state.openerDistance === -1 ? -1 : state.openerDistance + 1;
      const opensLine =
        distance !== -1 &&
        state.openerChar !== BARRIER &&
        state.openerAtLineStart;
      const isUnknown = state.openerChar === UNKNOWN;
      if (
        after === '(' ||
        after === UNKNOWN ||
        (opensLine && after === ':') ||
        (opensLine &&
          /\s/.test(after) &&
          (isUnknown ||
            distance === 1 ||
            (distance === 2 && /^\s$|^[xX]$/.test(state.openerNext))))
      ) {
        escaped.add(index);
      }
    } else if (character === '[' && state.phase === 'start') {
      lineStartOpeners.push(index);
    }
    advanceLineState(state, character);
  }
  for (const index of lineStartOpeners) {
    if ($labelClosesInCode(text, index, escaped, $labelClosesAfter)) {
      // The `]` that would close this label is in inline code, where it
      // cannot be escaped, so the `[` is.
      escaped.add(index);
    }
  }
  return escaped;
}

/**
 * Whether the label opened by the `[` at `index` in `text` would close at a
 * `]` inside inline code followed by `:`, making a link reference definition.
 * A label ends at the first `]` that is not escaped and cannot hold another
 * `[` (https://spec.commonmark.org/0.31.2/#link-label), and definitions are
 * read before code spans. `escaped` holds the `]` this pass escapes, which
 * stay inside the label. `$rest` reads past the end of `text`.
 */
function $labelClosesInCode(
  text: string,
  index: number,
  escaped: Set<number>,
  $rest: (budget: number) => boolean,
): boolean {
  for (let next = index + 1; next < text.length; next++) {
    if (text[next] === '[' || (text[next] === ']' && !escaped.has(next))) {
      return false;
    }
  }
  const budget = MAX_LABEL_DISTANCE - (text.length - index);
  return budget > 0 && $rest(budget);
}

/**
 * Continues `$labelClosesInCode` past `node`: reads the leaves after it in its
 * block until inline code holding a bracket, a `[`, a link, the end of the
 * block or `budget` characters. Unknown text may hold the `]`, so it answers
 * yes.
 */
function $labelClosesInCodeAfter(
  node: LexicalNode,
  selection: BaseSelection | null,
  budget: number,
): boolean {
  let remaining = budget;
  for (
    let leaf = $nextLeaf(node, selection);
    leaf !== null && remaining > 0;
    leaf = $nextLeaf(leaf, selection)
  ) {
    const kind = $exportKind(leaf);
    if (kind === 'link') {
      return false;
    } else if (kind === 'unknown') {
      return true;
    } else if ($isTextNode(leaf)) {
      const text = asLiteral($exportedText(leaf, selection));
      if (leaf.hasFormat('code')) {
        const bracket = text.search(/[[\]]/);
        if (bracket !== -1) {
          return text[bracket] === ']' && text[bracket + 1] === ':';
        }
      } else if (text.includes('[')) {
        // A `]` in plain text may be one this pass escapes, which leaves the
        // label open, so only a `[` ends the search here.
        return false;
      }
      remaining -= text.length;
    } else if ($isLineBreakNode(leaf)) {
      remaining--;
    }
  }
  return false;
}

/**
 * The state kept for the export in progress: its text match transformers, how
 * each element and text node they might write is exported, and the line state
 * after each leaf read so far, so that each leaf is read once however many
 * brackets follow it.
 */
interface BracketContext {
  textMatchTransformers: TextMatchTransformer[];
  exportKinds: Map<NodeKey, ExportKind>;
  lineStates: Map<NodeKey, LineState>;
}

let bracketContext: BracketContext | null = null;

function withBracketContext<T>(
  textMatchTransformers: TextMatchTransformer[],
  callback: () => T,
): T {
  const previous = bracketContext;
  bracketContext = {
    exportKinds: new Map(),
    lineStates: new Map(),
    textMatchTransformers,
  };
  try {
    return callback();
  } finally {
    bracketContext = previous;
  }
}

/**
 * How a node's exported text reads around a bracket: a link written as
 * `[text](url)`, text this pass reads, an inline element whose children are
 * exported in place, or something written in a syntax it cannot see.
 */
type ExportKind = 'link' | 'text' | 'transparent' | 'unknown';

function $exportKind(node: LexicalNode): ExportKind {
  if ($isLineBreakNode(node) || ($isElementNode(node) && !node.isInline())) {
    return 'text';
  } else if (!$isTextNode(node) && !$isElementNode(node)) {
    // A decorator is exported as its text content, or by a transformer.
    return 'unknown';
  }
  const context = bracketContext;
  const cached = context && context.exportKinds.get(node.getKey());
  if (cached) {
    return cached;
  }
  // What a transformer writes for the node, with its children left out, or
  // null when none writes it.
  let written: string | null = null;
  if (context) {
    for (const transformer of context.textMatchTransformers) {
      if (transformer.export === undefined) {
        continue;
      }
      try {
        written = transformer.export(
          node,
          () => '',
          () => '',
        );
      } catch {
        written = UNKNOWN;
      }
      if (written != null) {
        break;
      }
    }
  } else if ($isLinkNode(node) && !$isAutoLinkNode(node)) {
    written = '[]()';
  }
  // An element written as `[children](...)` reads like a link, whatever its
  // class; anything else a transformer writes is unknown.
  const kind: ExportKind =
    written == null
      ? $isTextNode(node)
        ? 'text'
        : 'transparent'
      : $isElementNode(node) && written.startsWith('[')
        ? 'link'
        : 'unknown';
  if (context) {
    context.exportKinds.set(node.getKey(), kind);
  }
  return kind;
}

function $isInsideLink(node: LexicalNode): boolean {
  for (let parent = node.getParent(); parent; parent = parent.getParent()) {
    if ($exportKind(parent) === 'link') {
      return true;
    }
    if (!parent.isInline()) {
      return false;
    }
  }
  return false;
}

function $isInlineElement(node: LexicalNode | null): boolean {
  return $isElementNode(node) && node.isInline();
}

/** Whether `node` is an inline element whose exported text is its children's. */
function $isTransparentInline(node: LexicalNode | null): node is ElementNode {
  return (
    $isElementNode(node) &&
    node.isInline() &&
    $exportKind(node) === 'transparent'
  );
}

/**
 * The first character of the exported text after `node` in its block: text
 * read through inline elements whose children are exported in place, `]` at
 * the end of a link's text, `[` where a link starts, a newline for a line
 * break, a backtick for inline code, and UNKNOWN for anything written in a
 * syntax this pass cannot see. Empty at the end of the block or of the
 * exported selection.
 */
function $nextExportedChar(
  node: LexicalNode,
  selection: BaseSelection | null,
): string {
  let current: LexicalNode = node;
  for (;;) {
    let next = current.getNextSibling();
    while (next === null) {
      const parent = current.getParent();
      if (parent !== null && $exportKind(parent) === 'link') {
        return ']';
      }
      if (!$isTransparentInline(parent)) {
        // Leaving an inline element written in its own syntax leads into
        // text this pass cannot see.
        return $isInlineElement(parent) ? UNKNOWN : '';
      }
      current = parent;
      next = current.getNextSibling();
    }
    while ($isTransparentInline(next) && next.getFirstChild() !== null) {
      next = next.getFirstChildOrThrow();
    }
    if (selection !== null && !next.isSelected(selection)) {
      return '';
    }
    const kind = $exportKind(next);
    if (kind === 'link') {
      return '[';
    } else if (kind === 'unknown') {
      return UNKNOWN;
    } else if ($isTextNode(next)) {
      const exported = $exportedText(next, selection);
      if (exported !== '') {
        return next.hasFormat('code') ? '`' : asLiteral(exported[0]);
      }
    } else if ($isLineBreakNode(next)) {
      return '\n';
    }
    current = next;
  }
}

/**
 * The leaf exported just after `node` in its block, read through inline
 * elements whose children are exported in place, or null at the end of the
 * block or of the exported selection.
 */
function $nextLeaf(
  node: LexicalNode,
  selection: BaseSelection | null,
): LexicalNode | null {
  let current: LexicalNode = node;
  let next = current.getNextSibling();
  while (next === null) {
    const parent = current.getParent();
    if (!$isTransparentInline(parent)) {
      // An inline element written in its own syntax stands for that syntax.
      return $isInlineElement(parent) ? parent : null;
    }
    current = parent;
    next = current.getNextSibling();
  }
  while ($isTransparentInline(next) && next.getFirstChild() !== null) {
    next = next.getFirstChildOrThrow();
  }
  return selection !== null && !next.isSelected(selection) ? null : next;
}

/**
 * The leaf exported just before `node` in its block, read through inline
 * elements whose children are exported in place, or null at the start of the
 * block or of the exported selection.
 */
function $previousLeaf(
  node: LexicalNode,
  selection: BaseSelection | null,
): LexicalNode | null {
  let current: LexicalNode = node;
  let previous = current.getPreviousSibling();
  while (previous === null) {
    const parent = current.getParent();
    if (!$isTransparentInline(parent)) {
      // An inline element written in its own syntax stands for that syntax.
      return $isInlineElement(parent) ? parent : null;
    }
    current = parent;
    previous = current.getPreviousSibling();
  }
  while ($isTransparentInline(previous) && previous.getLastChild() !== null) {
    previous = previous.getLastChildOrThrow();
  }
  return selection !== null && !previous.isSelected(selection)
    ? null
    : previous;
}

/**
 * A leaf's exported text in the terms LineState reads: a line break as a
 * newline, inline code with its brackets and spaces masked, a link as BARRIER
 * and anything this pass cannot see as UNKNOWN.
 */
function $leafText(leaf: LexicalNode, selection: BaseSelection | null): string {
  const kind = $exportKind(leaf);
  if (kind === 'link') {
    return BARRIER;
  } else if (kind === 'unknown') {
    return UNKNOWN;
  } else if ($isTextNode(leaf)) {
    const text = asLiteral($exportedText(leaf, selection));
    return leaf.hasFormat('code') ? text.replace(/[[\] \t]/g, '`') : text;
  } else if ($isLineBreakNode(leaf)) {
    return '\n';
  }
  return '';
}

function $lineStateBefore(
  node: LexicalNode,
  selection: BaseSelection | null,
): LineState {
  // Walk back to a leaf whose state is known, then read forward from it.
  const lineStates = bracketContext && bracketContext.lineStates;
  const pending: LexicalNode[] = [];
  let state = BLOCK_START;
  for (
    let leaf = $previousLeaf(node, selection);
    leaf !== null;
    leaf = $previousLeaf(leaf, selection)
  ) {
    const cached = lineStates && lineStates.get(leaf.getKey());
    if (cached) {
      state = cached;
      break;
    }
    pending.push(leaf);
  }
  for (let index = pending.length - 1; index >= 0; index--) {
    const leaf = pending[index];
    const next = {...state};
    for (const character of $leafText(leaf, selection)) {
      advanceLineState(next, character);
    }
    if (lineStates) {
      lineStates.set(leaf.getKey(), next);
    }
    state = next;
  }
  return state;
}

/**
 * A piece of exported inline Markdown: a format's tag (`**`), a character
 * of text at the start or end of a text node (the only text a tag can
 * touch), or anything else as written.
 */
type Piece =
  | {kind: 'tag'; text: string; opens: boolean}
  | {kind: 'char'; text: string}
  | {kind: 'other'; text: string};

function other(text: string): Piece {
  return {kind: 'other', text};
}

function joinPieces(pieces: Piece[]): string {
  let output = '';
  for (const piece of pieces) {
    output += piece.text;
  }
  return output;
}

/**
 * The pieces of exported text: its first and last characters on their own
 * (a backslash escape or a character reference is one piece, never encoded
 * again), the rest as written.
 */
function textPieces(text: string): Piece[] {
  const units =
    text.match(/\\[!-/:-@[-`{-~]|&#(?:\d+|[xX][\da-fA-F]+);|[\s\S]/gu) || [];
  if (units.length === 0) {
    return [];
  }
  const piece = (unit: string): Piece =>
    unit.length > 1 && (unit[0] === '\\' || unit[0] === '&')
      ? other(unit)
      : {kind: 'char', text: unit};
  if (units.length === 1) {
    return [piece(units[0]!)];
  }
  return [
    piece(units[0]!),
    other(units.slice(1, -1).join('')),
    piece(units[units.length - 1]!),
  ];
}

type CharClass = 'space' | 'punctuation' | 'word';

/** A character as CommonMark classes it: Unicode P and S are punctuation. */
function classOf(char: string): CharClass {
  if (char === '' || /\s/u.test(char)) {
    return 'space';
  }
  return /[\p{P}\p{S}]/u.test(char) ? 'punctuation' : 'word';
}

/**
 * The same, as parsers that read text in UTF-16 units see it (the reference
 * JavaScript implementation, markdown-it): a character outside the Basic
 * Multilingual Plane is two surrogates, neither punctuation.
 */
function unitClassOf(char: string): CharClass {
  return char.length > 1 ? 'word' : classOf(char);
}

/** The same, as this package's import classes it: ASCII punctuation only. */
function asciiClassOf(char: string): CharClass {
  const charClass = classOf(char);
  return charClass === 'punctuation' && !PUNCTUATION.test(char)
    ? 'word'
    : charClass;
}

/**
 * Whether a character can be written as a numeric character reference that
 * every parser reads back as itself: a letter, a mark, a digit, a symbol or
 * punctuation, never a control character (CommonMark maps the references of
 * C1 controls to other characters: `&#128;` is `€`).
 */
function canBeReference(char: string): boolean {
  return /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(char);
}

/**
 * Keep every run of tags in `pieces` (the inline Markdown of one block) able
 * to open and close, by CommonMark's flanking rules
 * (https://spec.commonmark.org/0.31.2/#left-flanking-delimiter-run): a run
 * that closes a tag cannot have punctuation before it and a letter or digit
 * after it (`**Hello,**world`), and a run that opens one cannot have a
 * letter or digit before it and punctuation after it (`x*(beta)*`), or the
 * Markdown imported again keeps the asterisks as text. There the letter or
 * digit is written as a numeric character reference, which is punctuation to
 * the run and the same character once imported (`**Hello,**&#119;orld`,
 * `&#120;*(beta)*`), so the text a reader sees is unchanged. Only a run
 * that fails both as CommonMark classes characters and as parsers that read
 * UTF-16 units do (they disagree on emoji and other characters outside the
 * Basic Multilingual Plane) is changed, so Markdown that any of them reads
 * back as written stays byte for byte as it was. A reference changes the
 * character the next run sees, so the check repeats around each character it
 * writes.
 */
function keepTagRunsFlanking(allPieces: Piece[]): Piece[] {
  const pieces = allPieces.filter(piece => piece.text !== '');
  // Runs: consecutive tags of one delimiter character, by piece index.
  const runs: [number, number][] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece.kind !== 'tag') {
      continue;
    }
    const last = runs[runs.length - 1];
    if (
      last !== undefined &&
      last[1] === i - 1 &&
      (pieces[i - 1] as {text: string}).text[0] === piece.text[0]
    ) {
      last[1] = i;
    } else {
      runs.push([i, i]);
    }
  }
  if (runs.length === 0) {
    return pieces;
  }
  const result = [...pieces];
  // The character next to piece `i` on one side, skipping empty pieces.
  const charBefore = (i: number): [string, number] => {
    for (let j = i - 1; j >= 0; j--) {
      const text = result[j].text;
      if (text !== '') {
        const last = text.charCodeAt(text.length - 1);
        return [
          last >= 0xdc00 && last <= 0xdfff && text.length > 1
            ? text.slice(-2)
            : text.slice(-1),
          j,
        ];
      }
    }
    return ['', -1];
  };
  const charAfter = (i: number): [string, number] => {
    for (let j = i + 1; j < result.length; j++) {
      const text = result[j].text;
      if (text !== '') {
        return [String.fromCodePoint(text.codePointAt(0)!), j];
      }
    }
    return ['', -1];
  };
  const encode = (j: number): boolean => {
    const piece = result[j];
    if (j < 0 || piece.kind !== 'char' || !canBeReference(piece.text)) {
      return false;
    }
    result[j] = other(`&#${piece.text.codePointAt(0)};`);
    return true;
  };
  // The pieces written as references here.
  const written = new Set<number>();
  // Which run touches each piece, to check again after it changes.
  const runAt = new Map<number, number[]>();
  const pending: number[] = [];
  runs.forEach(([start, end], index) => {
    pending.push(index);
    for (const at of [charBefore(start)[1], charAfter(end)[1]]) {
      if (at >= 0) {
        runAt.set(at, [...(runAt.get(at) || []), index]);
      }
    }
  });
  while (pending.length > 0) {
    const [start, end] = runs[pending.pop()!];
    let opens = false;
    let closes = false;
    for (let i = start; i <= end; i++) {
      const piece = result[i] as {opens: boolean};
      opens = opens || piece.opens;
      closes = closes || !piece.opens;
    }
    const [before, beforeAt] = charBefore(start);
    const [after, afterAt] = charAfter(end);
    // Only where the run fails by both readings of the characters, so that
    // Markdown any parser reads back as written stays as it is.
    const fails = (b: CharClass, a: CharClass) =>
      closes && b === 'punctuation' && a === 'word'
        ? 'after'
        : opens && a === 'punctuation' && b === 'word'
          ? 'before'
          : null;
    const proper = fails(classOf(before), classOf(after));
    const units = fails(unitClassOf(before), unitClassOf(after));
    // This package's import counts only ASCII punctuation: where a reference
    // written here (punctuation to it) meets a character it takes for a
    // letter (`€`, `—`), that character is written as a reference too.
    const ascii = fails(asciiClassOf(before), asciiClassOf(after));
    const side =
      proper !== null && proper === units
        ? proper
        : (ascii === 'after' && written.has(beforeAt)) ||
            (ascii === 'before' && written.has(afterAt))
          ? ascii
          : null;
    const at = side === 'after' ? afterAt : side === 'before' ? beforeAt : -1;
    if (at >= 0 && encode(at)) {
      written.add(at);
      pending.push(...(runAt.get(at) || []));
    }
  }
  return result;
}

function getTextSibling(node: TextNode, backward: boolean): TextNode | null {
  const sibling = backward ? node.getPreviousSibling() : node.getNextSibling();

  if ($isTextNode(sibling)) {
    return sibling;
  }

  return null;
}

/**
 * Whether `tag` carries on past `node`, which has its format, to exported
 * text that can hold it. Whitespace-only siblings cannot (the tag must close
 * before the space), so they are looked past while they keep the format.
 * Text outside the exported selection does not count. Every whitespace node
 * the walk passes over shares its answer, so that is remembered on the tag
 * and each run is walked once, whatever order its nodes are asked in.
 */
function $continuesTag(
  node: TextNode,
  tag: OpenTag,
  selection: BaseSelection | null,
): boolean {
  const {answers} = tag;
  const known = answers.get(node.getKey());
  if (known !== undefined) {
    return known;
  }
  const passed: TextNode[] = [];
  let next = getTextSibling(node, false);
  let result = false;
  while (
    next &&
    next.hasFormat(tag.format) &&
    (!selection || next.isSelected(selection))
  ) {
    const text = $exportedText(next, selection);
    if (canHoldTag(text)) {
      result = true;
      break;
    }
    // Markdown import matches a tag within one line.
    if (text.includes('\n')) {
      break;
    }
    // A whitespace node already answered for shares the answer.
    const passedAnswer = answers.get(next.getKey());
    if (passedAnswer !== undefined) {
      result = passedAnswer;
      break;
    }
    passed.push(next);
    next = getTextSibling(next, false);
  }
  answers.set(node.getKey(), result);
  for (const passedNode of passed) {
    answers.set(passedNode.getKey(), result);
  }
  return result;
}

/** The text of `node` that the export emits: its selected slice, if any. */
function $exportedText(node: TextNode, selection: BaseSelection | null) {
  return selection
    ? $sliceSelectedTextNodeContent(selection, node, 'clone').getTextContent()
    : node.getTextContent();
}

function hasFormat(
  node: LexicalNode | null | undefined,
  format: TextFormatType,
): boolean {
  return $isTextNode(node) && node.hasFormat(format);
}

/**
 * Whether exported text can carry a format's tag: CommonMark flanking rules
 * keep tags off whitespace.
 */
function canHoldTag(text: string): boolean {
  return /\S/.test(text);
}
