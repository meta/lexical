/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  NormalizeTripleClickSelectionExtension,
} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  defineExtension,
  type LexicalEditor,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical';
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

function setUpEditor() {
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Paragraph 1')),
          $createParagraphNode().append($createTextNode('Paragraph 2')),
        );
      },
      dependencies: [NormalizeTripleClickSelectionExtension],
      name: 'normalize-triple-click-selection-test',
      register: ed => {
        const rootElement = document.createElement('div');
        rootElement.contentEditable = 'true';
        document.body.appendChild(rootElement);
        ed.setRootElement(rootElement);
        return () => {
          ed.setRootElement(null);
          rootElement.remove();
        };
      },
    }),
  );
  // Render the initial paragraphs before selecting into them
  editor.read(() => {});
  return editor;
}

/**
 * What a triple click selects: all of paragraph 1 up to the start of
 * paragraph 2, put in the DOM and reported with a selectionchange event the
 * way the browser does
 */
function overselect(editor: LexicalEditor) {
  const rootElement = editor.getRootElement()!;
  const [p1, p2] = rootElement.children;
  const domSelection = document.getSelection()!;
  domSelection.setBaseAndExtent(p1.firstChild!.firstChild!, 0, p2, 0);
  document.dispatchEvent(new Event('selectionchange'));
  editor.read(() => {});
}

/** The same selection, made by code (like undo or a collab update) */
function overselectByCode(editor: LexicalEditor) {
  editor.update(
    () => {
      const [p1, p2] = $getRoot().getChildren();
      assert($isParagraphNode(p1));
      const text = p1.getFirstChildOrThrow();
      assert($isTextNode(text));
      text.select(0, 0);
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.focus.set(p2.getKey(), 0, 'element');
      }
    },
    {discrete: true},
  );
}

function readFocus(editor: LexicalEditor) {
  return editor.read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      return null;
    }
    return {
      offset: selection.focus.offset,
      text: selection.focus.getNode().getTextContent(),
    };
  });
}

function mouseDown(editor: LexicalEditor, detail: number) {
  editor
    .getRootElement()!
    .dispatchEvent(
      new MouseEvent('mousedown', {bubbles: true, cancelable: true, detail}),
    );
}

const FIXED = {offset: 'Paragraph 1'.length, text: 'Paragraph 1'};
const OVERSELECTED = {offset: 0, text: 'Paragraph 2'};

