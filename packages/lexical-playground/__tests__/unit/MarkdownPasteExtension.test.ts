/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode, CodeNode} from '@lexical/code-core';
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {LinkNode} from '@lexical/link';
import {ListItemNode, ListNode} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  configExtension,
  defineExtension,
  type ElementNode,
  KEY_DOWN_COMMAND,
  KEY_ESCAPE_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  PASTE_COMMAND,
  UNDO_COMMAND,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {
  CONVERT_PASTED_MARKDOWN_COMMAND,
  DISMISS_PASTED_MARKDOWN_COMMAND,
  looksLikeMarkdown,
  type MarkdownPasteConfig,
  MarkdownPasteExtension,
} from '../../src/plugins/MarkdownPasteExtension';

const MARKDOWN = [
  '# Heading',
  '',
  'Some **bold** and [a link](https://lexical.dev)',
  '',
  '- one',
  '- two',
  '',
  '> quote',
  '',
  '```js',
  'const x = 1;',
  '```',
].join('\n');

const CONVERTED = [
  ['heading', 'Heading'],
  ['paragraph', 'Some bold and a link'],
  ['list', 'one\n\ntwo'],
  ['quote', 'quote'],
  ['code', 'const x = 1;'],
];

function createEditor(
  config: Partial<MarkdownPasteConfig> = {},
  {withAllNodes = true} = {},
): LexicalEditor {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      dependencies: [
        RichTextExtension,
        configExtension(HistoryExtension, {delay: 0}),
        configExtension(MarkdownPasteExtension, config),
      ],
      name: 'test',
      nodes: withAllNodes ? [CodeNode, LinkNode, ListItemNode, ListNode] : [],
    }),
  );
}

function getOffer(editor: LexicalEditor) {
  return getExtensionDependencyFromEditor(editor, MarkdownPasteExtension).output
    .offer;
}

function paste(editor: LexicalEditor, data: Record<string, string>): void {
  const clipboardData = new DataTransfer();
  for (const [type, value] of Object.entries(data)) {
    clipboardData.setData(type, value);
  }
  editor.dispatchCommand(
    PASTE_COMMAND,
    new ClipboardEvent('paste', {clipboardData}),
  );
  // The rich text paste handler imports in an update of its own.
  editor.read(() => {});
}

function convert(editor: LexicalEditor): boolean {
  let handled = false;
  editor.update(
    () => {
      handled = editor.dispatchCommand(
        CONVERT_PASTED_MARKDOWN_COMMAND,
        undefined,
      );
    },
    {discrete: true},
  );
  return handled;
}

function describeNode(node: LexicalNode): [string, string] {
  return [node.getType(), node.getTextContent()];
}

function describeRoot(editor: LexicalEditor): [string, string][] {
  return editor.read(() => $getRoot().getChildren().map(describeNode));
}

function setUp(editor: LexicalEditor, $fn: () => void): void {
  editor.update($fn, {discrete: true});
}

describe('looksLikeMarkdown', () => {
  test.each([
    '# Heading',
    '> quoted',
    '- one\n- two',
    '1. one\n2. two',
    '```\ncode\n```',
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '| a | b |\n| --- | :--: |',
    '| a | b |\n|-|-|',
    '| a |\n| --- |',
    '  | a | b |\n  | --- | --- |  ',
    '**bold** and *italic*',
    'see [docs](https://lexical.dev) and `code`',
    '~~old~~ __new__',
  ])('%j looks like Markdown', text => {
    expect(looksLikeMarkdown(text)).toBe(true);
  });

  test.each([
    'plain words',
    '#hashtag and more',
    '1. just one numbered line',
    '- a single dash item',
    '5 * 3 = 15',
    'a snake_case_name and another_one',
    'one **bold** word',
    '```',
    '| --- |',
    '|-|-|',
    '| a | b |\n||',
    '| a | b |\n| |',
    'not a table\n| --- | --- |',
  ])('%j does not look like Markdown', text => {
    expect(looksLikeMarkdown(text)).toBe(false);
  });
});

