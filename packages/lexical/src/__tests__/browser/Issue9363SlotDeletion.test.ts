/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSlot,
  COMMAND_PRIORITY_HIGH,
  DecoratorNode,
  ElementNode,
  KEY_DELETE_COMMAND,
  KEY_DOWN_COMMAND,
  type LexicalEditor,
  mountSlotContainer,
  setDOMUnmanaged,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

// Regression tests for #9363: deletion inside a decorator-host slot.

// Narrow enough, in a fixed-advance font, that QUOTE wraps into
// 'aaaa bbbb ' / 'cccc dddd'.
const EDITABLE_WIDTH = '120px';
const EDITABLE_FONT = '16px monospace';
const QUOTE = 'aaaa bbbb cccc dddd';
const ATTRIBUTION = 'Arthur';
const NESTED = 'Nested';

class SlotContainerNode extends ElementNode {
  $config() {
    return this.config('test_9363_slot_container', {extends: ElementNode});
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

// A block decorator host with a multi-paragraph `quote` slot and a
// single-paragraph `attribution` slot, mounted into chrome the way the
// playground's PullQuoteNode does.
class QuoteHostNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_9363_quote_host', {
      extends: DecoratorNode,
      slots: ['quote', 'attribution'],
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

interface Fixture {
  attributionKey: string;
  nestedKey: string;
  editor: LexicalEditor;
  input: HTMLInputElement;
  quoteKey: string;
}

/**
 * Mounts the host's slots into its chrome in model order, in reversed DOM
 * order, or in model DOM order displayed reversed with CSS `order`.
 */
type SlotOrder = 'model' | 'reversed' | 'css-reversed';
function mountEditor(order: SlotOrder = 'model'): Fixture {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const contentEditable = document.createElement('div');
  contentEditable.contentEditable = 'true';
  contentEditable.style.width = EDITABLE_WIDTH;
  contentEditable.style.font = EDITABLE_FONT;
  container.appendChild(contentEditable);

  let hostKey = '';
  let quoteKey = '';
  let attributionKey = '';
  let nestedKey = '';
  let nestedHostKey = '';
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        const host = new QuoteHostNode();
        const quote = $createTextNode(QUOTE);
        const attribution = $createTextNode(ATTRIBUTION);
        // A second decorator host nested in the quote slot.
        const nested = $createTextNode(NESTED);
        const nestedHost = new QuoteHostNode();
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('before')),
            host,
            $createParagraphNode().append($createTextNode('after')),
          );
        $setSlot(
          host,
          'quote',
          new SlotContainerNode().append(
            $createParagraphNode().append(quote),
            nestedHost,
          ),
        );
        $setSlot(
          nestedHost,
          'attribution',
          $createParagraphNode().append(nested),
        );
        $setSlot(
          host,
          'attribution',
          $createParagraphNode().append(attribution),
        );
        hostKey = host.getKey();
        quoteKey = quote.getKey();
        attributionKey = attribution.getKey();
        nestedKey = nested.getKey();
        nestedHostKey = nestedHost.getKey();
      },
      dependencies: [RichTextExtension],
      name: '[9363-browser]',
      nodes: [QuoteHostNode, SlotContainerNode],
    }),
  );
  editor.setRootElement(contentEditable);
  onTestFinished(() => {
    editor.setRootElement(null);
    document.body.removeChild(container);
  });

  const hostDOM = editor.getElementByKey(hostKey);
  assert(hostDOM !== null, 'Expected the host to be rendered');
  const chrome = document.createElement('div');
  const quoteTarget = document.createElement('div');
  const attributionTarget = document.createElement('div');
  // A native control in the host's own chrome, beside its slots.
  const input = document.createElement('input');
  input.value = 'abc';
  if (order === 'reversed') {
    chrome.append(attributionTarget, quoteTarget, input);
  } else {
    chrome.append(quoteTarget, attributionTarget, input);
  }
  if (order === 'css-reversed') {
    chrome.style.display = 'flex';
    chrome.style.flexDirection = 'column';
    attributionTarget.style.order = '-1';
  }
  hostDOM.append(chrome);
  mountSlotContainer(editor, hostKey, 'quote', quoteTarget);
  mountSlotContainer(editor, hostKey, 'attribution', attributionTarget);
  const nestedHostDOM = editor.getElementByKey(nestedHostKey);
  assert(nestedHostDOM !== null, 'Expected the nested host to be rendered');
  mountSlotContainer(editor, nestedHostKey, 'attribution', nestedHostDOM);

  return {attributionKey, editor, input, nestedKey, quoteKey};
}

function selectText(
  {editor}: Fixture,
  key: string,
  anchorOffset: number,
  focusOffset = anchorOffset,
): void {
  editor.update(
    () => {
      const node = $getNodeByKey(key);
      assert($isTextNode(node), 'Expected a TextNode');
      node.select(anchorOffset, focusOffset);
    },
    {discrete: true},
  );
}

