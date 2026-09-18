/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/// <reference types="trusted-types" />

import {getPeerDependencyFromEditor} from '@lexical/extension';
import {$generateHtmlFromNodes} from '@lexical/html';
import invariant from '@lexical/internal/invariant';
import {$sliceSelectedTextNodeContent} from '@lexical/selection';
import {objectKlassEquals} from '@lexical/utils';
import {
  $caretFromPoint,
  $caretRangeFromSelection,
  $comparePointCaretNext,
  $getCaretRange,
  $getCaretRangeInDirection,
  $getChildCaret,
  $getChildCaretAtIndex,
  $getCollapsedCaretRange,
  $getEditor,
  $getNearestNodeFromDOMNode,
  $getRoot,
  $getSelection,
  $getSelectionSlotFrame,
  $getSlot,
  $getSlotNames,
  $getTextPointCaret,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $isTextPointCaret,
  $parseSerializedNode,
  $setSelectionFromCaretRange,
  $splitAtPointCaretNext,
  type BaseSelection,
  COMMAND_PRIORITY_CRITICAL,
  COPY_COMMAND,
  defineExtension,
  findAllLexicalElementsDeep,
  getDOMSelection,
  getDOMSelectionPoints,
  getEditorPropertyFromDOMNode,
  isHTMLElement,
  isLexicalEditor,
  isSelectionWithinEditor,
  type LexicalEditor,
  type LexicalNode,
  type PointCaret,
  type RangeSelection,
  safeCast,
  SELECTION_INSERT_CLIPBOARD_NODES_COMMAND,
  type SerializedElementNode,
  shallowMergeConfig,
} from 'lexical';

import {caretFromPoint} from './caretFromPoint';
import {$getImportOutput} from './ClipboardImportExtension';

export interface LexicalClipboardData {
  'text/html'?: string | undefined;
  'application/x-lexical-editor'?: string | undefined;
  'text/plain': string;
  [mimeType: string & {}]: string | undefined;
}

/**
 * Returns the *currently selected* Lexical content as an HTML string, relying on the
 * logic defined in the exportDOM methods on the LexicalNode classes. Note that
 * this will not return the HTML content of the entire editor (unless all the content is included
 * in the current selection).
 *
 * @param editor - LexicalEditor instance to get HTML content from
 * @param selection - The selection to use (default is $getSelection())
 * @returns a string of HTML content
 */
export function $getHtmlContent(
  editor: LexicalEditor,
  selection = $getSelection(),
): string {
  if (selection == null) {
    invariant(false, 'Expected valid LexicalSelection');
  }

  // If we haven't selected anything
  if (
    ($isRangeSelection(selection) && selection.isCollapsed()) ||
    selection.getNodes().length === 0
  ) {
    return '';
  }

  return $generateHtmlFromNodes(editor, selection);
}

/**
 * Returns the *currently selected* Lexical content as a JSON string, relying on the
 * logic defined in the exportJSON methods on the LexicalNode classes. Note that
 * this will not return the JSON content of the entire editor (unless all the content is included
 * in the current selection).
 *
 * @param editor  - LexicalEditor instance to get the JSON content from
 * @param selection - The selection to use (default is $getSelection())
 * @returns
 */
export function $getLexicalContent(
  editor: LexicalEditor,
  selection = $getSelection(),
): null | string {
  if (selection == null) {
    invariant(false, 'Expected valid LexicalSelection');
  }

  // If we haven't selected anything
  if (
    ($isRangeSelection(selection) && selection.isCollapsed()) ||
    selection.getNodes().length === 0
  ) {
    return null;
  }

  return JSON.stringify($generateJSONFromSelectedNodes(editor, selection));
}

/**
 * Attempts to insert content of the mime-types text/plain or text/uri-list from
 * the provided DataTransfer object into the editor at the provided selection.
 * text/uri-list is only used if text/plain is not also provided.
 *
 * @param dataTransfer an object conforming to the [DataTransfer interface] (https://html.spec.whatwg.org/multipage/dnd.html#the-datatransfer-interface)
 * @param selection the selection to use as the insertion point for the content in the DataTransfer object
 */
export function $insertDataTransferForPlainText(
  dataTransfer: DataTransfer,
  selection: BaseSelection,
): void {
  const text =
    dataTransfer.getData('text/plain') || dataTransfer.getData('text/uri-list');

  if (text != null) {
    selection.insertRawText(text);
  }
}

