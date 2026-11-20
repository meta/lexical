/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {registerMarkdownShortcuts} from '@lexical/markdown';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COLLABORATION_TAG,
  defineExtension,
  getNearestEditorFromDOMNode,
  HISTORIC_TAG,
  IS_APPLE,
  PASTE_TAG,
} from 'lexical';
import {describe, expect, onTestFinished, test, vi} from 'vitest';
import {userEvent} from 'vitest/browser';

import {MarkdownTestExtension} from '../utils';

const extension = defineExtension({
  dependencies: [MarkdownTestExtension, HistoryExtension],
  name: 'MarkdownShortcutsBrowserTest',
  register: editor => registerMarkdownShortcuts(editor),
});

function setup() {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  root.style.whiteSpace = 'pre-wrap';
  document.body.append(root);
  const editor = buildEditorFromExtensions(extension);
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
    window.getSelection()?.removeAllRanges();
  });
  editor.update(
    () => {
      $getRoot().clear().append($createParagraphNode());
      $getRoot().selectEnd();
    },
    {discrete: true},
  );
  window.focus();
  root.focus();
  return root;
}

function paste(root: HTMLElement, text: string) {
  const clipboardData = new DataTransfer();
  clipboardData.setData('text/plain', text);
  const event = new ClipboardEvent('paste', {bubbles: true, cancelable: true});
  // Firefox does not expose data passed to the ClipboardEvent constructor.
  Object.defineProperty(event, 'clipboardData', {value: clipboardData});
  root.dispatchEvent(event);
  if (!event.defaultPrevented) {
    const input = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertFromPaste',
    });
    Object.defineProperty(input, 'dataTransfer', {value: clipboardData});
    root.dispatchEvent(input);
  }
}

const cases = [
  {
    html: '<h3 dir="auto"><br data-lexical-managed-linebreak="true" /></h3>',
    text: '### ',
  },
  {
    html: '<h4 dir="auto"><br data-lexical-managed-linebreak="true" /></h4>',
    text: '#### ',
  },
  {
    html: '<h5 dir="auto"><br data-lexical-managed-linebreak="true" /></h5>',
    text: '##### ',
  },
  {
    html: '<h6 dir="auto"><br data-lexical-managed-linebreak="true" /></h6>',
    text: '###### ',
  },
  {
    html: '<blockquote dir="auto"><br data-lexical-managed-linebreak="true" /></blockquote>',
    text: '> ',
  },
  {
    html: `
        <h1 dir="auto"><br data-lexical-managed-linebreak="true" /></h1>
      `,
    text: '# ',
  },
  {
    html: `
        <h2 dir="auto"><br data-lexical-managed-linebreak="true" /></h2>
      `,
    text: '## ',
  },
  {
    html: `
        <ol dir="auto">
          <li value="1"><br data-lexical-managed-linebreak="true" /></li>
        </ol>
      `,
    text: '1. ',
  },
  {
    html: `
        <ol start="25" dir="auto">
          <li value="25"><br data-lexical-managed-linebreak="true" /></li>
        </ol>
      `,
    text: '25. ',
  },
  {
    html: `
        <ol dir="auto">
          <li value="1">
            <ol>
              <li value="1"><br data-lexical-managed-linebreak="true" /></li>
            </ol>
          </li>
        </ol>
      `,
    text: '    1. ',
  },
  {
    html: `
        <ul dir="auto">
          <li value="1"><br data-lexical-managed-linebreak="true" /></li>
        </ul>
      `,
    text: '- ',
  },
  {
    html: `
        <ul dir="auto">
          <li value="1">
            <ul>
              <li value="1"><br data-lexical-managed-linebreak="true" /></li>
            </ul>
          </li>
        </ul>
      `,
    text: '    - ',
  },
  {
    html: `
        <ul dir="auto">
          <li value="1"><br data-lexical-managed-linebreak="true" /></li>
        </ul>
      `,
    text: '* ',
  },
  {
    html: `
        <ul dir="auto">
          <li value="1">
            <ul>
              <li value="1"><br data-lexical-managed-linebreak="true" /></li>
            </ul>
          </li>
        </ul>
      `,
    text: '    * ',
  },
  {
    html: `
        <ul dir="auto">
          <li value="1">
            <ul>
              <li value="1"><br data-lexical-managed-linebreak="true" /></li>
            </ul>
          </li>
        </ul>
      `,
    text: '      * ',
  },
  {
    html: `
        <ul dir="auto">
          <li value="1">
            <ul>
              <li value="1">
                <ul>
                  <li value="1">
                    <br data-lexical-managed-linebreak="true" />
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      `,
    text: '        * ',
  },
];

