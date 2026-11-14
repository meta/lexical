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
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {
  type DraggableBlockBehavior,
  DraggableBlockPlugin_EXPERIMENTAL,
} from '@lexical/react/LexicalDraggableBlockPlugin';
import {EditorRefPlugin} from '@lexical/react/LexicalEditorRefPlugin';
import {ListPlugin} from '@lexical/react/LexicalListPlugin';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $setSlot,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
  mountSlotContainer,
} from 'lexical';
import * as React from 'react';
import {act, createRef, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {describe, expect, onTestFinished, test} from 'vitest';

// Where the handle lands and where a drop goes depend on the rects of the
// blocks under the pointer. jsdom reports every rect as zero, so this runs
// against a real layout engine.

const MENU_CLASS = 'draggable-block-menu';
const TARGET_LINE_CLASS = 'draggable-block-target-line';

type Structure = string | [string, ...Structure[]];

/**
 * The document as nested text: a paragraph is its text, a list is its type
 * followed by its items (a nested list is the item itself), any other block
 * that holds blocks is its type followed by its named slots and its children.
 */
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
  const nested = [
    ...$getSlotNames(node).map(name => $getSlot(node, name)),
    ...($isElementNode(node) ? node.getChildren() : []),
  ].filter(
    (child): child is ElementNode => $isElementNode(child) && !child.isInline(),
  );
  if (nested.length > 0) {
    return [node.getType(), ...nested.map($structure)];
  }
  return node.getTextContent();
}

/** A div with a class, so that a test can find its element. */
class TestBlockNode extends ElementNode {
  createDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = this.getType();
    return div;
  }
  updateDOM(): false {
    return false;
  }
}

/** Shaped like a collapsible: a shadow root that holds a title and a body. */
class SectionNode extends TestBlockNode {
  $config() {
    return this.config('test-section', {extends: ElementNode});
  }
  isShadowRoot(): true {
    return true;
  }
}

class SectionTitleNode extends TestBlockNode {
  $config() {
    return this.config('test-section-title', {extends: ElementNode});
  }
}

/** A shadow root that holds any blocks: the body of a section, or a multi-block slot value. */
class RegionNode extends TestBlockNode {
  $config() {
    return this.config('test-region', {extends: ElementNode});
  }
  isShadowRoot(): true {
    return true;
  }
}

/** A host of two named slots: a single-line `caption` and a multi-block `content`. */
class FigureNode extends TestBlockNode {
  $config() {
    return this.config('test-figure', {
      extends: ElementNode,
      slots: ['caption', 'content'],
    });
  }
}

/** Reveals the slots of every figure inside the figure's own element. */
function FigureSlotsPlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      editor.registerMutationListener(
        FigureNode,
        mutations => {
          for (const [nodeKey, mutation] of mutations) {
            const hostDom = editor.getElementByKey(nodeKey);
            if (mutation !== 'destroyed' && hostDom !== null) {
              mountSlotContainer(editor, nodeKey, 'caption', hostDom);
              mountSlotContainer(editor, nodeKey, 'content', hostDom);
            }
          }
        },
        {skipInitialization: false},
      ),
    [editor],
  );
  return null;
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

function render(
  $getBlockBehavior?: (node: LexicalNode) => DraggableBlockBehavior | null,
): Harness {
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
          nodes: [
            ListNode,
            ListItemNode,
            SectionNode,
            SectionTitleNode,
            RegionNode,
            FigureNode,
          ],
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
        <FigureSlotsPlugin />
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
          $getBlockBehavior={$getBlockBehavior}
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
 * of `to`, which the plugin reads as "after `to`". `dragged` is the block
 * that the handle over `from` belongs to, when that is not `from` itself.
 */
function dragAfter(
  harness: Harness,
  from: HTMLElement,
  to: HTMLElement,
  dragged: HTMLElement = from,
): void {
  const {anchorElem, editor} = harness;
  hover(harness, from);
  expect(harness.lastElement()).toBe(dragged);
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

  test('a list does not stay behind empty when its only item is dragged out', () => {
    const harness = render();
    const {editor} = harness;
    act(() => {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $createListNode('number').append(
                $item('One'),
                $nested($createListNode('bullet').append($item('Only'))),
              ),
              $block('After'),
              $createListNode('check').append($item('Alone')),
            );
        },
        {discrete: true},
      );
    });

    dragAfter(
      harness,
      elementWithText(editor, 'Only'),
      elementWithText(editor, 'One'),
    );
    expect(structure(editor)).toEqual([
      ['number', 'One', 'Only'],
      'After',
      ['check', 'Alone'],
    ]);

    dragAfter(
      harness,
      elementWithText(editor, 'Alone'),
      elementWithText(editor, 'Only'),
    );
    expect(structure(editor)).toEqual([
      ['number', 'One', 'Only', 'Alone'],
      'After',
    ]);
  });

  test('an item dropped on the upper half of the first nested item becomes the first nested item', () => {
    const harness = render();
    const {anchorElem, editor} = harness;
    populate(editor);
    const from = elementWithText(editor, 'Three');
    const to = elementWithText(editor, 'Nested one');

    hover(harness, from);
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
      clientY: rect.top + 2,
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

    expect(structure(editor)).toEqual([
      'Before',
      ['number', 'One', 'Two', ['bullet', 'Three', 'Nested one', 'Nested two']],
      'After',
    ]);
  });

  test('finds the item under the pointer in a long list, from the gutter too', () => {
    const harness = render();
    const {anchorElem, editor, scroller} = harness;
    act(() => {
      editor.update(
        () => {
          const list = $createListNode('bullet');
          for (let i = 0; i < 200; i++) {
            list.append($item(`Item ${i}`));
          }
          $getRoot().clear().append($block('Before'), list, $block('After'));
        },
        {discrete: true},
      );
    });

    for (const text of ['Item 0', 'Item 1', 'Item 137', 'Item 199']) {
      const item = elementWithText(editor, text);
      hover(harness, item);
      expect(harness.lastElement()).toBe(item);

      const rect = item.getBoundingClientRect();
      act(() => {
        scroller.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            clientX: anchorElem.getBoundingClientRect().left + 1,
            clientY: rect.top + rect.height / 2,
          }),
        );
      });
      expect(harness.lastElement()).toBe(item);
    }
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