/**
 * Insert the contents of `dataTransfer` at `selection` using the rich-text
 * import pipeline (`application/x-lexical-editor` → `text/html` → `text/plain`
 * → `text/uri-list`, in descending order of priority).
 *
 * Every payload type leaves the editor's selection after the inserted content,
 * so `selection` must be a live selection this update may write to — the one
 * from `$getSelection()`, or one built with `$createRangeSelection()`. Passing
 * a selection read out of an already-committed EditorState is not supported and
 * raises an invariant in development builds.
 *
 * @param dataTransfer an object conforming to the [DataTransfer interface] (https://html.spec.whatwg.org/multipage/dnd.html#the-datatransfer-interface)
 * @param selection the selection to use as the insertion point for the content in the DataTransfer object
 * @param _editor unused; retained for backwards compatibility. Safe to
 *   omit on new call sites.
 */
export function $insertDataTransferForRichText(
  dataTransfer: DataTransfer,
  selection: BaseSelection,
  _editor?: LexicalEditor,
): void {
  $getImportOutput().$insertDataTransfer(dataTransfer, selection);
}

const LEXICAL_DRAG_MIME_TYPE = 'application/x-lexical-drag';

interface LexicalDragMarker {
  editorKey: string;
}

/**
 * Populate `dataTransfer` with a marker identifying the current editor as a
 * drag source. Pair this with {@link $handleRichTextDrop} or
 * {@link $handlePlainTextDrop} on the drop side to get cut-and-paste semantics
 * for drags that end in a different editor.
 *
 * Only the source editor's key needs to round-trip — the source's
 * RangeSelection itself is preserved on the source editor between drag start
 * and drop (Lexical suppresses selectionchange during drag), so the drop
 * handler reads it directly via `$getSelection()` on the resolved source
 * editor.
 *
 * Callers typically invoke this from a DRAGSTART_COMMAND handler alongside
 * {@link setLexicalClipboardDataTransfer} (so that the dragged content itself
 * round-trips with full node fidelity).
 */
export function $writeDragSourceToDataTransfer(
  dataTransfer: DataTransfer,
  editor: LexicalEditor,
): void {
  const marker: LexicalDragMarker = {editorKey: editor.getKey()};
  dataTransfer.setData(LEXICAL_DRAG_MIME_TYPE, JSON.stringify(marker));
}

function isLexicalDragMarker(value: unknown): value is LexicalDragMarker {
  return (
    value !== null &&
    typeof value === 'object' &&
    'editorKey' in value &&
    typeof (value as {editorKey: unknown}).editorKey === 'string'
  );
}

function readDragMarker(dataTransfer: DataTransfer): LexicalDragMarker | null {
  const raw = dataTransfer.getData(LEXICAL_DRAG_MIME_TYPE);
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isLexicalDragMarker(parsed) ? parsed : null;
}

function findEditorRootByKey(key: string, doc: Document): HTMLElement | null {
  for (const el of findAllLexicalElementsDeep(doc)) {
    const editor = getEditorPropertyFromDOMNode(el);
    if (
      isLexicalEditor(editor) &&
      editor.getKey() === key &&
      isHTMLElement(el)
    ) {
      return el;
    }
  }
  return null;
}

function $resolveDropPointCaret(
  event: DragEvent,
  editor: LexicalEditor,
): null | PointCaret<'next'> {
  const hit = caretFromPoint(
    event.clientX,
    event.clientY,
    editor.getRootElement(),
  );
  if (hit === null) {
    return null;
  }
  const node = $getNearestNodeFromDOMNode(hit.node);
  if (node === null) {
    return null;
  }
  if ($isTextNode(node)) {
    return $getTextPointCaret(node, 'next', hit.offset);
  }
  if ($isElementNode(node)) {
    return $getChildCaretAtIndex(node, hit.offset, 'next');
  }
  const parent = node.getParent();
  if (parent === null) {
    return null;
  }
  return $getChildCaretAtIndex(parent, node.getIndexWithinParent() + 1, 'next');
}

function $isDropCaretInsideSelection(
  dropCaret: PointCaret<'next'>,
  selection: RangeSelection,
): boolean {
  const {anchor: start, focus: end} = $getCaretRangeInDirection(
    $caretRangeFromSelection(selection),
    'next',
  );
  return (
    $comparePointCaretNext(start, dropCaret) < 0 &&
    $comparePointCaretNext(dropCaret, end) < 0
  );
}

