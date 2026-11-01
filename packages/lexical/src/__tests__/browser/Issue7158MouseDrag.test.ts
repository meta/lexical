/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * #7158: a real mouse drag that starts beside the first or last inline
 * decorator of a line must extend across the decorators it crosses. jsdom
 * cannot model this (it has no hit testing, and a browser's mouse drag keeps
 * its own anchor regardless of later Selection API calls), so the drag is
 * driven through Playwright's mouse. These also check that a click beside
 * those decorators puts the caret beside them, that a drag past the end or
 * start of a line does not rewrite the selection on every move, that a Shift
 * drag keeps the selection's anchor, that events in another order (a fast
 * first move, a late selectionchange, a release before the last move's
 * selectionchange), other layouts (lines that wrap after a decorator,
 * right-to-left text, floats, columns, boxes that are not level with what is
 * beside them) and pointer events that the page stops from propagating or
 * cancels are handled, that a click keeps a format armed at a caret that it
 * leaves alone, and that the presses the editor must not follow (double
 * clicks, presses on a selection, cancelled presses, touch and pen, read-only
 * editors, compositions, presses ended by a move with no button, a dragstart
 * or a key) are left to the browser.
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createRangeSelectionFromDom,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isDecoratorNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_CRITICAL,
  DecoratorNode,
  type ElementDOMSlot,
  ElementNode,
  FORMAT_TEXT_COMMAND,
  getDOMSelection,
  isDOMTextNode,
  type LexicalEditor,
  type LexicalNode,
  registerEventListener,
  registerEventListeners,
  SELECTION_CHANGE_COMMAND,
  setDOMUnmanaged,
} from 'lexical';
import {assert, describe, onTestFinished, test, vi} from 'vitest';
import {commands, server, userEvent} from 'vitest/browser';

import {$assertNodeType} from '../utils/assertNodeType';

const COUNT = 6;
const SIZE = 40;
/** Text that wraps once in the root element, and ends on its second line. */
const WRAPPING_TEXT =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod';

class ImageLikeDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_7158_mouse_image', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    const img = document.createElement('img');
    img.alt = '';
    img.style.cssText = `display:inline-block;width:${SIZE}px;height:${SIZE}px;background:#888`;
    span.appendChild(img);
    return span;
  }
  updateDOM(): false {
    return false;
  }
  isInline(): true {
    return true;
  }
  decorate(): null {
    return null;
  }
}

/**
 * An unselectable (`user-select: none`) inline-block whose image sits in a
 * block wrapper, as many integrations style images. Chromium's hit test finds
 * no position inside it that a drag selection can extend to.
 */
