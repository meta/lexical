/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  AnyLexicalCommand,
  InputState,
  LexicalCommand,
  LexicalEditor,
} from './LexicalEditor';
import type {KeyboardShortcutMatch} from './LexicalKeyboardShortcuts';
import type {LexicalNode, NodeKey} from './LexicalNode';
import type {ElementNode} from './nodes/LexicalElementNode';
import type {TextNode} from './nodes/LexicalTextNode';

import invariant from '@lexical/internal/invariant';
import warnOnlyOnce from '@lexical/internal/warnOnlyOnce';

import {
  $createRangeSelection,
  $createTextNode,
  $getChildCaret,
  $getPreviousSelection,
  $getRoot,
  $getSelection,
  $getSiblingCaret,
  $isBlockElementNode,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isNodeSelection,
  $isRangeSelection,
  $isRootNode,
  $isTabNode,
  $isTextNode,
  $setCompositionKey,
  $setPointFromCaret,
  BLUR_COMMAND,
  type CaretDirection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  COMPOSITION_END_TAG,
  COMPOSITION_START_TAG,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  COPY_COMMAND,
  CUT_COMMAND,
  DELETE_CHARACTER_COMMAND,
  DELETE_LINE_COMMAND,
  DELETE_WORD_COMMAND,
  DRAGEND_COMMAND,
  DRAGOVER_COMMAND,
  DRAGSTART_COMMAND,
  DROP_COMMAND,
  FOCUS_COMMAND,
  FORMAT_TEXT_COMMAND,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_SPACE_COMMAND,
  KEY_TAB_COMMAND,
  MOVE_TO_END,
  MOVE_TO_START,
  PASTE_COMMAND,
  REDO_COMMAND,
  REMOVE_TEXT_COMMAND,
  type SiblingCaret,
  SKIP_SELECTION_FOCUS_TAG,
  UNDO_COMMAND,
} from '.';
import {
  CAN_USE_BEFORE_INPUT,
  IS_ANDROID_CHROME,
  IS_APPLE,
  IS_APPLE_WEBKIT,
  IS_CHROME,
  IS_FIREFOX,
  IS_IOS,
  IS_SAFARI,
} from './environment';
import {
  BEFORE_INPUT_COMMAND,
  COMPOSITION_END_COMMAND,
  COMPOSITION_START_COMMAND,
  INPUT_COMMAND,
  KEY_MODIFIER_COMMAND,
  SELECT_ALL_COMMAND,
} from './LexicalCommands';
import {
  COMPOSITION_START_CHAR,
  DOM_ELEMENT_TYPE,
  DOUBLE_LINE_BREAK,
  IS_ALL_FORMATTING,
} from './LexicalConstants';
import {
  compileKeyboardShortcuts,
  CONTROL_OR_ALT,
  CONTROL_OR_META,
} from './LexicalKeyboardShortcuts';
import {createRefCountedRegistry} from './LexicalRefCountedRegistry';
import {
  $createPoint,
  $createRangeSelectionFromDom,
  $getPointSlotFrame,
  $internalCreateRangeSelection,
  $internalRefreshSelectionFormatAndStyle,
  $internalResolveSelectionPoint,
  $isSameFrame,
  $prepareCompositionTarget,
  type RangeSelection,
} from './LexicalSelection';
import {
  $dispatchSelectionChangeCommand,
  getActiveEditor,
  updateEditorSync,
} from './LexicalUpdates';
import {
  $addUpdateTag,
  $findMatchingParent,
  $flushMutations,
  $getAdjacentNode,
  $getDOMTextNode,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $isEventFromEmbeddedInput,
  $isSelectionCapturedInDecoratorInput,
  $isTokenOrSegmented,
  $isTokenOrTab,
  $setSelection,
  $shouldInsertTextAfterOrBeforeTextNode,
  $updateSelectedTextFromDOM,
  $updateTextNodeFromDOMContent,
  dispatchCommand,
  doesContainSurrogatePair,
  type DOMSelectionBoundaryPoints,
  getActiveElementDeep,
  getAnchorTextFromDOM,
  getComposedEventTarget,
  getDOMOwnerDocument,
  getDOMSelection,
  getDOMSelectionFromTarget,
  getDOMSelectionPoints,
  getEditorPropertyFromDOMNode,
  getEditorsToPropagate,
  getNearestEditorFromDOMNode,
  getParentElement,
  getWindow,
  isDOMCapturingSelection,
  isDOMDocumentNode,
  isDOMNode,
  isDOMShadowRoot,
  isDOMTextNode,
  isFirefoxClipboardEvents,
  isHTMLElement,
  isLexicalEditor,
  isModifier,
  isSelectionWithinEditor,
  type KeyboardEventModifierMask,
} from './LexicalUtils';
import {mergeRegister} from './utils/mergeRegister';
import {registerEventListener} from './utils/registerEventListener';
import {registerEventListeners} from './utils/registerEventListeners';

type RootElementRemoveHandles = (() => void)[];
// Each root element event is handled by a function or dispatched as a
// command. A method type, so that a handler can take the event's own type.
type RootElementEvents = Record<
  string,
  | AnyLexicalCommand
  | {handle(event: Event, editor: LexicalEditor): void}['handle']
>;
const ANDROID_COMPOSITION_LATENCY = 30;

// Node can be moved between documents (for example using createPortal), so we
// need to track the document each root element was originally registered on.
const rootElementToDocument = new WeakMap<HTMLElement, Document>();
// Per-document state read by the shared `selectionchange` handler, keyed by the
// document each root element was registered against:
// - `editors` is the candidate set `onDocumentSelectionChange` attributes the
//   event to, using each editor's shadow-aware anchor rather than guessing from
//   `Selection.anchorNode` (retargeted to a light-DOM ancestor inside a shadow
//   tree).
// - `hasShadowEditor` caches whether any editor here is shadow-mounted
//   (`undefined` = needs recompute), so the handler avoids an O(editors)
//   `getRootNode()` scan per selectionchange. Invalidated whenever the editor
//   set changes — which, via setRootElement, is where an editor's root (and
//   thus its shadow-mounted status) is rebound.
interface DocumentRegistration {
  editors: Set<LexicalEditor>;
  hasShadowEditor: boolean | undefined;
}
const documentRegistrations = new WeakMap<Document, DocumentRegistration>();
// The single shared `selectionchange` listener per document, reference counted
// across all editors registered against that document: attached when the first
// root element is registered and removed when the last one is unregistered.
const documentSelectionChange = createRefCountedRegistry((doc: Document) => {
  doc.addEventListener('selectionchange', onDocumentSelectionChange);
  return () =>
    doc.removeEventListener('selectionchange', onDocumentSelectionChange);
});

// This function is used to determine if Lexical should attempt to override
// the default browser behavior for insertion of text and use its own internal
// heuristics. This is an extremely important function, and makes much of Lexical
// work as intended between different browsers and across word, line and character
// boundary/formats. It also is important for text replacement, node schemas and
// composition mechanics.
function $shouldPreventDefaultAndInsertText(
  selection: RangeSelection,
  domTargetRange: null | StaticRange,
  text: string,
  timeStamp: number,
  isBeforeInput: boolean,
  cachedDOMSelectionPoints?: DOMSelectionBoundaryPoints | null,
): boolean {
  const anchor = selection.anchor;
  const focus = selection.focus;
  const anchorNode = anchor.getNode();
  const editor = getActiveEditor();
  let domSelectionPoints: DOMSelectionBoundaryPoints | null;
  if (cachedDOMSelectionPoints !== undefined) {
    domSelectionPoints = cachedDOMSelectionPoints;
  } else {
    const domSelection = getDOMSelection(getWindow(editor));
    domSelectionPoints =
      domSelection !== null
        ? getDOMSelectionPoints(domSelection, editor._rootElement)
        : null;
  }
  const domAnchorNode =
    domSelectionPoints !== null ? domSelectionPoints.anchorNode : null;
  const anchorKey = anchor.key;
  const backingAnchorElement = editor.getElementByKey(anchorKey);
  const textLength = text.length;

  return (
    anchorKey !== focus.key ||
    // If we're working with a non-text node.
    !$isTextNode(anchorNode) ||
    // If we are replacing a range with a single character or grapheme, and not composing.
    (((!isBeforeInput &&
      (!CAN_USE_BEFORE_INPUT ||
        // We check to see if there has been
        // a recent beforeinput event for "textInput". If there has been one in the last
        // 50ms then we proceed as normal. However, if there is not, then this is likely
        // a dangling `input` event caused by execCommand('insertText').
        editor._inputState.lastBeforeInputInsertTextTimeStamp <
          timeStamp + 50)) ||
      (anchorNode.isDirty() && textLength < 2) ||
      // TODO consider if there are other scenarios when multiple code units
      //      should be addressed here
      doesContainSurrogatePair(text)) &&
      anchor.offset !== focus.offset &&
      !anchorNode.isComposing()) ||
    // Any non standard text node.
    $isTokenOrSegmented(anchorNode) ||
    // If the text length is more than a single character and we're either
    // dealing with this in "beforeinput" or where the node has already recently
    // been changed (thus is dirty).
    (anchorNode.isDirty() && textLength > 1) ||
    // If the DOM selection element is not the same as the backing node during beforeinput.
    ((isBeforeInput || !CAN_USE_BEFORE_INPUT) &&
      backingAnchorElement !== null &&
      !anchorNode.isComposing() &&
      domAnchorNode !==
        $getDOMTextNode(anchorNode, backingAnchorElement, editor)) ||
    // If TargetRange is not the same as the DOM selection; browser trying to edit random parts
    // of the editor.
    (domSelectionPoints !== null &&
      domTargetRange !== null &&
      (!domTargetRange.collapsed ||
        domTargetRange.startContainer !== domSelectionPoints.anchorNode ||
        domTargetRange.startOffset !== domSelectionPoints.anchorOffset)) ||
    // Check if we're changing from bold to italics, or some other format.
    (!anchorNode.isComposing() &&
      (anchorNode.getFormat() !== selection.format ||
        anchorNode.getStyle() !== selection.style)) ||
    // One last set of heuristics to check against.
    $shouldInsertTextAfterOrBeforeTextNode(selection, anchorNode)
  );
}

function shouldSkipSelectionChange(
  domNode: null | Node,
  offset: number,
): boolean {
  return (
    isDOMTextNode(domNode) &&
    domNode.nodeValue !== null &&
    offset !== 0 &&
    offset !== domNode.nodeValue.length
  );
}

