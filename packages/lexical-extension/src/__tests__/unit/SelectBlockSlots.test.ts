/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  SelectBlockExtension,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotFrame,
  $isBlockFullySelected,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSlot,
  configExtension,
  defineExtension,
  ElementNode,
  type LexicalNode,
  SELECT_ALL_COMMAND,
  type TextNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

// A multi-block slot value. Any non-inline block can be a slot value (see
// $setSlot); this suite needs values holding several blocks, so it mirrors
// the shadow-root $slotContainer pattern from
// packages/lexical/src/__tests__/unit/LexicalSlot.test.ts using the $config
// node API.
class SlotContainerNode extends ElementNode {
  $config() {
    return this.config('select-block-slots-container', {extends: ElementNode});
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

function $isSlotContainerNode(
  node: LexicalNode | undefined | null,
): node is SlotContainerNode {
  return node instanceof SlotContainerNode;
}

// A shadow-root container holding a paragraph + text per entry, so the slot
// value holds whole blocks.
function $slotContainer(...texts: string[]): SlotContainerNode {
  const container = $create(SlotContainerNode);
  for (const text of texts) {
    container.append($createParagraphNode().append($createTextNode(text)));
  }
  return container;
}

// Document shape:
//   root
//   ├── paragraph 'before'
//   ├── host paragraph 'host body', slot 'title' →
//   │     SlotContainerNode
//   │     ├── paragraph 'slot one'
//   │     └── paragraph 'slot two'
//   └── paragraph 'after'
// Two in-slot blocks keep "select the caret's block" (SelectBlockExtension)
// observably different from "select the whole slot" (the rich-text default).
function setUpSlotEditor(
  options: {disabled?: boolean; slotTexts?: string[]} = {},
) {
  const {disabled = false, slotTexts = ['slot one', 'slot two']} = options;
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        const host = $createParagraphNode().append(
          $createTextNode('host body'),
        );
        $setSlot(host, 'title', $slotContainer(...slotTexts));
        $getRoot().append(
          $createParagraphNode().append($createTextNode('before')),
          host,
          $createParagraphNode().append($createTextNode('after')),
        );
      },
      // RichTextExtension registers the default SELECT_ALL_COMMAND handler at
      // COMMAND_PRIORITY_EDITOR; when enabled, SelectBlockExtension overrides
      // it from its higher COMMAND_PRIORITY_LOW bucket, mirroring how the
      // playground composes the two.
      dependencies: [
        RichTextExtension,
        configExtension(SelectBlockExtension, {
          cascadeSelection: false,
          disabled,
        }),
      ],
      name: 'select-block-slots-test',
      nodes: [SlotContainerNode],
      register: editor => {
        const rootElement = document.createElement('div');
        rootElement.contentEditable = 'true';
        document.body.appendChild(rootElement);
        editor.setRootElement(rootElement);
        return () => rootElement.remove();
      },
    }),
  );
}

function selectAllKeyboardEvent(): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key: 'a',
  });
}

function $hostParagraph(): ElementNode {
  const node = $getRoot().getChildAtIndex(1);
  assert($isElementNode(node), 'host paragraph must exist');
  return node;
}

function $slotValue(): SlotContainerNode {
  const slot = $getSlot($hostParagraph(), 'title');
  assert($isSlotContainerNode(slot), 'slot value must exist');
  return slot;
}

function $slotParagraph(index: number): ElementNode {
  const node = $slotValue().getChildAtIndex(index);
  assert($isElementNode(node), `slot paragraph ${index} must exist`);
  return node;
}

function $slotText(index: number): TextNode {
  const text = $slotParagraph(index).getFirstChild();
  assert($isTextNode(text), `slot text ${index} must exist`);
  return text;
}

function $expectFullySelected(blockNode: ElementNode): void {
  const selection = $getSelection();
  assert($isRangeSelection(selection), 'expecting a RangeSelection');
  expect($isBlockFullySelected(blockNode, selection)).toBe(true);
}