function $doDrop(
  event: DragEvent,
  editor: LexicalEditor,
  $insertDataTransfer: (
    dataTransfer: DataTransfer,
    selection: BaseSelection,
    targetEditor: LexicalEditor,
  ) => void,
): boolean {
  const dataTransfer = event.dataTransfer;
  if (dataTransfer === null) {
    return false;
  }

  // Drags that didn't originate in a Lexical editor (no marker) fall through
  // to the browser's native drag-and-drop flow; its beforeinput
  // insertFromDrop is already handled correctly by Lexical's existing
  // beforeinput logic.
  const marker = readDragMarker(dataTransfer);
  if (marker === null) {
    return false;
  }

  const dropCaret = $resolveDropPointCaret(event, editor);
  if (dropCaret === null) {
    return false;
  }

  // Split at the drop caret so we have a stable NodeCaret boundary that
  // survives text-content mutations in its siblings.
  const stableDropCaret = $splitAtPointCaretNext(dropCaret);
  if (stableDropCaret === null) {
    return false;
  }

  const isSameEditorDrag = marker.editorKey === editor.getKey();
  const currentSelection = $getSelection();

  if (isSameEditorDrag) {
    // Same-editor drag: the destination's $getSelection() is the still-
    // selected dragged range, so Lexical's beforeinput handler would skip
    // applyDOMRange and route the insert to the source's location instead
    // of the drop point. Remove the dragged range ourselves, then insert
    // at the stable drop caret.
    if (
      !$isRangeSelection(currentSelection) ||
      currentSelection.isCollapsed()
    ) {
      return false;
    }
    if ($isDropCaretInsideSelection(dropCaret, currentSelection)) {
      event.preventDefault();
      return true;
    }
    currentSelection.removeText();
  }

  // If the drop caret's origin was swept away by the source removal, abort —
  // this can happen on a same-editor drag whose range covered the entire
  // text node we tried to split at.
  if (!stableDropCaret.origin.isAttached()) {
    event.preventDefault();
    return true;
  }

  const dropSelection = $setSelectionFromCaretRange(
    $getCollapsedCaretRange(stableDropCaret),
  );
  $insertDataTransfer(dataTransfer, dropSelection, editor);

  if (!isSameEditorDrag) {
    // Cross-editor drag. The native drag-out deletion that the browser
    // would normally fire (beforeinput deleteByDrag on the source) isn't
    // reliable when the source is a nested contenteditable of the
    // destination (e.g. an image caption inside the main editor), so we
    // dispatch it ourselves at the source editor's root. The source
    // editor's own beforeinput handler runs the deletion through its own
    // REMOVE_TEXT_COMMAND and SKIP_SELECTION_FOCUS_TAG path.
    const rootElement = editor.getRootElement();
    const doc = rootElement ? rootElement.ownerDocument : null;
    const sourceRoot = doc ? findEditorRootByKey(marker.editorKey, doc) : null;
    if (sourceRoot !== null) {
      sourceRoot.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'deleteByDrag',
        }),
      );
    }
  }

  event.preventDefault();
  return true;
}

/**
 * Drop handler for rich-text editors. Inserts the DataTransfer payload via
 * {@link $insertDataTransferForRichText} at the drop caret and, when the drag
 * originated from a Lexical editor (marked via
 * {@link $writeDragSourceToDataTransfer} on DRAGSTART), removes the source
 * range — producing cut-and-paste semantics whether the drop is in the same
 * editor or a different one on the same page.
 */
export function $handleRichTextDrop(
  event: DragEvent,
  editor: LexicalEditor,
): boolean {
  return $doDrop(event, editor, $insertDataTransferForRichText);
}

/**
 * Drop handler for plain-text editors. Same semantics as
 * {@link $handleRichTextDrop} but inserts via
 * {@link $insertDataTransferForPlainText}.
 */
export function $handlePlainTextDrop(
  event: DragEvent,
  editor: LexicalEditor,
): boolean {
  return $doDrop(event, editor, (dataTransfer, selection) =>
    $insertDataTransferForPlainText(dataTransfer, selection),
  );
}

/**
 * Inserts Lexical nodes into the editor using different strategies depending on
 * some simple selection-based heuristics. If you're looking for a generic way to
 * to insert nodes into the editor at a specific selection point, you probably want
 * {@link lexical.$insertNodes}
 *
 * @param editor LexicalEditor instance to insert the nodes into.
 * @param nodes The nodes to insert.
 * @param selection The selection to insert the nodes into.
 */