function onSelectionChange(
  domSelection: Selection,
  editor: LexicalEditor,
  isActive: boolean,
): void {
  // Shadow-aware boundary points so isSelectionWithinEditor below isn't
  // fooled by the retargeted shadow host into dropping the selection.
  const {
    anchorNode: anchorDOM,
    anchorOffset,
    focusNode: focusDOM,
    focusOffset,
  } = getDOMSelectionPoints(domSelection, editor._rootElement);
  const inputState = editor._inputState;
  if (inputState.isSelectionChangeFromDOMUpdate) {
    inputState.isSelectionChangeFromDOMUpdate = false;
    const appliedPoints = inputState.selectionChangeFromDOMUpdatePoints;
    inputState.selectionChangeFromDOMUpdatePoints = null;

    // If native DOM selection is on a DOM element, then
    // we should continue as usual, as Lexical's selection
    // may have normalized to a better child. If the DOM
    // element is a text node, we can safely apply this
    // optimization and skip the selection change entirely.
    // We also need to check if the offset is at the boundary,
    // because in this case, we might need to normalize to a
    // sibling instead.
    //
    // The skip is only safe when this event actually observes the selection
    // the reconciler applied. The flag can outlive its own event — WebKit
    // fires no selectionchange when the applied selection matches what the
    // DOM already had — and then the next real user selection (e.g. a click
    // into text after select-all) would be swallowed here.
    if (
      shouldSkipSelectionChange(anchorDOM, anchorOffset) &&
      shouldSkipSelectionChange(focusDOM, focusOffset) &&
      !inputState.postDeleteSelectionToRestore &&
      (appliedPoints === null ||
        (appliedPoints.anchorNode === anchorDOM &&
          appliedPoints.anchorOffset === anchorOffset &&
          appliedPoints.focusNode === focusDOM &&
          appliedPoints.focusOffset === focusOffset))
    ) {
      return;
    }
  }
  updateEditorSync(editor, () => {
    // Non-active editor don't need any extra logic for selection, it only needs update
    // to reconcile selection (set it to null) to ensure that only one editor has non-null selection.
    if (!isActive) {
      $setSelection(null);
      return;
    }

    if (!isSelectionWithinEditor(editor, anchorDOM, focusDOM)) {
      return;
    }
    // Not for a press that a listener after the editor's cancelled, which
    // the browser does not select from either.
    const drag = inputState.mouseDrag;
    if (drag && !(drag.type === 'mousedown' && drag.defaultPrevented)) {
      $adjustMouseDrag(editor, drag, focusDOM);
    }
    // Whether the adjustment for the drag's latest mouse event moved the
    // selection from the DOM's, which notified it.
    const isAdjusted = adjustedMouseEvents.has(drag as MouseEvent);

    let selection = $getSelection();

    // Restore selection in the event of incorrect rightward shift after deletion
    if (
      inputState.postDeleteSelectionToRestore &&
      $isRangeSelection(selection) &&
      selection.isCollapsed()
    ) {
      const curAnchor = selection.anchor;
      const prevAnchor = inputState.postDeleteSelectionToRestore.anchor;
      if (
        // Rightward shift in same node
        (curAnchor.key === prevAnchor.key &&
          curAnchor.offset === prevAnchor.offset + 1) ||
        // Or rightward shift into sibling node
        (curAnchor.offset === 1 &&
          prevAnchor.getNode().is(curAnchor.getNode().getPreviousSibling()))
      ) {
        // Restore selection
        selection = inputState.postDeleteSelectionToRestore.clone();
        $setSelection(selection);
      }
    }
    inputState.postDeleteSelectionToRestore = null;

    // Update the selection format
    if ($isRangeSelection(selection)) {
      const anchor = selection.anchor;

      if (selection.isCollapsed()) {
        // Badly interpreted range selection when collapsed - #1482
        if (domSelection.type === 'Range' && anchorDOM === focusDOM) {
          selection.dirty = true;
        }
        $updateCollapsedSelectionFormatStyle(editor, selection);
      } else {
        const anchorKey = anchor.key;
        const focus = selection.focus;
        const focusKey = focus.key;
        const nodes = selection.getNodes();
        const nodesLength = nodes.length;
        const isBackward = selection.isBackward();
        // Its own offsets, which go with its keys, where it is not the DOM's.
        const [anchorAt, focusAt] = isAdjusted
          ? [anchor.offset, focus.offset]
          : [anchorOffset, focusOffset];
        const startOffset = isBackward ? focusAt : anchorAt;
        const endOffset = isBackward ? anchorAt : focusAt;
        const startKey = isBackward ? focusKey : anchorKey;
        const endKey = isBackward ? anchorKey : focusKey;
        let combinedFormat = IS_ALL_FORMATTING;
        let hasTextNodes = false;
        for (let i = 0; i < nodesLength; i++) {
          const node = nodes[i];
          const textContentSize = node.getTextContentSize();
          if (
            $isTextNode(node) &&
            textContentSize !== 0 &&
            // Exclude empty text nodes at boundaries resulting from user's selection
            !(
              (i === 0 &&
                node.__key === startKey &&
                startOffset === textContentSize) ||
              (i === nodesLength - 1 &&
                node.__key === endKey &&
                endOffset === 0)
            )
          ) {
            // TODO: what about style?
            hasTextNodes = true;
            combinedFormat &= node.getFormat();
            if (combinedFormat === 0) {
              break;
            }
          }
        }

        selection.format = hasTextNodes ? combinedFormat : 0;
      }
    }

    // Not again when the adjustment notified it.
    $dispatchSelectionChangeCommand(
      editor,
      selection,
      selection !== null &&
        ((selection.dirty && !isAdjusted) || !$isRangeSelection(selection)),
    );
  });
}

function $updateSelectionFormatStyle(
  selection: RangeSelection,
  format: number,
  style: string,
) {
  if (selection.format !== format || selection.style !== style) {
    selection.format = format;
    selection.style = style;
    selection.dirty = true;
  }
}

function $updateSelectionFormatStyleFromTextNode(
  selection: RangeSelection,
  node: TextNode,
) {
  const format = node.getFormat();
  const style = node.getStyle();
  $updateSelectionFormatStyle(selection, format, style);
}

/**
 * Gives a caret the format and style of where it is, as a selectionchange
 * does, unless the editor has just put it there with its own.
 */
function $updateCollapsedSelectionFormatStyle(
  editor: LexicalEditor,
  selection: RangeSelection,
): void {
  const anchor = selection.anchor;
  const anchorNode = anchor.getNode();
  // If we have marked a collapsed selection format, and we're
  // within the given time range – then attempt to use that format
  // instead of getting the format from the anchor node.
  const windowEvent = getWindow(editor).event;
  const currentTimeStamp = windowEvent
    ? windowEvent.timeStamp
    : performance.now();
  const {
    format: lastFormat,
    style: lastStyle,
    offset: lastOffset,
    key: lastKey,
    timeStamp,
  } = editor._inputState.collapsedSelectionFormat;

  if (
    currentTimeStamp < timeStamp + 200 &&
    anchor.offset === lastOffset &&
    anchor.key === lastKey
  ) {
    $updateSelectionFormatStyle(selection, lastFormat, lastStyle);
  } else if (anchor.type === 'text') {
    invariant(
      $isTextNode(anchorNode),
      'Point.getNode() must return TextNode when type is text',
    );
    $updateSelectionFormatStyleFromTextNode(selection, anchorNode);
  } else if (
    // An element point, unless nothing is composing and the root has no text
    editor.isComposing() ||
    $getRoot().getTextContent() !== ''
  ) {
    invariant(
      $isElementNode(anchorNode),
      'Point.getNode() must return ElementNode when type is element',
    );
    if (
      // This previously applied to all ParagraphNode
      anchorNode.isEmpty()
    ) {
      $internalRefreshSelectionFormatAndStyle(selection, '');
    } else {
      $updateSelectionFormatStyle(selection, selection.format, '');
    }
  }
}

// This is a work-around is mainly Chrome specific bug where if you select
// the contents of an empty block, you cannot easily unselect anything.
// This results in a tiny selection box that looks buggy/broken. This can
// also help other browsers when selection might "appear" lost, when it
// really isn't.
function onClick(event: PointerEvent, editor: LexicalEditor): void {
  updateEditorSync(editor, () => {
    const selection = $getSelection();
    const domSelection = getDOMSelection(getWindow(editor));
    const lastSelection = $getPreviousSelection();

    if (domSelection) {
      if ($isRangeSelection(selection)) {
        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();

        if (
          anchor.type === 'element' &&
          anchor.offset === 0 &&
          selection.isCollapsed() &&
          !$isRootNode(anchorNode) &&
          $getRoot().getChildrenSize() === 1 &&
          anchorNode.getTopLevelElementOrThrow().isEmpty() &&
          lastSelection !== null &&
          selection.is(lastSelection)
        ) {
          domSelection.removeAllRanges();
          selection.dirty = true;
        }
      } else if (
        event.pointerType === 'touch' ||
        event.pointerType === 'pen' ||
        // iOS reports the click that follows a tap with pointerType 'mouse',
        // and fires it before the selectionchange for the caret the tap just
        // placed. Without this, the NodeSelection survives into CLICK_COMMAND,
        // where rich text clears it and the reconciler removes that caret, so
        // the keyboard opens with no caret to reveal and the page jumps. The
        // tap's pointerdown is still 'touch' (or 'pen'); an iPadOS trackpad
        // click is handled by selectionchange like any other mouse click.
        (IS_IOS && editor._inputState.lastPointerType !== 'mouse')
      ) {
        // This is used to update the selection on touch devices (including Apple Pencil) when the user clicks on text after a
        // node selection. See isSelectionChangeFromMouseDown for the inverse
        const domSelectionPoints = getDOMSelectionPoints(
          domSelection,
          editor._rootElement,
        );
        const domAnchorNode = domSelectionPoints.anchorNode;
        // If the user is attempting to click selection back onto text, then
        // we should attempt create a range selection.
        // When we click on an empty paragraph node or the end of a paragraph that ends
        // with an image/poll, the nodeType will be ELEMENT_NODE
        if (isHTMLElement(domAnchorNode) || isDOMTextNode(domAnchorNode)) {
          const newSelection = $internalCreateRangeSelection(
            lastSelection,
            domSelection,
            editor,
            event,
          );
          $setSelection(newSelection);
        }
      }
    }

    // Firefox produces no DOM range when clicking between block-level
    // decorators (rangeCount === 0). Use click coordinates to compute
    // the correct child offset. Only act when the click landed directly
    // on the root element (not inside a child like a table cell).
    if (IS_FIREFOX && domSelection !== null && domSelection.rangeCount === 0) {
      const rootElement = editor._rootElement;
      if (rootElement !== null && event.target === rootElement) {
        const clientY = event.clientY;
        let offset = rootElement.childNodes.length;
        for (let i = 0; i < rootElement.childNodes.length; i++) {
          const child = rootElement.childNodes[i];
          if (isHTMLElement(child)) {
            const rect = child.getBoundingClientRect();
            if (clientY <= (rect.top + rect.bottom) / 2) {
              offset = i;
              break;
            }
          }
        }
        domSelection.setBaseAndExtent(rootElement, offset, rootElement, offset);
        const newSelection = $internalCreateRangeSelection(
          lastSelection,
          domSelection,
          editor,
          event,
        );
        if (newSelection !== null) {
          $setSelection(newSelection);
        } else {
          domSelection.removeAllRanges();
        }
      }
    }

    dispatchCommand(editor, CLICK_COMMAND, event);
  });
}

// How far a touch may move and still count as a tap rather than a scroll.
const TAP_SLOP_PX = 10;

// Elements that take a tap (focus, text input, or their own controls) instead
// of letting it fall through to the editor. `[tabindex]` includes
// tabindex="-1", which makes an element focusable by tap but not by Tab.
const FOCUSABLE_SELECTOR =
  'input:not(:disabled),textarea:not(:disabled),select:not(:disabled),' +
  'button:not(:disabled),a[href],area[href],label,summary,iframe,object,' +
  'embed,audio[controls],video[controls],[tabindex],' +
  '[contenteditable]:not([contenteditable="false"])';

// iOS only. A tap on a decorator (an image, say) would focus the editor, and
// iOS answers that focus by opening the keyboard and scrolling to reveal the
// caret. A decorator is selected with a NodeSelection, which leaves no DOM
// caret, so iOS reveals the top of the editor instead and the page jumps
// (meta/lexical#9112). Cancelling the mousedown keeps the keyboard closed;
// the click still follows, so CLICK_COMMAND handlers select the node as usual.
//
// When the editor did not have focus, it is focused from code instead, with
// `inputmode="none"` so no keyboard opens and `preventScroll` so nothing
// moves. Keys from an iPad hardware keyboard (Backspace to delete the image)
// then reach the editor. The root's own `inputmode` comes back with the next
// press that isn't cancelled, or when the editor loses focus. A tap on text
// first blurs the editor (see onTouchEndIOS), so that the tap focuses it again
// and iOS opens the keyboard with the caret in view. A trackpad or mouse press
// is left alone.
//
// Only taps that would focus the editor through a decorator are cancelled.
// Something that takes the tap itself (a button, an input, a nested editor, an
// embed) keeps the default. So does an element outside any decorator, such as
// a `setDOMUnmanaged({captureSelection: true})` widget in an element node; one
// inside a decorator needs a tabindex to keep native focus. A closed shadow
// root hides its controls and the tap is retargeted to its host, so a widget
// like that needs a tabindex on its host too.
function onMouseDownIOS(event: Event, editor: LexicalEditor): void {
  const rootElement = editor.getRootElement();
  if (rootElement === null) {
    return;
  }
  if (!isDecoratorTapIOS(event, editor, rootElement)) {
    restoreInputModeIOS(editor, rootElement);
    return;
  }
  event.preventDefault();
  if (getActiveElementDeep(rootElement.ownerDocument) !== rootElement) {
    if (editor._inputState.savedInputMode === undefined) {
      editor._inputState.savedInputMode = rootElement.getAttribute('inputmode');
    }
    rootElement.setAttribute('inputmode', 'none');
    rootElement.focus({preventScroll: true});
  }
}

