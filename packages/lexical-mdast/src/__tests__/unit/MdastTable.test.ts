/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {
  AlignType,
  PhrasingContent,
  Table,
  TableCell,
  TableRow,
} from 'mdast';

import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  type AnyLexicalExtensionArgument,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  HorizontalRuleNode,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {$createLinkNode, $isLinkNode, LinkNode} from '@lexical/link';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteNode,
  QuoteNode,
} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $createTableSelectionFrom,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  type TableCellNode,
  type TableNode,
} from '@lexical/table';
import {
  $createLineBreakNode,
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  $setSelection,
  configExtension,
  defineExtension,
  TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {fromMarkdown} from 'mdast-util-from-markdown';
import {defaultHandlers} from 'mdast-util-to-markdown';
import {assert, describe, expect, it} from 'vitest';

import {
  $convertFromMarkdownString,
  $convertFromMdast,
  $convertSelectionToMarkdownString,
  $convertToMarkdownString,
  $convertToMdast,
  MdastAutolinkLiteralExtension,
  MdastCommonMarkExtension,
  MdastExtension,
  MdastTableExtension,
} from '../../index';

function createEditor(
  ...extensions: AnyLexicalExtensionArgument[]
): LexicalEditorWithDispose {
  // The caller is responsible for disposal (with `using`).
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        MdastCommonMarkExtension,
        MdastExtension,
        MdastTableExtension,
        ...extensions,
      ],
      name: '[root]',
      theme: {tableScrollableWrapper: 'table-wrapper'},
    }),
  );
}

function $table(): TableNode {
  return $assertNodeType($getRoot().getFirstChild(), $isTableNode);
}

function $cells(table = $table()): TableCellNode[][] {
  return table
    .getChildren()
    .filter($isTableRowNode)
    .map(row => row.getChildren().filter($isTableCellNode));
}

/** Imports `markdown`, applies `$edit`, and exports the document. */
function convert(markdown: string, $edit?: () => void): string {
  using editor = createEditor();
  editor.update(() => $convertFromMarkdownString(markdown), {discrete: true});
  if ($edit) {
    editor.update($edit, {discrete: true});
  }
  return editor.read(() => $convertToMarkdownString());
}

const table = (...rows: string[]) => rows.join('\n');

