/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$isListItemNode, $isListNode} from '@lexical/list';
import {$isQuoteNode} from '@lexical/rich-text';
import {
  $copyNode,
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $findMatchingParent,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isTabNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
  type LineBreakNode,
  type TextNode,
} from 'lexical';

import {leavesFormatOpen} from './importTextFormatTransformer';
import {$importTextTransformers} from './importTextTransformers';
import {
  $createMarkdownLineBreakNode,
  type ElementTransformer,
  type MultilineElementTransformer,
  parseMarkdownHardLineBreak,
  type TextFormatTransformer,
  type TextMatchTransformer,
  type Transformer,
  withListIndentColumns,
} from './MarkdownTransformers';
import {isEmptyParagraph, transformersByType} from './utils';

export type TextFormatTransformersIndex = Readonly<{
  fullMatchRegExpByTag: Readonly<Record<string, RegExp>>;
  openTagsRegExp: RegExp;
  transformersByTag: Readonly<Record<string, TextFormatTransformer>>;
}>;

/**
 * Parses a markdown string and appends the resulting nodes to `container`.
 * Does not clear the container or touch the selection — callers handle that.
 */
export function $importMarkdownNodes(
  markdownString: string,
  container: ElementNode,
  transformers: Transformer[],
  shouldPreserveNewLines = false,
): void {
  const byType = transformersByType(transformers);
  const textFormatTransformersIndex = createTextFormatTransformersIndex(
    byType.textFormat,
  );
  const lines = markdownString.split('\n');
  const linesLength = lines.length;
  // Lines that leave an emphasis or code span open, which the lines after
  // them may close. They wait here, unparsed, until it is known whether the
  // following lines continue them.
  const pending: PendingLines = {lines: [], text: ''};

  // A list line is measured against the column its parent item's content
  // starts at, which only the line that opened that level knows. Blank lines
  // between list lines make the list loose rather than ending it — except
  // when they are being preserved, where they are content like any block.
  withListIndentColumns(!shouldPreserveNewLines, () => {
    for (let i = 0; i < linesLength; i++) {
      const lineText = lines[i];

      const [imported, shiftedIndex] = $importMultiline(
        lines,
        i,
        byType.multilineElement,
        container,
      );

      if (imported) {
        $flushPendingLines(
          pending,
          textFormatTransformersIndex,
          byType.textMatch,
          shouldPreserveNewLines,
        );
        i = shiftedIndex;
        continue;
      }

      $importBlocks(
        lineText,
        container,
        byType.element,
        textFormatTransformersIndex,
        byType.textMatch,
        shouldPreserveNewLines,
        pending,
      );
    }
    $flushPendingLines(
      pending,
      textFormatTransformersIndex,
      byType.textMatch,
      shouldPreserveNewLines,
    );
  });

  const children = container.getChildren();
  for (const child of children) {
    if (
      !shouldPreserveNewLines &&
      isEmptyParagraph(child) &&
      container.getChildrenSize() > 1
    ) {
      child.remove();
      continue;
    }
    if ($isElementNode(child)) {
      for (const textNode of child.getAllTextNodes()) {
        $normalizeMarkdownTextNode(textNode);
      }
    }
  }
}

/**
 *
 * @returns first element of the returned tuple is a boolean indicating if a multiline element was imported. The second element is the index of the last line that was processed.
 */
