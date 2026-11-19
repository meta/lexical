/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {test} from 'vitest';

import {
  assertHTML,
  pasteFromClipboard,
  setupTablePasteEditor,
} from './htmlPasteUtils';
import {html} from './utils';

test('Copy + paste (Table - Google Docs with custom widths)', async () => {
  const {root} = await setupTablePasteEditor();

  const clipboard = {
    'text/html': `<meta charset='utf-8'><meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-dd8626d9-7fff-78d6-4aad-a0d248a19533"><div dir="ltr" style="margin-left:0pt;" align="center"><table style="border:none;border-collapse:collapse;"><colgroup><col width="78" /><col width="405" /><col width="233" /></colgroup><tbody><tr style="height:0pt"><td style="border-left:solid #000000 1pt;border-right:solid #000000 1pt;border-bottom:solid #000000 1pt;border-top:solid #000000 1pt;vertical-align:top;padding:5pt 5pt 5pt 5pt;overflow:hidden;overflow-wrap:break-word;"><p dir="ltr" style="line-height:1.2;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">short</span></p></td><td style="border-left:solid #000000 1pt;border-right:solid #000000 1pt;border-bottom:solid #000000 1pt;border-top:solid #000000 1pt;vertical-align:top;padding:5pt 5pt 5pt 5pt;overflow:hidden;overflow-wrap:break-word;"><p dir="ltr" style="line-height:1.2;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">wide</span></p></td><td style="border-left:solid #000000 1pt;border-right:solid #000000 1pt;border-bottom:solid #000000 1pt;border-top:solid #000000 1pt;vertical-align:top;padding:5pt 5pt 5pt 5pt;overflow:hidden;overflow-wrap:break-word;"><p dir="ltr" style="line-height:1.2;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">default</span></p></td></tr><tr style="height:0pt"><td style="border-left:solid #000000 1pt;border-right:solid #000000 1pt;border-bottom:solid #000000 1pt;border-top:solid #000000 1pt;vertical-align:top;padding:5pt 5pt 5pt 5pt;overflow:hidden;overflow-wrap:break-word;"><p dir="ltr" style="line-height:1.2;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">a</span></p></td><td style="border-left:solid #000000 1pt;border-right:solid #000000 1pt;border-bottom:solid #000000 1pt;border-top:solid #000000 1pt;vertical-align:top;padding:5pt 5pt 5pt 5pt;overflow:hidden;overflow-wrap:break-word;"><p dir="ltr" style="line-height:1.2;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">b</span></p></td><td style="border-left:solid #000000 1pt;border-right:solid #000000 1pt;border-bottom:solid #000000 1pt;border-top:solid #000000 1pt;vertical-align:top;padding:5pt 5pt 5pt 5pt;overflow:hidden;overflow-wrap:break-word;"><p dir="ltr" style="line-height:1.2;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">c</span></p></td></tr></tbody></table></div><br data-lexical-managed-linebreak="true" /></b>`,
  };
  await pasteFromClipboard(root, clipboard);
  await assertHTML(
    root,
    html`
      <table class="PlaygroundEditorTheme__table" dir="auto">
        <colgroup>
          <col style="width: 78px;" />
          <col style="width: 405px;" />
          <col style="width: 233px;" />
        </colgroup>
        <tr dir="auto">
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
              <span style="font-size: 11pt" data-lexical-text="true">
                short
              </span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
              <span style="font-size: 11pt" data-lexical-text="true">wide</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
              <span style="font-size: 11pt" data-lexical-text="true">
                default
              </span>
            </p>
          </td>
        </tr>
        <tr dir="auto">
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
              <span style="font-size: 11pt" data-lexical-text="true">a</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
              <span style="font-size: 11pt" data-lexical-text="true">b</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
              <span style="font-size: 11pt" data-lexical-text="true">c</span>
            </p>
          </td>
        </tr>
      </table>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <br data-lexical-managed-linebreak="true" />
      </p>
    `,
  );
});

