/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Signal} from '@lexical/extension';

import {calculateZoomLevel} from '@lexical/utils';
import {
  $addUpdateTag,
  $findMatchingParent,
  $getNearestNodeFromDOMNode,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  createCommand,
  type ElementNode,
  getActiveElement,
  getNearestEditorFromDOMNode,
  IS_FIREFOX,
  isHTMLElement,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_SPACE_COMMAND,
  type LexicalCommand,
  type LexicalEditor,
  mergeRegister,
  type NodeKey,
  registerEventListener,
  registerEventListeners,
  SKIP_DOM_SELECTION_TAG,
  SKIP_SELECTION_FOCUS_TAG,
} from 'lexical';

import {$insertList} from './formatList';
import {$isListItemNode, type ListItemNode} from './LexicalListItemNode';
import {$isListNode} from './LexicalListNode';

// What a focused check list item's own key handlers use: Space toggles it,
// the vertical arrows move to the sibling item and keep the checkbox focused,
// Escape hands the focus back itself, and the left arrow is the one key that
// means either thing -- it is what moves the focus onto the checkbox, and
// pressing it again is what leaves the item -- so its handler decides rather
// than the listener below. The modifiers are here because pressing one on its
// own operates nothing at all.
const CHECKBOX_KEYS = new Set([
  ' ',
  'Alt',
  'ArrowDown',
  'ArrowLeft',
  'ArrowUp',
  'CapsLock',
  'Control',
  'Escape',
  'Meta',
  'Shift',
]);

export const INSERT_CHECK_LIST_COMMAND: LexicalCommand<void> = createCommand(
  'INSERT_CHECK_LIST_COMMAND',
);

/**
 * Registers the checklist plugin with the editor.
 * @param editor The LexicalEditor instance.
 * @param options Optional configuration.
 *   - disableTakeFocusOnClick: If true, clicking a checklist item will not focus the editor (useful for mobile).
 */