function $importMultiline(
  lines: string[],
  startLineIndex: number,
  multilineElementTransformers: MultilineElementTransformer[],
  rootNode: ElementNode,
): [boolean, number] {
  for (const transformer of multilineElementTransformers) {
    const {handleImportAfterStartMatch, regExpEnd, regExpStart, replace} =
      transformer;

    const startMatch = lines[startLineIndex].match(regExpStart);
    if (!startMatch) {
      continue; // Try next transformer
    }

    if (handleImportAfterStartMatch) {
      const result = handleImportAfterStartMatch({
        lines,
        rootNode,
        startLineIndex,
        startMatch,
        transformer,
      });
      if (result === null) {
        continue;
      } else if (result) {
        return result;
      }
    }

    const regexpEndRegex: RegExp | undefined =
      typeof regExpEnd === 'object' && 'regExp' in regExpEnd
        ? regExpEnd.regExp
        : regExpEnd;

    const isEndOptional =
      regExpEnd && typeof regExpEnd === 'object' && 'optional' in regExpEnd
        ? regExpEnd.optional
        : !regExpEnd;

    let endLineIndex = startLineIndex;
    const linesLength = lines.length;

    // check every single line for the closing match. It could also be on the same line as the opening match.
    while (endLineIndex < linesLength) {
      const endMatch = regexpEndRegex
        ? lines[endLineIndex].match(regexpEndRegex)
        : null;
      if (!endMatch) {
        if (
          !isEndOptional ||
          (isEndOptional && endLineIndex < linesLength - 1) // Optional end, but didn't reach the end of the document yet => continue searching for potential closing match
        ) {
          endLineIndex++;
          continue; // Search next line for closing match
        }
      }

      // Now, check if the closing match matched is the same as the opening match.
      // If it is, we need to continue searching for the actual closing match.
      if (
        endMatch &&
        startLineIndex === endLineIndex &&
        endMatch.index === startMatch.index
      ) {
        endLineIndex++;
        continue; // Search next line for closing match
      }

      // At this point, we have found the closing match. Next: calculate the lines in between open and closing match
      // This should not include the matches themselves, and be split up by lines
      const linesInBetween = [];

      if (endMatch && startLineIndex === endLineIndex) {
        linesInBetween.push(
          lines[startLineIndex].slice(
            startMatch[0].length,
            -endMatch[0].length,
          ),
        );
      } else {
        for (let i = startLineIndex; i <= endLineIndex; i++) {
          if (i === startLineIndex) {
            const text = lines[i].slice(startMatch[0].length);
            linesInBetween.push(text); // Also include empty text
          } else if (i === endLineIndex && endMatch) {
            const text = lines[i].slice(0, -endMatch[0].length);
            linesInBetween.push(text); // Also include empty text
          } else {
            linesInBetween.push(lines[i]);
          }
        }
      }

      if (
        replace(rootNode, null, startMatch, endMatch, linesInBetween, true) !==
        false
      ) {
        // Return here. This $importMultiline function is run line by line and should only process a single multiline element at a time.
        return [true, endLineIndex];
      }

      // The replace function returned false, despite finding the matching open and close tags => this transformer does not want to handle it.
      // Thus, we continue letting the remaining transformers handle the passed lines of text from the beginning
      break;
    }
  }

  // No multiline transformer handled this line successfully
  return [false, startLineIndex];
}

// The most lines that are parsed as one string. Whether the lines so far leave
// something open is read from all of their text each time a line is added, so
// a delimiter that never closes would make a long paragraph cost far more than
// its length. An emphasis or code span that runs on for more lines than this
// is imported as literal text.
const MAX_JOINED_LINES = 100;

interface PendingLine {
  lineText: string;
  // The paragraph the line was imported as. It is not in the document when
  // an element transformer took the line (a heading, a list item, a quote).
  elementNode: ElementNode;
  textNode: TextNode;
}

interface PendingLines {
  lines: PendingLine[];
  // The text of the lines, read as one string.
  text: string;
}