// Match the e2e HTML assertions' whitespace-insensitive formatting while
// retaining node types, nesting, list numbers and managed line breaks.
function normalizeHTML(html: string) {
  const template = document.createElement('template');
  template.innerHTML = html.replace(/>\s+</g, '><').trim();
  return template.innerHTML;
}

describe('native Markdown block shortcuts', () => {
  test.each(cases)('types, undoes and redoes $text', async ({text, html}) => {
    const root = setup();
    const expected = normalizeHTML(html);
    await userEvent.keyboard(text);
    await expect.poll(() => root.innerHTML).toBe(expected);
    await userEvent.keyboard('{ControlOrMeta>}z{/ControlOrMeta}');
    await expect
      .poll(() => root.innerHTML)
      .toBe(
        '<p dir="auto"><span data-lexical-text="true">' +
          text.replaceAll('>', '&gt;') +
          '</span></p>',
      );
    await userEvent.keyboard(
      IS_APPLE ? '{Meta>}{Shift>}z{/Shift}{/Meta}' : '{Control>}y{/Control}',
    );
    await expect.poll(() => root.innerHTML).toBe(expected);
  });
});

describe('native multi-character Markdown input', () => {
  test.each([
    {selector: 'ul', text: '- '},
    {selector: 'h1', text: '# '},
    {selector: 'strong', text: '**bold**'},
  ])('converts $text inserted in one input event', async ({text, selector}) => {
    const root = setup();
    document.execCommand('insertText', false, text);
    await expect.poll(() => root.querySelector(selector) !== null).toBe(true);
  });

  test('converts a shortcut completed by a multi-character input', async () => {
    const root = setup();
    await userEvent.keyboard('**bol');
    document.execCommand('insertText', false, 'd**');
    await expect
      .poll(() => root.querySelector('strong')?.textContent)
      .toBe('bold');
  });

  test('converts replacement text that completes a shortcut', async () => {
    const root = setup();
    await userEvent.keyboard('word{ControlOrMeta>}a{/ControlOrMeta}');
    root.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: '**bold**',
        inputType: 'insertReplacementText',
      }),
    );
    await expect
      .poll(() => root.querySelector('strong')?.textContent)
      .toBe('bold');
  });

  test('leaves pasted Markdown literal', async () => {
    const root = setup();
    paste(root, '**bold**');
    await expect.poll(() => root.textContent).toBe('**bold**');
    expect(root.querySelector('strong')).toBeNull();
  });

  test('leaves a pasted single-character trigger literal', async () => {
    const root = setup();
    await userEvent.keyboard('#');
    paste(root, ' ');
    await expect.poll(() => root.textContent).toBe('# ');
    expect(root.querySelector('h1')).toBeNull();
  });

  test.each([undefined, PASTE_TAG, HISTORIC_TAG, COLLABORATION_TAG])(
    'leaves a multi-character programmatic update literal (tag %s)',
    async tag => {
      const root = setup();
      const editor = getNearestEditorFromDOMNode(root)!;
      editor.update(
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText('**bold**');
          }
        },
        {discrete: true, tag},
      );
      await expect.poll(() => root.textContent).toBe('**bold**');
      expect(root.querySelector('strong')).toBeNull();
    },
  );
});

// An input listener that runs before the editor's (React registers a
// capture-phase one on its root container) lets the mutation observer report
// the text the browser inserted before the editor's input listener reads it.
// On a busy machine the text entry is more than 100ms old by then, which the
// observer took for text that something else changed: it read the text back,
// the shortcut ran, and the input listener inserted the last character again,
// into the new block.
describe('native Markdown shortcuts on a busy machine', () => {
  test.each([
    {
      html: '<h1 dir="auto"><br data-lexical-managed-linebreak="true" /></h1>',
      text: '# ',
    },
    {
      html: '<code spellcheck="false" dir="auto"><br data-lexical-managed-linebreak="true" /></code>',
      text: '``` ',
    },
    {
      html: '<p dir="auto"><em data-lexical-text="true">hi</em></p>',
      text: '*hi*',
    },
  ])('types $text', async ({text, html}) => {
    const root = setup();
    // As on a busy machine, the input event comes 150ms after the text entry:
    // the clock runs 150ms ahead from a capture-phase input listener above
    // the root until a listener after the editor's.
    let lag = 0;
    const now = performance.now.bind(performance);
    const clock = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => now() + lag);
    const controller = new AbortController();
    onTestFinished(() => {
      controller.abort();
      clock.mockRestore();
    });
    const {signal} = controller;
    document.body.addEventListener('input', () => (lag = 150), {
      capture: true,
      signal,
    });
    root.addEventListener('input', () => (lag = 0), {signal});
    await userEvent.keyboard(text);
    await expect.poll(() => root.innerHTML).toBe(normalizeHTML(html));
  });
});
