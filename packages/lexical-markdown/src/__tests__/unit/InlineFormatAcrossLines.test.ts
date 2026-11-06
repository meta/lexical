/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  type TextMatchTransformer,
  TRANSFORMERS,
} from '@lexical/markdown';
import {
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  type LexicalNode,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {MarkdownTestExtension} from '../utils';

// Describes the inline content of a block as e.g. `**a**|b`, where `|` is a
// LineBreakNode and `**`, `*`, `` ` `` mark bold, italic and code text.
function describeNode(node: LexicalNode): string {
  if ($isLineBreakNode(node)) {
    return '|';
  }
  if ($isTextNode(node)) {
    const text = node.getTextContent();
    if (node.hasFormat('code')) {
      return '`' + text + '`';
    }
    if (node.hasFormat('bold')) {
      return '**' + text + '**';
    }
    if (node.hasFormat('italic')) {
      return '*' + text + '*';
    }
    return text;
  }
  if ($isElementNode(node)) {
    return `<${node.getType()}>${node.getChildren().map(describeNode).join('')}</>`;
  }
  return `[${node.getType()}]`;
}

function importMarkdown(
  markdown: string,
  shouldPreserveNewLines = false,
): {blocks: string[]; exported: string} {
  using editor = buildEditorFromExtensions([MarkdownTestExtension]);
  let blocks: string[] = [];
  let exported = '';
  editor.update(
    () => {
      $convertFromMarkdownString(
        markdown,
        TRANSFORMERS,
        undefined,
        shouldPreserveNewLines,
      );
      blocks = $getRoot().getChildren().map(describeNode);
      exported = $convertToMarkdownString(
        TRANSFORMERS,
        undefined,
        shouldPreserveNewLines,
      );
    },
    {discrete: true},
  );
  return {blocks, exported};
}

describe('inline formats that continue on the next line of a block', () => {
  it.each([
    ['bold', '**a\nb**', '<paragraph>**a**|**b**</>'],
    ['italic', '*foo\nbar*', '<paragraph>*foo*|*bar*</>'],
    ['underscore italic', '_foo\nbar_', '<paragraph>*foo*|*bar*</>'],
    ['code span', 'x `a\nb` y', '<paragraph>x `a`|`b` y</>'],
    ['bold over three lines', '**a\nb\nc**', '<paragraph>**a**|**b**|**c**</>'],
    [
      'text around the span',
      'before **a\nb** after',
      '<paragraph>before **a**|**b** after</>',
    ],
    [
      'two spans on different lines',
      '**a\nb** and *c\nd*',
      '<paragraph>**a**|**b** and *c*|*d*</>',
    ],
  ])('imports %s', (_name, markdown, expected) => {
    expect(importMarkdown(markdown).blocks).toEqual([expected]);
  });

  it('does not escape the delimiters on export', () => {
    for (const markdown of ['**a\nb**', '*foo\nbar*', 'x `a\nb` y']) {
      const {exported} = importMarkdown(markdown);
      expect(exported).not.toContain('\\');
      // Importing the export again gives the same document.
      expect(importMarkdown(exported).blocks).toEqual(
        importMarkdown(markdown).blocks,
      );
    }
  });

  it('keeps the per-line workaround working', () => {
    expect(importMarkdown('**a**\n**b**')).toEqual({
      blocks: ['<paragraph>**a**|**b**</>'],
      exported: '**a**\n**b**',
    });
  });

  it('keeps hard line breaks inside formatted text', () => {
    const {blocks, exported} = importMarkdown('**a  \nb**\n*c\\\nd*');
    expect(blocks).toEqual(['<paragraph>**a**|**b**|*c*|*d*</>']);
    expect(exported).toBe('**a**  \n**b**\n*c*\\\n*d*');
  });

  it('works for lazy continuation lines in quotes and list items', () => {
    expect(importMarkdown('> **a\n> b**').blocks).toEqual([
      '<quote>**a**|**b**</>',
    ]);
    expect(importMarkdown('- **a\nb**').blocks).toEqual([
      '<list><listitem>**a**|**b**</></>',
    ]);
  });

  it('does not pair delimiters across a blank line', () => {
    expect(importMarkdown('**a\n\nb**').blocks).toEqual([
      '<paragraph>**a</>',
      '<paragraph>b**</>',
    ]);
  });

  it('does not pair delimiters across separate blocks', () => {
    expect(importMarkdown('# **a\nb**').blocks).toEqual([
      '<heading>**a</>',
      '<paragraph>b**</>',
    ]);
    expect(importMarkdown('**a\n- b**').blocks).toEqual([
      '<paragraph>**a</>',
      '<list><listitem>b**</></>',
    ]);
  });

  it('leaves an unmatched delimiter literal', () => {
    expect(importMarkdown('**a\nb').blocks).toEqual(['<paragraph>**a|b</>']);
    expect(importMarkdown('a * b\nc * d').blocks).toEqual([
      '<paragraph>a * b|c * d</>',
    ]);
  });

  it('does not format across lines when newlines are preserved', () => {
    expect(importMarkdown('**a\nb**', true).blocks).toEqual([
      '<paragraph>**a</>',
      '<paragraph>b**</>',
    ]);
  });

  it('still unescapes text on every line', () => {
    expect(importMarkdown('\\*a\nb\\*').blocks).toEqual([
      '<paragraph>*a|b*</>',
    ]);
  });
});

describe('hard line break markers', () => {
  it('stays on its own line after a link title that spans lines', () => {
    const {exported} = importMarkdown('x [a](http://u "t\nv") y  \nz');
    expect(exported).toContain('y  \nz');
  });

  it('stays on its own line after a character reference for a newline', () => {
    // The character reference makes the joined text hold a newline that is not
    // a line ending, so these lines are parsed one by one instead.
    const {exported} = importMarkdown('a &#10; **b\nc**  \nd');
    expect(exported).toContain('  \nd');
  });

  it('stays on its own line when later lines also continue a span', () => {
    const {blocks, exported} = importMarkdown('**a  \nb**  \nc\\\n*d\ne*');
    expect(blocks).toEqual(['<paragraph>**a**|**b**|c|*d*|*e*</>']);
    expect(exported).toBe('**a**  \n**b**  \nc\\\n*d*\n*e*');
  });
});

describe('text match transformers across lines', () => {
  const UNMERGEABLE: TextMatchTransformer = {
    dependencies: [],
    importRegExp: /\[\[[^\]]*\]\]/,
    regExp: /\[\[[^\]]*\]\]/,
    replace(node) {
      node.toggleUnmergeable();
    },
    type: 'text-match',
  };

  it('keeps the detail of a node that is split at a line ending', () => {
    using editor = buildEditorFromExtensions([MarkdownTestExtension]);
    let details: [string, boolean][] = [];
    editor.update(
      () => {
        $convertFromMarkdownString('x [[a\nb]] y', [
          UNMERGEABLE,
          ...TRANSFORMERS,
        ]);
        details = $getRoot()
          .getAllTextNodes()
          .map(node => [node.getTextContent(), node.isUnmergeable()]);
      },
      {discrete: true},
    );
    expect(details).toEqual([
      ['x ', false],
      ['[[a', true],
      ['b]]', true],
      [' y', false],
    ]);
  });
});

describe('long paragraphs', () => {
  it('parses lines that close their own delimiters one by one', () => {
    const lines = 1000;
    const markdown = Array.from(
      {length: lines},
      (_, i) => `line ${i} with \`code\` and **bold** text`,
    ).join('\n');
    const start = performance.now();
    const {blocks} = importMarkdown(markdown);
    const elapsed = performance.now() - start;
    expect(blocks).toHaveLength(1);
    // Joining all of the lines would take many times longer than this.
    expect(elapsed).toBeLessThan(15000);
  }, 30000);

  it('still joins lines until the delimiter is closed', () => {
    const {blocks} = importMarkdown(
      ['a `x', 'b', 'c` d', 'e **f**', 'g *h', 'i* j'].join('\n'),
    );
    expect(blocks).toEqual([
      '<paragraph>a `x`|`b`|`c` d|e **f**|g *h*|*i* j</>',
    ]);
  });
});
