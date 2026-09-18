/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {$createCodeNode, CodeNode} from '@lexical/code-core';
import {createHeadlessEditor} from '@lexical/headless';
import {$generateHtmlFromNodes, $generateNodesFromDOM} from '@lexical/html';
import invariant from '@lexical/internal/invariant';
import {$createLinkNode, $isLinkNode, LinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {
  $convertFromMarkdownString,
  $convertSelectionToMarkdownString,
  $convertToMarkdownString,
  $generateNodesFromMarkdownString,
  CHECK_LIST,
  CODE,
  type ElementTransformer,
  HEADING,
  LINK,
  type MultilineElementTransformer,
  registerMarkdownShortcuts,
  type TextMatchTransformer,
  type Transformer,
  TRANSFORMERS,
} from '@lexical/markdown';
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
  HeadingNode,
  QuoteNode,
} from '@lexical/rich-text';
import {
  $addUpdateTag,
  $copyNode,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getCaretRange,
  $getRoot,
  $getSelection,
  $getState,
  $getTextPointCaret,
  $insertNodes,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  $setSelectionFromCaretRange,
  $setState,
  COMPOSITION_END_TAG,
  type CreateEditorArgs,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  TEXT_TYPE_TO_FORMAT,
  type TextNode,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

import {
  hardLineBreakState,
  listMarkerState,
  normalizeMarkdown,
  parseMarkdownHardLineBreak,
} from '../../MarkdownTransformers';

/**
 * An error thrown inside `editor.update` or `editor.read` is routed to the
 * editor's `onError` handler rather than rethrown, and `createHeadlessEditor`
 * defaults that handler to `console.error` — so a failed assertion inside one
 * would log and pass. Every editor in this file throws instead, the way
 * `buildEditorFromExtensions` does by default.
 */
function createTestEditor(
  config: CreateEditorArgs | undefined = {},
): LexicalEditor {
  return createHeadlessEditor({
    nodes: [HeadingNode, ListNode, ListItemNode, QuoteNode, CodeNode, LinkNode],
    ...config,
    onError(error) {
      throw error;
    },
  });
}

const HIGHLIGHT_TEXT_MATCH_IMPORT: TextMatchTransformer = {
  ...LINK,
  importRegExp: /\$([^$]+?)\$/,
  replace: (textNode, match) => {
    textNode.toggleFormat('highlight');
  },
};

const SIMPLE_INLINE_JSX_MATCHER: TextMatchTransformer = {
  dependencies: [LinkNode],
  getEndIndex(node, match) {
    // Find the closing tag. Count the number of opening and closing tags to find the correct closing tag.
    // For simplicity, this will only count the opening and closing tags without checking for "MyTag" specifically.
    let openedSubStartMatches = 0;
    const start = (match.index ?? 0) + match[0].length;
    let endIndex = start;
    const line = node.getTextContent();

    for (let i = start; i < line.length; i++) {
      const char = line[i];
      if (char === '<') {
        const nextChar = line[i + 1];
        if (nextChar === '/') {
          if (openedSubStartMatches === 0) {
            endIndex = i + '</MyTag>'.length;
            break;
          }
          openedSubStartMatches--;
        } else {
          openedSubStartMatches++;
        }
      }
    }
    return endIndex;
  },
  importRegExp: /<(MyTag)\s*>/,
  regExp: /__ignore__/,
  replace: (textNode, match) => {
    const linkNode = $createLinkNode('simple-jsx');

    const textStart = match[0].length + (match.index ?? 0);
    const textEnd =
      (match.index ?? 0) + textNode.getTextContent().length - '</MyTag>'.length;
    const text = match.input?.slice(textStart, textEnd);

    const linkTextNode = $createTextNode(text);
    linkTextNode.setFormat(textNode.getFormat());
    linkNode.append(linkTextNode);
    textNode.replace(linkNode);
  },
  type: 'text-match',
};

// Matches html within a mdx file
const MDX_HTML_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [CodeNode],
  export: node => {
    if (node.getTextContent().startsWith('From HTML:')) {
      return `<MyComponent>${node
        .getTextContent()
        .replace('From HTML: ', '')}</MyComponent>`;
    }
    return null; // Run next transformer
  },
  regExpEnd: /<\/(\w+)\s*>/,
  regExpStart: /<(\w+)[^>]*>/,
  replace: (rootNode, children, startMatch, endMatch, linesInBetween) => {
    if (!linesInBetween) {
      return false; // Run next transformer. We don't need to support markdown shortcuts for this test
    }
    if (startMatch[1] === 'MyComponent') {
      const codeBlockNode = $createCodeNode(startMatch[1]);
      const textNode = $createTextNode(
        'From HTML: ' + linesInBetween.join('\n'),
      );
      codeBlockNode.append(textNode);
      rootNode.append(codeBlockNode);
      return;
    }
    return false; // Run next transformer
  },
  type: 'multiline-element',
};

const CODE_TAG_COUNTER_EXAMPLE: MultilineElementTransformer = {
  dependencies: CODE.dependencies,
  export: CODE.export,
  handleImportAfterStartMatch({lines, rootNode, startLineIndex, startMatch}) {
    const regexpEndRegex: RegExp | undefined = /[ \t]*```$/;

    const isEndOptional = false;

    let endLineIndex = startLineIndex;
    const linesLength = lines.length;

    let openedSubStartMatches = 0;

    // check every single line for the closing match. It could also be on the same line as the opening match.
    while (endLineIndex < linesLength) {
      const potentialSubStartMatch =
        lines[endLineIndex].match(/^[ \t]*```(\w+)?/);

      const endMatch = regexpEndRegex
        ? lines[endLineIndex].match(regexpEndRegex)
        : null;

      if (potentialSubStartMatch) {
        if (endMatch) {
          if ((potentialSubStartMatch.index ?? 0) < (endMatch.index ?? 0)) {
            openedSubStartMatches++;
          }
        } else {
          openedSubStartMatches++;
        }
      }

      if (endMatch) {
        openedSubStartMatches--;
      }

      if (!endMatch || openedSubStartMatches > 0) {
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
      const linesInBetween: string[] = [];

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
        CODE.replace(
          rootNode,
          null,
          startMatch,
          endMatch,
          linesInBetween,
          true,
        ) !== false
      ) {
        // Return here. This $importMultiline function is run line by line and should only process a single multiline element at a time.
        return [true, endLineIndex];
      }

      // The replace function returned false, despite finding the matching open and close tags => this transformer does not want to handle it.
      // Thus, we continue letting the remaining transformers handle the passed lines of text from the beginning
      break;
    }

    // No multiline transformer handled this line successfully
    return [false, startLineIndex];
  },
  regExpStart: CODE.regExpStart,
  replace: CODE.replace,
  type: 'multiline-element',
};