describe('looksLikeMarkdown on long lines', () => {
  test.each([
    ['unclosed link text', '['.repeat(200_000)],
    ['unclosed link destinations', '[a]('.repeat(50_000)],
    ['spaces after a table row', `| --- | ---${' '.repeat(200_000)}x`],
    ['a long delimiter row', `| a |\n|${'-'.repeat(200_000)}x`],
  ])('%s stays linear', (_name, text) => {
    const start = performance.now();
    expect(looksLikeMarkdown(text)).toBe(false);
    // A quadratic scan takes tens of seconds at this size.
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('MarkdownPasteExtension', () => {
  test('pastes Markdown literally and offers to convert it', () => {
    const editor = createEditor();
    paste(editor, {'text/plain': MARKDOWN});
    expect(describeRoot(editor)[0]).toEqual(['paragraph', '# Heading']);
    expect(getOffer(editor).peek()).toMatchObject({markdown: MARKDOWN});

    expect(convert(editor)).toBe(true);
    expect(getOffer(editor).peek()).toBe(null);
    expect(describeRoot(editor)).toEqual(CONVERTED);
    editor.read(() => {
      const paragraph = $getRoot().getChildAtIndex<ElementNode>(1)!;
      const [, bold, , link] = paragraph.getChildren();
      expect($isTextNode(bold) && bold.hasFormat('bold')).toBe(true);
      expect(link.getType()).toBe('link');
    });
  });

  test('undo after converting restores the paste', () => {
    const editor = createEditor();
    paste(editor, {'text/plain': '# Heading\n\n- one\n- two'});
    const pasted = describeRoot(editor);
    convert(editor);
    expect(describeRoot(editor)).toEqual([
      ['heading', 'Heading'],
      ['list', 'one\n\ntwo'],
    ]);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(describeRoot(editor)).toEqual(pasted);
  });

  test('offers HTML pastes that show the Markdown syntax', () => {
    // Terminals and code editors put the same characters, styled, in HTML.
    const editor = createEditor();
    paste(editor, {
      'text/html':
        '<div style="color: #ccc"><span># Title</span><br><span>- **one**</span><br><span>- two</span></div>',
      'text/plain': '# Title\n- **one**\n- two',
    });
    expect(getOffer(editor).peek()).not.toBe(null);
    convert(editor);
    expect(describeRoot(editor)).toEqual([
      ['heading', 'Title'],
      ['list', 'one\n\ntwo'],
    ]);
  });

  test('replaces a code block that the HTML was pasted as', () => {
    const editor = createEditor();
    paste(editor, {
      'text/html': '<pre><code># Title\n- **one**\n- two</code></pre>',
      'text/plain': '# Title\n- **one**\n- two',
    });
    expect(describeRoot(editor)).toEqual([
      ['code', '# Title\n- **one**\n- two'],
    ]);
    expect(convert(editor)).toBe(true);
    expect(describeRoot(editor)).toEqual([
      ['heading', 'Title'],
      ['list', 'one\n\ntwo'],
    ]);
  });

  test('replaces a pasted code block without touching the text around it', () => {
    const editor = createEditor();
    setUp(editor, () => {
      const text = $createTextNode('abcd');
      $getRoot().getFirstChildOrThrow<ElementNode>().append(text);
      text.select(2, 2);
    });
    paste(editor, {
      'text/html': '<pre><code># Title\n- **one**\n- two</code></pre>',
      'text/plain': '# Title\n- **one**\n- two',
    });
    expect(describeRoot(editor)).toEqual([
      ['paragraph', 'ab'],
      ['code', '# Title\n- **one**\n- two'],
      ['paragraph', 'cd'],
    ]);
    convert(editor);
    expect(describeRoot(editor)).toEqual([
      ['paragraph', 'ab'],
      ['heading', 'Title'],
      ['list', 'one\n\ntwo'],
      ['paragraph', 'cd'],
    ]);
  });

  test('replaces the code block at the end of a mixed HTML paste', () => {
    const editor = createEditor();
    paste(editor, {
      'text/html': '<p>## Intro</p><pre><code>- **one**\n- two</code></pre>',
      'text/plain': '## Intro\n- **one**\n- two',
    });
    expect(describeRoot(editor)).toEqual([
      ['paragraph', '## Intro'],
      ['code', '- **one**\n- two'],
    ]);
    convert(editor);
    expect(describeRoot(editor)).toEqual([
      ['heading', 'Intro'],
      ['list', 'one\n\ntwo'],
    ]);
  });

  test('does not offer HTML pastes that rendered the Markdown', () => {
    const editor = createEditor();
    paste(editor, {
      'text/html': '<h1>Title</h1><ul><li><b>one</b></li><li>two</li></ul>',
      'text/plain': '# Title\n- **one**\n- two',
    });
    expect(describeRoot(editor)[0]).toEqual(['heading', 'Title']);
    expect(getOffer(editor).peek()).toBe(null);
  });

  test('converts inline Markdown pasted into the middle of text', () => {
    const editor = createEditor();
    setUp(editor, () => {
      const text = $createTextNode('before  after');
      $getRoot().getFirstChildOrThrow<ElementNode>().append(text);
      text.select(7, 7);
    });
    paste(editor, {'text/plain': '**bold** and *italic*'});
    expect(describeRoot(editor)).toEqual([
      ['paragraph', 'before **bold** and *italic* after'],
    ]);
    convert(editor);
    expect(describeRoot(editor)).toEqual([
      ['paragraph', 'before bold and italic after'],
    ]);
    editor.read(() => {
      const nodes = $getRoot()
        .getFirstChildOrThrow<ElementNode>()
        .getChildren();
      const byText = (text: string) =>
        nodes.find(node => node.getTextContent() === text);
      const bold = byText('bold');
      const italic = byText('italic');
      expect($isTextNode(bold) && bold.hasFormat('bold')).toBe(true);
      expect($isTextNode(italic) && italic.hasFormat('italic')).toBe(true);
    });
  });

  test('converts Markdown pasted at the start of text', () => {
    const editor = createEditor();
    setUp(editor, () => {
      const text = $createTextNode('after');
      $getRoot().getFirstChildOrThrow<ElementNode>().append(text);
      text.select(0, 0);
    });
    paste(editor, {'text/plain': '**bold** and *italic* '});
    convert(editor);
    expect(describeRoot(editor)).toEqual([
      ['paragraph', 'bold and italic after'],
    ]);
  });

  test('converts Markdown pasted between blocks', () => {
    const editor = createEditor();
    setUp(editor, () => {
      const root = $getRoot().clear();
      const empty = $createParagraphNode();
      root.append(
        $createParagraphNode().append($createTextNode('first')),
        empty,
        $createParagraphNode().append($createTextNode('last')),
      );
      empty.select();
    });
    paste(editor, {'text/plain': '# Heading\n\n- one\n- two'});
    convert(editor);
    expect(describeRoot(editor)).toEqual([
      ['paragraph', 'first'],
      ['heading', 'Heading'],
      ['list', 'one\n\ntwo'],
      ['paragraph', 'last'],
    ]);
  });

  test('converts Markdown pasted over a selection', () => {
    const editor = createEditor();
    setUp(editor, () => {
      const text = $createTextNode('keep REPLACE keep');
      $getRoot().getFirstChildOrThrow<ElementNode>().append(text);
      text.select(5, 12);
    });
    paste(editor, {'text/plain': '**bold** and `code`'});
    expect(describeRoot(editor)).toEqual([
      ['paragraph', 'keep **bold** and `code` keep'],
    ]);
    convert(editor);
    expect(describeRoot(editor)).toEqual([
      ['paragraph', 'keep bold and code keep'],
    ]);
  });

  test('does not offer text that does not look like Markdown', () => {
    const editor = createEditor();
    paste(editor, {'text/plain': 'plain words\n\nand more'});
    expect(getOffer(editor).peek()).toBe(null);
    expect(convert(editor)).toBe(false);
  });

  test('does not offer a paste into a code block', () => {
    const editor = createEditor();
    setUp(editor, () => {
      const code = $createCodeNode();
      $getRoot().clear().append(code);
      code.selectEnd();
    });
    paste(editor, {'text/plain': '# not a heading'});
    expect(getOffer(editor).peek()).toBe(null);
  });

  test('typing dismisses the offer', () => {
    const editor = createEditor();
    paste(editor, {'text/plain': '# Heading'});
    expect(getOffer(editor).peek()).not.toBe(null);
    setUp(editor, () => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.insertText('!');
      }
    });
    expect(getOffer(editor).peek()).toBe(null);
  });

  test('moving the selection dismisses the offer', () => {
    const editor = createEditor();
    paste(editor, {'text/plain': '# Heading'});
    setUp(editor, () => $getRoot().selectStart());
    expect(getOffer(editor).peek()).toBe(null);
  });

  test('a commit that changes nothing keeps the offer', () => {
    const editor = createEditor();
    paste(editor, {'text/plain': '# Heading'});
    let commits = 0;
    const unregister = editor.registerUpdateListener(() => {
      commits++;
    });
    onTestFinished(unregister);
    // An empty update does not commit, but a dirty selection does.
    setUp(editor, () => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.dirty = true;
      }
    });
    expect(commits).toBe(1);
    expect(getOffer(editor).peek()).not.toBe(null);
  });

  test('Escape and the dismiss command drop the offer', () => {
    const editor = createEditor();
    // Rich text blurs the editor on Escape; the first one only dismisses.
    let blurred = false;
    editor.blur = () => {
      blurred = true;
    };
    paste(editor, {'text/plain': '# Heading'});
    expect(
      editor.dispatchCommand(
        KEY_ESCAPE_COMMAND,
        new KeyboardEvent('keydown', {key: 'Escape'}),
      ),
    ).toBe(true);
    expect(blurred).toBe(false);
    expect(getOffer(editor).peek()).toBe(null);

    setUp(editor, () => $getRoot().selectEnd());
    paste(editor, {'text/plain': '# Heading'});
    expect(getOffer(editor).peek()).not.toBe(null);
    editor.dispatchCommand(DISMISS_PASTED_MARKDOWN_COMMAND, undefined);
    expect(getOffer(editor).peek()).toBe(null);
    expect(describeRoot(editor)).toEqual([['paragraph', '# Heading# Heading']]);
  });

  test('Tab converts a pending offer', () => {
    const editor = createEditor();
    paste(editor, {'text/plain': '# Heading'});
    const event = new KeyboardEvent('keydown', {
      cancelable: true,
      key: 'Tab',
    });
    expect(editor.dispatchCommand(KEY_DOWN_COMMAND, event)).toBe(true);
    editor.read(() => {});
    expect(event.defaultPrevented).toBe(true);
    expect(describeRoot(editor)).toEqual([['heading', 'Heading']]);
    expect(getOffer(editor).peek()).toBe(null);
  });

  test('Shift+Tab does not convert', () => {
    const editor = createEditor();
    paste(editor, {'text/plain': '# Heading'});
    editor.dispatchCommand(
      KEY_DOWN_COMMAND,
      new KeyboardEvent('keydown', {
        cancelable: true,
        key: 'Tab',
        shiftKey: true,
      }),
    );
    editor.read(() => {});
    expect(describeRoot(editor)).toEqual([['paragraph', '# Heading']]);
  });

  test('Tab is left to the editor without an offer', () => {
    const pressTab = (editor: LexicalEditor) => {
      setUp(editor, () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText('text');
        }
      });
      const event = new KeyboardEvent('keydown', {
        cancelable: true,
        key: 'Tab',
      });
      editor.dispatchCommand(KEY_DOWN_COMMAND, event);
      editor.read(() => {});
      return [describeRoot(editor), event.defaultPrevented];
    };
    expect(pressTab(createEditor())).toEqual(
      pressTab(createEditor({disabled: true})),
    );
  });

  test('announces the offer in a live region', () => {
    const editor = createEditor();
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    onTestFinished(() => {
      editor.setRootElement(null);
      root.remove();
    });
    editor.setRootElement(root);
    const announced = () =>
      Array.from(document.querySelectorAll('[aria-live]'))
        .map(region => region.textContent)
        .join('');
    paste(editor, {'text/plain': 'plain words'});
    expect(announced()).toBe('');
    paste(editor, {'text/plain': '\n# Heading'});
    expect(getOffer(editor).peek()).not.toBe(null);
    expect(announced()).toContain('looks like Markdown');
  });

  test('disabling the extension drops a pending offer', () => {
    const editor = createEditor();
    const {disabled, offer} = getExtensionDependencyFromEditor(
      editor,
      MarkdownPasteExtension,
    ).output;
    paste(editor, {'text/plain': '# Heading'});
    expect(offer.peek()).not.toBe(null);
    disabled.value = true;
    expect(offer.peek()).toBe(null);
    setUp(editor, () => $getRoot().selectEnd());
    paste(editor, {'text/plain': '\n# Heading'});
    expect(offer.peek()).toBe(null);
    disabled.value = false;
    setUp(editor, () => $getRoot().selectEnd());
    paste(editor, {'text/plain': '\n# Heading'});
    expect(offer.peek()).not.toBe(null);
  });

  test('does not offer when disabled', () => {
    const editor = createEditor({disabled: true});
    paste(editor, {'text/plain': '# Heading'});
    expect(getOffer(editor).peek()).toBe(null);
  });

  test('isMarkdown decides what is offered', () => {
    const editor = createEditor({isMarkdown: text => text.startsWith('!')});
    paste(editor, {'text/plain': '# Heading'});
    expect(getOffer(editor).peek()).toBe(null);
    paste(editor, {'text/plain': '! **x**'});
    expect(getOffer(editor).peek()).not.toBe(null);
  });

  test('skips transformers whose nodes are not registered', () => {
    const editor = createEditor({}, {withAllNodes: false});
    paste(editor, {'text/plain': '# heading\n\n- item'});
    convert(editor);
    expect(describeRoot(editor)).toEqual([
      ['heading', 'heading'],
      ['paragraph', '- item'],
    ]);
  });
});