function $importBlocks(
  lineText: string,
  rootNode: ElementNode,
  elementTransformers: ElementTransformer[],
  textFormatTransformersIndex: TextFormatTransformersIndex,
  textMatchTransformers: TextMatchTransformer[],
  shouldPreserveNewLines: boolean,
  pending: PendingLines,
) {
  const flush = () =>
    $flushPendingLines(
      pending,
      textFormatTransformersIndex,
      textMatchTransformers,
      shouldPreserveNewLines,
    );

  // A waiting line that is a paragraph of its own is not yet part of the
  // block it continues. An element transformer reads the block before the
  // line it imports, so it would find that paragraph instead of the quote or
  // list it should continue, so the waiting lines are imported first.
  if (
    pending.lines.length > 0 &&
    $isLinePlainParagraph(pending.lines[pending.lines.length - 1]) &&
    elementTransformers.some(({regExp}) => lineText.match(regExp) !== null)
  ) {
    flush();
  }

  const textNode = $createTextNode(lineText);
  const elementNode = $createParagraphNode();
  elementNode.append(textNode);
  rootNode.append(elementNode);

  for (const {regExp, replace} of elementTransformers) {
    const match = lineText.match(regExp);

    if (match) {
      textNode.setTextContent(lineText.slice(match[0].length));
      if (replace(elementNode, [textNode], match, true) !== false) {
        break;
      }
    }
  }

  const line: PendingLine = {elementNode, lineText, textNode};
  if (!shouldPreserveNewLines) {
    if (pending.lines.length > 0) {
      if (
        $continuesPendingLines(pending, line) &&
        $parsesWithoutBlock(
          textNode.getTextContent(),
          textFormatTransformersIndex,
          textMatchTransformers,
        )
      ) {
        // The emphasis or code span that the waiting lines left open may end
        // on this line.
        pending.lines.push(line);
        pending.text += '\n' + textNode.getTextContent();
        if (
          pending.lines.length >= MAX_JOINED_LINES ||
          !$leavesFormatOpen(pending.text, textFormatTransformersIndex)
        ) {
          flush();
        }
        return;
      }
      flush();
    }
    const text = textNode.getTextContent();
    if (
      $leavesFormatOpen(text, textFormatTransformersIndex) &&
      $parsesWithoutBlock(
        text,
        textFormatTransformersIndex,
        textMatchTransformers,
      )
    ) {
      pending.lines.push(line);
      pending.text = text;
      return;
    }
  }

  $importLine(
    line,
    textFormatTransformersIndex,
    textMatchTransformers,
    shouldPreserveNewLines,
  );
}

// Whether the line is still a paragraph of its own in the document.
function $isLinePlainParagraph({elementNode}: PendingLine): boolean {
  return elementNode.getParent() !== null;
}

// Whether `line` goes on in the paragraph, quote or list item that the
// waiting lines are in.
function $continuesPendingLines(
  pending: PendingLines,
  line: PendingLine,
): boolean {
  const [first] = pending.lines;
  const last = pending.lines[pending.lines.length - 1];
  const block = $isLinePlainParagraph(first)
    ? null
    : first.textNode.getParent();
  if (!$isLinePlainParagraph(line)) {
    // A quote transformer appends a line to the quote before it.
    return (
      block !== null &&
      !$isLinePlainParagraph(last) &&
      line.textNode.getParent() === block &&
      $isLineBreakNode(line.textNode.getPreviousSibling())
    );
  }
  const target = $getMergeTarget(line.elementNode, line.lineText);
  return target !== null && ($isLinePlainParagraph(last) || target === block);
}

// Parses the text of a line in the block it was imported as, then lets it
// continue the block before it where it can.
function $importLine(
  {elementNode, lineText, textNode}: PendingLine,
  textFormatTransformersIndex: TextFormatTransformersIndex,
  textMatchTransformers: TextMatchTransformer[],
  shouldPreserveNewLines: boolean,
): void {
  $importTextTransformers(
    textNode,
    textFormatTransformersIndex,
    textMatchTransformers,
  );

  // If no transformer found and we left with original paragraph node
  // can check if its content can be appended to the previous node
  // if it's a paragraph, quote or list
  const targetNode = shouldPreserveNewLines // Only append if we're not preserving newlines
    ? null
    : $getMergeTarget(elementNode, lineText);
  if (targetNode !== null) {
    targetNode.splice(targetNode.getChildrenSize(), 0, [
      $createMarkdownLineBreakNode(targetNode),
      ...elementNode.getChildren(),
    ]);
    elementNode.remove();
  }
}

// The block that the line of `elementNode` continues, if it is a plain line
// right after a paragraph, quote or list that it can be appended to.
function $getMergeTarget(
  elementNode: ElementNode,
  lineText: string,
): ElementNode | null {
  if (elementNode.getParent() === null || lineText.length === 0) {
    return null;
  }
  const previousNode = elementNode.getPreviousSibling();
  if (
    !$isParagraphNode(previousNode) &&
    !$isQuoteNode(previousNode) &&
    !$isListNode(previousNode)
  ) {
    return null;
  }
  let targetNode: ElementNode | null = previousNode;

  if ($isListNode(previousNode)) {
    const lastDescendant = previousNode.getLastDescendant();
    if (lastDescendant == null) {
      targetNode = null;
    } else {
      targetNode = $findMatchingParent(lastDescendant, $isListItemNode);
    }
  }

  return targetNode != null && targetNode.getTextContentSize() > 0
    ? targetNode
    : null;
}