export const CANCELED_HEADING_REPLACE_EXAMPLE: ElementTransformer = {
  dependencies: [HeadingNode],
  export: () => {
    return null;
  },
  regExp: /^(#{1,6})\s/,
  replace: () => {
    return false;
  },
  type: 'element',
};

describe('Markdown', () => {
  type Input = {
    html: string;
    md: string;
    skipExport?: true;
    skipImport?: true;
    shouldPreserveNewLines?: true;
    shouldMergeAdjacentLines?: true | false;
    customTransformers?: Transformer[];
    mdAfterExport?: string;
  }[];

  const URL = 'https://lexical.dev';

  const IMPORT_AND_EXPORT: Input = [
    {
      html: '<h1><span style="white-space: pre-wrap;">Hello world</span></h1>',
      md: '# Hello world',
    },
    {
      html: '<h2><span style="white-space: pre-wrap;">Hello world</span></h2>',
      md: '## Hello world',
    },
    {
      html: '<h3><span style="white-space: pre-wrap;">Hello world</span></h3>',
      md: '### Hello world',
    },
    {
      html: '<h4><span style="white-space: pre-wrap;">Hello world</span></h4>',
      md: '#### Hello world',
    },
    {
      html: '<h5><span style="white-space: pre-wrap;">Hello world</span></h5>',
      md: '##### Hello world',
    },
    {
      html: '<h6><span style="white-space: pre-wrap;">Hello world</span></h6>',
      md: '###### Hello world',
    },
    {
      // Multiline paragraphs: https://spec.commonmark.org/dingus/?text=Hello%0Aworld%0A!
      html: '<p><span style="white-space: pre-wrap;">Hello world !</span></p>',
      md: ['Hello', 'world', '!'].join('\n'),
      shouldMergeAdjacentLines: true,
      skipExport: true,
    },
    {
      // Multiline paragraphs
      // TO-DO: It would be nice to support also hard line breaks (<br>) as \ or double spaces
      // See https://spec.commonmark.org/0.31.2/#hard-line-breaks.
      // Example: '<p><span style="white-space: pre-wrap;">Hello\\\nworld\\\n!</span></p>',
      html: '<p><span style="white-space: pre-wrap;">Hello<br>world<br>!</span></p>',
      md: ['Hello', 'world', '!'].join('\n'),
      skipImport: true,
    },
    {
      html: '<blockquote><span style="white-space: pre-wrap;">Hello</span><br><span style="white-space: pre-wrap;">world!</span></blockquote>',
      md: '> Hello\n> world!',
    },
    // TO-DO: <br> should be preserved
    // {
    //   html: '<ul><li value="1"><span style="white-space: pre-wrap;">Hello</span></li><li value="2"><span style="white-space: pre-wrap;">world<br>!<br>!</span></li></ul>',
    //   md: '- Hello\n- world<br>!<br>!',
    //   skipImport: true,
    // },
    {
      // Multiline list items: https://spec.commonmark.org/dingus/?text=-%20Hello%0A-%20world%0A!%0A!
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">Hello</span></li><li value="2"><span style="white-space: pre-wrap;">world ! !</span></li></ul>',
      md: '- Hello\n- world\n!\n!',
      shouldMergeAdjacentLines: true,
      skipExport: true,
    },
    {
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">Hello</span></li><li value="2"><span style="white-space: pre-wrap;">world</span></li></ul>',
      md: '- Hello\n- world',
    },
    {
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">Level 1</span><ul><li value="1"><span style="white-space: pre-wrap;">Level 2</span><ul><li value="1"><span style="white-space: pre-wrap;">Level 3</span></li></ul></li></ul></li></ul><p><span style="white-space: pre-wrap;">Hello world</span></p>',
      md: '- Level 1\n    - Level 2\n        - Level 3\n\nHello world',
    },
    // List indentation with tabs, Import only: export will use "    " only for one level of indentation
    {
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">Level 1</span><ul><li value="1"><span style="white-space: pre-wrap;">Level 2</span><ul><li value="1"><span style="white-space: pre-wrap;">Level 3</span></li></ul></li></ul></li></ul><p><span style="white-space: pre-wrap;">Hello world</span></p>',
      md: '- Level 1\n\t- Level 2\n  \t  - Level 3\n\nHello world',
      skipExport: true,
    },
    {
      // Import only: export will use "-" instead of "*"
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">Level 1</span><ul><li value="1"><span style="white-space: pre-wrap;">Level 2</span><ul><li value="1"><span style="white-space: pre-wrap;">Level 3</span></li></ul></li></ul></li></ul><p><span style="white-space: pre-wrap;">Hello world</span></p>',
      md: '* Level 1\n    * Level 2\n        * Level 3\n\nHello world',
      skipExport: true,
    },
    {
      // Bullet list item starting with number-dot pattern should be escaped (#7824)
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">1. foo</span></li></ul>',
      md: '- 1\\. foo',
    },
    {
      html: '<ol><li value="1"><span style="white-space: pre-wrap;">Hello</span></li><li value="2"><span style="white-space: pre-wrap;">world</span></li></ol>',
      md: '1. Hello\n2. world',
    },
    {
      html: '<ol start="25"><li value="25"><span style="white-space: pre-wrap;">Hello</span></li><li value="26"><span style="white-space: pre-wrap;">world</span></li></ol>',
      md: '25. Hello\n26. world',
    },
    {
      // ...including a check list among the sublist types.
      customTransformers: [CHECK_LIST],
      html: '<ol><li value="1"><span style="white-space: pre-wrap;">item one</span></li><li value="2"><span style="white-space: pre-wrap;">item two</span><ul><li value="1"><span style="white-space: pre-wrap;">sublist</span></li></ul><ol><li value="1"><span style="white-space: pre-wrap;">sublist</span></li></ol><ul __lexicallisttype="check"><li role="checkbox" tabindex="-1" aria-checked="false" value="1"><span style="white-space: pre-wrap;">checklist</span></li></ul></li></ol>',
      md: '1. item one\n2. item two\n    - sublist\n    1. sublist\n    - [ ] checklist',
    },
    {
      // The sublist keeps its own bullet character. Import only: the marker
      // does not survive a trip through HTML, so export writes "-".
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">a</span><ul><li value="1"><span style="white-space: pre-wrap;">b</span></li><li value="2"><span style="white-space: pre-wrap;">c</span></li></ul></li></ul>',
      md: '- a\n    * b\n    * c',
      skipExport: true,
    },
    {
      // A sublist is measured against the column its parent item's content
      // starts at, so two spaces are enough under `- ` and three under
      // `1. `. Export always writes four.
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">a</span><ul><li value="1"><span style="white-space: pre-wrap;">b</span></li></ul></li></ul>',
      md: '- a\n  - b',
      mdAfterExport: '- a\n    - b',
    },
    {
      html: '<ol><li value="1"><span style="white-space: pre-wrap;">a</span><ul><li value="1"><span style="white-space: pre-wrap;">b</span></li></ul></li></ol>',
      md: '1. a\n   - b',
      mdAfterExport: '1. a\n    - b',
    },
    {
      html: '<ol><li value="1"><span style="white-space: pre-wrap;">item one</span></li><li value="2"><span style="white-space: pre-wrap;">item two</span><ul><li value="1"><span style="white-space: pre-wrap;">sublist</span></li></ul><ol><li value="1"><span style="white-space: pre-wrap;">sublist</span></li></ol></li></ol>',
      md: '1. item one\n2. item two\n   - sublist\n   1. sublist',
      mdAfterExport: '1. item one\n2. item two\n    - sublist\n    1. sublist',
    },
    {
      // A marker wider than the indent that is exported for it still takes
      // that indent as a sublist.
      html: '<ol start="100"><li value="100"><span style="white-space: pre-wrap;">a</span><ul><li value="1"><span style="white-space: pre-wrap;">b</span></li></ul></li></ol>',
      md: '100. a\n    - b',
    },
    {
      // Every level is measured against its own parent's content column, not
      // just the first: two-space nesting keeps all four levels apart.
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">a</span><ul><li value="1"><span style="white-space: pre-wrap;">b</span><ul><li value="1"><span style="white-space: pre-wrap;">c</span><ul><li value="1"><span style="white-space: pre-wrap;">d</span></li></ul></li></ul></li></ul></li></ul>',
      md: '- a\n  - b\n    - c\n      - d',
      mdAfterExport: '- a\n    - b\n        - c\n            - d',
    },
    {
      html: '<ol><li value="1"><span style="white-space: pre-wrap;">a</span><ol><li value="1"><span style="white-space: pre-wrap;">b</span><ol><li value="1"><span style="white-space: pre-wrap;">c</span></li></ol></li></ol></li></ol>',
      md: '1. a\n   1. b\n      1. c',
      mdAfterExport: '1. a\n    1. b\n        1. c',
    },
    {
      // ...while items written at the same column stay siblings, however deep
      // that column is.
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">a</span><ul><li value="1"><span style="white-space: pre-wrap;">b</span></li><li value="2"><span style="white-space: pre-wrap;">c</span></li></ul></li></ul>',
      md: '- a\n    - b\n    - c',
    },
    {
      // A wider marker opens its content further along, so the indent that
      // nests under `9. ` is one short of the one that nests under `10. `.
      html: '<ol start="9"><li value="9"><span style="white-space: pre-wrap;">a</span><ul><li value="1"><span style="white-space: pre-wrap;">b</span></li></ul></li></ol>',
      md: '9. a\n   - b',
      mdAfterExport: '9. a\n    - b',
    },
    {
      html: '<ol start="10"><li value="10"><span style="white-space: pre-wrap;">a</span><ul><li value="1"><span style="white-space: pre-wrap;">b</span></li></ul></li></ol>',
      md: '10. a\n    - b',
    },
    {
      // A line that follows a paragraph closes the levels above it.
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">a</span></li></ul><p><span style="white-space: pre-wrap;">text</span></p><ol><li value="1"><span style="white-space: pre-wrap;">c</span><ul><li value="1"><span style="white-space: pre-wrap;">d</span></li></ul></li></ol>',
      md: '- a\n\ntext\n\n1. c\n   - d',
      mdAfterExport: '- a\n\ntext\n\n1. c\n    - d',
    },
    {
      // A blank line only makes the list loose. It does not close the levels
      // above it, so the same sublist is read the same way written tightly or
      // with a blank line before it.
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">a</span><ul><li value="1"><span style="white-space: pre-wrap;">b</span></li></ul></li></ul>',
      md: '- a\n\n  - b',
      mdAfterExport: '- a\n    - b',
    },
    {
      // ...and the loose sublist lands inside the item above it, exactly as
      // the tight spelling does.
      html: '<ol><li value="1"><span style="white-space: pre-wrap;">First</span><ul><li value="1"><span style="white-space: pre-wrap;">detail</span></li></ul></li></ol>',
      md: '1. First\n\n   - detail',
      mdAfterExport: '1. First\n    - detail',
    },
    {
      // A block of another kind does close them, blank lines or not.
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">a</span></li></ul><p><span style="white-space: pre-wrap;">text</span></p><ul><li value="1"><span style="white-space: pre-wrap;">b</span></li></ul>',
      md: '- a\n\ntext\n\n  - b',
      mdAfterExport: '- a\n\ntext\n\n- b',
    },
    {
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">bullet1</span><ol><li value="1"><span style="white-space: pre-wrap;">ordered1</span></li><li value="2"><span style="white-space: pre-wrap;">ordered2</span></li></ol></li><li value="2"><span style="white-space: pre-wrap;">bullet2</span></li></ul>',
      md: '- bullet1\n    1. ordered1\n    2. ordered2\n- bullet2',
    },
    {
      html: '<ol><li value="1"><span style="white-space: pre-wrap;">ordered1</span><ul><li value="1"><span style="white-space: pre-wrap;">bullet1</span></li><li value="2"><span style="white-space: pre-wrap;">bullet2</span></li></ul></li><li value="2"><span style="white-space: pre-wrap;">ordered2</span></li></ol>',
      md: '1. ordered1\n    - bullet1\n    - bullet2\n2. ordered2',
    },
    {
      html: '<ul><li value="1"><span style="white-space: pre-wrap;">a</span><ol><li value="1"><span style="white-space: pre-wrap;">b</span><ul><li value="1"><span style="white-space: pre-wrap;">c</span></li><li value="2"><span style="white-space: pre-wrap;">d</span></li></ul></li><li value="2"><span style="white-space: pre-wrap;">e</span></li></ol></li><li value="2"><span style="white-space: pre-wrap;">f</span></li></ul>',
      md: '- a\n    1. b\n        - c\n        - d\n    2. e\n- f',
    },
    {
      html: '<ol><li value="1"><span style="white-space: pre-wrap;">item one</span></li><li value="2"><span style="white-space: pre-wrap;">item two</span><ul><li value="1"><span style="white-space: pre-wrap;">sublist bullet</span></li></ul><ol><li value="1"><span style="white-space: pre-wrap;">sublist ordered</span></li></ol></li></ol>',
      md: '1. item one\n2. item two\n    - sublist bullet\n    1. sublist ordered',
    },
    {
      html: '<p><i><em style="white-space: pre-wrap;">Hello</em></i><span style="white-space: pre-wrap;"> world</span></p>',
      md: '*Hello* world',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">Hello</strong></b><span style="white-space: pre-wrap;"> world</span></p>',
      md: '**Hello** world',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">Bold label:</strong></b><span style="white-space: pre-wrap;">&nbsp;Following paragraph text.</span></p>',
      md: '**Bold label:**\u00A0Following paragraph text.',
      skipExport: true,
    },
    {
      html: '<p><i><b><strong style="white-space: pre-wrap;">Hello</strong></b></i><span style="white-space: pre-wrap;"> world</span></p>',
      md: '***Hello*** world',
    },
    {
      html: '<p><code spellcheck="false" style="white-space: pre-wrap;"><span>Hello</span></code><span style="white-space: pre-wrap;"> world</span></p>',
      md: '`Hello` world',
    },
    {
      html: '<p><code spellcheck="false" style="white-space: pre-wrap;"><span>Backtick\\</span></code><span style="white-space: pre-wrap;"> after backslash</span></p>',
      md: '`Backtick\\` after backslash',
    },
    {
      html: '<p><code spellcheck="false" style="white-space: pre-wrap;"><span>Backtick</span></code><span style="white-space: pre-wrap;">\\ before backslash</span></p>',
      md: '`Backtick`\\\\ before backslash',
    },
    {
      html: '<p><s><span style="white-space: pre-wrap;">Hello</span></s><span style="white-space: pre-wrap;"> world</span></p>',
      md: '~~Hello~~ world',
    },
    {
      html: '<p><code spellcheck="false" style="white-space: pre-wrap;"><span>hello$</span></code></p>',
      md: '`hello$`',
    },
    {
      html: '<p><code spellcheck="false" style="white-space: pre-wrap;"><span>$$hello</span></code></p>',
      md: '`$$hello`',
    },
    {
      // Code spans bind tighter than text-match transformers, so the $...$
      // (HIGHLIGHT_TEXT_MATCH_IMPORT) must not consume across the code spans.
      // https://github.com/facebook/lexical/issues/8687
      html: '<p><code spellcheck="false" style="white-space: pre-wrap;"><span>$a</span></code><span style="white-space: pre-wrap;"> </span><code spellcheck="false" style="white-space: pre-wrap;"><span>$b</span></code></p>',
      md: '`$a` `$b`',
    },
    {
      // Inline code containing a backtick must use a longer fence (CommonMark
      // code spans) and pad with spaces so it round-trips losslessly.
      html: '<p><span style="white-space: pre-wrap;">Here: </span><code spellcheck="false" style="white-space: pre-wrap;"><span>a`b</span></code></p>',
      md: 'Here: `` a`b ``',
    },
    {
      // Two consecutive backticks in the content bump the fence to three.
      html: '<p><span style="white-space: pre-wrap;">Code: </span><code spellcheck="false" style="white-space: pre-wrap;"><span>a``b</span></code></p>',
      md: 'Code: ``` a``b ```',
    },
    {
      // Content beginning with a backtick is padded so the fence stays distinct.
      html: '<p><code spellcheck="false" style="white-space: pre-wrap;"><span>`x</span></code></p>',
      md: '`` `x ``',
    },
    {
      // The code fence must remain the innermost wrapping, inside bold.
      html: '<p><b><code spellcheck="false" style="white-space: pre-wrap;"><strong>a`b</strong></code></b></p>',
      md: '**`` a`b ``**',
    },
    {
      html: '<p><a href="https://lexical.dev"><span style="white-space: pre-wrap;">Hello</span></a><span style="white-space: pre-wrap;"> world</span></p>',
      md: '[Hello](https://lexical.dev) world',
    },
    {
      html: '<p><a href="https://lexical.dev" title="Hello world"><span style="white-space: pre-wrap;">Hello</span></a><span style="white-space: pre-wrap;"> world</span></p>',
      md: '[Hello](https://lexical.dev "Hello world") world',
    },
    {
      html: '<p><a href="https://lexical.dev" title="Title with &quot; escaped character"><span style="white-space: pre-wrap;">Hello</span></a><span style="white-space: pre-wrap;"> world</span></p>',
      md: '[Hello](https://lexical.dev "Title with \\" escaped character") world',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">Hello </span><s><i><b><strong style="white-space: pre-wrap;">world</strong></b></i></s><span style="white-space: pre-wrap;">!</span></p>',
      md: 'Hello ***~~world~~***!',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">Hello </strong></b><s><b><strong style="white-space: pre-wrap;">world</strong></b></s><span style="white-space: pre-wrap;">!</span></p>',
      md: '**Hello ~~world~~**!',
    },
    {
      html: '<p><s><b><strong style="white-space: pre-wrap;">Hello </strong></b></s><s><i><b><strong style="white-space: pre-wrap;">world</strong></b></i></s><s><span style="white-space: pre-wrap;">!</span></s></p>',
      md: '**~~Hello *world*~~**~~!~~',
    },
    {
      html: '<p><i><em style="white-space: pre-wrap;">Hello </em></i><i><b><strong style="white-space: pre-wrap;">world</strong></b></i><i><em style="white-space: pre-wrap;">!</em></i></p>',
      md: '*Hello **world**!*',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">hello world</span></p>',
      md: 'hello\nworld',
      shouldMergeAdjacentLines: true,
      skipExport: true,
    },
    {
      html: '<p><span style="white-space: pre-wrap;">hello</span><br><span style="white-space: pre-wrap;">world</span></p>',
      md: 'hello\nworld',
      shouldMergeAdjacentLines: false,
    },
    {
      html: '<p><span style="white-space: pre-wrap;">hello</span></p><p><span style="white-space: pre-wrap;">world</span></p>',
      md: 'hello\nworld',
      shouldPreserveNewLines: true,
    },
    {
      html: '<h1><span style="white-space: pre-wrap;">Hello</span></h1><p><br></p><p><br></p><p><br></p><p><b><strong style="white-space: pre-wrap;">world</strong></b><span style="white-space: pre-wrap;">!</span></p>',
      md: '# Hello\n\n\n\n**world**!',
      shouldPreserveNewLines: true,
    },
    {
      html: '<h1><span style="white-space: pre-wrap;">Hello</span></h1><p><span style="white-space: pre-wrap;">hi</span></p><p><br></p><p><b><strong style="white-space: pre-wrap;">world</strong></b></p><p><br></p><p><span style="white-space: pre-wrap;">hi</span></p><blockquote><span style="white-space: pre-wrap;">hello</span><br><span style="white-space: pre-wrap;">hello</span></blockquote><p><br></p><h1><span style="white-space: pre-wrap;">hi</span></h1><p><br></p><p><span style="white-space: pre-wrap;">hi</span></p>',
      md: '# Hello\nhi\n\n**world**\n\nhi\n> hello\n> hello\n\n# hi\n\nhi',
      shouldPreserveNewLines: true,
    },
    {
      // Import only: export will use * instead of _ due to registered transformers order
      html: '<p><i><em style="white-space: pre-wrap;">Hello</em></i><span style="white-space: pre-wrap;"> world</span></p>',
      md: '_Hello_ world',
      skipExport: true,
    },
    {
      // Import only: export will use * instead of _ due to registered transformers order
      html: '<p><b><strong style="white-space: pre-wrap;">Hello</strong></b><span style="white-space: pre-wrap;"> world</span></p>',
      md: '__Hello__ world',
      skipExport: true,
    },
    {
      // Import only: export will use * instead of _ due to registered transformers order
      html: '<p><i><b><strong style="white-space: pre-wrap;">Hello</strong></b></i><span style="white-space: pre-wrap;"> world</span></p>',
      md: '___Hello___ world',
      skipExport: true,
    },
    {
      // Import only: export will use * instead of _ due to registered transformers order
      html: '<p><span style="white-space: pre-wrap;">Hello </span><s><i><b><strong style="white-space: pre-wrap;">world</strong></b></i></s><span style="white-space: pre-wrap;">!</span></p>',
      md: 'Hello ~~__*world*__~~!',
      skipExport: true,
    },
    {
      html: '<pre spellcheck="false"><span style="white-space: pre-wrap;">Single line Code</span></pre>',
      md: '```Single line Code```', // Ensure that "Single" is not read as the language by the code transformer. It should only be read as the language if there is a multi-line code block
      skipExport: true, // Export will fail, as the code transformer will add new lines to the code block to make it multi-line. This is expected though, as the lexical code block is a block node and cannot be inline.
    },
    {
      html: '<pre spellcheck="false" data-language="javascript"><span style="white-space: pre-wrap;">Incomplete tag</span></pre>',
      md: '```javascript Incomplete tag',
      skipExport: true,
    },
    {
      html:
        '<pre spellcheck="false" data-language="javascript"><span style="white-space: pre-wrap;">Incomplete multiline\n' +
        '\n' +
        'Tag</span></pre>',
      md: '```javascript Incomplete multiline\n\nTag',
      skipExport: true,
    },
    {
      html: '<pre spellcheck="false"><span style="white-space: pre-wrap;">Code</span></pre>',
      md: '```\nCode\n```',
    },
    {
      html: '<pre spellcheck="false" data-language="javascript"><span style="white-space: pre-wrap;">Code</span></pre>',
      md: '```javascript\nCode\n```',
    },
    {
      // Should always preserve language in md but keep data-highlight-language only for supported languages
      html: '<pre spellcheck="false" data-language="unknown"><span style="white-space: pre-wrap;">Code</span></pre>',
      md: '```unknown\nCode\n```',
    },
    {
      // Import only: prefix tabs will be removed for export
      html: '<pre spellcheck="false"><span style="white-space: pre-wrap;">Code</span></pre>',
      md: '\t```\nCode\n```',
      skipExport: true,
    },
    {
      // Import only: prefix spaces will be removed for export
      html: '<pre spellcheck="false"><span style="white-space: pre-wrap;">Code</span></pre>',
      md: '   ```\nCode\n```',
      skipExport: true,
    },
    {
      html: `<h3><span style="white-space: pre-wrap;">Code blocks</span></h3><pre spellcheck="false" data-language="javascript"><span style="white-space: pre-wrap;">1 + 1 = 2;</span></pre>`,
      md: `### Code blocks

\`\`\`javascript
1 + 1 = 2;
\`\`\``,
    },
    {
      // Import only: extra empty lines will be removed for export
      html: '<p><span style="white-space: pre-wrap;">Hello</span></p><p><span style="white-space: pre-wrap;">world</span></p>',
      md: ['Hello', '', '', '', 'world'].join('\n'),
      skipExport: true,
    },
    {
      // https://spec.commonmark.org/dingus/?text=%3E%20Hello%0Aworld%0A!
      html: '<blockquote><span style="white-space: pre-wrap;">Hello world !</span></blockquote>',
      md: '> Hello\nworld\n!',
      shouldMergeAdjacentLines: true,
      skipExport: true,
    },
    {
      // Import only: ensures that left side of splitText is processed for text match transformers
      html: '<p><span style="white-space: pre-wrap;">Hello </span><a href="https://lexical.dev"><span style="white-space: pre-wrap;">world</span></a><span style="white-space: pre-wrap;">! Hello </span><mark style="white-space: pre-wrap;"><span>$world$</span></mark><span style="white-space: pre-wrap;">! </span><a href="https://lexical.dev"><span style="white-space: pre-wrap;">Hello</span></a><span style="white-space: pre-wrap;"> world! Hello </span><mark style="white-space: pre-wrap;"><span>$world$</span></mark><span style="white-space: pre-wrap;">!</span></p>',
      md: `Hello [world](${URL})! Hello $world$! [Hello](${URL}) world! Hello $world$!`,
      skipExport: true,
    },
    {
      // Export only: import will use $...$ to transform <span /> to <mark /> due to HIGHLIGHT_TEXT_MATCH_IMPORT
      html: "<p><span style='white-space: pre-wrap;'>$$H$&e$`l$'l$o$</span></p>",
      md: "$$H$&e$\\`l$'l$o$",
      skipImport: true,
    },
    {
      customTransformers: [MDX_HTML_TRANSFORMER],
      html: '<p><span style="white-space: pre-wrap;">Some HTML in mdx:</span></p><pre spellcheck="false" data-language="MyComponent"><span style="white-space: pre-wrap;">From HTML: Some Text</span></pre>',
      md: 'Some HTML in mdx:\n\n<MyComponent>Some Text</MyComponent>',
      shouldMergeAdjacentLines: true,
    },
    {
      customTransformers: [MDX_HTML_TRANSFORMER],
      html: '<p><span style="white-space: pre-wrap;">Some HTML in mdx:</span></p><pre spellcheck="false" data-language="MyComponent"><span style="white-space: pre-wrap;">From HTML: Line 1 Some Text</span></pre>',
      md: 'Some HTML in mdx:\n\n<MyComponent>Line 1\nSome Text</MyComponent>',
      shouldMergeAdjacentLines: true,
      skipExport: true,
    },
    {
      customTransformers: [CODE_TAG_COUNTER_EXAMPLE],
      // Ensure special ``` code block supports nested code blocks
      html: '<pre spellcheck="false" data-language="ts"><span style="white-space: pre-wrap;">Code\n```ts\nSub Code\n```</span></pre>',
      md: '```ts\nCode\n```ts\nSub Code\n```\n```',
      skipExport: true,
    },
    {
      customTransformers: [SIMPLE_INLINE_JSX_MATCHER],
      html: '<p><span style="white-space: pre-wrap;">Hello </span><a href="https://simple-jsx"><span style="white-space: pre-wrap;">One &lt;MyTag&gt;Two&lt;/MyTag&gt;</span></a><span style="white-space: pre-wrap;"> there</span></p>',
      md: 'Hello <MyTag>One <MyTag>Two</MyTag></MyTag> there',
      skipExport: true,
    },
    {
      html: '<p><a href="https://lexical.dev"><span style="white-space: pre-wrap;">text</span></a></p>',
      md: '[text](https://lexical.dev)',
    },
    {
      html: '<p><code spellcheck="false" style="white-space: pre-wrap;"><span>text</span></code></p>',
      md: '`text`',
    },
    {
      html: '<p><a href="https://lexical.dev"><code spellcheck="false" style="white-space: pre-wrap;"><span>text</span></code></a></p>',
      md: '[`text`](https://lexical.dev)',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">Bold</strong></b><span style="white-space: pre-wrap;"> </span><a href="https://lexical.dev"><code spellcheck="false" style="white-space: pre-wrap;"><span>text</span></code></a><span style="white-space: pre-wrap;"> </span><b><strong style="white-space: pre-wrap;">Bold 2</strong></b></p>',
      md: '**Bold** [`text`](https://lexical.dev) **Bold 2**',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">Bold</strong></b><span style="white-space: pre-wrap;"> </span><a href="https://lexical.dev"><code spellcheck="false" style="white-space: pre-wrap;"><span>text</span></code><span style="white-space: pre-wrap;"> </span><b><strong style="white-space: pre-wrap;">Bold 2</strong></b></a><span style="white-space: pre-wrap;"> </span><b><strong style="white-space: pre-wrap;">Bold 3</strong></b></p>',
      md: '**Bold** [`text` **Bold 2**](https://lexical.dev) **Bold 3**',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">Bold</strong></b><span style="white-space: pre-wrap;"> </span><a href="https://lexical.dev"><code spellcheck="false" style="white-space: pre-wrap;"><span>text **Bold in code**</span></code></a><span style="white-space: pre-wrap;"> </span><b><strong style="white-space: pre-wrap;">Bold 3</strong></b></p>',
      md: '**Bold** [`text **Bold in code**`](https://lexical.dev) **Bold 3**',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">Bold</strong></b><span style="white-space: pre-wrap;"> </span><code spellcheck="false" style="white-space: pre-wrap;"><span>[text](https://lexical.dev)</span></code><span style="white-space: pre-wrap;"> </span><b><strong style="white-space: pre-wrap;">Bold 3</strong></b></p>',
      md: '**Bold** `[text](https://lexical.dev)` **Bold 3**',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">Text </span><b><strong style="white-space: pre-wrap;">boldstart </strong></b><a href="https://lexical.dev"><b><strong style="white-space: pre-wrap;">text</strong></b></a><b><strong style="white-space: pre-wrap;"> boldend</strong></b><span style="white-space: pre-wrap;"> text</span></p>',
      md: 'Text **boldstart [text](https://lexical.dev) boldend** text',
      mdAfterExport:
        'Text **boldstart** [**text**](https://lexical.dev) **boldend** text',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">Text </span><b><strong style="white-space: pre-wrap;">boldstart </strong></b><a href="https://lexical.dev"><b><code spellcheck="false" style="white-space: pre-wrap;"><strong>text</strong></code></b></a><b><strong style="white-space: pre-wrap;"> boldend</strong></b><span style="white-space: pre-wrap;"> text</span></p>',
      md: 'Text **boldstart [`text`](https://lexical.dev) boldend** text',
      mdAfterExport:
        'Text **boldstart** [**`text`**](https://lexical.dev) **boldend** text',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">It </span><s><i><b><strong style="white-space: pre-wrap;">works </strong></b></i></s><a href="https://lexical.io"><s><i><b><strong style="white-space: pre-wrap;">with links</strong></b></i></s></a><span style="white-space: pre-wrap;"> too</span></p>',
      md: 'It ~~___works [with links](https://lexical.io)___~~ too',
      mdAfterExport:
        'It ***~~works~~*** [***~~with links~~***](https://lexical.io) too',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">It </span><s><i><b><strong style="white-space: pre-wrap;">works </strong></b></i></s><a href="https://lexical.io"><s><i><b><strong style="white-space: pre-wrap;">with links</strong></b></i></s></a><s><i><b><strong style="white-space: pre-wrap;"> too</strong></b></i></s><span style="white-space: pre-wrap;">!</span></p>',
      md: 'It ~~___works [with links](https://lexical.io) too___~~!',
      mdAfterExport:
        'It ***~~works~~*** [***~~with links~~***](https://lexical.io) ***~~too~~***!',
    },
    {
      html: '<p><a href="https://lexical.dev"><span style="white-space: pre-wrap;">link</span></a><a href="https://lexical.dev"><span style="white-space: pre-wrap;">link2</span></a></p>',
      md: '[link](https://lexical.dev)[link2](https://lexical.dev)',
    },
    {
      // Test that importRegExp is not too greedy when there are multiple link patterns
      html: '<p><a href="https://a.example.com"><span style="white-space: pre-wrap;">a</span></a><span style="white-space: pre-wrap;"> </span><a href="https://b.example.com"><span style="white-space: pre-wrap;">b</span></a></p>',
      md: '[a](https://a.example.com) [b](https://b.example.com)',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">[foo </span><a href="/uri"><span style="white-space: pre-wrap;">bar</span></a><span style="white-space: pre-wrap;">](/uri)</span></p>',
      md: '[foo [bar](/uri)](/uri)',
    },
    {
      // https://spec.commonmark.org/0.31.2/#link-destination allows a balanced
      // pair of parentheses inside the destination.
      html: '<p><a href="https://en.wikipedia.org/wiki/Ruby_(programming_language)"><span style="white-space: pre-wrap;">Ruby</span></a></p>',
      md: '[Ruby](https://en.wikipedia.org/wiki/Ruby_(programming_language))',
      // Export escapes the parentheses so that the destination cannot close
      // early, which is what @lexical/mdast writes for the same link.
      mdAfterExport:
        '[Ruby](https://en.wikipedia.org/wiki/Ruby_\\(programming_language\\))',
    },
    {
      html: '<p><a href="https://example.com/a(b)c"><span style="white-space: pre-wrap;">a</span></a><span style="white-space: pre-wrap;"> and </span><a href="https://example.com/d"><span style="white-space: pre-wrap;">d</span></a></p>',
      md: '[a](https://example.com/a(b)c) and [d](https://example.com/d)',
      mdAfterExport:
        '[a](https://example.com/a\\(b\\)c) and [d](https://example.com/d)',
    },
    {
      // A backslash-escaped parenthesis is part of the destination too, and it
      // is the spelling export produces, so this one is already a fixed point.
      html: '<p><a href="https://example.com/a)b"><span style="white-space: pre-wrap;">a</span></a></p>',
      md: '[a](https://example.com/a\\)b)',
    },
    {
      // A destination between < and > holds whitespace, which the raw form
      // cannot. https://spec.commonmark.org/0.31.2/#link-destination
      html: '<p><a href="https://example.com/a b"><span style="white-space: pre-wrap;">a</span></a></p>',
      md: '[a](<https://example.com/a b>)',
    },
    {
      html: '<p><a href="https://example.com/a b" title="t"><span style="white-space: pre-wrap;">a</span></a></p>',
      md: '[a](<https://example.com/a b> "t")',
    },
    {
      // The pointy form is read wherever it appears, and export drops it again
      // when the destination has nothing that needs it.
      html: '<p><a href="/uri"><span style="white-space: pre-wrap;">a</span></a></p>',
      md: '[a](</uri>)',
      mdAfterExport: '[a](/uri)',
    },
    {
      // Import only: <mark>...</mark> is exported as ==...== in markdown.
      // Use HIGHLIGHT_TEXT_MATCH_IMPORT as custom transformer even though it is included later to ensure it runs before LINK.
      customTransformers: [HIGHLIGHT_TEXT_MATCH_IMPORT],
      html: '<p><span style="white-space: pre-wrap;">Multiple </span><a href="https://lexical.dev"><code spellcheck="false" style="white-space: pre-wrap;"><span>TextMatchTransformer</span></code><span style="white-space: pre-wrap;">s</span></a><s><mark style="white-space: pre-wrap;"><span>$ with formatting$</span></mark></s></p>',
      md: 'Multiple [`TextMatchTransformer`s](https://lexical.dev)~~$ with formatting$~~',
      skipExport: true,
    },
    {
      html: '<p><b><code spellcheck="false" style="white-space: pre-wrap;"><strong>Bold Code</strong></code></b></p>',
      md: '**`Bold Code`**',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">This is a backslash: \\</span></p>',
      md: 'This is a backslash: \\\\',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">This is an asterisk: *</span></p>',
      md: 'This is an asterisk: \\*',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">Backtick and asterisk: `**`</span></p>',
      md: 'Backtick and asterisk: \\`\\*\\*\\`',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">Backtick and asterisk: `**`</strong></b></p>',
      md: '**Backtick and asterisk: \\`\\*\\*\\`**',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">*test*</strong></b></p>',
      md: '**\\*test\\***',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">some bold text with an escaped star: *</strong></b><span style="white-space: pre-wrap;"> normal text</span></p>',
      md: '**some bold text with an escaped star: \\*** normal text',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">*This text should </span><b><strong style="white-space: pre-wrap;">not</strong></b><span style="white-space: pre-wrap;"> be italic*</span></p>',
      md: '\\*This text should **not** be italic*',
      mdAfterExport: '\\*This text should **not** be italic\\*',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">*some text*</span></p>',
      md: '\\*some text*',
      mdAfterExport: '\\*some text\\*',
    },
    {
      html: '<p><a href="https://lexical.dev"><span style="white-space: pre-wrap;">text </span><b><strong style="white-space: pre-wrap;">bold</strong></b><span style="white-space: pre-wrap;"> *normal*</span></a></p>',
      md: '[text **bold** \\*normal\\*](https://lexical.dev)',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">*Hello* world</span></p>',
      md: '\\*Hello\\* world',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">&nbsp;</strong></b></p>',
      md: '**&#160;**',
      mdAfterExport: '\xA0',
    },
    {
      html: '<p><a href="https://lexical.dev"><span style="white-space: pre-wrap;">[h]ello</span></a><a href="https://lexical.dev"><span style="white-space: pre-wrap;">h[e]llo</span></a></p>',
      md: '[[h]ello](https://lexical.dev)[h[e]llo](https://lexical.dev)',
    },
    {
      html: '<p><a href="https://lexical.dev"><span style="white-space: pre-wrap;">h[e[ll]]o</span></a><a href="https://lexical.dev"><span style="white-space: pre-wrap;">world</span></a></p>',
      md: '[h[e[ll]]o](https://lexical.dev)[world](https://lexical.dev)',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">[hello]](https://lexical.dev)</span><a href="https://lexical.dev"><span style="white-space: pre-wrap;">world</span></a></p>',
      md: '[hello]](https://lexical.dev)[world](https://lexical.dev)',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">[h</span><a href="https://lexical.dev"><span style="white-space: pre-wrap;">ello</span></a><a href="https://lexical.dev"><span style="white-space: pre-wrap;">world</span></a></p>',
      md: '[h[ello](https://lexical.dev)[world](https://lexical.dev)',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">[](https://lexical.dev)</span></p>',
      md: '[](https://lexical.dev)',
    },
    {
      html: '<p><a href="https://lexical.dev"><b><strong style="white-space: pre-wrap;">link</strong></b></a><b><strong style="white-space: pre-wrap;">text</strong></b></p>',
      md: '[**link**](https://lexical.dev)**text**',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">text </strong></b><a href="https://lexical.dev"><b><strong style="white-space: pre-wrap;">link</strong></b></a></p>',
      md: '**text [link](https://lexical.dev)**',
      mdAfterExport: '**text** [**link**](https://lexical.dev)',
    },
    {
      html: '<p><i><em style="white-space: pre-wrap;">text</em></i><i><b><strong style="white-space: pre-wrap;">text</strong></b></i></p>',
      md: '*text**text***',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">text</strong></b><i><b><strong style="white-space: pre-wrap;">text</strong></b></i></p>',
      md: '**text*text***',
    },
    {
      html: '<p><i><em style="white-space: pre-wrap;">foo**bar</em></i></p>',
      md: '*foo**bar*',
      mdAfterExport: '*foo\\*\\*bar*',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">foo </strong></b><a href="/url"><i><b><strong style="white-space: pre-wrap;">bar</strong></b></i></a></p>',
      md: '**foo [*bar*](/url)**',
      mdAfterExport: '**foo** [***bar***](/url)',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">*foo </span><i><em style="white-space: pre-wrap;">bar baz</em></i></p>',
      md: '*foo *bar baz*',
      mdAfterExport: '\\*foo *bar baz*',
    },
    {
      html: '<p><i><em style="white-space: pre-wrap;">a </em></i><i><code spellcheck="false" style="white-space: pre-wrap;"><em>*</em></code></i><i><em style="white-space: pre-wrap;"> b </em></i><i><code spellcheck="false" style="white-space: pre-wrap;"><em>x</em></code></i></p>',
      md: '*a `*` b `x`*',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">_foo_bar</span></p>',
      md: '_foo_bar',
      mdAfterExport: '\\_foo\\_bar',
    },
    {
      html: '<p><b><strong style="white-space: pre-wrap;">Hello </strong></b><s><b><strong style="white-space: pre-wrap;">world</strong></b></s><span style="white-space: pre-wrap;">!</span></p>',
      md: '**Hello&#32;~~world~~**!',
      mdAfterExport: '**Hello ~~world~~**!',
    },
    {
      html: '<p><i><em style="white-space: pre-wrap;">Hello </em></i><i><b><strong style="white-space: pre-wrap;">world</strong></b></i><i><em style="white-space: pre-wrap;">!</em></i></p>',
      md: '*Hello&#32;**world**!*',
      mdAfterExport: '*Hello **world**!*',
    },
    {
      html: '<p><s><b><strong style="white-space: pre-wrap;">Hello </strong></b></s><s><i><b><strong style="white-space: pre-wrap;">world</strong></b></i></s><s><span style="white-space: pre-wrap;">!</span></s></p>',
      md: '**~~Hello&#32;*world*~~**~~!~~',
      mdAfterExport: '**~~Hello *world*~~**~~!~~',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">!"#$%&amp;\'()*+,-./:;&lt;=&gt;?@[\\]^_`{|}~</span></p>',
      md: '\\!\\"\\#\\$\\%\\&\\\'\\(\\)\\*\\+\\,\\-\\.\\/\\:\\;\\<\\=\\>\\?\\@\\[\\\\\\]\\^\\_\\`\\{\\|\\}\\~',
      mdAfterExport: '!"#$%&\'()\\*+,-./:;<=>?@[\\\\]^\\_\\`{|}\\~',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">\\→\\A\\a\\ \\3\\φ\\«</span></p>',
      md: '\\→\\A\\a\\ \\3\\φ\\«',
      mdAfterExport: '\\\\→\\\\A\\\\a\\\\ \\\\3\\\\φ\\\\«',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">foo</span><br><span style="white-space: pre-wrap;">bar</span></p>',
      md: 'foo\\\nbar',
      mdAfterExport: 'foo\nbar',
    },
    {
      html: '<p><span style="white-space: pre-wrap;">foo</span><br><span style="white-space: pre-wrap;">bar</span></p>',
      md: 'foo  \nbar',
      skipExport: true,
    },
    {
      html: '<p><span style="white-space: pre-wrap;">foo </span><a href="https://lexical.dev"><span style="white-space: pre-wrap;">bar</span></a><span style="white-space: pre-wrap;">\t</span><span style="white-space: pre-wrap;">baz</span></p>',
      md: 'foo [bar](https://lexical.dev)\tbaz',
      skipExport: true,
    },
    {
      html: '<p><span style="white-space: pre-wrap;">foo</span><span style="white-space: pre-wrap;">\t</span><span style="white-space: pre-wrap;"> </span><span style="white-space: pre-wrap;">\t</span><span style="white-space: pre-wrap;">bar</span><br><span style="white-space: pre-wrap;">\t</span><span style="white-space: pre-wrap;">baz</span></p>',
      md: 'foo\t \tbar\n\tbaz',
      skipExport: true,
    },
    {
      html: '<p><span style="white-space: pre-wrap;">Hello</span><span style="white-space: pre-wrap;">\t</span><span style="white-space: pre-wrap;">\t</span><span style="white-space: pre-wrap;">World</span></p>',
      md: 'Hello\t\tWorld',
      skipExport: true,
    },
  ];

  for (const {
    html,
    md,
    skipImport,
    shouldPreserveNewLines,
    shouldMergeAdjacentLines,
    customTransformers,
  } of IMPORT_AND_EXPORT) {
    if (skipImport) {
      continue;
    }

    it(`can import "${md.replace(/\n/g, '\\n')}"`, () => {
      const editor = createTestEditor({
        nodes: [
          HeadingNode,
          ListNode,
          ListItemNode,
          QuoteNode,
          CodeNode,
          LinkNode,
        ],
      });

      editor.update(
        () =>
          $convertFromMarkdownString(
            md,
            [
              ...(customTransformers || []),
              ...TRANSFORMERS,
              HIGHLIGHT_TEXT_MATCH_IMPORT,
            ],
            undefined,
            shouldPreserveNewLines,
            shouldMergeAdjacentLines,
          ),
        {
          discrete: true,
        },
      );

      expect(editor.read('latest', () => $generateHtmlFromNodes(editor))).toBe(
        html,
      );
    });
  }

  for (const {
    html,
    md,
    skipExport,
    shouldPreserveNewLines,
    customTransformers,
    mdAfterExport,
  } of IMPORT_AND_EXPORT) {
    if (skipExport) {
      continue;
    }

    it(`can export "${md.replace(/\n/g, '\\n')}"`, () => {
      const editor = createTestEditor({
        nodes: [
          HeadingNode,
          ListNode,
          ListItemNode,
          QuoteNode,
          CodeNode,
          LinkNode,
        ],
      });

      editor.update(
        () => {
          const parser = new DOMParser();
          const dom = parser.parseFromString(html, 'text/html');
          const nodes = $generateNodesFromDOM(editor, dom);
          $getRoot().select();
          $insertNodes(nodes);
        },
        {
          discrete: true,
        },
      );

      expect(
        editor.read('latest', () =>
          $convertToMarkdownString(
            [...(customTransformers || []), ...TRANSFORMERS],
            undefined,
            shouldPreserveNewLines,
          ),
        ),
      ).toBe(mdAfterExport ?? md);
    });
  }

  for (const {
    md,
    skipImport,
    shouldPreserveNewLines,
    shouldMergeAdjacentLines,
    customTransformers,
  } of IMPORT_AND_EXPORT) {
    if (skipImport) {
      continue;
    }

    it(`should not select when importing "${md.replace(/\n/g, '\\n')}"`, () => {
      const editor = createTestEditor({
        nodes: [
          HeadingNode,
          ListNode,
          ListItemNode,
          QuoteNode,
          CodeNode,
          LinkNode,
        ],
      });

      editor.update(
        () =>
          $convertFromMarkdownString(
            md,
            [
              ...(customTransformers || []),
              ...TRANSFORMERS,
              HIGHLIGHT_TEXT_MATCH_IMPORT,
            ],
            undefined,
            shouldPreserveNewLines,
            shouldMergeAdjacentLines,
          ),
        {
          discrete: true,
        },
      );

      expect(editor.read('latest', () => $getSelection())).toBe(null);
    });
  }

  it('should not remove leading node and transform if replace returns false', () => {
    const editor = createTestEditor({
      nodes: [
        HeadingNode,
        ListNode,
        ListItemNode,
        QuoteNode,
        CodeNode,
        LinkNode,
      ],
    });

    registerMarkdownShortcuts(editor, [CANCELED_HEADING_REPLACE_EXAMPLE]);

    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        root.append(paragraph);
        paragraph.selectEnd();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText('#');
        }
      },
      {
        discrete: true,
      },
    );

    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(' ');
        }
      },
      {
        discrete: true,
      },
    );

    expect(editor.read(() => $generateHtmlFromNodes(editor))).toBe(
      '<p><span style="white-space: pre-wrap;"># </span></p>',
    );
  });

  it('should remove leading node and execute transform if replace does not return false', () => {
    const editor = createTestEditor({
      nodes: [
        HeadingNode,
        ListNode,
        ListItemNode,
        QuoteNode,
        CodeNode,
        LinkNode,
      ],
    });

    registerMarkdownShortcuts(editor, [HEADING]);

    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        root.append(paragraph);
        paragraph.selectEnd();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText('#');
        }
      },
      {
        discrete: true,
      },
    );

    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(' ');
        }
      },
      {
        discrete: true,
      },
    );

    expect(editor.read(() => $generateHtmlFromNodes(editor))).toBe(
      '<h1><br></h1>',
    );
  });

  it.each(['1. ', '- ', '* ', '+ '])(
    'should preserve a heading when typing the "%s" list shortcut',
    shortcut => {
      const editor = createTestEditor({
        nodes: [
          HeadingNode,
          ListNode,
          ListItemNode,
          QuoteNode,
          CodeNode,
          LinkNode,
        ],
      });

      registerMarkdownShortcuts(editor, TRANSFORMERS);

      editor.update(
        () => {
          const heading = $createHeadingNode('h1');
          const text = $createTextNode('Welcome to the playground');
          heading.append(text);
          $getRoot().append(heading);
          text.select(0, 0);
        },
        {discrete: true},
      );

      for (const character of shortcut) {
        editor.update(
          () => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.insertText(character);
            }
          },
          {discrete: true},
        );
      }

      editor.read(() => {
        const heading = $getRoot().getFirstChild();
        expect($isHeadingNode(heading)).toBe(true);
        expect(heading?.getTextContent()).toBe(
          `${shortcut}Welcome to the playground`,
        );
      });
    },
  );

  it.each(['# ', '## ', '###### ', '1. ', '- ', '* ', '+ '])(
    'should preserve a quote when typing the "%s" shortcut (#7407)',
    shortcut => {
      const editor = createTestEditor({
        nodes: [
          HeadingNode,
          ListNode,
          ListItemNode,
          QuoteNode,
          CodeNode,
          LinkNode,
        ],
      });

      registerMarkdownShortcuts(editor, TRANSFORMERS);

      editor.update(
        () => {
          const quote = $createQuoteNode();
          const text = $createTextNode('Welcome to the playground');
          quote.append(text);
          $getRoot().append(quote);
          text.select(0, 0);
        },
        {discrete: true},
      );

      for (const character of shortcut) {
        editor.update(
          () => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.insertText(character);
            }
          },
          {discrete: true},
        );
      }

      editor.read(() => {
        const quote = $getRoot().getFirstChild();
        expect($isQuoteNode(quote)).toBe(true);
        expect(quote?.getTextContent()).toBe(
          `${shortcut}Welcome to the playground`,
        );
      });
    },
  );

  it('should preserve a quote when the code fence shortcut is typed in it (#7407)', () => {
    const editor = createTestEditor({
      nodes: [
        HeadingNode,
        ListNode,
        ListItemNode,
        QuoteNode,
        CodeNode,
        LinkNode,
      ],
    });

    registerMarkdownShortcuts(editor, TRANSFORMERS);

    editor.update(
      () => {
        const quote = $createQuoteNode();
        const text = $createTextNode('');
        quote.append(text);
        $getRoot().append(quote);
        text.select(0, 0);
      },
      {discrete: true},
    );

    for (const character of '```') {
      editor.update(
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText(character);
          }
        },
        {discrete: true},
      );
    }
    editor.dispatchCommand(KEY_ENTER_COMMAND, null);

    editor.read(() => {
      const quote = $getRoot().getFirstChild();
      expect($isQuoteNode(quote)).toBe(true);
      expect(quote?.getTextContent()).toBe('```');
    });
  });

  it('can round-trip nested fenced code blocks (4 backticks wrapping 3 backticks)', () => {
    const markdown =
      '````markdown\n' +
      '# Example\n' +
      '\n' +
      'Run this:\n' +
      '```bash\n' +
      'npm install\n' +
      '```\n' +
      '````';

    const editor = createTestEditor({
      nodes: [
        HeadingNode,
        ListNode,
        ListItemNode,
        QuoteNode,
        CodeNode,
        LinkNode,
      ],
    });

    editor.update(
      () => {
        $convertFromMarkdownString(markdown, TRANSFORMERS);
      },
      {discrete: true},
    );

    expect(
      editor.read('latest', () => $convertToMarkdownString(TRANSFORMERS)),
    ).toBe(markdown);
  });

  it('can round-trip deeply nested fenced code blocks (5 backticks wrapping 4 backticks)', () => {
    const markdown =
      '`````text\n' +
      'Top Level 5 ticks\n' +
      '````markdown\n' +
      'Level 2 (4 ticks)\n' +
      '```javascript\n' +
      'console.log("Deepest (3 ticks)");\n' +
      '```\n' +
      '````\n' +
      '`````';

    const editor = createTestEditor({
      nodes: [
        HeadingNode,
        ListNode,
        ListItemNode,
        QuoteNode,
        CodeNode,
        LinkNode,
      ],
    });

    editor.update(
      () => {
        $convertFromMarkdownString(markdown, TRANSFORMERS);
      },
      {discrete: true},
    );

    expect(
      editor.read('latest', () => $convertToMarkdownString(TRANSFORMERS)),
    ).toBe(markdown);
  });

  it('computes fence dynamically when code block content contains backticks', () => {
    const editor = createTestEditor({
      nodes: [CodeNode],
    });

    editor.update(
      () => {
        // Create a CodeNode without setting fence state (uses default ```)
        const codeBlockNode = $createCodeNode('markdown');
        // Content contains ``` which conflicts with default fence
        $getRoot()
          .append(codeBlockNode)
          .selectEnd()
          .insertRawText('```js\nconsole.log("hello");\n```');
      },
      {discrete: true},
    );

    // Export should compute fence to be ```` (4 backticks) since content contains ```
    const exported = editor.read('latest', () =>
      $convertToMarkdownString(TRANSFORMERS),
    );

    expect(exported).toBe(
      '````markdown\n```js\nconsole.log("hello");\n```\n````',
    );
  });

  describe('overlapping inline formats (#4895)', () => {
    type Run = [text: string, format: number];

    const BOLD = TEXT_TYPE_TO_FORMAT.bold;
    const ITALIC = TEXT_TYPE_TO_FORMAT.italic;
    const STRIKE = TEXT_TYPE_TO_FORMAT.strikethrough;
    const INLINE_CODE = TEXT_TYPE_TO_FORMAT.code;

    function overlapEditor() {
      return createTestEditor({
        nodes: [
          HeadingNode,
          ListNode,
          ListItemNode,
          QuoteNode,
          CodeNode,
          LinkNode,
        ],
      });
    }

    /** Reads the document back as merged (text, format) runs. */
    function $textRuns(): Run[] {
      const out: Run[] = [];
      for (const node of $getRoot().getAllTextNodes()) {
        const format = node.getFormat();
        const text = node.getTextContent();
        const last = out[out.length - 1];
        if (last && last[1] === format) {
          last[0] += text;
        } else {
          out.push([text, format]);
        }
      }
      return out;
    }

    /**
     * Builds a one-paragraph document from explicit text-node format runs,
     * asserts the exported markdown, and verifies that re-importing the
     * export restores the same formatting.
     */
    function expectRoundTrip(runs: Run[], expected: string): void {
      const editor = overlapEditor();
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          for (const [text, format] of runs) {
            paragraph.append($createTextNode(text).setFormat(format));
          }
          $getRoot().clear().append(paragraph);
        },
        {discrete: true},
      );
      const markdown = editor.read(() =>
        $convertToMarkdownString(TRANSFORMERS),
      );
      expect(markdown).toBe(expected);
      const reimported = overlapEditor();
      reimported.update(
        () => {
          $convertFromMarkdownString(markdown, TRANSFORMERS);
        },
        {discrete: true},
      );
      expect(reimported.read($textRuns)).toEqual(runs);
    }

    it('round-trips bold overlapping italic (the issue example)', () => {
      expectRoundTrip(
        [
          ['he', 0],
          ['llo', BOLD],
          ['wor', BOLD | ITALIC],
          ['ld', ITALIC],
          ['!', 0],
        ],
        'he**llo*wor****ld*!',
      );
    });

    it('round-trips italic overlapping bold', () => {
      expectRoundTrip(
        [
          ['a', 0],
          ['b', ITALIC],
          ['c', ITALIC | BOLD],
          ['d', BOLD],
          ['e', 0],
        ],
        'a*b**c*****d**e',
      );
    });

    it('round-trips strikethrough overlapping bold', () => {
      expectRoundTrip(
        [
          ['a', STRIKE],
          ['b', STRIKE | BOLD],
          ['c', BOLD],
        ],
        '~~a**b**~~**c**',
      );
    });

    it('round-trips a code span inside a bold run', () => {
      expectRoundTrip(
        [
          ['a', BOLD],
          ['b', BOLD | INLINE_CODE],
          ['c', BOLD],
        ],
        '**a`b`c**',
      );
    });

    it('imports a partially consumed delimiter run like CommonMark', () => {
      // `**llo*wor****ld*` pairs `*wor*` first, leaving `***` of the four-
      // marker run; the remaining `**` must still close the `**` opener
      // (rule of 3 re-measured on the remaining lengths) and the final `*`
      // opens the trailing emphasis.
      const editor = overlapEditor();
      editor.update(
        () => {
          $convertFromMarkdownString('he**llo*wor****ld*!', TRANSFORMERS);
        },
        {discrete: true},
      );
      expect(editor.read($textRuns)).toEqual([
        ['he', 0],
        ['llo', BOLD],
        ['wor', BOLD | ITALIC],
        ['ld', ITALIC],
        ['!', 0],
      ]);
    });
  });

  describe('list marker', () => {
    it('should remember marker used on import', () => {
      const editor = createTestEditor({
        nodes: [ListNode, ListItemNode],
      });
      editor.update(
        () =>
          $convertFromMarkdownString(
            '+ hello',
            [...TRANSFORMERS],
            undefined,
            true,
            false,
          ),
        {discrete: true},
      );
      editor.read('latest', () => {
        const node = $getRoot().getFirstChild();
        expect(node).toBeInstanceOf(ListNode);
        const marker = node ? $getState(node, listMarkerState) : undefined;
        expect(marker).toBe('+');
      });
    });
    it('should not use [ as a marker for an implicit check list', () => {
      const editor = createTestEditor({
        nodes: [ListNode, ListItemNode],
      });
      registerMarkdownShortcuts(editor, [CHECK_LIST]);
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append($createParagraphNode())
            .selectEnd()
            .insertText('[]'),
        {discrete: true},
      );
      editor.update(() => $getSelection()!.insertText(' '), {
        discrete: true,
      });
      editor.read(() => {
        const node = $getRoot().getFirstChild();
        expect(node).toBeInstanceOf(ListNode);
        const marker = node ? $getState(node, listMarkerState) : undefined;
        expect(marker).toBe('-');
      });
    });
    it('should remember the marker for checkbox with an explicit marker', () => {
      const editor = createTestEditor({
        nodes: [ListNode, ListItemNode],
      });
      registerMarkdownShortcuts(editor, [CHECK_LIST]);
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append($createParagraphNode())
            .selectEnd()
            .insertText('* []'),
        {discrete: true},
      );
      editor.update(() => $getSelection()!.insertText(' '), {
        discrete: true,
      });
      editor.read(() => {
        const node = $getRoot().getFirstChild();
        expect(node).toBeInstanceOf(ListNode);
        const marker = node ? $getState(node, listMarkerState) : undefined;
        expect(marker).toBe('*');
      });
    });

    it('should remember marker used on export', () => {
      const editor = createTestEditor({
        nodes: [ListNode, ListItemNode],
      });
      editor.update(
        () => {
          const listNode = $createListNode();
          $setState(listNode, listMarkerState, '+');
          const listItemNode = $createListItemNode();
          listItemNode.append($createTextNode('hello'));
          listNode.append(listItemNode);
          listNode.setListType('bullet');
          $getRoot().select();
          $insertNodes([listNode]);
        },
        {discrete: true},
      );
      editor.read('latest', () => {
        const markdownString = $convertToMarkdownString(
          [...TRANSFORMERS],
          undefined,
          true,
        );
        expect(markdownString).toBe('+ hello');
      });
    });
  });

  describe('Enter key triggers', () => {
    it('should create an empty code block when ``` is typed and Enter is pressed', () => {
      const editor = createTestEditor({
        nodes: [
          HeadingNode,
          ListNode,
          ListItemNode,
          QuoteNode,
          CodeNode,
          LinkNode,
        ],
      });

      registerMarkdownShortcuts(editor, TRANSFORMERS);

      editor.update(
        () => {
          const root = $getRoot();
          const paragraph = $createParagraphNode();
          root.append(paragraph);
          paragraph.selectEnd();
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('```');
          }
        },
        {discrete: true},
      );

      editor.update(
        () => {
          editor.dispatchCommand(KEY_ENTER_COMMAND, null);
        },
        {discrete: true},
      );

      expect(editor.read(() => $generateHtmlFromNodes(editor))).toBe(
        '<pre spellcheck="false"></pre>',
      );
    });

    it('should create a code block with language when ```javascript is typed and Enter is pressed', () => {
      const editor = createTestEditor({
        nodes: [
          HeadingNode,
          ListNode,
          ListItemNode,
          QuoteNode,
          CodeNode,
          LinkNode,
        ],
      });

      registerMarkdownShortcuts(editor, TRANSFORMERS);

      editor.update(
        () => {
          const root = $getRoot();
          const paragraph = $createParagraphNode();
          root.append(paragraph);
          paragraph.selectEnd();
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('```javascript');
          }
        },
        {discrete: true},
      );

      editor.update(
        () => {
          editor.dispatchCommand(KEY_ENTER_COMMAND, null);
        },
        {discrete: true},
      );

      expect(editor.read(() => $generateHtmlFromNodes(editor))).toBe(
        '<pre spellcheck="false" data-language="javascript"></pre>',
      );
    });

    it('should not transform on Enter when replace returns false', () => {
      const CANCELED_CODE: MultilineElementTransformer = {
        dependencies: [CodeNode],
        regExpEnd: {
          optional: true,
          regExp: /^[ \t]*`{3,}$/,
        },
        regExpStart: /^`{3,}(\w+)?/,
        replace: () => {
          return false;
        },
        type: 'multiline-element',
      };

      const editor = createTestEditor({
        nodes: [
          HeadingNode,
          ListNode,
          ListItemNode,
          QuoteNode,
          CodeNode,
          LinkNode,
        ],
      });

      registerMarkdownShortcuts(editor, [CANCELED_CODE]);

      editor.update(
        () => {
          const root = $getRoot();
          const paragraph = $createParagraphNode();
          root.append(paragraph);
          paragraph.selectEnd();
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('```');
          }
        },
        {discrete: true},
      );

      editor.update(
        () => {
          editor.dispatchCommand(KEY_ENTER_COMMAND, null);
        },
        {discrete: true},
      );

      expect(editor.read(() => $generateHtmlFromNodes(editor))).toBe(
        '<p><span style="white-space: pre-wrap;">```</span></p>',
      );
    });

    it('should transform element markdown on Enter when trailing space was not required (custom element transformer)', () => {
      const ELEMENT_TRIGGERED_FENCE: ElementTransformer = {
        dependencies: [CodeNode],
        export: () => null,
        regExp: /^`{3,}(\w+)?$/,
        replace: (parentNode, children, match, isImport) => {
          const node = $createCodeNode(match[1]);
          node.append(...children);
          parentNode.replace(node);
          if (!isImport) {
            node.select(0, 0);
          }
        },
        triggerOnEnter: true,
        type: 'element',
      };

      const editor = createTestEditor({
        nodes: [
          HeadingNode,
          ListNode,
          ListItemNode,
          QuoteNode,
          CodeNode,
          LinkNode,
        ],
      });

      registerMarkdownShortcuts(editor, [ELEMENT_TRIGGERED_FENCE]);

      editor.update(
        () => {
          const root = $getRoot();
          const paragraph = $createParagraphNode();
          root.append(paragraph);
          paragraph.selectEnd();
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('```');
          }
        },
        {discrete: true},
      );

      editor.update(
        () => {
          editor.dispatchCommand(KEY_ENTER_COMMAND, null);
        },
        {discrete: true},
      );

      expect(editor.read(() => $generateHtmlFromNodes(editor))).toBe(
        '<pre spellcheck="false"></pre>',
      );
    });

    it('should transform heading on Enter when a line was inserted at once (no trailing space listener trigger)', () => {
      const editor = createTestEditor({
        nodes: [
          HeadingNode,
          ListNode,
          ListItemNode,
          QuoteNode,
          CodeNode,
          LinkNode,
        ],
      });

      registerMarkdownShortcuts(editor, [HEADING]);

      editor.update(
        () => {
          const root = $getRoot();
          const paragraph = $createParagraphNode();
          root.append(paragraph);
          paragraph.selectEnd();
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('## ');
          }
        },
        {discrete: true},
      );

      editor.update(
        () => {
          editor.dispatchCommand(KEY_ENTER_COMMAND, null);
        },
        {discrete: true},
      );

      expect(editor.read(() => $generateHtmlFromNodes(editor))).toBe(
        '<h2><br></h2>',
      );
    });
  });

  describe('composition-end trigger characters (#7026)', () => {
    function buildEditor() {
      const editor = createTestEditor({
        nodes: [
          HeadingNode,
          ListNode,
          ListItemNode,
          QuoteNode,
          CodeNode,
          LinkNode,
        ],
      });
      registerMarkdownShortcuts(editor, TRANSFORMERS);
      return editor;
    }

    function $getTextNode(): TextNode {
      const paragraph = $getRoot().getFirstChildOrThrow();
      invariant(
        $isParagraphNode(paragraph),
        'expected ParagraphNode at root[0]',
      );
      const textNode = paragraph.getFirstChildOrThrow();
      invariant($isTextNode(textNode), 'expected TextNode at paragraph[0]');
      return textNode;
    }

    it('applies inline code when the closing backtick is committed via compositionend', () => {
      const editor = buildEditor();

      // Set up "`hello" with the caret at offset 6. The first backtick was
      // typed normally, the rest mirrors what is in the editor once the
      // German dead-key sequence "` h e l l o" has resolved.
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          $getRoot().append(paragraph);
          const textNode = $createTextNode('`hello');
          paragraph.append(textNode);
          paragraph.selectEnd();
        },
        {discrete: true},
      );

      // Pretend compositionupdate is in progress: the backtick is pushed into
      // the text node, the caret advances to the trailing position (collapsed,
      // matching what a real compositionupdate leaves behind), and the editor
      // is marked composing so the markdown listener short-circuits on
      // `editor.isComposing()`.
      editor.update(
        () => {
          const textNode = $getTextNode();
          $setCompositionKey(textNode.getKey());
          textNode.setTextContent('`hello`');
          textNode.select(7, 7);
        },
        {discrete: true},
      );

      // compositionend flush: the text is already in place, the caret stays
      // where it is, and the COMPOSITION_END_TAG is added. Without the
      // bypass the listener would bail on `selection.is(prevSelection)`.
      editor.update(
        () => {
          $setCompositionKey(null);
          $addUpdateTag(COMPOSITION_END_TAG);
          $getTextNode().markDirty();
        },
        {discrete: true},
      );

      expect(editor.read(() => $generateHtmlFromNodes(editor))).toBe(
        '<p><code spellcheck="false" style="white-space: pre-wrap;"><span>hello</span></code></p>',
      );
    });

    it('applies inline code when compositionend commits the trigger as a multi-character chunk', () => {
      const editor = buildEditor();

      // Some IMEs (and synthetic event sources) skip compositionupdate and
      // land the entire composed run on compositionend. Model that here:
      // the caret stays at offset 6 across the composition, then jumps to 8
      // when compositionend commits "a`". The transform should still fire,
      // which requires the offset-jump bypass (the selection-equality bypass
      // alone is not enough here).
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          $getRoot().append(paragraph);
          const textNode = $createTextNode('`hello');
          paragraph.append(textNode);
          paragraph.selectEnd();
        },
        {discrete: true},
      );

      editor.update(
        () => {
          $setCompositionKey($getTextNode().getKey());
        },
        {discrete: true},
      );

      editor.update(
        () => {
          $setCompositionKey(null);
          $addUpdateTag(COMPOSITION_END_TAG);
          const textNode = $getTextNode();
          textNode.setTextContent('`helloa`');
          textNode.select(8, 8);
        },
        {discrete: true},
      );

      expect(editor.read(() => $generateHtmlFromNodes(editor))).toBe(
        '<p><code spellcheck="false" style="white-space: pre-wrap;"><span>helloa</span></code></p>',
      );
    });
  });
});