export function $insertGeneratedNodes(
  editor: LexicalEditor,
  nodes: LexicalNode[],
  selection: BaseSelection,
): void {
  if (
    !editor.dispatchCommand(SELECTION_INSERT_CLIPBOARD_NODES_COMMAND, {
      nodes,
      selection,
    })
  ) {
    selection.insertNodes(nodes);
    $updateSelectionOnInsert(selection);
  }
  return;
}

function $updateSelectionOnInsert(selection: BaseSelection): void {
  if ($isRangeSelection(selection) && selection.isCollapsed()) {
    const anchor = selection.anchor;
    let nodeToInspect: LexicalNode | null = null;

    const anchorCaret = $caretFromPoint(anchor, 'previous');
    if (anchorCaret) {
      if ($isTextPointCaret(anchorCaret)) {
        nodeToInspect = anchorCaret.origin;
      } else {
        const range = $getCaretRange(
          anchorCaret,
          $getChildCaret($getRoot(), 'next').getFlipped(),
        );
        for (const caret of range) {
          if ($isTextNode(caret.origin)) {
            nodeToInspect = caret.origin;
            break;
          } else if ($isElementNode(caret.origin) && !caret.origin.isInline()) {
            break;
          }
        }
      }
    }

    if (nodeToInspect && $isTextNode(nodeToInspect)) {
      const newFormat = nodeToInspect.getFormat();
      const newStyle = nodeToInspect.getStyle();

      if (selection.format !== newFormat || selection.style !== newStyle) {
        selection.format = newFormat;
        selection.style = newStyle;
        selection.dirty = true;
      }
    }
  }
}

export interface BaseSerializedNode {
  children?: BaseSerializedNode[];
  /**
   * Named slot subtrees keyed by slot name; present on serialized hosts.
   * Mirrors {@link SerializedLexicalNode.$slots}.
   * @experimental named-slots
   */
  $slots?: Record<string, BaseSerializedNode>;
  type: string;
  version: number;
}

function exportNodeToJSON<T extends LexicalNode>(node: T): BaseSerializedNode {
  const serializedNode = node.exportJSON();
  const nodeClass = node.constructor;

  if (serializedNode.type !== nodeClass.getType()) {
    invariant(
      false,
      'LexicalNode: Node %s does not implement .exportJSON().',
      nodeClass.name,
    );
  }

  if ($isElementNode(node)) {
    const serializedChildren = (serializedNode as SerializedElementNode)
      .children;
    if (!Array.isArray(serializedChildren)) {
      invariant(
        false,
        'LexicalNode: Node %s is an element but .exportJSON() does not have a children array.',
        nodeClass.name,
      );
    }
  }

  return serializedNode;
}

