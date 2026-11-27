/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {assert, describe, expect, test} from 'vitest';

import {
  $copyNode,
  $create,
  $createParagraphNode,
  $createTextNode,
  $deepCopy,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $getState,
  $isElementNode,
  $isParagraphNode,
  $isTextNode,
  $setSlot,
  $setState,
  createState,
  DecoratorNode,
  defineExtension,
  ElementNode,
  type LexicalNode,
  type ParagraphNode,
} from '../..';

const colorState = createState('deep-copy-color', {
  parse: v => (typeof v === 'string' ? v : ''),
});

// Reset by $copyNode, so it tells the two copies apart.
const resetState = createState('deep-copy-reset', {
  parse: v => (typeof v === 'string' ? v : ''),
  resetOnCopyNode: true,
});

// A block decorator, to check that slots on a non-element host are copied.
class SlotDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('deep_copy_slot_decorator', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  decorate(): null {
    return null;
  }
}

// A shadow-root block used as a slot value.
class SlotContainerNode extends ElementNode {
  $config() {
    return this.config('deep_copy_slot_container', {extends: ElementNode});
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

// An inline wrapper that asks to be dropped from clones, keeping its children.
class UncopiedWrapperNode extends ElementNode {
  $config() {
    return this.config('deep_copy_uncopied_wrapper', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): boolean {
    return false;
  }
  isInline(): boolean {
    return true;
  }
  excludeFromCopy(destination?: 'clone' | 'html'): boolean {
    return destination === 'clone';
  }
}

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      name: '[deep-copy]',
      nodes: [SlotContainerNode, SlotDecoratorNode, UncopiedWrapperNode],
    }),
  );
}

/** The keys of node and everything below it, slots included. */
function $keys(node: LexicalNode): string[] {
  const keys = [node.getKey()];
  for (const name of $getSlotNames(node)) {
    const slot = $getSlot(node, name);
    assert(slot !== null, `slot ${name} resolves`);
    keys.push(...$keys(slot));
  }
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      keys.push(...$keys(child));
    }
  }
  return keys;
}

function $title(text: string): SlotContainerNode {
  return $create(SlotContainerNode).append(
    $createParagraphNode().append($createTextNode(text)),
  );
}

function $expectNoSharedKeys(original: LexicalNode, copy: LexicalNode) {
  const originalKeys = new Set($keys(original));
  for (const key of $keys(copy)) {
    expect(originalKeys.has(key)).toBe(false);
  }
}