describe('normalizeMarkdown - shouldMergeAdjacentLines = true', () => {
  it('should combine lines separated by a single \n unless they are in a codeblock', () => {
    const markdown = `
A1
A2

A3

\`\`\`md
B1
B2

B3
\`\`\`

C1
C2

C3

\`\`\`js
D1
D2

D3
\`\`\`

\`\`\`single line code\`\`\`

E1
E2

E3
`;
    expect(normalizeMarkdown(markdown, true)).toBe(`
A1 A2

A3

\`\`\`md
B1
B2

B3
\`\`\`

C1 C2

C3

\`\`\`js
D1
D2

D3
\`\`\`

\`\`\`single line code\`\`\`

E1 E2

E3
`);
  });

  it('keeps fence-like lines that carry an info string as code content', () => {
    const markdown = `
\`\`\`ts
const a = 1
\`\`\`js
const b = 2
\`\`\`

After
`;
    // The inner ```js carries an info string, so it is part of the code block's
    // content. The block stays open until the bare ``` fence, and nothing after
    // it is merged into the fence-like content lines.
    expect(normalizeMarkdown(markdown, true)).toBe(markdown);
  });

  it('does not close a longer fence on a shorter inner fence', () => {
    const markdown = `
\`\`\`\`
\`\`\`
inner
\`\`\`
\`\`\`\`
`;
    expect(normalizeMarkdown(markdown, true)).toBe(markdown);
  });

  it('closes a shorter opening fence with a longer closing fence', () => {
    // Per CommonMark a closing fence may be longer than the opening fence:
    // https://spec.commonmark.org/0.31.2/#code-fences
    const markdown = `\`\`\`
line one
line two
\`\`\`\`
after one
after two`;
    // The 4-backtick line closes the 3-backtick block, so the lines inside the
    // block stay verbatim while the prose after the closing fence is merged.
    expect(normalizeMarkdown(markdown, true)).toBe(`\`\`\`
line one
line two
\`\`\`\`
after one after two`);
  });

  it('keeps content unmerged in an unclosed code block', () => {
    // Per CommonMark a fenced code block is also closed by the end of the
    // document, even without a closing fence:
    // https://spec.commonmark.org/0.31.2/#code-fences
    const markdown = `\`\`\`
line one
line two`;
    // Without a closing fence everything after the opening fence is code
    // content, so the lines must stay verbatim instead of being merged as prose.
    expect(normalizeMarkdown(markdown, true)).toBe(markdown);
  });

  it('tables', () => {
    const markdown = `
| a | b |
| --- | --- |
| c | d |
`;
    expect(normalizeMarkdown(markdown, true)).toBe(markdown);
  });

  it('merges adjacent plain text lines with a single space', () => {
    const md = `Hello
world`;
    expect(normalizeMarkdown(md, true)).toBe(`Hello world`);
  });

  it('merges while trimming the next line and inserting a single space', () => {
    const md = `Hello
   world   `;
    expect(normalizeMarkdown(md, true)).toBe(`Hello world`);
  });

  it('does not merge across HTML-like tags (opening, content, closing, after)', () => {
    const md = `<div>
content
</div>
after`;
    // Nothing should be merged
    expect(normalizeMarkdown(md, true)).toBe(md);
  });

  it('does not merge the fence line with the first line after a code block', () => {
    const md = '```\ncode\n```\nNext line';
    // The closing ``` must remain on its own line; "Next line" must not be glued to it
    expect(normalizeMarkdown(md, true)).toBe('```\ncode\n```\nNext line');
  });

  it('preserves hard-break trailing spaces when merging adjacent lines', () => {
    const md = ['foo  ', 'bar'].join('\n');
    expect(normalizeMarkdown(md, true)).toBe(md);
  });

  it('preserves exact hard-break trailing spaces when merging adjacent lines', () => {
    const md = ['foo   ', 'bar'].join('\n');
    expect(normalizeMarkdown(md, true)).toBe(md);
  });

  it('preserves backslash hard-breaks when merging adjacent lines', () => {
    const md = `foo\\
bar`;
    expect(normalizeMarkdown(md, true)).toBe(md);
  });

  it('merges a soft break before a hard-breaking line', () => {
    const md = ['foo', 'bar  ', 'baz'].join('\n');
    expect(normalizeMarkdown(md, true)).toBe(['foo bar  ', 'baz'].join('\n'));
  });

  it('treats whitespace-only lines as empty separators (no merge across them)', () => {
    const md = `A1
     
A2`;
    // The middle line is spaces only; should be treated as an empty separator
    expect(normalizeMarkdown(md, true)).toBe(`A1

A2`);
  });

  it('mdx start tag followed by content, than closing tag preceded by content', () => {
    const md = `<MyComponent>Line 1
Some Text</MyComponent>`;
    expect(normalizeMarkdown(md, true)).toBe(
      `<MyComponent>Line 1 Some Text</MyComponent>`,
    );
  });
});

