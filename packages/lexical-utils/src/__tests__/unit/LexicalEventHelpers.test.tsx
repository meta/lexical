/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from 'lexical';

import {CodeHighlightNode, CodeNode} from '@lexical/code';
import {HashtagNode} from '@lexical/hashtag';
import {AutoLinkNode, LinkNode} from '@lexical/link';
import {ListItemNode, ListNode} from '@lexical/list';
import {OverflowNode} from '@lexical/overflow';
import {AutoFocusPlugin} from '@lexical/react/LexicalAutoFocusPlugin';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {HeadingNode, QuoteNode} from '@lexical/rich-text';
import {
  applySelectionInputs,
  pasteHTML,
} from '@lexical/selection/src/__tests__/utils';
import {TableCellNode, TableNode, TableRowNode} from '@lexical/table';
import {initializeClipboard, TestComposer} from 'lexical/src/__tests__/utils';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

Range.prototype.getBoundingClientRect = function (): DOMRect {
  const rect = {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
  };
  return {
    ...rect,
    toJSON() {
      return rect;
    },
  };
};

initializeClipboard();

Range.prototype.getBoundingClientRect = function (): DOMRect {
  const rect = {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
  };
  return {
    ...rect,
    toJSON() {
      return rect;
    },
  };
};

describe('LexicalEventHelpers', () => {
  let container: HTMLDivElement | null = null;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    await init();
  });

  afterEach(() => {
    document.body.removeChild(container!);
    container = null;
  });

  let editor: LexicalEditor | null = null;

  async function init() {
    function TestBase() {
      function TestPlugin(): null {
        [editor] = useLexicalComposerContext();

        return null;
      }

      return (
        <TestComposer
          config={{
            nodes: [
              LinkNode,
              HeadingNode,
              ListNode,
              ListItemNode,
              QuoteNode,
              CodeNode,
              TableNode,
              TableCellNode,
              TableRowNode,
              HashtagNode,
              CodeHighlightNode,
              AutoLinkNode,
              OverflowNode,
            ],
            theme: {
              code: 'editor-code',
              heading: {
                h1: 'editor-heading-h1',
                h2: 'editor-heading-h2',
                h3: 'editor-heading-h3',
                h4: 'editor-heading-h4',
                h5: 'editor-heading-h5',
                h6: 'editor-heading-h6',
              },
              image: 'editor-image',
              list: {
                listitem: 'editor-listitem',
                olDepth: ['editor-list-ol'],
                ulDepth: ['editor-list-ul'],
              },
              paragraph: 'editor-paragraph',
              placeholder: 'editor-placeholder',
              quote: 'editor-quote',
              text: {
                bold: 'editor-text-bold',
                code: 'editor-text-code',
                hashtag: 'editor-text-hashtag',
                italic: 'editor-text-italic',
                link: 'editor-text-link',
                strikethrough: 'editor-text-strikethrough',
                underline: 'editor-text-underline',
                underlineStrikethrough: 'editor-text-underlineStrikethrough',
              },
            },
          }}>
          <RichTextPlugin
            contentEditable={
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              <ContentEditable role={null as any} spellCheck={null as any} />
            }
            placeholder={null}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <AutoFocusPlugin />
          <TestPlugin />
        </TestComposer>
      );
    }

    act(() => {
      createRoot(container!).render(<TestBase />);
    });
  }

  async function update(fn: () => void) {
    await act(async () => {
      await editor!.update(fn);
    });

    return Promise.resolve().then();
  }

  test('Expect initial output to be a block with no text', () => {
    expect(container!.innerHTML).toBe(
      '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><br data-lexical-managed-linebreak="true"></p></div>',
    );
  });

  describe('onPasteForRichText', () => {
    describe('baseline', () => {
      const suite = [
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><h1 class="editor-heading-h1" dir="auto"><span data-lexical-text="true">Hello</span></h1></div>',
          inputs: [pasteHTML(`<meta charset='utf-8'><h1>Hello</h1>`)],
          name: 'should produce the correct editor state from a pasted HTML h1 element',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><h2 class="editor-heading-h2" dir="auto"><span data-lexical-text="true">From</span></h2></div>',
          inputs: [pasteHTML(`<meta charset='utf-8'><h2>From</h2>`)],
          name: 'should produce the correct editor state from a pasted HTML h2 element',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><h3 class="editor-heading-h3" dir="auto"><span data-lexical-text="true">The</span></h3></div>',
          inputs: [pasteHTML(`<meta charset='utf-8'><h3>The</h3>`)],
          name: 'should produce the correct editor state from a pasted HTML h3 element',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><ul class="editor-list-ul" dir="auto"><li class="editor-listitem"><span data-lexical-text="true">Other side</span></li><li class="editor-listitem"><span data-lexical-text="true">I must have called</span></li></ul></div>',
          inputs: [
            pasteHTML(
              `<meta charset='utf-8'><ul><li>Other side</li><li>I must have called</li></ul>`,
            ),
          ],
          name: 'should produce the correct editor state from a pasted HTML ul element',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><ol class="editor-list-ol" dir="auto"><li class="editor-listitem"><span data-lexical-text="true">To tell you</span></li><li class="editor-listitem"><span data-lexical-text="true">I’m sorry</span></li></ol></div>',
          inputs: [
            pasteHTML(
              `<meta charset='utf-8'><ol><li>To tell you</li><li>I’m sorry</li></ol>`,
            ),
          ],
          name: 'should produce the correct editor state from pasted HTML ol element',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">A thousand times</span></p></div>',
          inputs: [pasteHTML(`<meta charset='utf-8'>A thousand times`)],
          name: 'should produce the correct editor state from pasted DOM Text Node',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><strong class="editor-text-bold" data-lexical-text="true">Bold</strong></p></div>',
          inputs: [pasteHTML(`<meta charset='utf-8'><b>Bold</b>`)],
          name: 'should produce the correct editor state from a pasted HTML b element',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><em class="editor-text-italic" data-lexical-text="true">Italic</em></p></div>',
          inputs: [pasteHTML(`<meta charset='utf-8'><i>Italic</i>`)],
          name: 'should produce the correct editor state from a pasted HTML i element',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><em class="editor-text-italic" data-lexical-text="true">Italic</em></p></div>',
          inputs: [pasteHTML(`<meta charset='utf-8'><em>Italic</em>`)],
          name: 'should produce the correct editor state from a pasted HTML em element',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><span class="editor-text-underline" data-lexical-text="true">Underline</span></p></div>',
          inputs: [pasteHTML(`<meta charset='utf-8'><u>Underline</u>`)],
          name: 'should produce the correct editor state from a pasted HTML u element',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><h1 class="editor-heading-h1" dir="auto"><span data-lexical-text="true">Lyrics to Hello by Adele</span></h1><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">A thousand times</span></p></div>',
          inputs: [
            pasteHTML(
              `<meta charset='utf-8'><h1>Lyrics to Hello by Adele</h1>A thousand times`,
            ),
          ],
          name: 'should produce the correct editor state from pasted heading node followed by a DOM Text Node',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><a href="https://facebook.com"><span data-lexical-text="true">Facebook</span></a></p></div>',
          inputs: [
            pasteHTML(
              `<meta charset='utf-8'><a href="https://facebook.com">Facebook</a>`,
            ),
          ],
          name: 'should produce the correct editor state from a pasted HTML anchor element',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">Welcome to</span><a href="https://facebook.com"><span data-lexical-text="true">Facebook!</span></a></p></div>',
          inputs: [
            pasteHTML(
              `<meta charset='utf-8'>Welcome to<a href="https://facebook.com">Facebook!</a>`,
            ),
          ],
          name: 'should produce the correct editor state from a pasted combination of an HTML text node followed by an anchor node',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">Welcome to</span><a href="https://facebook.com"><span data-lexical-text="true">Facebook!</span></a><span data-lexical-text="true">We hope you like it here.</span></p></div>',
          inputs: [
            pasteHTML(
              `<meta charset='utf-8'>Welcome to<a href="https://facebook.com">Facebook!</a>We hope you like it here.`,
            ),
          ],
          name: 'should produce the correct editor state from a pasted combination of HTML anchor elements and text nodes',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><ul class="editor-list-ul" dir="auto"><li class="editor-listitem"><span data-lexical-text="true">Hello</span></li><li class="editor-listitem"><span data-lexical-text="true">from the other</span></li><li class="editor-listitem"><span data-lexical-text="true">side</span></li></ul></div>',
          inputs: [
            pasteHTML(
              `<meta charset='utf-8'><doesnotexist><ul><li>Hello</li><li>from the other</li><li>side</li></ul></doesnotexist>`,
            ),
          ],
          name: 'should ignore DOM node types that do not have transformers, but still process their children.',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><ul class="editor-list-ul" dir="auto"><li class="editor-listitem"><span data-lexical-text="true">Hello</span></li><li class="editor-listitem"><span data-lexical-text="true">from the other</span></li><li class="editor-listitem"><span data-lexical-text="true">side</span></li></ul></div>',
          inputs: [
            pasteHTML(
              `<meta charset='utf-8'><doesnotexist><doesnotexist><ul><li>Hello</li><li>from the other</li><li>side</li></ul></doesnotexist></doesnotexist>`,
            ),
          ],
          name: 'should ignore multiple levels of DOM node types that do not have transformers, but still process their children.',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">Welcome to</span><a href="https://facebook.com"><strong class="editor-text-bold" data-lexical-text="true">Facebook!</strong></a><span data-lexical-text="true">We hope you like it here.</span></p></div>',
          inputs: [
            pasteHTML(
              `<meta charset='utf-8'>Welcome to<b><a href="https://facebook.com">Facebook!</a></b>We hope you like it here.`,
            ),
          ],
          name: 'should preserve formatting from HTML tags on deeply nested text nodes.',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">Welcome to</span><a href="https://facebook.com"><strong class="editor-text-bold" data-lexical-text="true">Facebook!</strong></a><strong class="editor-text-bold" data-lexical-text="true">We hope you like it here.</strong></p></div>',
          inputs: [
            pasteHTML(
              `<meta charset='utf-8'>Welcome to<b><a href="https://facebook.com">Facebook!</a>We hope you like it here.</b>`,
            ),
          ],
          name: 'should preserve formatting from HTML tags on deeply nested and top level text nodes.',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">Welcome to</span><a href="https://facebook.com"><strong class="editor-text-bold editor-text-italic" data-lexical-text="true">Facebook!</strong></a><strong class="editor-text-bold editor-text-italic" data-lexical-text="true">We hope you like it here.</strong></p></div>',
          inputs: [
            pasteHTML(
              `<meta charset='utf-8'>Welcome to<b><i><a href="https://facebook.com">Facebook!</a>We hope you like it here.</i></b>`,
            ),
          ],
          name: 'should preserve multiple types of formatting on deeply nested text nodes and top level text nodes',
        },
      ];

      suite.forEach((testUnit, i) => {
        const name = testUnit.name || 'Test case';

        test(name + ` (#${i + 1})`, async () => {
          await applySelectionInputs(testUnit.inputs, update, editor!);

          // Validate HTML matches
          expect(container!.innerHTML).toBe(testUnit.expectedHTML);
        });
      });
    });

    describe('Google Docs', () => {
      const suite = [
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">Get schwifty!</span></p></div>',
          inputs: [
            pasteHTML(
              `<b style="font-weight:normal;" id="docs-internal-guid-2c706577-7fff-f54a-fe65-12f480020fac"><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Get schwifty!</span></b>`,
            ),
          ],
          name: 'should produce the correct editor state from Normal text',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><strong class="editor-text-bold" data-lexical-text="true">Get schwifty!</strong></p></div>',
          inputs: [
            pasteHTML(
              `<b style="font-weight:normal;" id="docs-internal-guid-9db03964-7fff-c26c-8b1e-9484fb3b54a4"><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:700;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Get schwifty!</span></b>`,
            ),
          ],
          name: 'should produce the correct editor state from bold text',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><em class="editor-text-italic" data-lexical-text="true">Get schwifty!</em></p></div>',
          inputs: [
            pasteHTML(
              `<b style="font-weight:normal;" id="docs-internal-guid-9db03964-7fff-c26c-8b1e-9484fb3b54a4"><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:italic;font-variant:normal;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Get schwifty!</span></b>`,
            ),
          ],
          name: 'should produce the correct editor state from italic text',
        },
        {
          expectedHTML:
            '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p class="editor-paragraph" dir="auto"><span class="editor-text-strikethrough" data-lexical-text="true">Get schwifty!</span></p></div>',
          inputs: [
            pasteHTML(
              `<b style="font-weight:normal;" id="docs-internal-guid-9db03964-7fff-c26c-8b1e-9484fb3b54a4"><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:line-through;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Get schwifty!</span></b>`,
            ),
          ],
          name: 'should produce the correct editor state from strikethrough text',
        },
      ];

      suite.forEach((testUnit, i) => {
        const name = testUnit.name || 'Test case';

        test(name + ` (#${i + 1})`, async () => {
          await applySelectionInputs(testUnit.inputs, update, editor!);

          // Validate HTML matches
          expect(container!.innerHTML).toBe(testUnit.expectedHTML);
        });
      });
    });

    describe('W3 spacing', () => {
      const suite = [
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">hello world</span></p>',
          inputs: [pasteHTML('<span>hello world</span>')],
          name: 'inline hello world',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">hello world</span></p>',
          inputs: [pasteHTML('<span>    hello  </span>world  ')],
          name: 'inline hello world (2)',
        },
        {
          // MS Office got it right
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true"> hello world</span></p>',
          inputs: [
            pasteHTML(' <span style="white-space: pre"> hello </span> world  '),
          ],
          name: 'pre + inline (inline collapses with pre)',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">  a b</span><span data-lexical-text="true">\t</span><span data-lexical-text="true">c  </span></p>',
          inputs: [pasteHTML('<p style="white-space: pre">  a b\tc  </p>')],
          name: 'white-space: pre (1) (no touchy)',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">a b c</span></p>',
          inputs: [pasteHTML('<p>\ta\tb  <span>c\t</span>\t</p>')],
          name: 'tabs are collapsed',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">hello world</span></p>',
          inputs: [
            pasteHTML(`
              <div>
                hello
                world
              </div>
            `),
          ],
          name: 'remove beginning + end spaces on the block',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><strong class="editor-text-bold" data-lexical-text="true">hello world</strong></p>',
          inputs: [
            pasteHTML(`
              <div>
                <strong>
                  hello
                  world
                </strong>
              </div>
          `),
          ],
          name: 'remove beginning + end spaces on the block (2)',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">a </span><strong class="editor-text-bold" data-lexical-text="true">b</strong><span data-lexical-text="true"> c</span></p>',
          inputs: [
            pasteHTML(`
              <div>
                a
                <strong>b</strong>
                c
              </div>
          `),
          ],
          name: 'remove beginning + end spaces on the block + anonymous inlines collapsible rules',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><strong class="editor-text-bold" data-lexical-text="true">a </strong><span data-lexical-text="true">b</span></p>',
          inputs: [pasteHTML('<div><strong>a </strong>b</div>')],
          name: 'collapsibles and neighbors (1)',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">a</span><strong class="editor-text-bold" data-lexical-text="true"> b</strong></p>',
          inputs: [pasteHTML('<div>a<strong> b</strong></div>')],
          name: 'collapsibles and neighbors (2)',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><strong class="editor-text-bold" data-lexical-text="true">a </strong><span data-lexical-text="true">b</span></p>',
          inputs: [pasteHTML('<div><strong>a </strong><span></span>b</div>')],
          name: 'collapsibles and neighbors (3)',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">a</span><strong class="editor-text-bold" data-lexical-text="true"> b</strong></p>',
          inputs: [pasteHTML('<div>a<span></span><strong> b</strong></div>')],
          name: 'collapsibles and neighbors (4)',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><br data-lexical-managed-linebreak="true"></p>',
          inputs: [
            pasteHTML(`
              <p>
              </p>
          `),
          ],
          name: 'empty block',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">a</span></p>',
          inputs: [pasteHTML('<span> </span><span>a</span>')],
          name: 'redundant inline at start',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">a</span></p>',
          inputs: [pasteHTML('<span>a</span><span> </span>')],
          name: 'redundant inline at end',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">a</span></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">b</span></p>',
          inputs: [
            pasteHTML(`
            <div>
              <p>
                a
              </p>
              <p>
                b
              </p>
            </div>
            `),
          ],
          name: 'collapsible spaces with nested structures',
        },
        // TODO no proper support for divs #4465
        // {
        //   expectedHTML:
        //     '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">a</span></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">b</span></p>',
        //   inputs: [
        //     pasteHTML(`
        //     <div>
        //     <div>
        //     a
        //     </div>
        //     <div>
        //     b
        //     </div>
        //     </div>
        //     `),
        //   ],
        //   name: 'collapsible spaces with nested structures (2)',
        // },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><strong class="editor-text-bold" data-lexical-text="true">a b</strong></p>',
          inputs: [
            pasteHTML(`
            <div>
              <strong>
                a
              </strong>
              <strong>
                b
              </strong>
            </div>
            `),
          ],
          name: 'collapsible spaces with nested structures (3)',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">a</span><br><span data-lexical-text="true">b</span></p>',
          inputs: [
            pasteHTML(`
            <p>
            a
            <br>
            b
            </p>
            `),
          ],
          name: 'forced line break should remain',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">a</span><br><span data-lexical-text="true">b</span></p>',
          inputs: [
            pasteHTML(`
            <p>
            a
            \t<br>\t
            b
            </p>
            `),
          ],
          name: 'forced line break with tabs',
        },
        // The 3 below are not correct, they're missing the first \n -> <br> but that's a fault with
        // the implementation of DOMParser, it works correctly in Safari
        {
          expectedHTML:
            '<code class="editor-code" spellcheck="false" dir="auto"><span data-lexical-text="true">a</span><br><span data-lexical-text="true">b</span><br><br data-lexical-managed-linebreak="true"></code>',
          inputs: [pasteHTML(`<pre>\na\r\nb\r\n</pre>`)],
          name: 'pre (no touchy) (1)',
        },
        {
          expectedHTML:
            '<code class="editor-code" spellcheck="false" dir="auto"><span data-lexical-text="true">a</span><br><span data-lexical-text="true">b</span><br><br data-lexical-managed-linebreak="true"></code>',
          inputs: [
            pasteHTML(`
              <pre>\na\r\nb\r\n</pre>
          `),
          ],
          name: 'pre (no touchy) (2)',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><br><span data-lexical-text="true">a</span><br><span data-lexical-text="true">b</span><br><br data-lexical-managed-linebreak="true"></p>',
          inputs: [
            pasteHTML(`<span style="white-space: pre">\na\r\nb\r\n</span>`),
          ],
          name: 'white-space: pre (no touchy) (2)',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">paragraph1</span></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">paragraph2</span></p>',
          inputs: [
            pasteHTML(
              '\n<p class="p1">paragraph1</p>\n<p class="p1">paragraph2</p>\n',
            ),
          ],
          name: 'two Apple Notes paragraphs',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">line 1</span><br><span data-lexical-text="true">line 2</span></p><p class="editor-paragraph" dir="auto"><br data-lexical-managed-linebreak="true"></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">paragraph 1</span></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">paragraph 2</span></p>',
          inputs: [
            pasteHTML(
              '\n<p class="p1">line 1<br>\nline 2</p>\n<p class="p2"><br></p>\n<p class="p1">paragraph 1</p>\n<p class="p1">paragraph 2</p>\n',
            ),
          ],
          name: 'two Apple Notes lines + two paragraphs separated by an empty paragraph',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">line 1</span><br><span data-lexical-text="true">line 2</span></p><p class="editor-paragraph" dir="auto"><br data-lexical-managed-linebreak="true"></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">paragraph 1</span></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">paragraph 2</span></p>',
          inputs: [
            pasteHTML(
              '\n<p class="p1">line 1<br>\nline 2</p>\n<p class="p2">\n<br>\n</p>\n<p class="p1">paragraph 1</p>\n<p class="p1">paragraph 2</p>\n',
            ),
          ],
          name: 'two lines + two paragraphs separated by an empty paragraph (2)',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">line 1</span><br><span data-lexical-text="true">line 2</span></p>',
          inputs: [
            pasteHTML(
              '<p class="p1"><span>line 1</span><span><br></span><span>line 2</span></p>',
            ),
          ],
          name: 'two lines and br in spans',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">a</span></p><p class="editor-paragraph" dir="auto"><br data-lexical-managed-linebreak="true"></p>',
          inputs: [pasteHTML('<p>a</p><br>')],
          name: 'lone trailing block-level br collapses to an empty paragraph',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">a</span></p><p class="editor-paragraph" dir="auto"><br data-lexical-managed-linebreak="true"></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">b</span></p>',
          inputs: [pasteHTML('<p>a</p><br><p>b</p>')],
          name: 'lone block-level br between paragraphs collapses to an empty paragraph',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><br><span data-lexical-text="true">a</span></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">b</span></p>',
          inputs: [pasteHTML('<br>a<p>b</p>')],
          name: 'block-level br followed by inline content is preserved',
        },
        {
          expectedHTML:
            '<ol class="editor-list-ol" dir="auto"><li class="editor-listitem"><span data-lexical-text="true">1</span><br><span data-lexical-text="true">2</span></li><li class="editor-listitem"><br data-lexical-managed-linebreak="true"></li><li class="editor-listitem"><span data-lexical-text="true">3</span></li></ol>',
          inputs: [
            pasteHTML('<ol><li>1<div></div>2</li><li></li><li>3</li></ol>'),
          ],
          name: 'empty block node in li behaves like a line break',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">1</span><br><span data-lexical-text="true">2</span></p>',
          inputs: [pasteHTML('<div>1<div></div>2</div>')],
          name: 'empty block node in div behaves like a line break',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">12</span></p>',
          inputs: [pasteHTML('<div>1<text></text>2</div>')],
          name: 'empty inline node does not behave like a line break',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">1</span></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">2</span></p>',
          inputs: [pasteHTML('<div><div>1</div><div></div><div>2</div></div>')],
          name: 'empty block node between non inline siblings does not behave like a line break',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">a</span></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">b b</span></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">c</span></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">z</span></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">d e</span></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">fg</span></p>',
          inputs: [
            pasteHTML(
              `<div>a<div>b b<div>c<div><div></div>z</div></div>d e</div>fg</div>`,
            ),
          ],
          name: 'nested divs',
        },
        {
          expectedHTML:
            '<ol class="editor-list-ol" dir="auto"><li class="editor-listitem"><span data-lexical-text="true">1</span></li><li class="editor-listitem"><br data-lexical-managed-linebreak="true"></li><li class="editor-listitem"><span data-lexical-text="true">3</span></li></ol>',
          inputs: [pasteHTML('<ol><li>1</li><li><br /></li><li>3</li></ol>')],
          name: 'only br in a li',
        },
        {
          expectedHTML:
            '<p class="editor-paragraph" dir="auto"><span data-lexical-text="true">1</span></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">2</span></p><p class="editor-paragraph" dir="auto"><span data-lexical-text="true">3</span></p>',
          inputs: [pasteHTML('1<p>2<br /></p>3')],
          name: 'last br in a block node is ignored',
        },
      ];

      suite.forEach((testUnit, i) => {
        const name = testUnit.name || 'Test case';

        // eslint-disable-next-line no-only-tests/no-only-tests, dot-notation
        const test_ = 'only' in testUnit && testUnit['only'] ? test.only : test;
        test_(name + ` (#${i + 1})`, async () => {
          await applySelectionInputs(testUnit.inputs, update, editor!);

          // Validate HTML matches
          expect((container!.firstChild as HTMLElement).innerHTML).toBe(
            testUnit.expectedHTML,
          );
        });
      });
    });
  });
});