function isDecoratorTapIOS(
  event: Event,
  editor: LexicalEditor,
  rootElement: HTMLElement,
): boolean {
  if (editor._inputState.lastPointerType === 'mouse') {
    return false;
  }
  const target = getComposedEventTarget(event);
  if (!isDOMNode(target)) {
    return false;
  }
  // Walk up to the editor root, crossing open shadow roots.
  let inDecorator = false;
  for (
    let node: Node | null = target;
    node !== null;
    node = getParentElement(node)
  ) {
    if (node === rootElement) {
      return inDecorator;
    }
    if (node.nodeType === DOM_ELEMENT_TYPE) {
      const element = node as Element;
      if (element.matches(FOCUSABLE_SELECTOR)) {
        return false;
      }
      if (element.getAttribute('data-lexical-decorator') === 'true') {
        inDecorator = true;
      }
    }
  }
  return false;
}

// iOS only. After onMouseDownIOS focused the editor with inputmode="none",
// only removing the attribute would open the keyboard over the caret: iOS
// reveals the caret when a tap focuses the editor, not when the keyboard opens
// later. So a tap on anything but a decorator blurs the editor at touchend,
// before iOS handles the tap, and the tap then focuses it afresh. The
// compatibility mousedown comes too late for that.
function onTouchEndIOS(
  event: TouchEvent,
  editor: LexicalEditor,
  rootElement: HTMLElement,
): void {
  if (editor._inputState.savedInputMode === undefined) {
    return;
  }
  if (!isDecoratorTapIOS(event, editor, rootElement)) {
    if (getActiveElementDeep(rootElement.ownerDocument) === rootElement) {
      rootElement.blur();
    }
    restoreInputModeIOS(editor, rootElement);
  }
}

/** @internal Puts back the root's own `inputmode` (see onMouseDownIOS). */
export function restoreInputModeIOS(
  editor: LexicalEditor,
  rootElement: HTMLElement,
): void {
  const savedInputMode = editor._inputState.savedInputMode;
  if (savedInputMode !== undefined) {
    editor._inputState.savedInputMode = undefined;
    if (savedInputMode === null) {
      rootElement.removeAttribute('inputmode');
    } else {
      rootElement.setAttribute('inputmode', savedInputMode);
    }
  }
}

// Calls onTap at the touchend of a single touch that didn't move, so a
// scroll or a pinch is not a tap. Captured, so a decorator that stops its
// touch events from propagating can't hide them.
function registerTapListenerIOS(
  rootElement: HTMLElement,
  onTap: (event: TouchEvent) => void,
): () => void {
  let start: {x: number; y: number} | null = null;
  const options = {capture: true, passive: true};
  return mergeRegister(
    registerEventListener(
      rootElement,
      'touchstart',
      event => {
        const touch = event.touches.length === 1 ? event.touches[0] : null;
        start = touch ? {x: touch.clientX, y: touch.clientY} : null;
      },
      options,
    ),
    registerEventListener(
      rootElement,
      'touchend',
      event => {
        const touch = event.changedTouches[0];
        if (
          start !== null &&
          touch &&
          event.touches.length === 0 &&
          Math.abs(touch.clientX - start.x) <= TAP_SLOP_PX &&
          Math.abs(touch.clientY - start.y) <= TAP_SLOP_PX
        ) {
          onTap(event);
        }
        start = null;
      },
      options,
    ),
  );
}

function onPointerDown(event: PointerEvent, editor: LexicalEditor) {
  // TODO implement text drag & drop
  // Resolve to the composed target so a pointerdown inside a decorator's
  // open shadow root reports the real internal element rather than the
  // outer shadow host the engine retargets to.
  const target = getComposedEventTarget(event);
  const pointerType = event.pointerType;
  if (
    isDOMNode(target) &&
    pointerType !== 'touch' &&
    pointerType !== 'pen' &&
    event.button === 0
  ) {
    updateEditorSync(editor, () => {
      // Drag & drop should not recompute selection until mouse up; otherwise the initially
      // selected content is lost.
      if (!isDOMCapturingSelection(target, editor)) {
        editor._inputState.isSelectionChangeFromMouseDown = true;
      }
    });
  }
}

// The press and moves of mouse drags for which $adjustMouseDrag moved the
// selection.
const adjustedMouseEvents = new WeakSet<MouseEvent>();

/**
 * Puts the focus of a mouse press or drag beside the inline decorator that
 * the pointer is over, or is beyond at the start or end of a line, where
 * browsers often find no position, or one inside it or on another line
 * (#7158). A drag keeps its anchor, and a press without Shift collapses.
 */
function $adjustMouseDrag(
  editor: LexicalEditor,
  event: MouseEvent,
  focusDOM: Node | null = null,
): void {
  const selection = $getSelection();
  const before = selection && selection.clone();
  $moveMouseDragFocus(editor, event, focusDOM);
  const after = $getSelection();
  const drag = editor._inputState.mouseDrag;
  if (drag && after && !after.is(before)) {
    adjustedMouseEvents.add(drag);
  }
  // A caret that a press moves to another node takes its format and style,
  // as from a selectionchange.
  if (event.type === 'mousedown' && $isRangeSelection(after)) {
    $internalRefreshSelectionFormatAndStyle(
      after,
      $isRangeSelection(before) ? before.anchor.key : '',
    );
  }
}

function $moveMouseDragFocus(
  editor: LexicalEditor,
  event: MouseEvent,
  focusDOM: Node | null,
): void {
  const previous = $getPreviousSelection();
  const isPress = event.type === 'mousedown';
  const isCaret = isPress && !event.shiftKey;
  const decorator = focusDOM && $getNearestNodeFromDOMNode(focusDOM);
  // A focus that the browser put inside a decorator goes back for a drag
  // (unless a table selected cells) and before it for a click, in the DOM
  // too. A Shift press keeps what the platform chose.
  if ($isDecoratorNode(decorator)) {
    if (!isPress) {
      if ($isRangeSelection(previous)) {
        $setSelection(previous.clone());
      }
    } else if (isCaret && decorator.isInline()) {
      decorator.selectPrevious();
    }
  }
  const current = $getSelection();
  // A point in DOM that no node renders (an extension's badge at the end of
  // a line) leaves no selection. A decorator at the pointer still places one:
  // from nothing for a click, else keeping the previous anchor.
  const selection =
    current ||
    (isCaret
      ? $createRangeSelection()
      : $isRangeSelection(previous)
        ? previous.clone()
        : null);
  const root = editor.getRootElement();
  const doc = root && root.getRootNode();
  if (
    !$isRangeSelection(selection) ||
    // A press on a selection can drag it. (macOS drags only after 150 ms, and
    // a quicker drag from there selects text without this adjustment.)
    (isCaret && !selection.isCollapsed()) ||
    !(isDOMDocumentNode(doc) || isDOMShadowRoot(doc))
  ) {
    return;
  }
  const {anchor, focus} = selection;
  // A Shift press keeps the anchor the platform chose (macOS: the far end).
  if (!isPress && $isRangeSelection(previous)) {
    const {key, offset, type} = previous.anchor;
    anchor.set(key, offset, type, true);
  }
  const {clientX: x, clientY: y} = event;
  // Not in a document without layout (jsdom).
  const target = doc.elementFromPoint && doc.elementFromPoint(x, y);
  const hit = target && $getNearestNodeFromDOMNode(target);
  const $leaf = (node: LexicalNode | null, dir: CaretDirection) =>
    $isElementNode(node)
      ? dir === 'next'
        ? node.getLastDescendant()
        : node.getFirstDescendant()
      : node;
  // The node under the pointer (null in this list), then, when the pointer is
  // over a block rather than its content, a caret at each end of each of its
  // children, facing the node beside it there, for the decorator at that end,
  // which the pointer must be beyond at the edge of a line.
  const candidates: (SiblingCaret | null)[] = [null];
  const block =
    $isElementNode(hit) &&
    !hit.isInline() &&
    ($isRootNode(hit)
      ? $findMatchingParent(focus.getNode(), $isBlockElementNode)
      : hit);
  for (const caret of block ? $getChildCaret(block, 'next') : []) {
    candidates.push($getSiblingCaret(caret.origin, 'previous'), caret);
  }
  const win = getWindow(editor);
  const range = win.document.createRange();
  let offLine: LexicalNode | null = null;
  for (const caret of candidates) {
    const node = caret ? $leaf(caret.origin, caret.direction) : hit;
    if (!$isDecoratorNode(node) || !node.isInline() || node === offLine) {
      continue;
    }
    const dom = editor.getElementByKey(node.getKey());
    if (!dom) {
      continue;
    }
    // The box of what it draws, which can be larger than its element (an
    // image in a span) or smaller (text in a box, or nothing).
    range.selectNodeContents(dom);
    const contents = range.getBoundingClientRect();
    const rect = dom.getBoundingClientRect();
    const {bottom, left, right, top} =
      contents.height > rect.height ? contents : rect;
    // Off the pointer's line, and so not measured again for its other edge.
    if (caret && (y < top || y > bottom)) {
      offLine = node;
      continue;
    }
    // By its line's direction, as a chip of code can have its own.
    const isRtl =
      win.getComputedStyle(getParentElement(dom) || dom).direction === 'rtl';
    const isAfter = x * 2 > left + right !== isRtl;
    const dir = isAfter ? 'next' : 'previous';
    // On its line, the nearest box of the node beside it there (none at a
    // line break) is beyond it, and where the line wraps between them, past
    // its middle. A node without a box tells neither.
    const sib = caret && caret.getNodeAtCaret();
    const sibDOM = sib && editor.getElementByKey(sib.getKey());
    const sibRects = sibDOM ? sibDOM.getClientRects() : [];
    const sibRect: DOMRect | undefined =
      sibRects[isAfter ? 0 : sibRects.length - 1];
    if (
      !caret ||
      // A float is at the edge of no line.
      (caret.direction === dir &&
        win.getComputedStyle(dom).cssFloat === 'none' &&
        (!sib ||
          $isLineBreakNode(sib) ||
          (sibRect &&
            (isAfter === isRtl
              ? sibRect.right * 2 > left + right
              : sibRect.left * 2 < left + right))))
    ) {
      // A focus already beside it stays, as WebKit reports no move to a
      // point it takes for the same one.
      if (!node.is($leaf($getAdjacentNode(focus, isAfter), dir))) {
        const beside = $getSiblingCaret(node, dir);
        $setPointFromCaret(focus, beside);
        if (isCaret) {
          $setPointFromCaret(anchor, beside);
        }
      }
      if (!current) {
        $setSelection(selection);
      }
      return;
    }
  }
  // Chromium restarts a drag from its press when the editor has moved the
  // selection, and a press beyond a decorator then puts both points inside
  // it, so the focus goes to the position at the pointer instead.
  if ($isDecoratorNode(decorator) && !isPress) {
    const ownerDoc = win.document;
    const caret =
      ownerDoc.caretPositionFromPoint &&
      ownerDoc.caretPositionFromPoint(x, y, {
        shadowRoots: isDOMShadowRoot(doc) ? [doc] : [],
      });
    const resolved =
      caret &&
      $internalResolveSelectionPoint(
        caret.offsetNode,
        caret.offset,
        null,
        editor,
      );
    if (resolved) {
      const [{key, offset, type}] = resolved;
      focus.set(key, offset, type);
    }
  }
}

function getTargetRange(event: InputEvent): null | StaticRange {
  if (!event.getTargetRanges) {
    return null;
  }
  const targetRanges = event.getTargetRanges();
  if (targetRanges.length === 0) {
    return null;
  }
  return targetRanges[0];
}