describe('normalizeMarkdown - shouldMergeAdjacentLines = false', () => {
  it('should not combine lines separated by a single \n', () => {
    const markdown = `
A1
A2

A3

\`\`\`md
B1
B2

B3
\`\`\`

C1
C2

C3

\`\`\`js
D1
D2

D3
\`\`\`

\`\`\`single line code\`\`\`

E1
E2

E3
`;
    expect(normalizeMarkdown(markdown, false)).toBe(`
A1
A2

A3

\`\`\`md
B1
B2

B3
\`\`\`

C1
C2

C3

\`\`\`js
D1
D2

D3
\`\`\`

\`\`\`single line code\`\`\`

E1
E2

E3
`);
  });

  it('tables', () => {
    const markdown = `
| a | b |
| --- | --- |
| c | d |
`;
    expect(normalizeMarkdown(markdown, false)).toBe(markdown);
  });

  it('preserves trailing whitespace on content lines', () => {
    const md = 'foo   \n\nbar';
    expect(normalizeMarkdown(md, false)).toBe('foo   \n\nbar');
  });

  it('collapses whitespace-only lines to empty (paragraph separator)', () => {
    const md = 'A\n   \nB';
    expect(normalizeMarkdown(md, false)).toBe('A\n\nB');
  });

  it('preserves leading whitespace on content lines', () => {
    const md = '   foo\n\nbar';
    expect(normalizeMarkdown(md, false)).toBe('   foo\n\nbar');
  });

  it('preserves indented fenced code blocks nested inside tags', () => {
    const markdown = `
<Banner>
\`\`\`ts
  indent 1;
\`\`\`
</Banner>
`;
    expect(normalizeMarkdown(markdown, false)).toBe(markdown);
  });
});

