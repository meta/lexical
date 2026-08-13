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
import {$createLinkNode, LinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
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
  KEY_ENTER_COMMAND,
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
      const editor = createHeadlessEditor({
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
      const editor = createHeadlessEditor({
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
      const editor = createHeadlessEditor({
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
    const editor = createHeadlessEditor({
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
    const editor = createHeadlessEditor({
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
      const editor = createHeadlessEditor({
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

    const editor = createHeadlessEditor({
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

    const editor = createHeadlessEditor({
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
    const editor = createHeadlessEditor({
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
      return createHeadlessEditor({
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
      const editor = createHeadlessEditor({
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
      const editor = createHeadlessEditor({
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
      const editor = createHeadlessEditor({
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
      const editor = createHeadlessEditor({
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
      const editor = createHeadlessEditor({
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
      const editor = createHeadlessEditor({
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

      const editor = createHeadlessEditor({
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

      const editor = createHeadlessEditor({
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
      const editor = createHeadlessEditor({
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
      const editor = createHeadlessEditor({
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
    const editor = createHeadlessEditor({
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
    const editor = createHeadlessEditor({
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
  function createTestEditor() {
    return createHeadlessEditor({
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
  function createTestEditor() {
    return createHeadlessEditor({
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
  function createTestEditor() {
    return createHeadlessEditor({
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
  function createTestEditor() {
    return createHeadlessEditor({
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
    const editor = createHeadlessEditor({nodes: baseNodes});
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
    const editor = createHeadlessEditor({nodes: baseNodes});
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
    const editor = createHeadlessEditor({nodes: baseNodes});
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
    const editor = createHeadlessEditor({nodes: baseNodes});
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
  function createTestEditor() {
    return createHeadlessEditor({
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

    let nodes: ReturnType<typeof $generateNodesFromMarkdownString> = [];
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

    let nodes: ReturnType<typeof $generateNodesFromMarkdownString> = [];
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
    const editor = createHeadlessEditor({nodes: [LinkNode]});
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