// When a macOS text replacement is accepted, Chrome and Firefox fire input events for the key press that
// triggered the acceptance *before* the one for the replacement text. This causes the caret to be placed
// before the acceptance boundary. This function moves the caret past the acceptance boundary.
function $maybeMoveSelectionPastTrailingAcceptanceBoundary(
  insertedText: string | null | undefined,
): void {
  const {lastKeyCode} = getActiveEditor()._inputState;
  if (insertedText == null || insertedText.length <= 1 || lastKeyCode == null) {
    return;
  }

  const characterToSearchFor =
    lastKeyCode.length === 1
      ? lastKeyCode
      : lastKeyCode === 'Enter'
        ? '\n'
        : lastKeyCode === 'Tab'
          ? '\t'
          : null;

  if (!characterToSearchFor) {
    return;
  }

  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return;
  }

  const anchorNode = selection.anchor.getNode();
  if (!$isTextNode(anchorNode)) {
    return;
  }

  const {offset} = selection.anchor;
  if (anchorNode.getTextContentSize() === offset) {
    const nextSibling = anchorNode.getNextSibling();
    if (characterToSearchFor === '\n') {
      // iOS fires insertReplacementText *before* the Enter's insertParagraph, so no
      // acceptance boundary exists yet; moving here lands the caret in the block that
      // already followed, and Enter then splits that one instead.
      if (IS_IOS) {
        return;
      }
      if ($isLineBreakNode(nextSibling)) {
        nextSibling.selectEnd();
      } else if (!nextSibling) {
        const block = $findMatchingParent(anchorNode, $isBlockElementNode);
        const nextBlock = block && block.getNextSibling();
        if ($isElementNode(nextBlock)) {
          nextBlock.selectStart();
        }
      }
    } else if (characterToSearchFor === '\t') {
      if ($isTabNode(nextSibling)) {
        nextSibling.selectEnd();
      }
    } else if (
      $isTextNode(nextSibling) &&
      nextSibling.getTextContent()[0] === characterToSearchFor
    ) {
      nextSibling.select(1, 1);
    }
  } else if (anchorNode.getTextContent()[offset] === characterToSearchFor) {
    anchorNode.select(offset + 1, offset + 1);
  }
}

function $canRemoveText(
  anchorNode: TextNode | ElementNode,
  focusNode: TextNode | ElementNode,
): boolean {
  return (
    anchorNode !== focusNode ||
    $isElementNode(anchorNode) ||
    $isElementNode(focusNode) ||
    !$isTokenOrTab(anchorNode) ||
    !$isTokenOrTab(focusNode)
  );
}

function isPossiblyAndroidKeyPress(
  inputState: InputState,
  timeStamp: number,
): boolean {
  return (
    inputState.lastKeyCode === 'MediaLast' &&
    timeStamp < inputState.lastKeyDownTimeStamp + ANDROID_COMPOSITION_LATENCY
  );
}

function clearHandledSelectionCommandInsertText(inputState: InputState): void {
  inputState.isInsertTextAfterHandledSelectionCommand = false;
  if (inputState.handledSelectionCommandTimeoutId !== null) {
    clearTimeout(inputState.handledSelectionCommandTimeoutId);
    inputState.handledSelectionCommandTimeoutId = null;
  }
}

function markHandledSelectionCommandInsertText(inputState: InputState): void {
  // Only desktop Chrome on macOS accepts pending system text replacements
  // after these commands. Elsewhere, the next insertText may be real input.
  if (!IS_APPLE || IS_IOS || !IS_CHROME) {
    return;
  }
  clearHandledSelectionCommandInsertText(inputState);
  inputState.isInsertTextAfterHandledSelectionCommand = true;
  inputState.handledSelectionCommandTimeoutId = setTimeout(
    () => clearHandledSelectionCommandInsertText(inputState),
    0,
  );
}

export function registerDefaultCommandHandlers(editor: LexicalEditor) {
  editor.registerCommand(
    BEFORE_INPUT_COMMAND,
    $handleBeforeInput,
    COMMAND_PRIORITY_EDITOR,
  );
  editor.registerCommand(INPUT_COMMAND, $handleInput, COMMAND_PRIORITY_EDITOR);
  editor.registerCommand(
    COMPOSITION_START_COMMAND,
    $handleCompositionStart,
    COMMAND_PRIORITY_EDITOR,
  );
  editor.registerCommand(
    COMPOSITION_END_COMMAND,
    $handleCompositionEnd,
    COMMAND_PRIORITY_EDITOR,
  );
  editor.registerCommand(
    KEY_DOWN_COMMAND,
    $handleKeyDown,
    COMMAND_PRIORITY_EDITOR,
  );
}

/**
 * Returns true when a `beforeinput` / `input` event belongs to a native
 * control (e.g. an `<input>` or `<textarea>`, or any other subtree marked with
 * `setDOMUnmanaged({captureSelection: true})`) inside a decorator whose
 * selection is owned by the browser rather than managed by Lexical. Turning
 * such an event into a Lexical command would insert text into the editor
 * instead of the focused control.
 *
 * A focused `<input>`, `<textarea>` or foreign contentEditable in any node's
 * DOM owns its input events too, as
 * {@link $isSelectionCapturedInDecoratorInput} decides, even in unmanaged DOM
 * that wasn't marked with `captureSelection`: an `<input>` that a render
 * override adds beside a paragraph's children, say. Firefox gives the
 * `insertFromPaste` input event of a paste there the pasted text as its data,
 * which would otherwise be inserted at the editor's selection as well.
 *
 * Two signals are checked because Firefox 152 changed how it dispatches
 * `beforeinput` for these controls (#8738): the event is retargeted off of the
 * focused control, so its composed target no longer points at it. The deep
 * active element still does, and is used as a fallback.
 */
function $isInputEventTargetingCapturedSelection(
  event: InputEvent,
  editor: LexicalEditor,
): boolean {
  // Use the composed target so an event coming from inside a decorator's
  // nested shadow root resolves to the real internal element.
  const composedTarget = getComposedEventTarget(event);
  if (
    isHTMLElement(composedTarget) &&
    isDOMCapturingSelection(composedTarget, editor)
  ) {
    return true;
  }
  // Firefox 152 retargets the event off of the focused control, so fall back
  // to the deep active element (getActiveElementDeep crosses shadow roots) to
  // detect that a captured decorator control still owns the selection.
  const rootElement = editor.getRootElement();
  if (rootElement === null) {
    return false;
  }
  const activeElement = getActiveElementDeep(rootElement.ownerDocument);
  return (
    activeElement !== null &&
    rootElement.contains(activeElement) &&
    (isDOMCapturingSelection(activeElement, editor) ||
      $isSelectionCapturedInDecoratorInput(rootElement, activeElement))
  );
}

function onBeforeInput(event: InputEvent, editor: LexicalEditor): void {
  const inputType = event.inputType;

  // We let the browser do its own thing for composition.
  if (
    inputType === 'deleteCompositionText' ||
    // If we're pasting in FF, we shouldn't get this event
    // as the `paste` event should have triggered, unless the
    // user has dom.event.clipboardevents.enabled disabled in
    // about:config. In that case, we need to process the
    // pasted content in the DOM mutation phase.
    (IS_FIREFOX && isFirefoxClipboardEvents(editor))
  ) {
    return;
  } else if (inputType === 'insertCompositionText') {
    return;
  }

  // Always run the update so the editor selection stays in sync with the DOM
  // (the {event} option recomputes it). Only skip dispatching the command when
  // a native control inside a decorator owns this event: processing it would
  // insert text into the editor rather than the control. Firefox 152 started
  // dispatching these to the editor root (#8738).
  updateEditorSync(
    editor,
    () => {
      if (!$isInputEventTargetingCapturedSelection(event, editor)) {
        dispatchCommand(editor, BEFORE_INPUT_COMMAND, event);
      }
    },
    {event},
  );
}

