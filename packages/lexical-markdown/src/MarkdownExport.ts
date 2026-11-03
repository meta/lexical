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
import {
  characterAt,
  characterBefore,
  flankingBefore,
  getPortableEmphasisSides,
  isEmptyParagraph,
  isEscaped,
  isLetterForSomeReader,
  isPortablyFlankedBy,
  isVariationSelector,
  toCharacterReference,
  transformersByType,
} from './utils';

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
        joinPieces(
          $exportChildrenForSelection(
            node_,
            selection,
            textFormatTransformers,
            textMatchTransformers,
            shouldPreserveNewLines,
          ).pieces,
        ),
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
      markdown: joinPieces(childResult.pieces),
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
  output: MarkdownPieces = createPieces(),
): {shouldInclude: boolean; pieces: MarkdownPieces} {
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
          joinPieces(
            $exportChildrenForSelection(
              parentNode,
              selection,
              textFormatTransformers,
              textMatchTransformers,
              shouldPreserveNewLines,
              unclosedTags,
              [...unclosableTags, ...unclosedTags],
            ).pieces,
          ),
        textNode =>
          joinPieces(
            $exportTextFormat(
              textNode,
              $exportedText(textNode, selection),
              textFormatTransformers,
              unclosedTags,
              unclosableTags,
              shouldPreserveNewLines,
              selection,
            ),
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
          pushPiece(output, RAW, result);
          anyChildIncluded = true;
        }
        continue mainLoop;
      }
    }

    if ($isLineBreakNode(child)) {
      if (childIncluded) {
        pushPiece(output, RAW, $exportLineBreak(child));
        anyChildIncluded = true;
      }
    } else if ($isTextNode(child)) {
      if (childIncluded) {
        $exportTextFormat(
          child,
          $exportedText(child, selection),
          textFormatTransformers,
          unclosedTags,
          unclosableTags,
          shouldPreserveNewLines,
          selection,
          output,
        );
        anyChildIncluded = true;
      }
    } else if ($isElementNode(child)) {
      const childResult = $exportChildrenForSelection(
        child,
        selection,
        textFormatTransformers,
        textMatchTransformers,
        shouldPreserveNewLines,
        unclosedTags,
        unclosableTags,
        output,
      );

      // extractWithChild: if child has selected descendants, ask parent if it should be included
      if (
        !childIncluded &&
        childResult.shouldInclude &&
        child.extractWithChild(child, selection, 'html')
      ) {
        childIncluded = true;
      }

      // An element child writes pieces only when it has included ones.
      if (childIncluded || childResult.shouldInclude) {
        anyChildIncluded = true;
      }
    } else if ($isDecoratorNode(child)) {
      if (childIncluded) {
        pushPiece(output, TEXT, child.getTextContent());
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
    $exportChildPieces(
      node,
      textTransformersIndex,
      textMatchTransformers,
      unclosedTags,
      unclosableTags,
      shouldPreserveNewLines,
    ),
  );
}