describe('NormalizeTripleClickSelectionExtension', () => {
  beforeEach(() => {
    vi.useFakeTimers({toFake: ['Date']});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('trims the selection change that follows a triple click', () => {
    using editor = setUpEditor();
    mouseDown(editor, 3);
    overselect(editor);
    expect(readFocus(editor)).toEqual(FIXED);
  });

  test('trims the selection change however late it arrives', () => {
    using editor = setUpEditor();
    mouseDown(editor, 3);
    vi.advanceTimersByTime(1000);
    overselect(editor);
    expect(readFocus(editor)).toEqual(FIXED);
  });

  test('trims a triple click on formatted text', () => {
    using editor = setUpEditor();
    editor.update(
      () => {
        for (const paragraph of $getRoot().getChildren()) {
          assert($isParagraphNode(paragraph));
          const text = paragraph.getFirstChildOrThrow();
          assert($isTextNode(text));
          text.setFormat('bold').setStyle('color: red');
        }
      },
      {discrete: true},
    );
    mouseDown(editor, 3);
    overselect(editor);
    expect(readFocus(editor)).toEqual(FIXED);
  });

  test('trims after a fourth click', () => {
    using editor = setUpEditor();
    mouseDown(editor, 4);
    overselect(editor);
    expect(readFocus(editor)).toEqual(FIXED);
  });

  test('only trims the first selection change', () => {
    using editor = setUpEditor();
    mouseDown(editor, 3);
    overselect(editor);
    editor.update(() => $getRoot().selectStart(), {discrete: true});
    overselect(editor);
    expect(readFocus(editor)).toEqual(OVERSELECTED);
  });

  test('a keydown cancels it', () => {
    using editor = setUpEditor();
    mouseDown(editor, 3);
    editor
      .getRootElement()!
      .dispatchEvent(new KeyboardEvent('keydown', {bubbles: true}));
    overselect(editor);
    expect(readFocus(editor)).toEqual(OVERSELECTED);
  });

  test('a single or double click cancels it', () => {
    for (const detail of [1, 2]) {
      using editor = setUpEditor();
      mouseDown(editor, 3);
      mouseDown(editor, detail);
      overselect(editor);
      expect(readFocus(editor)).toEqual(OVERSELECTED);
    }
  });

  test('a modifier key on its own does not cancel it', () => {
    using editor = setUpEditor();
    mouseDown(editor, 3);
    for (const key of ['Control', 'Alt', 'Shift', 'Meta']) {
      editor
        .getRootElement()!
        .dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key}));
    }
    overselect(editor);
    expect(readFocus(editor)).toEqual(FIXED);
  });

  test('a click or keydown outside the editor cancels it', () => {
    for (const event of [
      new MouseEvent('mousedown', {bubbles: true, detail: 1}),
      new KeyboardEvent('keydown', {bubbles: true, key: 'z'}),
    ]) {
      using editor = setUpEditor();
      mouseDown(editor, 3);
      const toolbar = document.createElement('button');
      document.body.appendChild(toolbar);
      toolbar.dispatchEvent(event);
      toolbar.remove();
      overselect(editor);
      expect(readFocus(editor)).toEqual(OVERSELECTED);
    }
  });

  test('a triple click outside the editor does not arm it', () => {
    using editor = setUpEditor();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(
      new MouseEvent('mousedown', {bubbles: true, detail: 3}),
    );
    outside.remove();
    overselect(editor);
    expect(readFocus(editor)).toEqual(OVERSELECTED);
  });

  test('still trims the triple click after a selection change made by code', () => {
    // The browser applied its selection, then code changed Lexical's selection
    // without writing it to the DOM before the late selectionchange arrived
    using editor = setUpEditor();
    const [p1, p2] = editor.getRootElement()!.children;
    mouseDown(editor, 3);
    document
      .getSelection()!
      .setBaseAndExtent(p1.firstChild!.firstChild!, 0, p2, 0);
    editor.update(() => $getRoot().selectEnd(), {
      discrete: true,
      tag: SKIP_DOM_SELECTION_TAG,
    });
    document.dispatchEvent(new Event('selectionchange'));
    editor.read(() => {});
    expect(readFocus(editor)).toEqual(FIXED);
  });

  test('does not trim a selection change made by code', () => {
    using editor = setUpEditor();
    mouseDown(editor, 3);
    overselectByCode(editor);
    expect(readFocus(editor)).toEqual(OVERSELECTED);
  });

  test('a pointerdown cancels it, even without a mousedown', () => {
    using editor = setUpEditor();
    mouseDown(editor, 3);
    const toolbar = document.createElement('button');
    document.body.appendChild(toolbar);
    toolbar.dispatchEvent(new Event('pointerdown', {bubbles: true}));
    toolbar.remove();
    overselect(editor);
    expect(readFocus(editor)).toEqual(OVERSELECTED);
  });

  test('does not trim a selection set by code once it reaches the DOM', () => {
    // A third-click handler that prevents the native selection and sets its
    // own: its selectionchange from the DOM must not be trimmed either
    using editor = setUpEditor();
    const rootElement = editor.getRootElement()!;
    const preventTripleClick = (event: MouseEvent) => {
      if (event.detail > 2) {
        event.preventDefault();
      }
    };
    rootElement.addEventListener('mousedown', preventTripleClick);
    mouseDown(editor, 3);
    rootElement.removeEventListener('mousedown', preventTripleClick);
    overselectByCode(editor);
    rootElement.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
    document.dispatchEvent(new Event('selectionchange'));
    editor.read(() => {});
    expect(readFocus(editor)).toEqual(OVERSELECTED);
  });

  test('does not trim a selection set by code after the mouseup', () => {
    // The native selection was applied (and reported late), then a click
    // handler replaced it with its own before the selectionchange arrived
    using editor = setUpEditor();
    const rootElement = editor.getRootElement()!;
    mouseDown(editor, 3);
    const [p1] = rootElement.children;
    document
      .getSelection()!
      .setBaseAndExtent(p1.firstChild!.firstChild!, 0, p1, 1);
    rootElement.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
    overselectByCode(editor);
    document.dispatchEvent(new Event('selectionchange'));
    editor.read(() => {});
    expect(readFocus(editor)).toEqual(OVERSELECTED);
  });

  test('does not trim a selection set by code while the button is held', () => {
    // The fourth click's native selection was already reported, then code set
    // its own selection before the mouseup and its DOM update was reported
    using editor = setUpEditor();
    mouseDown(editor, 4);
    overselectByCode(editor);
    document.dispatchEvent(new Event('selectionchange'));
    editor.read(() => {});
    expect(readFocus(editor)).toEqual(OVERSELECTED);
  });

  test('trims a native selection reported after the mouseup', () => {
    using editor = setUpEditor();
    const rootElement = editor.getRootElement()!;
    const [p1, p2] = rootElement.children;
    mouseDown(editor, 3);
    document
      .getSelection()!
      .setBaseAndExtent(p1.firstChild!.firstChild!, 0, p2, 0);
    rootElement.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
    document.dispatchEvent(new Event('selectionchange'));
    editor.read(() => {});
    expect(readFocus(editor)).toEqual(FIXED);
  });

  test('does nothing without a triple click', () => {
    using editor = setUpEditor();
    overselect(editor);
    expect(readFocus(editor)).toEqual(OVERSELECTED);
  });
});