class BoxedImageDecoratorNode extends ImageLikeDecoratorNode {
  $config() {
    return this.config('test_7158_mouse_boxed_image', {
      extends: ImageLikeDecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.cssText =
      'display:inline-block;position:relative;user-select:none;overflow:hidden';
    const div = document.createElement('div');
    const img = document.createElement('img');
    img.alt = '';
    img.style.cssText = `display:block;width:${SIZE}px;height:${SIZE}px;background:#888`;
    div.appendChild(img);
    span.appendChild(div);
    return span;
  }
}

/**
 * The same block-wrapped image, but selectable, like the playground's
 * ImageNode: Chromium's hit test can put a drag point inside it, where the
 * point resolves to no Lexical selection.
 */
class SelectableBoxedImageDecoratorNode extends BoxedImageDecoratorNode {
  $config() {
    return this.config('test_7158_mouse_selectable_boxed_image', {
      extends: BoxedImageDecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const span = super.createDOM();
    span.style.userSelect = '';
    return span;
  }
}

/**
 * An unselectable inline decorator whose box is a nested editor's root
 * element, like the caption of the playground's ImageNode, so that the
 * pointer moves over it are aimed at that editor.
 */
class NestedEditorDecoratorNode extends ImageLikeDecoratorNode {
  $config() {
    return this.config('test_7158_mouse_nested_editor', {
      extends: ImageLikeDecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.cssText = 'display:inline-block;user-select:none';
    const div = document.createElement('div');
    div.style.cssText = `width:${SIZE}px;height:${SIZE}px;background:#888`;
    span.appendChild(div);
    return span;
  }
}

/**
 * An unselectable inline decorator drawn by its own element, which has no
 * child nodes, like a span sized by CSS or a React decorator before its portal
 * renders.
 */
class ChildlessDecoratorNode extends ImageLikeDecoratorNode {
  $config() {
    return this.config('test_7158_mouse_childless', {
      extends: ImageLikeDecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.cssText = `display:inline-block;width:${SIZE}px;height:${SIZE}px;background:#888;user-select:none`;
    return span;
  }
}

/**
 * An inline decorator of text, like a mention or an equation, which browsers
 * put drag points in, where they resolve to no selection.
 */
class TextChipDecoratorNode extends ImageLikeDecoratorNode {
  $config() {
    return this.config('test_7158_mouse_text_chip', {
      extends: ImageLikeDecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.cssText = `display:inline-block;width:${SIZE}px;height:${SIZE}px;background:#ccc;overflow:hidden`;
    span.textContent = '@ab';
    return span;
  }
}

/** The same chip of text, unselectable. */
class UnselectableTextChipDecoratorNode extends TextChipDecoratorNode {
  $config() {
    return this.config('test_7158_mouse_unselectable_text_chip', {
      extends: TextChipDecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const span = super.createDOM();
    span.style.userSelect = 'none';
    return span;
  }
}

/**
 * The chip of text with a direction of its own, as a chip of code, a formula
 * or a name has.
 */
class LtrTextChipDecoratorNode extends TextChipDecoratorNode {
  $config() {
    return this.config('test_7158_mouse_ltr_text_chip', {
      extends: TextChipDecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const span = super.createDOM();
    span.dir = 'ltr';
    return span;
  }
}

/** The chip of text with the direction of its text, which is left-to-right. */
class AutoTextChipDecoratorNode extends TextChipDecoratorNode {
  $config() {
    return this.config('test_7158_mouse_auto_text_chip', {
      extends: TextChipDecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const span = super.createDOM();
    span.dir = 'auto';
    return span;
  }
}

/** An inline image floated right, as an "align right" image is. */
class FloatRightDecoratorNode extends ImageLikeDecoratorNode {
  $config() {
    return this.config('test_7158_mouse_float_right', {
      extends: ImageLikeDecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const span = super.createDOM();
    span.style.cssText = 'float:right;margin-left:8px';
    const img = span.firstElementChild;
    assert(img instanceof HTMLElement, 'expected the image');
    img.style.cssText = `display:block;width:${2 * SIZE}px;height:${3 * SIZE}px;background:#888`;
    return span;
  }
}

/** A small box aligned with the top of its line, as a badge can be. */
class TopAlignedDecoratorNode extends ImageLikeDecoratorNode {
  $config() {
    return this.config('test_7158_mouse_top_aligned', {
      extends: ImageLikeDecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.cssText =
      'display:inline-block;width:16px;height:16px;vertical-align:top;background:#c80';
    return span;
  }
}

/**
 * A chip in an element that has no box of its own (`display: contents`), as
 * the element that a React decorator renders into can be.
 */
class ContentsChipDecoratorNode extends TextChipDecoratorNode {
  $config() {
    return this.config('test_7158_mouse_contents_chip', {
      extends: TextChipDecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.display = 'contents';
    span.appendChild(super.createDOM());
    return span;
  }
}

/** A decorator that draws nothing, as a marker. */
class HiddenDecoratorNode extends ImageLikeDecoratorNode {
  $config() {
    return this.config('test_7158_mouse_hidden', {
      extends: ImageLikeDecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.display = 'none';
    return span;
  }
}

/** The error that a `ThrowingDecoratorNode` throws once. */
class ReconcilerTestError extends Error {}
let throwInCreateDOM = false;

/** A decorator whose createDOM throws once `throwInCreateDOM` is set. */
class ThrowingDecoratorNode extends ImageLikeDecoratorNode {
  $config() {
    return this.config('test_7158_mouse_throwing', {
      extends: ImageLikeDecoratorNode,
    });
  }
  createDOM(): HTMLElement {
    if (throwInCreateDOM) {
      throwInCreateDOM = false;
      throw new ReconcilerTestError('test_7158_mouse_throwing');
    }
    return super.createDOM();
  }
}

/** An inline element, like a link or a mark, to put a decorator in. */
class InlineWrapperNode extends ElementNode {
  $config() {
    return this.config('test_7158_inline_wrapper', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('a');
  }
  updateDOM(): false {
    return false;
  }
  isInline(): true {
    return true;
  }
}

/** A block whose children render into an inner element that has no key. */
class SlottedBlockNode extends ElementNode {
  $config() {
    return this.config('test_7158_slotted_block', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    const div = document.createElement('div');
    const section = document.createElement('section');
    section.style.minHeight = `${SIZE}px`;
    div.appendChild(section);
    return div;
  }
  updateDOM(): false {
    return false;
  }
  getDOMSlot(dom: HTMLElement): ElementDOMSlot<HTMLElement> {
    const section = dom.firstElementChild;
    assert(section instanceof HTMLElement, 'expected the section');
    return super.getDOMSlot(dom).withElement(section);
  }
}

type DecoratorClass = typeof ImageLikeDecoratorNode;

interface MountOptions {
  /** Text after the decorators. */
  trailingText?: string;
  /** A line before the decorators, ended by a line break. */
  leadingLine?: string;
  /** A line after the decorators, after a line break. */
  trailingLine?: string;
  /** Whether each decorator is in an inline element of its own. */
  inInlineElements?: boolean;
  /** The text between the decorators, if there is text between them. */
  betweenText?: string;
  /** Whether the editor is in a shadow root. */
  inShadowRoot?: boolean;
  /**
   * Whether the editor has recovered from an error in its reconciler, after
   * which it renders its state again with new input state.
   */
  recoverFromError?: boolean;
  /** The width of the root element's content, if not 380px. */
  width?: number;
}

const NODES = [
  ImageLikeDecoratorNode,
  BoxedImageDecoratorNode,
  SelectableBoxedImageDecoratorNode,
  NestedEditorDecoratorNode,
  ChildlessDecoratorNode,
  TextChipDecoratorNode,
  UnselectableTextChipDecoratorNode,
  LtrTextChipDecoratorNode,
  AutoTextChipDecoratorNode,
  FloatRightDecoratorNode,
  TopAlignedDecoratorNode,
  ContentsChipDecoratorNode,
  HiddenDecoratorNode,
  ThrowingDecoratorNode,
  InlineWrapperNode,
  SlottedBlockNode,
];

/**
 * An editor of `$children`, in a 380px wide root element (in a shadow root,
 * if `inShadowRoot`), with the root's id the drag command finds it by.
 */
function mountEditor(
  $children: () => LexicalNode[],
  inShadowRoot = false,
  recoverFromError = false,
) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = document.createElement('div');
  root.id = 'issue-7158-root';
  root.contentEditable = 'true';
  // Narrower than the test frame (414px), which would otherwise scroll
  // sideways when a drag nears its edge.
  root.style.cssText = 'width:380px;padding:10px;font-size:16px';
  (inShadowRoot ? host.attachShadow({mode: 'open'}) : host).appendChild(root);
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        $getRoot()
          .clear()
          .append(...$children());
      },
      dependencies: [RichTextExtension],
      name: '[7158-mouse]',
      nodes: NODES,
      // As by default, except for the error the editor recovers from.
      onError: error => {
        if (!(error instanceof ReconcilerTestError)) {
          throw error;
        }
      },
    }),
  );
  editor.setRootElement(root);
  onTestFinished(() => {
    if (recoverFromError) {
      // The recovery leaves the editor's first MutationObserver attached as
      // well, which in Firefox fails on the mutations of dispose() while the
      // editor has a selection.
      editor.update(() => $setSelection(null), {discrete: true});
    }
    editor.dispose();
    host.remove();
  });
  if (recoverFromError) {
    throwInCreateDOM = true;
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($create(ThrowingDecoratorNode)),
        );
      },
      {discrete: true},
    );
    assert(!throwInCreateDOM, 'expected the reconciler to fail');
    editor.update(
      () => {
        $getRoot().getLastChildOrThrow().remove();
      },
      {discrete: true},
    );
  }
  return {editor, root};
}

/** The box of `node`, or of a range in it, relative to the top-left of `root`. */
function rectIn(root: HTMLElement, node: Node, start?: number, end?: number) {
  const range = document.createRange();
  if (start === undefined) {
    range.selectNode(node);
  } else {
    range.setStart(node, start);
    range.setEnd(node, end ?? start + 1);
  }
  const rect = range.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  return {
    bottom: rect.bottom - rootRect.top,
    left: rect.left - rootRect.left,
    right: rect.right - rootRect.left,
    top: rect.top - rootRect.top,
    x: (rect.left + rect.right) / 2 - rootRect.left,
    y: (rect.top + rect.bottom) / 2 - rootRect.top,
  };
}

function mount(
  textBetween: boolean,
  klass: DecoratorClass,
  {
    trailingText = '',
    leadingLine = '',
    trailingLine = '',
    inInlineElements = false,
    betweenText = ' ',
    inShadowRoot = false,
    recoverFromError = false,
    width,
  }: MountOptions = {},
) {
  const {editor, root} = mountEditor(
    () => {
      const paragraph = $createParagraphNode();
      if (leadingLine !== '') {
        // The decorators start the paragraph's second line.
        paragraph.append($createTextNode(leadingLine), $createLineBreakNode());
      }
      for (let i = 0; i < COUNT; i++) {
        if (textBetween) {
          paragraph.append($createTextNode(betweenText));
        }
        paragraph.append(
          inInlineElements
            ? $create(InlineWrapperNode).append($create(klass))
            : $create(klass),
        );
      }
      if (trailingText !== '') {
        paragraph.append($createTextNode(trailingText));
      }
      if (trailingLine !== '') {
        // The decorators end the paragraph's first line.
        paragraph.append($createLineBreakNode(), $createTextNode(trailingLine));
      }
      return [paragraph];
    },
    inShadowRoot,
    recoverFromError,
  );
  if (width !== undefined) {
    root.style.width = `${width}px`;
  }
  const trailingTextKey = editor.read('latest', () => {
    const last = $getRoot().getLastDescendant();
    return $isTextNode(last) ? last.getKey() : null;
  });
  // Where each pointer event landed (relative to the root) and the DOM
  // selection once the browser has handled it, for the failure message.
  const pointerLog: string[] = [];
  const logPointer = (event: PointerEvent) => {
    const rect = root.getBoundingClientRect();
    const x = Math.round(event.clientX - rect.left);
    const y = Math.round(event.clientY - rect.top);
    setTimeout(() => {
      pointerLog.push(
        `${event.type.slice(7)}(${x},${y} b${event.buttons})=` +
          describeDOMSelection(getDOMSelection(window)),
      );
    });
  };
  onTestFinished(
    registerEventListeners(
      document,
      {pointerdown: logPointer, pointermove: logPointer, pointerup: logPointer},
      true,
    ),
  );
  // The box inside each decorator, or the decorator's own.
  const images = Array.from(
    root.querySelectorAll('[data-lexical-decorator]'),
    dom => dom.firstElementChild || dom,
  );
  const rootRect = root.getBoundingClientRect();
  // Points relative to the root's top-left, on the images' center line.
  const y = images[0].getBoundingClientRect().top + SIZE / 2 - rootRect.top;
  const left = (i: number) =>
    images[i].getBoundingClientRect().left - rootRect.left;
  const right = (i: number) =>
    images[i].getBoundingClientRect().right - rootRect.left;
  // The box of `text` within the trailing text, relative to the root.
  const textRect = (text: string) => {
    const textNode =
      trailingTextKey !== null
        ? editor.getElementByKey(trailingTextKey)?.firstChild
        : null;
    assert(isDOMTextNode(textNode), 'expected the trailing text');
    const index = textNode.data.indexOf(text);
    return rectIn(root, textNode, index, index + text.length);
  };
  pointerLog.push(
    `left(0)=${Math.round(left(0))} right(${COUNT - 1})=${Math.round(right(COUNT - 1))} y=${Math.round(y)} dpr=${window.devicePixelRatio}`,
  );
  return {
    editor,
    left,
    pointerLog,
    right,
    root,
    textRect,
    trailingTextKey,
    y,
  };
}

function describeDOMPoint(node: Node | null, offset: number): string {
  if (node === null) {
    return 'null';
  }
  const name = isDOMTextNode(node)
    ? `#text(${JSON.stringify(node.data)})`
    : node.nodeName.toLowerCase();
  return `${name}:${offset}`;
}

/**
 * A real mouse drag through `points` relative to the root. It moves in steps
 * of at most half a decorator's width, so the pointer stops over each
 * decorator it crosses.
 */
function mouseDrag(
  points: Parameters<typeof commands.mouseDrag>[1],
  options?: Omit<
    NonNullable<Parameters<typeof commands.mouseDrag>[2]>,
    'maxStep'
  >,
): Promise<void> {
  return commands.mouseDrag('#issue-7158-root', points, {
    ...options,
    maxStep: SIZE / 2,
  });
}

function describeDOMSelection(selection: Selection | null): string {
  return selection === null
    ? 'null'
    : `${describeDOMPoint(selection.anchorNode, selection.anchorOffset)}->` +
        describeDOMPoint(selection.focusNode, selection.focusOffset);
}

/**
 * The init of a left button mouse PointerEvent at (`x`, `y`) relative to
 * `root`.
 */
function mousePointerInit(
  root: HTMLElement,
  x: number,
  y: number,
): PointerEventInit {
  const rootRect = root.getBoundingClientRect();
  return {
    bubbles: true,
    button: 0,
    buttons: 1,
    clientX: rootRect.left + x,
    clientY: rootRect.top + y,
    composed: true,
    pointerType: 'mouse',
  };
}

/** The element at the point of `init`, to dispatch a pointer event to. */
function elementAt(init: PointerEventInit): Element {
  const element = document.elementFromPoint(
    init.clientX ?? 0,
    init.clientY ?? 0,
  );
  assert(element !== null, 'expected an element at the pointer');
  return element;
}

// The last selectionchange is handled asynchronously, and on a busy runner it
// can land well after the mouse is released, so wait for the editor's
// selection to settle rather than for a fixed time. A failure reports the
// selection that was reached, to tell a selection that never extended apart
// from one that extended too far.
async function expectSelectedDecoratorCount(
  editor: LexicalEditor,
  expected: number,
  pointerLog: string[],
): Promise<void> {
  await vi.waitFor(
    () => {
      const [count, lexical] = editor.read('latest', () => {
        const selection = $getSelection();
        // A caret beside a decorator "selects" it as far as getNodes() is
        // concerned, so it counts as none.
        return $isRangeSelection(selection)
          ? [
              selection.isCollapsed()
                ? 0
                : selection.getNodes().filter($isDecoratorNode).length,
              `${selection.anchor.key}:${selection.anchor.offset}->` +
                `${selection.focus.key}:${selection.focus.offset}`,
            ]
          : [-1, String(selection)];
      });
      assert(
        count === expected,
        `expected ${expected} selected decorators, got ${count} ` +
          `(lexical ${lexical}; ` +
          `dom ${describeDOMSelection(getDOMSelection(window))}; ` +
          `pointer ${pointerLog.join(' ')})`,
      );
    },
    {interval: 50, timeout: 2000},
  );
}

/** Asserts that the selection holds no line break of the decorators' line. */
function assertNoLineBreakSelected(
  editor: LexicalEditor,
  pointerLog: string[],
): void {
  assert(
    editor.read('latest', () => {
      const selection = $getSelection();
      return (
        $isRangeSelection(selection) &&
        !selection.getNodes().some($isLineBreakNode)
      );
    }),
    `expected the line break to stay unselected (` +
      `${describeEditorSelection(editor)}; dom ` +
      `${describeDOMSelection(getDOMSelection(window))}; ` +
      `pointer ${pointerLog.join(' ')})`,
  );
}

/**
 * The drag of `dragFromLineEnd` or `dragFromLineStart`, with the press
 * beyond the line's last or first decorator.
 */
async function dragFromLineEdge(
  edge: 'end' | 'start',
  {editor, left, pointerLog, right, y}: ReturnType<typeof mount>,
  options?: Parameters<typeof mouseDrag>[1],
): Promise<void> {
  await mouseDrag(
    edge === 'end'
      ? [
          [right(COUNT - 1) + 30, y],
          [left(COUNT - 2) + SIZE / 2, y],
          [left(3) + SIZE / 2, y],
          [left(2) - 2, y],
        ]
      : [
          [left(0) - 5, y],
          [left(1) + SIZE / 2, y],
          [left(COUNT - 2) + SIZE / 2, y],
          [right(COUNT - 1) + 30, y],
        ],
    options,
  );
  await expectSelectedDecoratorCount(
    editor,
    edge === 'end' ? COUNT - 2 : COUNT,
    pointerLog,
  );
  assertNoLineBreakSelected(editor, pointerLog);
}

function dragFromLineEnd(
  klass: DecoratorClass,
  textBetween: boolean,
  options?: MountOptions,
) {
  return () => dragFromLineEdge('end', mount(textBetween, klass, options));
}

function dragFromLineStart(
  klass: DecoratorClass,
  textBetween: boolean,
  options?: MountOptions,
) {
  return () => dragFromLineEdge('start', mount(textBetween, klass, options));
}

describe('Issue #7158: mouse drag over only inline decorators', () => {
  test(
    'a drag from right of the last decorator selects back to the third',
    dragFromLineEnd(ImageLikeDecoratorNode, false),
  );
  test(
    'a drag from left of the first decorator selects to the end of the line',
    dragFromLineStart(ImageLikeDecoratorNode, false),
  );
});

test(
  'Issue #7158: a drag over text between inline decorators from right of the last decorator selects back to the third',
  dragFromLineEnd(ImageLikeDecoratorNode, true),
);

// Chromium restarts a drag from its press once the editor has moved the
// selection, and a press beyond the last decorator puts both of its points
// inside that decorator, so it has no position in the text to report, also
// at a release that comes before the selectionchange of the last move.
test.each([
  ['', false],
  [', released before the selectionchange of its last move,', true],
])(
  'Issue #7158: a drag from right of the last decorator into a word between decorators%s ends in the word',
  async (_name, isReleasedFirst) => {
    const {editor, left, pointerLog, right, root, y} = mount(
      true,
      ImageLikeDecoratorNode,
      {betweenText: 'ab'},
    );
    // Between the "a" and the "b" before the fifth decorator.
    const word = (right(COUNT - 3) + left(COUNT - 2)) / 2;
    if (isReleasedFirst) {
      withholdLastMoveSelectionChanges(root, word);
    }
    await mouseDrag([
      // Halfway to the right edge of the root, which the text before the
      // decorators moves closer in a wider font.
      [(right(COUNT - 1) + root.offsetWidth) / 2, y],
      [left(COUNT - 1) + SIZE / 2, y],
      [word, y],
    ]);
    await vi.waitFor(() => {
      const text = editor.read('latest', () => {
        const selection = $getSelection();
        return $isRangeSelection(selection) ? selection.getTextContent() : '';
      });
      assert(
        text === 'bab',
        `expected the selection to start in the word, got ${JSON.stringify(text)} ` +
          `(dom ${describeDOMSelection(getDOMSelection(window))}; ` +
          `pointer ${pointerLog.join(' ')})`,
      );
    });
  },
);

/**
 * Records each selection change of `editor`, with the selection it changed to
 * in Lexical and in the DOM, and how many pointer events the window had
 * dispatched by then, counted before the editor's listeners see each one.
 */
function recordSelectionChanges(
  editor: LexicalEditor,
): {description: string; pointerEvents: number}[] {
  const changes: {description: string; pointerEvents: number}[] = [];
  let pointerEvents = 0;
  const countPointerEvent = () => {
    pointerEvents++;
  };
  onTestFinished(
    registerEventListeners(
      window,
      {
        pointerdown: countPointerEvent,
        pointermove: countPointerEvent,
        pointerup: countPointerEvent,
      },
      true,
    ),
  );
  onTestFinished(
    editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        const selection = $getSelection();
        changes.push({
          description: `${
            $isRangeSelection(selection)
              ? `${selection.anchor.key}:${selection.anchor.offset}->` +
                `${selection.focus.key}:${selection.focus.offset}`
              : String(selection)
          } (dom ${describeDOMSelection(getDOMSelection(window))})`,
          pointerEvents,
        });
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
  );
  return changes;
}

/**
 * Asserts that no pointer event changed the selection more than once, which
 * is what a selection that the editor and the browser keep moving back and
 * forth looks like. How often a drag changes the selection while following
 * the pointer depends on the browser, so that is not counted: above a line,
 * Linux Firefox keeps a drag's focus at the start of the line, and macOS
 * Firefox puts it under the pointer.
 */
function assertOneSelectionChangePerPointerEvent(
  changes: {description: string; pointerEvents: number}[],
  pointerLog: string[],
): void {
  const repeated = changes.filter(
    ({pointerEvents}, i) =>
      i > 0 && changes[i - 1].pointerEvents === pointerEvents,
  );
  assert(
    repeated.length === 0,
    `expected at most one selection change per pointer event, got ` +
      changes
        .map(
          ({description, pointerEvents}) =>
            `${description} after pointer event ${pointerEvents}`,
        )
        .join(', ') +
      `; pointer ${pointerLog.join(' ')}`,
  );
}

// Where a line ends in the managed line break's <img> (WebKit and desktop
// Chromium), the browser puts a drag's focus below or past the end of the line
// after that <img>, which Lexical maps to the point before it. Writing that
// point back only has the browser move it again on the next pointer move, so
// each move would be two selection changes.
async function dragPastLineEnd() {
  const {editor, pointerLog, right, y} = mount(false, ImageLikeDecoratorNode);
  const changes = recordSelectionChanges(editor);
  const x = right(COUNT - 1) + 30;
  await mouseDrag([
    [x, y],
    [x + 50, y + SIZE],
    [x + 100, y + SIZE],
    [x + 50, y + 2 * SIZE],
  ]);
  await vi.waitFor(() =>
    assert(
      editor.read('latest', () => {
        const selection = $getSelection();
        return $isRangeSelection(selection) && selection.isCollapsed();
      }),
      'expected a collapsed selection',
    ),
  );
  assertOneSelectionChangePerPointerEvent(changes, pointerLog);
}

// As at the end of the line, a drag above the start of a line that starts with
// an inline decorator must not change the selection back and forth. Firefox
// puts the focus of each move inside a decorator, which the editor moves
// beside it.
async function dragPastLineStart() {
  const {editor, left, pointerLog, y} = mount(false, ImageLikeDecoratorNode);
  const changes = recordSelectionChanges(editor);
  const x = left(0) + SIZE / 2;
  await mouseDrag([
    [left(0) - 5, y],
    [x, y - SIZE],
    [x + 50, y - SIZE],
    [x + 100, y - SIZE],
    [x + 50, y - SIZE / 2],
  ]);
  // The drag ends over the right half of the second decorator.
  await expectSelectedDecoratorCount(editor, 2, pointerLog);
  assertOneSelectionChangePerPointerEvent(changes, pointerLog);
}

test(
  'Issue #7158: a drag past the end of the line does not keep changing the selection',
  dragPastLineEnd,
);
test(
  'Issue #7158: a drag past the start of the line does not keep changing the selection',
  dragPastLineStart,
);

/**
 * Records each selectionchange that left the selection as it was, but dirty,
 * so that the editor writes it back to the DOM, and that did not dispatch
 * SELECTION_CHANGE_COMMAND, as one does outside a mouse press.
 */
function recordUnnotifiedDirtySelections(editor: LexicalEditor): string[] {
  const unnotified: string[] = [];
  let isSelectionChange = false;
  let isNotified = false;
  // Before the editor's listener on the document, and after it.
  onTestFinished(
    registerEventListener(
      window,
      'selectionchange',
      () => {
        isSelectionChange = true;
        isNotified = false;
      },
      true,
    ),
  );
  onTestFinished(
    registerEventListener(document, 'selectionchange', () => {
      isSelectionChange = false;
    }),
  );
  onTestFinished(
    editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        isNotified = true;
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
  );
  onTestFinished(
    editor.registerUpdateListener(({editorState, prevEditorState}) => {
      const selection = editorState.read(() => $getSelection());
      if (
        isSelectionChange &&
        !isNotified &&
        $isRangeSelection(selection) &&
        selection.dirty &&
        selection.is(prevEditorState.read(() => $getSelection()))
      ) {
        unnotified.push(
          `${describeEditorSelection(editor)} (dom ` +
            `${describeDOMSelection(getDOMSelection(window))})`,
        );
      }
      isNotified = false;
    }),
  );
  return unnotified;
}

// A click from text to past the end of a line that ends in decorators, where
// the editor moves the caret that the browser puts there, notifies that caret
// once, although the browser reports it dirty. A second click there leaves it
// as it was, and WebKit reports the dirty caret again, which is notified
// again.
test('Issue #7158: clicks past the end of a line that ends in decorators notify their caret once each', async () => {
  let textKey = '';
  const {editor, root} = mountEditor(() => {
    const text = $createTextNode('ab');
    textKey = text.getKey();
    const paragraph = $createParagraphNode().append(text);
    for (let i = 0; i < 3; i++) {
      paragraph.append($create(ImageLikeDecoratorNode));
    }
    return [paragraph, $createParagraphNode().append($createTextNode('next'))];
  });
  const changes = recordSelectionChanges(editor);
  const text = editor.getElementByKey(textKey)?.firstChild;
  assert(isDOMTextNode(text), 'expected the text');
  const {x, y} = rectIn(root, text, 1);
  const images = root.querySelectorAll('[data-lexical-decorator] img');
  const end = rectIn(root, images[images.length - 1]).right + 30;
  await mouseDrag([[x, y]]);
  await mouseDrag([[end, y]]);
  const unnotified = recordUnnotifiedDirtySelections(editor);
  await mouseDrag([[end, y]]);
  await expectCaret(editor, 'paragraph:4', []);
  assertOneSelectionChangePerPointerEvent(changes, []);
  assert(
    unnotified.length === 0,
    `expected the second click past the end to notify its caret, got none ` +
      `for ${unnotified.join(', ')}`,
  );
});

// Chromium reports the caret that the editor writes back into a keyless
// element as another selectionchange, which is notified too.
test('Issue #7158: a click in an empty block whose children render into a keyless element notifies each dirty caret', async () => {
  const {editor, root} = mountEditor(() => [
    $createParagraphNode().append($createTextNode('before')),
    $create(SlottedBlockNode),
    $createParagraphNode().append($createTextNode('after')),
  ]);
  const unnotified = recordUnnotifiedDirtySelections(editor);
  const section = root.querySelector('section');
  assert(section !== null, 'expected the section');
  const {x, y} = rectIn(root, section);
  await mouseDrag([[x, y]]);
  await expectCaret(editor, 'test_7158_slotted_block:0', []);
  assert(
    unnotified.length === 0,
    `expected each dirty caret notified, got none for ${unnotified.join(', ')}`,
  );
});

// Once a drag leaves the root element, the browser alone follows the pointer:
// the editor must not keep putting the focus where the last move inside the
// root was, as each selectionchange would. The drag moves in steps over the
// decorators, then jumps from over the third one out of the right of the
// root, where the browser puts the focus at the end of the line, so the
// selection collapses there.
test('Issue #7158: a drag that leaves the root element is left to the browser', async () => {
  const {editor, left, pointerLog, right, root, y} = mount(
    false,
    ImageLikeDecoratorNode,
  );
  const points: [x: number, y: number][] = [];
  for (let x = right(COUNT - 1) + 30; x > left(2) + 5; x -= SIZE / 2) {
    points.push([x, y]);
  }
  points.push([left(2) + 5, y], [root.getBoundingClientRect().width + 5, y]);
  await commands.mouseDrag('#issue-7158-root', [points[0], ...points.slice(1)]);
  await expectSelectedDecoratorCount(editor, 0, pointerLog);
});

// No engine extends a drag across these decorators by itself, so these
// exercise the pointermove fallback.
describe('Issue #7158: mouse drag over unselectable inline decorators', () => {
  test(
    'a drag from right of the last decorator selects back to the third',
    dragFromLineEnd(BoxedImageDecoratorNode, false),
  );
  test(
    'a drag from left of the first decorator selects to the end of the line',
    dragFromLineStart(BoxedImageDecoratorNode, false),
  );
  test(
    'with text between, a drag from right of the last decorator selects back to the third',
    dragFromLineEnd(BoxedImageDecoratorNode, true),
  );
});

describe('Issue #7158: mouse drag over inline decorators of text', () => {
  test(
    'a drag from right of the last selectable decorator selects back to the third',
    dragFromLineEnd(TextChipDecoratorNode, false),
  );
  test(
    'a drag from left of the first unselectable decorator selects to the end of the line',
    dragFromLineStart(UnselectableTextChipDecoratorNode, false),
  );
});

// A decorator can be in an inline element, such as a link or a mark, including
// at either end of the line.
describe.each([
  ['inline', ImageLikeDecoratorNode],
  ['unselectable boxed inline', BoxedImageDecoratorNode],
])(
  'Issue #7158: mouse drag over %s decorators that are each in an inline element',
  (_name, klass) => {
    test(
      'a drag from right of the last decorator selects back to the third',
      dragFromLineEnd(klass, false, {inInlineElements: true}),
    );
    test(
      'a drag from left of the first decorator selects to the end of the line',
      dragFromLineStart(klass, false, {inInlineElements: true}),
    );
  },
);

// A Shift press extends the selection to the press, so its drag keeps the
// selection's anchor. Chromium and WebKit do that even for a press on the
// selection, where Firefox drags the selection, with or without Shift.
describe('Issue #7158: Shift mouse drag over unselectable inline decorators', () => {
  test.skipIf(server.browser === 'firefox')(
    'a drag from inside the selection extends it back to the third decorator',
    async () => {
      const {editor, left, pointerLog, root, textRect, trailingTextKey, y} =
        mount(false, BoxedImageDecoratorNode, {trailingText: ' hello world'});
      assert(trailingTextKey !== null, 'expected the trailing text');
      root.focus();
      editor.update(
        () => {
          $assertNodeType($getNodeByKey(trailingTextKey), $isTextNode).select(
            1,
            12,
          );
        },
        {discrete: true},
      );
      const hello = textRect('hello');
      await mouseDrag(
        [
          [(hello.left + hello.right) / 2, (hello.top + hello.bottom) / 2],
          [left(COUNT - 1) + SIZE / 2, y],
          [left(3) + SIZE / 2, y],
          [left(2) - 2, y],
        ],
        {modifiers: ['Shift']},
      );
      await expectSelectedDecoratorCount(editor, COUNT - 2, pointerLog);
    },
  );

  test('a drag keeps a caret anchor before a decorator the press is beyond', async () => {
    const {editor, left, pointerLog, root, textRect, y} = mount(
      false,
      BoxedImageDecoratorNode,
      {trailingText: ' hello world'},
    );
    root.focus();
    editor.update(
      () => {
        $assertNodeType($getRoot().getFirstChild(), $isParagraphNode).select(
          1,
          1,
        );
      },
      {discrete: true},
    );
    const world = textRect('world');
    await mouseDrag(
      [
        [(world.left + world.right) / 2, (world.top + world.bottom) / 2],
        [left(COUNT - 1) + SIZE / 2, y],
        [left(4) - 2, y],
      ],
      {modifiers: ['Shift']},
    );
    // From before the second decorator to before the fifth.
    await expectSelectedDecoratorCount(editor, 3, pointerLog);
  });
});

describe('Issue #7158: mouse drag over selectable boxed inline decorators', () => {
  test('a drag that returns to its start and leaves again keeps its anchor', async () => {
    const {editor, left, pointerLog, right, y} = mount(
      false,
      SelectableBoxedImageDecoratorNode,
    );
    await mouseDrag([
      [right(COUNT - 1) + 30, y],
      [left(2) + SIZE / 2, y],
      [right(COUNT - 1) + 10, y],
      [left(COUNT - 1) + 5, y],
      [left(2) - 2, y],
    ]);
    await expectSelectedDecoratorCount(editor, COUNT - 2, pointerLog);
  });

  // On macOS Chrome a drag can restart from the pointer, collapsing the
  // selection inside a decorator, where it resolves to no Lexical selection.
  // Linux Chromium does not do this, so do it the way it would: after the
  // browser and Lexical have handled a pointermove. This listener bubbles to
  // the document after the root's, and its timeout runs after the browser's
  // default action for the move.
  test('a drag that restarts inside a decorator keeps its anchor', async () => {
    const {editor, left, pointerLog, right, root, y} = mount(
      false,
      SelectableBoxedImageDecoratorNode,
    );
    const decorators = root.querySelectorAll('span > div');
    let injected = false;
    const inject = (event: PointerEvent) => {
      const x = event.clientX - root.getBoundingClientRect().left;
      if (!injected && event.buttons === 1 && x < left(COUNT - 2)) {
        injected = true;
        setTimeout(() =>
          getDOMSelection(window)?.collapse(decorators[COUNT - 2], 0),
        );
      }
    };
    onTestFinished(registerEventListener(document, 'pointermove', inject));
    await mouseDrag([
      [right(COUNT - 1) + 30, y],
      [left(2) - 2, y],
    ]);
    assert(injected, 'the drag never reached the injection point');
    await expectSelectedDecoratorCount(editor, COUNT - 2, pointerLog);
  });
});

// A nested editor handles the pointer events aimed at its root, as the
// caption of the playground's ImageNode does, and the drag must still see the
// moves over it. The drag ends over one, where only the drag's own handling
// can put the focus before that decorator. Firefox aims the moves of a drag
// at the element that was pressed, so there the nested editors never see
// them.
describe('Issue #7158: mouse drag over inline decorators that hold a nested editor', () => {
  test.each([
    ['an editable', true],
    ['a read-only', false],
  ])(
    'a drag from right of the last decorator to %s nested editor in the third selects back to it',
    async (_name, isEditable) => {
      const {editor, left, pointerLog, right, root, y} = mount(
        false,
        NestedEditorDecoratorNode,
      );
      for (const box of root.querySelectorAll<HTMLElement>(
        '[data-lexical-decorator] > div',
      )) {
        const nested = buildEditorFromExtensions(
          defineExtension({
            dependencies: [RichTextExtension],
            name: '[7158-mouse-nested]',
          }),
        );
        box.contentEditable = 'true';
        nested.setRootElement(box);
        nested.setEditable(isEditable);
        onTestFinished(() => nested.dispose());
      }
      await mouseDrag([
        [right(COUNT - 1) + 30, y],
        [left(COUNT - 2) + SIZE / 2, y],
        [left(3) + SIZE / 2, y],
        [left(2) + SIZE / 4, y],
      ]);
      await expectSelectedDecoratorCount(editor, COUNT - 2, pointerLog);
    },
  );
});

// A click beside the first or last inline decorator of a line puts the caret
// beside it, not inside its contentEditable=false DOM, where it would resolve
// to no selection at all; with a caret elsewhere already, Lexical would then
// remove the DOM selection too. On a line between line breaks, it also stays
// on that line rather than going to the end of the line above or the start of
// the line below.
const BETWEEN_LINE_BREAKS = {leadingLine: 'above', trailingLine: 'below'};

/**
 * The carets beside the decorators at the `edge` of their line, as
 * `expectCaret` takes them: in the paragraph, after the leading line's text
 * and line break if there is one, or, in an inline element at the edge of the
 * line, also at the edge of that element.
 */
function edgeCarets(options: MountOptions, edge: 'end' | 'start'): string[] {
  const offset =
    (options.leadingLine !== undefined ? 2 : 0) + (edge === 'end' ? COUNT : 0);
  return [
    `paragraph:${offset}`,
    ...(options.inInlineElements
      ? [`test_7158_inline_wrapper:${edge === 'end' ? 1 : 0}`]
      : []),
  ];
}
describe.each<[string, DecoratorClass, MountOptions]>([
  ['inline decorators', ImageLikeDecoratorNode, {}],
  ['unselectable boxed inline decorators', BoxedImageDecoratorNode, {}],
  [
    'unselectable boxed inline decorators each in an inline element',
    BoxedImageDecoratorNode,
    {inInlineElements: true},
  ],
  [
    'inline decorators on a line between line breaks',
    ImageLikeDecoratorNode,
    BETWEEN_LINE_BREAKS,
  ],
  [
    'unselectable boxed inline decorators on a line between line breaks',
    BoxedImageDecoratorNode,
    BETWEEN_LINE_BREAKS,
  ],
  [
    'unselectable boxed inline decorators each in an inline element on a line between line breaks',
    BoxedImageDecoratorNode,
    {...BETWEEN_LINE_BREAKS, inInlineElements: true},
  ],
])('Issue #7158: mouse click beside %s', (_name, klass, options) => {
  // The paragraph offset of the line's first decorator: after the leading
  // line's text and line break.
  const first = options.leadingLine !== undefined ? 2 : 0;
  // The caret before the click, as an offset among the line's decorators,
  // if any: at the other end of the line, or beside the decorator clicked
  // next to, where the browser can leave it for the click.
  test.each<[string, string, 'end' | 'start', number | null]>([
    ['', 'left of the first', 'start', null],
    ['', 'right of the last', 'end', null],
    ['with a caret at the other end, ', 'left of the first', 'start', COUNT],
    ['with a caret at the other end, ', 'right of the last', 'end', 0],
    ['with a caret after it, ', 'left of the first', 'start', 1],
    ['with a caret before it, ', 'right of the last', 'end', COUNT - 1],
  ])(
    '%sa click %s decorator puts the caret at the %s of the line',
    async (_caret, _side, edge, caretOffset) => {
      const {editor, left, pointerLog, right, root, y} = mount(
        false,
        klass,
        options,
      );
      if (caretOffset !== null) {
        root.focus();
        editor.update(
          () => {
            const paragraph = $getRoot().getFirstChild();
            assert($isParagraphNode(paragraph), 'expected the paragraph');
            paragraph.select(first + caretOffset, first + caretOffset);
          },
          {discrete: true},
        );
      }
      await mouseDrag([
        [edge === 'start' ? left(0) - 5 : right(COUNT - 1) + 30, y],
      ]);
      await expectCaret(editor, edgeCarets(options, edge), pointerLog);
    },
  );
});

// The reconciler renders an edge box only after the decorator that ends a
// paragraph, so a line that a line break ends has none.
describe.each([
  ['', false],
  [' that are each in an inline element', true],
])(
  'Issue #7158: mouse drag over inline decorators%s beside a line break',
  (_name, inInlineElements) => {
    test(
      'on a line a line break starts, a drag from left of the first decorator selects to the end of the line',
      dragFromLineStart(ImageLikeDecoratorNode, false, {
        inInlineElements,
        leadingLine: 'text',
      }),
    );
    test(
      'on a line a line break ends, a drag from right of the last decorator selects back to the third',
      dragFromLineEnd(ImageLikeDecoratorNode, false, {
        inInlineElements,
        trailingLine: 'text',
      }),
    );
  },
);

// A line that the browser wraps after a decorator ends in that decorator, as
// one that a line break ends does: with a word too long for the rest of the
// line right after the last decorator, or with only decorators, three to a
// line. Past the end of such a line, Firefox puts a drag's focus inside the
// decorator, and WebKit puts a press or a drag's focus before it.
describe.each<[string, MountOptions, number]>([
  [
    'a long word wraps after the last decorator',
    {trailingText: 'b'.repeat(30)},
    COUNT,
  ],
  ['the decorators wrap after the third', {width: 3 * SIZE + 30}, 3],
])(
  'Issue #7158: mouse drag and click on a line that %s',
  (_name, options, count) => {
    // The editor, with the point right of the end of its first line.
    const mountWrapped = () => {
      const mounted = mount(false, ImageLikeDecoratorNode, options);
      const {left, right, textRect, y} = mounted;
      const next =
        options.trailingText !== undefined ? textRect('b').left : left(count);
      assert(
        next < right(count - 1),
        `expected the line to wrap after decorator ${count}`,
      );
      const end: [x: number, y: number] = [right(count - 1) + 20, y];
      return {...mounted, end};
    };
    test('a drag from left of the first decorator past the end of the line selects to the end of the line', async () => {
      const {editor, end, left, pointerLog, y} = mountWrapped();
      await mouseDrag([[left(0) - 5, y], [left(1) + SIZE / 2, y], end]);
      await expectSelectedDecoratorCount(editor, count, pointerLog);
    });
    test('a click past the end of the line puts the caret after the last decorator', async () => {
      const {editor, end, pointerLog} = mountWrapped();
      await mouseDrag([end]);
      // Or at the start of the word after it, the same position.
      await expectCaret(editor, [`paragraph:${count}`, 'text:0'], pointerLog);
    });
    test('a drag from past the end of the line selects back to the second decorator', async () => {
      const {editor, end, left, pointerLog, y} = mountWrapped();
      await mouseDrag([end, [left(count - 1) + SIZE / 2, y], [left(1) - 2, y]]);
      await expectSelectedDecoratorCount(editor, count - 1, pointerLog);
    });
  },
);

describe('Issue #7158: mouse presses the drag fallback leaves alone', () => {
  // A double-click drag extends the selection by words, keeping the word it
  // selected; the drag's anchor moves to whichever end of that word is
  // farther from the pointer.
  test('a double-click drag keeps the double-clicked word', async () => {
    const {editor, left, textRect, y} = mount(false, ImageLikeDecoratorNode, {
      trailingText: ' hello world',
    });
    const word = textRect('world');
    const wordY = (word.top + word.bottom) / 2;
    await mouseDrag(
      [
        [(word.left + word.right) / 2, wordY],
        [left(COUNT - 1) + SIZE / 2, y],
        [left(2) - 2, y],
      ],
      {clickCount: 2},
    );
    await vi.waitFor(() => {
      const text = editor.read('latest', () => {
        const selection = $getSelection();
        return $isRangeSelection(selection) ? selection.getTextContent() : '';
      });
      assert(
        text.endsWith(' hello world'),
        `expected the selection to end with the double-clicked word, got ${JSON.stringify(text)}`,
      );
    });
  });

  // Something can cancel a press after Lexical has started tracking it (a
  // check list item's check mark does on pointerdown, the playground's card
  // chrome on mousedown), and the browser then starts no selection drag.
  test.each([
    ['pointerdown', true],
    ['mousedown', false],
  ])('a press whose %s is cancelled selects nothing', async (type, capture) => {
    const {editor, left, root, textRect, y} = mount(
      false,
      BoxedImageDecoratorNode,
      {trailingText: ' hello world'},
    );
    root.focus();
    editor.update(
      () => {
        $getRoot().selectEnd();
      },
      {discrete: true},
    );
    onTestFinished(
      registerEventListener(
        root,
        type,
        event => event.preventDefault(),
        capture,
      ),
    );
    const world = textRect('world');
    await mouseDrag([
      [(world.left + world.right) / 2, (world.top + world.bottom) / 2],
      [left(COUNT - 1) + SIZE / 2, y],
      [left(2) - 2, y],
    ]);
    assert(
      editor.read('latest', () => {
        const selection = $getSelection();
        return $isRangeSelection(selection) && selection.isCollapsed();
      }),
      `expected the caret to stay put, got ${describeDOMSelection(getDOMSelection(window))}`,
    );
  });

  // A collaborator's edit (simulated here) can change the text at the drag's
  // anchor mid-drag, and move the editor's selection with it.
  test('a drag whose anchor text changes mid-drag continues from the moved anchor', async () => {
    const {editor, left, root, textRect, trailingTextKey, y} = mount(
      false,
      ImageLikeDecoratorNode,
      {trailingText: ' hello world'},
    );
    assert(trailingTextKey !== null, 'expected the trailing text');
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    onTestFinished(registerEventListener(window, 'error', onError));
    let edited = false;
    let moves = 0;
    // On the second move of the drag, once it has started from its anchor.
    const edit = (event: PointerEvent) => {
      if (!edited && event.buttons === 1 && ++moves === 2) {
        edited = true;
        editor.update(
          () => {
            $assertNodeType(
              $getNodeByKey(trailingTextKey),
              $isTextNode,
            ).setTextContent(' hi');
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.anchor.set(trailingTextKey, 3, 'text');
              if (selection.focus.key === trailingTextKey) {
                selection.focus.set(trailingTextKey, 3, 'text');
              }
            }
          },
          {discrete: true},
        );
      }
    };
    onTestFinished(registerEventListener(root, 'pointermove', edit, true));
    const end = textRect('world').right + 30;
    await mouseDrag([
      [end, y],
      [end - 30, y],
      [left(COUNT - 1) + SIZE / 2, y],
      [left(2) - 2, y],
    ]);
    assert(edited, 'the drag never moved');
    assert(errors.length === 0, `uncaught errors: ${errors.join(', ')}`);
    await vi.waitFor(() => {
      const anchor = editor.read('latest', () => {
        const selection = $getSelection();
        return $isRangeSelection(selection)
          ? `${selection.anchor.key}:${selection.anchor.offset}`
          : String(selection);
      });
      assert(
        anchor === `${trailingTextKey}:3`,
        `expected the anchor at the end of the edited text, got ${anchor}`,
      );
    });
  });

  // A press whose release never reached the window (a context menu or a
  // dialog took it), or that became a drag and drop, leaves a drag behind,
  // which must not move the focus of a later selection to where that drag
  // last was. A move with no button ends it, as do a dragstart, a context
  // menu, a key, a pointercancel, and the window losing focus.
  test.each([
    'a move with no button',
    'dragstart',
    'a context menu',
    'a pointercancel',
    'a window blur',
    'the key',
  ])('a press ended by %s leaves a later selection alone', async ending => {
    const {editor, left, root, textRect, trailingTextKey, y} = mount(
      false,
      ImageLikeDecoratorNode,
      {trailingText: ' hello world'},
    );
    assert(trailingTextKey !== null, 'expected the trailing text');
    root.focus();
    editor.update(
      () => {
        $assertNodeType($getNodeByKey(trailingTextKey), $isTextNode).select(
          6,
          6,
        );
      },
      {discrete: true},
    );
    // A press on the caret, then a first move over the third decorator,
    // which the editor leaves to the browser.
    const hello = textRect('hello');
    const press = mousePointerInit(root, hello.right, hello.y);
    const target = elementAt(press);
    target.dispatchEvent(new PointerEvent('pointerdown', press));
    target.dispatchEvent(new MouseEvent('mousedown', {...press, detail: 1}));
    const over = mousePointerInit(root, left(2) + SIZE / 4, y);
    elementAt(over).dispatchEvent(new PointerEvent('pointermove', over));
    if (ending === 'a move with no button') {
      target.dispatchEvent(
        new PointerEvent('pointermove', {...over, buttons: 0}),
      );
    } else if (ending === 'dragstart') {
      target.dispatchEvent(
        new DragEvent('dragstart', {bubbles: true, cancelable: true}),
      );
    } else if (ending === 'a context menu') {
      target.dispatchEvent(new MouseEvent('contextmenu', over));
    } else if (ending === 'a pointercancel') {
      elementAt(over).dispatchEvent(new PointerEvent('pointercancel', over));
    } else if (ending === 'a window blur') {
      window.dispatchEvent(new FocusEvent('blur'));
    }
    // Then the selection changes, once the editor has handled the moves.
    await new Promise(resolve => setTimeout(resolve));
    if (ending === 'the key') {
      await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    } else {
      // As a drop, or a script, moves it.
      const text = editor.getElementByKey(trailingTextKey)?.firstChild;
      assert(isDOMTextNode(text), 'expected the trailing text');
      getDOMSelection(window)?.setBaseAndExtent(text, 6, text, 5);
    }
    await vi.waitFor(() => {
      const points = editor.read('latest', () => {
        const selection = $getSelection();
        return $isRangeSelection(selection)
          ? `${selection.anchor.key}:${selection.anchor.offset}->` +
              `${selection.focus.key}:${selection.focus.offset}`
          : String(selection);
      });
      assert(
        points === `${trailingTextKey}:6->${trailingTextKey}:5`,
        `expected the focus one character back, got ${points}`,
      );
    });
  });

  // An app can cancel a press before the editor's listener sees it (a check
  // list item's check mark does), or after, on the document or on an
  // ancestor of the root (where React handles onMouseDown). The browser then
  // moves neither the caret nor the focus, and the editor must not either. A
  // click that is not cancelled takes the focus from an input outside and
  // puts the caret beside the decorator.
  test.each<[string, 'document' | 'parent' | 'root' | null, boolean]>([
    ['is cancelled before the editor sees it', 'root', false],
    ['is cancelled on the document', 'document', false],
    ["is cancelled on the root's parent", 'parent', false],
    [
      'is cancelled on the document while an input outside has the focus',
      'document',
      true,
    ],
    ['is not cancelled while an input outside has the focus', null, true],
  ])(
    'a click right of the last decorator that %s',
    async (_name, cancelledOn, inputFocused) => {
      const {editor, pointerLog, right, root, y} = mount(
        false,
        ImageLikeDecoratorNode,
      );
      const parent = root.parentElement;
      assert(parent !== null, 'expected the root in an element');
      root.focus();
      editor.update(
        () => {
          $assertNodeType($getRoot().getFirstChild(), $isParagraphNode).select(
            0,
            0,
          );
        },
        {discrete: true},
      );
      const input = document.createElement('input');
      if (inputFocused) {
        parent.appendChild(input);
        input.focus();
      }
      const changes = recordSelectionChanges(editor);
      if (cancelledOn !== null) {
        onTestFinished(
          registerEventListener(
            cancelledOn === 'document'
              ? document
              : cancelledOn === 'parent'
                ? parent
                : root,
            'mousedown',
            event => event.preventDefault(),
            cancelledOn === 'root',
          ),
        );
      }
      await mouseDrag([[right(COUNT - 1) + 30, y]]);
      await expectCaret(
        editor,
        `paragraph:${cancelledOn !== null ? 0 : COUNT}`,
        pointerLog,
      );
      const focused = cancelledOn !== null && inputFocused ? input : root;
      const expectedChanges = cancelledOn !== null ? 0 : 1;
      assert(
        changes.length === expectedChanges &&
          document.activeElement === focused,
        `expected ${expectedChanges} selection changes and the focus on ` +
          `${focused.nodeName}, got ` +
          `[${changes.map(change => change.description).join(', ')}] and ` +
          `the focus on ${document.activeElement?.nodeName}`,
      );
    },
  );

  // The app can also put the caret somewhere itself in its listener, and the
  // selectionchange of that must not take the cancelled press up again.
  test.each([
    ['the document', 'document'],
    ["the root's parent", 'parent'],
  ])(
    'a click right of the last decorator that is cancelled on %s by a listener that puts the caret elsewhere',
    async (_name, cancelledOn) => {
      const {editor, pointerLog, right, root, trailingTextKey, y} = mount(
        false,
        ImageLikeDecoratorNode,
        {trailingLine: 'hello world'},
      );
      assert(trailingTextKey !== null, 'expected the trailing text');
      const parent = root.parentElement;
      assert(parent !== null, 'expected the root in an element');
      root.focus();
      editor.update(
        () => {
          $assertNodeType($getRoot().getFirstChild(), $isParagraphNode).select(
            0,
            0,
          );
        },
        {discrete: true},
      );
      onTestFinished(
        registerEventListener(
          cancelledOn === 'document' ? document : parent,
          'mousedown',
          event => {
            event.preventDefault();
            editor.update(
              () => {
                $assertNodeType(
                  $getNodeByKey(trailingTextKey),
                  $isTextNode,
                ).selectEnd();
              },
              {discrete: true},
            );
          },
        ),
      );
      await mouseDrag([[right(COUNT - 1) + 30, y]]);
      await expectCaret(editor, 'text:11', pointerLog);
    },
  );

  // The mouse events a touch or pen tap is followed by must not move the
  // caret before the platform puts its own, which iOS and Android manage
  // closely; a mouse press beside the decorator does.
  test.each([
    ['touch', 0],
    ['pen', 0],
    ['mouse', COUNT],
  ])(
    'the mouse events of a %s press right of the last decorator put the caret at %i',
    async (pointerType, offset) => {
      const {editor, pointerLog, right, root, y} = mount(
        false,
        ImageLikeDecoratorNode,
      );
      root.focus();
      editor.update(
        () => {
          $assertNodeType($getRoot().getFirstChild(), $isParagraphNode).select(
            0,
            0,
          );
        },
        {discrete: true},
      );
      const init = {
        ...mousePointerInit(root, right(COUNT - 1) + 30, y),
        pointerType,
      };
      const target = elementAt(init);
      target.dispatchEvent(new PointerEvent('pointerdown', init));
      target.dispatchEvent(new MouseEvent('mousedown', {...init, detail: 1}));
      // Synthetic events have no default action, so the caret is final once
      // the editor's update has committed.
      await new Promise(resolve => setTimeout(resolve));
      target.dispatchEvent(
        new PointerEvent('pointerup', {...init, buttons: 0}),
      );
      await expectCaret(editor, `paragraph:${offset}`, pointerLog);
    },
  );

  // Chromium commits a composition in the default action of the press that
  // ends it, which runs after the editor's listeners, so the press must leave
  // the caret in the composition for that.
  test('a press right of the last decorator during a composition leaves the caret in it', async () => {
    const {editor, pointerLog, right, root, y} = mount(
      true,
      ImageLikeDecoratorNode,
    );
    root.focus();
    // In the text before the last decorator.
    const paragraphOffset = 2 * COUNT - 2;
    editor.update(
      () => {
        $assertNodeType($getRoot().getFirstChild(), $isParagraphNode).select(
          paragraphOffset,
          paragraphOffset,
        );
      },
      {discrete: true},
    );
    root.dispatchEvent(
      new CompositionEvent('compositionstart', {bubbles: true, data: ''}),
    );
    assert(editor.isComposing(), 'expected a composition');
    const caret = describeEditorSelection(editor);
    const init = mousePointerInit(root, right(COUNT - 1) + 30, y);
    const target = elementAt(init);
    target.dispatchEvent(new PointerEvent('pointerdown', init));
    target.dispatchEvent(new MouseEvent('mousedown', {...init, detail: 1}));
    await Promise.resolve();
    assert(editor.isComposing(), 'expected the composition to go on');
    assert(
      describeEditorSelection(editor) === caret,
      `expected the caret to stay at ${caret}, got ` +
        `${describeEditorSelection(editor)} (pointer ${pointerLog.join(' ')})`,
    );
    target.dispatchEvent(new PointerEvent('pointerup', {...init, buttons: 0}));
  });

  // A listener that runs before the editor's can update the editor in the
  // same task, without committing, and add an inline decorator at the end of
  // the line, which then has no DOM to measure.
  test('a press right of a decorator that an update has just put at the end of the line', async () => {
    const {editor, right, root, y} = mount(false, ImageLikeDecoratorNode);
    root.focus();
    editor.update(
      () => {
        $assertNodeType($getRoot().getFirstChild(), $isParagraphNode).select(
          0,
          0,
        );
      },
      {discrete: true},
    );
    const errors: unknown[] = [];
    onTestFinished(
      registerEventListener(window, 'error', event => {
        errors.push(event.error);
        event.preventDefault();
      }),
    );
    onTestFinished(
      registerEventListener(
        root,
        'mousedown',
        () =>
          editor.update(() => {
            $assertNodeType(
              $getRoot().getFirstChild(),
              $isParagraphNode,
            ).append($create(ImageLikeDecoratorNode));
          }),
        true,
      ),
    );
    const init = mousePointerInit(root, right(COUNT - 1) + 30, y);
    const target = elementAt(init);
    target.dispatchEvent(new PointerEvent('pointerdown', init));
    target.dispatchEvent(new MouseEvent('mousedown', {...init, detail: 1}));
    await Promise.resolve();
    target.dispatchEvent(new PointerEvent('pointerup', {...init, buttons: 0}));
    assert(errors.length === 0, `uncaught errors: ${errors.join(', ')}`);
    const count = editor.read(
      'latest',
      () =>
        $getRoot().getAllTextNodes().length +
        $getRoot()
          .getChildren()
          .flatMap(node => ($isParagraphNode(node) ? node.getChildren() : []))
          .filter($isDecoratorNode).length,
    );
    assert(
      count === COUNT + 1,
      `expected ${COUNT + 1} decorators, got ${count}`,
    );
  });
});

/** The editor's selection, as anchor->focus key:offset points. */
/**
 * Resolves on the next selectionchange, after the editor's listener, which
 * was registered before this one, has handled it.
 */
function nextSelectionChange(): Promise<void> {
  return new Promise(resolve =>
    onTestFinished(
      registerEventListener(document, 'selectionchange', () => resolve()),
    ),
  );
}

function describeEditorSelection(editor: LexicalEditor): string {
  return editor.read('latest', () => {
    const selection = $getSelection();
    return $isRangeSelection(selection)
      ? `${selection.anchor.key}:${selection.anchor.offset}->` +
          `${selection.focus.key}:${selection.focus.offset}`
      : String(selection);
  });
}

/**
 * Waits for a caret at `expected`, `type:offset` with the type of its node,
 * or at one of them.
 */
async function expectCaret(
  editor: LexicalEditor,
  expected: string | string[],
  pointerLog: string[],
): Promise<void> {
  const carets = typeof expected === 'string' ? [expected] : expected;
  await vi.waitFor(
    () => {
      const caret = editor.read('latest', () => {
        const selection = $getSelection();
        return $isRangeSelection(selection) && selection.isCollapsed()
          ? `${selection.anchor.getNode().getType()}:${selection.anchor.offset}`
          : String(selection);
      });
      assert(
        carets.includes(caret),
        `expected the caret at ${carets.join(' or ')}, got ${caret} ` +
          `(dom ${describeDOMSelection(getDOMSelection(window))}; ` +
          `pointer ${pointerLog.join(' ')})`,
      );
    },
    {interval: 50, timeout: 2000},
  );
}

/**
 * Keeps selectionchange events from the editor while `isWithheld()`, as a
 * busy main thread can deliver one after the input events that follow it.
 * The drag command still sees them, as it listens on the window.
 */
function withholdSelectionChanges(isWithheld: () => boolean): void {
  onTestFinished(
    registerEventListener(
      document,
      'selectionchange',
      event => {
        if (isWithheld()) {
          event.stopImmediatePropagation();
        }
      },
      true,
    ),
  );
}

/**
 * Keeps the selectionchange events of a press from the editor until its
 * first move, or with `untilRelease` until its release, as a busy main thread
 * can deliver them after those. The editor then gets one after the release.
 */
function withholdPressSelectionChanges(untilRelease = false): void {
  let isWithheld = false;
  onTestFinished(
    registerEventListeners(document, {
      pointerdown: () => {
        isWithheld = true;
      },
      // After the editor's listener.
      pointermove: event => {
        if (!untilRelease && event.buttons === 1) {
          isWithheld = false;
        }
      },
      pointerup: () => {
        if (isWithheld) {
          isWithheld = false;
          setTimeout(() =>
            document.dispatchEvent(new Event('selectionchange')),
          );
        }
      },
    }),
  );
  withholdSelectionChanges(() => isWithheld);
}

/**
 * Keeps the selectionchange events of a drag's move to `x` (relative to
 * `root`) from the editor until its release, as a busy main thread can
 * deliver them after that. The editor then gets one after the release, and
 * the promise resolves once it has handled that one.
 */
function withholdLastMoveSelectionChanges(
  root: HTMLElement,
  x: number,
): Promise<void> {
  const clientX = root.getBoundingClientRect().left + x;
  let isWithheld = false;
  let onHandled = () => {};
  const handled = new Promise<void>(resolve => {
    onHandled = resolve;
  });
  onTestFinished(
    registerEventListeners(document, {
      pointermove: event => {
        if (event.buttons === 1 && Math.abs(event.clientX - clientX) < 1) {
          isWithheld = true;
        }
      },
      pointerup: () => {
        if (isWithheld) {
          isWithheld = false;
          setTimeout(() => {
            document.dispatchEvent(new Event('selectionchange'));
            onHandled();
          });
        }
      },
    }),
  );
  withholdSelectionChanges(() => isWithheld);
  return handled;
}

describe('Issue #7158: mouse drags whose events come in another order', () => {
  // Chromium and WebKit decide on the first move of a press whether it drags
  // a selection that holds the press point. The editor must not select up to
  // a decorator beside the press before then, or the gesture becomes a drag
  // and drop of that selection.
  test('a drag from text whose first move crosses half a decorator selects across it', async () => {
    let decoratorKey = '';
    const {editor, root} = mountEditor(() => {
      const decorator = $create(ImageLikeDecoratorNode);
      decoratorKey = decorator.getKey();
      return [
        $createParagraphNode().append(
          $createTextNode('hello '),
          decorator,
          $createTextNode(' world and more'),
        ),
      ];
    });
    const image = editor.getElementByKey(decoratorKey)?.firstElementChild;
    assert(image != null, 'expected the image');
    const box = rectIn(root, image);
    // On the line's text, as the press is.
    const text = image.parentElement?.previousSibling?.firstChild;
    assert(isDOMTextNode(text), 'expected the text before the decorator');
    const {y} = rectIn(root, text, 0);
    let dragStarts = 0;
    onTestFinished(
      registerEventListener(
        document,
        'dragstart',
        () => {
          dragStarts++;
        },
        true,
      ),
    );
    await commands.mouseDrag(
      '#issue-7158-root',
      [
        [box.left - 2, y],
        [box.left + (SIZE * 3) / 4, y],
        [box.right + 60, y],
      ],
      {maxStep: SIZE, quickStart: true},
    );
    assert(dragStarts === 0, 'expected no drag and drop');
    await expectSelectedDecoratorCount(editor, 1, []);
  });

  // A hand that moves fast makes the first move of a drag well away from the
  // press, before the editor has seen the press's selectionchange.
  test('over unselectable boxed inline decorators on a line between line breaks, a drag with a fast first move from left of the first selects to the end of the line', () =>
    dragFromLineEdge(
      'start',
      mount(false, BoxedImageDecoratorNode, BETWEEN_LINE_BREAKS),
      {quickStart: true},
    ));

  // On a busy main thread the first move of a drag can come before the
  // selectionchange of its press. The drag must still extend from the press,
  // not from the caret before it, and from beside a decorator the press is
  // beyond.
  test.each<[string, DecoratorClass, MountOptions, 'end' | 'start']>([
    [
      'right of the last decorator of a line between line breaks',
      ImageLikeDecoratorNode,
      BETWEEN_LINE_BREAKS,
      'end',
    ],
    [
      'left of the first unselectable boxed decorator of a line between line breaks',
      BoxedImageDecoratorNode,
      BETWEEN_LINE_BREAKS,
      'start',
    ],
    [
      'left of the first decorator of a line, in an editor recovered from an error,',
      BoxedImageDecoratorNode,
      {...BETWEEN_LINE_BREAKS, recoverFromError: true},
      'start',
    ],
  ])(
    'a drag from %s whose first move comes before the selectionchange of its press selects from beside the decorator',
    async (_name, klass, options, edge) => {
      const mounted = mount(false, klass, options);
      withholdPressSelectionChanges();
      await dragFromLineEdge(edge, mounted);
    },
  );

  test('a drag from text whose first move comes before the selectionchange of its press extends from the press', async () => {
    const {editor, left, pointerLog, root, textRect, y} = mount(
      false,
      BoxedImageDecoratorNode,
      {trailingText: ' hello world'},
    );
    root.focus();
    editor.update(
      () => {
        $getRoot().selectStart();
      },
      {discrete: true},
    );
    withholdPressSelectionChanges();
    const world = textRect('world');
    await mouseDrag([
      [world.x, world.y],
      [left(COUNT - 1) + SIZE / 2, y],
      [left(2) - 2, y],
    ]);
    await expectSelectedDecoratorCount(editor, COUNT - 2, pointerLog);
  });

  // The release can come before the selectionchange of the last move, which
  // the editor then gets after the drag.
  test('a drag released before the selectionchange of its last move puts the focus beside the decorator', async () => {
    const {editor, left, pointerLog, right, root, y} = mount(
      false,
      SelectableBoxedImageDecoratorNode,
    );
    withholdLastMoveSelectionChanges(root, left(2) + SIZE / 4);
    await mouseDrag([
      [right(COUNT - 1) + 30, y],
      [left(COUNT - 2) + SIZE / 2, y],
      [left(3) + SIZE / 2, y],
      [left(2) + SIZE / 4, y],
    ]);
    await expectSelectedDecoratorCount(editor, COUNT - 2, pointerLog);
  });

  // Past the end of a line between line breaks, WebKit puts a drag's focus at
  // the end of the line above, which the editor moves back beside the last
  // decorator. When the selectionchange of the last such move comes after the
  // release, the release must do that, or the selectionchange then selects
  // the line break above instead of the decorators.
  test('a drag from left of the first decorator of a line between line breaks to past its end, released before the selectionchange of its last move, selects to the end of the line', async () => {
    const {editor, left, pointerLog, right, root, y} = mount(
      false,
      ImageLikeDecoratorNode,
      BETWEEN_LINE_BREAKS,
    );
    const lastMoveHandled = withholdLastMoveSelectionChanges(
      root,
      right(COUNT - 1) + 30,
    );
    await mouseDrag([
      [left(0) - 5, y],
      [left(1) + SIZE / 2, y],
      [left(COUNT - 2) + SIZE / 2, y],
      [right(COUNT - 1) + 30, y],
    ]);
    await lastMoveHandled;
    await expectSelectedDecoratorCount(editor, COUNT, pointerLog);
    assertNoLineBreakSelected(editor, pointerLog);
  });

  // On a busy main thread the release of a click can come before the
  // selectionchange of its press.
  test.each<[string, DecoratorClass, MountOptions, 'end' | 'start']>([
    [
      'left of the first decorator of a line between line breaks',
      ImageLikeDecoratorNode,
      BETWEEN_LINE_BREAKS,
      'start',
    ],
    [
      'right of the last decorator of a line between line breaks',
      ImageLikeDecoratorNode,
      BETWEEN_LINE_BREAKS,
      'end',
    ],
  ])(
    'a click %s released before the selectionchange of its press puts the caret beside the decorator',
    async (_name, klass, options, edge) => {
      const {editor, left, pointerLog, right, y} = mount(false, klass, options);
      withholdPressSelectionChanges(true);
      await mouseDrag([
        [edge === 'start' ? left(0) - 5 : right(COUNT - 1) + 30, y],
      ]);
      await expectCaret(editor, edgeCarets(options, edge), pointerLog);
    },
  );

  test('typing after a click in bold text released before the selectionchange of its press types bold text', async () => {
    let boldKey = '';
    const {editor, root} = mountEditor(() => {
      const bold = $createTextNode('bold text').toggleFormat('bold');
      boldKey = bold.getKey();
      return [
        $createParagraphNode().append($createTextNode('plain text '), bold),
      ];
    });
    root.focus();
    editor.update(
      () => {
        $getRoot().selectStart();
      },
      {discrete: true},
    );
    withholdPressSelectionChanges(true);
    const text = editor.getElementByKey(boldKey)?.firstChild;
    assert(isDOMTextNode(text), 'expected the bold text');
    const {left, y} = rectIn(root, text, 4);
    await mouseDrag([[left, y]]);
    const clicked = describeEditorSelection(editor);
    await userEvent.keyboard('X');
    await vi.waitFor(() => {
      const format = editor.read('latest', () => {
        const typed = $getRoot()
          .getAllTextNodes()
          .find(node => node.getTextContent().includes('X'));
        return typed === undefined ? 'nothing typed' : typed.getFormat();
      });
      assert(
        format === 1,
        `expected X typed in bold, got format ${format} after a click ` +
          `to ${clicked}`,
      );
    });
  });

  // A press on a selection can start a drag and drop of it, which the browser
  // decides on once the pointer has moved a few pixels. Until then the moves
  // must leave the selection alone, also in a shadow root, where WebKit
  // reports a selection as collapsed at the host. On macOS, Chromium and
  // WebKit drag a selection only when the pointer has stayed still for 150ms
  // after the press, and otherwise select from the pointer.
  test.each([
    ['', false],
    [' in a shadow root', true],
  ])(
    'a drag and drop of a selection%s drags the selection that was pressed',
    async (_name, inShadowRoot) => {
      const {editor, pointerLog, right, root, textRect, trailingTextKey, y} =
        mount(false, ImageLikeDecoratorNode, {
          inShadowRoot,
          trailingText: ' hello world',
        });
      assert(trailingTextKey !== null, 'expected the trailing text');
      root.focus();
      // From before the second decorator to after "hello".
      editor.update(
        () => {
          const paragraph = $assertNodeType(
            $getRoot().getFirstChild(),
            $isParagraphNode,
          );
          const selection = $createRangeSelection();
          selection.anchor.set(paragraph.getKey(), 1, 'element');
          selection.focus.set(trailingTextKey, 6, 'text');
          $setSelection(selection);
        },
        {discrete: true},
      );
      const pressed = describeEditorSelection(editor);
      let dragged: string | null = null;
      onTestFinished(
        registerEventListener(
          document,
          'dragstart',
          event => {
            dragged = describeEditorSelection(editor);
            event.preventDefault();
          },
          true,
        ),
      );
      // On the space after the last decorator, then onto that decorator.
      const textY = textRect('hello').y;
      await mouseDrag(
        [
          [right(COUNT - 1) + 2, textY],
          [right(COUNT - 1) - 3, textY],
          [right(COUNT - 1) - 3, y + 3 * SIZE],
        ],
        {hold: 200},
      );
      assert(
        dragged === pressed,
        `expected a drag of ${pressed}, got ${dragged} ` +
          `(pointer ${pointerLog.join(' ')})`,
      );
    },
  );

  // Chromium and WebKit take a press beyond either end of a selected line for
  // a press on the selection, so the press must leave it to them. Firefox
  // selects from there instead.
  test.skipIf(server.browser === 'firefox')(
    'a drag and drop of a selection pressed beyond the end of its line drags the selection',
    async () => {
      const {editor, pointerLog, right, root, y} = mount(
        true,
        ImageLikeDecoratorNode,
        {trailingLine: 'below'},
      );
      root.focus();
      // The whole first line.
      editor.update(
        () => {
          $assertNodeType($getRoot().getFirstChild(), $isParagraphNode).select(
            0,
            2 * COUNT,
          );
        },
        {discrete: true},
      );
      const describeContent = () =>
        editor.read('latest', () => {
          const selection = $getSelection();
          return $isRangeSelection(selection)
            ? `${selection.getNodes().filter($isDecoratorNode).length} ` +
                `decorators and ${JSON.stringify(selection.getTextContent())}`
            : String(selection);
        });
      const pressed = describeContent();
      let dragged: string | null = null;
      onTestFinished(
        registerEventListener(
          document,
          'dragstart',
          event => {
            dragged = describeContent();
            event.preventDefault();
          },
          true,
        ),
      );
      const x = right(COUNT - 1) + 10;
      // macOS drags a selection only after the pointer has stayed still for
      // 150ms.
      await mouseDrag(
        [
          [x, y],
          [x, y + 3 * SIZE],
        ],
        {hold: 200},
      );
      assert(
        dragged === pressed,
        `expected a drag of ${pressed}, got ${dragged}, then ` +
          `${describeEditorSelection(editor)} (pointer ${pointerLog.join(' ')})`,
      );
    },
  );
});

describe('Issue #7158: mouse drags in other layouts and states', () => {
  // A decorator drawn by its own element has no box inside it to measure.
  test('a drag released over the left half of a childless decorator puts the focus before it', async () => {
    const {editor, left, pointerLog, right, y} = mount(
      true,
      ChildlessDecoratorNode,
    );
    await mouseDrag([
      [right(COUNT - 1) + 30, y],
      [left(COUNT - 2) + SIZE / 2, y],
      [left(3) + SIZE / 2, y],
      [left(2) + 5, y],
    ]);
    await expectSelectedDecoratorCount(editor, COUNT - 2, pointerLog);
  });

  // A drag that overshoots the root element, or passes over something drawn
  // over it, is followed again once it is back.
  test('a drag that leaves the root element and comes back selects back to the third', async () => {
    const {editor, left, pointerLog, right, root, y} = mount(
      false,
      BoxedImageDecoratorNode,
    );
    await mouseDrag([
      [right(COUNT - 1) + 30, y],
      [root.getBoundingClientRect().width + 5, y],
      [left(COUNT - 2) + SIZE / 2, y],
      [left(3) + SIZE / 2, y],
      [left(2) - 2, y],
    ]);
    await expectSelectedDecoratorCount(editor, COUNT - 2, pointerLog);
  });

  // Windows repeats the keydown of a held Shift, and a modifier can be
  // pressed mid-drag, neither of which ends the drag.
  test('a drag with a repeated Shift keydown and an Alt keydown mid-drag selects back to the third', async () => {
    const {editor, left, pointerLog, right, root, y} = mount(
      false,
      BoxedImageDecoratorNode,
    );
    const keydowns: KeyboardEventInit[] = [
      {key: 'Shift', repeat: true, shiftKey: true},
      {altKey: true, key: 'Alt'},
    ];
    let moves = 0;
    onTestFinished(
      registerEventListener(root, 'pointermove', event => {
        const init = event.buttons === 1 ? keydowns[++moves - 2] : undefined;
        if (init) {
          root.dispatchEvent(
            new KeyboardEvent('keydown', {...init, bubbles: true}),
          );
        }
      }),
    );
    await mouseDrag([
      [right(COUNT - 1) + 30, y],
      [left(COUNT - 2) + SIZE / 2, y],
      [left(3) + SIZE / 2, y],
      [left(2) - 2, y],
    ]);
    await expectSelectedDecoratorCount(editor, COUNT - 2, pointerLog);
  });

  // A touch or a pen beside a drag, as on a touchscreen laptop, does not end
  // it, nor does the browser cancelling that touch to scroll.
  test('a drag with a touch and a pen moving beside it selects back to the third', async () => {
    const {editor, left, pointerLog, right, root, y} = mount(
      false,
      BoxedImageDecoratorNode,
    );
    const touch = {pointerId: 2, pointerType: 'touch'};
    const pen = {pointerId: 3, pointerType: 'pen'};
    const others: [string, PointerEventInit][] = [
      ['pointermove', {...touch, buttons: 1}],
      ['pointercancel', touch],
      ['pointermove', pen],
      ['pointerup', pen],
    ];
    let moves = 0;
    onTestFinished(
      registerEventListener(root, 'pointermove', event => {
        const other = event.buttons === 1 ? others[++moves - 2] : undefined;
        if (other) {
          document.dispatchEvent(new PointerEvent(...other));
        }
      }),
    );
    await mouseDrag([
      [right(COUNT - 1) + 30, y],
      [left(COUNT - 2) + SIZE / 2, y],
      [left(3) + SIZE / 2, y],
      [left(2) - 2, y],
    ]);
    assert(moves > others.length, 'expected each other pointer mid-drag');
    await expectSelectedDecoratorCount(editor, COUNT - 2, pointerLog);
  });

  // In right-to-left text the decorators run from the right, and the right
  // half of one is before it.
  test('a drag over right-to-left text and decorators selects back to the third', async () => {
    const {editor, left, pointerLog, right, y} = mount(
      true,
      BoxedImageDecoratorNode,
      {betweenText: 'א'},
    );
    await mouseDrag([
      [left(COUNT - 1) - 20, y],
      [right(COUNT - 2) - SIZE / 2, y],
      [right(3) - SIZE / 2, y],
      [right(2) - 5, y],
    ]);
    await expectSelectedDecoratorCount(editor, COUNT - 2, pointerLog);
  });

  // A decorator with a direction of its own, like a chip of code, is before
  // or after by the direction of its line: in a right-to-left one its right
  // half is before it, whatever its own direction.
  test.each<['left' | 'right', string, string, DecoratorClass]>([
    ['left', '', 'selects it', TextChipDecoratorNode],
    ['right', '', 'leaves it out', TextChipDecoratorNode],
    ['left', ' with dir=ltr', 'selects it', LtrTextChipDecoratorNode],
    ['right', ' with dir=ltr', 'leaves it out', LtrTextChipDecoratorNode],
    ['left', ' with dir=auto', 'selects it', AutoTextChipDecoratorNode],
    ['right', ' with dir=auto', 'leaves it out', AutoTextChipDecoratorNode],
  ])(
    'a drag from right-to-left text that ends over the %s half of a chip of text%s %s',
    async (half, _name, _verb, klass) => {
      const keys: string[] = [];
      const {editor, root} = mountEditor(() => {
        const paragraph = $createParagraphNode().append(
          $createTextNode('אבגד '),
          $create(klass),
          $createTextNode(' הוזח'),
        );
        keys.push(
          paragraph.getKey(),
          ...paragraph.getChildren().map(child => child.getKey()),
        );
        return [paragraph];
      });
      const [paragraphKey, firstKey, chipKey, lastKey] = keys;
      const text = editor.getElementByKey(firstKey)?.firstChild;
      const chip = editor.getElementByKey(chipKey);
      assert(isDOMTextNode(text) && chip != null, 'expected the text and chip');
      // From the start of the line, its right edge, leftwards.
      const start = rectIn(root, text, 0);
      const box = rectIn(root, chip);
      await mouseDrag([
        [start.right - 1, start.y],
        [half === 'left' ? box.left + SIZE / 4 : box.right - SIZE / 4, start.y],
      ]);
      const expected = (
        half === 'left'
          ? [`${paragraphKey}:2`, `${lastKey}:0`]
          : [`${paragraphKey}:1`, `${firstKey}:5`]
      ).map(focus => `${firstKey}:0->${focus}`);
      await vi.waitFor(() => {
        const points = describeEditorSelection(editor);
        assert(
          expected.includes(points),
          `expected ${expected.join(' or ')}, got ${points}`,
        );
      });
    },
  );

  // The first node of a right-to-left line is at its right edge, so text left
  // of a decorator that starts the line, or right of one that ends it, is not
  // beyond the line.
  test.each(['start', 'end'])(
    'a click on right-to-left text beside a decorator at the %s of the line puts the caret in the text',
    async edge => {
      let textKey = '';
      const {editor, root} = mountEditor(() => {
        const text = $createTextNode('שלום עולם שלום');
        textKey = text.getKey();
        const decorator = $create(ImageLikeDecoratorNode);
        return [
          $createParagraphNode().append(
            ...(edge === 'start' ? [decorator, text] : [text, decorator]),
          ),
        ];
      });
      const text = editor.getElementByKey(textKey)?.firstChild;
      assert(isDOMTextNode(text), 'expected the text');
      const char = rectIn(root, text, 5);
      await mouseDrag([[char.x, char.y]]);
      await expectCaret(editor, ['text:5', 'text:6'], []);
    },
  );

  // Text flows beside an inline decorator floated right, so a pointer on that
  // text is not beyond the line the decorator starts.
  test.each([
    ['a click', [50, 51]],
    ['a drag', [2, 15]],
  ] as const)(
    '%s on text beside a decorator floated right selects that text',
    async (_name, [start, end]) => {
      let textKey = '';
      const {editor, root} = mountEditor(() => {
        const text = $createTextNode(
          'lorem ipsum dolor sit amet consectetur adipiscing elit sed do ' +
            'eiusmod tempor incididunt ut labore et dolore magna aliqua',
        );
        textKey = text.getKey();
        return [
          $createParagraphNode().append($create(FloatRightDecoratorNode), text),
        ];
      });
      const text = editor.getElementByKey(textKey)?.firstChild;
      assert(isDOMTextNode(text), 'expected the text');
      const first = rectIn(root, text, start);
      const last = rectIn(root, text, end - 1);
      await mouseDrag(
        start + 1 === end
          ? [[first.x, first.y]]
          : [
              [first.left + 1, first.y],
              [last.right - 1, last.y],
            ],
      );
      await vi.waitFor(() => {
        const points = describeEditorSelection(editor);
        assert(
          points.split('->').every(point => point.startsWith(`${textKey}:`)),
          `expected the selection in the text, got ${points}`,
        );
      });
    },
  );

  // Side by side, a line of one block can be level with a decorator that
  // ends a line of the other, and a press must leave that block alone.
  test('a click in a block beside one that ends in a decorator keeps the caret in the block clicked', async () => {
    let otherKey = '';
    const {editor, root} = mountEditor(() => {
      const other = $createParagraphNode().append(
        $createTextNode('aa'),
        $create(ImageLikeDecoratorNode),
      );
      otherKey = other.getKey();
      return [other, $createParagraphNode().append($createTextNode('bb'))];
    });
    root.style.display = 'grid';
    root.style.gridTemplateColumns = '1fr 1fr';
    // Once the editor has handled the selectionchange of the caret below.
    const selectionChanged = nextSelectionChange();
    root.focus();
    editor.update(
      () => {
        $assertNodeType($getNodeByKey(otherKey), $isParagraphNode).select(0, 0);
      },
      {discrete: true},
    );
    await selectionChanged;
    const blocks: string[] = [];
    onTestFinished(
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const block = selection.focus.getNode().getTopLevelElement();
            blocks.push(block === null ? 'none' : block.getKey());
          }
          return false;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
    );
    const decorator = root.querySelector('[data-lexical-decorator]');
    assert(decorator !== null, 'expected the decorator');
    const level = rectIn(root, decorator);
    await mouseDrag([[root.getBoundingClientRect().width - 30, level.y]]);
    await vi.waitFor(() =>
      assert(blocks.length > 0, 'expected a selection change'),
    );
    assert(
      !blocks.includes(otherKey),
      `expected no selection change in the other block, got ${blocks.join(', ')}`,
    );
  });

  // Beside a short line, a pointer between its text and a decorator floated
  // right that starts the paragraph is beyond the end of the line, not the
  // start.
  test('a click to the right of a short line beside a decorator floated right puts the caret at the end of the line', async () => {
    let textKey = '';
    const {editor, root} = mountEditor(() => {
      const text = $createTextNode('Short line.');
      textKey = text.getKey();
      return [
        $createParagraphNode().append($create(FloatRightDecoratorNode), text),
      ];
    });
    const text = editor.getElementByKey(textKey)?.firstChild;
    assert(isDOMTextNode(text), 'expected the text');
    const last = rectIn(root, text, text.length - 1);
    await mouseDrag([[last.right + 60, last.y]]);
    const expected = `${textKey}:${text.length}->${textKey}:${text.length}`;
    await vi.waitFor(() => {
      const points = describeEditorSelection(editor);
      assert(points === expected, `expected ${expected}, got ${points}`);
    });
  });

  // A drag can be released outside the root element, where the editor does
  // not see the release. A later drag from outside the editor that crosses
  // the root keeps its own anchor.
  test('after a drag released outside the root element, a drag from page text across the root keeps its anchor there', async () => {
    const {editor, left, pointerLog, right, root, y} = mount(
      false,
      ImageLikeDecoratorNode,
    );
    const other = document.createElement('div');
    other.style.cssText = 'width:380px;padding:10px;font-size:16px';
    document.body.appendChild(other);
    onTestFinished(() => other.remove());
    other.textContent = 'Page text outside of the editor.';
    const rootRect = root.getBoundingClientRect();
    const otherRect = other.getBoundingClientRect();
    const otherY = (otherRect.top + otherRect.bottom) / 2 - rootRect.top;
    await mouseDrag([
      [right(COUNT - 1) + 30, y],
      [left(3) + SIZE / 2, y],
      [100, otherY],
    ]);
    const before = describeEditorSelection(editor);
    await mouseDrag([
      [150, otherY],
      [170, otherY],
      [150, y],
      [left(1) + SIZE / 4, y],
    ]);
    await vi.waitFor(() => {
      const selection = getDOMSelection(window);
      assert(
        selection !== null && other.contains(selection.anchorNode),
        `expected the anchor in the page text, got ` +
          `${describeDOMSelection(selection)} (editor ${before} then ` +
          `${describeEditorSelection(editor)}; pointer ${pointerLog.join(' ')})`,
      );
    });
  });

  // The editor works out the format of a selection from the text it holds,
  // which typing at a caret uses, and must keep it when a release or the
  // first move of a press takes the selection from the DOM.
  test('a drag over bold text selects with the bold format', async () => {
    let textKey = '';
    const {editor, root} = mountEditor(() => {
      const text = $createTextNode('hello world and more').toggleFormat('bold');
      textKey = text.getKey();
      return [$createParagraphNode().append(text)];
    });
    const text = editor.getElementByKey(textKey)?.firstChild;
    assert(isDOMTextNode(text), 'expected the text');
    const from = rectIn(root, text, 1);
    const to = rectIn(root, text, 8);
    await mouseDrag([
      [from.x, from.y],
      [to.x, to.y],
    ]);
    await vi.waitFor(() =>
      assert(
        editor.read('latest', () => {
          const selection = $getSelection();
          return (
            $isRangeSelection(selection) &&
            !selection.isCollapsed() &&
            selection.hasFormat('bold')
          );
        }),
        `expected a bold selection, got ${describeEditorSelection(editor)}`,
      ),
    );
  });

  // A selection has the format of the text it holds, so one of only the
  // decorator before bold text has none, also where the editor has put the
  // focus back beside the decorator while the DOM's is inside it.
  test('a drag over a decorator before bold text selects it without the bold format', async () => {
    const {editor, root} = mountEditor(() => [
      $createParagraphNode()
        .setIndent(2)
        .append(
          $create(TextChipDecoratorNode),
          $createTextNode('hello').toggleFormat('bold'),
        ),
    ]);
    const decorator = root.querySelector('[data-lexical-decorator]');
    assert(decorator !== null, 'expected the decorator');
    const {left, right, y} = rectIn(root, decorator);
    await mouseDrag([
      [left - 20, y],
      [right - SIZE / 4, y],
    ]);
    await expectSelectedDecoratorCount(editor, 1, []);
    const format = editor.read('latest', () => {
      const selection = $getSelection();
      return $isRangeSelection(selection) ? selection.format : -1;
    });
    assert(
      format === 0,
      `expected no format, got ${format} for ` +
        `${describeEditorSelection(editor)} ` +
        `(dom ${describeDOMSelection(getDOMSelection(window))})`,
    );
  });

  // A click often moves the mouse a pixel or so, which is a drag.
  test('typing after a click on the caret that moves a pixel in bold text types bold text', async () => {
    let textKey = '';
    const {editor, root} = mountEditor(() => {
      const text = $createTextNode('hello world and more').toggleFormat('bold');
      textKey = text.getKey();
      return [$createParagraphNode().append(text)];
    });
    // Once the editor has handled the selectionchange of the caret below.
    const selectionChanged = nextSelectionChange();
    root.focus();
    // With the format a click would give it.
    editor.update(
      () => {
        const text = $assertNodeType($getNodeByKey(textKey), $isTextNode);
        text.select(7, 7).format = text.getFormat();
      },
      {discrete: true},
    );
    await selectionChanged;
    const text = editor.getElementByKey(textKey)?.firstChild;
    assert(isDOMTextNode(text), 'expected the text');
    const {left, y} = rectIn(root, text, 7);
    await mouseDrag([
      [left + 1, y],
      [left + 2, y],
      [left + 1, y],
    ]);
    const clicked = describeEditorSelection(editor);
    await userEvent.keyboard('X');
    await vi.waitFor(() => {
      const format = editor.read('latest', () => {
        const typed = $getRoot()
          .getAllTextNodes()
          .find(node => node.getTextContent().includes('X'));
        return typed === undefined ? 'nothing typed' : typed.getFormat();
      });
      assert(
        format === 1,
        `expected X typed in bold, got format ${format} after a click ` +
          `to ${clicked}`,
      );
    });
  });

  // A caret that a click puts beside a decorator in a line of plain text
  // takes the format and style of where it is, not those of the caret before
  // the click, also when the release comes first and the editor takes the
  // press from the DOM.
  test.each(
    (
      [
        ['bold', 'right of a decorator that ends a line', 2],
        ['bold', 'left of a decorator that starts a line', 0],
        ['red', 'right of a decorator that ends a line', 2],
        ['red', 'left of a decorator that starts a line', 0],
      ] as const
    ).flatMap(([formatted, name, offset]) =>
      ['', ', released before the selectionchange of its press,'].map(
        released => [formatted, name, released, offset] as const,
      ),
    ),
  )(
    'typing after a click from %s text to the %s%s types plain text',
    async (formatted, _name, released, offset) => {
      let textKey = '';
      const {editor, root} = mountEditor(() => {
        const text = $createTextNode('formatted text');
        textKey = text.getKey();
        const decorator = $create(ImageLikeDecoratorNode);
        if (formatted === 'bold') {
          text.toggleFormat('bold');
        } else {
          text.setStyle('color: red');
        }
        return [
          $createParagraphNode().append(text),
          offset === 0
            ? // Indented, to leave room for the click.
              $createParagraphNode()
                .setIndent(2)
                .append(decorator, $createTextNode(' plain text'))
            : $createParagraphNode().append(
                $createTextNode('plain text '),
                decorator,
              ),
        ];
      });
      // Once the editor has handled the selectionchange of the caret below.
      const selectionChanged = nextSelectionChange();
      root.focus();
      // With the format and style a click would give it.
      editor.update(
        () => {
          const text = $assertNodeType($getNodeByKey(textKey), $isTextNode);
          const selection = text.select(4, 4);
          selection.format = text.getFormat();
          selection.style = text.getStyle();
        },
        {discrete: true},
      );
      await selectionChanged;
      const decorator = root.querySelector('[data-lexical-decorator]');
      assert(decorator !== null, 'expected the decorator');
      const {left, right, y} = rectIn(root, decorator);
      if (released) {
        withholdPressSelectionChanges(true);
      }
      await mouseDrag([[offset === 0 ? left - 20 : right + 30, y]]);
      await expectCaret(editor, `paragraph:${offset}`, []);
      await userEvent.keyboard('X');
      await vi.waitFor(() => {
        const typed = editor.read('latest', () => {
          const node = $getRoot()
            .getAllTextNodes()
            .find(textNode => textNode.getTextContent().includes('X'));
          return node === undefined
            ? 'nothing typed'
            : `format ${node.getFormat()} style "${node.getStyle()}"`;
        });
        assert(
          typed === 'format 0 style ""',
          `expected X typed in plain text, got ${typed}`,
        );
      });
    },
  );

  // A format armed at a caret, as a toolbar button arms it, is for what is
  // typed there next, so a click that leaves the caret where it was keeps
  // it. Browsers fire no selectionchange for that click (WebKit does beside
  // a decorator), and the editor then takes its press at the release.
  test.each([
    ['at the end of a line of text', false],
    ['beside a decorator that ends its line', true],
  ])(
    'typing after a click that leaves the caret %s types the format armed there',
    async (_name, hasDecorator) => {
      const {editor, root} = mountEditor(() => {
        const paragraph = $createParagraphNode().append(
          $createTextNode('hello world'),
        );
        if (hasDecorator) {
          paragraph.append($create(ImageLikeDecoratorNode));
        }
        return [
          paragraph,
          $createParagraphNode().append($createTextNode('next')),
        ];
      });
      const end = root.querySelector(
        hasDecorator ? '[data-lexical-decorator]' : '[data-lexical-text]',
      );
      assert(end !== null, 'expected the end of the line');
      const {right, y} = rectIn(root, end);
      const caret = hasDecorator ? 'paragraph:2' : 'text:11';
      await mouseDrag([[right + 30, y]]);
      await expectCaret(editor, caret, []);
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
      await mouseDrag([[right + 30, y]]);
      await expectCaret(editor, caret, []);
      await userEvent.keyboard('X');
      await vi.waitFor(() => {
        const format = editor.read('latest', () => {
          const typed = $getRoot()
            .getAllTextNodes()
            .find(node => node.getTextContent().includes('X'));
          return typed === undefined ? 'nothing typed' : typed.getFormat();
        });
        assert(format === 1, `expected X typed in bold, got format ${format}`);
      });
    },
  );

  // A decorator is at the edge of its line only where what is beside it is
  // on another line, which the vertical position of their boxes does not
  // tell: a box aligned with the top of a tall line is above the text beside
  // it, a decorator without a box has an empty one, and text that wraps has
  // a box on each of its lines. A click or a drag that ends over the block
  // there keeps the browser's position in the text.
  describe.each<
    [
      string,
      'before' | 'after' | 'end',
      [string, string],
      (texts: LexicalNode[]) => LexicalNode[],
    ]
  >([
    [
      'above text before a box aligned with the top of the line',
      'before',
      ['hello there', ' world '],
      ([first, second]) => [
        first,
        $create(TopAlignedDecoratorNode),
        second,
        $create(ImageLikeDecoratorNode),
      ],
    ],
    [
      'above text after a box aligned with the top of the line',
      'after',
      ['hello there', ' world '],
      ([first, second]) => [
        first,
        $create(TopAlignedDecoratorNode),
        second,
        $create(ImageLikeDecoratorNode),
      ],
    ],
    [
      'above the end of text that wraps onto the line of a decorator after it',
      'before',
      [WRAPPING_TEXT, ' and more'],
      ([first, second]) => [first, $create(ImageLikeDecoratorNode), second],
    ],
    [
      'above the start of text after a decorator that wraps after that line',
      'after',
      ['and more ', WRAPPING_TEXT],
      ([first, second]) => [first, $create(ImageLikeDecoratorNode), second],
    ],
    [
      'past the end of a line where a decorator without a box follows an image',
      'end',
      ['aaa ', ' bbb ccc'],
      ([first, second]) => [
        first,
        $create(ImageLikeDecoratorNode),
        $create(ContentsChipDecoratorNode),
        second,
      ],
    ],
    [
      'past the end of a line where a hidden decorator follows an image',
      'end',
      ['aaa ', ' bbb ccc'],
      ([first, second]) => [
        first,
        $create(ImageLikeDecoratorNode),
        $create(HiddenDecoratorNode),
        second,
      ],
    ],
  ])('%s', (_name, where, [firstText, secondText], $line) => {
    // The editor, the point, and a check of the focus, in the text before
    // or after the first decorator, near the point or at the end of the line.
    const mountLine = () => {
      const keys: string[] = [];
      const {editor, root} = mountEditor(() => {
        const texts = [firstText, secondText, 'next line'].map(text =>
          $createTextNode(text),
        );
        keys.push(...texts.map(text => text.getKey()));
        return [
          $createParagraphNode().append(...$line(texts.slice(0, 2))),
          $createParagraphNode().append(texts[2]),
        ];
      });
      const [first, second, next] = keys.map(key => {
        const text = editor.getElementByKey(key)?.firstChild;
        assert(isDOMTextNode(text), 'expected the text');
        return text;
      });
      // The box inside the first decorator, or the decorator's own.
      const decorator = root.querySelector('[data-lexical-decorator]');
      assert(decorator !== null, 'expected a decorator');
      const box = rectIn(root, decorator.firstElementChild || decorator);
      const text = where === 'before' ? first : second;
      const char = rectIn(root, text, where === 'before' ? text.length - 3 : 3);
      const below = char.top - box.top;
      assert(
        below > 5 && below < SIZE,
        'expected the text below the point, on the line of the decorator',
      );
      const x = where === 'end' ? rectIn(root, text).right + 30 : char.x;
      return {
        expectFocus: async () => {
          await vi.waitFor(() => {
            const [key, offset] = editor.read(
              'latest',
              (): [string | null, number] => {
                const selection = $getSelection();
                return $isRangeSelection(selection)
                  ? [selection.focus.key, selection.focus.offset]
                  : [null, -1];
              },
            );
            assert(
              key === keys[where === 'before' ? 0 : 1] &&
                (where === 'end'
                  ? offset === text.length
                  : offset > 0 && offset < text.length),
              `expected the focus in ${JSON.stringify(text.data)} ` +
                `${where === 'end' ? 'at its end' : 'near the point'}, got ` +
                `${describeEditorSelection(editor)} ` +
                `(dom ${describeDOMSelection(getDOMSelection(window))})`,
            );
          });
        },
        // Near the top of the decorator, above the text on its line.
        point: [x, box.top + 5] as [x: number, y: number],
        start: rectIn(root, next, 4),
      };
    };
    test('a click', async () => {
      const {expectFocus, point} = mountLine();
      await mouseDrag([point]);
      await expectFocus();
    });
    test('a drag from the next line', async () => {
      const {expectFocus, point, start} = mountLine();
      await mouseDrag([[start.x, start.y], point]);
      await expectFocus();
    });
  });

  // In a read-only editor the editor does not write the DOM selection, so a
  // drag is left to the browser, and a copy, which the editor makes from its
  // own selection, copies what is highlighted.
  test('a copy after a drag in a read-only editor copies the decorators highlighted', async () => {
    const {editor, left, pointerLog, right, root, y} = mount(
      false,
      ImageLikeDecoratorNode,
    );
    // As the ContentEditable component renders a read-only editor.
    editor.setEditable(false);
    root.contentEditable = 'false';
    await mouseDrag([
      [right(COUNT - 1) + 30, y],
      [left(COUNT - 2) + SIZE / 2, y],
      [left(3) + SIZE / 2, y],
      [left(2) + SIZE / 2 - 3, y],
    ]);
    const domSelection = getDOMSelection(window);
    assert(domSelection !== null, 'expected a DOM selection');
    const highlighted = Array.from(
      root.querySelectorAll('[data-lexical-decorator]'),
    ).filter(dom => domSelection.containsNode(dom, false)).length;
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    });
    root.dispatchEvent(event);
    const copied = event.defaultPrevented
      ? clipboardData
          .getData('application/x-lexical-editor')
          .split('"test_7158_mouse_image"').length - 1
      : highlighted;
    assert(
      copied === highlighted,
      `copied ${copied} decorators but ${highlighted} are highlighted ` +
        `(${describeEditorSelection(editor)}; pointer ${pointerLog.join(' ')})`,
    );
  });

  // An editor that becomes read-only during a drag stops writing the DOM
  // selection too, so it leaves the rest of the drag to the browser, which
  // does not extend it over unselectable boxes.
  test('a drag that the editor becomes read-only during leaves the selection where the browser has it', async () => {
    const {editor, left, pointerLog, right, root, y} = mount(
      false,
      BoxedImageDecoratorNode,
    );
    // Once the drag has crossed the last decorator.
    onTestFinished(
      registerEventListener(document, 'pointermove', event => {
        if (
          editor.isEditable() &&
          event.clientX < root.getBoundingClientRect().left + left(COUNT - 1)
        ) {
          editor.setEditable(false);
          root.contentEditable = 'false';
        }
      }),
    );
    await mouseDrag([
      [right(COUNT - 1) + 30, y],
      [left(COUNT - 2) + SIZE / 2, y],
      [left(2) + SIZE / 2 - 3, y],
    ]);
    assert(!editor.isEditable(), 'expected the editor to be read-only');
    const browser = editor.read('latest', () => {
      const selection = $createRangeSelectionFromDom(
        getDOMSelection(window),
        editor,
      );
      return selection
        ? `${selection.anchor.key}:${selection.anchor.offset}->` +
            `${selection.focus.key}:${selection.focus.offset}`
        : String(selection);
    });
    const lexical = describeEditorSelection(editor);
    assert(
      lexical === browser,
      `expected the selection at ${browser}, got ${lexical} (dom ` +
        `${describeDOMSelection(getDOMSelection(window))}; ` +
        `pointer ${pointerLog.join(' ')})`,
    );
  });
});

/** Stops the `types` of pointer event that reach `element` from propagating. */
function stopPropagationAt(
  element: Element | null,
  types: ('pointermove' | 'pointerup')[],
): void {
  assert(element !== null, 'expected an element to stop events at');
  for (const type of types) {
    onTestFinished(
      registerEventListener(element, type, event => event.stopPropagation()),
    );
  }
}

// An element around the editor (a canvas, a drag library) or a decorator (a
// React one whose onPointerMove calls stopPropagation) can stop the pointer
// events of a press from propagating, or cancel them, and the editor must
// still follow the press.
describe('Issue #7158: mouse presses whose pointer events the page stops or cancels', () => {
  test('a drag from text into a selectable boxed decorator, whose moves the host stops, keeps its anchor', async () => {
    let textKey = '';
    const {editor, root} = mountEditor(() => {
      const text = $createTextNode('abc ');
      textKey = text.getKey();
      const paragraph = $createParagraphNode().append(text);
      for (let i = 0; i < 4; i++) {
        paragraph.append(
          $create(SelectableBoxedImageDecoratorNode),
          $createTextNode(' '),
        );
      }
      return [paragraph];
    });
    stopPropagationAt(root.parentElement, ['pointermove']);
    const text = editor.getElementByKey(textKey)?.firstChild;
    assert(isDOMTextNode(text), 'expected the text');
    const third = rectIn(
      root,
      root.querySelectorAll('[data-lexical-decorator] img')[2],
    );
    await mouseDrag([
      [rectIn(root, text, 0).left + 2, third.y],
      [third.left + 25, third.y],
    ]);
    await expectSelectedDecoratorCount(editor, 3, []);
    const anchor = describeEditorSelection(editor).split('->')[0];
    assert(
      anchor === `${textKey}:0`,
      `expected the anchor at the press, got ${anchor}`,
    );
  });

  test('a drag from right of the last decorator, over decorators that stop its moves and release, selects back to the third', () => {
    const mounted = mount(false, ImageLikeDecoratorNode);
    for (const dom of mounted.root.querySelectorAll(
      '[data-lexical-decorator]',
    )) {
      stopPropagationAt(dom, ['pointermove', 'pointerup']);
    }
    return dragFromLineEdge('end', mounted);
  });

  // The moves of a press that the page cancels still select.
  test.each<[string, DecoratorClass]>([
    ['images', ImageLikeDecoratorNode],
    ['chips of text', TextChipDecoratorNode],
  ])(
    'a drag from right of the last of a line of %s, whose moves the page cancels, selects back to the third',
    (_name, klass) => {
      const mounted = mount(false, klass);
      onTestFinished(
        registerEventListener(document, 'pointermove', event =>
          event.preventDefault(),
        ),
      );
      return dragFromLineEdge('end', mounted);
    },
  );

  // A toolbar keeps the editor focused by cancelling the mousedown of its
  // buttons, and an app can move the caret with no pointer event at all.
  test.each([
    ['a toolbar button', true],
    ['an update', false],
  ])(
    'a click right of the last decorator, whose release the host stops, leaves the caret that %s puts next',
    async (_name, isToolbar) => {
      const {editor, pointerLog, right, root, trailingTextKey, y} = mount(
        false,
        ImageLikeDecoratorNode,
        {trailingLine: 'hello world'},
      );
      assert(trailingTextKey !== null, 'expected the trailing text');
      stopPropagationAt(root.parentElement, ['pointermove', 'pointerup']);
      const selectEnd = () =>
        editor.update(
          () => {
            $assertNodeType(
              $getNodeByKey(trailingTextKey),
              $isTextNode,
            ).selectEnd();
          },
          {discrete: true},
        );
      const button = document.createElement('button');
      button.id = 'issue-7158-toolbar';
      button.textContent = 'End';
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', selectEnd);
      root.before(button);
      await mouseDrag([[right(COUNT - 1) + 30, y]]);
      await expectCaret(editor, `paragraph:${COUNT}`, pointerLog);
      if (isToolbar) {
        await commands.mouseDrag('#issue-7158-toolbar', [[5, 5]]);
      } else {
        // Then after the editor has handled its selectionchange.
        const selectionChanged = nextSelectionChange();
        selectEnd();
        await selectionChanged;
      }
      await expectCaret(editor, 'text:11', pointerLog);
    },
  );
});

// macOS Chrome and Safari extend a Shift press from the far end of the
// selection, where Linux extends it from its anchor. They decide that in the
// press's default action, which this listener, after the editor's, stands in
// for: it makes the far end the anchor, here the end of a selection the press
// is before. The editor must leave the selection to that, on text and beyond
// a decorator that starts the line.
test.each([
  ['on text', false],
  ['left of the first decorator', true],
])(
  'Issue #7158: a Shift click %s keeps the anchor the browser extends from',
  async (_name, isBeyondDecorator) => {
    const {editor, left, pointerLog, root, textRect, trailingTextKey, y} =
      mount(false, ImageLikeDecoratorNode, {trailingText: ' hello world'});
    assert(trailingTextKey !== null, 'expected the trailing text');
    root.focus();
    editor.update(
      () => {
        $assertNodeType($getNodeByKey(trailingTextKey), $isTextNode).select(
          7,
          12,
        );
      },
      {discrete: true},
    );
    let pressed = '';
    onTestFinished(
      registerEventListener(window, 'mousedown', () => {
        const selection = getDOMSelection(window);
        assert(selection !== null, 'expected a DOM selection');
        pressed = describeDOMSelection(selection);
        const range = selection.getRangeAt(0);
        selection.setBaseAndExtent(
          range.endContainer,
          range.endOffset,
          range.startContainer,
          range.startOffset,
        );
      }),
    );
    const hello = textRect('hello');
    await mouseDrag(
      [isBeyondDecorator ? [left(0) - 5, y] : [hello.x, hello.y]],
      {modifiers: ['Shift']},
    );
    const paragraphKey = editor.read('latest', () =>
      $getRoot().getFirstChildOrThrow().getKey(),
    );
    await vi.waitFor(() => {
      const points = describeEditorSelection(editor);
      const [anchor, focus] = points.split('->');
      assert(
        anchor === `${trailingTextKey}:12` &&
          (isBeyondDecorator
            ? focus === `${paragraphKey}:0`
            : /:[1-6]$/.test(focus) && focus.startsWith(`${trailingTextKey}:`)),
        `expected the selection from the end of "world" to the press, got ` +
          `${points}, from ${pressed} at the press ` +
          `(pointer ${pointerLog.join(' ')})`,
      );
    });
  },
);

// An extension can keep DOM of its own in a block with setDOMUnmanaged, such
// as a badge at the end of a line. The browser can put a point of the drag in
// it, which is no position in the editor, and an edit of the block mid-drag,
// which the editor reverts, must leave it where it was.
describe('Issue #7158: mouse drag beside DOM an extension keeps in the block', () => {
  function badge(): HTMLElement {
    const span = document.createElement('span');
    span.textContent = '*';
    setDOMUnmanaged(span);
    return span;
  }
  const managedLineBreak = (block: Element) =>
    Array.from(
      block.querySelectorAll(':scope > [data-lexical-managed-linebreak]'),
    );
  const beforeLineBreak = (block: Element) =>
    block.insertBefore(badge(), managedLineBreak(block)[0]);
  const afterLineBreak = (block: Element) => block.append(badge());
  const removeLineBreak = (block: Element) =>
    managedLineBreak(block).forEach(node => node.remove());

  type Edit = (block: Element) => void;
  test.each<[string, 'end' | 'start', Edit, Edit | null]>([
    [
      'right of the last decorator, with a badge before the line break,',
      'end',
      beforeLineBreak,
      null,
    ],
    [
      'left of the first decorator, with a badge before the line break,',
      'start',
      beforeLineBreak,
      null,
    ],
    [
      'right of the last decorator, with a badge after a line break that an edit removes mid-drag,',
      'end',
      afterLineBreak,
      removeLineBreak,
    ],
    [
      'left of the first decorator, with a badge after a line break that an edit removes mid-drag,',
      'start',
      afterLineBreak,
      removeLineBreak,
    ],
  ])(
    'a drag from %s selects as without the badge',
    async (_name, edge, addBadge, editMidDrag) => {
      const mounted = mount(false, ImageLikeDecoratorNode);
      const block = mounted.root.firstElementChild!;
      addBadge(block);
      const rendered = mounted.root.innerHTML;
      let moves = 0;
      onTestFinished(
        registerEventListener(
          window,
          'pointermove',
          event => {
            if (editMidDrag && event.buttons !== 0 && ++moves === 2) {
              editMidDrag(block);
            }
          },
          true,
        ),
      );
      await dragFromLineEdge(edge, mounted);
      assert.equal(mounted.root.innerHTML, rendered);
    },
  );
});