function $appendNodesToJSON(
  editor: LexicalEditor,
  selection: BaseSelection | null,
  currentNode: LexicalNode,
  targetArray: BaseSerializedNode[] = [],
): boolean {
  let shouldInclude =
    selection !== null ? currentNode.isSelected(selection) : true;
  // 'clone', not 'html': this builds the internal
  // `application/x-lexical-editor` payload, the same destination the
  // $sliceSelectedTextNodeContent and extractWithChild calls below already
  // pass. Asking with 'html' dropped nodes that opt out of HTML export while
  // asking to survive a clone (e.g. MarkNode).
  const shouldExclude =
    $isElementNode(currentNode) && currentNode.excludeFromCopy('clone');
  let target = currentNode;

  if (selection !== null && $isTextNode(target)) {
    target = $sliceSelectedTextNodeContent(selection, target, 'clone');
  }
  const children = $isElementNode(target) ? target.getChildren() : [];

  const serializedNode = exportNodeToJSON(target);
  if ($isTextNode(target) && target.getTextContentSize() === 0) {
    // If an uncollapsed selection ends or starts at the end of a line of specialized,
    // TextNodes, such as code tokens, we will get a 'blank' TextNode here, i.e., one
    // with text of length 0. We don't want this, it makes a confusing mess. Reset!
    shouldInclude = false;
  }

  // An element host in a NodeSelection (e.g. a Card promoted whole-host by a
  // chrome click) recurses into its children with a null selection so the
  // whole subtree serializes even when none of the children are in the outer
  // selection themselves — the old shell-only output made cut silently lossy.
  // Only a whole-host NodeSelection promotes: a partial RangeSelection that
  // happens to contain the host must keep slicing/excluding per child, or a
  // drag into the host's interior would over-export unselected content.
  const childSelection =
    shouldInclude && $isNodeSelection(selection) && $isElementNode(currentNode)
      ? null
      : selection;

  for (let i = 0; i < children.length; i++) {
    const childNode = children[i];
    const shouldIncludeChild = $appendNodesToJSON(
      editor,
      childSelection,
      childNode,
      serializedNode.children,
    );

    if (
      !shouldInclude &&
      $isElementNode(currentNode) &&
      shouldIncludeChild &&
      currentNode.extractWithChild(childNode, selection, 'clone')
    ) {
      shouldInclude = true;
    }
  }

  // Slots are shadow-root isolated, so they can't be partially selected by a
  // RangeSelection — when the host is included, each slot subtree is copied
  // whole. Pass a null selection to deep-export the slot regardless of the
  // outer selection, mirroring the EditorState slot serialization. Gate on the
  // same condition as the push below (and as the HTML exporter): only emit
  // slots for a host that is itself emitted, so a host outside the selection
  // is never walked — its slots must not influence (or break) this export.
  if (shouldInclude && !shouldExclude) {
    const slotNames = $getSlotNames(target);
    if (slotNames.length > 0) {
      const serializedSlots: Record<string, BaseSerializedNode> = {};
      for (const name of slotNames) {
        const slotNode = $getSlot(target, name);
        invariant(
          slotNode !== null,
          'LexicalNode: Node %s has slot "%s" but it resolved to no node during export.',
          target.constructor.name,
          name,
        );
        const slotArray: BaseSerializedNode[] = [];
        $appendNodesToJSON(editor, null, slotNode, slotArray);
        // A whole-slot export must serialize to exactly the slot node. A slot
        // value that overrides excludeFromCopy would otherwise make
        // $appendNodesToJSON splice up its children (or emit nothing), leaving
        // a dangling/undefined slot entry that breaks on paste.
        invariant(
          slotArray.length === 1 && slotArray[0].type === slotNode.getType(),
          'LexicalNode: slot "%s" on %s did not serialize to exactly the slot value node (got %s of type %s); a slot value must not be excluded from copy.',
          name,
          target.constructor.name,
          String(slotArray.length),
          String(slotArray.length > 0 ? slotArray[0].type : 'none'),
        );
        serializedSlots[name] = slotArray[0];
      }
      (
        serializedNode as BaseSerializedNode & {
          $slots?: Record<string, BaseSerializedNode>;
        }
      ).$slots = serializedSlots;
    }
  }

  if (shouldInclude && !shouldExclude) {
    targetArray.push(serializedNode);
  } else if (Array.isArray(serializedNode.children)) {
    for (let i = 0; i < serializedNode.children.length; i++) {
      const serializedChildNode = serializedNode.children[i];
      targetArray.push(serializedChildNode);
    }
  }

  return shouldInclude;
}

// TODO why $ function with Editor instance?
/**
 * Gets the Lexical JSON of the nodes inside the provided Selection.
 *
 * @param editor LexicalEditor to get the JSON content from.
 * @param selection Selection to get the JSON content from.
 * @returns an object with the editor namespace and a list of serializable nodes as JavaScript objects.
 */
export function $generateJSONFromSelectedNodes<
  SerializedNode extends BaseSerializedNode,
>(
  editor: LexicalEditor,
  selection: BaseSelection | null,
): {
  namespace: string;
  nodes: SerializedNode[];
} {
  const nodes: SerializedNode[] = [];
  const root = $getRoot();
  // A selection wholly inside a slot subtree never includes its host (slots
  // are shadow-root isolated), so a root-children walk would miss the
  // selected nodes entirely and export an empty payload (cut = data loss).
  // Walk the selection's slot frame instead; outside slots this is the root.
  // $generateDOMFromNodes in @lexical/html redirects the text/html channel
  // through the same frame, so the two clipboard payloads stay in agreement.
  const slotFrame = $getSelectionSlotFrame(selection);
  const topLevelChildren = (
    $isElementNode(slotFrame) ? slotFrame : root
  ).getChildren();
  for (let i = 0; i < topLevelChildren.length; i++) {
    const topLevelNode = topLevelChildren[i];
    $appendNodesToJSON(editor, selection, topLevelNode, nodes);
  }
  return {
    namespace: editor._config.namespace,
    nodes,
  };
}

