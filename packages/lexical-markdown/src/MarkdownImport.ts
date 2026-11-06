/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$isListItemNode, $isListNode, type ListItemNode} from '@lexical/list';
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

import {$importTextTransformers} from './importTextTransformers';
import {
  $createMarkdownLineBreakNode,
  type ElementTransformer,
  type MultilineElementTransformer,
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
  // The raw text node of every line imported as a block. Inline markdown is
  // parsed only once all lines are in place, because emphasis and code spans
  // may continue across the line break between two lines of a paragraph.
  const rawLineNodes: TextNode[] = [];

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
        i = shiftedIndex;
        continue;
      }

      $importBlocks(
        lineText,
        container,
        byType.element,
        shouldPreserveNewLines,
        rawLineNodes,
      );
    }
  });

  $importInlineMarkdown(
    rawLineNodes,
    textFormatTransformersIndex,
    byType.textMatch,
  );

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

function $importBlocks(
  lineText: string,
  rootNode: ElementNode,
  elementTransformers: ElementTransformer[],
  shouldPreserveNewLines: boolean,
  rawLineNodes: TextNode[],
) {
  const textNode = $createTextNode(lineText);
  rawLineNodes.push(textNode);
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

  // If no transformer found and we left with original paragraph node
  // can check if its content can be appended to the previous node
  // if it's a paragraph, quote or list
  if (elementNode.getParent() !== null && lineText.length > 0) {
    const previousNode = elementNode.getPreviousSibling();
    if (
      !shouldPreserveNewLines && // Only append if we're not preserving newlines
      ($isParagraphNode(previousNode) ||
        $isQuoteNode(previousNode) ||
        $isListNode(previousNode))
    ) {
      let targetNode: typeof previousNode | ListItemNode | null = previousNode;

      if ($isListNode(previousNode)) {
        const lastDescendant = previousNode.getLastDescendant();
        if (lastDescendant == null) {
          targetNode = null;
        } else {
          targetNode = $findMatchingParent(lastDescendant, $isListItemNode);
        }
      }

      if (targetNode != null && targetNode.getTextContentSize() > 0) {
        targetNode.splice(targetNode.getChildrenSize(), 0, [
          $createMarkdownLineBreakNode(targetNode),
          ...elementNode.getChildren(),
        ]);
        elementNode.remove();
      }
    }
  }
}

/**
 * Parses the inline markdown (emphasis, code spans, links, ...) of the text
 * nodes created by `$importBlocks`.
 *
 * Lines that were merged into one block are separated by LineBreakNodes.
 * CommonMark treats a line ending inside emphasis or a code span as ordinary
 * whitespace, so a delimiter opened on one line may be closed on a later one.
 * Consecutive lines are therefore parsed as a single string for as long as
 * the lines so far leave a delimiter open, and are split back into text and
 * LineBreakNodes afterwards. Every other line is parsed on its own, which
 * keeps the cost of a long paragraph linear in its number of lines.
 */
function $importInlineMarkdown(
  rawLineNodes: TextNode[],
  textFormatTransformersIndex: TextFormatTransformersIndex,
  textMatchTransformers: TextMatchTransformer[],
): void {
  const rawKeys = new Set(rawLineNodes.map(node => node.getKey()));
  const handled = new Set<string>();
  const delimiters = Object.keys(textFormatTransformersIndex.transformersByTag);

  for (const textNode of rawLineNodes) {
    const key = textNode.getKey();
    if (handled.has(key) || textNode.getParent() === null) {
      continue;
    }
    handled.add(key);

    // Collect the lines that continue this one: raw text nodes joined by
    // LineBreakNodes, for as long as the text so far has a delimiter open.
    const lineNodes: TextNode[] = [textNode];
    const lineBreaks: LineBreakNode[] = [];
    let text = textNode.getTextContent();
    while ($hasOpenDelimiter(text, delimiters)) {
      const lineBreak = lineNodes[lineNodes.length - 1].getNextSibling();
      const next = lineBreak && lineBreak.getNextSibling();
      if (
        !$isLineBreakNode(lineBreak) ||
        !$isTextNode(next) ||
        !rawKeys.has(next.getKey())
      ) {
        break;
      }
      handled.add(next.getKey());
      lineBreaks.push(lineBreak);
      lineNodes.push(next);
      text += '\n' + next.getTextContent();
    }

    if (
      lineNodes.length > 1 &&
      $importJoinedLines(
        lineNodes,
        lineBreaks,
        textFormatTransformersIndex,
        textMatchTransformers,
      )
    ) {
      continue;
    }
    for (const node of lineNodes) {
      $importLineApart(
        node,
        textFormatTransformersIndex,
        textMatchTransformers,
      );
    }
  }
}