/**
 * Whether a line can be parsed together with the lines around it. A text
 * match transformer that replaces the block of the line it matches (a block
 * equation, say) cannot work on text in a paragraph that is not in the
 * document, and such a line has to be imported on its own, in its own block.
 */
function $parsesWithoutBlock(
  text: string,
  textFormatTransformersIndex: TextFormatTransformersIndex,
  textMatchTransformers: TextMatchTransformer[],
): boolean {
  if (textMatchTransformers.length === 0) {
    return true;
  }
  const node = $createTextNode(text);
  $createParagraphNode().append(node);
  try {
    $importTextTransformers(
      node,
      textFormatTransformersIndex,
      textMatchTransformers,
    );
  } catch {
    return false;
  }
  return true;
}

// Whether something that was parsed holds a line ending: formatted text, a
// link text, the node of a text match, ... A line ending in plain text is no
// different from the ones between lines that were parsed one by one.
function $holdsLineEnding(node: LexicalNode, root: ElementNode): boolean {
  if ($isElementNode(node)) {
    return node.getChildren().some(child => $holdsLineEnding(child, root));
  }
  return (
    $isTextNode(node) &&
    !$isTabNode(node) &&
    node.getTextContent().includes('\n') &&
    !(
      node.getType() === 'text' &&
      node.getParent() === root &&
      node.getFormat() === 0 &&
      node.getDetail() === 0 &&
      node.getMode() === 'normal' &&
      node.getStyle() === ''
    )
  );
}

// Whether the text leaves an emphasis, a code span or a link text open.
function $leavesFormatOpen(
  text: string,
  textFormatTransformersIndex: TextFormatTransformersIndex,
): boolean {
  if (leavesFormatOpen(text, textFormatTransformersIndex)) {
    return true;
  }
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') {
      depth++;
    } else if (text[i] === ']' && depth > 0) {
      depth--;
    }
  }
  return depth > 0;
}

/**
 * Imports the lines that were waiting to see if the lines after them
 * continue them. CommonMark treats a line ending inside emphasis or a code
 * span as whitespace, so lines of one paragraph are parsed as one string and
 * split at the line endings again. A single line, and lines that cannot be
 * parsed that way, are imported as they are without this.
 */
function $flushPendingLines(
  pending: PendingLines,
  textFormatTransformersIndex: TextFormatTransformersIndex,
  textMatchTransformers: TextMatchTransformer[],
  shouldPreserveNewLines: boolean,
): void {
  const {lines} = pending;
  pending.lines = [];
  pending.text = '';
  if (
    lines.length > 1 &&
    $importJoinedLines(
      lines,
      textFormatTransformersIndex,
      textMatchTransformers,
    )
  ) {
    return;
  }
  for (const line of lines) {
    $importLine(
      line,
      textFormatTransformersIndex,
      textMatchTransformers,
      shouldPreserveNewLines,
    );
  }
}

/**
 * Parses the text of `lines` as one string and puts the result where the
 * lines are, separated by LineBreakNodes that keep the hard line break
 * marker (trailing spaces or a backslash) of their line.
 *
 * The string is parsed in a paragraph that is not in the document, so that
 * nothing has changed if the lines turn out not to fit. Then this returns
 * false, and the caller imports them one by one in the blocks they were
 * imported as. That is so when a transformer cannot work on a block without
 * a parent, and when a match consumed or produced a line ending (a link
 * title that spans lines, `&#10;`), since the markers are handed out to the
 * line endings that are left, in order.
 */
