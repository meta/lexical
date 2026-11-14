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
  type Transformer,
  TRANSFORMERS,
} from '@lexical/markdown';
import {
  $createParagraphNode,
  $createTextNode,
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
  transformers: Transformer[] = TRANSFORMERS,
): {blocks: string[]; exported: string} {
  using editor = buildEditorFromExtensions([MarkdownTestExtension]);
  let blocks: string[] = [];
  let exported = '';
  editor.update(
    () => {
      $convertFromMarkdownString(
        markdown,
        transformers,
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

describe('what counts as an open delimiter', () => {
  it.each([
    [
      'a delimiter after a literal one on the line',
      'a * b *c\nd*',
      '<paragraph>a * b *c*|*d*</>',
    ],
    [
      'an underscore after one inside a word',
      'snake_case and _foo\nbar_',
      '<paragraph>snake_case and *foo*|*bar*</>',
    ],
    [
      'bold after a literal pair of stars',
      '2 ** 3 is **big\nnumber**',
      '<paragraph>2 ** 3 is **big**|**number**</>',
    ],
    [
      'a code span after an escaped backtick',
      'a \\` b `c\nd`',
      '<paragraph>a ` b `c`|`d`</>',
    ],
  ])('finds %s', (_name, markdown, expected) => {
    expect(importMarkdown(markdown).blocks).toEqual([expected]);
  });
});

describe('lines that are imported on their own', () => {
  // A transformer reads the text it is given and the paragraph around it,
  // as a block equation does with `$$x$$`.
  const seen: [string, string][] = [];
  const PARENT_READER: TextMatchTransformer = {
    dependencies: [],
    importRegExp: /x2/,
    regExp: /x2$/,
    replace(node) {
      const parent = node.getParentOrThrow();
      seen.push([parent.getType(), parent.getTextContent()]);
    },
    type: 'text-match',
  };
  const BLOCK: TextMatchTransformer = {
    dependencies: [],
    importRegExp: /^\$\$([^$]+?)\$\$$/,
    regExp: /^\$\$([^$]+?)\$\$$/,
    replace(node, match) {
      node
        .getParentOrThrow()
        .replace(
          $createParagraphNode().append($createTextNode('EQ:' + match[1])),
        );
    },
    type: 'text-match',
  };

  it('lets a transformer read the block of its own line', () => {
    seen.length = 0;
    importMarkdown('a\nb x2\n# h x2\n- i x2\n> q x2', false, [
      PARENT_READER,
      ...TRANSFORMERS,
    ]);
    expect(seen).toEqual([
      ['paragraph', 'b x2'],
      ['heading', 'h x2'],
      ['listitem', 'i x2'],
      ['quote', 'q x2'],
    ]);
  });

  it('lets a transformer replace the block of its own line', () => {
    const transformers = [BLOCK, ...TRANSFORMERS];
    expect(importMarkdown('a\n$$x^2$$\nb', false, transformers).blocks).toEqual(
      ['<paragraph>a</>', '<paragraph>EQ:x^2|b</>'],
    );
    expect(importMarkdown('# $$x^2$$', false, transformers).blocks).toEqual([
      '<paragraph>EQ:x^2</>',
    ]);
  });

  it('keeps such a line when an earlier line leaves a delimiter open', () => {
    const transformers = [BLOCK, ...TRANSFORMERS];
    // Neither line is joined with the lines around it, so the equation is
    // imported as it is without any open delimiter.
    expect(
      importMarkdown('a *b\n$$x^2$$\nc*', false, transformers).blocks,
    ).toEqual(['<paragraph>a *b</>', '<paragraph>EQ:x^2|c*</>']);
    expect(importMarkdown('a\n$$a*b$$', false, transformers).blocks).toEqual([
      '<paragraph>a</>',
      '<paragraph>EQ:a*b</>',
    ]);
  });

  it('imports lines one by one when no delimiter gets closed', () => {
    const seenText: string[] = [];
    const RECORD: TextMatchTransformer = {
      dependencies: [],
      importRegExp: /marker/,
      regExp: /marker$/,
      replace(node) {
        seenText.push(node.getTextContent());
      },
      type: 'text-match',
    };
    const lines = Array.from(
      {length: 300},
      (_, i) => `line ${i} with \`code\`, **bold**, 2 * 3 and marker`,
    );
    importMarkdown(lines.join('\n'), false, [RECORD, ...TRANSFORMERS]);
    expect(seenText).toHaveLength(300);
    // Parsing the whole paragraph at once would hand over all of the lines.
    expect(seenText.every(text => !text.includes('\n'))).toBe(true);
  });

  it('does not join the rest of a paragraph after a literal 2 * 3', () => {
    const seenText: string[] = [];
    const RECORD: TextMatchTransformer = {
      dependencies: [],
      importRegExp: /marker/,
      regExp: /marker$/,
      replace(node) {
        seenText.push(node.getTextContent());
      },
      type: 'text-match',
    };
    importMarkdown('2 * 3\nmarker\nmarker', false, [RECORD, ...TRANSFORMERS]);
    expect(seenText).toEqual(['marker', 'marker']);
  });
});

describe('lines that continue a block', () => {
  it('keeps one list when lines wait between its items', () => {
    expect(importMarkdown('- **a\nb\n- c').blocks).toEqual([
      '<list><listitem>**a|b</><listitem>c</></>',
    ]);
  });

  it('keeps one quote when lines wait before one of its lines', () => {
    expect(importMarkdown('> **a\nb\n> c').blocks).toEqual([
      '<quote>**a|b|c</>',
    ]);
  });

  it('joins a lazy line that follows a quote line', () => {
    expect(importMarkdown('> a\n**b\nc**').blocks).toEqual([
      '<quote>a|**b**|**c**</>',
    ]);
  });

  it('stops joining after a number of lines', () => {
    const middle = Array.from({length: 120}, () => 'x');
    const [blocks] = importMarkdown(
      ['**a', ...middle, 'b**'].join('\n'),
    ).blocks;
    expect(blocks).not.toContain('**a**');
    const [short] = importMarkdown(
      ['**a', ...middle.slice(0, 20), 'b**'].join('\n'),
    ).blocks;
    expect(short.startsWith('<paragraph>**a**|**x**')).toBe(true);
  });
});

describe('code spans across a line break', () => {
  it('exports a code span across a line break as two spans', () => {
    expect(importMarkdown('x `a\nb` y').exported).toBe('x `a`\n`b` y');
  });
});

describe('long paragraphs', () => {
  it('imports a paragraph of lines that close their own delimiters', () => {
    const markdown = Array.from(
      {length: 1000},
      (_, i) => `line ${i} with \`code\` and **bold** text`,
    ).join('\n');
    const {blocks} = importMarkdown(markdown);
    expect(blocks).toHaveLength(1);
    expect(
      blocks[0].startsWith('<paragraph>line 0 with `code` and **bold**'),
    ).toBe(true);
  });

  it('still joins lines until the delimiter is closed', () => {
    const {blocks} = importMarkdown(
      ['a `x', 'b', 'c` d', 'e **f**', 'g *h', 'i* j'].join('\n'),
    );
    expect(blocks).toEqual([
      '<paragraph>a `x`|`b`|`c` d|e **f**|g *h*|*i* j</>',
    ]);
  });
});