describe('markdown hard line break import', () => {
  it('preserves hard line break when shouldPreserveNewLines is true', () => {
    const md = `foo  
bar`;
    const editor = createTestEditor({
      nodes: [
        HeadingNode,
        ListNode,
        ListItemNode,
        QuoteNode,
        CodeNode,
        LinkNode,
      ],
    });

    editor.update(
      () =>
        $convertFromMarkdownString(
          md,
          [...TRANSFORMERS, HIGHLIGHT_TEXT_MATCH_IMPORT],
          undefined,
          true,
        ),
      {
        discrete: true,
      },
    );

    expect(
      editor.read('latest', () =>
        $convertToMarkdownString(
          [...TRANSFORMERS, HIGHLIGHT_TEXT_MATCH_IMPORT],
          undefined,
          true,
        ),
      ),
    ).toBe(md);
  });

  it('preserves backslash hard line break when shouldPreserveNewLines is true', () => {
    const md = `foo\\
bar`;
    const editor = createTestEditor({
      nodes: [
        HeadingNode,
        ListNode,
        ListItemNode,
        QuoteNode,
        CodeNode,
        LinkNode,
      ],
    });

    editor.update(
      () =>
        $convertFromMarkdownString(
          md,
          [...TRANSFORMERS, HIGHLIGHT_TEXT_MATCH_IMPORT],
          undefined,
          true,
        ),
      {
        discrete: true,
      },
    );

    expect(
      editor.read('latest', () =>
        $convertToMarkdownString(
          [...TRANSFORMERS, HIGHLIGHT_TEXT_MATCH_IMPORT],
          undefined,
          true,
        ),
      ),
    ).toBe(md);
  });
});

