/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$insertDataTransferForRichText} from '@lexical/clipboard';
import {$patchStyleText} from '@lexical/selection';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
} from 'lexical';
import {initializeUnitTest, invariant} from 'lexical/src/__tests__/utils';
import {beforeEach, describe, expect, test} from 'vitest';

describe('HTMLCopyAndPaste tests', () => {
  initializeUnitTest(
    testEnv => {
      beforeEach(async () => {
        const {editor} = testEnv;
        await editor.update(() => {
          const root = $getRoot();
          const paragraph = $createParagraphNode();
          root.append(paragraph);
          paragraph.select();
        });
      });

      const HTML_COPY_PASTING_TESTS = [
        {
          expectedHTML: `<p dir="auto"><span data-lexical-text="true">Hello!</span></p>`,
          name: 'plain DOM text node',
          pastedHTML: `Hello!`,
        },
        {
          expectedHTML: `<p dir="auto"><span data-lexical-text="true">Hello!</span></p><p dir="auto"><br data-lexical-managed-linebreak="true"></p>`,
          name: 'a paragraph element',
          pastedHTML: `<p>Hello!<p>`,
        },
        {
          expectedHTML: `<p dir="auto"><span data-lexical-text="true">123</span></p><p dir="auto"><span data-lexical-text="true">456</span></p>`,
          name: 'a single div',
          pastedHTML: `123
            <div>
              456
            </div>`,
        },
        {
          expectedHTML: `<p dir="auto"><span data-lexical-text="true">a b c d e</span></p><p dir="auto"><span data-lexical-text="true">f g h</span></p>`,
          name: 'multiple nested spans and divs',
          pastedHTML: `<div>
            a b
            <span>
              c d
              <span>e</span>
            </span>
            <div>
              f
              <span>g h</span>
            </div>
          </div>`,
        },
        {
          expectedHTML: `<p dir="auto"><span data-lexical-text="true">123</span></p><p dir="auto"><span data-lexical-text="true">456</span></p>`,
          name: 'nested span in a div',
          pastedHTML: `<div>
            <span>
              123
              <div>456</div>
            </span>
          </div>`,
        },
        {
          expectedHTML: `<p dir="auto"><span data-lexical-text="true">123</span></p><p dir="auto"><span data-lexical-text="true">456</span></p>`,
          name: 'nested div in a span',
          pastedHTML: ` <span>123<div>456</div></span>`,
        },
        {
          expectedHTML: `<ul dir="auto"><li dir="ltr" style="text-align: right;"><span data-lexical-text="true">Hello</span></li><li dir="ltr" style="text-align: right;"><span data-lexical-text="true">World</span></li></ul>`,
          name: 'google doc list with right alignment',
          pastedHTML: `<meta charset='utf-8'><meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-61c25daf-7fff-957d-d4b5-8e006d20766d"><ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;"><li dir="ltr" style="list-style-type:disc;font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;" aria-level="1"><p dir="ltr" style="line-height:1.38;text-align: right;margin-top:0pt;margin-bottom:0pt;" role="presentation"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Hello</span></p></li><li dir="ltr" style="list-style-type:disc;font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;" aria-level="1"><p dir="ltr" style="line-height:1.38;text-align: right;margin-top:0pt;margin-bottom:0pt;" role="presentation"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">World</span></p></li></ul></b>`,
        },
        {
          expectedHTML: `<ul dir="auto"><li role="checkbox" tabindex="-1" aria-checked="true" dir="ltr"><span data-lexical-text="true">done</span></li><li role="checkbox" tabindex="-1" aria-checked="false" dir="ltr"><span data-lexical-text="true">todo</span></li><li><ul><li role="checkbox" tabindex="-1" aria-checked="true" dir="ltr"><span data-lexical-text="true">done</span></li><li role="checkbox" tabindex="-1" aria-checked="false" dir="ltr"><span data-lexical-text="true">todo</span></li></ul></li><li role="checkbox" tabindex="-1" aria-checked="false" dir="ltr"><span data-lexical-text="true">todo</span></li></ul>`,
          name: 'google doc checklist',
          pastedHTML: `<meta charset='utf-8'><meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1980f960-7fff-f4df-4ba3-26c6e1508542"><ul style="margin-top:0;margin-bottom:0;padding-inline-start:28px;"><li dir="ltr" role="checkbox" aria-checked="true" style="list-style-type:none;font-size:11.5pt;font-family:'Optimistic Text',sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:line-through;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;vertical-align:baseline;white-space:pre;" aria-level="1"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAABbElEQVR4Ae3bsU4CYRDEcRsxodZE8Q0BbS258l5MwESJNL6HOfrPKdhyxeBcwk5mkn9F98sGIOSuPM/zPM/zPI+xG/SEtuiAWpEOaIOWaDIWziP6RK14OzSjX44ITvTBvqRn1MRaMIHeBIE2TKBBEGhgArWkKmtJBjKQgQxkIANd/Aw0NVC+O7RHvYFynHasN1COE/UGynGiXgOIjxOtdIH4OGJAfBwxID6OGBAfRwiIjyMARMCpCjRF5+72Dzhd5R+rHfpC92NeTlWgLl5PkQg4RYBynBSJgFMGKMNJkQg4lYFeUDuFRMCpBXQOEgGnDtA/kPg4xT7m2y/tCd9zKgOdviTC5RQEIiAFjh4QASlw9IAISIEjCURAWvmf1UDKcQwUSDmOgWLdMcxA7BnIQAYykIEM5EcRvplAW0GgNRNoKQg0ZwJN0E4I5x1dI+pmgSSA84BG2QQt0LrYG/eAXtGccjme53me53me9wPjPWZWjhktAQAAAABJRU5ErkJggg==" width="18.4px" height="18.4px" alt="checked" aria-roledescription="checkbox" style="margin-right:3px;" /><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;display:inline-block;vertical-align:top;margin-top:0;" role="presentation"><span style="font-size:11.5pt;font-family:'Optimistic Text',sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:line-through;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">done</span></p></li><li dir="ltr" role="checkbox" aria-checked="false" style="list-style-type:none;font-size:11.5pt;font-family:'Optimistic Text',sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;" aria-level="1"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAA1ElEQVR4Ae3bMQ4BURSFYY2xBuwQ7BIkTGxFRj9Oo9RdkXn5TvL3L19u+2ZmZmZmZhVbpH26pFcaJ9IrndMudb/CWadHGiden1bll9MIzqd79SUd0thY20qga4NA50qgoUGgoRJo/NL/V/N+QIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIEyFeEZyXQpUGgUyXQrkGgTSVQl/qGcG5pnkq3Sn0jOMv0k3Vpm05pmNjfsGPalFyOmZmZmdkbSS9cKbtzhxMAAAAASUVORK5CYII=" width="18.4px" height="18.4px" alt="unchecked" aria-roledescription="checkbox" style="margin-right:3px;" /><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;display:inline-block;vertical-align:top;margin-top:0;" role="presentation"><span style="font-size:11.5pt;font-family:'Optimistic Text',sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">todo</span></p></li><ul style="margin-top:0;margin-bottom:0;padding-inline-start:28px;"><li dir="ltr" role="checkbox" aria-checked="true" style="list-style-type:none;font-size:11.5pt;font-family:'Optimistic Text',sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:line-through;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;vertical-align:baseline;white-space:pre;" aria-level="2"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAABbElEQVR4Ae3bsU4CYRDEcRsxodZE8Q0BbS258l5MwESJNL6HOfrPKdhyxeBcwk5mkn9F98sGIOSuPM/zPM/zPI+xG/SEtuiAWpEOaIOWaDIWziP6RK14OzSjX44ITvTBvqRn1MRaMIHeBIE2TKBBEGhgArWkKmtJBjKQgQxkIANd/Aw0NVC+O7RHvYFynHasN1COE/UGynGiXgOIjxOtdIH4OGJAfBwxID6OGBAfRwiIjyMARMCpCjRF5+72Dzhd5R+rHfpC92NeTlWgLl5PkQg4RYBynBSJgFMGKMNJkQg4lYFeUDuFRMCpBXQOEgGnDtA/kPg4xT7m2y/tCd9zKgOdviTC5RQEIiAFjh4QASlw9IAISIEjCURAWvmf1UDKcQwUSDmOgWLdMcxA7BnIQAYykIEM5EcRvplAW0GgNRNoKQg0ZwJN0E4I5x1dI+pmgSSA84BG2QQt0LrYG/eAXtGccjme53me53me9wPjPWZWjhktAQAAAABJRU5ErkJggg==" width="18.4px" height="18.4px" alt="checked" aria-roledescription="checkbox" style="margin-right:3px;" /><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;display:inline-block;vertical-align:top;margin-top:0;" role="presentation"><span style="font-size:11.5pt;font-family:'Optimistic Text',sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:line-through;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">done</span></p></li><li dir="ltr" role="checkbox" aria-checked="false" style="list-style-type:none;font-size:11.5pt;font-family:'Optimistic Text',sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;" aria-level="2"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAA1ElEQVR4Ae3bMQ4BURSFYY2xBuwQ7BIkTGxFRj9Oo9RdkXn5TvL3L19u+2ZmZmZmZhVbpH26pFcaJ9IrndMudb/CWadHGiden1bll9MIzqd79SUd0thY20qga4NA50qgoUGgoRJo/NL/V/N+QIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIEyFeEZyXQpUGgUyXQrkGgTSVQl/qGcG5pnkq3Sn0jOMv0k3Vpm05pmNjfsGPalFyOmZmZmdkbSS9cKbtzhxMAAAAASUVORK5CYII=" width="18.4px" height="18.4px" alt="unchecked" aria-roledescription="checkbox" style="margin-right:3px;" /><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;display:inline-block;vertical-align:top;margin-top:0;" role="presentation"><span style="font-size:11.5pt;font-family:'Optimistic Text',sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">todo</span></p></li></ul><li dir="ltr" role="checkbox" aria-checked="false" style="list-style-type:none;font-size:11.5pt;font-family:'Optimistic Text',sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;" aria-level="1"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAA1ElEQVR4Ae3bMQ4BURSFYY2xBuwQ7BIkTGxFRj9Oo9RdkXn5TvL3L19u+2ZmZmZmZhVbpH26pFcaJ9IrndMudb/CWadHGiden1bll9MIzqd79SUd0thY20qga4NA50qgoUGgoRJo/NL/V/N+QIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIEyFeEZyXQpUGgUyXQrkGgTSVQl/qGcG5pnkq3Sn0jOMv0k3Vpm05pmNjfsGPalFyOmZmZmdkbSS9cKbtzhxMAAAAASUVORK5CYII=" width="18.4px" height="18.4px" alt="unchecked" aria-roledescription="checkbox" style="margin-right:3px;" /><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;display:inline-block;vertical-align:top;margin-top:0;" role="presentation"><span style="font-size:11.5pt;font-family:'Optimistic Text',sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">todo</span></p></li></ul></b>`,
        },
        {
          expectedHTML: `<p dir="auto" style="text-align: start;"><span data-lexical-text="true">checklist</span></p><ul dir="auto"><li role="checkbox" tabindex="-1" aria-checked="true" style="text-align: start;"><span data-lexical-text="true">done</span></li><li role="checkbox" tabindex="-1" aria-checked="false" style="text-align: start;"><span data-lexical-text="true">todo</span></li></ul>`,
          name: 'github checklist',
          pastedHTML: `<meta charset='utf-8'><p dir="auto" style="box-sizing: border-box; margin-top: 0px !important; margin-bottom: 16px; color: rgb(31, 35, 40); font-family: -apple-system, &quot;system-ui&quot;, &quot;Segoe UI&quot;, &quot;Noto Sans&quot;, Helvetica, Arial, sans-serif, &quot;Apple Color Emoji&quot;, &quot;Segoe UI Emoji&quot;; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">checklist</p><ul class="contains-task-list" style="box-sizing: border-box; padding: 0px; margin-top: 0px; margin-bottom: 0px !important; position: relative; color: rgb(31, 35, 40); font-family: -apple-system, &quot;system-ui&quot;, &quot;Segoe UI&quot;, &quot;Noto Sans&quot;, Helvetica, Arial, sans-serif, &quot;Apple Color Emoji&quot;, &quot;Segoe UI Emoji&quot;; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;"><li class="task-list-item enabled" style="box-sizing: border-box; list-style-type: none; padding: 2px 15px 2px 42px; margin-right: -15px; margin-left: -15px; line-height: 1.5; border: 0px;"><span class="handle" style="box-sizing: border-box; display: block; float: left; width: 20px; padding: 2px 0px 0px 2px; margin-left: -43px; opacity: 0;"><svg class="drag-handle" aria-hidden="true" width="16" height="16"><path d="M10 13a1 1 0 100-2 1 1 0 000 2zm-4 0a1 1 0 100-2 1 1 0 000 2zm1-5a1 1 0 11-2 0 1 1 0 012 0zm3 1a1 1 0 100-2 1 1 0 000 2zm1-5a1 1 0 11-2 0 1 1 0 012 0zM6 5a1 1 0 100-2 1 1 0 000 2z"></path></svg></span><input type="checkbox" id="" class="task-list-item-checkbox" checked="" style="box-sizing: border-box; font: inherit; margin: 0px 0.2em 0.25em -1.4em; overflow: visible; padding: 0px; vertical-align: middle;"><span></span>done</li><li class="task-list-item enabled" style="box-sizing: border-box; list-style-type: none; margin-top: 0px; padding: 2px 15px 2px 42px; margin-right: -15px; margin-left: -15px; line-height: 1.5; border: 0px;"><span class="handle" style="box-sizing: border-box; display: block; float: left; width: 20px; padding: 2px 0px 0px 2px; margin-left: -43px; opacity: 0;"><svg class="drag-handle" aria-hidden="true" width="16" height="16"><path d="M10 13a1 1 0 100-2 1 1 0 000 2zm-4 0a1 1 0 100-2 1 1 0 000 2zm1-5a1 1 0 11-2 0 1 1 0 012 0zm3 1a1 1 0 100-2 1 1 0 000 2zm1-5a1 1 0 11-2 0 1 1 0 012 0zM6 5a1 1 0 100-2 1 1 0 000 2z"></path></svg></span><input type="checkbox" id="" class="task-list-item-checkbox" style="box-sizing: border-box; font: inherit; margin: 0px 0.2em 0.25em -1.4em; overflow: visible; padding: 0px; vertical-align: middle;"><span></span>todo</li></ul>`,
        },
        {
          expectedHTML: `<ul dir="auto"><li role="checkbox" tabindex="-1" aria-checked="true"><span data-lexical-text="true">Milk</span></li><li role="checkbox" tabindex="-1" aria-checked="false"><span data-lexical-text="true">Eggs</span></li><li role="checkbox" tabindex="-1" aria-checked="true"><span data-lexical-text="true">Beer</span></li></ul>`,
          name: 'joplin checklist',
          pastedHTML: `<ul data-is-checklist="1"><li class="md-checkbox joplin-checkbox"><div class="checkbox-wrapper"><input type="checkbox" id="md-checkbox-0" checked="checked"><label id="cb-label-md-checkbox-0" for="md-checkbox-0" class="checkbox-label-checked">Milk</label></div></li><li class="md-checkbox joplin-checkbox"><div class="checkbox-wrapper"><input type="checkbox" id="md-checkbox-1"><label id="cb-label-md-checkbox-1" for="md-checkbox-1" class="checkbox-label-unchecked">Eggs</label></div></li><li class="md-checkbox joplin-checkbox"><div class="checkbox-wrapper"><input type="checkbox" id="md-checkbox-2" checked="checked"><label id="cb-label-md-checkbox-2" for="md-checkbox-2" class="checkbox-label-checked">Beer</label></div></li></ul>`,
        },
        {
          expectedHTML: `<p dir="auto"><strong class="editor-text-bold" data-lexical-text="true">hello world</strong></p>`,
          name: 'pasting inheritance',
          pastedHTML: `<strong>hello</strong>`,
          plainTextInsert: ' world',
        },
        {
          expectedHTML: `<p dir="auto"><span data-lexical-text="true">hello world</span></p>`,
          name: 'div with display:inline should not insert linebreaks',
          pastedHTML: `<div><div style="display: inline;">hello</div> <div style="display: inline;">world</div></div>`,
        },
        {
          expectedHTML: `<code spellcheck="false" dir="auto"><span data-lexical-text="true">❯ cd ~/src/lexical</span></code>`,
          name: 'Ghostty terminal paste with inline divs',
          pastedHTML: `<div style="font-family: monospace; white-space: pre;"><div style="display: inline;color: rgb(181, 189, 104);font-weight: bold;">&#10095;</div> cd ~/src/lexical</div>`,
        },
      ];

      HTML_COPY_PASTING_TESTS.forEach((testCase, i) => {
        test(`HTML copy paste: ${testCase.name}`, async () => {
          const {editor} = testEnv;

          const dataTransfer = new DataTransfer();
          dataTransfer.setData('text/html', testCase.pastedHTML);
          await editor.update(() => {
            const selection = $getSelection();
            invariant(
              $isRangeSelection(selection),
              'isRangeSelection(selection)',
            );
            $insertDataTransferForRichText(dataTransfer, selection, editor);
            if (testCase.plainTextInsert) {
              const newSelection = $getSelection();
              invariant(
                $isRangeSelection(newSelection),
                'isRangeSelection(newSelection) for plainTextInsert',
              );
              newSelection.insertText(testCase.plainTextInsert);
            }
          });
          expect(testEnv.innerHTML).toBe(testCase.expectedHTML);
        });
      });

      test('iOS fix: Word predictions should be handled as plain text to maintain selection formatting', async () => {
        const {editor} = testEnv;

        const dataTransfer = new DataTransfer();

        // we simulate choosing an iOS Safari `autocorrect` or `word prediction`
        // which pastes the word into the editor with both the `text/plain` and `text/html` data types
        dataTransfer.setData('text/plain', 'Prediction');
        dataTransfer.setData('text/html', 'Prediction');

        // to compensate, the clipboard content will only be inserted as HTML if the `text/html` content differs from the `text/plain` content
        await editor.update(() => {
          const selection = $getSelection();
          invariant(
            $isRangeSelection(selection),
            'isRangeSelection(selection)',
          );
          $patchStyleText(selection, {
            'background-color': 'rgb(255,170,45)',
          });
          $insertDataTransferForRichText(dataTransfer, selection, editor);
        });

        // the editor's selection formatting is maintained because the text has been inserted as plain text
        expect(testEnv.innerHTML).toBe(
          '<p dir="auto"><span style="background-color: rgb(255, 170, 45);" data-lexical-text="true">Prediction</span></p>',
        );
      });
    },
    {
      namespace: 'test',
      theme: {
        text: {
          bold: 'editor-text-bold',
          italic: 'editor-text-italic',
          underline: 'editor-text-underline',
        },
      },
    },
  );
});
