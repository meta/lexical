/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  DecoratorNode,
  getDOMSelection,
  isDOMTextNode,
  type NodeKey,
  type SerializedLexicalNode,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';

class ChipNode extends DecoratorNode<null> {
  __text: string;

  static getType(): string {
    return 'chip';
  }

  static clone(node: ChipNode): ChipNode {
    return new ChipNode(node.__text, node.__key);
  }

  static importJSON(
    serializedNode: SerializedLexicalNode & {text: string},
  ): ChipNode {
    return new ChipNode(serializedNode.text);
  }

  constructor(text: string, key?: NodeKey) {
    super(key);
    this.__text = text;
  }

  exportJSON(): SerializedLexicalNode & {text: string} {
    return {
      ...super.exportJSON(),
      text: this.__text,
    };
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.textContent = this.__text;
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  isInline(): boolean {
    return true;
  }

  getTextContent(): string {
    return this.__text;
  }

  decorate(): null {
    return null;
  }
}

class InputDecoratorNode extends DecoratorNode<null> {
  static getType(): string {
    return 'input-decorator';
  }

  static clone(node: InputDecoratorNode): InputDecoratorNode {
    return new InputDecoratorNode(node.__key);
  }

  static importJSON(): InputDecoratorNode {
    return new InputDecoratorNode();
  }

  exportJSON(): SerializedLexicalNode {
    return super.exportJSON();
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span');
    const input = document.createElement('input');
    input.type = 'text';
    span.appendChild(input);
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  isInline(): boolean {
    return true;
  }

  decorate(): null {
    return null;
  }
}

function $createChipNode(text: string): ChipNode {
  return new ChipNode(text);
}

test('Issue #9840: Shift-click on an inline decorator keeps the anchor and puts the focus beside the decorator', async () => {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  const errors: Error[] = [];

  let text1Key = '';

  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      const p = $createParagraphNode();
      const t1 = $createTextNode('Before ');
      const chip = $createChipNode('@tag');
      const t2 = $createTextNode(' after');
      text1Key = t1.getKey();
      p.append(t1, chip, t2);
      $getRoot().clear().append(p);
    },
    dependencies: [RichTextExtension],
    name: '[issue-9840-shift-click-decorator]',
    nodes: [ChipNode],
    onError: error => {
      errors.push(error);
    },
  });
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });

  // Step 1: Initial selection collapsed inside text before decorator at offset 2 ('Be|fore ')
  editor.update(
    () => {
      const t1 = editor.getEditorState()._nodeMap.get(text1Key);
      assert(t1 !== null);
      (t1 as any).select(2, 2);
    },
    {discrete: true},
  );

  const initialSelection = editor.read(() => {
    const sel = $getSelection();
    assert($isRangeSelection(sel));
    return {
      anchorKey: sel.anchor.key,
      anchorOffset: sel.anchor.offset,
      focusKey: sel.focus.key,
      focusOffset: sel.focus.offset,
    };
  });
  expect(initialSelection).toEqual({
    anchorKey: text1Key,
    anchorOffset: 2,
    focusKey: text1Key,
    focusOffset: 2,
  });

  // Find the decorator's span and text node
  const decoratorSpan = root.querySelector('[data-lexical-decorator]');
  assert(decoratorSpan !== null, 'Expected the decorator span');
  const decoratorText = decoratorSpan.firstChild;
  assert(isDOMTextNode(decoratorText), 'Expected decorator text node');

  const domSelection = getDOMSelection(window);
  assert(domSelection !== null, 'Expected a DOM selection');

  // Step 2: Simulate Shift+click on the decorator
  const init = {
    bubbles: true,
    button: 0,
    buttons: 1,
    composed: true,
    shiftKey: true,
  };

  decoratorSpan.dispatchEvent(
    new PointerEvent('pointerdown', {...init, pointerType: 'mouse'}),
  );
  decoratorSpan.dispatchEvent(
    new MouseEvent('mousedown', {...init, detail: 1}),
  );

  // In Firefox, Shift+click puts DOM focus in the decorator text
  domSelection.setBaseAndExtent(decoratorText, 2, decoratorText, 2);
  document.dispatchEvent(new Event('selectionchange'));

  decoratorSpan.dispatchEvent(
    new PointerEvent('pointerup', {
      ...init,
      buttons: 0,
      pointerType: 'mouse',
    }),
  );

  expect(errors).toEqual([]);

  const afterSelection = editor.read(() => {
    const sel = $getSelection();
    if (!$isRangeSelection(sel)) {
      return null;
    }
    return {
      anchorKey: sel.anchor.key,
      anchorOffset: sel.anchor.offset,
      isCollapsed: sel.isCollapsed(),
    };
  });

  // The anchor must be preserved at Before:2 and selection must not be dropped to null
  expect(afterSelection).not.toBeNull();
  expect(afterSelection?.anchorKey).toBe(text1Key);
  expect(afterSelection?.anchorOffset).toBe(2);
  expect(afterSelection?.isCollapsed).toBe(false);
});

test('Issue #9840: Click without Shift on an embedded input inside a decorator does not start mouseDrag', async () => {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);

  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      const p = $createParagraphNode();
      p.append(new InputDecoratorNode());
      $getRoot().clear().append(p);
    },
    dependencies: [RichTextExtension],
    name: '[issue-9840-input-decorator]',
    nodes: [InputDecoratorNode],
    onError: error => {
      throw error;
    },
  });
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });

  const input = root.querySelector('input');
  assert(input !== null, 'Expected input element');

  const init = {
    bubbles: true,
    button: 0,
    buttons: 1,
    composed: true,
    shiftKey: false,
  };

  input.dispatchEvent(
    new PointerEvent('pointerdown', {...init, pointerType: 'mouse'}),
  );
  input.dispatchEvent(new MouseEvent('mousedown', {...init, detail: 1}));

  // mouseDrag must be null because the embedded input captures selection
  expect(editor._inputState.mouseDrag).toBeNull();
});