function $exportChildPieces(
  node: ElementNode,
  textTransformersIndex: TextFormatTransformer[],
  textMatchTransformers: TextMatchTransformer[],
  unclosedTags?: OpenTag[],
  unclosableTags?: OpenTag[],
  shouldPreserveNewLines: boolean = false,
  output: MarkdownPieces = createPieces(),
): MarkdownPieces {
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
          joinPieces(
            $exportTextFormat(
              textNode,
              textContent,
              textTransformersIndex,
              unclosedTags,
              unclosableTags,
              shouldPreserveNewLines,
              null,
            ),
          ),
      );

      if (result != null) {
        pushPiece(output, RAW, result);
        continue mainLoop;
      }
    }

    if ($isLineBreakNode(child)) {
      pushPiece(output, RAW, $exportLineBreak(child));
    } else if ($isTextNode(child)) {
      $exportTextFormat(
        child,
        child.getTextContent(),
        textTransformersIndex,
        unclosedTags,
        unclosableTags,
        shouldPreserveNewLines,
        null,
        output,
      );
    } else if ($isElementNode(child)) {
      // empty paragraph returns ""
      $exportChildPieces(
        child,
        textTransformersIndex,
        textMatchTransformers,
        unclosedTags,
        unclosableTags,
        shouldPreserveNewLines,
        output,
      );
    } else if ($isDecoratorNode(child)) {
      pushPiece(output, TEXT, child.getTextContent());
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
  // unclosed tags include the markdown tags that haven't been closed yet, and their associated formats
  unclosedTags: OpenTag[],
  unclosableTags: OpenTag[],
  shouldPreserveNewLines: boolean,
  // the selection being exported, which ends the text a tag can extend over
  selection: BaseSelection | null,
  // where the exported pieces go
  pieces: MarkdownPieces = createPieces(),
): MarkdownPieces {
  // This function handles the case of a string looking like this: "   foo   "
  // Where it would be invalid markdown to generate: "**   foo   **"
  // so the tags go inside the whitespace instead: "   **foo**   ".

  const isCode = node.hasFormat('code');

  let output = textContent;
  if (!isCode) {
    // Preserve literal backslashes when preserving source newlines, except
    // right before a character escaped here, where they would escape the
    // escape instead.
    // Default mode guards numeric references; named references keep legacy output.
    // Numeric escapes avoid changing emphasis flanking beside formatting.
    // Guard ambiguous '<' and '&' at node ends for constructs split across nodes.
    if (shouldPreserveNewLines) {
      // A whole run of backslashes is matched, so that one before no marker
      // is not tried again from each of its backslashes.
      output = output.replace(
        /\\+|[*_`~]/g,
        (escaped, offset: number, text: string) =>
          escaped[0] !== '\\'
            ? `\\${escaped}`
            : /[*_`~]/.test(text[offset + escaped.length])
              ? escaped + escaped
              : escaped,
      );
    } else {
      output = $escapeLiteralBrackets(
        node,
        output.replace(/([*_`~\\]|<(?=\S|$)|&(?=#|$))/g, character =>
          /[*_`~\\]/.test(character)
            ? `\\${character}`
            : toCharacterReference(character),
        ),
        selection,
      );
    }
  }

  const holdsTag = canHoldTag(textContent);

  // the opening tags to be added to the result
  let openingTags = '';
  // the closing tags to be added to the result
  let closingTagsBefore = '';
  let closingTagsAfter = '';

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
        openingTags += tag;
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
          closingTagsBefore += unclosedTag.tag;
        } else {
          closingTagsAfter += unclosedTag.tag;
        }
      }
      // Mutate the original array to remove the closed tag
      unclosedTags.pop();
    }
    break;
  }
  if (isCode && textContent !== '') {
    // Inline code is an atomic literal span with a content-derived fence, so
    // its whitespace stays inside the fence and other formats wrap around it.
    const {fence, padded} = getCodeSpanDelimiter(textContent);
    output = fence + padded + fence;
  } else if (!holdsTag) {
    // If the node is entirely whitespace, we don't apply opening/closing tags
    // around it, but it must still output any closing tags.
    pushPiece(pieces, CLOSER, closingTagsBefore + closingTagsAfter);
    pushPiece(pieces, TEXT, output);
    return pieces;
  }

  // Flanking Compliance: CommonMark flanking rules require formatting tags to be
  // adjacent to non-whitespace characters, so openingTags and closingTagsAfter
  // are placed INSIDE the whitespace boundaries!
  // Tags stay inside JavaScript whitespace, which holds CommonMark's and the
  // other characters some readers count as whitespace.
  // (Trimming rather than a regex keeps this linear in long whitespace runs.)
  const trimmedStart = output.trimStart();
  const trimmedOutput = trimmedStart.trimEnd();
  const leadingSpace = output.slice(0, output.length - trimmedStart.length);
  const trailingSpace = trimmedStart.slice(trimmedOutput.length);
  pushPiece(pieces, CLOSER, closingTagsBefore);
  pushPiece(pieces, TEXT, leadingSpace);
  pushPiece(pieces, OPENER, openingTags);
  // Inline code is a literal span: a character reference would show as is.
  pushPiece(pieces, isCode ? RAW : TEXT, trimmedOutput);
  pushPiece(pieces, CLOSER, closingTagsAfter);
  pushPiece(pieces, TEXT, trailingSpace);
  return pieces;
}

