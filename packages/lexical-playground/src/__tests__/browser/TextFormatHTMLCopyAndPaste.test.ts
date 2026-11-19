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
  setupPasteEditor,
} from './htmlPasteUtils';
import {html} from './utils';

test('Copy + paste html with BIU formatting', async () => {
  const {root} = setupPasteEditor();

  const clipboardData = {
    'text/html': `<meta charset='utf-8'><meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-d6ac4fde-7fff-3941-b4d9-3903abcccdcb"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:700;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Bold</span></p><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:italic;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Italic</span></p><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:underline;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">underline</span></p><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:700;font-style:italic;font-variant:normal;text-decoration:underline;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Bold Italic Underline</span></p></b><br class="Apple-interchange-newline">`,
  };
  await pasteFromClipboard(root, clipboardData);
  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
        <strong
          class="PlaygroundEditorTheme__textBold"
          style="font-size: 11pt"
          data-lexical-text="true">
          Bold
        </strong>
      </p>
      <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
        <em
          class="PlaygroundEditorTheme__textItalic"
          style="font-size: 11pt"
          data-lexical-text="true">
          Italic
        </em>
      </p>
      <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
        <span
          class="PlaygroundEditorTheme__textUnderline"
          style="font-size: 11pt"
          data-lexical-text="true">
          underline
        </span>
      </p>
      <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
        <strong
          class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic
           PlaygroundEditorTheme__textUnderline"
          style="font-size: 11pt"
          data-lexical-text="true">
          Bold Italic Underline
        </strong>
      </p>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <br data-lexical-managed-linebreak="true" />
      </p>
    `,
  );
});

test('Copy + paste html with highlight formatting', async () => {
  const {root} = setupPasteEditor();

  const clipboardData = {
    'text/html': `<meta charset='utf-8'><p><b>Bold</b><mark>Highlight</mark><b><mark>Bold&amp;Highlight</mark></b></p>`,
  };
  await pasteFromClipboard(root, clipboardData);
  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <strong
          class="PlaygroundEditorTheme__textBold"
          data-lexical-text="true">
          Bold
        </strong>
        <mark data-lexical-text="true">
          <span class="PlaygroundEditorTheme__textHighlight">Highlight</span>
        </mark>
        <mark data-lexical-text="true">
          <strong
            class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textHighlight">
            Bold&amp;Highlight
          </strong>
        </mark>
      </p>
    `,
  );
});