/** Paragraph, section (title, body of two paragraphs), paragraph. */
function populateSection(editor: LexicalEditor): void {
  act(() => {
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $block('Before'),
            $create(SectionNode).append(
              $create(SectionTitleNode).append($createTextNode('Title')),
              $create(RegionNode).append(
                $block('Body one'),
                $block('Body two'),
              ),
            ),
            $block('After'),
          );
      },
      {discrete: true},
    );
  });
}

/** A section is dragged from its title, the blocks of its body on their own. */
function $sectionBehavior(node: LexicalNode): DraggableBlockBehavior | null {
  if (node instanceof SectionNode) {
    return 'draggable';
  }
  if (node instanceof SectionTitleNode) {
    return 'ignored';
  }
  if (node instanceof RegionNode) {
    return 'transparent';
  }
  return null;
}

function elementWithClass(editor: LexicalEditor, className: string) {
  const elem = editor
    .getRootElement()!
    .querySelector<HTMLElement>(`.${className}`);
  expect(elem).not.toBeNull();
  return elem!;
}

describe('DraggableBlockPlugin_EXPERIMENTAL with $getBlockBehavior', () => {
  test('by default a shadow root is one unit', () => {
    const harness = render();
    const {editor} = harness;
    populateSection(editor);
    const section = elementWithClass(editor, 'test-section');

    hover(harness, elementWithClass(editor, 'test-section-title'));
    expect(harness.lastElement()).toBe(section);

    hover(harness, elementWithText(editor, 'Body one'));
    expect(harness.lastElement()).toBe(section);
  });

  test('an ignored block and the gaps of a transparent block belong to the enclosing block', () => {
    const harness = render($sectionBehavior);
    const {editor} = harness;
    populateSection(editor);
    const section = elementWithClass(editor, 'test-section');
    const region = elementWithClass(editor, 'test-region');
    region.style.paddingBottom = '30px';

    hover(harness, elementWithClass(editor, 'test-section-title'));
    expect(harness.lastElement()).toBe(section);

    hover(harness, elementWithText(editor, 'Body two'));
    expect(harness.lastElement()).toBe(elementWithText(editor, 'Body two'));

    const rect = region.getBoundingClientRect();
    act(() => {
      harness.scroller.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: rect.left + 1,
          clientY: rect.bottom - 10,
        }),
      );
    });
    expect(harness.lastElement()).toBe(section);
  });

  test("returning 'atomic' for every block keeps the handle on top-level blocks", () => {
    const harness = render(() => 'atomic');
    const {editor} = harness;
    populate(editor);

    hover(harness, elementWithText(editor, 'Nested two'));
    expect(harness.lastElement()).toBe(
      editor.getRootElement()!.querySelector('ol'),
    );
  });

  test('an atomic block hides the blocks nested in it', () => {
    const harness = render(node => ($isListNode(node) ? 'atomic' : null));
    const {editor} = harness;
    populate(editor);

    hover(harness, elementWithText(editor, 'Two'));
    expect(harness.lastElement()).toBe(
      elementWithText(editor, 'Two').closest('ol'),
    );
  });

  test('reorders the blocks of a transparent shadow root', () => {
    const harness = render($sectionBehavior);
    const {editor} = harness;
    populateSection(editor);

    dragAfter(
      harness,
      elementWithText(editor, 'Body one'),
      elementWithText(editor, 'Body two'),
    );

    expect(structure(editor)).toEqual([
      'Before',
      ['test-section', 'Title', ['test-region', 'Body two', 'Body one']],
      'After',
    ]);
  });

  test('moves blocks into and out of a transparent shadow root', () => {
    const harness = render($sectionBehavior);
    const {editor} = harness;
    populateSection(editor);

    dragAfter(
      harness,
      elementWithText(editor, 'Before'),
      elementWithText(editor, 'Body one'),
    );
    expect(structure(editor)).toEqual([
      [
        'test-section',
        'Title',
        ['test-region', 'Body one', 'Before', 'Body two'],
      ],
      'After',
    ]);

    dragAfter(
      harness,
      elementWithText(editor, 'Body two'),
      elementWithText(editor, 'After'),
    );
    expect(structure(editor)).toEqual([
      ['test-section', 'Title', ['test-region', 'Body one', 'Before']],
      'After',
      'Body two',
    ]);
  });

  test('a list item dropped in a shadow root gets a list of the same type', () => {
    const harness = render($sectionBehavior);
    const {editor} = harness;
    populateSection(editor);
    act(() => {
      editor.update(
        () => {
          $getRoot().append($createListNode('number').append($item('One')));
        },
        {discrete: true},
      );
    });

    dragAfter(
      harness,
      elementWithText(editor, 'One'),
      elementWithText(editor, 'Body one'),
    );

    expect(structure(editor)).toEqual([
      'Before',
      [
        'test-section',
        'Title',
        ['test-region', 'Body one', ['number', 'One'], 'Body two'],
      ],
      'After',
    ]);
  });

  test('a shadow root keeps a block when its last block is dragged out', () => {
    const harness = render($sectionBehavior);
    const {editor} = harness;
    populateSection(editor);

    dragAfter(
      harness,
      elementWithText(editor, 'Body one'),
      elementWithText(editor, 'After'),
    );
    dragAfter(
      harness,
      elementWithText(editor, 'Body two'),
      elementWithText(editor, 'After'),
    );

    expect(structure(editor)).toEqual([
      'Before',
      ['test-section', 'Title', ['test-region', '']],
      'After',
      'Body two',
      'Body one',
    ]);
  });
});