/**
 * Exported inline Markdown, with the format markers kept apart from the text
 * until `joinPieces` can see the characters on both sides of each delimiter
 * run: `values[i]` is a piece of the output and `kinds[i]` what it is. A
 * character reference can stand in for a character of `TEXT`, which is text
 * and decorator content; `RAW` is anything else, such as code spans, line
 * breaks and the output of transformers, whose syntax a reference could
 * break. `OPENER` and `CLOSER` are format markers.
 */
type PieceKind = typeof TEXT | typeof RAW | typeof OPENER | typeof CLOSER;

interface MarkdownPieces {
  kinds: PieceKind[];
  values: string[];
}

const TEXT = 0;
const RAW = 1;
const OPENER = 2;
const CLOSER = 3;

function createPieces(): MarkdownPieces {
  return {kinds: [], values: []};
}

// Adjacent text (and adjacent raw output) is merged, so that each run of
// markers sits between the pieces whose characters a reader sees beside it.
function pushPiece(pieces: MarkdownPieces, kind: PieceKind, value: string) {
  const {kinds, values} = pieces;
  const last = kinds.length - 1;
  if (value === '') {
    return;
  } else if (last >= 0 && kinds[last] === kind && !isMarker(kind)) {
    values[last] += value;
  } else {
    kinds.push(kind);
    values.push(value);
  }
}

function isMarker(kind: PieceKind | undefined): boolean {
  return kind === OPENER || kind === CLOSER;
}

