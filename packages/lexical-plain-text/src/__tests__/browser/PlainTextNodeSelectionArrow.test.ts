/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  buildEditorFromExtensions,
  HorizontalRuleExtension,
} from '@lexical/extension';
import {PlainTextExtension} from '@lexical/plain-text';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  DecoratorNode,
  type LexicalEditor,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

class TestInlineDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_inline_decorator', {extends: DecoratorNode});
  }

  createDOM(): HTMLElement {
    return document.createElement('span');
  }

  updateDOM(): false {
    return false;
  }

  decorate(): null {
    return null;
  }

  isInline(): true {
    return true;
  }

  getTextContent(): string {
    return '◆';
  }
}

/** An inline decorator whose DOM holds a text field of its own. */
class TestInputNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_input', {extends: DecoratorNode});
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span');
    const input = document.createElement('input');
    input.value = 'field text';
    span.appendChild(input);
    return span;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): null {
    return null;
  }

  isInline(): true {
    return true;
  }
}

function mountEditor($initialEditorState: () => void): LexicalEditor {
  const rootElement = document.createElement('div');
  rootElement.contentEditable = 'true';
  document.body.appendChild(rootElement);
  const editor = buildEditorFromExtensions({
    $initialEditorState,
    dependencies: [PlainTextExtension, HorizontalRuleExtension],
    name: 'test',
    nodes: [TestInlineDecoratorNode, TestInputNode],
  });
  editor.setRootElement(rootElement);
  rootElement.focus();

  onTestFinished(() => {
    editor.setRootElement(null);
    rootElement.remove();
    editor.dispose();
  });

  return editor;
}

/**
 * `first / before / (rule) / after`, with the rule node-selected by clicking
 * it after a click in `first`, as a user would.
 */
async function mountWithSelectedRule(): Promise<LexicalEditor> {
  const editor = mountEditor(() => {
    $getRoot()
      .clear()
      .append(
        $createParagraphNode().append($createTextNode('first')),
        $createParagraphNode().append($createTextNode('before')),
        $createHorizontalRuleNode(),
        $createParagraphNode().append($createTextNode('after')),
      );
  });
  const [firstKey, ruleKey] = editor.read(() => [
    $getRoot().getChildAtIndex(0)!.getKey(),
    $getRoot().getChildAtIndex(2)!.getKey(),
  ]);
  await userEvent.click(editor.getElementByKey(firstKey)!);
  await userEvent.click(editor.getElementByKey(ruleKey)!);
  editor.read(() => {
    expect($isNodeSelection($getSelection())).toBe(true);
  });
  return editor;
}

/** Node-selects the second child of the last block. */
function selectSecondChildOfLastBlock(editor: LexicalEditor): void {
  editor.update(
    () => {
      const block = $getRoot().getLastChildOrThrow();
      assert($isElementNode(block));
      const selection = $createNodeSelection();
      selection.add(block.getChildAtIndex(1)!.getKey());
      $setSelection(selection);
    },
    {discrete: true},
  );
}

/**
 * `first / ab (decorator) cd`, with the inline decorator node-selected. The
 * second block is written right to left when `direction` says so.
 */
function mountWithSelectedInlineDecorator(
  direction: 'ltr' | 'rtl' = 'ltr',
): LexicalEditor {
  const editor = mountEditor(() => {
    const [before, after] =
      direction === 'rtl' ? ['אב ', ' גד'] : ['ab ', ' cd'];
    $getRoot()
      .clear()
      .append(
        $createParagraphNode().append($createTextNode('first')),
        $createParagraphNode()
          .setDirection(direction)
          .append(
            $createTextNode(before),
            new TestInlineDecoratorNode(),
            $createTextNode(after),
          ),
      );
  });
  selectSecondChildOfLastBlock(editor);
  return editor;
}

/**
 * `ab (field text)`, with the decorator that holds the field node-selected and
 * then the caret clicked into the field after `field`, which keeps the
 * NodeSelection.
 */
async function mountWithCaretInSelectedDecoratorInput(): Promise<{
  editor: LexicalEditor;
  input: HTMLInputElement;
}> {
  const editor = mountEditor(() => {
    $getRoot()
      .clear()
      .append(
        $createParagraphNode().append(
          $createTextNode('ab '),
          new TestInputNode(),
        ),
      );
  });
  selectSecondChildOfLastBlock(editor);
  const input = editor.getRootElement()!.querySelector('input')!;
  await userEvent.click(input);
  input.setSelectionRange(5, 5);
  editor.read(() => {
    expect($isNodeSelection($getSelection())).toBe(true);
  });
  return {editor, input};
}

/**
 * Presses `key` and reports whether anything prevented its default action, as
 * the page sees it once the editor's listeners have run.
 */
async function pressKey(key: string): Promise<boolean> {
  let defaultPrevented: boolean | null = null;
  const record = (event: KeyboardEvent) => {
    defaultPrevented = event.defaultPrevented;
  };
  window.addEventListener('keydown', record);
  try {
    await userEvent.keyboard(`{${key}}`);
  } finally {
    window.removeEventListener('keydown', record);
  }
  assert(defaultPrevented !== null, 'the keydown reached the window');
  return defaultPrevented;
}

