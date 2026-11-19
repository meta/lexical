/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createLinkNode, LinkExtension} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isBlockFullySelected,
  $isElementNode,
  $isRangeSelection,
  defineExtension,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

import {
  buildEditorFromExtensions,
  DecoratorTextExtension,
  DecoratorTextNode,
  SelectBlockExtension,
} from '../../index';

// Match the inline, non-editable shape of the playground's date decorators.
// Their controls and image/nested-editor integration remain covered in e2e.
class InlineDecoratorNode extends DecoratorTextNode {
  $config() {
    return this.config('select-block-decorator', {extends: DecoratorTextNode});
  }
  createDOM(): HTMLElement {
    const element = document.createElement('span');
    element.textContent = 'decorator';
    element.style.display = 'inline-block';
    return element;
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
  getTextContent(): string {
    return 'decorator';
  }
}

const extension = defineExtension({
  dependencies: [
    RichTextExtension,
    LinkExtension,
    DecoratorTextExtension,
    SelectBlockExtension,
  ],
  name: 'SelectBlockBrowserTest',
  nodes: [InlineDecoratorNode],
});

function setup($children: () => LexicalNode[]) {
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
      const paragraph = $createParagraphNode().append(...$children());
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append(
            $createTextNode('Lorem ipsum dolor '),
            $createTextNode('sit amet').toggleFormat('bold'),
            $createTextNode(', consectetur adipiscing elit.'),
          ),
          $createParagraphNode().append(
            $createLinkNode('https://').append($createTextNode('Link text')),
          ),
          $createParagraphNode().append(new InlineDecoratorNode()),
          paragraph,
        );
      paragraph.selectEnd();
    },
    {discrete: true},
  );
  window.focus();
  root.focus();
  return {editor, root};
}

function domSelection() {
  const selection = window.getSelection()!;
  return [
    selection.anchorNode,
    selection.anchorOffset,
    selection.focusNode,
    selection.focusOffset,
  ];
}

async function selectAll() {
  await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}');
}

const cases = [
  {
    $children: () => [$createTextNode('Simple text')],
    endOffset: 11,
    endPath: [0, 0],
    name: 'simple text',
  },
  {
    $children: () => [
      $createTextNode('Formatted '),
      $createTextNode('text').toggleFormat('bold'),
    ],
    endOffset: 4,
    endPath: [1, 0],
    name: 'formatted text',
  },
  {
    $children: () => [
      $createLinkNode('https://').append($createTextNode('link')),
    ],
    endOffset: 4,
    endPath: [0, 0, 0],
    name: 'inline element',
  },
  {
    $children: () => [new InlineDecoratorNode(), $createTextNode(' text')],
    endOffset: 5,
    endPath: [1, 0],
    name: 'inline decorator, text',
  },
  {
    $children: () => [$createTextNode('text '), new InlineDecoratorNode()],
    endOffset: 2,
    endPath: [],
    name: 'text, inline decorator',
  },
  {
    $children: () => [
      $createTextNode('text '),
      new InlineDecoratorNode(),
      $createTextNode(' text'),
    ],
    endOffset: 5,
    endPath: [2, 0],
    name: 'text, inline decorator, text',
  },
  {
    $children: () => [
      $createLinkNode('https://').append($createTextNode('link')),
      $createTextNode(' '),
      new InlineDecoratorNode(),
    ],
    endOffset: 3,
    endPath: [],
    name: 'element, inline decorator',
  },
  {
    $children: () => [
      new InlineDecoratorNode(),
      $createLinkNode('https://').append($createTextNode(' link')),
    ],
    endOffset: 5,
    endPath: [1, 0, 0],
    name: 'inline decorator, element',
  },
];

describe('native select-all block expansion', () => {
  test.each(cases)('$name', async ({$children, endPath, endOffset}) => {
    const {editor, root} = setup($children);
    const paragraph = root.lastElementChild!;
    const childCount = editor.read('latest', () => {
      const last = $getRoot().getLastChildOrThrow();
      assert($isElementNode(last));
      return last.getChildrenSize();
    });
    const endNode = endPath.reduce<Node>(
      (node, index) => node.childNodes[index],
      paragraph,
    );
    await selectAll();
    await expect
      .poll(domSelection)
      .toEqual([paragraph, 0, paragraph, childCount]);
    editor.read('latest', () => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect($isBlockFullySelected($getRoot(), selection)).toBe(false);
    });
    await selectAll();
    await expect
      .poll(domSelection)
      .toEqual([
        root.firstElementChild!.firstChild!.firstChild!,
        0,
        endNode,
        endOffset,
      ]);
    editor.read('latest', () => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect($isBlockFullySelected($getRoot(), selection)).toBe(true);
    });
  });

  test.each([1, 2])(
    'empty block selects the document after %i presses',
    async presses => {
      const {root} = setup(() => []);
      const paragraph = root.lastElementChild!;
      await expect.poll(domSelection).toEqual([paragraph, 0, paragraph, 0]);
      for (let i = 0; i < presses; i++) {
        await selectAll();
        await expect
          .poll(domSelection)
          .toEqual([
            root.firstElementChild!.firstChild!.firstChild!,
            0,
            paragraph,
            0,
          ]);
      }
    },
  );

  test('a partial backward selection expands to the block, then the document', async () => {
    const {root} = setup(() => [$createTextNode('my text')]);
    const paragraph = root.lastElementChild!;
    const text = paragraph.firstChild!.firstChild!;
    await userEvent.keyboard(
      '{Shift>}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{/Shift}',
    );
    await expect.poll(domSelection).toEqual([text, 7, text, 3]);
    await selectAll();
    await expect.poll(domSelection).toEqual([paragraph, 0, paragraph, 1]);
    await selectAll();
    await expect
      .poll(domSelection)
      .toEqual([root.firstElementChild!.firstChild!.firstChild!, 0, text, 7]);
  });

  test('a selection spanning blocks expands to the whole document', async () => {
    const {editor, root} = setup(() => []);
    editor.update(
      () => {
        const second = $createTextNode('second');
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('first')),
            $createParagraphNode().append(second),
          );
        second.selectEnd();
      },
      {discrete: true},
    );
    await userEvent.keyboard(`{Shift>}${'{ArrowLeft}'.repeat(9)}{/Shift}`);
    await expect
      .poll(() => {
        const selection = window.getSelection()!;
        return selection.anchorNode !== selection.focusNode;
      })
      .toBe(true);
    await selectAll();
    await expect
      .poll(domSelection)
      .toEqual([
        root.firstElementChild!.firstChild!.firstChild!,
        0,
        root.lastElementChild!.firstChild!.firstChild!,
        6,
      ]);
  });
});