export function registerCheckList(
  editor: LexicalEditor,
  options?: {disableTakeFocusOnClick?: boolean | Signal<boolean>},
) {
  const disableTakeFocusOnClick =
    (options && options.disableTakeFocusOnClick) || false;
  const peekDisableTakeFocusOnClick =
    typeof disableTakeFocusOnClick === 'boolean'
      ? () => disableTakeFocusOnClick
      : disableTakeFocusOnClick.peek.bind(disableTakeFocusOnClick);

  // Mobile tap fix: the touchstart listener registered below calls
  // event.preventDefault() to keep the caret away from the marker. On iOS
  // Safari and Android Chrome that suppression also cancels the synthesized
  // click, so handleClick never runs and the checkbox cannot be toggled by
  // tap. We additionally listen for pointerup with pointerType === 'touch'
  // and run the same toggle logic, deduplicating against any click that
  // does fire on browsers where preventDefault doesn't suppress it.
  //
  // Dedup state is per-target: recorded as `__lexicalCheckListLastHandled`
  // on the target element, and written only by the touch pointerup path.
  // A global window would block tapping a second checkbox within 500ms of
  // toggling the first. The click path only reads the timestamp, so rapid
  // mouse clicks on the same desktop checkbox are not throttled — only the
  // synthesized click that follows a touch pointerup is absorbed.
  const DEDUP_WINDOW_MS = 500;
  const isWithinDedupWindow = (
    event: PointerEvent | MouseEvent | TouchEvent,
  ): boolean => {
    const target = event.target;
    if (!isHTMLElement(target)) {
      return false;
    }
    // @ts-ignore internal field
    const last = target.__lexicalCheckListLastHandled as number | undefined;
    return last !== undefined && event.timeStamp - last < DEDUP_WINDOW_MS;
  };
  const recordHandled = (event: PointerEvent | MouseEvent | TouchEvent) => {
    const target = event.target;
    if (isHTMLElement(target)) {
      // @ts-ignore internal field
      target.__lexicalCheckListLastHandled = event.timeStamp;
    }
  };
  const configHandleClick = (event: PointerEvent | MouseEvent | TouchEvent) => {
    if (isWithinDedupWindow(event)) {
      return;
    }
    handleClick(event, peekDisableTakeFocusOnClick());
  };
  const configHandlePointerUp = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') {
      return;
    }
    if (isWithinDedupWindow(event)) {
      return;
    }
    recordHandled(event);
    handleClick(event, peekDisableTakeFocusOnClick());
  };
  // What the last pointer press landed on, recorded in the capture-phase
  // handler that runs before the browser moves focus and consumed once the
  // gesture ends. A press on the item's content is the one that has to hand
  // focus back; a press on the check mark is how the plugin focuses the item
  // on purpose; and 'none' covers a click with no press behind it, which a
  // screen reader synthesizes on the focused item and which must not move
  // focus at all.
  let lastPress: 'checkMark' | 'content' | 'none' = 'none';
  const configHandleSelectDefaults = (
    event: PointerEvent | MouseEvent | TouchEvent,
  ) => {
    lastPress = handleSelectDefaults(event, peekDisableTakeFocusOnClick())
      ? 'checkMark'
      : 'content';
  };
  const returnFocusAfterPress = () => {
    if (lastPress === 'content') {
      returnFocusToRoot(editor);
    }
    lastPress = 'none';
  };
  return mergeRegister(
    editor.registerCommand(
      INSERT_CHECK_LIST_COMMAND,
      () => {
        $insertList('check');
        return true;
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      event => {
        return handleArrowUpOrDown(event, editor, false);
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      event => {
        return handleArrowUpOrDown(event, editor, true);
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        const activeItem = getActiveCheckListItem(editor);

        if (activeItem != null) {
          const rootElement = editor.getRootElement();

          if (rootElement != null) {
            rootElement.focus();
          }

          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      KEY_SPACE_COMMAND,
      event => {
        const activeItem = getActiveCheckListItem(editor);

        if (activeItem != null && editor.isEditable()) {
          const listItemNode = $getNearestNodeFromDOMNode(activeItem);

          if ($isListItemNode(listItemNode)) {
            event.preventDefault();
            listItemNode.toggleChecked();
          }
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      event => {
        // The checkbox holds the focus already, so this arrow is the caret
        // moving rather than the checkbox being reached: back through the
        // label, or out of the item altogether when the caret is at its
        // start. Either way the editing host takes the focus back and the
        // caret moves as it normally would.
        if (getActiveCheckListItem(editor) !== null) {
          returnFocusToRoot(editor);
          return false;
        }

        return editor.read('latest', () => {
          const selection = $getSelection();

          if ($isRangeSelection(selection) && selection.isCollapsed()) {
            const {anchor} = selection;
            const isElement = anchor.type === 'element';

            if (isElement || anchor.offset === 0) {
              const anchorNode = anchor.getNode();
              const elementNode = $findMatchingParent(
                anchorNode,
                node => $isElementNode(node) && !node.isInline(),
              );
              if ($isListItemNode(elementNode)) {
                const parent = elementNode.getParent();
                if (
                  $isListNode(parent) &&
                  parent.getListType() === 'check' &&
                  (isElement || elementNode.getFirstDescendant() === anchorNode)
                ) {
                  const domNode = editor.getElementByKey(elementNode.__key);

                  // getActiveElement rather than document.activeElement, which
                  // reports the shadow host in a shadow root (so this would
                  // otherwise always re-focus and swallow the arrow key).
                  if (
                    domNode != null &&
                    getActiveElement(domNode) !== domNode
                  ) {
                    domNode.focus();
                    event.preventDefault();
                    return true;
                  }
                }
              }
            }
          }

          return false;
        });
      },
      COMMAND_PRIORITY_LOW,
    ),

    editor.registerRootListener(rootElement => {
      if (rootElement !== null) {
        return mergeRegister(
          registerEventListeners(rootElement, {
            // Whichever of the two runs first consumes the press, before the
            // toggle it wraps focuses the item again for a check mark press.
            // pointerup also covers a gesture that never produces a click,
            // such as a right click opening the context menu.
            click: event => {
              returnFocusAfterPress();
              configHandleClick(event);
            },
            pointerup: event => {
              returnFocusAfterPress();
              configHandlePointerUp(event);
            },
          }),
          // Use capture so we run before other listeners that might move focus.
          // Some browsers / integrations still generate mousedown events as well
          // as pointerdown, so handle both.
          registerEventListeners(
            rootElement,
            {
              // Entering text moves the caret, which Chrome and Safari also
              // treat as handing focus back to the editing host. Capture so
              // the focus is right before the editor handles the input.
              beforeinput: () => returnFocusToRoot(editor),
              // Correcting the focus as soon as the browser moves it, rather
              // than waiting for the release, keeps the item from holding it
              // for the length of the press. Only Firefox: Chrome and Safari
              // hand the focus back themselves as part of placing the caret,
              // and stepping in before they do puts the caret at the start of
              // the item instead. A press on an item that already holds the
              // focus moves no focus at all and so arrives at neither of
              // these, which is what the release below is still there for.
              focusin: () => {
                if (IS_FIREFOX && lastPress === 'content') {
                  returnFocusToRoot(editor);
                }
              },
              // Every other key is the text being operated rather than the
              // checkbox, the caret-moving arrows above all: the caret leaves
              // the check mark behind, so the focus has to follow it. Text
              // entry arrives here too, but not all of it comes from a key,
              // which is why beforeinput covers that separately.
              keydown: event => {
                if (!CHECKBOX_KEYS.has(event.key)) {
                  returnFocusToRoot(editor);
                }
              },
              mousedown: configHandleSelectDefaults,
              pointerdown: configHandleSelectDefaults,
            },
            {capture: true},
          ),
          // Intercept touchstart to stop the mobile browser from placing the
          // caret and opening the keyboard when tapping the checklist marker.
          // passive:false lets the handler call preventDefault, so it needs its
          // own options and can't share the capture-only group above.
          registerEventListener(
            rootElement,
            'touchstart',
            configHandleSelectDefaults,
            {
              capture: true,
              passive: false,
            },
          ),
        );
      }
    }),
  );
}

function handleCheckItemEvent(
  event: PointerEvent | MouseEvent | TouchEvent,
  callback: () => void,
) {
  const target = event.target;

  if (!isHTMLElement(target)) {
    return;
  }

  // Ignore clicks on LI that have nested lists
  const firstChild = target.firstChild;

  if (
    isHTMLElement(firstChild) &&
    (firstChild.tagName === 'UL' || firstChild.tagName === 'OL')
  ) {
    return;
  }

  const parentNode = target.parentNode;

  // @ts-ignore internal field
  if (!parentNode || parentNode.__lexicalListType !== 'check') {
    return;
  }
  let clientX: number | null = null;
  let pointerType: string | null = null;

  if ('clientX' in event) {
    clientX = event.clientX;
  } else if ('touches' in event) {
    const touches = event.touches;
    if (touches.length > 0) {
      clientX = touches[0].clientX;
      pointerType = 'touch';
    }
  }

  // If we couldn't resolve a clientX (unexpected input), bail out.
  if (clientX == null) {
    return;
  }

  const rect = target.getBoundingClientRect();
  const zoom = calculateZoomLevel(target);
  const clientXInPixels = clientX / zoom;

  // Use getComputedStyle if available, otherwise fallback to 0px width
  const targetView = target.ownerDocument.defaultView;
  const beforeStyles = targetView
    ? targetView.getComputedStyle(target, '::before')
    : ({width: '0px'} as CSSStyleDeclaration);
  const beforeWidthInPixels = parseFloat(beforeStyles.width);

  // Make click area slightly larger for touch devices to improve accessibility
  // Determine whether this is a touch event; some environments may supply
  // pointerType on PointerEvent while touch events use the `touches` API above.
  const isTouchEvent =
    pointerType === 'touch' ||
    ('pointerType' in event && event.pointerType === 'touch');
  const clickAreaPadding = isTouchEvent ? 32 : 0; // Add 32px padding for touch events

  if (
    target.dir === 'rtl'
      ? clientXInPixels < rect.right + clickAreaPadding &&
        clientXInPixels > rect.right - beforeWidthInPixels - clickAreaPadding
      : clientXInPixels > rect.left - clickAreaPadding &&
        clientXInPixels < rect.left + beforeWidthInPixels + clickAreaPadding
  ) {
    callback();
  }
}

function handleClick(
  event: PointerEvent | MouseEvent | TouchEvent,
  disableFocusOnClick: boolean,
) {
  handleCheckItemEvent(event, () => {
    if (isHTMLElement(event.target)) {
      const domNode = event.target;
      const editor = getNearestEditorFromDOMNode(domNode);

      if (editor != null && editor.isEditable()) {
        editor.update(() => {
          const node = $getNearestNodeFromDOMNode(domNode);

          if ($isListItemNode(node)) {
            if (disableFocusOnClick) {
              $addUpdateTag(SKIP_SELECTION_FOCUS_TAG);
              $addUpdateTag(SKIP_DOM_SELECTION_TAG);
            } else {
              domNode.focus();
            }
            node.toggleChecked();
          }
        });
      }
    }
  });
}

/**
 * Prevents default focus switch behavior
 *
 * @param event might be of type PointerEvent, MouseEvent, or TouchEvent, hence the generic Event type
 *
 */
function handleSelectDefaults(
  event: PointerEvent | MouseEvent | TouchEvent,
  disableTakeFocusOnClick: boolean,
): boolean {
  let isCheckMarkPress = false;

  handleCheckItemEvent(event, () => {
    isCheckMarkPress = true;
    // Prevents caret moving when clicking on check mark.
    event.preventDefault();
    if (disableTakeFocusOnClick) {
      event.stopPropagation();
    }
  });

  return isCheckMarkPress;
}

// A check list item carries tabIndex="-1" so the plugin can hand it focus for
// its checkbox role, which also makes it the nearest focusable ancestor of the
// caret. Pressing the mouse in the item's text therefore focuses the item, and
// a focused item is what the key handlers read as "the checkbox is what the
// keyboard is operating", so Space toggled the item instead of typing a space
// (#4680). Chrome and Safari hand focus back to the root once they are done
// with the press; this does the same in every browser, at the end of the
// gesture so the press has finished placing the caret first.
function returnFocusToRoot(editor: LexicalEditor): void {
  const rootElement = editor.getRootElement();
  const activeElement = rootElement ? getActiveElement(rootElement) : null;

  if (
    rootElement !== null &&
    isHTMLElement(activeElement) &&
    isCheckListItem(activeElement)
  ) {
    rootElement.focus({preventScroll: true});
  }
}

function isCheckListItem(dom: HTMLElement): boolean {
  const parentNode = dom.parentNode;

  return (
    dom.tagName === 'LI' &&
    parentNode != null &&
    // @ts-ignore internal field
    parentNode.__lexicalListType === 'check'
  );
}

function getActiveCheckListItem(editor: LexicalEditor): HTMLElement | null {
  // getActiveElement scoped to the editor's root rather than
  // document.activeElement, which reports the shadow host when the editor is
  // in a shadow root (so the focused <li> would otherwise be invisible here).
  const rootElement = editor.getRootElement();
  const activeElement = rootElement ? getActiveElement(rootElement) : null;

  return isHTMLElement(activeElement) && isCheckListItem(activeElement)
    ? activeElement
    : null;
}

function findCheckListItemSibling(
  node: ListItemNode,
  backward: boolean,
): ListItemNode | null {
  let sibling = backward ? node.getPreviousSibling() : node.getNextSibling();
  let parent: ElementNode | null = node;

  // Going up in a tree to get non-null sibling
  while (sibling == null && $isListItemNode(parent)) {
    // Get li -> parent ul/ol -> parent li
    parent = parent.getParentOrThrow().getParent();

    if (parent != null) {
      sibling = backward
        ? parent.getPreviousSibling()
        : parent.getNextSibling();
    }
  }

  // Going down in a tree to get first non-nested list item
  while ($isListItemNode(sibling)) {
    const firstChild = backward
      ? sibling.getLastChild()
      : sibling.getFirstChild();

    if (!$isListNode(firstChild)) {
      return sibling;
    }

    sibling = backward ? firstChild.getLastChild() : firstChild.getFirstChild();
  }

  return null;
}

function handleArrowUpOrDown(
  event: KeyboardEvent,
  editor: LexicalEditor,
  backward: boolean,
) {
  const activeItem = getActiveCheckListItem(editor);

  if (activeItem != null) {
    let nextItemKey: null | NodeKey = null;

    editor.update(
      () => {
        const listItem = $getNearestNodeFromDOMNode(activeItem);

        if (!$isListItemNode(listItem)) {
          return;
        }

        const nextListItem = findCheckListItemSibling(listItem, backward);

        if (nextListItem != null) {
          nextListItem.selectStart();

          if (editor.getElementByKey(nextListItem.__key) != null) {
            event.preventDefault();
            nextItemKey = nextListItem.__key;
          }
        }
      },
      {
        // The focus has to land after the reconciler has moved the selection
        // onto the next item, which is what onUpdate is for. The element is
        // resolved from the key here rather than captured above, so a
        // reconciliation that replaced it is followed to the current one.
        onUpdate: () => {
          const dom =
            nextItemKey === null ? null : editor.getElementByKey(nextItemKey);

          if (dom != null) {
            dom.focus();
          }
        },
      },
    );
  }

  return false;
}