describe('MdastTableExtension', () => {
  it('round-trips a GFM table', () => {
    const markdown = table(
      '| a | b   |',
      '| - | --- |',
      '| 1 | 2   |',
      '| 3 | *4* |',
    );
    expect(convert(markdown)).toBe(markdown);
  });

  it('gives each row the header row’s cells', () => {
    expect(
      convert(table('| a | b |', '| - | - |', '| 1 | 2 | 3 |', '| x |')),
    ).toBe(table('| a | b |', '| - | - |', '| 1 | 2 |', '| x |   |'));
  });

  it('reads alignment into the paragraphs of each column and writes it back', () => {
    using editor = createEditor();
    const markdown = table(
      '| a | b |  c | d |',
      '| :- | :-: | -: | - |',
      '| 1 | 2 | 3 | 4 |',
    );
    editor.update(() => $convertFromMarkdownString(markdown), {
      discrete: true,
    });
    editor.read(() => {
      for (const row of $cells()) {
        expect(
          row.map(cell =>
            $assertNodeType(
              cell.getFirstChild(),
              $isElementNode,
            ).getFormatType(),
          ),
        ).toEqual(['left', 'center', 'right', '']);
      }
      expect($convertToMarkdownString()).toBe(
        table(
          '| a  |  b  |  c | d |',
          '| :- | :-: | -: | - |',
          '| 1  |  2  |  3 | 4 |',
        ),
      );
    });
  });

  it('reads <br> in a cell as a line break and writes it back', () => {
    using editor = createEditor();
    editor.update(
      () =>
        $convertFromMarkdownString(
          table(
            '| a |',
            '| - |',
            '| x<br>y **p<BR/>q** <br title="x>y">z</br>w |',
          ),
        ),
      {discrete: true},
    );
    editor.read(() => {
      const paragraph = $assertNodeType(
        $cells()[1][0].getFirstChild(),
        $isParagraphNode,
      );
      expect(
        paragraph
          .getChildren()
          .map(child =>
            $isLineBreakNode(child) ? '\n' : child.getTextContent(),
          )
          .join(''),
      ).toBe('x\ny p\nq \nz\nw');
      expect($convertToMarkdownString()).toBe(
        table(
          '| a                                |',
          '| -------------------------------- |',
          '| x<br>y **p**<br>**q** <br>z<br>w |',
        ),
      );
    });
  });

  it('reads and writes the pipes in a cell as GFM does', () => {
    using editor = createEditor();
    editor.update(
      () =>
        $convertFromMarkdownString(
          table(
            '| a |',
            '| - |',
            '| a\\|b `c\\|d` <span title="e\\|f"> <http://g\\|h> [i](j\\|k) |',
          ),
        ),
      {discrete: true},
    );
    editor.read(() => {
      expect($cells()[1][0].getTextContent()).toBe(
        'a|b c|d <span title="e|f"> http://g|h i',
      );
      // Raw HTML imports as text without MdastHtmlExtension.
      expect($convertToMarkdownString()).toBe(
        table(
          '| a                                                        |',
          '| -------------------------------------------------------- |',
          '| a\\|b `c\\|d` \\<span title="e\\|f"> <http://g\\|h> [i](j\\|k) |',
        ),
      );
    });
  });

  it('writes the blocks of a cell as lines', () => {
    expect(
      convert(table('| a |', '| - |', '| x |'), () => {
        $cells()[1][0].append(
          $createHeadingNode('h2').append($createTextNode('h')),
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('i1')),
            $createListItemNode().append(
              $createLinkNode('https://lexical.dev').append(
                $createTextNode('i2'),
              ),
            ),
          ),
          $createParagraphNode(),
          $createParagraphNode().append($createTextNode('z')),
        );
      }),
    ).toBe(
      table(
        '| a                                                  |',
        '| -------------------------------------------------- |',
        '| x<br>h<br>i1<br>[i2](https://lexical.dev)<br><br>z |',
      ),
    );
  });

  it('reads a row span of 0 as the rest of the rows', () => {
    expect(
      convert(table('| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |'), () => {
        const [, [one], [three]] = $cells();
        three.remove();
        one.setRowSpan(0);
      }),
    ).toBe(table('| a | b |', '| - | - |', '| 1 | 2 |', '|   | 4 |'));
  });

  it('writes the block decorators of a cell after the table', () => {
    expect(
      convert(table('| a |', '| - |', '| x |'), () => {
        $cells()[1][0].append($createHorizontalRuleNode());
      }),
    ).toBe(table('| a |', '| - |', '| x |', '', '***'));
  });

  it('writes the alignment of the header cell, not of the cells below it', () => {
    expect(
      convert(table('| a | b |', '| - | -: |', '| 1 | 2 |'), () => {
        const [[, b], [one, two]] = $cells();
        $assertNodeType(one.getFirstChild(), $isElementNode).setFormat(
          'center',
        );
        $assertNodeType(b.getFirstChild(), $isElementNode).setFormat('');
        $assertNodeType(two.getFirstChild(), $isElementNode).setFormat('right');
      }),
    ).toBe(table('| a | b |', '| - | - |', '| 1 | 2 |'));
  });

  it('writes the alignment of the text in a cell as its column’s', () => {
    expect(
      convert(table('| a | b |', '| - | - |', '| 1 | 2 |'), () => {
        $assertNodeType(
          $cells()[0][1].getFirstChild(),
          $isElementNode,
        ).setFormat('center');
      }),
    ).toBe(table('| a |  b  |', '| - | :-: |', '| 1 |  2  |'));
  });

  it('skips a row where a selection reaches only a block decorator', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          table('| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |'),
        );
        const [, [one], [three, four]] = $cells();
        three.remove();
        one.setRowSpan(2);
        four.getFirstChildOrThrow().insertBefore($createHorizontalRuleNode());
        const selection = one.getAllTextNodes()[0].select(0, 0);
        selection.focus.set(four.getKey(), 1, 'element');
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe(
        [table('| 1 | 2 |', '| - | - |'), '***'].join('\n\n'),
      );
    });
  });

  it('writes a column unaligned when the text in its header is', () => {
    expect(
      convert(table('| a | b |', '| :-: | - |', '| 1 | 2 |'), () =>
        $assertNodeType(
          $cells()[0][0].getFirstChild(),
          $isElementNode,
        ).setFormat('justify'),
      ),
    ).toBe(table('| a | b |', '| - | - |', '| 1 | 2 |'));
  });

  it('writes a column unaligned when the text in its cell is', () => {
    expect(
      convert(table('| a | b |', '| :-: | - |', '| 1 | 2 |'), () => {
        $assertNodeType(
          $cells()[0][0].getFirstChild(),
          $isElementNode,
        ).setFormat('justify');
        $assertNodeType(
          $cells()[1][0].getFirstChild(),
          $isElementNode,
        ).setFormat('justify');
      }),
    ).toBe(table('| a | b |', '| - | - |', '| 1 | 2 |'));
  });

  it('writes the alignment of the text in a cell over the cell’s', () => {
    expect(
      convert(table('| a |', '| :-: |', '| 1 |'), () => {
        $assertNodeType(
          $cells()[0][0].getFirstChild(),
          $isElementNode,
        ).setFormat('right');
      }),
    ).toBe(table('|  a |', '| -: |', '|  1 |'));
  });

  it('writes a row a merged cell spans with an empty cell', () => {
    expect(
      convert(table('| a |', '| - |', '| 1 |', '| 2 |'), () => {
        const [, [one], [two]] = $cells();
        two.remove();
        one.setRowSpan(2);
      }),
    ).toBe(table('| a |', '| - |', '| 1 |', '|   |'));
  });

  it('writes a merged cell with empty cells where it spans, aligned as it is', () => {
    expect(
      convert(table('| a | b | c |', '| :- | - | - |', '| 1 | 2 | 3 |'), () => {
        const [[a, b], [one, two]] = $cells();
        b.remove();
        a.setColSpan(2);
        two.remove();
        one.setColSpan(2);
      }),
    ).toBe(table('| a  |    | c |', '| :- | :- | - |', '| 1  |    | 3 |'));
  });

  it('writes a line ending in a cell’s text as a space, unescaped', () => {
    const markdown = table('| a         |', '| --------- |', '| a # b   c |');
    expect(
      convert(table('| a |', '| - |', '| x |'), () => {
        $cells()[1][0].getAllTextNodes()[0].setTextContent('a\n# b \n c');
      }),
    ).toBe(markdown);
    expect(convert(markdown)).toBe(markdown);
  });

  it('reads alignment from the first line with text in a header cell', () => {
    expect(
      convert(table('| a |', '| - |', '| x |'), () => {
        const [[cell]] = $cells();
        cell
          .clear()
          .append(
            $createParagraphNode(),
            $createParagraphNode().append($createLineBreakNode()),
            $createParagraphNode().append($createTextNode(' ')),
            $createParagraphNode()
              .setFormat('center')
              .append($createTextNode('H')),
          );
      }),
    ).toBe(
      table(
        '| <br><br><br> <br>H |',
        '| :----------------: |',
        '|          x         |',
      ),
    );
  });

  it('skips what isn’t a row or cell', () => {
    expect(
      convert(table('| a |', '| - |', '| 1 |'), () => {
        $table().append($createParagraphNode());
        $assertNodeType(
          $table().getFirstChildOrThrow(),
          $isTableRowNode,
        ).append($createTextNode('x'));
      }),
    ).toBe(table('| a |', '| - |', '| 1 |'));
  });

  it('reads and writes escaped pipes in autolink literals', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastCommonMarkExtension,
          MdastAutolinkLiteralExtension,
          MdastTableExtension,
        ],
        name: '[root]',
      }),
    );
    editor.update(
      () =>
        $convertFromMarkdownString(
          table('| a |', '| - |', '| http://a.dev/b\\|c |'),
        ),
      {discrete: true},
    );
    editor.read(() => {
      const link = $assertNodeType(
        $assertNodeType(
          $cells()[1][0].getFirstChildOrThrow(),
          $isElementNode,
        ).getFirstChild(),
        $isLinkNode,
      );
      expect(link.getURL()).toBe('http://a.dev/b|c');
      expect(link.getTextContent()).toBe('http://a.dev/b|c');
      expect($convertToMarkdownString()).toBe(
        table(
          '| a                 |',
          '| ----------------- |',
          '| http://a.dev/b\\|c |',
        ),
      );
    });
  });

  it('escapes the pipes in raw HTML in a cell after any backslashes', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastCommonMarkExtension,
          MdastTableExtension,
          // Raw HTML imports as text without MdastHtmlExtension; this writes
          // it back as raw HTML.
          configExtension(MdastExtension, {
            exportRules: [
              {
                $export: node =>
                  $isTextNode(node) && node.getTextContent().startsWith('<')
                    ? {type: 'html', value: node.getTextContent()}
                    : null,
                type: TextNode,
              },
            ],
          }),
        ],
        name: '[root]',
      }),
    );
    const markdown = table(
      '| a                                     |',
      '| ------------------------------------- |',
      '| <span title="\\|"> <span title="\\\\\\|"> |',
    );
    editor.update(() => $convertFromMarkdownString(markdown), {
      discrete: true,
    });
    editor.read(() => {
      const html = '<span title="|"> <span title="\\\\|">';
      expect($cells()[1][0].getTextContent()).toBe(html);
      // The escapes are written with the cell, not kept in its mdast.
      const [tableNode] = $convertToMdast().children;
      assert(tableNode.type === 'table');
      expect(tableNode.children[1].children[0].children).toEqual([
        {type: 'html', value: html},
      ]);
      expect($convertToMarkdownString()).toBe(markdown);
    });
    // The mdast holds them unescaped, which reads back as it is, as does
    // a tree parsed with the editor's grammar.
    const {registry} = getExtensionDependencyFromEditor(
      editor,
      MdastExtension,
    ).output;
    for (const mdast of [
      editor.read(() => $convertToMdast()),
      fromMarkdown(markdown, {
        extensions: registry.micromarkExtensions,
        mdastExtensions: registry.mdastExtensions,
      }),
    ]) {
      editor.update(() => $convertFromMdast(mdast), {discrete: true});
      editor.read(() => {
        expect($convertToMarkdownString()).toBe(markdown);
      });
    }
    // A pipe after an odd run of backslashes, which a cell can't hold, isn't
    // where GFM ends the cell, so it's written as it is.
    editor.update(
      () => {
        $cells()[1][0].getAllTextNodes()[0].setTextContent('<i title="\\|">');
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertToMarkdownString()).toBe(
        table(
          '| a              |',
          '| -------------- |',
          '| <i title="\\|"> |',
        ),
      );
    });
  });

  it('keeps the spaces at the edges of a cell', () => {
    const markdown = table(
      '| a                  |',
      '| ------------------ |',
      '| &#x20; x<br> &#x9; |',
    );
    using editor = createEditor();
    editor.update(() => $convertFromMarkdownString(markdown), {
      discrete: true,
    });
    editor.read(() => {
      expect($cells()[1][0].getTextContent()).toBe('  x\n \t');
      expect($convertToMarkdownString()).toBe(markdown);
    });
    // A backslash before the space stays a backslash.
    editor.update(
      () => {
        $cells()[1][0]
          .clear()
          .append($createParagraphNode().append($createTextNode('x\\ ')));
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertToMarkdownString()).toBe(
        table('| a         |', '| --------- |', '| x\\\\&#x20; |'),
      );
    });
  });

  it('writes the empty lines at the edges of a cell', () => {
    expect(
      convert(table('| a |', '| - |', '| x |'), () => {
        const [cell] = $cells()[1];
        cell.getFirstChildOrThrow().insertBefore($createParagraphNode());
        cell.append($createParagraphNode());
      }),
    ).toBe(table('| a         |', '| --------- |', '| <br>x<br> |'));
  });

  it('writes the lines of a cell a selection reaches', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(table('| a |', '| - |', '| x |'));
        const [cell] = $cells()[1];
        const y = $createTextNode('y');
        cell.append(
          $createParagraphNode(),
          $createParagraphNode().append(y),
          $createParagraphNode(),
        );
        y.select(0, 1);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe('y');
    });
  });

  it('writes the blocks a selection in a cell reaches as paragraphs', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(table('| a |', '| - |', '| x |'));
        const [cell] = $cells()[1];
        const y = $createTextNode('y');
        cell.append($createParagraphNode().append(y));
        const selection = cell.getAllTextNodes()[0].select(0, 0);
        selection.focus.set(y.getKey(), 1, 'text');
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe('x\n\ny');
    });
  });

  it('exports a table from an editor state read without an editor', () => {
    using editor = createEditor();
    const markdown = table('| a |', '| - |', '| 1 |');
    editor.update(() => $convertFromMarkdownString(markdown), {discrete: true});
    const {output} = getExtensionDependencyFromEditor(editor, MdastExtension);
    expect(
      editor.getEditorState().read(() => output.$convertToMarkdownString()),
    ).toBe(markdown);
  });

  it('writes whole tables in a document export during a selection export', () => {
    let whole: string[] = [];
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          MdastCommonMarkExtension,
          configExtension(MdastExtension, {
            toMarkdownExtensions: [
              {
                handlers: {
                  root(node, parent, state, info) {
                    whole = $convertToMdast().children.map(({type}) => type);
                    return defaultHandlers.root(node, parent, state, info);
                  },
                },
              },
            ],
          }),
          MdastTableExtension,
        ],
        name: '[root]',
      }),
    );
    editor.update(
      () => {
        $convertFromMarkdownString(table('| x |', '| - |'));
        $cells()[0][0].getAllTextNodes()[0].select(0, 1);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe('x');
    });
    expect(whole).toEqual(['table']);
  });

  it('writes a table selection of one cell as a table', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          table('| a | b |', '| - | -: |', '| 1 | 2 |'),
        );
        const [, [, two]] = $cells();
        $setSelection($createTableSelectionFrom($table(), two, two));
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe(
        table('|  2 |', '| -: |'),
      );
    });
  });

  it('writes a one-cell table a selection holds whole', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(table('| x |', '| - |'));
        $getRoot().select(0, 1);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe(table('| x |', '| - |'));
    });
  });

  it('writes the nodes a selection in a cell reaches in order', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(table('| a |', '| - |', '| x |'));
        const [cell] = $cells()[1];
        const y = $createTextNode('y');
        cell.append(
          $createHorizontalRuleNode(),
          $createParagraphNode().append(y),
        );
        const selection = cell.getAllTextNodes()[0].select(0, 0);
        selection.focus.set(y.getKey(), 1, 'text');
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe('x\n\n***\n\ny');
    });
    editor.update(
      () => {
        const selection = $createNodeSelection();
        selection.add(
          $assertNodeType(
            $cells()[1][0].getChildAtIndex(1),
            $isHorizontalRuleNode,
          ).getKey(),
        );
        $setSelection(selection);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe('***');
    });
  });

  it('writes a nested table a selection stays in', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(table('| a |', '| - |', '| x |'));
        const [cell] = $cells()[1];
        const inner = $createTextNode('inner');
        cell.append(
          $createTableNode().append(
            $createTableRowNode().append(
              $createTableCellNode().append(
                $createParagraphNode().append(inner),
              ),
            ),
          ),
        );
        inner.select(0, 5);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe('inner');
    });
  });

  it('writes a nested table’s cells as lines, without its filler cells', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(table('| a |', '| - |', '| x |'));
        const [cell] = $cells()[1];
        const textCell = (text: string) =>
          $createTableCellNode().append(
            $createParagraphNode().append($createTextNode(text)),
          );
        cell
          .clear()
          .append(
            $createTableNode().append(
              $createTableRowNode().append(textCell('A').setColSpan(2)),
              $createTableRowNode().append(textCell('B'), textCell('C')),
              $createTableRowNode().append(
                textCell('D'),
                $createTableCellNode().append(
                  $createParagraphNode(),
                  $createParagraphNode(),
                ),
              ),
            ),
          );
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertToMarkdownString()).toBe(
        table(
          '| a                |',
          '| ---------------- |',
          '| A<br>B<br>C<br>D |',
        ),
      );
    });
  });

  it('writes a table selection of a nested table as that table', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(table('| a |', '| - |', '| x |'));
        const [cell] = $cells()[1];
        const p = $createTableCellNode().append(
          $createParagraphNode().append($createTextNode('p')),
        );
        const q = $createTableCellNode().append(
          $createParagraphNode().append($createTextNode('q')),
        );
        const inner = $createTableNode().append(
          $createTableRowNode().append(p, q),
        );
        cell.append(inner);
        $setSelection($createTableSelectionFrom(inner, p, q));
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe(
        table('| p | q |', '| - | - |'),
      );
    });
  });

  it('imports a table with no rows as nothing', () => {
    using editor = createEditor();
    editor.update(
      () =>
        $convertFromMdast({
          children: [{children: [], type: 'table'}],
          type: 'root',
        }),
      {discrete: true},
    );
    editor.read(() => {
      expect($getRoot().getChildren().some($isTableNode)).toBe(false);
    });
  });

  it('keeps a supplied html node with more than a break tag in it whole', () => {
    using editor = createEditor();
    editor.update(
      () =>
        $convertFromMdast({
          children: [
            {
              children: [
                {
                  children: [
                    {
                      children: [
                        {type: 'text', value: 'a'},
                        {type: 'html', value: '<br><b>content</b>'},
                        // A no-break space is not whitespace in HTML.
                        {type: 'html', value: '<br>\u00a0'},
                      ],
                      type: 'tableCell',
                    },
                  ],
                  type: 'tableRow',
                },
              ],
              type: 'table',
            },
          ],
          type: 'root',
        }),
      {discrete: true},
    );
    editor.read(() => {
      const [tableNode] = $convertToMdast().children;
      assert(tableNode.type === 'table');
      expect(tableNode.children[0].children[0].children).toMatchObject([
        // A raw html node imports as its text.
        {type: 'text', value: 'a<br><b>content</b><br>\u00a0'},
      ]);
    });
  });

  it('reads a break tag, raw HTML and a nested table in a supplied cell', () => {
    using editor = createEditor();
    editor.update(
      () =>
        $convertFromMdast({
          children: [
            {
              children: [
                {
                  children: [
                    {
                      children: [
                        {type: 'text', value: 'a'},
                        {type: 'html', value: ' <br>\n'},
                        {
                          children: [
                            {
                              children: [
                                {
                                  children: [
                                    {type: 'html', value: '<i title="\\|">'},
                                  ],
                                  type: 'tableCell',
                                },
                              ],
                              type: 'tableRow',
                            },
                          ],
                          type: 'table',
                        } as unknown as PhrasingContent,
                      ],
                      type: 'tableCell',
                    },
                  ],
                  type: 'tableRow',
                },
              ],
              type: 'table',
            },
          ],
          type: 'root',
        }),
      {discrete: true},
    );
    editor.read(() => {
      const [text, br, nested] = $assertNodeType(
        $cells()[0][0].getFirstChild(),
        $isParagraphNode,
      ).getChildren();
      expect(text.getTextContent()).toBe('a');
      expect($isLineBreakNode(br)).toBe(true);
      // A supplied tree holds the pipes in raw HTML as they are.
      expect($assertNodeType(nested, $isTableNode).getTextContent()).toBe(
        '<i title="\\|">',
      );
    });
  });

  it('reads phrasing content a supplied tree holds for a row or a cell', () => {
    using editor = createEditor();
    editor.update(
      () =>
        $convertFromMdast({
          children: [
            {
              children: [{children: [], type: 'tableRow'}],
              type: 'table',
            },
            {type: 'table'} as unknown as Table,
            {
              children: [
                {children: [{type: 'text', value: 'd'}], type: 'tableCell'},
                {children: [{type: 'text', value: 'e'}], type: 'tableCell'},
              ] as unknown as TableRow[],
              type: 'table',
            },
            {
              children: [
                {type: 'text'} as unknown as TableRow,
                {type: 'text', value: 'c'} as unknown as TableRow,
                {
                  children: [
                    {children: [{type: 'text', value: 'a'}], type: 'tableCell'},
                    {children: [{type: 'text', value: 'b'}], type: 'tableCell'},
                  ],
                  type: 'tableRow',
                },
              ],
              type: 'table',
            },
            {
              children: [
                {
                  children: [
                    {children: [{type: 'text', value: 'x'}], type: 'strong'},
                    // Whitespace between cells or rows is neither.
                    {type: 'text', value: '\n  '},
                    {type: 'text', value: 'y'},
                  ] as unknown as TableCell[],
                  type: 'tableRow',
                },
                {type: 'text', value: '\n'} as unknown as TableRow,
                {type: 'text', value: '\u00a0'} as unknown as TableRow,
                {type: 'text', value: 'z'} as unknown as TableRow,
                {type: 'tableRow'} as unknown as TableRow,
                {
                  children: [
                    {
                      children: [
                        {children: [{type: 'text', value: 'l'}], type: 'link'},
                      ],
                      type: 'tableCell',
                    } as unknown as TableCell,
                  ],
                  type: 'tableRow',
                },
              ],
              type: 'table',
            },
          ],
          type: 'root',
        }),
      {discrete: true},
    );
    editor.read(() => {
      // A table without header cells, or without rows, is none.
      expect($getRoot().getChildrenSize()).toBe(3);
      expect($convertToMarkdownString()).toBe(
        table('| d | e |', '| - | - |') +
          '\n\n' +
          table('| c |   |', '| - | - |', '| a | b |') +
          '\n\n' +
          table(
            '| **x** | y |',
            '| ----- | - |',
            // Only spaces, tabs and line endings are whitespace in Markdown.
            '| \u00a0     | z |',
            '|       |   |',
            '| [l]() |   |',
          ),
      );
    });
  });

  it('reads a supplied table’s missing header cells and alignment as GFM has them', () => {
    using editor = createEditor();
    editor.update(
      () =>
        $convertFromMdast({
          children: [
            {
              align: ['constructor' as AlignType, 'center'],
              children: [
                {children: [], type: 'tableRow'},
                {
                  children: [
                    {children: [{type: 'text', value: 'x'}], type: 'tableCell'},
                    {
                      children: [{type: 'html', value: '<i title="\\|">'}],
                      type: 'tableCell',
                    },
                  ],
                  type: 'tableRow',
                },
              ],
              type: 'table',
            },
          ],
          type: 'root',
        }),
      {discrete: true},
    );
    editor.read(() => {
      const cells = $cells();
      expect(cells.map(row => row.map(cell => cell.getTextContent()))).toEqual([
        ['', ''],
        ['x', '<i title="\\|">'],
      ]);
      expect(
        cells[1].map(cell =>
          $assertNodeType(
            cell.getFirstChild(),
            $isParagraphNode,
          ).getFormatType(),
        ),
      ).toEqual(['', 'center']);
    });
  });

  it('keeps a line break in a cell a break in mdast', () => {
    using editor = createEditor();
    editor.update(
      () => $convertFromMarkdownString(table('| a |', '| - |', '| x<br>y |')),
      {discrete: true},
    );
    editor.read(() => {
      const [tableNode] = $convertToMdast().children;
      assert(tableNode.type === 'table');
      expect(
        tableNode.children[1].children[0].children.map(child => child.type),
      ).toEqual(['text', 'break', 'text']);
    });
  });

  it('writes nothing of a cell a selection doesn’t reach', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          table('| a | b |', '| - | - |', '| 1 | x |', '| 3 | 4 |'),
        );
        const [, [one, x], [, four]] = $cells();
        x.clear().append($createParagraphNode(), $createParagraphNode());
        four.append($createHorizontalRuleNode());
        one.getAllTextNodes()[0].select(0, 1);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe('1');
    });
    // A block decorator alone is written without its table.
    editor.update(
      () => {
        const rule = $cells()[2][1].getLastChildOrThrow();
        const selection = $createNodeSelection();
        selection.add(rule.getKey());
        $setSelection(selection);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe('***');
    });
  });

  it('exports only the rows and columns a selection reaches', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          table('| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |'),
        );
        $cells()[2][0].getAllTextNodes()[0].select(0, 1);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe('3');
    });
  });

  it('writes the content of a merged cell a selection stays in', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          table('| foo | b |', '| - | - |', '| 1 | 2 |'),
        );
        const [[foo, b]] = $cells();
        b.remove();
        foo.setColSpan(2);
        foo.getAllTextNodes()[0].select(0, 3);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe('foo');
    });
  });

  it('writes a table a selection leaves or holds whole', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          ['before', table('| a |', '| - |'), 'after'].join('\n\n'),
        );
        $getRoot().select(0, $getRoot().getChildrenSize());
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe(
        ['before', table('| a |', '| - |'), 'after'].join('\n\n'),
      );
    });
    editor.update(
      () => {
        const [before] = $getRoot().getAllTextNodes();
        const selection = before.select(2, 2);
        const tableNode = $assertNodeType(
          $getRoot().getChildAtIndex(1),
          $isTableNode,
        );
        selection.focus.set($cells(tableNode)[0][0].getKey(), 1, 'element');
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe(
        ['fore', table('| a |', '| - |')].join('\n\n'),
      );
    });
  });

  it('exports only the columns a table selection spans', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          table('| a | b | c |', '| - | :-: | -: |', '| 1 | 2 | 3 |'),
        );
        const [, [, two, three]] = $cells();
        $setSelection($createTableSelectionFrom($table(), two, three));
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe(
        table('|  2  |  3 |', '| :-: | -: |'),
      );
    });
  });
  it('reads alignment from the first item of a list in a cell', () => {
    expect(
      convert(table('| a |', '| - |', '| x |'), () => {
        const [[cell]] = $cells();
        const item = $createListItemNode().append($createTextNode('y'));
        cell.clear().append($createListNode('bullet').append(item));
        item.setFormat('center');
      }),
    ).toBe(table('|  y  |', '| :-: |', '|  x  |'));
  });

  it('reads alignment from a quote around the text in a cell', () => {
    expect(
      convert(table('| a |', '| - |', '| x |'), () => {
        const [[cell]] = $cells();
        cell.clear().append(
          $createQuoteNode()
            .setFormat('center')
            .append($createParagraphNode().append($createTextNode('a'))),
        );
      }),
    ).toBe(table('|  a  |', '| :-: |', '|  x  |'));
  });

  it('reads no alignment from text in a nested table', () => {
    expect(
      convert(table('| a |', '| - |', '| x |'), () => {
        const [[cell]] = $cells();
        cell
          .clear()
          .append(
            $createTableNode().append(
              $createTableRowNode().append(
                $createTableCellNode().append(
                  $createParagraphNode()
                    .setFormat('center')
                    .append($createTextNode('p')),
                ),
              ),
            ),
          );
      }),
    ).toBe(table('| p |', '| - |', '| x |'));
  });

  it('reads a start format as none over the cell’s, and a quote around a nested table', () => {
    expect(
      convert(table('| a | b |', '| - | - |', '| 1 | 2 |'), () => {
        const [[a, b]] = $cells();
        a.setFormat('center');
        $assertNodeType(a.getFirstChild(), $isElementNode).setFormat('start');
        b.clear().append(
          $createQuoteNode()
            .setFormat('right')
            .append(
              $createTableNode().append(
                $createTableRowNode().append(
                  $createTableCellNode().append(
                    $createParagraphNode().append($createTextNode('p')),
                  ),
                ),
              ),
            ),
        );
      }),
    ).toBe(table('| a |  p |', '| - | -: |', '| 1 |  2 |'));
  });

  it('reads no alignment from the format placing a nested table', () => {
    expect(
      convert(table('| a |', '| - |', '| x |'), () => {
        const [[cell]] = $cells();
        cell.clear().append(
          $createTableNode()
            .setFormat('center')
            .append(
              $createTableRowNode().append(
                $createTableCellNode().append(
                  $createParagraphNode().append($createTextNode('p')),
                ),
              ),
            ),
        );
      }),
    ).toBe(table('| p |', '| - |', '| x |'));
  });

  it('reads the alignment of an empty header cell from its first element block', () => {
    expect(
      convert(table('| a | b |', '| :-: | - |', '| 1 | 2 |'), () => {
        const [[cell]] = $cells();
        cell
          .clear()
          .append(
            $createHorizontalRuleNode(),
            $createParagraphNode().setFormat('center'),
          );
      }),
    ).toBe(table('|     | b |', '| :-: | - |', '|  1  | 2 |') + '\n\n***');
  });

  it('reads the alignment of a header cell from a no-break space', () => {
    expect(
      convert(table('| a |', '| - |', '| 1 |'), () => {
        const [[cell]] = $cells();
        cell
          .clear()
          .append(
            $createParagraphNode()
              .setFormat('right')
              .append($createTextNode('\u00a0')),
            $createParagraphNode()
              .setFormat('center')
              .append($createTextNode('x')),
          );
      }),
    ).toBe(table('| \u00a0<br>x |', '| -----: |', '|      1 |'));
  });

  it('reads a negative row span as 1', () => {
    expect(
      convert(table('| a | b |', '| - | - |', '| 1 | 2 |'), () =>
        $cells()[0][0].setRowSpan(-1),
      ),
    ).toBe(table('| a | b |', '| - | - |', '| 1 | 2 |'));
  });

  it('leaves out a table with no cells', () => {
    expect(
      convert(
        ['before', table('| a |', '| - |', '| 1 |'), 'after'].join('\n\n'),
        () => {
          $cells($assertNodeType($getRoot().getChildAtIndex(1), $isTableNode))
            .flat()
            .forEach(cell => cell.remove());
        },
      ),
    ).toBe('before\n\nafter');
  });

  it('writes the lines of a code block in a cell as inline code', () => {
    expect(
      convert(
        [table('| a |', '| - |', '| 1 |'), '```\nx|y\n\nz\n```'].join('\n\n'),
        () => {
          const code = $getRoot().getLastChildOrThrow();
          $cells()[1][0].clear().append(code);
        },
      ),
    ).toBe(
      table(
        '| a                 |',
        '| ----------------- |',
        '| `x\\|y`<br><br>`z` |',
      ),
    );
  });

  it('keeps an inline node an export rule writes in its line', () => {
    using editor = createEditor(
      configExtension(MdastExtension, {
        exportRules: [
          {
            $export: node => [
              {type: 'wikiLink', value: node.getTextContent()} as never,
            ],
            type: LinkNode,
          },
        ],
        toMarkdownExtensions: [
          {
            handlers: {
              wikiLink: (node: {value: string}) => `[[${node.value}]]`,
            } as never,
          },
        ],
      }),
    );
    editor.update(
      () => {
        $convertFromMarkdownString(table('| a |', '| - |', '| 1 [w](x) 2 |'));
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertToMarkdownString()).toBe(
        table('| a         |', '| --------- |', '| 1 [[w]] 2 |'),
      );
    });
  });

  it('writes raw HTML blocks in a cell on lines of their own', () => {
    using editor = createEditor(
      configExtension(MdastExtension, {
        exportRules: [
          {
            $export: () => [{type: 'html', value: '<hr>'}],
            type: HorizontalRuleNode,
          },
        ],
      }),
    );
    editor.update(
      () => {
        $convertFromMarkdownString(table('| a |', '| - |', '| 1 |'));
        $cells()[1][0].append(
          $createHorizontalRuleNode(),
          $createHorizontalRuleNode(),
        );
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertToMarkdownString()).toBe(
        table(
          '| a                 |',
          '| ----------------- |',
          '| 1<br><hr><br><hr> |',
        ),
      );
    });
  });

  it('keeps a column whose cells export as blocks with no inline form', () => {
    using editor = createEditor(
      configExtension(MdastExtension, {
        exportRules: [
          {$export: () => [{type: 'thematicBreak'}], type: QuoteNode},
        ],
      }),
    );
    editor.update(
      () => {
        $convertFromMarkdownString(
          table('| a | b |', '| - | - |', '| 1 | 2 |'),
        );
        for (const row of $cells()) {
          row[1]
            .clear()
            .append(
              $createQuoteNode().append(
                $createParagraphNode().append($createTextNode('q')),
              ),
            );
        }
      },
      {discrete: true},
    );
    const expected = [
      table('| a |   |', '| - | - |', '| 1 |   |'),
      '***',
      '***',
    ].join('\n\n');
    editor.read(() => {
      expect($convertToMarkdownString()).toBe(expected);
    });
    // A copy of the whole table keeps the column too.
    editor.update(() => $getRoot().select(0, 1), {discrete: true});
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe(expected);
    });
  });

  it('adds no line for a block of only block decorators in a cell', () => {
    expect(
      convert(table('| a | b |', '| - | - |', '| 1 | 2 |'), () => {
        $cells()[1][0].append(
          $createQuoteNode().append($createHorizontalRuleNode()),
        );
      }),
    ).toBe([table('| a | b |', '| - | - |', '| 1 | 2 |'), '***'].join('\n\n'));
  });

  it('writes the row of a cell of only block decorators a selection ends in', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          table('| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |'),
        );
        const [, [one], [three, four]] = $cells();
        three.remove();
        one.setRowSpan(2);
        four.clear().append($createHorizontalRuleNode());
        const selection = one.getAllTextNodes()[0].select(0, 0);
        selection.focus.set(four.getKey(), 1, 'element');
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe(
        [table('| 1 | 2 |', '| - | - |', '|   |   |'), '***'].join('\n\n'),
      );
    });
  });

  it('copies a column of cells holding only block decorators', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          ['x', table('| a | b |', '| - | - |'), 'y'].join('\n\n'),
        );
        const tableNode = $assertNodeType(
          $getRoot().getChildAtIndex(1),
          $isTableNode,
        );
        $cells(tableNode)[0][1].clear().append($createHorizontalRuleNode());
        $getRoot().select(0, 3);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($convertSelectionToMarkdownString()).toBe(
        ['x', table('| a |   |', '| - | - |'), '***', 'y'].join('\n\n'),
      );
    });
  });

  it('keeps a table whose cells hold only block decorators', () => {
    expect(
      convert(table('| a |', '| - |'), () => {
        $cells()[0][0].clear().append($createHorizontalRuleNode());
      }),
    ).toBe([table('|   |', '| - |'), '***'].join('\n\n'));
  });
});