function $importJoinedLines(
  lines: PendingLine[],
  textFormatTransformersIndex: TextFormatTransformersIndex,
  textMatchTransformers: TextMatchTransformer[],
): boolean {
  const last = lines.length - 1;
  // Each line without its hard line break marker, which is taken off below.
  const text = lines
    .map(({textNode}, i) => {
      const lineText = textNode.getTextContent();
      const hardLineBreak =
        i < last ? parseMarkdownHardLineBreak(lineText) : null;
      return hardLineBreak !== null ? hardLineBreak[0] : lineText;
    })
    .join('\n');
  const scratch = $createParagraphNode();
  const joinedNode = $createTextNode(text);
  scratch.append(joinedNode);
  try {
    $importTextTransformers(
      joinedNode,
      textFormatTransformersIndex,
      textMatchTransformers,
    );
  } catch {
    return false;
  }
  if ($countNewlines(scratch) !== last || !$holdsLineEnding(scratch, scratch)) {
    return false;
  }

  // The lines that an element transformer put in a block (the first, and
  // the lines of a quote after it) come first, with the line break before
  // each of them already in place. The rest are paragraphs of their own.
  const inBlock = lines.filter(line => !$isLinePlainParagraph(line));
  const paragraphs = lines.filter($isLinePlainParagraph);
  const lineBreaks: LineBreakNode[] = [];
  for (let i = 0; i < last; i++) {
    const next = lines[i + 1];
    const existing = $isLinePlainParagraph(next)
      ? null
      : next.textNode.getPreviousSibling();
    lineBreaks.push(
      $isLineBreakNode(existing)
        ? existing
        : $createMarkdownLineBreakNode(
            $isLinePlainParagraph(lines[i])
              ? lines[i].elementNode
              : lines[i].textNode.getParentOrThrow(),
          ),
    );
  }
  for (const child of scratch.getChildren()) {
    $splitAtNewlines(child, lineBreaks);
  }

  const [first] = lines;
  let targetNode: ElementNode | null = null;
  if (inBlock.length > 0) {
    const block = first.textNode.getParentOrThrow();
    const start = first.textNode.getIndexWithinParent();
    const end = inBlock[inBlock.length - 1].textNode.getIndexWithinParent();
    for (const node of block.getChildren().slice(start, end + 1)) {
      node.remove();
    }
    block.splice(start, 0, scratch.getChildren());
  } else {
    targetNode = $getMergeTarget(first.elementNode, first.lineText);
    if (targetNode !== null) {
      targetNode.splice(targetNode.getChildrenSize(), 0, [
        $createMarkdownLineBreakNode(targetNode),
        ...scratch.getChildren(),
      ]);
    } else {
      first.elementNode.splice(0, 1, scratch.getChildren());
    }
  }
  // The paragraphs of the lines are empty now, or only hold the result when
  // the first line has no block to continue.
  for (const {elementNode} of paragraphs) {
    if (
      inBlock.length > 0 ||
      targetNode !== null ||
      elementNode !== first.elementNode
    ) {
      elementNode.remove();
    }
  }
  return true;
}

// The number of "\n" in the text below `node`.
function $countNewlines(node: LexicalNode): number {
  if ($isElementNode(node)) {
    let count = 0;
    for (const child of node.getChildren()) {
      count += $countNewlines(child);
    }
    return count;
  }
  if (!$isTextNode(node) || $isTabNode(node)) {
    return 0;
  }
  const text = node.getTextContent();
  let count = 0;
  for (
    let index = text.indexOf('\n');
    index !== -1;
    index = text.indexOf('\n', index + 1)
  ) {
    count++;
  }
  return count;
}

// Replaces each "\n" in the text below `node` with the next of `lineBreaks`.
// A text node is split by copying it, so that a subclass, its detail and its
// NodeState are kept in every piece, as `TextNode.splitText` does.
function $splitAtNewlines(
  node: LexicalNode,
  lineBreaks: LineBreakNode[],
): void {
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      $splitAtNewlines(child, lineBreaks);
    }
    return;
  }
  if (!$isTextNode(node) || $isTabNode(node)) {
    return;
  }
  const text = node.getTextContent();
  if (!text.includes('\n')) {
    return;
  }
  const nodes: LexicalNode[] = [];
  const pushText = (value: string) => {
    if (value !== '') {
      nodes.push($copyNode(node).setTextContent(value));
    }
  };
  let start = 0;
  for (
    let index = text.indexOf('\n');
    index !== -1;
    index = text.indexOf('\n', start)
  ) {
    pushText(text.slice(start, index));
    nodes.push(lineBreaks.shift() || $createLineBreakNode());
    start = index + 1;
  }
  pushText(text.slice(start));
  node.getParentOrThrow().splice(node.getIndexWithinParent(), 1, nodes);
}