describe('markdown whitespace import (default mode)', () => {
  function expectRoundTrip(md: string, shouldMergeAdjacentLines = false): void {
    const editor = createTestEditor();

    editor.update(
      () =>
        $convertFromMarkdownString(
          md,
          [...TRANSFORMERS, HIGHLIGHT_TEXT_MATCH_IMPORT],
          undefined,
          false,
          shouldMergeAdjacentLines,
        ),
      {discrete: true},
    );

    expect(
      editor.read('latest', () =>
        $convertToMarkdownString([
          ...TRANSFORMERS,
          HIGHLIGHT_TEXT_MATCH_IMPORT,
        ]),
      ),
    ).toBe(md);
  }

  function getHardLineBreakMarker(line: string): string {
    const parsed = parseMarkdownHardLineBreak(line);
    assert(parsed !== null, 'Expected a hard line break marker');
    return parsed[1];
  }

  function expectImportedHardLineBreakMarker(md: string, marker: string): void {
    const editor = createTestEditor();

    editor.update(
      () =>
        $convertFromMarkdownString(md, [
          ...TRANSFORMERS,
          HIGHLIGHT_TEXT_MATCH_IMPORT,
        ]),
      {discrete: true},
    );

    editor.read('latest', () => {
      const block = $getRoot().getFirstChildOrThrow();
      assert($isElementNode(block), 'Expected an element block');
      const lineBreakNode = block
        .getChildren()
        .find(child => $isLineBreakNode(child));

      assert(lineBreakNode !== undefined, 'Expected a line break node');
      expect(
        block
          .getChildren()
          .filter($isTextNode)
          .map(child => child.getTextContent()),
      ).not.toContain(marker);
      expect(block.getTextContent()).toBe('foo\nbar');
      expect($getState(lineBreakNode, hardLineBreakState)).toBe(marker);
    });

    expect(
      editor.read('latest', () =>
        $convertToMarkdownString([
          ...TRANSFORMERS,
          HIGHLIGHT_TEXT_MATCH_IMPORT,
        ]),
      ),
    ).toBe(md);
  }

  it('preserves trailing whitespace on a standalone paragraph line (default mode)', () => {
    // A paragraph with trailing spaces, separated by an empty line from the next.
    const md = 'hello world   \n\nnext paragraph';
    const editor = createTestEditor();

    editor.update(
      () =>
        $convertFromMarkdownString(md, [
          ...TRANSFORMERS,
          HIGHLIGHT_TEXT_MATCH_IMPORT,
        ]),
      {discrete: true},
    );

    expect(
      editor.read('latest', () =>
        $convertToMarkdownString([
          ...TRANSFORMERS,
          HIGHLIGHT_TEXT_MATCH_IMPORT,
        ]),
      ),
    ).toBe(md);
  });

  it('preserves leading whitespace on a standalone paragraph line (default mode)', () => {
    const md = '   hello world\n\nnext paragraph';
    const editor = createTestEditor();

    editor.update(
      () =>
        $convertFromMarkdownString(md, [
          ...TRANSFORMERS,
          HIGHLIGHT_TEXT_MATCH_IMPORT,
        ]),
      {discrete: true},
    );

    expect(
      editor.read('latest', () =>
        $convertToMarkdownString([
          ...TRANSFORMERS,
          HIGHLIGHT_TEXT_MATCH_IMPORT,
        ]),
      ),
    ).toBe(md);
  });

  it('preserves two-space hard line break in default mode', () => {
    // In default mode, "foo  \nbar" has two adjacent non-empty lines → normalizeMarkdown
    // preserves the trailing "  " which $importBlocks then converts to a LineBreakNode.
    expectRoundTrip('foo  \nbar');
  });

  it('preserves exact hard line break spaces in default mode', () => {
    expectRoundTrip('foo   \nbar');
  });

  it('preserves backslash hard line break in default mode', () => {
    expectRoundTrip('foo\\\nbar');
  });

  it('stores a two-space hard line break marker after formatted text', () => {
    expectImportedHardLineBreakMarker('**foo**  \nbar', '  ');
  });

  it('stores exact hard line break spaces after formatted text', () => {
    expectImportedHardLineBreakMarker('**foo**   \nbar', '   ');
  });

  it('stores a two-space hard line break marker after a link', () => {
    expectImportedHardLineBreakMarker(
      '[foo](https://lexical.dev)  \nbar',
      '  ',
    );
  });

  it('does not infer a hard line break marker from spaces inside a link', () => {
    const md = '[foo  ](https://lexical.dev)\nbar';
    const editor = createTestEditor();

    editor.update(
      () =>
        $convertFromMarkdownString(md, [
          ...TRANSFORMERS,
          HIGHLIGHT_TEXT_MATCH_IMPORT,
        ]),
      {discrete: true},
    );

    editor.read('latest', () => {
      const block = $getRoot().getFirstChildOrThrow();
      assert($isElementNode(block), 'Expected an element block');
      const lineBreakNode = block
        .getChildren()
        .find(child => $isLineBreakNode(child));

      assert(lineBreakNode !== undefined, 'Expected a line break node');
      expect(block.getTextContent()).toBe('foo  \nbar');
      expect($getState(lineBreakNode, hardLineBreakState)).toBe('');
    });

    expect(
      editor.read('latest', () =>
        $convertToMarkdownString([
          ...TRANSFORMERS,
          HIGHLIGHT_TEXT_MATCH_IMPORT,
        ]),
      ),
    ).toBe(md);
  });

  it('stores a two-space hard line break marker after formatted blockquote text', () => {
    expectImportedHardLineBreakMarker('> **foo**  \n> bar', '  ');
  });

  it('preserves two-space hard line break in merge-adjacent mode', () => {
    expectRoundTrip('foo  \nbar', true);
  });

  it('preserves exact hard line break spaces in merge-adjacent mode', () => {
    expectRoundTrip('foo   \nbar', true);
  });

  it('preserves backslash hard line break in merge-adjacent mode', () => {
    expectRoundTrip('foo\\\nbar', true);
  });

  it('preserves two-space hard line break between blockquote lines', () => {
    expectRoundTrip('> foo  \n> bar');
  });

  it('preserves exact hard line break spaces between blockquote lines', () => {
    expectRoundTrip('> foo   \n> bar');
  });

  it('preserves backslash hard line break between blockquote lines', () => {
    expectRoundTrip('> foo\\\n> bar');
  });

  it('exports exact hard line break markers from line break state', () => {
    const editor = createTestEditor();
    const marker = getHardLineBreakMarker('foo   ');

    editor.update(
      () => {
        const lineBreakNode = $createLineBreakNode();
        $setState(lineBreakNode, hardLineBreakState, marker);
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('foo'),
              lineBreakNode,
              $createTextNode('bar'),
            ),
          );
      },
      {discrete: true},
    );

    expect(
      editor.read('latest', () =>
        $convertToMarkdownString([
          ...TRANSFORMERS,
          HIGHLIGHT_TEXT_MATCH_IMPORT,
        ]),
      ),
    ).toBe('foo   \nbar');
  });

  it('does not copy markdown hard line break markers when line breaks are copied', () => {
    const editor = createTestEditor();
    const marker = getHardLineBreakMarker('foo   ');

    editor.update(
      () => {
        const lineBreakNode = $createLineBreakNode();
        $setState(lineBreakNode, hardLineBreakState, marker);

        expect($getState(lineBreakNode, hardLineBreakState)).toBe('   ');
        const copy = $copyNode(lineBreakNode);
        expect($getState(copy, hardLineBreakState)).toBe('');
        expect($getState(lineBreakNode, hardLineBreakState)).toBe('   ');
      },
      {discrete: true},
    );
  });
});

// Tests for issue #8012: negative lookbehind assertions (?<!) throw a SyntaxError
// in Safari < 16.4 at RegExp construction time, crashing the entire editor.
// The fix captures the preceding character in group 1 instead.
describe('markdown Safari compatibility (issue #8012)', () => {
  function roundtrip(md: string): string {
    const editor = createTestEditor();
    editor.update(() => $convertFromMarkdownString(md, TRANSFORMERS), {
      discrete: true,
    });
    return editor.read('latest', () => $convertToMarkdownString(TRANSFORMERS));
  }

  it('does not throw when constructing markdown regex patterns', () => {
    expect(() => {
      const editor = createTestEditor();
      editor.update(() => $convertFromMarkdownString('`hello`', TRANSFORMERS), {
        discrete: true,
      });
    }).not.toThrow();
  });

  it('parses a code span at the start of a string', () => {
    expect(roundtrip('`hello` world')).toBe('`hello` world');
  });

  it('parses a code span in the middle of text', () => {
    expect(roundtrip('foo `code` bar')).toBe('foo `code` bar');
  });

  it('parses multiple code spans on the same line', () => {
    expect(roundtrip('`a` and `b`')).toBe('`a` and `b`');
  });

  it('does not parse a backtick preceded by a backslash as a code span', () => {
    const editor = createTestEditor();
    editor.update(
      () => $convertFromMarkdownString('\\`not code\\`', TRANSFORMERS),
      {discrete: true},
    );
    const textContent = editor.read('latest', () =>
      $getRoot().getTextContent(),
    );
    expect(textContent).toBe('`not code`');
  });

  it('correctly captures code span content', () => {
    expect(roundtrip('`hello world`')).toBe('`hello world`');
    expect(roundtrip('foo `bar baz` qux')).toBe('foo `bar baz` qux');
  });

  it('does not apply emphasis formatting inside a code span', () => {
    expect(roundtrip('`**not bold**`')).toBe('`**not bold**`');
  });
});

describe('inline code with backticks (CommonMark code spans)', () => {
  function roundtrip(md: string): string {
    const editor = createTestEditor();
    editor.update(() => $convertFromMarkdownString(md, TRANSFORMERS), {
      discrete: true,
    });
    return editor.read('latest', () => $convertToMarkdownString(TRANSFORMERS));
  }

  function exportCodeSpan(content: string): string {
    const editor = createTestEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        const text = $createTextNode(content);
        text.toggleFormat('code');
        paragraph.append(text);
        $getRoot().append(paragraph);
      },
      {discrete: true},
    );
    return editor.read('latest', () => $convertToMarkdownString(TRANSFORMERS));
  }

  it('round-trips code spans whose content contains backticks', () => {
    expect(roundtrip('Here: `` a`b ``')).toBe('Here: `` a`b ``');
    expect(roundtrip('Code: ``` a``b ```')).toBe('Code: ``` a``b ```');
    expect(roundtrip('`` `x ``')).toBe('`` `x ``');
  });

  it('exports a content-derived fence longer than any backtick run', () => {
    expect(exportCodeSpan('block code')).toBe('`block code`');
    expect(exportCodeSpan('a`b')).toBe('`` a`b ``');
    expect(exportCodeSpan('a``b')).toBe('``` a``b ```');
    expect(exportCodeSpan('`x')).toBe('`` `x ``');
  });

  it('normalizes a redundant inline fence to the minimal valid fence', () => {
    // Both a single- and triple-backtick inline fence with backtick-free
    // content normalize to a single backtick on export.
    expect(roundtrip('a `block code` b')).toBe('a `block code` b');
    expect(roundtrip('a ```block code``` b')).toBe('a `block code` b');
  });

  it('keeps the code fence innermost when combined with bold', () => {
    expect(roundtrip('**`` a`b ``**')).toBe('**`` a`b ``**');
  });
});

describe('$convertSelectionToMarkdownString', () => {
  it('converts full selection to markdown', () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const text = $createTextNode('Hello World');
        paragraph.append(text);
        root.append(paragraph);
        text.select(0);
      },
      {discrete: true},
    );
    const result = editor.read('latest', () =>
      $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
    );
    expect(result).toBe('Hello World');
  });

  it('converts partial text selection to markdown', () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const text = $createTextNode('Hello World');
        paragraph.append(text);
        root.append(paragraph);
        text.select(6, 11);
      },
      {discrete: true},
    );
    const result = editor.read('latest', () =>
      $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
    );
    expect(result).toBe('World');
  });

  it('converts selection with bold text to markdown', () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const normal = $createTextNode('Hello ');
        const bold = $createTextNode('Bold');
        bold.toggleFormat('bold');
        const after = $createTextNode(' World');
        paragraph.append(normal, bold, after);
        root.append(paragraph);
        $setSelectionFromCaretRange(
          $getCaretRange(
            $getTextPointCaret(normal, 'next', 0),
            $getTextPointCaret(bold, 'next', 4),
          ),
        );
      },
      {discrete: true},
    );
    const result = editor.read('latest', () =>
      $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
    );
    expect(result).toBe('Hello **Bold**');
  });

  it('does not prefix a newline when the selection starts after the first block', () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const firstText = $createTextNode('First');
        const secondText = $createTextNode('Second');
        const thirdText = $createTextNode('Third');
        root.append(
          $createParagraphNode().append(firstText),
          $createParagraphNode().append(secondText),
          $createParagraphNode().append(thirdText),
        );
        $setSelectionFromCaretRange(
          $getCaretRange(
            $getTextPointCaret(secondText, 'next', 0),
            $getTextPointCaret(thirdText, 'next', 5),
          ),
        );
      },
      {discrete: true},
    );
    const result = editor.read('latest', () =>
      $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
    );
    expect(result).toBe('Second\n\nThird');
  });

  it('returns empty string for null selection', () => {
    const result = $convertSelectionToMarkdownString(TRANSFORMERS, null);
    expect(result).toBe('');
  });

  it('returns empty string for collapsed selection', () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const text = $createTextNode('Hello World');
        paragraph.append(text);
        root.append(paragraph);
        text.select(5, 5);
      },
      {discrete: true},
    );
    const result = editor.read('latest', () =>
      $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
    );
    expect(result).toBe('');
  });

  it('converts backward selection to markdown', () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const text = $createTextNode('Hello World');
        paragraph.append(text);
        root.append(paragraph);
        text.select(5, 0);
      },
      {discrete: true},
    );
    const result = editor.read('latest', () =>
      $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
    );
    expect(result).toBe('Hello');
  });

  it('converts multi-paragraph selection to markdown', () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const p1 = $createParagraphNode();
        const t1 = $createTextNode('First paragraph');
        p1.append(t1);
        const p2 = $createParagraphNode();
        const t2 = $createTextNode('Second paragraph');
        p2.append(t2);
        root.append(p1, p2);
        $setSelectionFromCaretRange(
          $getCaretRange(
            $getTextPointCaret(t1, 'next', 0),
            $getTextPointCaret(t2, 'next', 'next'),
          ),
        );
      },
      {discrete: true},
    );
    const result = editor.read('latest', () =>
      $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
    );
    expect(result).toBe('First paragraph\n\nSecond paragraph');
  });

  it('converts selection within a list to markdown', () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const list = $createListNode('bullet');
        const item1 = $createListItemNode();
        const t1 = $createTextNode('Item 1');
        item1.append(t1);
        const item2 = $createListItemNode();
        const t2 = $createTextNode('Item 2');
        item2.append(t2);
        list.append(item1, item2);
        root.append(list);
        $setSelectionFromCaretRange(
          $getCaretRange(
            $getTextPointCaret(t1, 'next', 0),
            $getTextPointCaret(t2, 'next', 'next'),
          ),
        );
      },
      {discrete: true},
    );
    const result = editor.read('latest', () =>
      $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
    );
    expect(result).toBe('- Item 1\n- Item 2');
  });

  it('preserves link when partially selecting link text', () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const before = $createTextNode('before ');
        const linkNode = $createLinkNode('https://example.com');
        const linkText = $createTextNode('link text');
        linkNode.append(linkText);
        const after = $createTextNode(' after');
        paragraph.append(before, linkNode, after);
        root.append(paragraph);
        linkText.select(0, 4);
      },
      {discrete: true},
    );
    const result = editor.read('latest', () =>
      $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
    );
    expect(result).toBe('[link](https://example.com)');
  });

  it('list partial selection only includes selected items', () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const list = $createListNode('bullet');
        const item1 = $createListItemNode();
        const t1 = $createTextNode('Item 1');
        item1.append(t1);
        const item2 = $createListItemNode();
        const t2 = $createTextNode('Item 2');
        item2.append(t2);
        const item3 = $createListItemNode();
        const t3 = $createTextNode('Item 3');
        item3.append(t3);
        list.append(item1, item2, item3);
        root.append(list);
        $setSelectionFromCaretRange(
          $getCaretRange(
            $getTextPointCaret(t2, 'next', 0),
            $getTextPointCaret(t3, 'next', 2),
          ),
        );
      },
      {discrete: true},
    );
    const result = editor.read('latest', () =>
      $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
    );
    expect(result).toBe('- Item 2\n- It');
  });

  it('quote partial selection only includes selected text', () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const quote = $createQuoteNode();
        const t1 = $createTextNode('Line 1');
        const br = $createLineBreakNode();
        const t2 = $createTextNode('Line 2');
        quote.append(t1, br, t2);
        root.append(quote);
        t2.select(0);
      },
      {discrete: true},
    );
    const result = editor.read('latest', () =>
      $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
    );
    expect(result).toBe('> Line 2');
  });

  it('nested list partial selection only includes selected nested items', () => {
    const editor = createTestEditor();
    editor.update(
      () => {
        const root = $getRoot();
        const list = $createListNode('bullet');
        const item1 = $createListItemNode();
        const t1 = $createTextNode('Item 1');
        item1.append(t1);
        const nestedContainer = $createListItemNode();
        const nestedList = $createListNode('bullet');
        const nestedItem1 = $createListItemNode();
        const nt1 = $createTextNode('Nested A');
        nestedItem1.append(nt1);
        const nestedItem2 = $createListItemNode();
        const nt2 = $createTextNode('Nested B');
        nestedItem2.append(nt2);
        nestedList.append(nestedItem1, nestedItem2);
        nestedContainer.append(nestedList);
        const item3 = $createListItemNode();
        const t3 = $createTextNode('Item 3');
        item3.append(t3);
        list.append(item1, nestedContainer, item3);
        root.append(list);
        nt1.select(0);
      },
      {discrete: true},
    );
    const result = editor.read('latest', () =>
      $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
    );
    expect(result).toBe('    - Nested A');
  });
});