/**
 * Parses the text of `node` in a paragraph of its own and moves the result
 * back to where `node` was. The block that holds a long paragraph has a
 * child for every line, and the transformers look up the position of the
 * nodes they split and replace, which would make every line cost as much as
 * the whole block is long.
 */
function $importLineApart(
  node: TextNode,
  textFormatTransformersIndex: TextFormatTransformersIndex,
  textMatchTransformers: TextMatchTransformer[],
): void {
  const scratch = $createParagraphNode();
  const previous = node.getPreviousSibling();
  const next = node.getNextSibling();
  const parent = node.getParentOrThrow();
  scratch.append(node);
  $importTextTransformers(
    node,
    textFormatTransformersIndex,
    textMatchTransformers,
  );
  $putBack(scratch.getChildren(), parent, previous, next);
}

// Puts `nodes` into `parent`, between `previous` and `next`.
function $putBack(
  nodes: LexicalNode[],
  parent: ElementNode,
  previous: LexicalNode | null,
  next: LexicalNode | null,
): void {
  let anchor = previous;
  for (const node of nodes) {
    if (anchor !== null) {
      anchor.insertAfter(node, false);
    } else if (next !== null) {
      next.insertBefore(node, false);
    } else {
      parent.append(node);
    }
    anchor = node;
  }
}

/**
 * Whether `text` has a delimiter that is probably not closed in it: a text
 * format tag that occurs an odd number of times, or a `[` without its `]`.
 * Escapes are not taken into account, so this errs on the side of reporting
 * an open delimiter, which only costs the lines being parsed together.
 */
function $hasOpenDelimiter(text: string, tags: string[]): boolean {
  for (const tag of tags) {
    let count = 0;
    for (
      let index = text.indexOf(tag);
      index !== -1;
      index = text.indexOf(tag, index + tag.length)
    ) {
      count++;
    }
    if (count % 2 === 1) {
      return true;
    }
  }
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '[') {
      depth++;
    } else if (character === ']' && depth > 0) {
      depth--;
    }
  }
  return depth > 0;
}

/**
 * Parses `lineNodes` (adjacent lines of one block, separated by `lineBreaks`)
 * as one string and puts the result in their place. The result is first built
 * apart from the document, so that nothing has changed if it turns out that
 * the lines cannot be put back, in which case this returns false.
 *
 * The original LineBreakNodes are reused, in order, so that the hard line
 * break marker each one carries (trailing spaces or a backslash) is kept on
 * its own line. That only holds while every "\n" left after parsing is a line
 * ending, which is not so when a match consumes one (a link title that spans
 * lines) or produces one (`&#10;`). Then the lines are parsed one by one.
 */
function $importJoinedLines(
  lineNodes: TextNode[],
  lineBreaks: LineBreakNode[],
  textFormatTransformersIndex: TextFormatTransformersIndex,
  textMatchTransformers: TextMatchTransformer[],
): boolean {
  const scratch = $createParagraphNode();
  const joinedNode = $createTextNode(
    lineNodes.map(node => node.getTextContent()).join('\n'),
  );
  scratch.append(joinedNode);
  $importTextTransformers(
    joinedNode,
    textFormatTransformersIndex,
    textMatchTransformers,
  );
  if ($countNewlines(scratch) !== lineBreaks.length) {
    return false;
  }

  for (const lineBreak of lineBreaks) {
    lineBreak.remove();
  }
  const remainingLineBreaks = lineBreaks.slice();
  for (const child of scratch.getChildren()) {
    $splitAtNewlines(child, remainingLineBreaks);
  }
  const parent = lineNodes[0].getParentOrThrow();
  const previous = lineNodes[0].getPreviousSibling();
  const next = lineNodes[lineNodes.length - 1].getNextSibling();
  for (const node of lineNodes) {
    node.remove();
  }
  $putBack(scratch.getChildren(), parent, previous, next);
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