test('Copy + paste (Table - Quip)', async () => {
  const {root} = await setupTablePasteEditor();

  const clipboard = {
    'text/html': `<meta charset='utf-8'><table style="border-collapse: collapse;"><col style="width: 90px;"><col style="width: 90px;"><col style="width: 90px;"><tr><td style="border: 1px solid rgb(230, 230, 230); text-align: left;">a</td><td style="border: 1px solid rgb(230, 230, 230); text-align: left;">b<br>b</td><td style="border: 1px solid rgb(230, 230, 230); text-align: left;">c</td></tr><tr><td style="border: 1px solid rgb(230, 230, 230); text-align: left;">d</td><td style="border: 1px solid rgb(230, 230, 230); text-align: left;">e</td><td style="border: 1px solid rgb(230, 230, 230); text-align: left;">f</td></tr></table>`,
  };
  await pasteFromClipboard(root, clipboard);

  await assertHTML(
    root,
    html`
      <table class="PlaygroundEditorTheme__table" dir="auto">
        <colgroup>
          <col style="width: 90px" />
          <col style="width: 90px" />
          <col style="width: 90px" />
        </colgroup>
        <tr dir="auto">
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p
              class="PlaygroundEditorTheme__paragraph"
              dir="auto"
              style="text-align: left;">
              <span data-lexical-text="true">a</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p
              class="PlaygroundEditorTheme__paragraph"
              dir="auto"
              style="text-align: left;">
              <span data-lexical-text="true">b</span>
              <br />
              <span data-lexical-text="true">b</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p
              class="PlaygroundEditorTheme__paragraph"
              dir="auto"
              style="text-align: left;">
              <span data-lexical-text="true">c</span>
            </p>
          </td>
        </tr>
        <tr dir="auto">
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p
              class="PlaygroundEditorTheme__paragraph"
              dir="auto"
              style="text-align: left;">
              <span data-lexical-text="true">d</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p
              class="PlaygroundEditorTheme__paragraph"
              dir="auto"
              style="text-align: left;">
              <span data-lexical-text="true">e</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p
              class="PlaygroundEditorTheme__paragraph"
              dir="auto"
              style="text-align: left;">
              <span data-lexical-text="true">f</span>
            </p>
          </td>
        </tr>
      </table>
    `,
  );
});

test('Copy + paste (Table - Google Sheets)', async () => {
  const {root} = await setupTablePasteEditor();

  const clipboard = {
    'text/html': `<meta charset='utf-8'><google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #ccc;}br {mso-data-placement:same-cell;}--></style><table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1" style="table-layout:fixed;font-size:10pt;font-family:Arial;width:0px;border-collapse:collapse;border:none"><colgroup><col width="100"/><col width="100"/><col width="100"/></colgroup><tbody><tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;a&quot;}">a</td><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;b\nb&quot;}">b<br/>b</td><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;c&quot;}">c</td></tr><tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;d&quot;}">d</td><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;e&quot;}">e</td><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;f&quot;}">f</td></tr></tbody></table>`,
  };

  await pasteFromClipboard(root, clipboard);

  await assertHTML(
    root,
    html`
      <table class="PlaygroundEditorTheme__table" dir="auto">
        <colgroup>
          <col style="width: 100px" />
          <col style="width: 100px" />
          <col style="width: 100px" />
        </colgroup>
        <tr dir="auto" style="height: 21px">
          <td
            class="PlaygroundEditorTheme__tableCell"
            dir="auto"
            style="vertical-align: bottom">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">a</span>
            </p>
          </td>
          <td
            class="PlaygroundEditorTheme__tableCell"
            dir="auto"
            style="vertical-align: bottom">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">b</span>
              <br />
              <span data-lexical-text="true">b</span>
            </p>
          </td>
          <td
            class="PlaygroundEditorTheme__tableCell"
            dir="auto"
            style="vertical-align: bottom">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">c</span>
            </p>
          </td>
        </tr>
        <tr dir="auto" style="height: 21px">
          <td
            class="PlaygroundEditorTheme__tableCell"
            dir="auto"
            style="vertical-align: bottom">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">d</span>
            </p>
          </td>
          <td
            class="PlaygroundEditorTheme__tableCell"
            dir="auto"
            style="vertical-align: bottom">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">e</span>
            </p>
          </td>
          <td
            class="PlaygroundEditorTheme__tableCell"
            dir="auto"
            style="vertical-align: bottom">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">f</span>
            </p>
          </td>
        </tr>
      </table>
    `,
  );
});

