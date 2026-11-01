/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from './LexicalEditor';
import type {EditorState} from './LexicalEditorState';
import type {BaseSelection} from './LexicalSelection';

import {
  $getSelection,
  $isDecoratorNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type LexicalNode,
  type TextNode,
} from '.';
import {IS_FIREFOX} from './environment';
import {isDecoratorBoundaryAnchorDOM} from './LexicalDOMSlot';
import {updateEditorSync} from './LexicalUpdates';
import {
  $getNodeByKey,
  $updateTextNodeFromDOMContent,
  getDOMSelection,
  getDOMSelectionPoints,
  getNodeKeyFromDOMNode,
  getParentElement,
  getWindow,
  isDOMTextNode,
  isDOMUnmanaged,
  isFirefoxClipboardEvents,
  isHTMLElement,
} from './LexicalUtils';
// The time between a text entry event and the mutation observer firing.
const TEXT_MUTATION_VARIANCE = 100;

let isProcessingMutations = false;
let lastTextEntryTimeStamp = 0;

export function getIsProcessingMutations(): boolean {
  return isProcessingMutations;
}

function updateTimeStamp() {
  lastTextEntryTimeStamp = performance.now();
}

function initTextEntryListener(editor: LexicalEditor): void {
  getWindow(editor).addEventListener('textInput', updateTimeStamp, true);
}

// A node of an element's managed line break (ElementDOMSlot).
function isManagedLineBreakDOM(dom: Node): boolean {
  return (
    isHTMLElement(dom) && dom.hasAttribute('data-lexical-managed-linebreak')
  );
}

function getLastSelection(editor: LexicalEditor): null | BaseSelection {
  return editor.read('latest', () => {
    const selection = $getSelection();
    return selection !== null ? selection.clone() : null;
  });
}

function $handleTextMutation(
  target: Text,
  node: TextNode,
  editor: LexicalEditor,
): void {
  const domSelection = getDOMSelection(getWindow(editor));
  const domSelectionPoints =
    domSelection && getDOMSelectionPoints(domSelection, editor._rootElement);
  let anchorOffset = null;
  let focusOffset = null;

  if (domSelectionPoints !== null && domSelectionPoints.anchorNode === target) {
    anchorOffset = domSelectionPoints.anchorOffset;
    focusOffset = domSelectionPoints.focusOffset;
  }

  const text = target.nodeValue;
  if (text !== null) {
    $updateTextNodeFromDOMContent(node, text, anchorOffset, focusOffset, false);
  }
}

function shouldUpdateTextNodeFromMutation(
  selection: null | BaseSelection,
  targetDOM: Node,
  targetNode: TextNode,
): boolean {
  if ($isRangeSelection(selection)) {
    const anchorNode = selection.anchor.getNode();
    if (
      anchorNode.is(targetNode) &&
      selection.format !== anchorNode.getFormat()
    ) {
      return false;
    }
  }
  return isDOMTextNode(targetDOM) && targetNode.isAttached();
}

function $getNearestManagedNodePairFromDOMNode(
  startingDOM: Node,
  editor: LexicalEditor,
  editorState: EditorState,
): [HTMLElement, LexicalNode] | undefined {
  for (
    let dom: Node | null = startingDOM;
    dom && !isDOMUnmanaged(dom);
    dom = getParentElement(dom)
  ) {
    const key = getNodeKeyFromDOMNode(dom, editor);
    if (key !== undefined) {
      const node = $getNodeByKey(key, editorState);
      if (node) {
        // All decorator nodes are unmanaged
        return $isDecoratorNode(node) || !isHTMLElement(dom)
          ? undefined
          : [dom, node];
      }
    }
  }
}