describe('List marker details', () => {
  const baseNodes = [
    HeadingNode,
    ListNode,
    ListItemNode,
    QuoteNode,
    CodeNode,
    LinkNode,
  ];

  it('reads an uppercase [X] as checked, as the /i on its regex intends', () => {
    const editor = createTestEditor({nodes: baseNodes});

    editor.update(
      () =>
        $convertFromMarkdownString('- [X] up\n- [ ] no', [
          CHECK_LIST,
          ...TRANSFORMERS,
        ]),
      {discrete: true},
    );

    expect(editor.read('latest', () => $generateHtmlFromNodes(editor))).toBe(
      '<ul __lexicallisttype="check"><li role="checkbox" tabindex="-1" aria-checked="true" value="1"><span style="white-space: pre-wrap;">up</span></li><li role="checkbox" tabindex="-1" aria-checked="false" value="2"><span style="white-space: pre-wrap;">no</span></li></ul>',
    );
  });

  it('expands a tab after the marker when measuring the content column', () => {
    const editor = createTestEditor({nodes: baseNodes});

    // The tab opens the content of `a` at column four, so a two-space `- b`
    // does not reach it and stays a sibling.
    editor.update(
      () => $convertFromMarkdownString('-\ta\n  - b', TRANSFORMERS),
      {discrete: true},
    );

    expect(editor.read('latest', () => $generateHtmlFromNodes(editor))).toBe(
      '<ul><li value="1"><span style="white-space: pre-wrap;">a</span></li><li value="2"><span style="white-space: pre-wrap;">b</span></li></ul>',
    );
  });

  it('keeps a typed start number out of a list the item only passes through', () => {
    const editor = createTestEditor({nodes: baseNodes});
    registerMarkdownShortcuts(editor, TRANSFORMERS);

    // Typing an indented ordered marker above an existing ordered list sends
    // the item into a sublist, so the outer list's start stays what it was.
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        root.append(
          paragraph,
          $createListNode('number', 5).append(
            $createListItemNode().append($createTextNode('y')),
          ),
        );
        paragraph.selectEnd();
      },
      {discrete: true},
    );
    for (const char of '    1. z') {
      editor.update(
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText(char);
          }
        },
        {discrete: true},
      );
    }
    editor.update(() => {}, {discrete: true});

    editor.read('latest', () => {
      const list = $getRoot().getFirstChild();
      invariant($isListNode(list), 'expected a list');
      expect(list.getStart()).toBe(5);
      expect(list.getLastChild()!.getTextContent()).toBe('y');
    });
  });
});

describe('Loose sublists', () => {
  const baseNodes = [
    HeadingNode,
    ListNode,
    ListItemNode,
    QuoteNode,
    CodeNode,
    LinkNode,
  ];

  it('nests a loose type-changing sublist into the item above it', () => {
    const editor = createTestEditor({nodes: baseNodes});

    editor.update(
      () => $convertFromMarkdownString('- a\n\n  1. b', TRANSFORMERS),
      {discrete: true},
    );

    expect(editor.read('latest', () => $generateHtmlFromNodes(editor))).toBe(
      '<ul><li value="1"><span style="white-space: pre-wrap;">a</span><ol><li value="1"><span style="white-space: pre-wrap;">b</span></li></ol></li></ul>',
    );
  });

  it('returns one joined list from $generateNodesFromMarkdownString', () => {
    const editor = createTestEditor({nodes: baseNodes});

    // No ListNode transform runs over the returned nodes, so the loose list
    // has to come back joined rather than as two lists a later transform
    // would merge. Asserted outside the update so the assertion cannot depend
    // on the editor's error handler.
    let shape = '';
    editor.update(
      () => {
        shape = $generateNodesFromMarkdownString('- a\n\n  - b', TRANSFORMERS)
          .map(node => ($isListNode(node) ? 'list' : node.getType()))
          .join(',');
      },
      {discrete: true},
    );

    expect(shape).toBe('list');
  });
});

describe('Sublist indent boundaries', () => {
  const baseNodes = [
    HeadingNode,
    ListNode,
    ListItemNode,
    QuoteNode,
    CodeNode,
    LinkNode,
  ];

  it("does not nest an indent short of a wide marker's content column", () => {
    const editor = createTestEditor({nodes: baseNodes});

    // `10. ` opens its content at column four, so three spaces is one short of
    // a sublist and the line starts a list of its own.
    editor.update(
      () => $convertFromMarkdownString('10. a\n   - b', TRANSFORMERS),
      {discrete: true},
    );

    expect(editor.read('latest', () => $generateHtmlFromNodes(editor))).toBe(
      '<ol start="10"><li value="10"><span style="white-space: pre-wrap;">a</span></li></ol><ul><li value="1"><span style="white-space: pre-wrap;">b</span></li></ul>',
    );
  });

  it('keeps a retyped sublist in front of the one it was placed before', () => {
    const editor = createTestEditor({nodes: baseNodes});
    registerMarkdownShortcuts(editor, TRANSFORMERS);

    // Typing above a list whose first child is a nested list of another type
    // puts the new item in front of that nested list, so the list built for
    // its own type belongs in front of it too.
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        root.append(
          paragraph,
          $createListNode('number').append(
            $createListItemNode().append(
              $createListNode('bullet').append(
                $createListItemNode().append($createTextNode('x')),
              ),
            ),
            $createListItemNode().append($createTextNode('y')),
          ),
        );
        paragraph.selectEnd();
      },
      {discrete: true},
    );
    for (const char of '    1. z') {
      editor.update(
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText(char);
          }
        },
        {discrete: true},
      );
    }
    editor.update(() => {}, {discrete: true});

    expect(editor.read('latest', () => $generateHtmlFromNodes(editor))).toBe(
      '<ol><li value="1"><ol><li value="1"><span style="white-space: pre-wrap;">z</span></li></ol><ul><li value="1"><span style="white-space: pre-wrap;">x</span></li></ul></li><li value="1"><span style="white-space: pre-wrap;">y</span></li></ol>',
    );
  });
});

describe('Loose list indents round trip', () => {
  const baseNodes = [
    HeadingNode,
    ListNode,
    ListItemNode,
    QuoteNode,
    CodeNode,
    LinkNode,
  ];

  function convert(md: string): string {
    const editor = createTestEditor({nodes: baseNodes});
    editor.update(() => $convertFromMarkdownString(md, TRANSFORMERS), {
      discrete: true,
    });
    return editor.read('latest', () => $convertToMarkdownString(TRANSFORMERS));
  }

  // Export writes one fixed step per level and drops the blank line, so a
  // blank line that changed how the indent was read would send the second
  // pass somewhere the first did not go.
  it.each([
    '- a\n\n  - b',
    '- a\n\n        - b',
    '1. First\n\n   - detail',
    '- a\n\ntext\n\n  - b',
  ])('re-imports its own export of "%s" unchanged', md => {
    const once = convert(md);

    expect(convert(once)).toBe(once);
  });
});

describe('Sublist markers', () => {
  const baseNodes = [
    HeadingNode,
    ListNode,
    ListItemNode,
    QuoteNode,
    CodeNode,
    LinkNode,
  ];

  it('records a marker on the list the item lands in, not the one above it', () => {
    const editor = createTestEditor({nodes: baseNodes});
    const md = '- a\n    * b\n    * c';

    editor.update(() => $convertFromMarkdownString(md, TRANSFORMERS), {
      discrete: true,
    });

    expect(
      editor.read('latest', () => $convertToMarkdownString(TRANSFORMERS)),
    ).toBe(md);
  });
});

describe('Typed sublist shortcuts', () => {
  const baseNodes = [
    HeadingNode,
    ListNode,
    ListItemNode,
    QuoteNode,
    CodeNode,
    LinkNode,
  ];

  function typeLines(editor: LexicalEditor, lines: string[]): void {
    for (const line of lines) {
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          $getRoot().append(paragraph);
          paragraph.selectEnd();
        },
        {discrete: true},
      );
      // One character at a time: the shortcut fires on the space that closes
      // the marker, so anything after it is typed into whatever the shortcut
      // left the caret in.
      for (const char of line) {
        editor.update(
          () => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.insertText(char);
            }
          },
          {discrete: true},
        );
      }
    }
  }

  function caretText(editor: LexicalEditor): string {
    return editor.read('latest', () => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'expected a range selection');
      return `${selection.anchor.getNode().getTextContent()}@${
        selection.anchor.offset
      }`;
    });
  }

  // The indent of a line with no list above it has no content column to be
  // measured against, so it falls back to a fixed LIST_INDENT_SIZE per level.
  // packages/lexical-playground/__tests__/e2e/Markdown.spec.mjs asserts the
  // same shapes.
  it.each([
    ['1. ', '<ol><li value="1"></li></ol>'],
    ['    1. ', '<ol><li value="1"><ol><li value="1"></li></ol></li></ol>'],
    ['- ', '<ul><li value="1"></li></ul>'],
    ['    - ', '<ul><li value="1"><ul><li value="1"></li></ul></li></ul>'],
    ['      * ', '<ul><li value="1"><ul><li value="1"></li></ul></li></ul>'],
    [
      '        * ',
      '<ul><li value="1"><ul><li value="1"><ul><li value="1"></li></ul></li></ul></li></ul>',
    ],
    ['\t- ', '<ul><li value="1"><ul><li value="1"></li></ul></li></ul>'],
  ])('indents a typed "%s" with no list above it', (text, html) => {
    const editor = createTestEditor({nodes: baseNodes});
    registerMarkdownShortcuts(editor, TRANSFORMERS);

    typeLines(editor, [text]);
    // The shortcut runs from an update listener, so it lands on the next
    // update rather than the one that typed the closing space.
    editor.update(() => {}, {discrete: true});

    expect(editor.read('latest', () => $generateHtmlFromNodes(editor))).toBe(
      html,
    );
  });

  it('nests a typed sublist of another type and keeps the caret in it', () => {
    const editor = createTestEditor({nodes: baseNodes});
    registerMarkdownShortcuts(editor, TRANSFORMERS);

    typeLines(editor, ['- a', '    1. b']);

    expect(editor.read('latest', () => $generateHtmlFromNodes(editor))).toBe(
      '<ul><li value="1"><span style="white-space: pre-wrap;">a</span><ol><li value="1"><span style="white-space: pre-wrap;">b</span></li></ol></li></ul>',
    );
    expect(caretText(editor)).toBe('b@1');
  });

  it('nests a typed sublist of the same type and keeps the caret in it', () => {
    const editor = createTestEditor({nodes: baseNodes});
    registerMarkdownShortcuts(editor, TRANSFORMERS);

    typeLines(editor, ['- a', '    - b']);

    expect(editor.read('latest', () => $generateHtmlFromNodes(editor))).toBe(
      '<ul><li value="1"><span style="white-space: pre-wrap;">a</span><ul><li value="1"><span style="white-space: pre-wrap;">b</span></li></ul></li></ul>',
    );
    expect(caretText(editor)).toBe('b@1');
  });

  // A typed line stands on its own: nothing records the column the list above
  // it was written at, so its indent is read as a fixed LIST_INDENT_SIZE per
  // level -- the step $listExport writes and the toolbar indents by. An
  // imported document is read by content column instead, which is what the
  // "CommonMark sublist indents" cases below cover.
  it('reads a typed indent in fixed steps, not by content column', () => {
    const editor = createTestEditor({nodes: baseNodes});
    registerMarkdownShortcuts(editor, TRANSFORMERS);

    typeLines(editor, ['1. a', '   - b']);

    expect(editor.read('latest', () => $generateHtmlFromNodes(editor))).toBe(
      '<ol><li value="1"><span style="white-space: pre-wrap;">a</span></li></ol><ul><li value="1"><span style="white-space: pre-wrap;">b</span></li></ul>',
    );
    expect(caretText(editor)).toBe('b@1');
  });

  it('nests a typed sublist under a list a shortcut did not create', () => {
    const editor = createTestEditor({nodes: baseNodes});
    registerMarkdownShortcuts(editor, TRANSFORMERS);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        root.append(
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('a')),
          ),
        );
      },
      {discrete: true},
    );
    typeLines(editor, ['    1. b']);

    expect(editor.read('latest', () => $generateHtmlFromNodes(editor))).toBe(
      '<ul><li value="1"><span style="white-space: pre-wrap;">a</span><ol><li value="1"><span style="white-space: pre-wrap;">b</span></li></ol></li></ul>',
    );
    expect(caretText(editor)).toBe('b@1');
  });
});