test('Copy + paste nested block and inline html in a table', async () => {
  const {root} = await setupTablePasteEditor();

  const clipboard = {
    'text/html': html`
      123
      <table>
        <tbody>
          <tr>
            <td>
              <span>456<span>
            </td>
            <td>
              789
              <div>
                000
              </div>
            </td>
          </tr>
          <tr>
            <td>
              ABC
              <div>
                000
                <div>
                  000
                </div>
              </div>
            </td>
            <td>
              DEF
            </td>
          </tr>
        </tbody>
      </table>
      `,
  };

  await pasteFromClipboard(root, clipboard);

  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">123</span>
      </p>
      <table class="PlaygroundEditorTheme__table" dir="auto">
        <colgroup>
          <col style="width: 92px" />
          <col style="width: 92px" />
        </colgroup>
        <tr dir="auto">
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">456</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">789</span>
            </p>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">000</span>
            </p>
          </td>
        </tr>
        <tr dir="auto">
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">ABC</span>
            </p>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">000</span>
            </p>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">000</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">DEF</span>
            </p>
          </td>
        </tr>
      </table>
    `,
  );
});

test('Copy + paste table with merged cells and unequal number of cells in rows', async () => {
  const {root} = await setupTablePasteEditor();

  const clipboard = {
    'text/html': html`
      123
      <table>
        <tr>
          <td colspan="2">
            <p>
              <span>1</span>
            </p>
          </td>
          <td>
            <p>
              <span>2</span>
            </p>
          </td>
          <td>
            <p>
              <span>3</span>
            </p>
          </td>
          <td>
            <p>
              <span>4</span>
            </p>
          </td>
        </tr>
        <tr>
          <td rowspan="4">
            <p>
              <span>7</span>
            </p>
          </td>
        </tr>
        <tr>
          <td>
            <p>
              <span>8</span>
            </p>
          </td>
          <td rowspan="2">
            <p>
              <span>9</span>
            </p>
          </td>
        </tr>
        <tr>
          <td>
            <p>
              <span>0</span>
            </p>
          </td>
        </tr>
      </table>
    `,
  };

  await pasteFromClipboard(root, clipboard);

  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">123</span>
      </p>
      <table class="PlaygroundEditorTheme__table" dir="auto">
        <colgroup>
          <col style="width: 92px" />
          <col style="width: 92px" />
          <col style="width: 92px" />
          <col style="width: 92px" />
          <col style="width: 92px" />
        </colgroup>
        <tr dir="auto">
          <td class="PlaygroundEditorTheme__tableCell" colspan="2" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">1</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">2</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">3</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">4</span>
            </p>
          </td>
        </tr>
        <tr dir="auto">
          <td class="PlaygroundEditorTheme__tableCell" dir="auto" rowspan="4">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">7</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br data-lexical-managed-linebreak="true" />
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br data-lexical-managed-linebreak="true" />
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br data-lexical-managed-linebreak="true" />
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br data-lexical-managed-linebreak="true" />
            </p>
          </td>
        </tr>
        <tr dir="auto">
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">8</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto" rowspan="2">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">9</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br data-lexical-managed-linebreak="true" />
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br data-lexical-managed-linebreak="true" />
            </p>
          </td>
        </tr>
        <tr dir="auto">
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">0</span>
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br data-lexical-managed-linebreak="true" />
            </p>
          </td>
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br data-lexical-managed-linebreak="true" />
            </p>
          </td>
        </tr>
      </table>
    `,
  );
});

test('Copy + paste table with empty row', async () => {
  const {root} = await setupTablePasteEditor();

  const clipboard = {
    'text/html': html`
      <table>
        <tr><td>1</td></tr>
        <tr></tr>
        <tr><td>2</td></tr>
      </table>
    `,
  };

  await pasteFromClipboard(root, clipboard);

  await assertHTML(
    root,
    html`
      <table class="PlaygroundEditorTheme__table" dir="auto">
        <colgroup>
          <col style="width: 92px" />
        </colgroup>
        <tr dir="auto">
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">1</span>
            </p>
          </td>
        </tr>
        <tr dir="auto">
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br data-lexical-managed-linebreak="true" />
            </p>
          </td>
        </tr>
        <tr dir="auto">
          <td class="PlaygroundEditorTheme__tableCell" dir="auto">
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">2</span>
            </p>
          </td>
        </tr>
      </table>
    `,
  );
});