/** Paragraph, figure (caption slot, content slot of two paragraphs), paragraph. */
function populateFigure(editor: LexicalEditor): void {
  act(() => {
    editor.update(
      () => {
        const figure = $create(FigureNode);
        $setSlot(figure, 'caption', $block('Caption'));
        $setSlot(
          figure,
          'content',
          $create(RegionNode).append($block('Slot one'), $block('Slot two')),
        );
        $getRoot().clear().append($block('Before'), figure, $block('After'));
      },
      {discrete: true},
    );
  });
}

describe('DraggableBlockPlugin_EXPERIMENTAL with named slots', () => {
  test('the blocks of a multi-block slot get a handle, a single-line slot does not', () => {
    const harness = render();
    const {editor} = harness;
    populateFigure(editor);

    hover(harness, elementWithText(editor, 'Slot two'));
    expect(harness.lastElement()).toBe(elementWithText(editor, 'Slot two'));

    hover(harness, elementWithText(editor, 'Caption'));
    expect(harness.lastElement()).toBe(elementWithClass(editor, 'test-figure'));
  });

  test('reorders the blocks of a slot and moves blocks into it', () => {
    const harness = render();
    const {editor} = harness;
    populateFigure(editor);

    dragAfter(
      harness,
      elementWithText(editor, 'Slot one'),
      elementWithText(editor, 'Slot two'),
    );
    dragAfter(
      harness,
      elementWithText(editor, 'After'),
      elementWithText(editor, 'Slot two'),
    );

    expect(structure(editor)).toEqual([
      'Before',
      [
        'test-figure',
        'Caption',
        ['test-region', 'Slot two', 'After', 'Slot one'],
      ],
    ]);
  });

  test('a host is not dropped into its own slot, and nothing is dropped beside a single-line slot value', () => {
    const harness = render();
    const {editor} = harness;
    populateFigure(editor);
    const before = structure(editor);

    dragAfter(
      harness,
      elementWithText(editor, 'Caption'),
      elementWithText(editor, 'Slot one'),
      elementWithClass(editor, 'test-figure'),
    );
    expect(structure(editor)).toEqual(before);

    dragAfter(
      harness,
      elementWithText(editor, 'Before'),
      elementWithText(editor, 'Caption'),
    );
    expect(structure(editor)).toEqual([
      ['test-figure', 'Caption', ['test-region', 'Slot one', 'Slot two']],
      'Before',
      'After',
    ]);
  });
});
