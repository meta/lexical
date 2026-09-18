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
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  DecoratorNode,
  type LexicalEditor,
} from 'lexical';
import {afterEach, assert, describe, expect, test, vi} from 'vitest';

// Regression tests for #9100.
//
// Where a line soft-wraps, one DOM offset has two visual caret positions —
// the end of the wrapped line and the start of the next — and which of them
// the caret takes is engine state that the DOM selection API does not
// expose. Firefox spends the first `Selection.modify('move'|'extend',
// 'backward', 'character')` call flipping between the two rather than moving,
// so the collapsed caret measurement that `deleteCharacter` relies on
// reported that the caret had not moved and Backspace deleted nothing.
//
// This has to run in a real browser (see the `browser` project in
// vitest.config.mts) because it needs a real layout engine to wrap the line
// at all, and the failure only reproduces on Firefox
// (VITEST_BROWSER=firefox); on the other engines these are non-regression
// tests for the extra `modify` call the fix adds.

// Narrow enough, in a fixed-advance font, that the text below wraps into
// three lines whatever the platform's default font happens to be.
const EDITABLE_WIDTH = '120px';
const EDITABLE_FONT = '16px monospace';
const WRAPPED_TEXT = 'aaaa bbbb cccc dddd';

/**
 * An inline decorator that refuses traversal and deletion: both
 * `deleteCharacter` and the decorator pre-pass in
 * `$modifySelectionAroundDecoratorsAndBlocks` special-case `isIsolated()`,
 * and the latter falls through to the native caret measurement for one
 * rather than resolving the movement in the model.
 */
class IsolatedInlineDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_isolated_inline_decorator', {
      extends: DecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.contentEditable = 'false';
    span.style.display = 'inline-block';
    span.style.width = '24px';
    span.style.height = '16px';
    return span;
  }
  updateDOM(): boolean {
    return false;
  }
  isInline(): boolean {
    return true;
  }
  isIsolated(): boolean {
    return true;
  }
  decorate(): null {
    return null;
  }
}

interface MountedEditor {
  dispose: () => void;
  editor: LexicalEditor;
}

function mountEditor($initialEditorState: () => void): MountedEditor {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const contentEditable = document.createElement('div');
  contentEditable.contentEditable = 'true';
  contentEditable.style.width = EDITABLE_WIDTH;
  contentEditable.style.font = EDITABLE_FONT;
  contentEditable.style.whiteSpace = 'pre-wrap';
  container.appendChild(contentEditable);

  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState,
      dependencies: [RichTextExtension],
      name: '[9100-browser]',
      nodes: [IsolatedInlineDecoratorNode],
    }),
  );
  editor.setRootElement(contentEditable);

  return {
    dispose: () => {
      editor.setRootElement(null);
      document.body.removeChild(container);
    },
    editor,
  };
}

function $initWithText(text: string, offset: number): void {
  const paragraph = $createParagraphNode();
  const textNode = $createTextNode(text);
  paragraph.append(textNode);
  $getRoot().clear().append(paragraph);
  textNode.select(offset, offset);
}

function deleteCharacter(editor: LexicalEditor, isBackward: boolean): void {
  editor.update(
    () => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected RangeSelection');
      selection.deleteCharacter(isBackward);
    },
    {discrete: true},
  );
}

function textContent(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $getRoot().getTextContent());
}

/**
 * The rendered top of the caret at each offset of the editor's only text
 * node, as the layout engine reports it. An offset whose top differs from
 * its predecessor's starts a new visual line.
 */
function caretTops(editor: LexicalEditor): number[] {
  const {key, size} = editor.read(() => {
    const textNode = $getRoot().getAllTextNodes()[0];
    return {key: textNode.getKey(), size: textNode.getTextContentSize()};
  });
  const domText = editor.getElementByKey(key)!.firstChild!;
  const range = document.createRange();
  const tops: number[] = [];
  for (let offset = 0; offset <= size; offset++) {
    range.setStart(domText, offset);
    range.setEnd(domText, offset);
    tops.push(Math.round(range.getBoundingClientRect().top));
  }
  return tops;
}