// Characters a URL or email can hold: GFM ends an autolink at
// whitespace or `<`, and a URL's host and path may hold any other character.
// This takes in the backslash that escapes a marker too.
const LINK_END = /[\s\p{Cc}<]/u;
function isLinkCharacter(character: string): boolean {
  return !LINK_END.test(character);
}
/** Where the run of URL characters that ends `text` starts. */
function linkRunStart(text: string): number {
  let start = text.length;
  while (start > 0 && isLinkCharacter(text[start - 1])) {
    start--;
  }
  return start;
}
// What starts a URL: `http://`, `https://` (and cmark-gfm's `ftp://`) with
// a host after it, which may start with an emoji but not with other ASCII
// punctuation than `-` and `_`, and `www.`, which micromark links with
// anything after it. GFM readers start `www.` only at the start of a run or
// after `*_~(`, and a scheme after anything but a letter.
const LINK_PREFIX = /(?:https?|ftp):\/\/(?![\s\p{Cc}!-,./:-@[-^`{-~])|www\./giu;
function startsLink(prefix: string, before: string): boolean {
  return /^w/i.test(prefix) ? '*_~('.includes(before) : !/[a-z]/i.test(before);
}
// Characters an email can hold (word characters, `.+@-`, and the backslash
// that escapes one), and what makes one: GFM needs a dot in its domain. An
// email takes in no format, and cmark-gfm finds it in the text with its
// references decoded, but micromark only where its `@` is written as is.
const ADDRESS_CHARACTER = /[\w.+@\\-]/;
const ADDRESS = /[\w.+-]@[\w-]+\.[\w-]/;
const LINKISH = /www\.|:\/\/|@/i;
// Characters that GFM readers leave out at the end of a URL.
const LINK_TRAIL = '?!.,:*_~';

// Characters that a reference does not stand in for everywhere: CommonMark
// readers and HTML decode references to control characters, unpaired
// surrogates and noncharacters as U+FFFD (or remap them).
const UNREFERENCEABLE = /[\p{Cc}\p{Cs}\p{Noncharacter_Code_Point}]/u;

/** Whether a character reference can stand in for `character` beside a marker. */
function isReferenceable(character: string | undefined): boolean {
  // Of a variation selector after the character it varies, the reference
  // is to the selector.
  if (
    character !== undefined &&
    character.length > 1 &&
    isVariationSelector(character[character.length - 1])
  ) {
    character = character[character.length - 1];
  }
  return (
    character !== undefined &&
    isLetterForSomeReader(character) &&
    !UNREFERENCEABLE.test(character)
  );
}

/**
 * Adjacent markers between the pieces at `before` and `after`: whether the
 * first delimiter run opens a tag, the marker character after it within the
 * markers (if any), whether the last delimiter run closes a tag, and the
 * marker character before it.
 */
type MarkerRun = [
  before: number,
  after: number,
  opens: boolean,
  afterFirst: string | undefined,
  closes: boolean,
  beforeLast: string | undefined,
];

/**
 * Joins exported pieces into Markdown. A delimiter run between a word
 * character and punctuation can only open or close on the punctuation side
 * (CommonMark flanking), so plain `a` before a bold `*` cannot go out as
 * `a**\***`. The word character beside such a run goes out as a numeric
 * reference instead, whose `&` or `;` is punctuation: `&#97;**\***`.
 */
function joinPieces({kinds, values}: MarkdownPieces): string {
  const text = values.join('');
  if (kinds.every(kind => kind === TEXT)) {
    return text;
  }
  const [encodeStart, encodeEnd] = decideReferences(kinds, values);
  // The code units of `text` that go out as references.
  const isReference = new Uint8Array(text.length);
  for (let index = 0, base = 0; index < kinds.length; index++) {
    const value = values[index];
    const start = encodeStart[index] ? characterAt(value, 0)!.length : 0;
    let end = value.length;
    if (encodeEnd[index] && end > start) {
      end -= characterBefore(value, end)!.length;
    }
    // A backslash left unescaped (when preserving newlines, or in decorator
    // text) would escape the reference, marker or raw punctuation written
    // after it, or end the line with a hard break.
    if (
      kinds[index] === TEXT &&
      (isMarker(kinds[index + 1]) ||
        (kinds[index + 1] === RAW && ESCAPABLE.test(values[index + 1]))) &&
      end > start &&
      isEscaped(value, end)
    ) {
      end--;
    }
    isReference.fill(1, base, base + start);
    isReference.fill(1, base + end, (base += value.length));
  }
  spoilLinks(kinds, values, isReference);
  let markdown = '';
  let from = 0;
  for (
    let at = isReference.indexOf(1);
    at !== -1;
    at = isReference.indexOf(1, from)
  ) {
    const character = characterAt(text, at)!;
    markdown += text.slice(from, at) + toCharacterReference(character);
    from = at + character.length;
  }
  return markdown + text.slice(from);
}

// What a backslash before it escapes: ASCII punctuation or a line ending.
const ESCAPABLE = /^[!-/:-@[-`{-~\n\r]/;

/**
 * Raw output as the bare-URL scan sees it. It keeps whitespace and `<`, which
 * end a URL, `*_~(`, after which `www.` starts one, and ASCII letters, before
 * which no scheme starts one, as `x`, and is `#` elsewhere. So no URL starts
 * inside it, but one before it runs on into it, as GFM readers run a URL on
 * through a code span or a link.
 */
function maskRaw(value: string): string {
  return value.replace(/[a-z]/gi, 'x').replace(/[^\sx<*_~(]/g, '#');
}

/**
 * Finds the bare URLs and `www.` hosts that GFM readers would link in the
 * joined pieces, and that a reference would land in or that would take in
 * the markers, code span or other raw output after them: the reader would
 * keep the reference's characters in the link, or the markers and code as
 * text. Such a URL is spoiled instead, by writing the `.` of `www.` or the
 * `:` after its scheme as a reference, so that no reader links it and its
 * text and formats come through. So is a URL that a reference before it
 * would start. `isReference` marks the code units of the joined text that go
 * out as references, and the ones that spoil a link are marked in it too.
 */
function spoilLinks(
  kinds: PieceKind[],
  values: string[],
  isReference: Uint8Array,
): void {
  // Every URL and email starts with one of these. With no reference written,
  // only a URL that runs on to the end of its text, into the markers or raw
  // output after it, is spoiled.
  const hasReferences = isReference.includes(1);
  if (
    !values.some(
      (value, i) =>
        kinds[i] === TEXT &&
        LINKISH.test(value) &&
        (hasReferences || LINKISH.test(value.slice(linkRunStart(value)))),
    )
  ) {
    return;
  }
  let text = '';
  // Whether each code unit is not text, as `1`.
  let isFormat = '';
  for (let i = 0; i < values.length; i++) {
    text += kinds[i] === RAW ? maskRaw(values[i]) : values[i];
    isFormat += (kinds[i] === TEXT ? '0' : '1').repeat(values[i].length);
  }
  // Running counts of referenced code units and of code units that are not
  // text, so that whether any lie in a span is a subtraction.
  const references = new Uint32Array(text.length + 1);
  const formats = new Uint32Array(text.length + 1);
  for (let i = 0; i < text.length; i++) {
    references[i + 1] = references[i] + isReference[i];
    formats[i + 1] = formats[i] + Number(isFormat[i] === '1');
  }
  const has = (sums: Uint32Array, from: number, to: number) =>
    from < to && sums[to] > sums[from];
  // A reference in an email would cut a micromark reader's link short, so
  // each `@` of one that holds a reference is spoiled.
  const spoilEmails = (from: number, to: number) => {
    for (let start = from; start < to; ) {
      let end = start;
      while (end < to && ADDRESS_CHARACTER.test(text[end])) {
        end++;
      }
      if (
        has(references, start, end) &&
        ADDRESS.test(text.slice(start, end).replace(/\\/g, ''))
      ) {
        for (let i = start; i < end; i++) {
          // A raw backslash before an `@` would escape the reference's `&`.
          if (
            text[i] === '@' &&
            !isReference[i] &&
            isFormat[i] === '0' &&
            !isEscaped(text, i)
          ) {
            isReference[i] = 1;
          }
        }
      }
      start = Math.max(end, start + 1);
    }
  };
  for (let start = 0; start < text.length; ) {
    let end = start;
    while (
      end < text.length &&
      (isLinkCharacter(text[end]) || isReference[end] === 1)
    ) {
      end++;
    }
    if (end === start) {
      start++;
      continue;
    }
    // A URL runs to the end of the run, less the punctuation at its end. It
    // takes in a backslash before that punctuation, which then no longer
    // escapes it, so the punctuation can join the markers after it.
    let trimmed = end;
    while (trimmed > start && LINK_TRAIL.includes(text[trimmed - 1])) {
      trimmed--;
    }
    if (isEscaped(text, trimmed) && has(formats, trimmed, end)) {
      trimmed = end;
    }
    // Where the text that is not part of a URL starts, which may hold an
    // email, and where the next URL may start.
    let rest = start;
    for (const prefix of text.slice(start, end).matchAll(LINK_PREFIX)) {
      const at = start + prefix.index;
      if (at < rest) {
        continue;
      }
      // A reference before the prefix, or a spoiled `.` or `:`, puts `;`
      // there.
      const before = at > start ? text[at - 1] : '';
      const wasLink = at === start || startsLink(prefix[0], before);
      if (
        at > start &&
        !startsLink(prefix[0], isReference[at - 1] ? ';' : before)
      ) {
        continue;
      }
      spoilEmails(rest, at);
      if (wasLink && !has(references, at, end) && !has(formats, at, trimmed)) {
        rest = end;
        break;
      }
      // A reference in the prefix spoils it already. A URL whose `.` or `:`
      // is a custom format's marker is left as it is.
      const spoil = at + prefix[0].search(/[.:]/);
      if (!has(references, at, at + prefix[0].length)) {
        if (isFormat[spoil] === '1') {
          rest = end;
          break;
        }
        isReference[spoil] = 1;
      }
      rest = at + prefix[0].length;
    }
    spoilEmails(rest, end);
    start = end;
  }
}

/**
 * Walks the delimiter run at the edge of the markers from `from` to `to`,
 * forward when `step` is 1 and backward when it is -1. Returns whether a
 * marker of `kind` is part of that run, and the character past it within the
 * markers, if any.
 */
function scanDelimiterRun(
  kinds: PieceKind[],
  values: string[],
  from: number,
  to: number,
  step: 1 | -1,
  kind: PieceKind,
): [boolean, string | undefined] {
  const edge = values[from];
  const delimiter = edge[step === 1 ? 0 : edge.length - 1];
  let hasKind = false;
  for (let i = from; i !== to + step; i += step) {
    const value = values[i];
    for (
      let c = step === 1 ? 0 : value.length - 1;
      c >= 0 && c < value.length;
      c += step
    ) {
      if (value[c] !== delimiter) {
        return [hasKind, value[c]];
      }
      hasKind ||= kinds[i] === kind;
    }
  }
  return [hasKind, undefined];
}

/**
 * Marks the text pieces whose first (in the first array) or last character
 * has to go out as a reference for the marker run beside it to open or close.
 */
function decideReferences(
  kinds: PieceKind[],
  values: string[],
): [Uint8Array, Uint8Array] {
  const count = kinds.length;
  const encodeStart = new Uint8Array(count);
  const encodeEnd = new Uint8Array(count);
  const runs: MarkerRun[] = [];
  // The run that follows and the run that precedes each piece, or -1. (A
  // typed array ignores a write out of its bounds.)
  const runAfter = new Int32Array(count).fill(-1);
  const runBefore = new Int32Array(count).fill(-1);
  for (let start = 0; start < count; start++) {
    if (isMarker(kinds[start])) {
      let end = start;
      while (isMarker(kinds[end + 1])) {
        end++;
      }
      runAfter[start - 1] = runBefore[end + 1] = runs.length;
      // Markers of one character form one delimiter run, and only the first
      // and the last delimiter run touch text.
      runs.push([
        start - 1,
        end + 1,
        ...scanDelimiterRun(kinds, values, start, end, 1, OPENER),
        ...scanDelimiterRun(kinds, values, end, start, -1, CLOSER),
      ]);
      start = end;
    }
  }
  const firstChar = (index: number) => characterAt(values[index], 0)!;
  // A variation selector that starts a piece varies what ends the piece
  // before it.
  const lastChar = (index: number): string =>
    flankingBefore(
      values[index],
      values[index].length,
      index > 0 &&
        values[index].length === 1 &&
        isVariationSelector(values[index])
        ? endChar(index - 1)
        : undefined,
    )!;
  // A one-character piece written as a reference reads as punctuation at
  // both ends: `&#97;`.
  const isOneCharacter = (index: number) =>
    firstChar(index).length === values[index].length;
  const isEncoded = (index: number) =>
    (encodeStart[index] || encodeEnd[index]) && isOneCharacter(index);
  const startChar = (index: number) =>
    index >= count
      ? undefined
      : encodeStart[index] || isEncoded(index)
        ? '&'
        : firstChar(index);
  // A piece of a character and a variation selector whose first character
  // goes out as a reference: the selector then varies the reference's `;`.
  const isVariedByStart = (index: number) =>
    encodeStart[index] === 1 &&
    values[index].length === firstChar(index).length + 1 &&
    isVariationSelector(values[index].slice(-1));
  const endChar = (index: number) =>
    index < 0
      ? undefined
      : encodeEnd[index] || isEncoded(index)
        ? ';'
        : isVariedByStart(index)
          ? flankingBefore(values[index].slice(-1), 1, ';')!
          : lastChar(index);
  // Whether the last (or first) character of the piece at `index` can go out
  // as a reference.
  const canReference = (index: number, atEnd: boolean): boolean =>
    kinds[index] === TEXT &&
    isReferenceable(atEnd ? endChar(index) : startChar(index));
  // Writing a one-character piece as a reference makes its other edge
  // punctuation too. That can stop the delimiter run touching that edge from
  // flanking unless the piece past it is written as a reference as well, and
  // so on along a chain of one-character pieces. Where the chain ends at
  // something that cannot be (raw output, say), writing the first reference
  // would only trade one lost format for another, so it is not written.
  // Each piece's answer is remembered for each direction, so each piece is
  // walked at most twice. Raw output and unreferenceable characters stay
  // what they are. A remembered block could only lift if a piece on its
  // chain were later written as a reference from the other side, which takes
  // a run of one marker character that both closes and opens; then a
  // reference that would have kept a format is not written.
  // 0 while unknown, then 1 when it spreads and 2 when it is blocked.
  const spreads = [new Uint8Array(count), new Uint8Array(count)];
  const canSpread = (index: number, leftward: boolean): boolean => {
    const known = spreads[Number(leftward)];
    const visited: number[] = [];
    let result = true;
    for (let piece = index; ; ) {
      if (known[piece] !== 0) {
        result = known[piece] === 1;
        break;
      }
      visited.push(piece);
      const runIndex = (leftward ? runBefore : runAfter)[piece];
      if (runIndex === -1) {
        break;
      }
      const [before, after, opens, afterFirst, closes, beforeLast] =
        runs[runIndex];
      const next = leftward ? before : after;
      // Only a run of a single delimiter character touches both pieces.
      if (
        !(leftward
          ? opens && afterFirst === undefined
          : closes && beforeLast === undefined) ||
        isPortablyFlankedBy(
          leftward ? '&' : ';',
          leftward ? endChar(next) : startChar(next),
          leftward,
        )
      ) {
        break;
      }
      if (!canReference(next, leftward)) {
        result = false;
        break;
      }
      if (!isOneCharacter(next)) {
        break;
      }
      piece = next;
    }
    for (const piece of visited) {
      known[piece] = result ? 1 : 2;
    }
    return result;
  };
  // Whether a reference beside the run, before it when `opening` and after it
  // otherwise, lets its first delimiter run open (or its last close) where it
  // could not, and whether that reference can be written. `_` between two
  // letters cannot open either way.
  const isHelpedBy = (
    [before, after, opens, afterFirst, closes, beforeLast]: MarkerRun,
    opening: boolean,
  ): boolean => {
    const piece = opening ? before : after;
    if (!(opening ? opens : closes) || !canReference(piece, opening)) {
      return false;
    }
    const side = opening ? 'canOpen' : 'canClose';
    const marker = opening
      ? values[before + 1][0]
      : values[after - 1][values[after - 1].length - 1];
    const previous = (!opening && beforeLast) || endChar(before);
    const next = (opening && afterFirst) || startChar(after);
    return (
      !getPortableEmphasisSides(marker, previous, next)[side] &&
      getPortableEmphasisSides(
        marker,
        opening ? ';' : previous,
        opening ? next : '&',
      )[side] &&
      (!isOneCharacter(piece) || canSpread(piece, opening))
    );
  };
  // Text does not escape every tag character (the `=` of `==`, say), and one
  // right beside a marker of the same character would join its delimiter
  // run, so it goes out as a reference.
  for (let i = 0; i < count; i++) {
    const value = values[i];
    if (kinds[i] === TEXT) {
      if (
        isMarker(kinds[i + 1]) &&
        value[value.length - 1] === values[i + 1][0] &&
        !isEscaped(value, value.length - 1)
      ) {
        encodeEnd[i] = 1;
      }
      if (
        isMarker(kinds[i - 1]) &&
        value[0] === values[i - 1][values[i - 1].length - 1]
      ) {
        encodeStart[i] = 1;
      }
    }
  }
  const pending = runs.map((_run, index) => index);
  // Writing a one-character piece as a reference changes what the run on its
  // other side sees, so that run is decided again. Each piece changes at most
  // twice, so this stays linear.
  while (pending.length > 0) {
    const index = pending.pop()!;
    const run = runs[index];
    const [before, after, opens, afterFirst] = run;
    if (isHelpedBy(run, true)) {
      encodeEnd[before] = 1;
      if (isEncoded(before) && runBefore[before] !== -1) {
        pending.push(runBefore[before]);
      }
    }
    if (isHelpedBy(run, false)) {
      encodeStart[after] = 1;
      // An opener that sees the same character, of a run that both closes
      // and opens, may now need its own reference.
      if (opens && afterFirst === undefined) {
        pending.push(index);
      }
      if (
        (isEncoded(after) || isVariedByStart(after)) &&
        runAfter[after] !== -1
      ) {
        pending.push(runAfter[after]);
      }
    }
  }
  return [encodeStart, encodeEnd];
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
