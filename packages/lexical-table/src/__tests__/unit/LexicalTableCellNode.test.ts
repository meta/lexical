/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$generateHtmlFromNodes, $generateNodesFromDOM} from '@lexical/html';
import {
  $createTableCellNode,
  $isTableCellNode,
  type SerializedTableCellNode,
  TableCellHeaderStates,
  TableCellNode,
} from '@lexical/table';
import {$createTextNode, $getRoot, type DOMConversionOutput} from 'lexical';
import {
  $runDOMConversion,
  expectHtmlToBeEqual,
  html,
  initializeUnitTest,
  invariant,
} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

const editorConfig = Object.freeze({
  namespace: '',
  theme: {
    tableCell: 'test-table-cell-class',
  },
});

describe('LexicalTableCellNode tests', () => {
  initializeUnitTest(testEnv => {
    test('importJSON coerces out-of-domain span/width/verticalAlign', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        // Everything a TableCellNode adds over an element, out of domain: the
        // serialization schema replaced the historical `|| 1` / `|| undefined`
        // parsing, so these fall back rather than being stored verbatim.
        // Cast: these are values a legacy or hostile document can carry, not
        // values the node's own type admits.
        const json = {
          colSpan: 0,
          headerState: TableCellHeaderStates.NO_STATUS,
          rowSpan: -3,
          type: 'tablecell',
          verticalAlign: 'nonsense',
          width: 0,
        } as SerializedTableCellNode;
        const cell = TableCellNode.importJSON(json);
        invariant($isTableCellNode(cell), 'expected a TableCellNode');
        expect(cell.getColSpan()).toBe(1);
        expect(cell.getRowSpan()).toBe(1);
        expect(cell.getWidth()).toBeUndefined();
        expect(cell.getVerticalAlign()).toBeUndefined();
      });
    });

    test('importJSON round-trips in-domain values', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const json: SerializedTableCellNode = {
          backgroundColor: '#fff',
          children: [],
          colSpan: 2,
          direction: null,
          format: '',
          headerState: TableCellHeaderStates.ROW,
          indent: 0,
          rowSpan: 3,
          type: 'tablecell',
          version: 1,
          verticalAlign: 'middle',
          width: 120,
        };
        const cell = TableCellNode.importJSON(json);
        invariant($isTableCellNode(cell), 'expected a TableCellNode');
        expect(cell.getColSpan()).toBe(2);
        expect(cell.getRowSpan()).toBe(3);
        expect(cell.getWidth()).toBe(120);
        expect(cell.getVerticalAlign()).toBe('middle');
        expect(cell.getBackgroundColor()).toBe('#fff');
        expect(cell.getHeaderStyles()).toBe(TableCellHeaderStates.ROW);
      });
    });

    test('TableCellNode.constructor', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const cellNode = $createTableCellNode(TableCellHeaderStates.NO_STATUS);

        expect(cellNode).not.toBe(null);
      });

      expect(() =>
        $createTableCellNode(TableCellHeaderStates.NO_STATUS),
      ).toThrow();
    });

    test('TableCellNode.createDOM()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const cellNode = $createTableCellNode(TableCellHeaderStates.NO_STATUS);
        expect(cellNode.createDOM(editorConfig).outerHTML).toBe(
          `<td class="${editorConfig.theme.tableCell}"></td>`,
        );

        const headerCellNode = $createTableCellNode(TableCellHeaderStates.ROW);
        expect(headerCellNode.createDOM(editorConfig).outerHTML).toBe(
          `<th class="${editorConfig.theme.tableCell}"></th>`,
        );

        const colSpan = 2;
        const cellWithRowSpanNode = $createTableCellNode(
          TableCellHeaderStates.NO_STATUS,
          colSpan,
        );
        expect(cellWithRowSpanNode.createDOM(editorConfig).outerHTML).toBe(
          `<td colspan="${colSpan}" class="${editorConfig.theme.tableCell}"></td>`,
        );

        const cellWidth = 200;
        const cellWithCustomWidthNode = $createTableCellNode(
          TableCellHeaderStates.NO_STATUS,
          undefined,
          cellWidth,
        );
        expect(cellWithCustomWidthNode.createDOM(editorConfig).outerHTML).toBe(
          `<td style="width: ${cellWidth}px;" class="${editorConfig.theme.tableCell}"></td>`,
        );
        const ignoredVerticalAlign = 'top';
        const cellWithIgnoredVerticalAlignNode = $createTableCellNode(
          TableCellHeaderStates.NO_STATUS,
        );
        cellWithIgnoredVerticalAlignNode.setVerticalAlign(ignoredVerticalAlign);
        expect(
          cellWithIgnoredVerticalAlignNode.createDOM(editorConfig).outerHTML,
        ).toBe(`<td class="${editorConfig.theme.tableCell}"></td>`);
        const validVerticalAlign = 'middle';
        const cellWithValidVerticalAlignNode = $createTableCellNode(
          TableCellHeaderStates.NO_STATUS,
        );
        cellWithValidVerticalAlignNode.setVerticalAlign(validVerticalAlign);
        expect(
          cellWithValidVerticalAlignNode.createDOM(editorConfig).outerHTML,
        ).toBe(
          `<td style="vertical-align: ${validVerticalAlign};" class="${editorConfig.theme.tableCell}"></td>`,
        );
      });
    });

    // Increased timeout as this test performs DOM parsing and HTML generation
    // which can be slow, preventing flaky test failures
    test('TableCellNode.importDOM', async () => {
      const {editor} = testEnv;
      const parser = new DOMParser();

      const cases: [string, string][] = [
        [
          html`
            <table>
              <tr>
                <td>
                  <test-decorator></test-decorator>
                  1
                </td>
              </tr>
            </table>
          `,
          html`
            <table>
              <tbody>
                <tr>
                  <td
                    style="border: 1px solid black; width: 75px; vertical-align: top; text-align: start;">
                    <p>
                      <test-decorator></test-decorator>
                      <span style="white-space: pre-wrap;">1</span>
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
          `,
        ],
        [
          html`
            <table>
              <tr>
                <td>
                  1
                  <br />
                  <br />
                  <br />
                  <br />
                  2
                </td>
              </tr>
            </table>
          `,
          html`
            <table>
              <tbody>
                <tr>
                  <td
                    style="border: 1px solid black; width: 75px; vertical-align: top; text-align: start;">
                    <p>
                      <span style="white-space: pre-wrap;">1</span>
                      <br />
                      <br />
                      <br />
                      <br />
                      <span style="white-space: pre-wrap;">2</span>
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
          `,
        ],
        [
          html`
            <table>
              <tr>
                <td>
                  <p>1</p>
                  <br />
                  <p>2</p>
                </td>
              </tr>
            </table>
          `,
          html`
            <table>
              <tbody>
                <tr>
                  <td
                    style="border: 1px solid black; width: 75px; vertical-align: top; text-align: start;">
                    <p>
                      <span style="white-space: pre-wrap;">1</span>
                    </p>
                    <p>
                      <br />
                    </p>
                    <p>
                      <span style="white-space: pre-wrap;">2</span>
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
          `,
        ],
      ];

      await editor.update(() => {
        const root = $getRoot();

        for (const [input, output] of cases) {
          root.clear();

          const dom = parser.parseFromString(input, 'text/html');
          const nodes = $generateNodesFromDOM(editor, dom);
          root.append(...nodes);

          expectHtmlToBeEqual($generateHtmlFromNodes(editor), output);
        }
      });
    }, 15000);

    // Simulates the Lexical Paste Engine finding and running the converter by
    // driving the real DOM-import machinery (the editor's registered conversion
    // cache, the path the paste engine actually uses) rather than reaching into
    // TableCellNode.importDOM() directly. The element is converted in place so
    // the cell's row/table position is visible to the conversion.
    const $convertHTMLTag = (
      element: HTMLElement,
    ): DOMConversionOutput | null => $runDOMConversion(testEnv.editor, element);

    const expectTableCellNode = (result: DOMConversionOutput | null) => {
      const node = result?.node;

      if (Array.isArray(node)) {
        throw new Error('Expected a single node, but got an array');
      }

      invariant(
        $isTableCellNode(node),
        'Expected result.node to be a TableCellNode',
      );

      return node;
    };

    test('DOM Conversion: <th> with scope="col" becomes COLUMN header', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const th = document.createElement('th');
        th.setAttribute('scope', 'col');

        const result = $convertHTMLTag(th);

        const node = expectTableCellNode(result);

        expect(node.getHeaderStyles()).toBe(TableCellHeaderStates.COLUMN);
      });
    });

    test('DOM Conversion: <th> with scope="row" becomes ROW header', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const th = document.createElement('th');
        th.setAttribute('scope', 'row');

        const result = $convertHTMLTag(th);

        const node = expectTableCellNode(result);

        expect(node.getHeaderStyles()).toBe(TableCellHeaderStates.ROW);
      });
    });

    test('DOM Conversion: <th> without scope defaults to ROW header', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const table = document.createElement('table');
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        tr.appendChild(th);
        table.appendChild(tr);

        const result = $convertHTMLTag(th);

        const node = expectTableCellNode(result);

        // First row, first column → BOTH (ROW from header row + COLUMN from first column)
        expect(node.getHeaderStyles()).toBe(TableCellHeaderStates.BOTH);
      });
    });

    test('DOM Conversion: <th> in first row without scope becomes ROW header', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const table = document.createElement('table');
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        const td = document.createElement('td');
        tr.appendChild(th);
        tr.appendChild(td);
        table.appendChild(tr);

        const result = $convertHTMLTag(th);
        const node = expectTableCellNode(result);

        // First row, first column → BOTH
        expect(node.getHeaderStyles()).toBe(TableCellHeaderStates.BOTH);
      });
    });

    test('DOM Conversion: <th> in first column of non-first row becomes COLUMN header', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const table = document.createElement('table');
        const tr1 = document.createElement('tr');
        const tr2 = document.createElement('tr');
        const th1 = document.createElement('th');
        const td1 = document.createElement('td');
        const th2 = document.createElement('th');
        const td2 = document.createElement('td');
        tr1.appendChild(th1);
        tr1.appendChild(td1);
        tr2.appendChild(th2);
        tr2.appendChild(td2);
        table.appendChild(tr1);
        table.appendChild(tr2);

        const result = $convertHTMLTag(th2);
        const node = expectTableCellNode(result);

        // Non-first row, first column → COLUMN
        expect(node.getHeaderStyles()).toBe(TableCellHeaderStates.COLUMN);
      });
    });

    test('DOM Conversion: <th> in thead without scope becomes ROW header', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        const th2 = document.createElement('th');
        tr.appendChild(th);
        tr.appendChild(th2);
        thead.appendChild(tr);
        table.appendChild(thead);

        // Second th in thead → ROW (not first column, so only ROW from first row)
        const result = $convertHTMLTag(th2);
        const node = expectTableCellNode(result);

        expect(node.getHeaderStyles()).toBe(TableCellHeaderStates.ROW);
      });
    });

    test('DOM Conversion: <td> with style.backgroundColor reads inline background-color', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const td = document.createElement('td');
        td.style.backgroundColor = '#F4B084';

        const result = $convertHTMLTag(td);
        const node = expectTableCellNode(result);

        // Browsers normalize hex to rgb when set via .style
        expect(node.getBackgroundColor()).toBe(td.style.backgroundColor);
      });
    });

    test('DOM Conversion: <td> with no background color sets backgroundColor to null', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const td = document.createElement('td');

        const result = $convertHTMLTag(td);
        const node = expectTableCellNode(result);

        expect(node.getBackgroundColor()).toBeNull();
      });
    });

    test('DOM Conversion: <td> with color propagates color to child TextNodes via after callback', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const td = document.createElement('td');
        td.style.color = 'blue';

        const result = $convertHTMLTag(td);
        expectTableCellNode(result);

        // The after callback propagates td color to child TextNodes
        const textNode = $createTextNode('Hello');
        result!.after!([textNode]);
        expect(textNode.getStyle()).toContain('color: blue');
      });
    });

    test('DOM Conversion: <td> color does not overwrite existing child TextNode color', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const td = document.createElement('td');
        td.style.color = 'blue';

        const result = $convertHTMLTag(td);
        expectTableCellNode(result);

        const textNode = $createTextNode('Hello');
        textNode.setStyle('color: red;');
        result!.after!([textNode]);
        // Existing color should not be overwritten
        expect(textNode.getStyle()).toContain('color: red');
        expect(textNode.getStyle()).not.toContain('color: blue');
      });
    });
  });
});