function deleteLine({editor}: Fixture, isBackward: boolean): void {
  editor.update(
    () => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected RangeSelection');
      selection.deleteLine(isBackward);
    },
    {discrete: true},
  );
}

function deleteLineAt(
  fixture: Fixture,
  key: string,
  offset: number,
  isBackward: boolean,
): void {
  selectText(fixture, key, offset);
  deleteLine(fixture, isBackward);
}

/** Focuses the slot's editing host and puts the DOM caret in its text. */
function placeCaretInSlot(
  {editor}: Fixture,
  key: string,
  offset: number,
): void {
  const textDOM = editor.getElementByKey(key)?.firstChild;
  assert(textDOM instanceof Text, 'Expected a rendered text node');
  const editingHost = textDOM.parentElement?.closest(
    '[contenteditable="true"]',
  );
  assert(editingHost instanceof HTMLElement, 'Expected an editing host');
  editingHost.focus();
  document.getSelection()?.collapse(textDOM, offset);
}

function textOf({editor}: Fixture, key: string): string | null {
  return editor.read(() => {
    const node = $getNodeByKey(key);
    return $isTextNode(node) && node.isAttached()
      ? node.getTextContent()
      : null;
  });
}

describe.each(['model', 'reversed', 'css-reversed'] as const)(
  'deleteLine inside a decorator-host slot, %s slot order (#9363)',
  order => {
    test('backward from the end of a wrapped line deletes that line', () => {
      const fixture = mountEditor(order);
      deleteLineAt(fixture, fixture.quoteKey, QUOTE.length, true);
      expect(textOf(fixture, fixture.quoteKey)).toBe('aaaa bbbb ');
      expect(textOf(fixture, fixture.attributionKey)).toBe(ATTRIBUTION);
    });

    test('forward from inside a wrapped line deletes to its end', () => {
      const fixture = mountEditor(order);
      deleteLineAt(fixture, fixture.quoteKey, 2, false);
      expect(textOf(fixture, fixture.quoteKey)).toBe('aacccc dddd');
    });

    test('backward from the end of a single-line slot empties it', () => {
      const fixture = mountEditor(order);
      deleteLineAt(fixture, fixture.attributionKey, ATTRIBUTION.length, true);
      expect(textOf(fixture, fixture.attributionKey)).toBe(null);
      expect(textOf(fixture, fixture.quoteKey)).toBe(QUOTE);
    });

    test('at the edges of a slot nothing leaves the slot', () => {
      const fixture = mountEditor(order);
      deleteLineAt(fixture, fixture.nestedKey, NESTED.length, false);
      deleteLineAt(fixture, fixture.nestedKey, 0, true);
      deleteLineAt(fixture, fixture.attributionKey, 0, true);
      deleteLineAt(fixture, fixture.attributionKey, ATTRIBUTION.length, false);
      expect(textOf(fixture, fixture.quoteKey)).toBe(QUOTE);
      expect(textOf(fixture, fixture.nestedKey)).toBe(NESTED);
      expect(textOf(fixture, fixture.attributionKey)).toBe(ATTRIBUTION);
    });

    test('a ranged selection deletes just that range', () => {
      const fixture = mountEditor(order);
      selectText(fixture, fixture.quoteKey, 2, 7);
      deleteLine(fixture, true);
      expect(textOf(fixture, fixture.quoteKey)).toBe('aabb cccc dddd');
      expect(textOf(fixture, fixture.attributionKey)).toBe(ATTRIBUTION);
      fixture.editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        expect(selection.isCollapsed()).toBe(true);
        expect(selection.anchor.key).toBe(fixture.quoteKey);
      });
    });
  },
);