/**
 * This method takes an array of objects conforming to the BaseSerializedNode interface and returns
 * an Array containing instances of the corresponding LexicalNode classes registered on the editor.
 * Normally, you'd get an Array of BaseSerialized nodes from {@link $generateJSONFromSelectedNodes}
 *
 * @param serializedNodes an Array of objects conforming to the BaseSerializedNode interface.
 * @returns an Array of Lexical Node objects.
 */
export function $generateNodesFromSerializedNodes(
  serializedNodes: BaseSerializedNode[],
): LexicalNode[] {
  const nodes = [];
  for (const serializedNode of serializedNodes) {
    nodes.push($parseSerializedNode(serializedNode));
  }
  return nodes;
}

const EVENT_LATENCY = 50;
let clipboardEventTimeout: null | number = null;

// TODO custom selection
// TODO potentially have a node customizable version for plain text
/**
 * Copies the content of the current selection to the clipboard in
 * text/plain, text/html, and application/x-lexical-editor (Lexical JSON)
 * formats.
 *
 * @param editor the LexicalEditor instance to copy content from
 * @param event the native browser ClipboardEvent to add the content to.
 * @returns
 */
export async function copyToClipboard(
  editor: LexicalEditor,
  event: null | ClipboardEvent,
  data?: LexicalClipboardData,
): Promise<boolean> {
  if (clipboardEventTimeout !== null) {
    // Prevent weird race conditions that can happen when this function is run multiple times
    // synchronously. In the future, we can do better, we can cancel/override the previously running job.
    return false;
  }
  if (event !== null) {
    return new Promise((resolve, reject) => {
      editor.update(() => {
        resolve($copyToClipboardEvent(editor, event, data));
      });
    });
  }

  const rootElement = editor.getRootElement();
  const editorWindow = editor._window || window;
  const windowDocument = editorWindow.document;
  const domSelection = getDOMSelection(editorWindow);
  if (rootElement === null || domSelection === null) {
    return false;
  }
  const element = windowDocument.createElement('span');
  element.style.position = 'fixed';
  element.style.top = '-1000px';
  element.append(windowDocument.createTextNode('#'));
  rootElement.append(element);
  const range = windowDocument.createRange();
  range.setStart(element, 0);
  range.setEnd(element, 1);
  domSelection.removeAllRanges();
  domSelection.addRange(range);
  return new Promise((resolve, reject) => {
    const removeListener = editor.registerCommand(
      COPY_COMMAND,
      secondEvent => {
        if (objectKlassEquals(secondEvent, ClipboardEvent)) {
          removeListener();
          if (clipboardEventTimeout !== null) {
            editorWindow.clearTimeout(clipboardEventTimeout);
            clipboardEventTimeout = null;
          }
          resolve($copyToClipboardEvent(editor, secondEvent, data));
        }
        // Block the entire copy flow while we wait for the next ClipboardEvent
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
    // If the above hack execCommand hack works, this timeout code should never fire. Otherwise,
    // the listener will be quickly freed so that the user can reuse it again
    clipboardEventTimeout = editorWindow.setTimeout(() => {
      removeListener();
      clipboardEventTimeout = null;
      resolve(false);
    }, EVENT_LATENCY);
    windowDocument.execCommand('copy');
    element.remove();
  });
}

// TODO shouldn't pass editor (pass namespace directly)
function $copyToClipboardEvent(
  editor: LexicalEditor,
  event: ClipboardEvent,
  data?: LexicalClipboardData,
): boolean {
  if (data === undefined) {
    const domSelection = getDOMSelection(editor._window);
    const selection = $getSelection();

    if (!selection || selection.isCollapsed()) {
      return false;
    }

    if (!domSelection) {
      return false;
    }
    const points = getDOMSelectionPoints(domSelection, editor.getRootElement());
    const anchorDOM = points.anchorNode;
    const focusDOM = points.focusNode;
    if (
      anchorDOM !== null &&
      focusDOM !== null &&
      !isSelectionWithinEditor(editor, anchorDOM, focusDOM)
    ) {
      return false;
    }

    data = $getClipboardDataFromSelection(selection);
  }
  event.preventDefault();
  const clipboardData = event.clipboardData;
  if (clipboardData === null) {
    return false;
  }
  setLexicalClipboardDataTransfer(clipboardData, data);
  return true;
}

const clipboardDataFunctions = [
  ['text/html', $getHtmlContent],
  ['application/x-lexical-editor', $getLexicalContent],
] as const;

/**
 * Serialize the content of the current selection to strings in
 * text/plain, text/html, and application/x-lexical-editor (Lexical JSON)
 * formats (as available).
 *
 * @param selection the selection to serialize (defaults to $getSelection())
 * @returns LexicalClipboardData
 */
export function $getClipboardDataFromSelection(
  selection: BaseSelection | null = $getSelection(),
): LexicalClipboardData {
  return $getClipboardDataWithConfigFromSelection(
    $getExportConfig(),
    selection,
  );
}

/**
 * Call setData on the given clipboardData for each MIME type present
 * in the given data (from {@link $getClipboardDataFromSelection})
 *
 * @param clipboardData the event.clipboardData to populate from data
 * @param data The lexical data
 */
export function setLexicalClipboardDataTransfer(
  clipboardData: DataTransfer,
  data: LexicalClipboardData,
) {
  for (const [k] of clipboardDataFunctions) {
    if (data[k] === undefined) {
      clipboardData.setData(k, '');
    }
  }
  for (const k in data) {
    const v = data[k as keyof LexicalClipboardData];
    if (v !== undefined) {
      clipboardData.setData(k, v);
    }
  }
}

/**
 * A function that produces the serialized representation of a selection for
 * a single MIME type. Functions are arranged in a stack per MIME type (see
 * {@link ExportMimeTypeConfig}); the function at the top of the stack is
 * invoked first and may call `next()` to delegate to the previous function
 * in the stack (typically the default Lexical serializer).
 *
 * Returning `null` from the top-most function omits that MIME type from the
 * resulting {@link LexicalClipboardData}.
 *
 * @param selection - The selection to serialize, or `null` if there is none.
 * @param next - Calls the previous handler in the stack and returns its
 *   result, or `null` if there is no previous handler.
 * @returns The serialized string for this MIME type, or `null` to omit it.
 */
export type ExportMimeTypeFunction = (
  selection: null | BaseSelection,
  next: () => null | string,
) => null | string;

/**
 * Configuration for {@link GetClipboardDataExtension}.
 */
export interface GetClipboardDataConfig {
  /**
   * The per-MIME-type serializer stacks used when copying or dragging the
   * current selection out of the editor. See {@link ExportMimeTypeConfig}.
   *
   * Merged with [...prev, ...override]
   */
  $exportMimeType: ExportMimeTypeConfig;
}

/**
 * A mapping from MIME type to a stack of {@link ExportMimeTypeFunction}.
 *
 * Each entry is an ordered array; the function at the highest index runs
 * first and may call `next()` to fall through to the function below it.
 * The default config provides a single fallback handler for
 * `'application/x-lexical-editor'`, `'text/html'`, and `'text/plain'`.
 *
 * When {@link GetClipboardDataExtension} merges a partial config, new
 * functions are appended to the existing array for each MIME type, so
 * later-registered handlers run before earlier ones (including the
 * defaults) and may delegate to them via `next()`. To register a brand new
 * MIME type, supply a key not present in the default config; arbitrary
 * string keys are accepted in addition to the keys of
 * {@link LexicalClipboardData}.
 */
export type ExportMimeTypeConfig = {
  [K in keyof LexicalClipboardData]?: ExportMimeTypeFunction[];
};

function $getExportConfig(editor = $getEditor()) {
  const dep = getPeerDependencyFromEditor<typeof GetClipboardDataExtension>(
    editor,
    GetClipboardDataExtension.name,
  );
  return dep ? dep.output : DEFAULT_EXPORT_MIME_TYPE;
}

const DEFAULT_EXPORT_MIME_TYPE: ExportMimeTypeConfig = {
  'application/x-lexical-editor': [
    (sel, next) => (sel ? $getLexicalContent($getEditor(), sel) : next()),
  ],
  'text/html': [
    (sel, next) => (sel ? $getHtmlContent($getEditor(), sel) : next()),
  ],
  'text/plain': [(sel, next) => (sel ? sel.getTextContent() : next())],
};

function $getClipboardDataWithConfigFromSelection(
  $exportMimeType: ExportMimeTypeConfig,
  selection: null | BaseSelection,
): LexicalClipboardData {
  const clipboardData: LexicalClipboardData = {'text/plain': ''};
  for (const [k, fns] of Object.entries($exportMimeType)) {
    if (fns) {
      const v = callExportMimeTypeFunctionStack(fns, selection);
      if (v !== null) {
        clipboardData[k] = v;
      }
    }
  }
  return clipboardData;
}

function callExportMimeTypeFunctionStack(
  fns: ExportMimeTypeFunction[],
  selection: null | BaseSelection,
) {
  const callAt = (i: number): string | null =>
    fns[i] ? fns[i](selection, callAt.bind(null, i - 1)) : null;
  return callAt(fns.length - 1);
}

/**
 * Serialize the given selection for a single MIME type using the active
 * editor's configured {@link ExportMimeTypeConfig}. The configured stack is
 * read from {@link GetClipboardDataExtension} via the editor's peer
 * dependency lookup; if the extension was not built into the editor, the
 * default stack is used.
 *
 * Useful when only one MIME representation is needed rather than the full
 * {@link LexicalClipboardData} produced by
 * {@link $getClipboardDataFromSelection}.
 *
 * Must be called from within an editor update or read.
 *
 * @param mimeType - The MIME type to serialize, e.g. `'text/html'`,
 *   `'application/x-lexical-editor'`, `'text/plain'`, or any custom key
 *   registered in the {@link ExportMimeTypeConfig}.
 * @param selection - The selection to serialize (defaults to
 *   `$getSelection()`).
 * @returns The serialized string for the requested MIME type, or `null` if
 *   no handler is registered for it or every handler returned `null`.
 */
export function $exportMimeTypeFromSelection(
  mimeType: keyof ExportMimeTypeConfig,
  selection: null | BaseSelection = $getSelection(),
): string | null {
  return callExportMimeTypeFunctionStack(
    $getExportConfig()[mimeType] || [],
    selection,
  );
}

/**
 * Lexical extension that controls how the current selection is serialized
 * into clipboard MIME types when copying or dragging out of the editor.
 *
 * The extension's config holds an {@link ExportMimeTypeConfig} — a stack of
 * {@link ExportMimeTypeFunction} per MIME type. Out of the box it provides
 * fallback serializers for `'application/x-lexical-editor'`, `'text/html'`,
 * and `'text/plain'` that defer to {@link $getLexicalContent},
 * {@link $getHtmlContent}, and `selection.getTextContent()` respectively.
 *
 * Apps can layer additional handlers on top to customize an existing
 * payload (delegating to the default via `next()`) or to register an
 * entirely new MIME type. Functions provided through `mergeConfig` are
 * appended to the existing stack for each MIME type, so a newly registered
 * handler runs first and may fall through to the previously registered
 * handlers via its `next` argument.
 *
 * The extension's `output` is the resolved {@link ExportMimeTypeConfig},
 * which {@link $getClipboardDataFromSelection} and
 * {@link $exportMimeTypeFromSelection} read via the editor's peer
 * dependency lookup.
 *
 * @example
 * ```ts
 * import {configExtension, defineExtension} from '@lexical/extension';
 * import {GetClipboardDataExtension} from '@lexical/clipboard';
 *
 * const MyClipboardExtension = defineExtension({
 *   name: 'my-app/clipboard',
 *   dependencies: [
 *     configExtension(GetClipboardDataExtension, {
 *       $exportMimeType: {
 *         // Wrap the default HTML output with an app-specific marker.
 *         'text/html': [
 *           (selection, next) => {
 *             const html = next();
 *             return html ? wrapWithMyAppMarker(html) : html;
 *           },
 *         ],
 *         // Add a brand-new MIME type.
 *         'application/vnd.myapp+json': [
 *           (selection) =>
 *             selection ? exportMyAppFormat(selection) : null,
 *         ],
 *       },
 *     }),
 *   ],
 * });
 * ```
 */
export const GetClipboardDataExtension = defineExtension({
  build(editor, config, state) {
    return config.$exportMimeType;
  },
  config: safeCast<GetClipboardDataConfig>({
    $exportMimeType: DEFAULT_EXPORT_MIME_TYPE,
  }),
  mergeConfig(config, partial) {
    const merged = shallowMergeConfig(config, partial);
    if (partial.$exportMimeType) {
      const $exportMimeType = {...config.$exportMimeType};
      for (const [k, v] of Object.entries(partial.$exportMimeType)) {
        if (v) {
          const prev = $exportMimeType[k];
          $exportMimeType[k] = prev ? [...prev, ...v] : v;
        }
      }
      merged.$exportMimeType = $exportMimeType;
    }
    return merged;
  },
  name: '@lexical/clipboard/GetClipboardData',
});