describe('$deepCopy', () => {
  test('copies the node and all of its descendants with new keys', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const original = $createParagraphNode().append(
          $createTextNode('Hello ').toggleFormat('bold'),
          $createTextNode('world'),
        );
        $getRoot().clear().append(original);

        const copy = $deepCopy(original);
        $getRoot().append(copy);

        expect($isParagraphNode(copy)).toBe(true);
        expect(copy.getTextContent()).toBe('Hello world');
        const [first, second] = copy.getChildren();
        assert($isTextNode(first) && $isTextNode(second));
        expect(first.hasFormat('bold')).toBe(true);
        expect(second.hasFormat('bold')).toBe(false);

        const originalKeys = new Set($keys(original));
        for (const key of $keys(copy)) {
          expect(originalKeys.has(key)).toBe(false);
        }
      },
      {discrete: true},
    );
  });

  test('returns a detached copy that does not alias the original', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const original = $createParagraphNode().append(
          $createTextNode('original'),
        );
        $getRoot().clear().append(original);

        const copy = $deepCopy(original);
        expect(copy.getParent()).toBe(null);

        $getRoot().append(copy);
        const text = copy.getFirstChild();
        assert($isTextNode(text));
        text.setTextContent('changed');

        expect(original.getTextContent()).toBe('original');
        expect(copy.getTextContent()).toBe('changed');
      },
      {discrete: true},
    );
  });

  test('keeps NodeState on the node and its descendants', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const text = $setState($createTextNode('text'), colorState, 'blue');
        const original = $setState(
          $createParagraphNode().append(text),
          colorState,
          'red',
        );
        $getRoot().clear().append(original);

        const copy = $deepCopy(original);
        expect($getState(copy, colorState)).toBe('red');
        const copiedText = copy.getFirstChild();
        assert($isTextNode(copiedText));
        expect($getState(copiedText, colorState)).toBe('blue');
      },
      {discrete: true},
    );
  });

  test('copies named slots', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const original = $createParagraphNode().append($createTextNode('body'));
        const title = $create(SlotContainerNode).append(
          $createParagraphNode().append($createTextNode('Title')),
        );
        $setSlot(original, 'title', title);
        $getRoot().clear().append(original);

        const copy = $deepCopy(original);
        $getRoot().append(copy);

        const copiedTitle = $getSlot(copy, 'title');
        assert(copiedTitle instanceof SlotContainerNode);
        expect(copiedTitle).not.toBe(title);
        expect(copiedTitle.getKey()).not.toBe(title.getKey());
        expect(copiedTitle.getTextContent()).toBe('Title');
        expect(copy.getTextContent()).toBe(original.getTextContent());
        // The original slot is untouched.
        expect($getSlot(original, 'title')).toBe(title);
      },
      {discrete: true},
    );
  });

  test('drops descendants excluded from clones and keeps their children', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const original = $createParagraphNode().append(
          $createTextNode('a'),
          $create(UncopiedWrapperNode).append(
            $createTextNode('b'),
            $createTextNode('c').toggleFormat('italic'),
          ),
          $createTextNode('d'),
        );
        $getRoot().clear().append(original);

        const copy: ParagraphNode = $deepCopy(original);
        $getRoot().append(copy);

        const children = copy.getChildren();
        expect(children.some(n => n instanceof UncopiedWrapperNode)).toBe(
          false,
        );
        expect(copy.getTextContent()).toBe('abcd');
        expect(original.getChildrenSize()).toBe(3);
      },
      {discrete: true},
    );
  });

  test('always copies the node passed in, even if it is excluded from clones', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const wrapper = $create(UncopiedWrapperNode).append(
          $createTextNode('inside'),
        );
        $getRoot().clear().append($createParagraphNode().append(wrapper));

        const copy = $deepCopy(wrapper);
        expect(copy).toBeInstanceOf(UncopiedWrapperNode);
        expect(copy.getTextContent()).toBe('inside');
      },
      {discrete: true},
    );
  });

  test('copies a text node and an empty element', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const text = $createTextNode('leaf').toggleFormat('bold');
        const empty = $createParagraphNode();
        $getRoot().clear().append($createParagraphNode().append(text), empty);

        const textCopy = $deepCopy(text);
        assert($isTextNode(textCopy));
        expect(textCopy.getKey()).not.toBe(text.getKey());
        expect(textCopy.getTextContent()).toBe('leaf');
        expect(textCopy.hasFormat('bold')).toBe(true);
        expect(textCopy.getParent()).toBe(null);

        const emptyCopy = $deepCopy(empty);
        expect($isParagraphNode(emptyCopy)).toBe(true);
        expect(emptyCopy.getKey()).not.toBe(empty.getKey());
        expect(emptyCopy.getChildrenSize()).toBe(0);
      },
      {discrete: true},
    );
  });

  test('copies slots on a decorator host', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const original = $create(SlotDecoratorNode);
        $setSlot(original, 'title', $title('Caption'));
        $getRoot().clear().append(original);

        const copy = $deepCopy(original);
        $getRoot().append(copy);

        expect(copy).toBeInstanceOf(SlotDecoratorNode);
        const copiedTitle = $getSlot(copy, 'title');
        assert(copiedTitle instanceof SlotContainerNode);
        expect(copiedTitle.getTextContent()).toBe('Caption');
        $expectNoSharedKeys(original, copy);
      },
      {discrete: true},
    );
  });

  test('copies slots nested inside slots and children, all with new keys', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const inner = $createParagraphNode().append($createTextNode('inner'));
        $setSlot(inner, 'note', $title('Note'));
        const title = $create(SlotContainerNode).append(inner);
        const original = $createParagraphNode().append($createTextNode('body'));
        $setSlot(original, 'title', title);
        $getRoot().clear().append(original);

        const copy = $deepCopy(original);
        $getRoot().append(copy);

        const copiedTitle = $getSlot(copy, 'title');
        assert(copiedTitle instanceof SlotContainerNode);
        const copiedInner = copiedTitle.getFirstChild();
        assert($isParagraphNode(copiedInner));
        // Text content includes slot text, so it is the note and then the body.
        expect(copiedInner.getTextContent()).toBe(inner.getTextContent());
        const copiedNote = $getSlot(copiedInner, 'note');
        assert(copiedNote instanceof SlotContainerNode);
        expect(copiedNote.getTextContent()).toBe('Note');
        expect($keys(copy)).toHaveLength($keys(original).length);
        $expectNoSharedKeys(original, copy);
      },
      {discrete: true},
    );
  });

  test('does not reset state the way $copyNode does', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const original = $setState(
          $createParagraphNode().append(
            $setState($createTextNode('text'), resetState, 'child'),
          ),
          resetState,
          'parent',
        );
        $getRoot().clear().append(original);

        expect($getState($copyNode(original), resetState)).toBe('');

        const copy = $deepCopy(original);
        expect($getState(copy, resetState)).toBe('parent');
        const copiedText = copy.getFirstChild();
        assert($isTextNode(copiedText));
        expect($getState(copiedText, resetState)).toBe('child');
      },
      {discrete: true},
    );
  });

  test('drops the slots and state of a descendant excluded from clones', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const wrapper = $setState(
          $create(UncopiedWrapperNode).append($createTextNode('kept')),
          colorState,
          'red',
        );
        $setSlot(wrapper, 'title', $title('dropped'));
        const original = $createParagraphNode().append(wrapper);
        $getRoot().clear().append(original);

        const copy = $deepCopy(original);
        $getRoot().append(copy);

        const [child] = copy.getChildren();
        assert($isTextNode(child));
        expect(child.getTextContent()).toBe('kept');
        // The wrapper's slot and state must not move onto the copied parent.
        expect($getSlotNames(copy)).toEqual([]);
        expect($getState(copy, colorState)).toBe('');
        // Text content includes slot text, so a leaked slot would show here.
        expect(copy.getTextContent()).toBe('kept');
        expect(copy.getChildrenSize()).toBe(1);
        // The original still has its wrapper and slot.
        expect($getSlot(wrapper, 'title')).not.toBe(null);
      },
      {discrete: true},
    );
  });

  test('leaves the original untouched when the copy is never inserted', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const original = $createParagraphNode().append(
          $createTextNode('a'),
          $createTextNode('b').toggleFormat('bold'),
        );
        $setSlot(original, 'title', $title('Title'));
        $getRoot().clear().append(original);
        const keysBefore = $keys(original);

        $deepCopy(original);

        expect($keys(original)).toEqual(keysBefore);
        for (const child of original.getChildren()) {
          expect(child.getParent()).toBe(original);
        }
        expect($getRoot().getChildren()).toEqual([original]);
      },
      {discrete: true},
    );
  });

  test('refuses to copy the RootNode and leaves the document unchanged', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode().append($createTextNode('x'));
        $getRoot().clear().append(paragraph);

        expect(() => $deepCopy($getRoot())).toThrow(
          /the RootNode cannot be copied/,
        );
        expect($getRoot().getChildren()).toEqual([paragraph]);
        expect($getRoot().getTextContent()).toBe('x');
      },
      {discrete: true},
    );
  });

  test('throws in a read-only context', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('x')));
      },
      {discrete: true},
    );
    editor.read(() => {
      const paragraph = $getRoot().getFirstChild();
      assert(paragraph !== null);
      expect(() => $deepCopy(paragraph)).toThrow(/read-only/);
    });
  });
});
