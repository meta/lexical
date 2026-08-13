/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Tests for the iOS Enter + text-replacement acceptance boundary.
 *
 * $maybeMoveSelectionPastTrailingAcceptanceBoundary compensates for Chrome and
 * Firefox, which fire the input event for the key press that triggered the
 * acceptance *before* the one for the replacement text, leaving the caret before
 * the acceptance boundary.
 *
 * iOS fires them in the opposite order — insertReplacementText first, then
 * insertParagraph. The paragraph has therefore not been split yet, so the block
 * the caret sits in still has its original next sibling. Moving the caret there
 * makes the following insertParagraph split *that* block instead, leaving the
 * caret one block further down than a single Enter should have taken it.
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  isDOMTextNode,
  isHTMLElement,
  type LexicalEditor,
  type LexicalEditorWithDispose,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test, vi} from 'vitest';

// `vi.mock` is hoisted above all imports, so LexicalEvents.ts observes
// IS_IOS=true and CAN_USE_BEFORE_INPUT=true.
vi.mock('lexical/src/environment', () => ({
  CAN_USE_BEFORE_INPUT: true,
  CAN_USE_DOM: true,
  IS_ANDROID: false,
  IS_ANDROID_CHROME: false,
  IS_APPLE: true,
  IS_APPLE_WEBKIT: true,
  IS_CHROME: false,
  IS_FIREFOX: false,
  IS_IOS: true,
  IS_SAFARI: true,
}));

function createBeforeInputEvent(
  inputType: string,
  {
    data,
    dataTransferText,
    targetRanges = [],
  }: {
    data?: string;
    dataTransferText?: string;
    targetRanges?: StaticRange[];
  } = {},
): InputEvent {
  const event = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data,
    inputType,
  });
  // jsdom's InputEvent exposes neither of these; patch them manually.
  Object.defineProperty(event, 'getTargetRanges', {
    value: () => targetRanges,
  });
  if (dataTransferText !== undefined) {
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        getData: (type: string) =>
          type === 'text/plain' ? dataTransferText : '',
      },
    });
  }
  return event;
}

/**
 * A paragraph containing "Abc" with the caret at its end, optionally followed by
 * another paragraph. The following block is what makes the bug observable — with
 * nothing after it, getNextSibling() is null and the correction is a no-op.
 */
function editorWithParagraphs(
  followingParagraphText: string | null,
): LexicalEditorWithDispose {
  return buildEditorFromExtensions({
    $initialEditorState: () => {
      const first = $createTextNode('Abc');
      $getRoot().append($createParagraphNode().append(first));
      if (followingParagraphText !== null) {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode(followingParagraphText),
          ),
        );
      }
      first.select(3, 3);
    },
    afterRegistration: editor => {
      const container = document.createElement('div');
      container.setAttribute('data-lexical-editor', 'true');
      container.contentEditable = 'true';
      document.body.appendChild(container);
      editor.setRootElement(container);
      return () => {
        editor.setRootElement(null);
        document.body.removeChild(container);
      };
    },
    dependencies: [RichTextExtension],
    name: '[test]',
  });
}

/** The DOM text node backing the editor's first text node. */
function firstDOMTextNode(editor: LexicalEditor): Text {
  return editor.read('latest', () => {
    const node = $assertNodeType($getRoot().getFirstDescendant(), $isTextNode);
    const el = editor.getElementByKey(node.getKey());
    assert(isHTMLElement(el));
    const textNode = el.firstChild;
    assert(isDOMTextNode(textNode));
    return textNode;
  });
}

/**
 * Replays the event sequence iOS produces when Enter accepts the "Abc" -> "ABC"
 * replacement: keydown Enter, then insertReplacementText, then insertParagraph.
 */
function acceptReplacementWithEnter(editor: LexicalEditor): void {
  const root = editor.getRootElement()!;
  const domText = firstDOMTextNode(editor);

  root.dispatchEvent(
    new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    }),
  );
  root.dispatchEvent(
    createBeforeInputEvent('insertReplacementText', {
      // The replacement covers the whole "Abc" that the user typed.
      dataTransferText: 'ABC',
      targetRanges: [
        new StaticRange({
          endContainer: domText,
          endOffset: 3,
          startContainer: domText,
          startOffset: 0,
        }),
      ],
    }),
  );
  root.dispatchEvent(createBeforeInputEvent('insertParagraph'));
}

describe('iOS Enter accepting a text replacement', () => {
  test('leaves the caret in the new paragraph when a block already follows', () => {
    using editor = editorWithParagraphs('Zzz');

    acceptReplacementWithEnter(editor);

    editor.read('force-commit', () => {
      const children = $getRoot().getChildren();
      expect(children.map(child => child.getTextContent())).toEqual([
        'ABC',
        '',
        'Zzz',
      ]);

      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if (!$isRangeSelection(selection)) {
        return;
      }
      // The caret must land in the newly inserted middle paragraph — not in the
      // "Zzz" block that already followed.
      expect(selection.anchor.getNode().getKey()).toBe(children[1].getKey());
      expect(selection.anchor.offset).toBe(0);
    });
  });

  test('is unchanged when the paragraph is the last block', () => {
    // getNextSibling() is null here, so the correction was already a no-op and
    // this case behaved correctly before the fix. Pinned so a future change to
    // the guard cannot regress it.
    using editor = editorWithParagraphs(null);

    acceptReplacementWithEnter(editor);

    editor.read('force-commit', () => {
      const children = $getRoot().getChildren();
      expect(children.map(child => child.getTextContent())).toEqual([
        'ABC',
        '',
      ]);

      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if (!$isRangeSelection(selection)) {
        return;
      }
      expect(selection.anchor.getNode().getKey()).toBe(children[1].getKey());
      expect(selection.anchor.offset).toBe(0);
    });
  });
});