function $expectSelectionInSlotFrame(): void {
  const selection = $getSelection();
  assert($isRangeSelection(selection), 'expecting a RangeSelection');
  const slotValue = $slotValue();
  const anchorFrame = $getSlotFrame(selection.anchor.getNode());
  const focusFrame = $getSlotFrame(selection.focus.getNode());
  assert(anchorFrame !== null, 'anchor must stay inside the slot frame');
  assert(focusFrame !== null, 'focus must stay inside the slot frame');
  expect(anchorFrame.is(slotValue)).toBe(true);
  expect(focusFrame.is(slotValue)).toBe(true);
}

describe('SelectBlockExtension with named slots', () => {
  test('select all inside a slot selects exactly the in-slot block', () => {
    using editor = setUpSlotEditor();
    editor.update(
      () => {
        $slotText(0).select(2, 2);
      },
      {discrete: true},
    );

    expect(
      editor.dispatchCommand(SELECT_ALL_COMMAND, selectAllKeyboardEvent()),
    ).toBe(true);
    editor.read(() => {
      // anchor/focus span the caret's in-slot paragraph...
      $expectFullySelected($slotParagraph(0));
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      // ...scoped to that block, not the whole slot value...
      expect($isBlockFullySelected($slotValue(), selection)).toBe(false);
      // ...and the selection stays inside the slot frame
      $expectSelectionInSlotFrame();
    });
  });

  test('repeated select all expands block, then slot, then document', () => {
    using editor = setUpSlotEditor();
    editor.update(
      () => {
        $slotText(0).select(2, 2);
      },
      {discrete: true},
    );

    // 1st press: the caret's in-slot block only
    editor.dispatchCommand(SELECT_ALL_COMMAND, selectAllKeyboardEvent());
    editor.read(() => {
      $expectFullySelected($slotParagraph(0));
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect($isBlockFullySelected($slotValue(), selection)).toBe(false);
    });

    // 2nd press: the whole slot frame (every in-slot block), still inside it
    expect(
      editor.dispatchCommand(SELECT_ALL_COMMAND, selectAllKeyboardEvent()),
    ).toBe(true);
    editor.read(() => {
      $expectFullySelected($slotValue());
      $expectFullySelected($slotParagraph(0));
      $expectFullySelected($slotParagraph(1));
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect($isBlockFullySelected($getRoot(), selection)).toBe(false);
      $expectSelectionInSlotFrame();
    });

    // 3rd press: the whole document. Comparing the in-frame selection
    // against the root crosses the slot boundary; the slot-frame guard in
    // $isBlockFullySelected returns false gracefully (instead of throwing on
    // a caret comparison with no common ancestor), so bare $selectAll runs.
    expect(() => {
      expect(
        editor.dispatchCommand(SELECT_ALL_COMMAND, selectAllKeyboardEvent()),
      ).toBe(true);
    }).not.toThrow();
    editor.read(() => {
      $expectFullySelected($getRoot());
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      // the selection escaped the slot frame onto the document
      expect($getSlotFrame(selection.anchor.getNode())).toBe(null);
      expect($getSlotFrame(selection.focus.getNode())).toBe(null);
    });
  });

  test('a one-block slot escalates block, then document, with no dead press', () => {
    using editor = setUpSlotEditor({slotTexts: ['only block']});
    editor.update(
      () => {
        $slotText(0).select(2, 2);
      },
      {discrete: true},
    );

    editor.dispatchCommand(SELECT_ALL_COMMAND, selectAllKeyboardEvent());
    editor.read(() => {
      $expectFullySelected($slotParagraph(0));
    });

    // The frame's only block is fully selected, so the frame counts as fully
    // selected itself and the second press goes straight to the document
    // instead of re-selecting an identical range.
    editor.dispatchCommand(SELECT_ALL_COMMAND, selectAllKeyboardEvent());
    editor.read(() => {
      $expectFullySelected($getRoot());
    });
  });

  test('$isBlockFullySelected is slot-frame aware instead of throwing', () => {
    using editor = setUpSlotEditor();
    editor.update(
      () => {
        // a selection inside a slot never fully selects a block outside of
        // its frame (and must not throw on the cross-boundary comparison)
        const inSlotCaret = $slotText(0).select(2, 2);
        expect(() =>
          $isBlockFullySelected($getRoot(), inSlotCaret),
        ).not.toThrow();
        expect($isBlockFullySelected($getRoot(), inSlotCaret)).toBe(false);

        // a selection spanning the in-slot block fully selects that block
        const spanning = $slotText(0).select(
          0,
          $slotText(0).getTextContentSize(),
        );
        expect($isBlockFullySelected($slotParagraph(0), spanning)).toBe(true);
        // ...but not its sibling block within the same frame
        expect($isBlockFullySelected($slotParagraph(1), spanning)).toBe(false);

        // the guard holds in the other direction too: a selection outside
        // the slot never fully selects a block inside it
        const outsideText = $getRoot().getFirstDescendant();
        assert($isTextNode(outsideText));
        const outside = outsideText.select(0, outsideText.getTextContentSize());
        expect(() =>
          $isBlockFullySelected($slotParagraph(0), outside),
        ).not.toThrow();
        expect($isBlockFullySelected($slotParagraph(0), outside)).toBe(false);
      },
      {discrete: true},
    );
  });

  test('a block-shaped slot value escalates value, then document', () => {
    // The slot link is a virtual shadow root, so the value need not be a
    // container: a bare paragraph serving as a single-line field is its own
    // block AND its own frame — the first press selects the line, the second
    // goes straight to the document.
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          const host = $createParagraphNode().append(
            $createTextNode('host body'),
          );
          const line = $createParagraphNode().append(
            $createTextNode('the line'),
          );
          $setSlot(host, 'title', line);
          $getRoot().append(
            $createParagraphNode().append($createTextNode('before')),
            host,
          );
        },
        dependencies: [
          RichTextExtension,
          configExtension(SelectBlockExtension, {
            cascadeSelection: false,
            disabled: false,
          }),
        ],
        name: 'select-block-line-slot-test',
        nodes: [],
        register: editor_ => {
          const rootElement = document.createElement('div');
          rootElement.contentEditable = 'true';
          document.body.appendChild(rootElement);
          editor_.setRootElement(rootElement);
          return () => rootElement.remove();
        },
      }),
    );
    editor.update(
      () => {
        const host = $getRoot().getChildAtIndex(1);
        assert($isElementNode(host));
        const line = $getSlot(host, 'title');
        assert(line !== null && $isElementNode(line));
        const text = line.getFirstChild();
        assert($isTextNode(text));
        text.select(3, 3);
      },
      {discrete: true},
    );

    // 1st press: the line itself (it is the scope's only block)
    editor.dispatchCommand(SELECT_ALL_COMMAND, selectAllKeyboardEvent());
    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect(selection.getTextContent()).toBe('the line');
      const frame = $getSlotFrame(selection.anchor.getNode());
      assert(frame !== null);
      expect($isBlockFullySelected($getRoot(), selection)).toBe(false);
    });

    // 2nd press: the frame equals the block, so escalation goes straight to
    // the document with no dead press
    editor.dispatchCommand(SELECT_ALL_COMMAND, selectAllKeyboardEvent());
    editor.read(() => {
      $expectFullySelected($getRoot());
    });
  });

  test('with SelectBlockExtension disabled, the rich-text default scopes select all to the slot', () => {
    using editor = setUpSlotEditor({disabled: true});
    editor.update(
      () => {
        $slotText(0).select(2, 2);
      },
      {discrete: true},
    );

    expect(
      editor.dispatchCommand(SELECT_ALL_COMMAND, selectAllKeyboardEvent()),
    ).toBe(true);
    editor.read(() => {
      // the conservative default selects the whole slot subtree (both
      // in-slot blocks), not just the caret's block...
      $expectFullySelected($slotValue());
      $expectFullySelected($slotParagraph(0));
      $expectFullySelected($slotParagraph(1));
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      // ...without escaping onto the host document
      expect($isBlockFullySelected($getRoot(), selection)).toBe(false);
      $expectSelectionInSlotFrame();
    });

    // outside a slot the default keeps the legacy whole-document semantics
    editor.update(
      () => {
        const text = $getRoot().getFirstDescendant();
        assert($isTextNode(text));
        text.select(3, 3);
      },
      {discrete: true},
    );
    expect(
      editor.dispatchCommand(SELECT_ALL_COMMAND, selectAllKeyboardEvent()),
    ).toBe(true);
    editor.read(() => {
      $expectFullySelected($getRoot());
    });
  });
});