function $handleBeforeInput(event: InputEvent): boolean {
  const inputType = event.inputType;
  const targetRange = getTargetRange(event);
  const editor = getActiveEditor();
  const inputState = editor._inputState;

  const selection = $getSelection();

  // On Chrome on macOS, some handled selection commands may accept a pending text replacement. This behavior
  // is not desirable, so we check for this case and prevent bogus text replacements from happening.
  if (
    inputType === 'insertText' &&
    event.data &&
    inputState.isInsertTextAfterHandledSelectionCommand
  ) {
    clearHandledSelectionCommandInsertText(inputState);
    event.preventDefault();
    if ($isRangeSelection(selection) && !selection.isCollapsed()) {
      const point = selection.isBackward() ? selection.anchor : selection.focus;
      selection.anchor.set(point.key, point.offset, point.type);
      selection.focus.set(point.key, point.offset, point.type);
    }
    return true;
  }

  if (inputType === 'deleteContentBackward') {
    if (selection === null) {
      // Use previous selection
      const prevSelection = $getPreviousSelection();

      if (!$isRangeSelection(prevSelection)) {
        return true;
      }

      $setSelection(prevSelection.clone());
    }

    if ($isRangeSelection(selection)) {
      const isSelectionAnchorSameAsFocus =
        selection.anchor.key === selection.focus.key;

      if (
        isPossiblyAndroidKeyPress(inputState, event.timeStamp) &&
        editor.isComposing() &&
        isSelectionAnchorSameAsFocus
      ) {
        $setCompositionKey(null);
        inputState.lastKeyDownTimeStamp = 0;
        // Fixes an Android bug where selection flickers when backspacing
        setTimeout(() => {
          updateEditorSync(editor, () => {
            $setCompositionKey(null);
          });
        }, ANDROID_COMPOSITION_LATENCY);
        if ($isRangeSelection(selection)) {
          const anchorNode = selection.anchor.getNode();
          anchorNode.markDirty();
          invariant($isTextNode(anchorNode), 'Anchor node must be a TextNode');
          $updateSelectionFormatStyleFromTextNode(selection, anchorNode);
        }
      } else {
        $setCompositionKey(null);

        // iOS 10-key Korean IME (천지인/Chunjiin) does not fire compositionstart /
        // compositionend events. Instead it sends a deleteContentBackward with a
        // non-collapsed targetRange to delete the current composing jamo, immediately
        // followed by insertText with the updated syllable.
        //
        // Because editor.isComposing() is always false for this keyboard type, Lexical
        // would otherwise dispatch DELETE_CHARACTER_COMMAND, which ignores the
        // targetRange entirely and deletes only one character before the cursor. This
        // leaves orphaned jamo in the editor state that accumulate and corrupt output
        // (e.g. typing "안녕하세요" produces "안녕하ᄉ세ᄋᄋ요").
        //
        // Fix: when on iOS with a non-collapsed targetRange, apply the range directly
        // to the Lexical selection and delete the matched text. If applyDOMRange cannot
        // resolve the range (returns a collapsed selection), fall through to the default
        // Lexical deletion path.
        if (IS_IOS && targetRange !== null && !targetRange.collapsed) {
          selection.applyDOMRange(targetRange);
          if (!selection.isCollapsed()) {
            event.preventDefault();
            selection.removeText();
            return true;
          }
        }

        event.preventDefault();
        // Chromium Android at the moment seems to ignore the preventDefault
        // on 'deleteContentBackward' and still deletes the content. Which leads
        // to multiple deletions. So we let the browser handle the deletion in this case.
        const selectedNode = selection.anchor.getNode();
        const selectedNodeText = selectedNode.getTextContent();
        // When the target node has `canInsertTextAfter` set to false, the first deletion
        // doesn't have an effect, so we need to handle it with Lexical.
        const selectedNodeCanInsertTextAfter =
          selectedNode.canInsertTextAfter();
        const hasSelectedAllTextInNode =
          selection.anchor.offset === 0 &&
          selection.focus.offset === selectedNodeText.length;
        let shouldLetBrowserHandleDelete =
          IS_ANDROID_CHROME &&
          isSelectionAnchorSameAsFocus &&
          !hasSelectedAllTextInNode &&
          selectedNodeCanInsertTextAfter;
        // Check if selection is collapsed and if the previous node is a decorator node
        // If so, the browser will not be able to handle the deletion
        if (shouldLetBrowserHandleDelete && selection.isCollapsed()) {
          shouldLetBrowserHandleDelete = !$isDecoratorNode(
            $getAdjacentNode(selection.anchor, true),
          );
        }
        if (!shouldLetBrowserHandleDelete) {
          dispatchCommand(editor, DELETE_CHARACTER_COMMAND, true);
          // When deleting across paragraphs, Chrome on Android incorrectly shifts the selection rightwards
          // We save the correct selection to restore later during handling of selectionchange event
          const selectionAfterDelete = $getSelection();
          if (
            IS_ANDROID_CHROME &&
            $isRangeSelection(selectionAfterDelete) &&
            selectionAfterDelete.isCollapsed()
          ) {
            inputState.postDeleteSelectionToRestore = selectionAfterDelete;
            // Cleanup in case selectionchange does not fire
            setTimeout(() => (inputState.postDeleteSelectionToRestore = null));
          }
        }
      }
      return true;
    }
  }

  if (!$isRangeSelection(selection)) {
    if (inputType === 'historyUndo' || inputType === 'historyRedo') {
      // Chromium and WebKit walk up the browser's undo scope, so they
      // dispatch history undo/redo at the editor root when the focused
      // control is outside of it and has exhausted its own history — e.g. the
      // URL field of a floating link toolbar (#6714) — at which point the
      // editor no longer has a selection. Returning without preventing the
      // default lets the browser run its native history over a
      // Lexical-managed contenteditable, rewriting the DOM behind the
      // editor's back; the editor state is then rebuilt from that DOM into a
      // document that was never in Lexical's history. `@lexical/history`
      // restores a whole editor state, so it does not need a selection.
      //
      // The default is prevented whether or not anything handles the command:
      // with no history extension registered undo becomes a no-op rather than
      // native undo, which is what the same inputType already does on the
      // RangeSelection path below (that one prevents the default before it
      // reaches the switch).
      event.preventDefault();
      dispatchCommand(
        editor,
        inputType === 'historyUndo' ? UNDO_COMMAND : REDO_COMMAND,
      );
    }
    return true;
  }

  const data = event.data;

  // This represents the case when two beforeinput events are triggered at the same time (without a
  // full event loop ending at input). This happens with MacOS with the default keyboard settings,
  // a combination of autocorrection + autocapitalization.
  // Having Lexical run everything in controlled mode would fix the issue without additional code
  // but this would kill the massive performance win from the most common typing event.
  // Alternatively, when this happens we can prematurely update our EditorState based on the DOM
  // content, a job that would usually be the input event's responsibility.
  if (inputState.unprocessedBeforeInputData !== null) {
    $updateSelectedTextFromDOM(
      false,
      editor,
      inputState.unprocessedBeforeInputData,
    );
  }

  // Set when a forward deletion's range lay before a caret in a slot, the
  // shape of a plain Delete (#9363), which then deletes one character.
  let deleteForwardCharacter = false;
  if (
    (!selection.dirty || inputState.unprocessedBeforeInputData !== null) &&
    selection.isCollapsed() &&
    !$isRootNode(selection.anchor.getNode()) &&
    targetRange !== null
  ) {
    const {key, offset, type} = selection.anchor;
    const frame = editor._slotsUsed && $getPointSlotFrame(selection.anchor);
    selection.applyDOMRange(targetRange);
    // A deletion's range must stay in the caret's frame and, in a slot, not
    // reach past the caret on the side it keeps: at the end of a
    // decorator-host slot Chromium's forward delete covers the line before
    // the caret instead (#9363). Such a deletion is measured from the caret.
    const isForward = inputType.endsWith('Forward');
    if (frame !== false && (isForward || inputType.endsWith('Backward'))) {
      const caret = $createPoint(key, offset, type);
      const {anchor, focus} = selection;
      const leftFrame =
        !$isSameFrame($getPointSlotFrame(anchor), frame) ||
        !$isSameFrame($getPointSlotFrame(focus), frame);
      const wrongSide =
        !leftFrame &&
        frame !== null &&
        (isForward
          ? anchor.isBefore(caret) || focus.isBefore(caret)
          : caret.isBefore(anchor) || caret.isBefore(focus));
      if (leftFrame || wrongSide) {
        anchor.set(key, offset, type);
        focus.set(key, offset, type);
        deleteForwardCharacter =
          wrongSide && inputType === 'deleteContentForward';
      }
    }
  }

  inputState.unprocessedBeforeInputData = null;

  const anchor = selection.anchor;
  const focus = selection.focus;
  const anchorNode = anchor.getNode();
  const focusNode = focus.getNode();

  if (inputType === 'insertText' || inputType === 'insertTranspose') {
    if (data === '\n') {
      event.preventDefault();
      dispatchCommand(editor, INSERT_LINE_BREAK_COMMAND, false);
    } else if (data === DOUBLE_LINE_BREAK) {
      event.preventDefault();
      dispatchCommand(editor, INSERT_PARAGRAPH_COMMAND);
    } else if (data == null && event.dataTransfer) {
      // Gets around a Safari text replacement bug.
      const text = event.dataTransfer.getData('text/plain');
      event.preventDefault();
      selection.insertRawText(text);
    } else if (
      data != null &&
      $shouldPreventDefaultAndInsertText(
        selection,
        targetRange,
        data,
        event.timeStamp,
        true,
      )
    ) {
      event.preventDefault();
      dispatchCommand(editor, CONTROLLED_TEXT_INSERTION_COMMAND, data);
      $maybeMoveSelectionPastTrailingAcceptanceBoundary(data);
    } else {
      inputState.unprocessedBeforeInputData = data;
    }
    inputState.lastBeforeInputInsertTextTimeStamp = event.timeStamp;
    return true;
  }

  // Prevent the browser from carrying out
  // the input event, so we can control the
  // output.
  event.preventDefault();

  switch (inputType) {
    case 'insertFromYank':
    case 'insertFromDrop':
    case 'insertReplacementText': {
      dispatchCommand(editor, CONTROLLED_TEXT_INSERTION_COMMAND, event);
      const textFromDataTransfer = event.dataTransfer
        ? event.dataTransfer.getData('text/plain')
        : null;
      $maybeMoveSelectionPastTrailingAcceptanceBoundary(
        textFromDataTransfer ?? event.data,
      );
      break;
    }

    case 'insertFromComposition': {
      inputState.compositionPhase = 'idle';
      const skipRedundantInsert = inputState.hadOrphanedCompositionEvents;
      inputState.hadOrphanedCompositionEvents = false;
      const prevCompositionKey = editor._compositionKey;
      $setCompositionKey(null);
      if (!skipRedundantInsert) {
        dispatchCommand(editor, CONTROLLED_TEXT_INSERTION_COMMAND, event);
      }
      $cleanupComposedSubclass(prevCompositionKey);
      break;
    }

    case 'insertLineBreak': {
      // Used for Android
      $setCompositionKey(null);
      inputState.isInsertLineBreak = false;
      dispatchCommand(editor, INSERT_LINE_BREAK_COMMAND, false);
      break;
    }

    case 'insertParagraph': {
      // Used for Android
      $setCompositionKey(null);

      // Safari does not provide the type "insertLineBreak".
      // So instead, we need to infer it from the keyboard event.
      // The keydown handler distinguishes an explicit iOS Shift press from
      // automatic capitalization before saving the intent for this input.
      if (inputState.isInsertLineBreak) {
        inputState.isInsertLineBreak = false;
        dispatchCommand(editor, INSERT_LINE_BREAK_COMMAND, false);
      } else {
        dispatchCommand(editor, INSERT_PARAGRAPH_COMMAND);
      }

      break;
    }

    case 'insertFromPaste':
    case 'insertFromPasteAsQuotation': {
      dispatchCommand(editor, PASTE_COMMAND, event);
      break;
    }

    case 'deleteByComposition': {
      if ($canRemoveText(anchorNode, focusNode)) {
        dispatchCommand(editor, REMOVE_TEXT_COMMAND, event);
      }

      break;
    }

    case 'deleteByDrag': {
      // The drop target is taking over focus and the document selection;
      // suppress this editor's own attempt to focus its root or move the DOM
      // selection back to the post-removal point during reconciliation.
      $addUpdateTag(SKIP_SELECTION_FOCUS_TAG);
      dispatchCommand(editor, REMOVE_TEXT_COMMAND, event);
      break;
    }

    case 'deleteByCut': {
      dispatchCommand(editor, REMOVE_TEXT_COMMAND, event);
      break;
    }

    case 'deleteContent': {
      dispatchCommand(editor, DELETE_CHARACTER_COMMAND, false);
      break;
    }

    case 'deleteWordBackward': {
      dispatchCommand(editor, DELETE_WORD_COMMAND, true);
      break;
    }

    case 'deleteWordForward': {
      dispatchCommand(editor, DELETE_WORD_COMMAND, false);
      break;
    }

    case 'deleteHardLineBackward':
    case 'deleteSoftLineBackward': {
      dispatchCommand(editor, DELETE_LINE_COMMAND, true);
      break;
    }

    case 'deleteContentForward':
    case 'deleteHardLineForward':
    case 'deleteSoftLineForward': {
      dispatchCommand(
        editor,
        deleteForwardCharacter ? DELETE_CHARACTER_COMMAND : DELETE_LINE_COMMAND,
        false,
      );
      break;
    }

    case 'formatStrikeThrough': {
      dispatchCommand(editor, FORMAT_TEXT_COMMAND, 'strikethrough');
      break;
    }

    case 'formatBold': {
      dispatchCommand(editor, FORMAT_TEXT_COMMAND, 'bold');
      break;
    }

    case 'formatItalic': {
      dispatchCommand(editor, FORMAT_TEXT_COMMAND, 'italic');
      break;
    }

    case 'formatUnderline': {
      dispatchCommand(editor, FORMAT_TEXT_COMMAND, 'underline');
      break;
    }

    case 'historyUndo': {
      dispatchCommand(editor, UNDO_COMMAND);
      break;
    }

    case 'historyRedo': {
      dispatchCommand(editor, REDO_COMMAND);
      break;
    }

    default:
    // NO-OP
  }

  return true;
}

function onInput(event: InputEvent, editor: LexicalEditor): void {
  // Note that the MutationObserver may or may not have already fired,
  // but the DOM and selection may have already changed.
  // See also:
  // - https://github.com/meta/lexical/issues/7028
  // - https://github.com/meta/lexical/pull/794

  // We don't want the onInput to bubble, in the case of nested editors.
  event.stopPropagation();
  const inputState = editor._inputState;
  clearHandledSelectionCommandInsertText(inputState);
  // Always run the update so the editor selection stays in sync with the DOM
  // (the {event} option recomputes it). Only skip dispatching the command when
  // a native control inside a decorator owns this event: processing it would
  // insert text into the editor rather than the control. Firefox 152 started
  // dispatching these to the editor root (#8738). This mirrors onBeforeInput.
  updateEditorSync(
    editor,
    () => {
      if (!$isInputEventTargetingCapturedSelection(event, editor)) {
        editor.dispatchCommand(INPUT_COMMAND, event);
      }
    },
    {event},
  );
  inputState.unprocessedBeforeInputData = null;
}

