/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createListItemNode,
  $createListNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {DraggableBlockPlugin_EXPERIMENTAL} from '@lexical/react/LexicalDraggableBlockPlugin';
import {EditorRefPlugin} from '@lexical/react/LexicalEditorRefPlugin';
import {ListPlugin} from '@lexical/react/LexicalListPlugin';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import * as React from 'react';
import {act, createRef} from 'react';
import {createRoot} from 'react-dom/client';
import {describe, expect, onTestFinished, test} from 'vitest';

// Where the handle lands and where a drop goes depend on the rects of the
// blocks under the pointer. jsdom reports every rect as zero, so this runs
// against a real layout engine.

const MENU_CLASS = 'draggable-block-menu';
const TARGET_LINE_CLASS = 'draggable-block-target-line';

type Structure = string | [string, ...Structure[]];

/** The document as nested text: a paragraph is its text, a list is its type followed by its items (a nested list is the item itself). */
function $structure(node: LexicalNode): Structure {
  if ($isListNode(node)) {
    return [
      node.getListType(),
      ...node.getChildren().map(item => {
        const first = $isElementNode(item) ? item.getFirstChild() : null;
        return $isListNode(first) ? $structure(first) : item.getTextContent();
      }),
    ];
  }
  return node.getTextContent();
}

function $block(text: string) {
  return $createParagraphNode().append($createTextNode(text));
}

function $item(text: string) {
  return $createListItemNode().append($createTextNode(text));
}

function $nested(list: ListNode) {
  return $createListItemNode().append(list);
}

interface Harness {
  editor: LexicalEditor;
  scroller: HTMLElement;
  anchorElem: HTMLElement;
  lastElement: () => HTMLElement | null;
}

function render(): Harness {
  const scroller = document.createElement('div');
  scroller.style.width = '600px';
  scroller.style.padding = '20px';
  const anchorElem = document.createElement('div');
  anchorElem.style.position = 'relative';
  const editorHost = document.createElement('div');
  scroller.append(anchorElem, editorHost);
  document.body.appendChild(scroller);
  const reactRoot = createRoot(editorHost);
  const editorRef =
    createRef<LexicalEditor>() as React.RefObject<LexicalEditor>;
  let lastElement: HTMLElement | null = null;

  function Test() {
    const menuRef = React.useRef<HTMLDivElement | null>(null);
    const targetLineRef = React.useRef<HTMLDivElement | null>(null);
    return (
      <LexicalComposer
        initialConfig={{
          namespace: 'draggable-block',
          nodes: [ListNode, ListItemNode],
          onError: (error: Error) => {
            throw error;
          },
        }}>
        <EditorRefPlugin editorRef={editorRef} />
        <RichTextPlugin
          contentEditable={<ContentEditable />}
          ErrorBoundary={({children}) => <>{children}</>}
        />
        <ListPlugin />
        <DraggableBlockPlugin_EXPERIMENTAL
          anchorElem={anchorElem}
          menuRef={menuRef}
          targetLineRef={targetLineRef}
          menuComponent={<div ref={menuRef} className={MENU_CLASS} />}
          targetLineComponent={
            <div ref={targetLineRef} className={TARGET_LINE_CLASS} />
          }
          isOnMenu={element => element.closest(`.${MENU_CLASS}`) !== null}
          onElementChanged={element => {
            lastElement = element;
          }}
        />
      </LexicalComposer>
    );
  }

  act(() => {
    reactRoot.render(<Test />);
  });
  onTestFinished(() => {
    act(() => {
      reactRoot.unmount();
    });
    scroller.remove();
  });
  return {
    anchorElem,
    editor: editorRef.current,
    lastElement: () => lastElement,
    scroller,
  };
}

/** Paragraph, numbered list with a nested bullet list, paragraph. */
function populate(editor: LexicalEditor): void {
  act(() => {
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $block('Before'),
            $createListNode('number').append(
              $item('One'),
              $item('Two'),
              $nested(
                $createListNode('bullet').append(
                  $item('Nested one'),
                  $item('Nested two'),
                ),
              ),
              $item('Three'),
            ),
            $block('After'),
          );
      },
      {discrete: true},
    );
  });
}

function structure(editor: LexicalEditor): Structure[] {
  return editor.read(() => $getRoot().getChildren().map($structure));
}

function elementWithText(editor: LexicalEditor, text: string): HTMLElement {
  const root = editor.getRootElement()!;
  for (const candidate of root.querySelectorAll<HTMLElement>('p, li')) {
    // The item's own text, not a nested list's.
    const ownText = Array.from(candidate.childNodes)
      .filter(child => child.nodeName !== 'UL' && child.nodeName !== 'OL')
      .map(child => child.textContent)
      .join('');
    if (ownText === text) {
      return candidate;
    }
  }
  throw new Error(`No block with text ${JSON.stringify(text)}`);
}

/** Moves the mouse over the vertical middle of `elem`, at its left edge. */
function hover({scroller}: Harness, elem: HTMLElement): void {
  const rect = elem.getBoundingClientRect();
  act(() => {
    scroller.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: rect.left + 1,
        clientY: rect.top + rect.height / 2,
      }),
    );
  });
}

/**
 * Drags the block under `from` by its handle and drops it at the bottom edge
 * of `to`, which the plugin reads as "after `to`".
 */
