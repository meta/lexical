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
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $findMatchingParent,
  $isElementNode,
  $isParagraphNode,
  $isTabNode,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';

import {importTextTransformers} from './importTextTransformers';
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
        textFormatTransformersIndex,
        byType.textMatch,
        shouldPreserveNewLines,
      );
    }
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

function $importBlocks(
  lineText: string,
  rootNode: ElementNode,
  elementTransformers: ElementTransformer[],
  textFormatTransformersIndex: TextFormatTransformersIndex,
  textMatchTransformers: TextMatchTransformer[],
  shouldPreserveNewLines: boolean,
) {
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

  importTextTransformers(
    textNode,
    textFormatTransformersIndex,
    textMatchTransformers,
  );

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