describe('Ordered list start adjustment (#8677)', () => {
  const baseNodes = [
    HeadingNode,
    ListNode,
    ListItemNode,
    QuoteNode,
    CodeNode,
    LinkNode,
  ];

  it('updates list start when typed marker precedes an existing ordered list', () => {
    const editor = createTestEditor({nodes: baseNodes});
    registerMarkdownShortcuts(editor, TRANSFORMERS);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const list = $createListNode('number', 2).append(
          $createListItemNode().append($createTextNode('A')),
          $createListItemNode().append($createTextNode('B')),
        );
        root.append(paragraph, list);
        paragraph.selectEnd().insertText('1.');
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(' ');
        }
      },
      {discrete: true},
    );

    expect(editor.read(() => $generateHtmlFromNodes(editor))).toBe(
      '<ol><li value="1"></li><li value="2"><span style="white-space: pre-wrap;">A</span></li><li value="3"><span style="white-space: pre-wrap;">B</span></li></ol>',
    );
  });

  it('respects an arbitrary typed start number', () => {
    const editor = createTestEditor({nodes: baseNodes});
    registerMarkdownShortcuts(editor, TRANSFORMERS);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const list = $createListNode('number', 2).append(
          $createListItemNode().append($createTextNode('A')),
        );
        root.append(paragraph, list);
        paragraph.selectEnd().insertText('7.');
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(' ');
        }
      },
      {discrete: true},
    );

    expect(editor.read(() => $generateHtmlFromNodes(editor))).toBe(
      '<ol start="7"><li value="7"></li><li value="8"><span style="white-space: pre-wrap;">A</span></li></ol>',
    );
  });

  it('does not change start when typed marker follows an existing ordered list', () => {
    const editor = createTestEditor({nodes: baseNodes});
    registerMarkdownShortcuts(editor, TRANSFORMERS);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const list = $createListNode('number', 2).append(
          $createListItemNode().append($createTextNode('A')),
        );
        const paragraph = $createParagraphNode();
        root.append(list, paragraph);
        paragraph.selectEnd().insertText('9.');
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(' ');
        }
      },
      {discrete: true},
    );

    // Branch (2) of listReplace: paragraph after the list is appended as the
    // trailing item and the list start stays at 2. The typed "9." is
    // overwritten by updateChildrenListItemValue.
    expect(editor.read(() => $generateHtmlFromNodes(editor))).toBe(
      '<ol start="2"><li value="2"><span style="white-space: pre-wrap;">A</span></li><li value="3"></li></ol>',
    );
  });

  it('creates a fresh ordered list when the next sibling is a different list type', () => {
    const editor = createTestEditor({nodes: baseNodes});
    registerMarkdownShortcuts(editor, TRANSFORMERS);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const bullets = $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('A')),
        );
        root.append(paragraph, bullets);
        paragraph.selectEnd().insertText('5.');
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(' ');
        }
      },
      {discrete: true},
    );

    // Adjacent list is a different type, so listReplace falls through to the
    // branch that creates a fresh ordered list with the typed start. The
    // existing bullet list stays intact.
    expect(editor.read(() => $generateHtmlFromNodes(editor))).toBe(
      '<ol start="5"><li value="5"></li></ol><ul><li value="1"><span style="white-space: pre-wrap;">A</span></li></ul>',
    );
  });
});

describe('$generateNodesFromMarkdownString', () => {
  it('returns nodes without modifying the root', () => {
    const editor = createTestEditor();

    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('existing')));
      },
      {discrete: true},
    );

    let nodes: LexicalNode[] = [];
    editor.update(
      () => {
        nodes = $generateNodesFromMarkdownString(
          '# Heading\n\nParagraph',
          TRANSFORMERS,
        );
      },
      {discrete: true},
    );

    expect(nodes).toHaveLength(2);
    expect(nodes[0].getType()).toBe('heading');
    expect(nodes[1].getType()).toBe('paragraph');

    expect(editor.read(() => $getRoot().getTextContent())).toBe('existing');
  });

  it('produces the same nodes as $convertFromMarkdownString', () => {
    const md = '# Title\n\n- item 1\n- item 2\n\n> quote\n\n```\ncode\n```';

    const convertEditor = createTestEditor();
    convertEditor.update(() => $convertFromMarkdownString(md, TRANSFORMERS), {
      discrete: true,
    });
    const convertHtml = convertEditor.read(() =>
      $generateHtmlFromNodes(convertEditor),
    );

    const generateEditor = createTestEditor();
    generateEditor.update(
      () => {
        const nodes = $generateNodesFromMarkdownString(md, TRANSFORMERS);
        $getRoot()
          .clear()
          .append(...nodes);
      },
      {discrete: true},
    );
    const generateHtml = generateEditor.read(() =>
      $generateHtmlFromNodes(generateEditor),
    );

    expect(generateHtml).toBe(convertHtml);
  });

  it('returned nodes can be inserted at selection', () => {
    const editor = createTestEditor();

    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('before')),
            $createParagraphNode().append($createTextNode('after')),
          );
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const root = $getRoot();
        root.select(1, 1);
        const nodes = $generateNodesFromMarkdownString(
          '**bold**',
          TRANSFORMERS,
        );
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertNodes(nodes);
        }
      },
      {discrete: true},
    );

    const html = editor.read(() => $generateHtmlFromNodes(editor));
    expect(html).toContain('before');
    expect(html).toContain('<strong');
    expect(html).toContain('after');
  });

  it('handles adjacent line merging (commonmark)', () => {
    const editor = createTestEditor();

    let nodes: LexicalNode[] = [];
    editor.update(
      () => {
        nodes = $generateNodesFromMarkdownString(
          'line 1\nline 2',
          TRANSFORMERS,
          false,
          true,
        );
      },
      {discrete: true},
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0].getType()).toBe('paragraph');
  });
});

describe('$convertSelectionToMarkdownString whitespace slices', () => {
  it('does not emit a dangling closing tag when the selection slices a format down to whitespace', () => {
    const editor = createTestEditor({nodes: [LinkNode]});
    editor.update(
      () => {
        const root = $getRoot();
        const first = $createTextNode('a  ');
        first.toggleFormat('bold');
        first.setStyle('color: red');
        const second = $createTextNode('b');
        second.toggleFormat('bold');
        root.append($createParagraphNode().append(first, second));
        $setSelectionFromCaretRange(
          $getCaretRange(
            $getTextPointCaret(first, 'next', 1),
            $getTextPointCaret(second, 'next', 1),
          ),
        );
      },
      {discrete: true},
    );
    const result = editor.read('latest', () =>
      $convertSelectionToMarkdownString(TRANSFORMERS, $getSelection()),
    );
    expect(result).toBe('  **b**');
  });
});

type ImportedLink = {title: null | string; url: string};

function importLinks(md: string): ImportedLink[] {
  const editor = createTestEditor({nodes: [LinkNode]});
  editor.update(() => $convertFromMarkdownString(md, TRANSFORMERS), {
    discrete: true,
  });
  return editor.read('latest', () =>
    $getRoot()
      .getAllTextNodes()
      .map(node => node.getParent())
      .filter($isLinkNode)
      .map(node => ({title: node.getTitle(), url: node.getURL()})),
  );
}

describe('link destination ends at whitespace', () => {
  // A backslash escapes punctuation only, so one in front of a space is a
  // literal backslash and the space closes the raw destination.
  // https://spec.commonmark.org/0.31.2/#link-destination
  const CASES: [md: string, links: ImportedLink[]][] = [
    ['[x](b\\ "t")', [{title: 't', url: 'b\\'}]],
    ['[x](foo\\ bar)', []],
    ['[x](foo\\ bar "t")', []],
    ['[x](a\\ b)', []],
    ['[x](a\\ b "t")', []],
  ];

  for (const [md, links] of CASES) {
    it(`reads ${JSON.stringify(md)}`, () => {
      expect(importLinks(md)).toEqual(links);
    });
  }
});

describe('a raw link destination cannot begin with an angle bracket', () => {
  // Otherwise a pointy destination that never closes falls through to the raw
  // form and the brackets end up inside the URL. Every expectation here is
  // what mdast-util-from-markdown returns for the same string.
  const CASES: [md: string, links: ImportedLink[]][] = [
    ['[x](<a<b>)', []],
    ['[x](<>x)', []],
    ['[x](<a>b)', []],
    ['[x](<foo)', []],
    ['[x](<\\>)', []],
    // anywhere but in first place an angle bracket is an ordinary character
    ['[x](a<b>c)', [{title: null, url: 'a<b>c'}]],
    ['[x](a<b)', [{title: null, url: 'a<b'}]],
    ['[x](a>b)', [{title: null, url: 'a>b'}]],
  ];

  for (const [md, links] of CASES) {
    it(`reads ${JSON.stringify(md)}`, () => {
      expect(importLinks(md)).toEqual(links);
    });
  }
});

describe('link destination and title shapes', () => {
  // Every expectation here is what mdast-util-from-markdown returns for the
  // same string. https://spec.commonmark.org/0.31.2/#inline-link
  const CASES: [md: string, links: ImportedLink[]][] = [
    // a title takes any of the three spellings, after whitespace
    ['[x](/uri "t")', [{title: 't', url: '/uri'}]],
    ["[x](/uri 't')", [{title: 't', url: '/uri'}]],
    ['[x](/uri (t))', [{title: 't', url: '/uri'}]],
    ['[x](/uri  "t")', [{title: 't', url: '/uri'}]],
    ['[x](/uri\t"t")', [{title: 't', url: '/uri'}]],
    // without the whitespace it is all destination
    ['[x](/uri"t")', [{title: null, url: '/uri"t"'}]],
    ['[x]( "t")', [{title: null, url: '"t"'}]],
    // a parenthesized title may not hold an unescaped parenthesis
    ['[x](/uri (a(b)c))', []],
    // whitespace may sit on either side of the destination
    ['[x]( /uri)', [{title: null, url: '/uri'}]],
    ['[x](/uri )', [{title: null, url: '/uri'}]],
    ['[x]( /uri "t" )', [{title: 't', url: '/uri'}]],
    // the destination itself is optional
    ['[x]()', [{title: null, url: ''}]],
    ['[x]( )', [{title: null, url: ''}]],
    // parentheses nest, up to the depth the pattern is written for
    ['[x](foo(and(bar)))', [{title: null, url: 'foo(and(bar))'}]],
    ['[x](a(b(c)d)e)', [{title: null, url: 'a(b(c)d)e'}]],
    ['[x](((a)))', [{title: null, url: '((a))'}]],
  ];

  for (const [md, links] of CASES) {
    it(`reads ${JSON.stringify(md)}`, () => {
      expect(importLinks(md)).toEqual(links);
    });
  }
});

describe('link destination whitespace does not backtrack', () => {
  // Whitespace may sit on either side of the destination, and when the
  // destination is absent the two runs neighbour each other. A pattern that
  // leaves them that way can split a run between them in as many ways as the
  // run is long, and walks every one of them before giving up on a run that
  // never reaches the closing parenthesis, so the work grows with the square
  // of the input. Reading these takes milliseconds and grew into seconds
  // before, so the time limit is the assertion.
  // https://spec.commonmark.org/0.31.2/#link-destination
  const RUN = 200000;
  const CASES: [name: string, md: string][] = [
    ['a run that never closes', `[x](${' '.repeat(RUN)}`],
    ['a run in front of a quote', `[x](${' '.repeat(RUN)}"`],
    ['a run of tabs', `[x](${'\t'.repeat(RUN)}`],
    [
      'a run on either side of a destination',
      `[x](${' '.repeat(RUN)}/uri${' '.repeat(RUN)}`,
    ],
  ];

  for (const [name, md] of CASES) {
    it(`reads ${name}`, {timeout: 5000}, () => {
      const editor = createTestEditor({nodes: [LinkNode]});
      editor.update(() => $convertFromMarkdownString(md, TRANSFORMERS), {
        discrete: true,
      });

      // None of them is a link, and the point is that saying so is quick.
      expect(
        editor.read('latest', () =>
          $getRoot()
            .getAllTextNodes()
            .map(node => node.getParent())
            .filter($isLinkNode),
        ),
      ).toEqual([]);
    });
  }
});

describe('link destination round trip', () => {
  // Export has to write a destination that import can read back: escapes in
  // the raw form, and the pointy form for a URL the raw form cannot hold.
  // https://spec.commonmark.org/0.31.2/#link-destination
  const CASES: [url: string, md: string][] = [
    [
      'https://en.wikipedia.org/wiki/Ruby_(programming_language)',
      '[x](https://en.wikipedia.org/wiki/Ruby_\\(programming_language\\))',
    ],
    ['https://example.com/a)b', '[x](https://example.com/a\\)b)'],
    ['https://example.com/a(b', '[x](https://example.com/a\\(b)'],
    [
      'https://example.com/a(b)c(d)e',
      '[x](https://example.com/a\\(b\\)c\\(d\\)e)',
    ],
    ['https://example.com/((a))', '[x](https://example.com/\\(\\(a\\)\\))'],
    ['https://example.com/a\\', '[x](https://example.com/a\\\\)'],
    ['https://example.com/a\\(b', '[x](https://example.com/a\\\\\\(b)'],
    ['https://example.com/a b', '[x](<https://example.com/a b>)'],
    ['https://example.com/a b(c)', '[x](<https://example.com/a b(c)>)'],
    ['https://example.com/a b>c', '[x](<https://example.com/a b\\>c>)'],
    ['https://example.com/a b<c', '[x](<https://example.com/a b\\<c>)'],
    ['https://example.com/a b\\', '[x](<https://example.com/a b\\\\>)'],
    ['https://example.com/a\tb', '[x](<https://example.com/a\tb>)'],
    // No destination may hold a line ending, and writing one raw would end the
    // paragraph in the middle of the link.
    ['https://example.com/a\nb', '[x](<https://example.com/a&#10;b>)'],
    ['https://example.com/a\r\nb', '[x](<https://example.com/a&#13;&#10;b>)'],
    ['https://example.com/a b\nc', '[x](<https://example.com/a b&#10;c>)'],
    // Only a `<` in first place would turn the raw form into the pointy one,
    // so an angle bracket anywhere else goes out unescaped.
    ['https://example.com/a<b>c', '[x](https://example.com/a<b>c)'],
    // A URL that already holds a character reference has to keep it. Written
    // raw it would be read back as the character it names, which is how the
    // line endings above survive at all.
    ['https://example.com/a&#10;b', '[x](https://example.com/a&#38;#10;b)'],
    ['https://example.com/a&#x0A;b', '[x](https://example.com/a&#38;#x0A;b)'],
    ['https://example.com/a&amp;b', '[x](https://example.com/a&#38;amp;b)'],
    ['&#38;', '[x](&#38;#38;)'],
    // An `&` that begins no reference is ordinary, so a query string keeps the
    // separators it was written with.
    ['https://example.com/?a=1&b=2', '[x](https://example.com/?a=1&b=2)'],
    [
      'https://example.com/?a=1&b=2;c=3',
      '[x](https://example.com/?a=1&b=2;c=3)',
    ],
    ['<foo>', '[x](\\<foo>)'],
    ['', '[x](<>)'],
    ['https://lexical.dev', '[x](https://lexical.dev)'],
  ];

  for (const [url, md] of CASES) {
    it(`preserves "${url}"`, () => {
      const editor = createTestEditor({nodes: [LinkNode]});
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createLinkNode(url).append($createTextNode('x')),
              ),
            );
        },
        {discrete: true},
      );

      const exported = editor.read('latest', () =>
        $convertToMarkdownString(TRANSFORMERS),
      );
      expect(exported).toBe(md);

      const reimported = createTestEditor({nodes: [LinkNode]});
      reimported.update(
        () => $convertFromMarkdownString(exported, TRANSFORMERS),
        {discrete: true},
      );

      expect(
        reimported.read('latest', () =>
          $getRoot()
            .getAllTextNodes()
            .map(node => node.getParent())
            .filter($isLinkNode)
            .map(node => node.getURL()),
        ),
      ).toEqual([url]);
    });
  }
});

describe('link title round trip', () => {
  // A title is read back through `unescapeText` too, so a character reference
  // in one survives only if it goes out as a reference of its own.
  // https://spec.commonmark.org/0.31.2/#link-title
  const CASES: [title: string, md: string][] = [
    ['a&#10;b', '[x](/uri "a&#38;#10;b")'],
    ['a&amp;b', '[x](/uri "a&#38;amp;b")'],
    ['a&b', '[x](/uri "a&b")'],
    ['a"b', '[x](/uri "a\\"b")'],
    ['plain', '[x](/uri "plain")'],
  ];

  for (const [title, md] of CASES) {
    it(`preserves "${title}"`, () => {
      const editor = createTestEditor({nodes: [LinkNode]});
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createLinkNode('/uri', {title}).append($createTextNode('x')),
              ),
            );
        },
        {discrete: true},
      );

      const exported = editor.read('latest', () =>
        $convertToMarkdownString(TRANSFORMERS),
      );
      expect(exported).toBe(md);

      const reimported = createTestEditor({nodes: [LinkNode]});
      reimported.update(
        () => $convertFromMarkdownString(exported, TRANSFORMERS),
        {discrete: true},
      );

      expect(
        reimported.read('latest', () =>
          $getRoot()
            .getAllTextNodes()
            .map(node => node.getParent())
            .filter($isLinkNode)
            .map(node => node.getTitle()),
        ),
      ).toEqual([title]);
    });
  }
});