function dragAfter(harness: Harness, from: HTMLElement, to: HTMLElement): void {
  const {anchorElem, editor} = harness;
  hover(harness, from);
  expect(harness.lastElement()).toBe(from);
  const handle = anchorElem.querySelector<HTMLElement>(`.${MENU_CLASS}`)!;
  const dataTransfer = new DataTransfer();
  act(() => {
    handle.dispatchEvent(
      new DragEvent('dragstart', {bubbles: true, dataTransfer}),
    );
  });
  const rect = to.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + 5,
    clientY: rect.bottom - 1,
    dataTransfer,
  };
  const rootElement = editor.getRootElement()!;
  act(() => {
    rootElement.dispatchEvent(new DragEvent('dragover', init));
  });
  act(() => {
    rootElement.dispatchEvent(new DragEvent('drop', init));
  });
  act(() => {
    handle.dispatchEvent(new DragEvent('dragend', {bubbles: true}));
  });
}

function targetLineLeft({anchorElem}: Harness): number {
  const line = anchorElem.querySelector<HTMLElement>(`.${TARGET_LINE_CLASS}`)!;
  const match = /translate\((-?[\d.]+)px/.exec(line.style.transform);
  expect(match).not.toBeNull();
  return parseFloat(match![1]);
}

describe('DraggableBlockPlugin_EXPERIMENTAL with lists', () => {
  test('the handle targets the list item under the pointer, at any depth', () => {
    const harness = render();
    const {editor} = harness;
    populate(editor);

    hover(harness, elementWithText(editor, 'Before'));
    expect(harness.lastElement()).toBe(elementWithText(editor, 'Before'));

    hover(harness, elementWithText(editor, 'Two'));
    expect(harness.lastElement()).toBe(elementWithText(editor, 'Two'));

    hover(harness, elementWithText(editor, 'Nested two'));
    expect(harness.lastElement()).toBe(elementWithText(editor, 'Nested two'));
  });

  test('reorders items within a list', () => {
    const harness = render();
    const {editor} = harness;
    populate(editor);

    dragAfter(
      harness,
      elementWithText(editor, 'One'),
      elementWithText(editor, 'Two'),
    );

    expect(structure(editor)).toEqual([
      'Before',
      ['number', 'Two', 'One', ['bullet', 'Nested one', 'Nested two'], 'Three'],
      'After',
    ]);
  });

  test('reorders items within a nested list', () => {
    const harness = render();
    const {editor} = harness;
    populate(editor);

    dragAfter(
      harness,
      elementWithText(editor, 'Nested one'),
      elementWithText(editor, 'Nested two'),
    );

    expect(structure(editor)).toEqual([
      'Before',
      ['number', 'One', 'Two', ['bullet', 'Nested two', 'Nested one'], 'Three'],
      'After',
    ]);
  });

  test('moves an item between lists of different depth and type', () => {
    const harness = render();
    const {editor} = harness;
    populate(editor);

    dragAfter(
      harness,
      elementWithText(editor, 'Nested two'),
      elementWithText(editor, 'Three'),
    );
    expect(structure(editor)).toEqual([
      'Before',
      ['number', 'One', 'Two', ['bullet', 'Nested one'], 'Three', 'Nested two'],
      'After',
    ]);

    dragAfter(
      harness,
      elementWithText(editor, 'One'),
      elementWithText(editor, 'Nested one'),
    );
    expect(structure(editor)).toEqual([
      'Before',
      ['number', 'Two', ['bullet', 'Nested one', 'One'], 'Three', 'Nested two'],
      'After',
    ]);
  });

  test('an item dropped outside a list gets a list of the same type', () => {
    const harness = render();
    const {editor} = harness;
    populate(editor);

    dragAfter(
      harness,
      elementWithText(editor, 'Three'),
      elementWithText(editor, 'After'),
    );

    expect(structure(editor)).toEqual([
      'Before',
      ['number', 'One', 'Two', ['bullet', 'Nested one', 'Nested two']],
      'After',
      ['number', 'Three'],
    ]);
  });

  test('a paragraph dropped on a list item lands next to the whole list', () => {
    const harness = render();
    const {editor} = harness;
    populate(editor);

    dragAfter(
      harness,
      elementWithText(editor, 'Before'),
      elementWithText(editor, 'Nested one'),
    );

    expect(structure(editor)).toEqual([
      ['number', 'One', 'Two', ['bullet', 'Nested one', 'Nested two'], 'Three'],
      'Before',
      'After',
    ]);
  });

  test('the drop line is indented to the target item', () => {
    const harness = render();
    const {anchorElem, editor} = harness;
    populate(editor);

    const from = elementWithText(editor, 'One');
    hover(harness, from);
    const handle = anchorElem.querySelector<HTMLElement>(`.${MENU_CLASS}`)!;
    const dataTransfer = new DataTransfer();
    act(() => {
      handle.dispatchEvent(
        new DragEvent('dragstart', {bubbles: true, dataTransfer}),
      );
    });
    const rootElement = editor.getRootElement()!;
    function dragOver(elem: HTMLElement) {
      const rect = elem.getBoundingClientRect();
      act(() => {
        rootElement.dispatchEvent(
          new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + 5,
            clientY: rect.bottom - 1,
            dataTransfer,
          }),
        );
      });
    }

    dragOver(elementWithText(editor, 'Two'));
    const topLevelLeft = targetLineLeft(harness);
    dragOver(elementWithText(editor, 'Nested one'));
    expect(targetLineLeft(harness)).toBeGreaterThan(topLevelLeft);

    act(() => {
      handle.dispatchEvent(new DragEvent('dragend', {bubbles: true}));
    });
  });
});