/**
 * Where `key` puts the caret in a field like the decorator's, outside any
 * editor, from after `field`: what the browser does with the key.
 */
async function caretAfterKeyInPlainInput(key: string): Promise<number> {
  const input = document.createElement('input');
  input.value = 'field text';
  document.body.appendChild(input);
  onTestFinished(() => input.remove());
  await userEvent.click(input);
  input.setSelectionRange(5, 5);
  await userEvent.keyboard(`{${key}}`);
  return input.selectionStart!;
}

/** The collapsed caret as the text it is in and its offset there. */
function describeCaret(editor: LexicalEditor): [text: string, offset: number] {
  return editor.read(() => {
    const selection = $getSelection();
    expect(
      $isNodeSelection(selection),
      'the NodeSelection is left in place',
    ).toBe(false);
    assert($isRangeSelection(selection));
    expect(selection.isCollapsed()).toBe(true);
    return [
      selection.anchor.getNode().getTextContent(),
      selection.anchor.offset,
    ];
  });
}

/** The text of each block, and the type of each block that isn't an element. */
function describeBlocks(editor: LexicalEditor): string[] {
  return editor.read(() =>
    $getRoot()
      .getChildren()
      .map(node =>
        $isElementNode(node) ? node.getTextContent() : node.getType(),
      ),
  );
}

describe('Arrow keys on a NodeSelection in plain text (#4214)', () => {
  test.for([
    {
      blocks: ['first', 'beforeq', 'horizontalrule', 'after'],
      caret: ['before', 6],
      key: 'ArrowUp',
    },
    {
      blocks: ['first', 'beforeq', 'horizontalrule', 'after'],
      caret: ['before', 6],
      key: 'ArrowLeft',
    },
    {
      blocks: ['first', 'before', 'horizontalrule', 'qafter'],
      caret: ['after', 0],
      key: 'ArrowDown',
    },
    {
      blocks: ['first', 'before', 'horizontalrule', 'qafter'],
      caret: ['after', 0],
      key: 'ArrowRight',
    },
  ] as const)(
    '$key moves the caret to the side of a node-selected rule, where typing goes',
    async ({blocks, caret, key}) => {
      const editor = await mountWithSelectedRule();

      await userEvent.keyboard(`{${key}}`);

      expect(describeCaret(editor)).toEqual(caret);

      await userEvent.keyboard('q');

      expect(describeBlocks(editor)).toEqual(blocks);
    },
  );

  test.for([
    {blocks: ['first', 'ab q◆ cd'], caret: ['ab ', 3], key: 'ArrowUp'},
    {blocks: ['first', 'ab q◆ cd'], caret: ['ab ', 3], key: 'ArrowLeft'},
    {blocks: ['first', 'ab ◆q cd'], caret: [' cd', 0], key: 'ArrowDown'},
    {blocks: ['first', 'ab ◆q cd'], caret: [' cd', 0], key: 'ArrowRight'},
  ] as const)(
    '$key moves the caret to the side of a node-selected inline decorator, where typing goes',
    async ({blocks, caret, key}) => {
      const editor = mountWithSelectedInlineDecorator();

      await userEvent.keyboard(`{${key}}`);

      expect(describeCaret(editor)).toEqual(caret);

      await userEvent.keyboard('q');

      expect(describeBlocks(editor)).toEqual(blocks);
    },
  );

  test.for([
    {blocks: ['first', 'אב ◆q גד'], caret: [' גד', 0], key: 'ArrowLeft'},
    {blocks: ['first', 'אב q◆ גד'], caret: ['אב ', 3], key: 'ArrowRight'},
  ] as const)(
    '$key moves the caret to its side of a node-selected inline decorator in right-to-left text',
    async ({blocks, caret, key}) => {
      const editor = mountWithSelectedInlineDecorator('rtl');

      await userEvent.keyboard(`{${key}}`);

      expect(describeCaret(editor)).toEqual(caret);

      await userEvent.keyboard('q');

      expect(describeBlocks(editor)).toEqual(blocks);
    },
  );

  test.for(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])(
    'Shift+%s on a node-selected rule leaves a non-collapsed RangeSelection that holds the rule',
    async key => {
      const editor = await mountWithSelectedRule();

      await userEvent.keyboard(`{Shift>}{${key}}{/Shift}`);

      editor.read(() => {
        const selection = $getSelection();
        expect(
          $isNodeSelection(selection),
          'the NodeSelection is left in place',
        ).toBe(false);
        assert($isRangeSelection(selection));
        expect(selection.isCollapsed()).toBe(false);
        expect(selection.getNodes().some($isHorizontalRuleNode)).toBe(true);
      });
    },
  );
});

describe('Arrow keys in the input of a node-selected decorator', () => {
  test.for(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])(
    '%s is left to the input',
    async key => {
      const expectedCaret = await caretAfterKeyInPlainInput(key);
      const {editor, input} = await mountWithCaretInSelectedDecoratorInput();

      expect(await pressKey(key)).toBe(false);

      expect(input.selectionStart).toBe(expectedCaret);
      editor.read(() => {
        expect($isNodeSelection($getSelection())).toBe(true);
      });
    },
  );
});