describe('Backspace and Delete inside a decorator-host slot (#9363)', () => {
  test.each([
    ['attribution', '{Delete}', 3, 'Artur'],
    ['attribution', '{Delete}', ATTRIBUTION.length, ATTRIBUTION],
    ['attribution', '{Backspace}', 3, 'Arhur'],
    ['attribution', '{Backspace}', ATTRIBUTION.length, 'Arthu'],
    ['nested', '{Delete}', 1, 'Nsted'],
    ['nested', '{Delete}', NESTED.length, NESTED],
    ['nested', '{Backspace}', 1, 'ested'],
  ] as const)(
    'a plain %s %s at offset %i deletes one character',
    async (slot, key, offset, expected) => {
      const fixture = mountEditor();
      const textKey =
        slot === 'nested' ? fixture.nestedKey : fixture.attributionKey;
      placeCaretInSlot(fixture, textKey, offset);
      await userEvent.keyboard(key);
      expect(textOf(fixture, textKey)).toBe(expected);
      expect(textOf(fixture, fixture.quoteKey)).toBe(QUOTE);
    },
  );

  // When a keydown handler takes the Delete without preventing it, the
  // browser's beforeinput target range reaches Lexical. At the end of a
  // slot Chromium's forward delete range covers the line before the caret.
  test.each([
    ['model', 3, 'Artur'],
    ['model', ATTRIBUTION.length, ATTRIBUTION],
    ['reversed', 3, 'Artur'],
    ['reversed', ATTRIBUTION.length, ATTRIBUTION],
    ['css-reversed', ATTRIBUTION.length, ATTRIBUTION],
  ] as const)(
    'an unprevented Delete in %s slot order at offset %i deletes one character',
    async (order, offset, expected) => {
      const fixture = mountEditor(order);
      onTestFinished(
        fixture.editor.registerCommand(
          KEY_DELETE_COMMAND,
          () => true,
          COMMAND_PRIORITY_HIGH,
        ),
      );
      placeCaretInSlot(fixture, fixture.attributionKey, offset);
      await userEvent.keyboard('{Delete}');
      expect(textOf(fixture, fixture.attributionKey)).toBe(expected);
      expect(textOf(fixture, fixture.quoteKey)).toBe(QUOTE);
    },
  );

  // With Lexical's keydown handling skipped, word deletion is left to the
  // browser and reaches Lexical as a beforeinput with a target range.
  const WORD = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Alt' : 'Control';
  test.each([
    ['Backspace', ATTRIBUTION.length, null],
    ['Delete', 0, null],
    ['Backspace', 0, ATTRIBUTION],
    ['Delete', ATTRIBUTION.length, ATTRIBUTION],
  ] as const)(
    'an unprevented word %s at offset %i stays in the slot',
    async (key, offset, expected) => {
      const fixture = mountEditor();
      onTestFinished(
        fixture.editor.registerCommand(
          KEY_DOWN_COMMAND,
          () => true,
          COMMAND_PRIORITY_HIGH,
        ),
      );
      placeCaretInSlot(fixture, fixture.attributionKey, offset);
      await userEvent.keyboard(`{${WORD}>}{${key}}{/${WORD}}`);
      expect(textOf(fixture, fixture.attributionKey)).toBe(expected);
      expect(textOf(fixture, fixture.quoteKey)).toBe(QUOTE);
    },
  );

  // The keystroke reaches rich text's own handlers, as it does outside slots.
  test('Backspace at the start of an indented slot paragraph outdents it', async () => {
    const fixture = mountEditor();
    fixture.editor.update(
      () => {
        $getNodeByKey(fixture.quoteKey)?.getParentOrThrow().setIndent(1);
      },
      {discrete: true},
    );
    placeCaretInSlot(fixture, fixture.quoteKey, 0);
    await userEvent.keyboard('{Backspace}');
    expect(textOf(fixture, fixture.quoteKey)).toBe(QUOTE);
    fixture.editor.read(() => {
      expect(
        $getNodeByKey(fixture.quoteKey)?.getParentOrThrow().getIndent(),
      ).toBe(0);
    });
  });

  test('Backspace and Delete in a captured control inside a slot edit the control', async () => {
    const fixture = mountEditor();
    const slotContainer = fixture.editor
      .getElementByKey(fixture.attributionKey)
      ?.closest('[data-lexical-slot]');
    assert(slotContainer instanceof HTMLElement, 'Expected a slot container');
    const control = document.createElement('input');
    control.value = 'abc';
    setDOMUnmanaged(control, {captureSelection: true});
    slotContainer.append(control);
    placeCaretInSlot(fixture, fixture.attributionKey, 3);
    await userEvent.keyboard('{Delete}');
    expect(textOf(fixture, fixture.attributionKey)).toBe('Artur');
    control.focus();
    control.setSelectionRange(1, 1);
    await userEvent.keyboard('{Backspace}{Delete}');
    expect(control.value).toBe('c');
    expect(textOf(fixture, fixture.attributionKey)).toBe('Artur');
  });

  test('Backspace and Delete in a native control inside a slot edit the control', async () => {
    const fixture = mountEditor();
    const slotContainer = fixture.editor
      .getElementByKey(fixture.attributionKey)
      ?.closest('[data-lexical-slot]');
    assert(slotContainer instanceof HTMLElement, 'Expected a slot container');
    const control = document.createElement('input');
    control.value = 'abc';
    setDOMUnmanaged(control);
    slotContainer.append(control);
    placeCaretInSlot(fixture, fixture.attributionKey, 3);
    await userEvent.keyboard('{Delete}');
    expect(textOf(fixture, fixture.attributionKey)).toBe('Artur');
    control.focus();
    control.setSelectionRange(1, 1);
    await userEvent.keyboard('{Backspace}{Delete}');
    expect(control.value).toBe('c');
    expect(textOf(fixture, fixture.attributionKey)).toBe('Artur');
  });

  test('Backspace and Delete in a native control of the host edit the control', async () => {
    const fixture = mountEditor();
    placeCaretInSlot(fixture, fixture.attributionKey, 3);
    await userEvent.keyboard('{Delete}');
    expect(textOf(fixture, fixture.attributionKey)).toBe('Artur');
    const {input} = fixture;
    input.focus();
    input.setSelectionRange(1, 1);
    await userEvent.keyboard('{Backspace}{Delete}');
    expect(input.value).toBe('c');
    expect(textOf(fixture, fixture.attributionKey)).toBe('Artur');
  });
});
