/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from './LexicalEditor';
import type {EditorState} from './LexicalEditorState';
import type {LexicalPrivateDOM} from './LexicalNode';
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
  $getNodeFromDOMNode,
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

function updateTimeStamp(event: Event) {
  lastTextEntryTimeStamp = event.timeStamp;
}

function initTextEntryListener(editor: LexicalEditor): void {
  if (lastTextEntryTimeStamp === 0) {
    getWindow(editor).addEventListener('textInput', updateTimeStamp, true);
  }
}

function isManagedLineBreak(
  dom: Node,
  target: Node & LexicalPrivateDOM,
  editor: LexicalEditor,
): boolean {
  const isBR = dom.nodeName === 'BR';
  const lexicalLineBreak = target.__lexicalLineBreak;
  return (
    (lexicalLineBreak &&
      (dom === lexicalLineBreak ||
        (isBR && dom.previousSibling === lexicalLineBreak))) ||
    (isBR && getNodeKeyFromDOMNode(dom, editor) !== undefined)
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
): void {
  isProcessingMutations = true;
  const shouldFlushTextMutations =
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

      for (let i = 0; i < mutations.length; i++) {
        const mutation = mutations[i];
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
          // Text mutations are deferred and passed to mutation listeners to be
          // processed outside of the Lexical engine.
          if (
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
        } else if (type === 'childList') {
          shouldRevertSelection = true;
          // We attempt to "undo" any changes that have occurred outside
          // of Lexical. We want Lexical's editor state to be source of truth.
          // To the user, these will look like no-ops.
          const addedDOMs = mutation.addedNodes;

          for (let s = 0; s < addedDOMs.length; s++) {
            const addedDOM = addedDOMs[s];
            const node = $getNodeFromDOMNode(addedDOM);
            const parentDOM = addedDOM.parentNode;

            if (
              parentDOM != null &&
              addedDOM !== blockCursorElement &&
              node === null &&
              !isManagedLineBreak(addedDOM, parentDOM, editor) &&
              // The zero-size selection anchors the reconciler parks outside
              // a leading / trailing block decorator (#8922) are keyless
              // scaffolding, like the managed line break — don't evict them
              // as foreign DOM.
              !isDecoratorBoundaryAnchorDOM(addedDOM) &&
              // @experimental named-slots. Slot containers are keyless
              // reconciler scaffolding: a flush that observes one being
              // parked in its host or relocated by an explicit mount must
              // not evict it as foreign DOM. Gated on the editor slot latch so
              // a non-slot editor still evicts foreign DOM that happens to
              // carry a `data-lexical-slot` attribute.
              !(
                editor._slotsUsed &&
                isHTMLElement(addedDOM) &&
                addedDOM.hasAttribute('data-lexical-slot')
              ) &&
              // Skip externally-added DOM that's explicitly opted out of
              // mutation tracking (e.g. an extension-rendered decoration
              // inside a TextNode's span, like the autocomplete ghost).
              !isDOMUnmanaged(addedDOM)
            ) {
              if (IS_FIREFOX) {
                const possibleText =
                  (isHTMLElement(addedDOM) ? addedDOM.innerText : null) ||
                  addedDOM.nodeValue;

                if (possibleText) {
                  possibleTextForFirefoxPaste += possibleText;
                }
              }

              parentDOM.removeChild(addedDOM);
            }
          }

          const removedDOMs = mutation.removedNodes;
          const removedDOMsLength = removedDOMs.length;

          if (removedDOMsLength > 0) {
            let unremovedBRs = 0;

            for (let s = 0; s < removedDOMsLength; s++) {
              const removedDOM = removedDOMs[s];

              if (
                isManagedLineBreak(removedDOM, targetDOM, editor) ||
                blockCursorElement === removedDOM
              ) {
                targetDOM.appendChild(removedDOM);
                unremovedBRs++;
              } else if (isDecoratorBoundaryAnchorDOM(removedDOM)) {
                // Position matters for these (leading vs trailing), so don't
                // blindly re-append — the next reconcile of this element puts
                // a fresh anchor on the right edge.
                unremovedBRs++;
              }
            }

            if (removedDOMsLength !== unremovedBRs) {
              badDOMTargets.set(nodeDOM, targetNode);
            }
          }
        }
      }

      // Now we process each of the unique target nodes, attempting
      // to restore their contents back to the source of truth, which
      // is Lexical's "current" editor state. This is basically like
      // an internal revert on the DOM.
      if (badDOMTargets.size > 0) {
        for (const [nodeDOM, targetNode] of badDOMTargets) {
          targetNode.reconcileObservedMutation(nodeDOM, editor);
        }
      }

      // Capture all the mutations made during this function. This
      // also prevents us having to process them on the next cycle
      // of onMutation, as these mutations were made by us.
      const records = observer.takeRecords();

      // Check for any random auto-added <br> elements, and remove them.
      // These get added by the browser when we undo the above mutations
      // and this can lead to a broken UI.
      if (records.length > 0) {
        for (let i = 0; i < records.length; i++) {
          const record = records[i];
          const addedNodes = record.addedNodes;
          const target = record.target;

          for (let s = 0; s < addedNodes.length; s++) {
            const addedDOM = addedNodes[s];
            const parentDOM = addedDOM.parentNode;

            if (
              parentDOM != null &&
              addedDOM.nodeName === 'BR' &&
              !isManagedLineBreak(addedDOM, target, editor)
            ) {
              parentDOM.removeChild(addedDOM);
            }
          }
        }

        // Clear any of those removal mutations
        observer.takeRecords();
      }

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

export function flushRootMutations(editor: LexicalEditor): void {
  const observer = editor._observer;

  if (observer !== null) {
    const mutations = observer.takeRecords();
    flushMutations(editor, mutations, observer);
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
