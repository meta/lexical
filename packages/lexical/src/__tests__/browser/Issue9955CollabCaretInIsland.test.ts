/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {domOverride, DOMRenderExtension} from '@lexical/html';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $markSlotEditable,
  $setSlot,
  COLLABORATION_TAG,
  configExtension,
  DecoratorNode,
  type EditorConfig,
  type ElementDOMSlot,
  ElementNode,
  getDOMSelection,
  type LexicalEditor,
  type LexicalNode,
  type ParagraphNode,
  type TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

// A block decorator whose slot is revealed in place inside its DOM, so the
// slot's container is an editing host of its own, like the playground's
// Pull Quote.
class SlotHostNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_collab_slot_host', {
      extends: DecoratorNode,
      slots: ['body'],
    });
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isInline(): boolean {
    return false;
  }
  decorate(): null {
    return null;
  }
}

class SlotValueNode extends ElementNode {
  $config() {
    return this.config('test_collab_slot_value', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isShadowRoot(): boolean {
    return true;
  }
}

// An element whose children render into an editable island inside a
// non-editable shell, like the playground's Review body.
class IslandHostNode extends ElementNode {
  $config() {
    return this.config('test_collab_island_host', {extends: ElementNode});
  }
  createDOM(_config: EditorConfig, editor: LexicalEditor): HTMLElement {
    const dom = document.createElement('div');
    dom.contentEditable = 'false';
    const island = document.createElement('div');
    $markSlotEditable(island, editor);
    dom.appendChild(island);
    return dom;
  }
  updateDOM(): boolean {
    return false;
  }
  getDOMSlot(element: HTMLElement): ElementDOMSlot<HTMLElement> {
    return super
      .getDOMSlot(element)
      .withElement(element.firstElementChild as HTMLElement);
  }
  isShadowRoot(): boolean {
    return true;
  }
}

// A block decorator whose DOM holds an element another owner takes the focus
// in: another editor's root, or a button.
class FocusTargetNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_collab_focus_target', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'focus-target';
    return dom;
  }
  updateDOM(): boolean {
    return false;
  }
  isInline(): boolean {
    return false;
  }
  decorate(): null {
    return null;
  }
}

const $inRoot = (line: ParagraphNode): LexicalNode => line;
const $inSlot = (line: ParagraphNode): LexicalNode => {
  const host = $create(SlotHostNode);
  $setSlot(host, 'body', $create(SlotValueNode).append(line));
  return host;
};
const $inIsland = (line: ParagraphNode): LexicalNode =>
  $create(IslandHostNode).append(line);

// The caret is after "abc" of "abcdef", in `$build`'s content.
async function setUp($build: (line: ParagraphNode) => LexicalNode): Promise<{
  editor: LexicalEditor;
  root: HTMLElement;
  text: () => string;
  textKey: string;
}> {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  let textKey = '';
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      const text = $createTextNode('abcdef');
      textKey = text.getKey();
      $getRoot().append(
        $build($createParagraphNode().append(text)),
        $create(FocusTargetNode),
      );
    },
    dependencies: [
      RichTextExtension,
      configExtension(DOMRenderExtension, {
        overrides: [
          domOverride([SlotHostNode], {
            $getSlotTargetElement: (_node, _slotName, hostDom) => hostDom,
          }),
        ],
      }),
    ],
    name: '[collab-caret-in-island]',
    nodes: [SlotHostNode, SlotValueNode, IslandHostNode, FocusTargetNode],
  });
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  editor.setRootElement(root);
  root.focus();
  editor.update(
    () => {
      ($getNodeByKey(textKey) as TextNode).select(3, 3);
    },
    {discrete: true},
  );
  await nextFrame();
  return {
    editor,
    root,
    text: () => editor.read(() => $getNodeByKey(textKey)!.getTextContent()),
    textKey,
  };
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

// A collaborator's "XY" at the start of the text, as @lexical/yjs applies it:
// the selection moves with the text it was in.
async function writeAsCollaborator(
  editor: LexicalEditor,
  textKey: string,
): Promise<void> {
  editor.update(
    () => {
      const text = $getNodeByKey(textKey) as TextNode;
      text.spliceText(0, 0, 'XY', false);
      text.select(5, 5);
    },
    {discrete: true, tag: COLLABORATION_TAG},
  );
  await nextFrame();
}

describe('the DOM caret after a collaboration update (#9955)', () => {
  test.each([
    ["the root's own text", $inRoot],
    ["a named slot's text", $inSlot],
    ["an editable island's text", $inIsland],
  ])('is where the selection is, in %s', async (_where, $build) => {
    const {editor, root, text, textKey} = await setUp($build);
    const focused = document.activeElement;
    expect(focused === root).toBe($build === $inRoot);

    await writeAsCollaborator(editor, textKey);
    const domSelection = getDOMSelection(window)!;
    expect(domSelection.anchorNode!.textContent).toBe('XYabcdef');
    expect(domSelection.anchorOffset).toBe(5);
    expect(document.activeElement).toBe(focused);

    await userEvent.keyboard('Q');
    await expect.poll(text).toBe('XYabcQdef');
  });

  test('stays in another editor nested in the root', async () => {
    const {editor, root, textKey} = await setUp($inIsland);
    const innerRoot = document.createElement('div');
    innerRoot.contentEditable = 'true';
    root.querySelector('.focus-target')!.appendChild(innerRoot);
    const inner = buildEditorFromExtensions({
      $initialEditorState: () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('inner')),
        );
      },
      dependencies: [RichTextExtension],
      name: '[collab-caret-inner]',
    });
    onTestFinished(() => inner.dispose());
    inner.setRootElement(innerRoot);
    innerRoot.focus();
    inner.update(
      () => {
        $getRoot().selectEnd();
      },
      {discrete: true},
    );
    await nextFrame();
    expect(document.activeElement).toBe(innerRoot);

    await writeAsCollaborator(editor, textKey);
    expect(document.activeElement).toBe(innerRoot);
    expect(getDOMSelection(window)!.anchorNode!.textContent).toBe('inner');
  });

  test("doesn't take the focus from a button in the root", async () => {
    const {editor, root, textKey} = await setUp($inIsland);
    const button = document.createElement('button');
    root.querySelector('.focus-target')!.appendChild(button);
    button.focus();
    await nextFrame();
    expect(document.activeElement).toBe(button);

    await writeAsCollaborator(editor, textKey);
    expect(document.activeElement).toBe(button);
  });
});