function $handleInput(event: InputEvent): boolean {
  const editor = getActiveEditor();
  const inputState = editor._inputState;
  const selection = $getSelection();
  const data = event.data;
  const targetRange = getTargetRange(event);

  let handled = false;
  let rerenderText = false;
  if (data != null && $isRangeSelection(selection)) {
    const domSelection = getDOMSelection(getWindow(editor));
    const domSelectionPoints =
      domSelection !== null
        ? getDOMSelectionPoints(domSelection, editor._rootElement)
        : null;

    // formatText() (e.g. Bold during composition) clears compositionKey,
    // but the browser still sends insertCompositionText with the
    // committed text. The browser has already updated the DOM, so we
    // must not re-insert via CONTROLLED_TEXT_INSERTION_COMMAND — let
    // $updateSelectedTextFromDOM sync from the DOM instead. Not gated
    // on IS_IOS because the formatText → $setCompositionKey(null) path
    // is platform-independent.
    const isOrphanedCompositionEnd =
      event.inputType === 'insertCompositionText' &&
      inputState.compositionPhase !== 'ending-firefox' &&
      !editor.isComposing();
    if (isOrphanedCompositionEnd) {
      inputState.hadOrphanedCompositionEvents = true;
    }

    const inputAnchorNode = selection.anchor.getNode();
    const isCompositionOnToken =
      event.inputType === 'insertCompositionText' &&
      inputState.compositionPhase !== 'ending-firefox' &&
      editor.isComposing() &&
      $isTextNode(inputAnchorNode) &&
      $isTokenOrSegmented(inputAnchorNode);

    if (
      !isOrphanedCompositionEnd &&
      !isCompositionOnToken &&
      $shouldPreventDefaultAndInsertText(
        selection,
        targetRange,
        data,
        event.timeStamp,
        false,
        domSelectionPoints,
      )
    ) {
      handled = true;
      // Given we're over-riding the default behavior, we will need
      // to ensure to disable composition before dispatching the
      // insertText command for when changing the sequence for FF.
      if (inputState.compositionPhase === 'ending-firefox') {
        const tokenRedirected = $onCompositionEndImpl(editor, data);
        inputState.compositionPhase = 'idle';
        if (tokenRedirected) {
          $addUpdateTag(COMPOSITION_END_TAG);
          $flushMutations();
          return true;
        }
      }
      const anchor = selection.anchor;
      const anchorNode = anchor.getNode();
      if (domSelection === null || domSelectionPoints === null) {
        return true;
      }
      const isBackward = selection.isBackward();
      const startOffset = isBackward
        ? selection.anchor.offset
        : selection.focus.offset;
      const endOffset = isBackward
        ? selection.focus.offset
        : selection.anchor.offset;
      // If the content is the same as inserted, then don't dispatch an insertion.
      // Given onInput doesn't take the current selection (it uses the previous)
      // we can compare that against what the DOM currently says.
      if (
        !CAN_USE_BEFORE_INPUT ||
        selection.isCollapsed() ||
        !$isTextNode(anchorNode) ||
        domSelectionPoints.anchorNode === null ||
        anchorNode.getTextContent().slice(0, startOffset) +
          data +
          anchorNode.getTextContent().slice(startOffset + endOffset) !==
          getAnchorTextFromDOM(domSelectionPoints.anchorNode)
      ) {
        dispatchCommand(editor, CONTROLLED_TEXT_INSERTION_COMMAND, data);
        // The browser has inserted the text as well, and not necessarily
        // where the editor did (Firefox, over a selection running into the
        // next block), so its text changes are not read back.
        rerenderText = event.inputType === 'insertText';
      }

      const textLength = data.length;

      // Another hack for FF, as it's possible that the IME is still
      // open, even though compositionend has already fired (sigh).
      if (
        IS_FIREFOX &&
        textLength > 1 &&
        event.inputType === 'insertCompositionText' &&
        !editor.isComposing()
      ) {
        selection.anchor.offset -= textLength;
        selection._cachedNodes = null;
        selection._cachedIsBackward = null;
      }

      // This ensures consistency on Android.
      if (IS_ANDROID_CHROME && editor.isComposing()) {
        inputState.lastKeyDownTimeStamp = 0;
        $setCompositionKey(null);
      }
    }
  }
  if (!handled) {
    const characterData = data !== null ? data : undefined;
    $updateSelectedTextFromDOM(false, editor, characterData);

    // onInput always fires after onCompositionEnd for FF, so the composition
    // end runs here. Mirror the COMPOSITION_END_TAG that $handleCompositionEnd
    // adds on Chrome/Webkit so listeners gated on this tag (markdown shortcut
    // trigger, history merge, autocomplete post-commit) see the same signal on
    // Firefox.
    if (inputState.compositionPhase === 'ending-firefox') {
      $onCompositionEndImpl(editor, data || undefined);
      $addUpdateTag(COMPOSITION_END_TAG);
      inputState.compositionPhase = 'idle';
    }
  }

  // Also flush any other mutations that might have occurred
  // since the change.
  $flushMutations(rerenderText);

  return true;
}

function onCompositionStart(
  event: CompositionEvent,
  editor: LexicalEditor,
): void {
  dispatchCommand(editor, COMPOSITION_START_COMMAND, event);
}

function $handleCompositionStart(event: CompositionEvent): boolean {
  const editor = getActiveEditor();
  const inputState = editor._inputState;
  const selection = $getSelection();

  if ($isRangeSelection(selection) && !editor.isComposing()) {
    inputState.compositionPhase = 'composing';
    inputState.hadOrphanedCompositionEvents = false;
    const anchor = selection.anchor;
    const node = selection.anchor.getNode();
    $setCompositionKey(anchor.key);
    $addUpdateTag(COMPOSITION_START_TAG);

    if (
      // If it has been 30ms since the last keydown, then we should
      // apply the empty space heuristic. We can't do this for Safari,
      // as the keydown fires after composition start.
      event.timeStamp <
        inputState.lastKeyDownTimeStamp + ANDROID_COMPOSITION_LATENCY ||
      // FF has issues around composing multibyte characters, so we also
      // need to invoke the empty space heuristic below.
      anchor.type === 'element' ||
      !selection.isCollapsed() ||
      (!IS_ANDROID_CHROME &&
        (node.getFormat() !== selection.format ||
          ($isTextNode(node) && node.getStyle() !== selection.style))) ||
      ($isTextNode(node) &&
        ($isTokenOrSegmented(node) ||
          (anchor.offset === 0 && !node.canInsertTextBefore()) ||
          (anchor.offset === node.getTextContentSize() &&
            !node.canInsertTextAfter())))
    ) {
      // Prepare a text node for the native composition. Desktop WebKit uses
      // the rendered composition suffix instead of adding a placeholder to
      // the document text.
      // IS_SAFARI also recognizes WebKit ports on non-Apple platforms.
      if (!IS_IOS && (IS_SAFARI || IS_APPLE_WEBKIT)) {
        $prepareCompositionTarget(selection);
      } else {
        dispatchCommand(
          editor,
          CONTROLLED_TEXT_INSERTION_COMMAND,
          COMPOSITION_START_CHAR,
        );
      }
      const updatedSelection = $getSelection();
      if ($isRangeSelection(updatedSelection)) {
        $setCompositionKey(updatedSelection.anchor.key);
      }
    }
  }

  return true;
}

function $handleCompositionEnd(event: CompositionEvent): boolean {
  const editor = getActiveEditor();
  editor._inputState.compositionPhase = 'idle';
  $onCompositionEndImpl(editor, event.data);
  $addUpdateTag(COMPOSITION_END_TAG);
  return true;
}

function $cleanupComposedSubclass(compositionKey: NodeKey | null): void {
  const inputState = getActiveEditor()._inputState;
  const composedSegmentedKey = inputState.composedSegmentedKey;
  inputState.composedSegmentedKey = null;
  if (compositionKey === null || compositionKey !== composedSegmentedKey) {
    return;
  }
  const composedNode = $getNodeByKey(compositionKey);
  if (
    !$isTextNode(composedNode) ||
    composedNode.getType() === 'text' ||
    $isTokenOrSegmented(composedNode) ||
    !composedNode.isAttached()
  ) {
    return;
  }
  const sel = $getSelection();
  const offset =
    $isRangeSelection(sel) && sel.anchor.key === compositionKey
      ? sel.anchor.offset
      : null;
  const replacement = $createTextNode(composedNode.getTextContent());
  replacement.setFormat(composedNode.getFormat());
  replacement.setStyle(composedNode.getStyle());
  composedNode.replace(replacement);
  if (offset !== null) {
    const safeOffset = Math.min(offset, replacement.getTextContentSize());
    replacement.select(safeOffset, safeOffset);
  }
}

function $onCompositionEndImpl(editor: LexicalEditor, data?: string): boolean {
  const compositionKey = editor._compositionKey;
  $setCompositionKey(null);

  // Handle termination of composition.
  if (compositionKey !== null && data != null) {
    // Composition can sometimes move to an adjacent DOM node when backspacing.
    // So check for the empty case.
    if (data === '') {
      const node = $getNodeByKey(compositionKey);
      const domElement = editor.getElementByKey(compositionKey);
      const textNode =
        domElement !== null && $isTextNode(node)
          ? $getDOMTextNode(node, domElement, editor)
          : null;

      if (
        textNode !== null &&
        textNode.nodeValue !== null &&
        $isTextNode(node)
      ) {
        const domSelection = getDOMSelection(getWindow(editor));
        const domSelectionPoints =
          domSelection &&
          getDOMSelectionPoints(domSelection, editor._rootElement);
        let anchorOffset = null;
        let focusOffset = null;

        if (
          domSelectionPoints !== null &&
          domSelectionPoints.anchorNode === textNode
        ) {
          anchorOffset = domSelectionPoints.anchorOffset;
          focusOffset = domSelectionPoints.focusOffset;
        }

        $updateTextNodeFromDOMContent(
          node,
          textNode.nodeValue,
          anchorOffset,
          focusOffset,
          true,
        );
      }
      $cleanupComposedSubclass(compositionKey);
      return false;
    } else if (data[data.length - 1] === '\n') {
      const selection = $getSelection();

      if ($isRangeSelection(selection) || $isNodeSelection(selection)) {
        // If the last character is a line break, we also need to insert
        // a line break.
        if ($isRangeSelection(selection)) {
          const focus = selection.focus;
          selection.anchor.set(focus.key, focus.offset, focus.type);
        }
        dispatchCommand(editor, KEY_ENTER_COMMAND, null);
        $cleanupComposedSubclass(compositionKey);
        return false;
      }
    }

    // When composition ends on a token node, markDirty reverts its DOM
    // but the composed text is lost. Redirect it to the adjacent TextNode
    // via the existing token-redirect logic in selection.insertText.
    const node = $getNodeByKey(compositionKey);
    if (node !== null && $isTextNode(node) && $isTokenOrSegmented(node)) {
      node.markDirty();
      const selection = $getSelection();
      const textLen = node.getTextContentSize();
      const offset =
        $isRangeSelection(selection) && selection.anchor.key === compositionKey
          ? selection.anchor.offset
          : textLen;
      node.select(offset, offset).insertText(data);
      return true;
    }
  }

  $updateSelectedTextFromDOM(true, editor, data);
  $cleanupComposedSubclass(compositionKey);
  return false;
}

function onCompositionEnd(
  event: CompositionEvent,
  editor: LexicalEditor,
): void {
  // Firefox finishes in the following input event. Desktop WebKit commits
  // through insertFromComposition; an empty cancellation finishes here.
  const inputState = editor._inputState;
  if (IS_FIREFOX) {
    inputState.compositionPhase = 'ending-firefox';
  } else if (event.data === '' || IS_IOS || !(IS_SAFARI || IS_APPLE_WEBKIT)) {
    // Cancellation has no insertFromComposition event to finish the Safari
    // composition. Release it now so the next ordinary key can dispatch.
    dispatchCommand(editor, COMPOSITION_END_COMMAND, event);
  }
}

function onKeyDown(event: KeyboardEvent, editor: LexicalEditor): void {
  const inputState = editor._inputState;
  if (IS_IOS) {
    // The virtual keyboard emits Shift events for manual toggles, but not for
    // automatic capitalization. Other key events may clear this state, never
    // set it, since their shiftKey flag also reflects automatic capitalization.
    inputState.isShiftKeyDown =
      event.key === 'Shift' ||
      (inputState.isShiftKeyDown && event.shiftKey && event.key !== 'CapsLock');
  }
  inputState.lastKeyDownTimeStamp = event.timeStamp;
  inputState.lastKeyCode = event.key;
  if (event.key !== 'Backspace') {
    clearHandledSelectionCommandInsertText(inputState);
  }
  if (
    editor.isComposing() ||
    (!IS_IOS && (IS_SAFARI || IS_APPLE_WEBKIT) && event.keyCode === 229)
  ) {
    return;
  }
  dispatchCommand(editor, KEY_DOWN_COMMAND, event);
}

function onKeyUp(event: KeyboardEvent, editor: LexicalEditor): void {
  if (!event.shiftKey || event.key === 'CapsLock') {
    editor._inputState.isShiftKeyDown = false;
  }
}

/** @internal */
export interface KeyDownShortcut extends KeyboardShortcutMatch {
  onMatch: (event: KeyboardEvent, editor: LexicalEditor) => void;
}

const ANY_MODIFIERS = {
  altKey: 'any',
  ctrlKey: 'any',
  metaKey: 'any',
  shiftKey: 'any',
} as const;
const CTRL_KEY = {ctrlKey: true} as const;
const META_KEY = {metaKey: true} as const;
const SHIFT_KEY_ANY = {shiftKey: 'any'} as const;
// Spelled out rather than spread from SHIFT_KEY_ANY: an object spread at
// module scope is a side effect to bundlers.
const ALT_SHIFT_KEY_ANY = {altKey: 'any', shiftKey: 'any'} as const;

/**
 * The keydown shortcuts that the editor handles natively, compiled to
 * dispatch by the pressed key and modifiers in O(1). Each shortcut's mask
 * is exclusive of every other mask on the same key, so at most one entry
 * matches any given event.
 */