// Look in node for '\t' and create a TabNode for each occurrence. The
// replacement nodes are built directly rather than through
// `splitText(...offsets)`: spreading one argument per tab boundary overflows
// the call stack on a long run of tabs, and the text can hold arbitrarily
// many.
function $normalizeMarkdownTextNode(textNode: TextNode): void {
  // A TabNode is a TextNode whose content is a tab, so without this guard the
  // rebuild below would destroy it and create an equivalent one in its place.
  if ($isTabNode(textNode)) {
    return;
  }
  const text = textNode.getTextContent();
  if (!text.includes('\t')) {
    return;
  }
  const format = textNode.getFormat();
  const style = textNode.getStyle();
  const nodes: LexicalNode[] = [];
  let start = 0;
  for (
    let index = text.indexOf('\t');
    index !== -1;
    index = text.indexOf('\t', index + 1)
  ) {
    if (index > start) {
      nodes.push(
        $createTextNode(text.slice(start, index))
          .setFormat(format)
          .setStyle(style),
      );
    }
    nodes.push($createTabNode());
    start = index + 1;
  }
  if (start < text.length) {
    nodes.push(
      $createTextNode(text.slice(start)).setFormat(format).setStyle(style),
    );
  }
  textNode.getParentOrThrow().splice(textNode.getIndexWithinParent(), 1, nodes);
}

function createTextFormatTransformersIndex(
  textTransformers: TextFormatTransformer[],
): TextFormatTransformersIndex {
  const transformersByTag: Record<string, TextFormatTransformer> = {};
  const fullMatchRegExpByTag: Record<string, RegExp> = {};
  const openTagsRegExp: string[] = [];

  for (const transformer of textTransformers) {
    const {tag} = transformer;
    transformersByTag[tag] = transformer;
    const tagRegExp = tag.replace(/(\*|\^|\+)/g, '\\$1');
    openTagsRegExp.push(tagRegExp);

    // Single-char tag (e.g. "*")
    if (tag.length === 1) {
      if (tag === '`') {
        // Capture the preceding character in group 1 (empty string at start-of-string
        // via the ^ branch) rather than using a negative lookbehind, which is not
        // supported in Safari < 16.4. Consumers must add match[1].length to
        // match.index to find the real start of the span (see importTextFormatTransformer.ts).
        fullMatchRegExpByTag[tag] = new RegExp(
          `(^|[^\\\\\`])(\`)((?:\\\\\`|[^\`])+?)(\`)(?!\`)`,
        );
      } else {
        fullMatchRegExpByTag[tag] = new RegExp(
          `(^|[^\\\\${tagRegExp}])(${tagRegExp})((\\\\${tagRegExp})?.*?[^${tagRegExp}\\s](\\\\${tagRegExp})?)(${tagRegExp})(?![\\\\${tagRegExp}])`,
        );
      }
    } else {
      // Multi-char tags (e.g. "**")
      fullMatchRegExpByTag[tag] = new RegExp(
        `(^|[^\\\\])(${tagRegExp})((\\\\${tagRegExp})?.*?[^\\s](\\\\${tagRegExp})?)(${tagRegExp})(?!\\\\)`,
      );
    }
  }

  return {
    // Reg exp to find open tag + content + close tag
    fullMatchRegExpByTag,

    // Regexp to locate *any* potential opening tag (longest first).
    // The former (?<!\\) escape guard has been removed — the delimiter
    // scanner's isEscaped() check handles escape filtering at match time.
    openTagsRegExp: new RegExp(`(${openTagsRegExp.join('|')})`, 'g'),
    transformersByTag,
  };
}
