/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
} from '@lexical/list';
import {$createHeadingNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createTextNode,
  $getRoot,
  $selectAll,
  CUT_COMMAND,
  type LexicalEditorWithDispose,
  type LexicalNode,
  PASTE_COMMAND,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

const ext = defineExtension({
  dependencies: [RichTextExtension, ListExtension],
  name: '[5835-cut]',
});

function createEditor(): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(ext);
  const container = document.createElement('div');
  document.body.appendChild(container);
  editor.setRootElement(container);
  onTestFinished(() => {
    editor.setRootElement(null);
    container.remove();
  });
  return editor;
}

/** The document as nested `[type, children]` pairs, with text spelled out. */
function outline(node: LexicalNode): unknown {
  const element = node as unknown as {getChildren?: () => LexicalNode[]};
  return element.getChildren
    ? [node.getType(), element.getChildren().map(outline)]
    : `${node.getType()}:${node.getTextContent()}`;
}

function readOutline(editor: LexicalEditorWithDispose): unknown {
  return editor.read(() => $getRoot().getChildren().map(outline));
}

function clipboardEvent(type: 'cut' | 'paste', data: DataTransfer) {
  return new ClipboardEvent(type, {clipboardData: data});
}

// The cut handler awaits copyToClipboard before removing the text, so let the
// microtask/timer queue drain before asserting.
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// Cutting the whole document wipes it exactly as deleting does, so it has to
// land in the same empty-editor state rather than leaving the last block behind
// as an empty heading or list (#5835).
describe('select-all + cut (#5835)', () => {
  test.for([
    {
      $block: () => $createHeadingNode('h1').append($createTextNode('hi')),
      label: 'heading',
    },
    {
      $block: () =>
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('one')),
        ),
      label: 'list',
    },
  ])('a lone $label leaves an empty paragraph', async ({$block}) => {
    using editor = createEditor();
    editor.update(
      () => {
        $getRoot().clear().append($block());
      },
      {discrete: true},
    );

    editor.update(
      () => {
        $selectAll();
      },
      {discrete: true},
    );
    editor.dispatchCommand(
      CUT_COMMAND,
      clipboardEvent('cut', new DataTransfer()),
    );
    await flush();

    expect(readOutline(editor)).toEqual([['paragraph', []]]);
  });

  // The point of widening the range *before* the copy: the clipboard has to
  // carry the blocks the cut removes, not just the text inside them, so Cmd+X
  // followed by Cmd+V puts the document back exactly as it was.
  test.for([
    {
      $block: () => $createHeadingNode('h1').append($createTextNode('hi')),
      label: 'heading',
    },
    {
      $block: () =>
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('one')),
          $createListItemNode().append($createTextNode('two')),
        ),
      label: 'list',
    },
  ])('cutting a lone $label and pasting restores it', async ({$block}) => {
    using editor = createEditor();
    editor.update(
      () => {
        $getRoot().clear().append($block());
      },
      {discrete: true},
    );
    const before = readOutline(editor);

    editor.update(
      () => {
        $selectAll();
      },
      {discrete: true},
    );
    const cutData = new DataTransfer();
    editor.dispatchCommand(CUT_COMMAND, clipboardEvent('cut', cutData));
    await flush();

    expect(readOutline(editor)).toEqual([['paragraph', []]]);

    editor.dispatchCommand(PASTE_COMMAND, clipboardEvent('paste', cutData));
    await flush();

    expect(readOutline(editor)).toEqual(before);
  });

  // A collapsed caret cuts nothing, so it must not disturb the block either:
  // Ctrl+X with no selection in an already-empty heading or list is a no-op.
  test.for([
    {
      $block: () => $createHeadingNode('h1'),
      expected: [['heading', []]],
      label: 'heading',
    },
    {
      $block: () => $createListNode('bullet').append($createListItemNode()),
      expected: [['list', [['listitem', []]]]],
      label: 'list',
    },
  ])(
    'a collapsed caret in an empty $label cuts nothing',
    async ({$block, expected}) => {
      using editor = createEditor();
      editor.update(
        () => {
          const block = $block();
          $getRoot().clear().append(block);
          block.selectStart();
        },
        {discrete: true},
      );

      editor.dispatchCommand(
        CUT_COMMAND,
        clipboardEvent('cut', new DataTransfer()),
      );
      await flush();

      expect(readOutline(editor)).toEqual(expected);
    },
  );
});