function buildKeyDownShortcuts(): KeyDownShortcut[] {
  /** Dispatch the command with the KeyboardEvent as its payload */
  const dispatch = (
    key: string,
    modifiers: KeyboardEventModifierMask,
    command: LexicalCommand<KeyboardEvent>,
  ): KeyDownShortcut => ({
    key,
    modifiers,
    onMatch: (event, editor) => {
      dispatchCommand(editor, command, event);
    },
  });
  /** preventDefault() and dispatch the command with a fixed payload */
  const prevent = <T>(
    key: string,
    modifiers: KeyboardEventModifierMask,
    command: LexicalCommand<T>,
    payload: T,
  ): KeyDownShortcut => ({
    key,
    modifiers,
    onMatch: (event, editor) => {
      event.preventDefault();
      dispatchCommand(editor, command, payload);
    },
  });
  const enter = (
    modifiers: KeyboardEventModifierMask,
    isInsertLineBreak: boolean,
  ): KeyDownShortcut => ({
    key: 'Enter',
    modifiers,
    onMatch: (event, editor) => {
      const inputState = editor._inputState;
      inputState.isInsertLineBreak =
        isInsertLineBreak && (!IS_IOS || inputState.isShiftKeyDown);
      dispatchCommand(editor, KEY_ENTER_COMMAND, event);
      if (event.defaultPrevented) {
        inputState.isInsertLineBreak = false;
      }
    },
  });
  // Only RangeSelection can use the native cut/copy
  const copyOrCut = (
    key: string,
    command: LexicalCommand<ClipboardEvent | KeyboardEvent | null>,
  ): KeyDownShortcut => ({
    key,
    modifiers: CONTROL_OR_META,
    onMatch: (event, editor) => {
      const prevSelection = editor._editorState._selection;
      // A copy or cut in an input embedded in a node's DOM is the input's.
      // Preventing the keydown would stop the browser from firing it at all.
      if (
        prevSelection !== null &&
        !$isRangeSelection(prevSelection) &&
        !$isEventFromEmbeddedInput(event)
      ) {
        event.preventDefault();
        dispatchCommand(editor, command, event);
      }
    },
  });
  return [
    // moveForward / moveToEnd / moveBackward / moveToStart / moveUp / moveDown
    dispatch('ArrowRight', SHIFT_KEY_ANY, KEY_ARROW_RIGHT_COMMAND),
    dispatch('ArrowLeft', SHIFT_KEY_ANY, KEY_ARROW_LEFT_COMMAND),
    dispatch('ArrowUp', ALT_SHIFT_KEY_ANY, KEY_ARROW_UP_COMMAND),
    dispatch('ArrowDown', ALT_SHIFT_KEY_ANY, KEY_ARROW_DOWN_COMMAND),
    // lineBreak / paragraph
    enter({...ANY_MODIFIERS, shiftKey: true}, true),
    enter({...ANY_MODIFIERS, shiftKey: false}, false),
    dispatch(' ', ANY_MODIFIERS, KEY_SPACE_COMMAND),
    // deleteBackward
    {
      key: 'Backspace',
      modifiers: SHIFT_KEY_ANY,
      onMatch: (event, editor) => {
        if (dispatchCommand(editor, KEY_BACKSPACE_COMMAND, event)) {
          markHandledSelectionCommandInsertText(editor._inputState);
        }
      },
    },
    dispatch('Escape', ANY_MODIFIERS, KEY_ESCAPE_COMMAND),
    // deleteForward
    dispatch('Delete', {}, KEY_DELETE_COMMAND),
    // deleteWordBackward / deleteWordForward
    prevent('Backspace', CONTROL_OR_ALT, DELETE_WORD_COMMAND, true),
    prevent('Delete', CONTROL_OR_ALT, DELETE_WORD_COMMAND, false),
    prevent('b', CONTROL_OR_META, FORMAT_TEXT_COMMAND, 'bold'),
    prevent('u', CONTROL_OR_META, FORMAT_TEXT_COMMAND, 'underline'),
    prevent('i', CONTROL_OR_META, FORMAT_TEXT_COMMAND, 'italic'),
    dispatch('Tab', SHIFT_KEY_ANY, KEY_TAB_COMMAND),
    // undo / redo
    prevent('z', CONTROL_OR_META, UNDO_COMMAND, undefined),
    prevent('z', {...CONTROL_OR_META, shiftKey: true}, REDO_COMMAND, undefined),
    ...(IS_APPLE
      ? [
          // openLineBreak
          {
            key: 'o',
            modifiers: CTRL_KEY,
            onMatch: (event: KeyboardEvent, editor: LexicalEditor) => {
              event.preventDefault();
              dispatchCommand(editor, INSERT_LINE_BREAK_COMMAND, true);
            },
          },
          // moveToStart / moveToEnd mac
          dispatch(
            'ArrowLeft',
            {metaKey: true, ...SHIFT_KEY_ANY},
            MOVE_TO_START,
          ),
          dispatch(
            'ArrowRight',
            {metaKey: true, ...SHIFT_KEY_ANY},
            MOVE_TO_END,
          ),

          // deleteBackward / deleteForward
          prevent('h', CTRL_KEY, DELETE_CHARACTER_COMMAND, true),
          prevent('d', CTRL_KEY, DELETE_CHARACTER_COMMAND, false),
          // deleteLineBackward / deleteLineForward
          prevent('Backspace', META_KEY, DELETE_LINE_COMMAND, true),
          prevent('Delete', META_KEY, DELETE_LINE_COMMAND, false),
          prevent('k', CTRL_KEY, DELETE_LINE_COMMAND, false),
        ]
      : [
          dispatch('Home', SHIFT_KEY_ANY, MOVE_TO_START),
          dispatch('End', SHIFT_KEY_ANY, MOVE_TO_END),
          prevent('y', CTRL_KEY, REDO_COMMAND, undefined),
        ]),
    // selectAll
    {
      key: 'a',
      modifiers: CONTROL_OR_META,
      onMatch: (event, editor) => {
        event.preventDefault();
        if (dispatchCommand(editor, SELECT_ALL_COMMAND, event)) {
          markHandledSelectionCommandInsertText(editor._inputState);
        }
      },
    },
    copyOrCut('c', COPY_COMMAND),
    copyOrCut('x', CUT_COMMAND),
  ];
}

function $handleKeyDown(event: KeyboardEvent): boolean {
  const editor = getActiveEditor();
  if (event.key == null) {
    return true;
  }
  let keyDownShortcuts = editor._keyDownShortcuts;
  if (keyDownShortcuts === null) {
    keyDownShortcuts = compileKeyboardShortcuts(buildKeyDownShortcuts());
    editor._keyDownShortcuts = keyDownShortcuts;
  }
  const shortcut = keyDownShortcuts.match(event);
  if (shortcut) {
    shortcut.onMatch(event, editor);
  }

  if (isModifier(event)) {
    editor.dispatchCommand(KEY_MODIFIER_COMMAND, event);
  }

  return true;
}

function getRootElementRemoveHandles(
  rootElement: HTMLElement,
): RootElementRemoveHandles {
  // @ts-expect-error: internal field
  let eventHandles = rootElement.__lexicalEventHandles;

  if (eventHandles === undefined) {
    eventHandles = [];
    // @ts-expect-error: internal field
    rootElement.__lexicalEventHandles = eventHandles;
  }

  return eventHandles;
}

/**
 * Takes the selection of a mouse press from the DOM, at the press's
 * selectionchange, or at its first move or release if that comes first.
 */
function $selectMouseDown(
  editor: LexicalEditor,
  domSelection: Selection,
  event: Event,
  registration: DocumentRegistration | undefined,
): void {
  // Clear the flag on all editors registered on this document — a
  // pointerdown inside a nested editor bubbles to the parent, setting
  // the flag on both. Only one selectionchange fires, so stale flags
  // on sibling/parent editors must be cleared to match the previous
  // single-global semantics.
  if (registration !== undefined) {
    for (const ed of registration.editors) {
      ed._inputState.isSelectionChangeFromMouseDown = false;
    }
  }
  const domAnchorNode = getDOMSelectionPoints(
    domSelection,
    editor._rootElement,
  ).anchorNode;
  if (isHTMLElement(domAnchorNode) || isDOMTextNode(domAnchorNode)) {
    // If the user is attempting to click selection back onto text, then
    // we should attempt create a range selection.
    // When we click on an empty paragraph node or the end of a paragraph that ends
    // with an image/poll, the nodeType will be ELEMENT_NODE
    const newSelection = $internalCreateRangeSelection(
      $getPreviousSelection(),
      domSelection,
      editor,
      event,
    );
    $setSelection(newSelection);
  }
}

// Mapping root editors to their active nested editors, contains nested editors
// mapping only, so if root editor is selected map will have no reference to free up memory
const activeNestedEditorsMap: Map<string, LexicalEditor> = new Map();

function onDocumentSelectionChange(event: Event): void {
  const target = event.target;
  // Text controls have their own selection. Their bubbling selectionchange
  // events do not indicate a change to the document's selection.
  if (
    isHTMLElement(target) &&
    (target.nodeName === 'INPUT' || target.nodeName === 'TEXTAREA')
  ) {
    return;
  }
  const domSelection = getDOMSelectionFromTarget(target);
  if (domSelection === null) {
    return;
  }
  // Ask each editor registered against this document for its shadow-aware
  // anchor and pick the one whose root actually contains the answer.
  // Selection.anchorNode is retargeted to a light-DOM ancestor for any
  // selection inside a shadow tree, so trusting it directly attributes a
  // shadow editor's change to whichever enclosing editor the engine
  // walked up to (or drops the event when the host sits outside every
  // editor). Reading getComposedRanges through each editor's own shadow
  // roots gets the un-retargeted anchor regardless of which editor owns
  // it.
  //
  // Nested case (inner shadow editor inside a light-DOM outer editor):
  // visit shadow-mounted candidates first. The inner editor's anchor read
  // resolves through its own shadow root and matches its candidate; the
  // outer editor's degraded read (empty composed range → retargeted host
  // landing inside outer's tree) never wins because we have already broken
  // out of the loop.

  const ownerDocument = getDOMOwnerDocument(target);
  let nextActiveEditor: LexicalEditor | null = null;
  const registration =
    ownerDocument !== null
      ? documentRegistrations.get(ownerDocument)
      : undefined;
  if (ownerDocument !== null) {
    if (registration !== undefined) {
      const editorsForDoc = registration.editors;
      let hasShadow = registration.hasShadowEditor;
      if (hasShadow === undefined) {
        hasShadow = false;
        for (const ed of editorsForDoc) {
          if (
            ed._rootElement !== null &&
            isDOMShadowRoot(ed._rootElement.getRootNode())
          ) {
            hasShadow = true;
            break;
          }
        }
        registration.hasShadowEditor = hasShadow;
      }
      if (!hasShadow) {
        const anchorNode = domSelection.anchorNode;
        if (
          anchorNode !== null &&
          !(isHTMLElement(anchorNode) && anchorNode.shadowRoot !== null)
        ) {
          nextActiveEditor = getNearestEditorFromDOMNode(anchorNode);
        }
      } else {
        // Try shadow-mounted candidates first: their getDOMSelectionPoints
        // call resolves the un-retargeted anchor through their own shadow
        // root, so an inner shadow editor inside a light-DOM outer editor
        // wins attribution before the outer candidate sees the host-retargeted
        // anchor that lands inside outer's tree.
        //
        // Single pass with deferred light-DOM fallback avoids Array.from +
        // sort and the redundant getRootNode calls the comparator needed.
        let deferredLightEditor: LexicalEditor | null = null;
        for (const candidate of editorsForDoc) {
          const candidateRoot = candidate._rootElement;
          if (candidateRoot === null) {
            continue;
          }
          const anchorNode = getDOMSelectionPoints(
            domSelection,
            candidateRoot,
          ).anchorNode;
          if (anchorNode === null) {
            continue;
          }
          if (getNearestEditorFromDOMNode(anchorNode) !== candidate) {
            continue;
          }
          if (isDOMShadowRoot(candidateRoot.getRootNode())) {
            nextActiveEditor = candidate;
            break;
          }
          if (deferredLightEditor === null) {
            deferredLightEditor = candidate;
          }
        }
        if (nextActiveEditor === null && deferredLightEditor !== null) {
          nextActiveEditor = deferredLightEditor;
        }
      }
    }
    // Fallback: the shadow-aware anchor sits outside every registered
    // editor (a programmatic selection change that landed on a non-editor
    // element, or a host the engine retargeted to). Use the deep-focused
    // element so a user typing into an editor still gets an attribution.
    if (nextActiveEditor === null) {
      const activeElement = getActiveElementDeep(ownerDocument);
      nextActiveEditor =
        activeElement !== null
          ? getNearestEditorFromDOMNode(activeElement)
          : null;
    }
  }
  if (nextActiveEditor === null) {
    return;
  }

  if (nextActiveEditor._inputState.isSelectionChangeFromMouseDown) {
    updateEditorSync(nextActiveEditor, () =>
      $selectMouseDown(nextActiveEditor, domSelection, event, registration),
    );
  }

  // When editor receives selection change event, we're checking if
  // it has any sibling editors (within same parent editor) that were active
  // before, and trigger selection change on it to nullify selection.
  const editors = getEditorsToPropagate(nextActiveEditor);
  const rootEditor = editors[editors.length - 1];
  const rootEditorKey = rootEditor._key;
  const activeNestedEditor = activeNestedEditorsMap.get(rootEditorKey);
  const prevActiveEditor = activeNestedEditor || rootEditor;

  if (prevActiveEditor !== nextActiveEditor) {
    onSelectionChange(domSelection, prevActiveEditor, false);
  }

  onSelectionChange(domSelection, nextActiveEditor, true);

  // If newly selected editor is nested, then add it to the map, clean map otherwise
  if (nextActiveEditor !== rootEditor) {
    activeNestedEditorsMap.set(rootEditorKey, nextActiveEditor);
  } else if (activeNestedEditor) {
    activeNestedEditorsMap.delete(rootEditorKey);
  }
}