function flushMutations(
  editor: LexicalEditor,
  mutations: MutationRecord[],
  observer: MutationObserver,
  rerenderText?: boolean,
): void {
  isProcessingMutations = true;
  const shouldFlushTextMutations =
    // Not while the browser makes an insertion the editor left to it: the
    // editor's input listener reads that text, and an input listener that
    // runs before it (React has one above the root) lets this run first,
    // however long after the text entry.
    editor._inputState.unprocessedBeforeInputData === null &&
    performance.now() - lastTextEntryTimeStamp > TEXT_MUTATION_VARIANCE;
  try {
    updateEditorSync(editor, () => {
      const selection = $getSelection() || getLastSelection(editor);
      const badDOMTargets = new Map<HTMLElement, LexicalNode>();
      // We use the current editor state, as that reflects what is
      // actually "on screen".
      const currentEditorState = editor._editorState;
      const blockCursorElement = editor._blockCursorElement;
      let shouldRevertSelection = false;
      let possibleTextForFirefoxPaste = '';

      for (const mutation of mutations) {
        const type = mutation.type;
        const targetDOM = mutation.target;
        const pair = $getNearestManagedNodePairFromDOMNode(
          targetDOM,
          editor,
          currentEditorState,
        );
        if (!pair) {
          continue;
        }
        const [nodeDOM, targetNode] = pair;

        if (type === 'characterData') {
          if (rerenderText) {
            // The editor applied this input itself, so the text the browser
            // also changed is rendered again from the editor state.
            if ($isTextNode(targetNode) && targetNode.isAttached()) {
              targetNode.markDirty();
            }
          } else if (
            // Text mutations are deferred and passed to mutation listeners to
            // be processed outside of the Lexical engine.
            // TODO there is an edge case here if a mutation happens too quickly
            //      after text input, it may never be handled since we do not
            //      track the ignored mutations in any way
            shouldFlushTextMutations &&
            $isTextNode(targetNode) &&
            isDOMTextNode(targetDOM) &&
            shouldUpdateTextNodeFromMutation(selection, targetDOM, targetNode)
          ) {
            $handleTextMutation(targetDOM, targetNode, editor);
          }
        } else {
          // childList, the only other type the observer records
          shouldRevertSelection = true;
          // We attempt to "undo" any changes that have occurred outside
          // of Lexical. We want Lexical's editor state to be source of truth.
          // To the user, these will look like no-ops.
          for (const addedDOM of mutation.addedNodes) {
            const key = getNodeKeyFromDOMNode(addedDOM, editor);

            if (
              addedDOM !== blockCursorElement &&
              // Not when it has moved on: scaffolding is put back below.
              addedDOM.parentNode === targetDOM &&
              // Keyed DOM stays only when it is the DOM its node renders
              // to: a stale copy (of a removed node, or from before a node
              // was rendered anew) is evicted like foreign DOM. So is a node
              // of a managed line break: an edit that moved one took it from
              // an element that reconcileObservedMutation puts back together.
              // The reconciler adds a decorator boundary anchor (#8922) only
              // while nothing observes, so one added here was moved or copied
              // by something else and is evicted too.
              (key
                ? editor.getElementByKey(key) !== addedDOM
                : // @experimental named-slots. Slot containers are keyless
                  // reconciler scaffolding: a flush that observes one being
                  // parked in its host or relocated by an explicit mount must
                  // not evict it as foreign DOM. Gated on the editor slot
                  // latch so a non-slot editor still evicts foreign DOM that
                  // happens to carry a `data-lexical-slot` attribute.
                  !(
                    editor._slotsUsed &&
                    isHTMLElement(addedDOM) &&
                    addedDOM.hasAttribute('data-lexical-slot')
                  ) &&
                  // Skip externally-added DOM that's explicitly opted out of
                  // mutation tracking (e.g. an extension-rendered decoration
                  // inside a TextNode's span, like the autocomplete ghost).
                  !isDOMUnmanaged(addedDOM))
            ) {
              if (IS_FIREFOX) {
                const possibleText =
                  (isHTMLElement(addedDOM) ? addedDOM.innerText : null) ||
                  addedDOM.nodeValue;

                if (possibleText) {
                  possibleTextForFirefoxPaste += possibleText;
                }
              }

              targetDOM.removeChild(addedDOM);
            }
          }

          for (const removedDOM of mutation.removedNodes) {
            const isBlockCursor = blockCursorElement === removedDOM;
            if (
              isBlockCursor ||
              isDecoratorBoundaryAnchorDOM(removedDOM) ||
              isManagedLineBreakDOM(removedDOM)
            ) {
              // Back in its place, wherever the edit put it, which matters for
              // the scaffolding and for DOM an extension keeps beside the
              // line break: after its previous sibling when a later record
              // took the next one.
              const next = mutation.nextSibling;
              const prev = mutation.previousSibling;
              targetDOM.insertBefore(
                removedDOM,
                !next || next.parentNode === targetDOM
                  ? next
                  : !prev
                    ? targetDOM.firstChild
                    : prev.parentNode === targetDOM
                      ? prev.nextSibling
                      : null,
              );
            }
            if (!isBlockCursor) {
              // A removed child is put back, and a line break that is no
              // longer whole or a decorator boundary anchor that is gone (a
              // later record evicts one the edit moved within its element) is
              // rebuilt, by reconcileObservedMutation once every record has
              // been seen, since a later record can still move what it would
              // sit next to.
              badDOMTargets.set(nodeDOM, targetNode);
            }
          }
        }
      }

      // Now we process each of the unique target nodes, attempting
      // to restore their contents back to the source of truth, which
      // is Lexical's "current" editor state. This is basically like
      // an internal revert on the DOM.
      for (const [nodeDOM, targetNode] of badDOMTargets) {
        targetNode.reconcileObservedMutation(nodeDOM, editor);
      }

      // Capture all the mutations made during this function. This
      // also prevents us having to process them on the next cycle
      // of onMutation, as these mutations were made by us.
      const records = observer.takeRecords();

      // Check for any random auto-added <br> elements, and remove them.
      // These get added by the browser when we undo the above mutations
      // and this can lead to a broken UI.
      for (const record of records) {
        for (const addedDOM of record.addedNodes) {
          // Keep the line breaks the revert put back: a LineBreakNode's
          // and the managed one.
          if (
            addedDOM.nodeName === 'BR' &&
            !getNodeKeyFromDOMNode(addedDOM, editor) &&
            !isManagedLineBreakDOM(addedDOM)
          ) {
            (addedDOM as Element).remove();
          }
        }
      }

      // Clear any of those removal mutations
      observer.takeRecords();

      if (selection !== null) {
        if (shouldRevertSelection) {
          $setSelection(selection);
        }

        if (IS_FIREFOX && isFirefoxClipboardEvents(editor)) {
          selection.insertRawText(possibleTextForFirefoxPaste);
        }
      }
    });
  } finally {
    isProcessingMutations = false;
  }
}

/**
 * Revert the DOM changes the observer has recorded but not reported yet.
 * With `ifRecorded` nothing runs when there are none, for a commit that is
 * about to disconnect the observer, which drops them: a change made inside an
 * update, or in the same task as an update whose commit was queued first.
 */
export function flushRootMutations(
  editor: LexicalEditor,
  rerenderText?: boolean,
  ifRecorded?: boolean,
): void {
  const observer = editor._observer;

  if (observer !== null) {
    const mutations = observer.takeRecords();
    if (!ifRecorded || mutations.length > 0) {
      flushMutations(editor, mutations, observer, rerenderText);
    }
  }
}

export function initMutationObserver(editor: LexicalEditor): void {
  initTextEntryListener(editor);
  editor._observer = new MutationObserver(
    (mutations: MutationRecord[], observer: MutationObserver) => {
      flushMutations(editor, mutations, observer);
    },
  );
}