/**
 * The offsets at which the text soft-wraps: the last offset of each visual
 * line but the last, i.e. the ambiguous positions this issue is about. The
 * caret rect at such an offset is still reported on the line that ends
 * there, so the wrap offset is the one before each change of line.
 */
function wrapOffsets(tops: number[]): number[] {
  const offsets: number[] = [];
  for (let offset = 1; offset < tops.length; offset++) {
    if (tops[offset] !== tops[offset - 1]) {
      offsets.push(offset - 1);
    }
  }
  return offsets;
}

function withEditorAt<T>(offset: number, fn: (editor: LexicalEditor) => T): T {
  const {editor, dispose} = mountEditor(() =>
    $initWithText(WRAPPED_TEXT, offset),
  );
  try {
    return fn(editor);
  } finally {
    dispose();
  }
}

describe('deletion at a soft line-wrap boundary (#9100)', () => {
  test('the fixture wraps into more than one line', () => {
    const offsets = withEditorAt(0, editor => wrapOffsets(caretTops(editor)));
    // Every wrap offset must be interior, or the deletions below would be
    // testing a block merge instead of a character deletion.
    expect(offsets.length).toBeGreaterThan(0);
    for (const offset of offsets) {
      expect(offset).toBeGreaterThan(0);
      expect(offset).toBeLessThan(WRAPPED_TEXT.length);
    }
  });

  test('backspace deletes exactly one character at every offset', () => {
    for (let offset = 1; offset <= WRAPPED_TEXT.length; offset++) {
      withEditorAt(offset, editor => {
        deleteCharacter(editor, true);
        expect(textContent(editor), `backspace at offset ${offset}`).toBe(
          WRAPPED_TEXT.slice(0, offset - 1) + WRAPPED_TEXT.slice(offset),
        );
      });
    }
  });

  test('delete forward removes exactly one character at every offset', () => {
    for (let offset = 0; offset < WRAPPED_TEXT.length; offset++) {
      withEditorAt(offset, editor => {
        deleteCharacter(editor, false);
        expect(textContent(editor), `delete at offset ${offset}`).toBe(
          WRAPPED_TEXT.slice(0, offset) + WRAPPED_TEXT.slice(offset + 1),
        );
      });
    }
  });
});

describe('an isolated decorator stops the caret on every engine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Not a #9100 case, but the shape that decided the guard on the retry
   * above, so it is pinned here next to it.
   *
   * `isIsolated()` used to leave caret movement to the engine: the decorator
   * pre-pass declined to hop over an isolated decorator and returned false,
   * so the movement fell through to the native measurement, where Firefox
   * stepped over the decorator and Chromium reported no movement at all —
   * trapping the caret with no way past it by keyboard. It is now resolved in
   * the model, so the caret stops on the near side on every engine and the
   * native measurement is never consulted.
   */
  test('the caret does not cross it, and the engine is not asked', () => {
    const {editor, dispose} = mountEditor(() => {
      const paragraph = $createParagraphNode();
      paragraph.append(
        $createTextNode('abc'),
        $create(IsolatedInlineDecoratorNode),
        $createTextNode('def'),
      );
      $getRoot().clear().append(paragraph);
      // The element point between the decorator and 'def'.
      paragraph.select(2, 2);
    });
    try {
      // Wrap (not replace) the engine's real implementation, so a movement
      // would still happen and only the call is observed.
      const modifySpy = vi.spyOn(Selection.prototype, 'modify');
      for (let i = 0; i < 3; i++) {
        editor.update(
          () => {
            const selection = $getSelection();
            assert($isRangeSelection(selection), 'Expected RangeSelection');
            selection.modify('move', true, 'character');
          },
          {discrete: true},
        );
      }
      const landed = editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        const {focus} = selection;
        return `${focus.getNode().getType()} ${focus.type}:${focus.offset}`;
      });
      // The starting point, untouched: the caret has neither crossed the
      // decorator into 'abc' nor been round-tripped through the DOM into the
      // equivalent text point at the start of 'def'.
      expect(landed).toBe('paragraph element:2');
      expect(modifySpy).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