/** @internal */
export function stopLexicalPropagation(event: Event): void {
  // We attach a special property to ensure the same event doesn't re-fire
  // for parent editors.
  // @ts-ignore
  event._lexicalHandled = true;
}

function hasStoppedLexicalPropagation(event: Event): boolean {
  // @ts-ignore
  const stopped = event._lexicalHandled === true;
  return stopped;
}

export type EventHandler = (event: Event, editor: LexicalEditor) => void;

export function addRootElementEvents(
  rootElement: HTMLElement,
  editor: LexicalEditor,
): void {
  // We only want to have a single global selectionchange event handler, shared
  // between all editor instances.
  const doc = rootElement.ownerDocument;
  rootElementToDocument.set(rootElement, doc);
  let registration = documentRegistrations.get(doc);
  if (registration === undefined) {
    registration = {
      editors: new Set(),
      hasShadowEditor: undefined,
    };
    documentRegistrations.set(doc, registration);
  }
  registration.editors.add(editor);
  registration.hasShadowEditor = undefined;

  // @ts-expect-error: internal field
  rootElement.__lexicalEditor = editor;
  const removeHandles = getRootElementRemoveHandles(rootElement);
  // Reference-counted shared `selectionchange` listener; the disposer is run
  // with this root element's other listeners in removeRootElementEvents.
  removeHandles.push(documentSelectionChange.register(doc));

  const events: RootElementEvents = {
    blur: BLUR_COMMAND,
    click: onClick,
    compositionend: onCompositionEnd,
    compositionstart: onCompositionStart,
    copy: COPY_COMMAND,
    cut: CUT_COMMAND,
    dragend: DRAGEND_COMMAND,
    dragover: DRAGOVER_COMMAND,
    dragstart: DRAGSTART_COMMAND,
    drop: DROP_COMMAND,
    focus: FOCUS_COMMAND,
    input: onInput,
    keydown: onKeyDown,
    paste: PASTE_COMMAND,
    pointerdown: onPointerDown,
    ...(CAN_USE_BEFORE_INPUT && {beforeinput: onBeforeInput}),
    ...(IS_IOS && {keyup: onKeyUp, mousedown: onMouseDownIOS}),
  };
  for (const [eventName, onEvent] of Object.entries(events)) {
    const eventHandler = (event: Event) => {
      if (hasStoppedLexicalPropagation(event)) {
        return;
      }
      stopLexicalPropagation(event);
      if (eventName === 'blur') {
        restoreInputModeIOS(editor, rootElement);
        editor._inputState.isShiftKeyDown = false;
        editor._inputState.isInsertLineBreak = false;
      }
      // A read-only editor still handles clicks and copies.
      if (
        editor.isEditable() ||
        eventName === 'click' ||
        eventName === 'copy'
      ) {
        if (typeof onEvent === 'function') {
          onEvent(event, editor);
        } else {
          dispatchCommand(editor, onEvent, event);
        }
      }
    };
    removeHandles.push(
      registerEventListener(rootElement, eventName, eventHandler),
    );
  }
  // The latest pointerdown in the root element.
  let press: PointerEvent | undefined;
  // Follows a mouse press that can start a selection drag: not on a decorator,
  // nor a double or triple click, which selects by words or paragraphs.
  const endMouseDrag = () => {
    editor._inputState.mouseDrag = null;
  };
  // Captured on the document, which also sees the part of a drag outside the
  // root element, and its release, even where a listener stops them. A touch
  // or a pen beside the drag leaves it alone.
  const onMouseDragMove = (event: PointerEvent) => {
    const inputState = editor._inputState;
    const drag = inputState.mouseDrag;
    // The browser selects nothing from a press that a listener cancelled.
    // A selectionchange during it is still the press's, as it can report a
    // selection that the listener made, but not one after its release: in
    // Firefox, that of a Shift-click that a table took can come after the
    // click, and report a caret put since.
    if (press && press.defaultPrevented && !event.buttons) {
      inputState.isSelectionChangeFromMouseDown = false;
    }
    if (!drag || event.pointerType !== 'mouse') {
      return;
    }
    const isRelease = event.type === 'pointerup';
    if (event.type === 'pointercancel' || (!isRelease && event.buttons !== 1)) {
      return endMouseDrag();
    }
    inputState.mouseDrag = isRelease ? null : event;
    updateEditorSync(editor, () => {
      const domSelection = getDOMSelection(getWindow(editor));
      if (drag.type !== 'mousedown') {
        // The release can come before the selectionchange of the last move,
        // so it handles that as the selectionchange does, but a table's
        // selection of cells stays.
        const selection =
          isRelease &&
          domSelection &&
          $isRangeSelection($getSelection()) &&
          $internalCreateRangeSelection(
            $getPreviousSelection(),
            domSelection,
            editor,
            new Event('selectionchange'),
          );
        if (selection) {
          $setSelection(selection);
        }
        return $adjustMouseDrag(
          editor,
          event,
          isRelease && domSelection
            ? getDOMSelectionPoints(domSelection, rootElement).focusNode
            : null,
        );
      }
      // Not adjusted on the first move: Chromium and WebKit start a drag and
      // drop of a selection that holds the press when they handle it.
      const selection = $createRangeSelectionFromDom(domSelection, editor);
      if (
        drag.defaultPrevented ||
        // A press on a selection drags it rather than selecting.
        (!drag.shiftKey && selection && !selection.isCollapsed())
      ) {
        endMouseDrag();
      } else if (domSelection && inputState.isSelectionChangeFromMouseDown) {
        // The editor has not seen the press's selectionchange yet, which the
        // drag extends from, so this handles it as that does. None may come
        // for a press that leaves the caret where it was, which keeps a
        // format armed there. That selectionchange, when it comes, must not
        // replace what the editor made of the press, such as a table's
        // selection of cells, after which macOS Chromium puts a caret at the
        // start of the editor.
        $selectMouseDown(
          editor,
          domSelection,
          new Event('selectionchange'),
          registration,
        );
        $adjustMouseDrag(
          editor,
          drag,
          getDOMSelectionPoints(domSelection, rootElement).focusNode,
        );
        const pressed = $getSelection();
        if (
          $isRangeSelection(pressed) &&
          pressed.isCollapsed() &&
          !pressed.is($getPreviousSelection())
        ) {
          $updateCollapsedSelectionFormatStyle(editor, pressed);
        }
      }
    });
  };
  removeHandles.push(
    registerEventListeners(
      doc,
      {
        pointercancel: onMouseDragMove,
        pointermove: onMouseDragMove,
        pointerup: onMouseDragMove,
      },
      true,
    ),
    // The window misses the release of a press that it loses focus during.
    registerEventListener(getWindow(editor), 'blur', endMouseDrag),
    // A read-only editor leaves a drag to the browser, as it does not write
    // the DOM selection.
    editor.registerEditableListener(endMouseDrag),
    registerEventListeners(rootElement, {
      contextmenu: endMouseDrag,
      dragstart: endMouseDrag,
      // As after a release that the window did not get, but not for the
      // modifier keys, which Windows repeats while they are held. Chrome's
      // keydown for an accepted autofill suggestion is not a KeyboardEvent.
      keydown: event =>
        (event.getModifierState && event.getModifierState(event.key)) ||
        endMouseDrag(),
      mousedown: event => {
        const inputState = editor._inputState;
        inputState.mouseDrag =
          event.button === 0 &&
          event.detail === 1 &&
          !event.defaultPrevented &&
          inputState.lastPointerType === 'mouse' &&
          editor.isEditable() &&
          !editor.isComposing() &&
          !isDOMCapturingSelection(
            getComposedEventTarget(event) as Node,
            editor,
          )
            ? event
            : null;
      },
    }),
    // Captured, so a decorator that stops its pointerdown from propagating
    // (resize handles often do) can't leave a stale pointer type behind for
    // the mousedown that follows.
    registerEventListener(
      rootElement,
      'pointerdown',
      event => {
        press = event;
        editor._inputState.lastPointerType = event.pointerType;
      },
      true,
    ),
  );
  if (IS_IOS) {
    removeHandles.push(
      registerTapListenerIOS(rootElement, event =>
        onTouchEndIOS(event, editor, rootElement),
      ),
    );
  }
}

const rootElementNotRegisteredWarning = warnOnlyOnce(
  'Root element not registered',
);

export function removeRootElementEvents(rootElement: HTMLElement): void {
  const doc = rootElementToDocument.get(rootElement);
  if (doc === undefined) {
    rootElementNotRegisteredWarning();
    return;
  }

  const registration = documentRegistrations.get(doc);
  if (registration === undefined) {
    // This can happen if setRootElement() failed
    rootElementNotRegisteredWarning();
    return;
  }

  // The shared `selectionchange` listener is reference counted by
  // `documentSelectionChange`; its disposer runs below with `removeHandles`.
  rootElementToDocument.delete(rootElement);

  const editor = getEditorPropertyFromDOMNode(rootElement);

  if (isLexicalEditor(editor)) {
    cleanActiveNestedEditorsMap(editor);
    registration.editors.delete(editor);
    registration.hasShadowEditor = undefined;
    // @ts-expect-error: internal field
    rootElement.__lexicalEditor = null;
  } else if (editor) {
    invariant(
      false,
      'Attempted to remove event handlers from a node that does not belong to this build of Lexical',
    );
  }

  const removeHandles = getRootElementRemoveHandles(rootElement);

  for (let i = 0; i < removeHandles.length; i++) {
    removeHandles[i]();
  }

  // @ts-expect-error: internal field
  rootElement.__lexicalEventHandles = [];
}

function cleanActiveNestedEditorsMap(editor: LexicalEditor) {
  if (editor._parentEditor !== null) {
    // For nested editor cleanup map if this editor was marked as active
    const editors = getEditorsToPropagate(editor);
    const rootEditor = editors[editors.length - 1];
    const rootEditorKey = rootEditor._key;

    if (activeNestedEditorsMap.get(rootEditorKey) === editor) {
      activeNestedEditorsMap.delete(rootEditorKey);
    }
  } else {
    // For top-level editors cleanup map
    activeNestedEditorsMap.delete(editor._key);
  }
}

/** @internal */
export function markSelectionChangeFromDOMUpdate(
  editor: LexicalEditor,
  anchorNode?: Node,
  anchorOffset?: number,
  focusNode?: Node,
  focusOffset?: number,
): void {
  const inputState = editor._inputState;
  inputState.isSelectionChangeFromDOMUpdate = true;
  inputState.selectionChangeFromDOMUpdatePoints =
    anchorNode !== undefined &&
    anchorOffset !== undefined &&
    focusNode !== undefined &&
    focusOffset !== undefined
      ? {anchorNode, anchorOffset, focusNode, focusOffset}
      : null;
}

/** @internal */
export function markCollapsedSelectionFormat(
  editor: LexicalEditor,
  format: number,
  style: string,
  offset: number,
  key: NodeKey,
  timeStamp: number,
): void {
  editor._inputState.collapsedSelectionFormat = {
    format,
    key,
    offset,
    style,
    timeStamp,
  };
}
