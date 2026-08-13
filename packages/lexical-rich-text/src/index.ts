/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getClipboardDataFromSelection,
  $handleRichTextDrop,
  $insertDataTransferForRichText,
  $writeDragSourceToDataTransfer,
  caretFromPoint,
  copyToClipboard,
  setLexicalClipboardDataTransfer,
} from '@lexical/clipboard';
import {type ReadonlySignal, signal} from '@lexical/extension';
import {
  $isParentRTL,
  $moveCharacter,
  $shouldOverrideDefaultCharacterSelection,
} from '@lexical/selection';
import {
  $getNearestBlockElementAncestorOrThrow,
  $handleIndentAndOutdent,
  eventFiles,
  objectKlassEquals,
} from '@lexical/utils';
import {
  $applyNodeReplacement,
  $caretFromPoint,
  $comparePointCaretNext,
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTabNode,
  $extendCaretToRange,
  $findMatchingParent,
  $formatText,
  $getCaretRange,
  $getChildCaret,
  $getCollapsedCaretRange,
  $getDocument,
  $getEditor,
  $getNearestNodeFromDOMNode,
  $getRoot,
  $getSelection,
  $getSiblingCaret,
  $getSlotFrame,
  $getState,
  $hasAncestor,
  $insertNodes,
  $isDecoratorNode,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isRootNode,
  $isRootOrShadowRoot,
  $isSelectionCapturedInDecoratorInput,
  $isShadowRootNode,
  $isSiblingCaret,
  $isTextNode,
  $needsBlockCursorBeside,
  $normalizeCaret,
  $normalizeSelection__EXPERIMENTAL,
  $selectAll,
  $setDirectionFromDOM,
  $setFormatFromDOM,
  $setSelection,
  $setSelectionFromCaretRange,
  $setState,
  $setTextFormat,
  addClassNamesToElement,
  CAN_USE_BEFORE_INPUT,
  type CaretDirection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  type CommandPayloadType,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  COPY_COMMAND,
  createCommand,
  createState,
  CUT_COMMAND,
  CUT_TAG,
  DELETE_CHARACTER_COMMAND,
  DELETE_LINE_COMMAND,
  DELETE_WORD_COMMAND,
  type DOMConversionOutput,
  type DOMExportOutput,
  DRAGOVER_COMMAND,
  DRAGSTART_COMMAND,
  DROP_COMMAND,
  type EditorConfig,
  ElementNode,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  getDOMSelection,
  INDENT_CONTENT_COMMAND,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  INSERT_TAB_COMMAND,
  IS_APPLE_WEBKIT,
  IS_IOS,
  IS_SAFARI,
  isDOMNode,
  isHTMLElement,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_SPACE_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode,
  type LexicalUpdateJSON,
  mergeRegister,
  MOVE_TO_END,
  MOVE_TO_START,
  type NodeKey,
  type NodeSelection,
  OUTDENT_CONTENT_COMMAND,
  type ParagraphNode,
  PASTE_COMMAND,
  PASTE_TAG,
  type RangeSelection,
  REMOVE_TEXT_COMMAND,
  SELECT_ALL_COMMAND,
  type SerializedElementNode,
  SET_TEXT_FORMAT_COMMAND,
  setNodeIndentFromDOM,
  type Spread,
  type TextFormatType,
} from 'lexical';

export type SerializedHeadingNode = Spread<
  {
    tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  },
  SerializedElementNode
>;

export const DRAG_DROP_PASTE: LexicalCommand<File[]> =
  /* @__PURE__ */ createCommand('DRAG_DROP_PASTE_FILE');

export type SerializedQuoteNode = Spread<
  {
    /**
     * Present (and `true`) only when the quote has opted in to shadow
     * root behavior via {@link QuoteNode.setIsShadowRoot} or
     * `$createQuoteNode({shadowRoot: true})`. Omitted otherwise, so the
     * serialization of quotes that have not opted in is unchanged.
     */
    shadowRoot?: boolean;
  },
  SerializedElementNode
>;

/**
 * Opt-in state for {@link QuoteNode.isShadowRoot}. When `true`, the quote
 * behaves like a multi-block region (similar to a table cell): it holds
 * block-level children (paragraphs, headings, ...) instead of inline
 * content, which allows more faithful HTML and Markdown import/export of
 * `<blockquote>` content. Defaults to `false`, in which case there is no
 * change to the legacy behavior (and nothing extra is serialized).
 */
export const quoteShadowRootState = /* @__PURE__ */ createState('shadowRoot', {
  parse: Boolean,
});

/** @noInheritDoc */
export class QuoteNode extends ElementNode {
  $config() {
    return this.config('quote', {
      extends: ElementNode,
      importDOM: {
        blockquote: () => ({
          conversion: $convertBlockquoteElement,
          priority: 0,
        }),
      },
      stateConfigs: [{flat: true, stateConfig: quoteShadowRootState}],
    });
  }

  /**
   * `true` when this quote has opted in to shadow root behavior with
   * {@link setIsShadowRoot} or `$createQuoteNode({shadowRoot: true})`,
   * in which case it contains block-level children rather than inline
   * content. `false` (the legacy inline-content behavior) by default.
   */
  isShadowRoot(): boolean {
    return $getState(this, quoteShadowRootState);
  }

  /**
   * Opt this quote in to (or out of) shadow root behavior. See
   * {@link quoteShadowRootState}. Note that this does not restructure any
   * existing children; a shadow root quote is expected to contain
   * block-level children (non-element children will be normalized into
   * paragraphs by the built-in shadow root transform).
   */
  setIsShadowRoot(isShadowRoot: boolean): this {
    return $setState(this, quoteShadowRootState, isShadowRoot);
  }

  // View

  createDOM(config: EditorConfig): HTMLElement {
    const element = $getDocument().createElement('blockquote');
    addClassNamesToElement(element, config.theme.quote);
    return element;
  }
  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    return false;
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const {element} = super.exportDOM(editor);

    if (isHTMLElement(element)) {
      if (this.isEmpty()) {
        element.append($getDocument().createElement('br'));
      }

      const formatType = this.getFormatType();
      if (formatType) {
        element.style.textAlign = formatType;
      }

      const direction = this.getDirection();
      if (direction) {
        element.dir = direction;
      }
    }

    return {
      element,
    };
  }

  exportJSON(): SerializedQuoteNode {
    return super.exportJSON();
  }

  static importJSON(serializedNode: SerializedQuoteNode): QuoteNode {
    return $createQuoteNode().updateFromJSON(serializedNode);
  }

  // Mutation

  insertNewAfter(_: RangeSelection, restoreSelection?: boolean): ParagraphNode {
    const newBlock = $createParagraphNode();
    const direction = this.getDirection();
    newBlock.setDirection(direction);
    this.insertAfter(newBlock, restoreSelection);
    return newBlock;
  }

  collapseAtStart(): true {
    if (this.isShadowRoot()) {
      // A shadow root quote holds block-level children, so collapsing
      // dissolves the quote and lifts the blocks out as siblings rather
      // than merging them into a single paragraph.
      for (const child of this.getChildren()) {
        this.insertBefore(child);
      }
      this.remove();
      return true;
    }
    const paragraph = $createParagraphNode();
    const children = this.getChildren();
    children.forEach(child => paragraph.append(child));
    this.replace(paragraph);
    return true;
  }

  canMergeWhenEmpty(): true {
    return true;
  }
}

export function $createQuoteNode(options?: {
  /**
   * When `true` the quote opts in to shadow root behavior
   * (see {@link quoteShadowRootState}). Defaults to `false`.
   */
  shadowRoot?: boolean;
}): QuoteNode {
  const node = $applyNodeReplacement(new QuoteNode());
  return options && options.shadowRoot ? node.setIsShadowRoot(true) : node;
}

export function $isQuoteNode(
  node: LexicalNode | null | undefined,
): node is QuoteNode {
  return node instanceof QuoteNode;
}

export type HeadingTagType = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/** @noInheritDoc */
export class HeadingNode extends ElementNode {
  /** @internal */
  __tag: HeadingTagType;

  $config() {
    return this.config('heading', {
      extends: ElementNode,
      importDOM: {
        h1: () => ({conversion: $convertHeadingElement, priority: 0}),
        h2: () => ({conversion: $convertHeadingElement, priority: 0}),
        h3: () => ({conversion: $convertHeadingElement, priority: 0}),
        h4: () => ({conversion: $convertHeadingElement, priority: 0}),
        h5: () => ({conversion: $convertHeadingElement, priority: 0}),
        h6: () => ({conversion: $convertHeadingElement, priority: 0}),
        p: (node: Node) => {
          // domNode is a <p> since we matched it by nodeName
          const paragraph = node as HTMLParagraphElement;
          const firstChild = paragraph.firstChild;
          if (firstChild !== null && isGoogleDocsTitle(firstChild)) {
            return {
              conversion: () => ({node: null}),
              priority: 3,
            };
          }
          return null;
        },
        span: (node: Node) => {
          if (isGoogleDocsTitle(node)) {
            return {
              conversion: () => {
                return {
                  node: $createHeadingNode('h1'),
                };
              },
              priority: 3,
            };
          }
          return null;
        },
      },
    });
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__tag = prevNode.__tag;
  }

  constructor(tag: HeadingTagType = 'h1', key?: NodeKey) {
    super(key);
    this.__tag = tag;
  }

  getTag(): HeadingTagType {
    return this.getLatest().__tag;
  }

  setTag(tag: HeadingTagType): this {
    const self = this.getWritable();
    self.__tag = tag;
    return self;
  }

  // View

  createDOM(config: EditorConfig): HTMLElement {
    const tag = this.__tag;
    const element = $getDocument().createElement(tag);
    const theme = config.theme;
    const classNames = theme.heading;
    if (classNames !== undefined) {
      const className = classNames[tag];
      addClassNamesToElement(element, className);
    }
    return element;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    return prevNode.__tag !== this.__tag;
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const {element} = super.exportDOM(editor);

    if (isHTMLElement(element)) {
      if (this.isEmpty()) {
        element.append($getDocument().createElement('br'));
      }

      const formatType = this.getFormatType();
      if (formatType) {
        element.style.textAlign = formatType;
      }

      const direction = this.getDirection();
      if (direction) {
        element.dir = direction;
      }
    }

    return {
      element,
    };
  }

  updateFromJSON(
    serializedNode: LexicalUpdateJSON<SerializedHeadingNode>,
  ): this {
    return super.updateFromJSON(serializedNode).setTag(serializedNode.tag);
  }

  exportJSON(): SerializedHeadingNode {
    return {
      ...super.exportJSON(),
      tag: this.getTag(),
    };
  }

  // Mutation
  insertNewAfter(
    selection?: RangeSelection,
    restoreSelection = true,
  ): ParagraphNode | HeadingNode {
    const anchorOffet = selection ? selection.anchor.offset : 0;
    const lastDesc = this.getLastDescendant();
    const isAtEnd =
      !lastDesc ||
      (selection &&
        selection.anchor.key === lastDesc.getKey() &&
        anchorOffet === lastDesc.getTextContentSize());
    const newElement =
      isAtEnd || !selection
        ? $createParagraphNode()
        : // The heading is split in two, so the second half keeps the
          // block format and style of the first, like ParagraphNode does.
          $createHeadingNode(this.getTag())
            .setFormat(this.getFormatType())
            .setStyle(this.getStyle());
    const direction = this.getDirection();
    newElement.setDirection(direction);
    this.insertAfter(newElement, restoreSelection);
    if (anchorOffet === 0 && !this.isEmpty() && selection) {
      const paragraph = $createParagraphNode();
      paragraph.select();
      this.replace(paragraph, true);
    }
    return newElement;
  }

  collapseAtStart(): true {
    if (this.isEmpty()) {
      const paragraph = $createParagraphNode();
      const children = this.getChildren();
      children.forEach(child => paragraph.append(child));
      this.replace(paragraph);
    }
    return true;
  }

  extractWithChild(): boolean {
    return true;
  }
}

function isGoogleDocsTitle(domNode: Node): boolean {
  if (domNode.nodeName.toLowerCase() === 'span') {
    return (domNode as HTMLSpanElement).style.fontSize === '26pt';
  }
  return false;
}

function $convertHeadingElement(element: HTMLElement): DOMConversionOutput {
  const nodeName = element.nodeName.toLowerCase();
  let node = null;
  if (
    nodeName === 'h1' ||
    nodeName === 'h2' ||
    nodeName === 'h3' ||
    nodeName === 'h4' ||
    nodeName === 'h5' ||
    nodeName === 'h6'
  ) {
    node = $createHeadingNode(nodeName);
    setNodeIndentFromDOM(element, node);
    $setFormatFromDOM(node, element);
    $setDirectionFromDOM(node, element);
  }
  return {node};
}

function $convertBlockquoteElement(element: HTMLElement): DOMConversionOutput {
  const node = $createQuoteNode();
  $setFormatFromDOM(node, element);
  setNodeIndentFromDOM(element, node);
  $setDirectionFromDOM(node, element);
  return {node};
}

export function $createHeadingNode(
  headingTag: HeadingTagType = 'h1',
): HeadingNode {
  return $applyNodeReplacement(new HeadingNode(headingTag));
}

export function $isHeadingNode(
  node: LexicalNode | null | undefined,
): node is HeadingNode {
  return node instanceof HeadingNode;
}

function onPasteForRichText(
  event: CommandPayloadType<typeof PASTE_COMMAND>,
  editor: LexicalEditor,
): void {
  event.preventDefault();
  editor.update(
    () => {
      const selection = $getSelection();
      const clipboardData =
        objectKlassEquals(event, InputEvent) ||
        objectKlassEquals(event, KeyboardEvent)
          ? null
          : event.clipboardData;
      if (clipboardData != null && selection !== null) {
        $insertDataTransferForRichText(clipboardData, selection, editor);
      }
    },
    {
      // PASTE_TAG gives the paste its own undo entry: @lexical/history treats
      // the tag as a history boundary so undoing a paste does not also undo any
      // typing that preceded it (see #8609).
      tag: PASTE_TAG,
    },
  );
}

async function onCutForRichText(
  event: CommandPayloadType<typeof CUT_COMMAND>,
  editor: LexicalEditor,
): Promise<void> {
  await copyToClipboard(
    editor,
    objectKlassEquals(event, ClipboardEvent) ? event : null,
  );
  editor.update(
    () => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.removeText();
      } else if ($isNodeSelection(selection)) {
        selection.getNodes().forEach(node => node.remove());
      }
    },
    {
      // CUT_TAG gives the cut its own undo entry: @lexical/history treats the
      // tag as a history boundary so undoing a cut does not also undo any typing
      // that preceded it (see #8609).
      tag: CUT_TAG,
    },
  );
}

export {eventFiles} from '@lexical/utils';

function $isTargetWithinDecorator(target: HTMLElement): boolean {
  const node = $getNearestNodeFromDOMNode(target);
  return $isDecoratorNode(node);
}

function $isSelectionAtEndOfRoot(selection: RangeSelection) {
  const focus = selection.focus;
  return focus.key === 'root' && focus.offset === $getRoot().getChildrenSize();
}

function $isSelectionAtStartOfRoot(selection: RangeSelection) {
  const focus = selection.focus;
  return focus.key === 'root' && focus.offset === 0;
}

function $isSelectionCollapsedAtFrontOfIndentedBlock(
  selection: RangeSelection,
): boolean {
  if (!selection.isCollapsed()) {
    return false;
  }
  const {anchor} = selection;
  if (anchor.offset !== 0) {
    return false;
  }
  const anchorNode = anchor.getNode();
  if ($isRootNode(anchorNode)) {
    return false;
  }
  const element = $getNearestBlockElementAncestorOrThrow(anchorNode);
  return (
    element.getIndent() > 0 &&
    (element.is(anchorNode) || anchorNode.is(element.getFirstDescendant()))
  );
}

/**
 * Trigger types that cause format escape at text node boundaries.
 * - `enter`: Escape on Enter key press
 * - `click`: Escape on mouse click
 * - `arrow`: Escape on arrow key navigation (left/right)
 * - `space`: Escape on Space key press
 * - `tab`: Escape on Tab key press
 */
export type EscapeFormatTrigger = 'enter' | 'click' | 'arrow' | 'space' | 'tab';

/**
 * Trigger flags for a single format type. Set a trigger key to `true` to
 * escape that format when the corresponding user interaction occurs.
 *
 * When `onlyAtBoundary` is `true`, the format is only escaped when the cursor
 * is at the start or end of a formatted text node with no adjacent sibling in
 * that direction. When `onlyAtBoundary` is `false` or omitted the format is
 * always escaped regardless of cursor position (matching the legacy
 * `$resetCapitalization` behavior).
 */
export type TriggerConfig = {
  [K in EscapeFormatTrigger]?: boolean;
} & {
  onlyAtBoundary?: boolean;
};

/**
 * Per-format trigger configuration. Each {@link TextFormatType} maps to its
 * own set of triggers, or `null` to explicitly disable escape for that format
 * (useful when overriding defaults via `configExtension`).
 */
export type EscapeFormatTriggerConfig = {
  [K in TextFormatType]?: TriggerConfig | null;
};

function $escapeFormatsForTrigger(
  selection: RangeSelection,
  trigger: EscapeFormatTrigger,
  direction: 'start' | 'end' | 'both',
  config: EscapeFormatTriggerConfig,
): void {
  let isBoundary = false;
  let anchorNode: LexicalNode | null = null;

  if (selection.isCollapsed() && selection.anchor.type === 'text') {
    const node = selection.anchor.getNode();
    if ($isTextNode(node)) {
      anchorNode = node;
      const offset = selection.anchor.offset;
      const atEnd =
        offset === node.getTextContentSize() && node.getNextSibling() === null;
      const atStart = offset === 0 && node.getPreviousSibling() === null;
      isBoundary =
        (direction === 'end' && atEnd) ||
        (direction === 'start' && atStart) ||
        (direction === 'both' && (atEnd || atStart));
    }
  }

  let didEscapeBoundary = false;
  for (const [formatKey, triggers] of Object.entries(config)) {
    if (triggers == null || !triggers[trigger]) {
      continue;
    }
    const format = formatKey as TextFormatType;

    if (triggers.onlyAtBoundary) {
      if (
        !isBoundary ||
        !anchorNode ||
        !$isTextNode(anchorNode) ||
        !anchorNode.hasFormat(format)
      ) {
        continue;
      }
      didEscapeBoundary = true;
    }

    if (selection.hasFormat(format)) {
      selection.toggleFormat(format);
    }
  }

  if (didEscapeBoundary) {
    selection.setStyle('');
  }
}

const DEFAULT_ESCAPE_FORMAT_TRIGGERS: EscapeFormatTriggerConfig = {
  capitalize: {enter: true, space: true, tab: true},
  lowercase: {enter: true, space: true, tab: true},
  uppercase: {enter: true, space: true, tab: true},
};

function $tryEnterFromBlockCursor(
  selection: RangeSelection,
  direction: CaretDirection,
): boolean {
  if (!selection.isCollapsed() || selection.anchor.type !== 'element') {
    return false;
  }
  const caret = $caretFromPoint(selection.anchor, direction);
  const child = caret.getNodeAtCaret();
  if ($isShadowRootNode(child) && !child.isInline()) {
    $setSelectionFromCaretRange(
      $getCollapsedCaretRange(
        $normalizeCaret($getChildCaret(child, direction)),
      ),
    );
    return true;
  }
  return false;
}

function $tryBlockCursorShadowRootNavigation(
  selection: RangeSelection,
  direction: CaretDirection,
): boolean {
  return (
    $tryExitShadowRootToBlockCursor(selection, direction) ||
    $tryEnterFromBlockCursor(selection, direction)
  );
}

function $tryExitShadowRootToBlockCursor(
  selection: RangeSelection,
  direction: CaretDirection,
): boolean {
  if (!selection.isCollapsed()) {
    return false;
  }
  const focusCaret = $caretFromPoint(selection.focus, direction);
  // Walk up from focus to find the nearest shadow root ancestor.
  // Start from the focus node itself since it may be a
  // shadow root (e.g. LayoutItem with element-type selection).
  const shadowRoot = $findMatchingParent(focusCaret.origin, $isShadowRootNode);
  if (!shadowRoot) {
    return false;
  }
  // When focus is an element-type point, $caretFromPoint returns a caret
  // whose origin is a child of the focus node. If that child happens to be
  // (or sit inside) a shadow root, $findMatchingParent matches it even
  // though the selection is at the parent level, not inside the shadow root.
  // Skip the exit logic when the focus node is not actually inside the
  // found shadow root.
  const focusNode = selection.focus.getNode();
  if (!shadowRoot.is(focusNode) && !$hasAncestor(focusNode, shadowRoot)) {
    return false;
  }
  // Check that the focus is at the edge of the shadow root in the given
  // direction. If focus is the shadow root itself, check the offset directly.
  // Otherwise walk toward the deepest first/last descendant.
  const textRange = $getCaretRange(
    focusCaret,
    $getSiblingCaret(shadowRoot, direction),
  );
  // If there's text we're not at the edge
  if (
    textRange
      .getTextSlices()
      .some(slice => slice && slice.getTextContentSize() > 0)
  ) {
    return false;
  }
  // Normalize the anchor in case it started with a ChildCaret
  const range = $getCaretRange(
    textRange.anchor.getSiblingCaret(),
    textRange.focus,
  );
  // When traversing from the edge to the root we expect to see only parent nodes
  // as sibling carets
  let prevOrigin = range.anchor.origin;
  for (const caret of range) {
    if (!($isSiblingCaret(caret) && caret.origin.is(prevOrigin.getParent()))) {
      return false;
    }
    prevOrigin = caret.origin;
  }
  // Walk outward from the shadow root through nested shadow roots until
  // we find a sibling that needs a block cursor beside it.
  let prevShadow = shadowRoot;
  for (const caret of $extendCaretToRange(
    $getSiblingCaret(shadowRoot, direction),
  )) {
    // A caret whose origin is the parent of the current level is the "leave"
    // step walking outward; only keep going while those parents are shadow
    // roots. Any other origin is the adjacent sibling at this level.
    if (caret.origin.is(prevShadow.getParent())) {
      if (!$isShadowRootNode(caret.origin)) {
        break;
      }
      prevShadow = caret.origin;
      continue;
    }
    if ($needsBlockCursorBeside(caret.origin)) {
      const sr = $getSiblingCaret(prevShadow, direction);
      $setSelectionFromCaretRange($getCaretRange(sr, sr));
      return true;
    }
    break;
  }
  return false;
}

function $isSelectableBlockDecorator(
  node: LexicalNode | null | undefined,
): boolean {
  return (
    $isDecoratorNode(node) &&
    !node.isInline() &&
    !node.isIsolated() &&
    node.isKeyboardSelectable()
  );
}

function $selectNode(key: NodeKey): void {
  const nodeSelection = $createNodeSelection();
  nodeSelection.add(key);
  $setSelection(nodeSelection);
}

function $tryDecoratorLineNavigation(
  selection: RangeSelection,
  isBackward: boolean,
): boolean {
  if (!selection.isCollapsed()) {
    return false;
  }
  const focus = selection.focus;
  const focusNode = focus.getNode();
  const direction = isBackward ? 'previous' : 'next';
  const focusCaret = $caretFromPoint(focus, direction);

  if (
    focus.type === 'element' &&
    $isElementNode(focusNode) &&
    $isRootOrShadowRoot(focusNode)
  ) {
    const adjacentChild = focusCaret.getNodeAtCaret();
    if (adjacentChild !== null && $isSelectableBlockDecorator(adjacentChild)) {
      $selectNode(adjacentChild.__key);
      return true;
    }
    return false;
  }

  const topBlock = $findMatchingParent(
    $isElementNode(focusNode) ? focusNode : focusNode.getParentOrThrow(),
    (n): n is ElementNode =>
      $isElementNode(n) && !n.isInline() && $isRootOrShadowRoot(n.getParent()),
  );
  if (topBlock === null) {
    return false;
  }
  const adjacentSibling = $getSiblingCaret(
    topBlock,
    direction,
  ).getNodeAtCaret();
  if (
    adjacentSibling === null ||
    !$isSelectableBlockDecorator(adjacentSibling)
  ) {
    return false;
  }
  // Empty blocks always escape on line-move, so skip the DOM probe.
  if (topBlock.getTextContentSize() === 0) {
    $selectNode(adjacentSibling.__key);
    return true;
  }
  const rootElement = $getEditor().getRootElement();
  if (rootElement === null) {
    return false;
  }
  const domSelection = getDOMSelection(rootElement.ownerDocument.defaultView);
  if (domSelection === null || domSelection.rangeCount === 0) {
    return false;
  }
  const savedAnchorNode = domSelection.anchorNode;
  const savedAnchorOffset = domSelection.anchorOffset;
  const savedFocusNode = domSelection.focusNode;
  const savedFocusOffset = domSelection.focusOffset;
  domSelection.modify('move', isBackward ? 'backward' : 'forward', 'line');
  const newAnchorNode = domSelection.anchorNode;
  const newAnchorOffset = domSelection.anchorOffset;
  if (newAnchorNode === null) {
    restoreDOMSelection(
      domSelection,
      savedAnchorNode,
      savedAnchorOffset,
      savedFocusNode,
      savedFocusOffset,
    );
    return false;
  }
  const movedNode = $getNearestNodeFromDOMNode(newAnchorNode);
  restoreDOMSelection(
    domSelection,
    savedAnchorNode,
    savedAnchorOffset,
    savedFocusNode,
    savedFocusOffset,
  );
  if (movedNode === null) {
    return false;
  }
  // Firefox stays in place when modify('move', 'backward', 'line') hits
  // the top of a block — treat no movement as reaching the block edge.
  const didNotMove =
    newAnchorNode === savedAnchorNode && newAnchorOffset === savedAnchorOffset;
  if (didNotMove) {
    $selectNode(adjacentSibling.__key);
    return true;
  }
  const stillInSameBlock =
    movedNode.is(topBlock) || $hasAncestor(movedNode, topBlock);
  if (stillInSameBlock) {
    return false;
  }
  $selectNode(adjacentSibling.__key);
  return true;
}

function restoreDOMSelection(
  domSelection: Selection,
  anchorNode: Node | null,
  anchorOffset: number,
  focusNode: Node | null,
  focusOffset: number,
): void {
  if (anchorNode !== null && focusNode !== null) {
    domSelection.setBaseAndExtent(
      anchorNode,
      anchorOffset,
      focusNode,
      focusOffset,
    );
  }
}

function $tryInlineGridLineNavigation(
  selection: RangeSelection,
  isBackward: boolean,
): boolean {
  if (!selection.isCollapsed()) {
    return false;
  }
  const focusNode = selection.focus.getNode();
  const parentBlock = $findMatchingParent(
    $isElementNode(focusNode) ? focusNode : focusNode.getParentOrThrow(),
    (n): n is ElementNode => $isElementNode(n) && !n.isInline(),
  );
  if (parentBlock === null) {
    return false;
  }
  const editor = $getEditor();
  const rootElement = editor.getRootElement();
  if (rootElement === null) {
    return false;
  }
  const win = rootElement.ownerDocument.defaultView;
  if (win === null) {
    return false;
  }
  let hasGrid = false;
  for (const child of parentBlock.getChildren()) {
    if ($isElementNode(child) && child.isInline()) {
      const dom = editor.getElementByKey(child.getKey());
      if (dom !== null) {
        const d = win.getComputedStyle(dom).display;
        if (d === 'inline-grid' || d === 'inline-flex') {
          hasGrid = true;
          break;
        }
      }
    }
  }
  if (!hasGrid) {
    return false;
  }
  const direction: CaretDirection = isBackward ? 'previous' : 'next';
  const siblingBlock = $getSiblingCaret(
    parentBlock,
    direction,
  ).getNodeAtCaret();
  if (siblingBlock === null || !$isElementNode(siblingBlock)) {
    if (isBackward) {
      const first = parentBlock.getFirstDescendant();
      if ($isTextNode(first)) {
        first.select(0, 0);
      } else {
        parentBlock.select(0, 0);
      }
    } else {
      const last = parentBlock.getLastDescendant();
      if ($isTextNode(last)) {
        const len = last.getTextContentSize();
        last.select(len, len);
      } else {
        const count = parentBlock.getChildrenSize();
        parentBlock.select(count, count);
      }
    }
    return true;
  }
  const siblingDOM = editor.getElementByKey(siblingBlock.getKey());
  if (siblingDOM === null) {
    return false;
  }
  const domSelection = getDOMSelection(win);
  if (domSelection === null || domSelection.rangeCount === 0) {
    return false;
  }
  const curRange = domSelection.getRangeAt(0).cloneRange();
  curRange.collapse(true);
  const curRect = curRange.getBoundingClientRect();
  const sibRect = siblingDOM.getBoundingClientRect();
  const targetY = sibRect.top + sibRect.height / 2;
  if (curRect.height > 0) {
    const hit = caretFromPoint(curRect.left, targetY, rootElement);
    if (hit !== null && siblingDOM.contains(hit.node)) {
      const hitRange = rootElement.ownerDocument.createRange();
      hitRange.setStart(hit.node, hit.offset);
      hitRange.collapse(true);
      selection.applyDOMRange(hitRange);
      selection.dirty = true;
      return true;
    }
  }
  const targetDesc = isBackward
    ? siblingBlock.getLastDescendant()
    : siblingBlock.getFirstDescendant();
  if ($isTextNode(targetDesc)) {
    const offset = isBackward ? targetDesc.getTextContentSize() : 0;
    targetDesc.select(offset, offset);
  } else {
    const childCount = siblingBlock.getChildrenSize();
    siblingBlock.select(
      isBackward ? childCount : 0,
      isBackward ? childCount : 0,
    );
  }
  return true;
}

function $exitNodeSelectionToward(
  node: LexicalNode,
  direction: CaretDirection,
): void {
  const caret = $getSiblingCaret(node, direction);
  const sibling = caret.getAdjacentCaret();
  if (
    sibling !== null &&
    $isElementNode(sibling.origin) &&
    !sibling.origin.isInline() &&
    sibling.origin.isShadowRoot()
  ) {
    $setSelectionFromCaretRange($getCollapsedCaretRange(caret));
  } else if (direction === 'next') {
    node.selectNext(0, 0);
  } else {
    node.selectPrevious();
  }
}

/**
 * Collapse a NodeSelection to a caret at the surrounding block's edge for
 * MOVE_TO_START / MOVE_TO_END. Picks the document-order first node for
 * MOVE_TO_START (`isBackward = true`) or last for MOVE_TO_END, walks up
 * to the picked node's nearest non-inline ancestor, and lands the caret
 * at that block's offset `0` or `childrenSize`.
 *
 * Document order is resolved via `$comparePointCaretNext` over each
 * selected node's `'next'` sibling caret — `NodeSelection.getNodes()`
 * iterates `_nodes: Set<NodeKey>` in click-insertion order, so a Set-
 * index pick would land on the most-recently-clicked node, not the
 * document-order first / last.
 *
 * A decorator nested inside an element-decorator host (e.g. inside a
 * card title paragraph) promotes to the surrounding paragraph rather
 * than the host's edge — the `n !== targetNode` guard excludes the
 * node itself, so a whole-element NodeSelection (the host) snaps to
 * its parent block, not its own interior. Falls back to the root when
 * no non-inline ancestor below the root matches, which lands the
 * caret at the document edge.
 *
 * Distinct from `KEY_ARROW_LEFT_COMMAND` / `KEY_ARROW_RIGHT_COMMAND`,
 * which step to the immediate sibling via `selectPrevious` /
 * `selectNext`. Cmd+Arrow is a line-end command rather than a one-step
 * caret move, so the block edge is the intended target. `event.shiftKey`
 * is not honored — NodeSelection has no natural "extend toward block
 * edge" semantic.
 *
 * Always calls `preventDefault` and `stopPropagation` so Chrome's
 * native Cmd+Arrow page-navigate cannot fall through.
 *
 * @internal
 */
function $promoteNodeSelectionToBlockEdge(
  selection: NodeSelection,
  isBackward: boolean,
  event: KeyboardEvent,
): boolean {
  event.preventDefault();
  event.stopPropagation();
  const nodes = selection.getNodes();
  if (nodes.length === 0) {
    return true;
  }
  const sorted = nodes
    .map(node => $getSiblingCaret(node, 'next'))
    .sort($comparePointCaretNext);
  const targetNode = (isBackward ? sorted[0] : sorted[sorted.length - 1])
    .origin;
  const block: ElementNode =
    $findMatchingParent(
      targetNode,
      (n): n is ElementNode =>
        n !== targetNode && $isElementNode(n) && !n.isInline(),
    ) ?? $getRoot();
  const offset = isBackward ? 0 : block.getChildrenSize();
  block.select(offset, offset);
  return true;
}

/**
 * Decides whether a paste event carrying files should be handled by
 * dispatching {@link DRAG_DROP_PASTE} with those files, rather than falling
 * through to the regular HTML paste handling.
 *
 * @param files - The files present on the clipboard, if any
 * @param hasTextContent - Whether the clipboard also carries text/html or
 * text/plain content
 */
export type ShouldHandlePasteAsFiles = (
  files: File[],
  hasTextContent: boolean,
) => boolean;

/**
 * The historical behavior: files are only handled when the clipboard carries
 * no text content at all. Note that browsers put a text/html fallback on the
 * clipboard alongside the file when an image is copied via the context menu,
 * so this default routes such images through the HTML importer.
 */
export function defaultShouldHandlePasteAsFiles(
  files: File[],
  hasTextContent: boolean,
): boolean {
  return files.length > 0 && !hasTextContent;
}

export function registerRichText(
  editor: LexicalEditor,
  escapeFormatTriggers: ReadonlySignal<EscapeFormatTriggerConfig> = signal(
    DEFAULT_ESCAPE_FORMAT_TRIGGERS,
  ),
  shouldHandlePasteAsFiles: ReadonlySignal<ShouldHandlePasteAsFiles> = signal(
    defaultShouldHandlePasteAsFiles,
  ),
): () => void {
  const removeListener = mergeRegister(
    editor.registerCommand(
      CLICK_COMMAND,
      event => {
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          // A click on an already-selected node is an interaction with that
          // node (its own click handler may select it, open an editor, …),
          // not a deselect gesture. Keep the selection when the click target
          // is inside the selected node's DOM; clicking anywhere else still
          // deselects (facebook/lexical#8907).
          const eventTarget = event.target;
          if (isHTMLElement(eventTarget)) {
            for (const node of selection.getNodes()) {
              const dom = editor.getElementByKey(node.getKey());
              if (dom !== null && dom.contains(eventTarget)) {
                return false;
              }
            }
          }
          selection.clear();
          return true;
        }
        if ($isRangeSelection(selection)) {
          $escapeFormatsForTrigger(
            selection,
            'click',
            'both',
            escapeFormatTriggers.peek(),
          );
        }
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      DELETE_CHARACTER_COMMAND,
      isBackward => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.deleteCharacter(isBackward);
          return true;
        } else if ($isNodeSelection(selection)) {
          selection.deleteNodes();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      DELETE_WORD_COMMAND,
      isBackward => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }
        selection.deleteWord(isBackward);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      DELETE_LINE_COMMAND,
      isBackward => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }
        selection.deleteLine(isBackward);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      CONTROLLED_TEXT_INSERTION_COMMAND,
      eventOrText => {
        const selection = $getSelection();

        if (typeof eventOrText === 'string') {
          if (selection !== null) {
            selection.insertText(eventOrText);
          }
        } else {
          if (selection === null) {
            return false;
          }

          const dataTransfer = eventOrText.dataTransfer;
          if (dataTransfer != null) {
            $insertDataTransferForRichText(dataTransfer, selection, editor);
          } else if ($isRangeSelection(selection)) {
            const data = eventOrText.data;
            if (data) {
              selection.insertText(data);
            }
            return true;
          }
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      REMOVE_TEXT_COMMAND,
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }
        selection.removeText();
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      FORMAT_TEXT_COMMAND,
      format => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) && !$isNodeSelection(selection)) {
          return false;
        }
        $formatText(selection, format);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      SET_TEXT_FORMAT_COMMAND,
      formats => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) && !$isNodeSelection(selection)) {
          return false;
        }
        $setTextFormat(selection, formats);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      FORMAT_ELEMENT_COMMAND,
      format => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) && !$isNodeSelection(selection)) {
          return false;
        }
        const nodes = selection.getNodes();
        for (const node of nodes) {
          const element = $findMatchingParent(
            node,
            (parentNode): parentNode is ElementNode =>
              $isElementNode(parentNode) && !parentNode.isInline(),
          );
          if (element !== null) {
            element.setFormat(format);
          }
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      INSERT_LINE_BREAK_COMMAND,
      selectStart => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }
        selection.insertLineBreak(selectStart);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      INSERT_PARAGRAPH_COMMAND,
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }
        selection.insertParagraph();
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      INSERT_TAB_COMMAND,
      () => {
        const tabNode = $createTabNode();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          tabNode.setFormat(selection.format);
          tabNode.setStyle(selection.style);
        }
        $insertNodes([tabNode]);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      INDENT_CONTENT_COMMAND,
      () => {
        return $handleIndentAndOutdent(block => {
          const indent = block.getIndent();
          block.setIndent(indent + 1);
        });
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      OUTDENT_CONTENT_COMMAND,
      () => {
        return $handleIndentAndOutdent(block => {
          const indent = block.getIndent();
          if (indent > 0) {
            block.setIndent(Math.max(0, indent - 1));
          }
        });
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      event => {
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          // If selection is on a node, let's try and move selection
          // back to being a range selection.
          const nodes = selection.getNodes();
          if (nodes.length > 0) {
            event.preventDefault();
            $exitNodeSelectionToward(nodes[0], 'previous');
            return true;
          }
        } else if ($isRangeSelection(selection)) {
          if ($isSelectionAtStartOfRoot(selection)) {
            event.preventDefault();
            return true;
          }
          if (
            !event.shiftKey &&
            $tryBlockCursorShadowRootNavigation(selection, 'previous')
          ) {
            event.preventDefault();
            return true;
          }
          if (!event.shiftKey && $tryDecoratorLineNavigation(selection, true)) {
            event.preventDefault();
            return true;
          }
          if (
            !event.shiftKey &&
            $tryInlineGridLineNavigation(selection, true)
          ) {
            event.preventDefault();
            return true;
          }
        }
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      event => {
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          // If selection is on a node, let's try and move selection
          // back to being a range selection.
          const nodes = selection.getNodes();
          if (nodes.length > 0) {
            event.preventDefault();
            $exitNodeSelectionToward(nodes[0], 'next');
            return true;
          }
        } else if ($isRangeSelection(selection)) {
          if ($isSelectionAtEndOfRoot(selection)) {
            event.preventDefault();
            return true;
          }
          if (
            !event.shiftKey &&
            $tryBlockCursorShadowRootNavigation(selection, 'next')
          ) {
            event.preventDefault();
            return true;
          }
          if (
            !event.shiftKey &&
            $tryDecoratorLineNavigation(selection, false)
          ) {
            event.preventDefault();
            return true;
          }
          if (
            !event.shiftKey &&
            $tryInlineGridLineNavigation(selection, false)
          ) {
            event.preventDefault();
            return true;
          }
        }
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      event => {
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          // If selection is on a node, let's try and move selection
          // back to being a range selection.
          const nodes = selection.getNodes();
          if (nodes.length > 0) {
            event.preventDefault();
            $exitNodeSelectionToward(
              nodes[0],
              $isParentRTL(nodes[0]) ? 'next' : 'previous',
            );
            return true;
          }
        }
        if (!$isRangeSelection(selection)) {
          return false;
        }
        if (
          !event.shiftKey &&
          $tryBlockCursorShadowRootNavigation(
            selection,
            $isParentRTL(selection.anchor.getNode()) ? 'next' : 'previous',
          )
        ) {
          event.preventDefault();
          return true;
        }
        if (!event.shiftKey) {
          $escapeFormatsForTrigger(
            selection,
            'arrow',
            'start',
            escapeFormatTriggers.peek(),
          );
        }
        if ($shouldOverrideDefaultCharacterSelection(selection, true)) {
          const isHoldingShift = event.shiftKey;
          event.preventDefault();
          $moveCharacter(selection, isHoldingShift, true);
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      event => {
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          // If selection is on a node, let's try and move selection
          // back to being a range selection.
          const nodes = selection.getNodes();
          if (nodes.length > 0) {
            event.preventDefault();
            $exitNodeSelectionToward(
              nodes[0],
              $isParentRTL(nodes[0]) ? 'previous' : 'next',
            );
            return true;
          }
        }
        if (!$isRangeSelection(selection)) {
          return false;
        }
        if (
          !event.shiftKey &&
          $tryBlockCursorShadowRootNavigation(
            selection,
            $isParentRTL(selection.anchor.getNode()) ? 'previous' : 'next',
          )
        ) {
          event.preventDefault();
          return true;
        }
        if (!event.shiftKey) {
          $escapeFormatsForTrigger(
            selection,
            'arrow',
            'end',
            escapeFormatTriggers.peek(),
          );
        }
        if ($shouldOverrideDefaultCharacterSelection(selection, false)) {
          const isHoldingShift = event.shiftKey;
          event.preventDefault();
          $moveCharacter(selection, isHoldingShift, false);
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      event => {
        const selection = $getSelection();
        // A NodeSelection (e.g. a click that selected a block decorator) is
        // the user's explicit "delete this node" gesture. The decorator
        // pass-through below is meant to keep keystrokes flowing into an
        // editable nested inside a decorator (image caption, etc.), but a
        // NodeSelection is exactly the case where the user wants us to
        // handle backspace ourselves.
        if (!$isNodeSelection(selection)) {
          if ($isTargetWithinDecorator(event.target as HTMLElement)) {
            return false;
          }
        }
        if ($isRangeSelection(selection)) {
          if ($isSelectionCollapsedAtFrontOfIndentedBlock(selection)) {
            event.preventDefault();
            return editor.dispatchCommand(OUTDENT_CONTENT_COMMAND);
          }
          // On iOS, blocking the keydown event's default prevents the system
          // keyboard from updating its autocomplete/autocorrect suggestion bar
          // after Backspace. Returning false here skips event.preventDefault()
          // on keydown; the beforeinput deleteContentBackward handler still runs
          // and performs the deletion, so editing behavior is unchanged.
          // See https://github.com/facebook/lexical/issues/5841
          if (IS_IOS && CAN_USE_BEFORE_INPUT) {
            return false;
          }
        } else if (!$isNodeSelection(selection)) {
          return false;
        }
        event.preventDefault();

        return editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_DELETE_COMMAND,
      event => {
        const selection = $getSelection();
        // Same NodeSelection bypass as KEY_BACKSPACE_COMMAND above: a click
        // that selected a block decorator is the user's "delete this node"
        // gesture, even though the click target lives inside a decorator.
        if (!$isNodeSelection(selection)) {
          if ($isTargetWithinDecorator(event.target as HTMLElement)) {
            return false;
          }
        }
        if (!($isRangeSelection(selection) || $isNodeSelection(selection))) {
          return false;
        }
        event.preventDefault();
        return editor.dispatchCommand(DELETE_CHARACTER_COMMAND, false);
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_ENTER_COMMAND,
      event => {
        let selection = $getSelection();
        // When a block-level DecoratorNode is selected as a NodeSelection
        // (e.g. it is the only root child after the user removed all
        // surrounding paragraphs), Enter has no RangeSelection to act on
        // and the default handler bails out, leaving the editor stuck.
        // Convert to a RangeSelection past the decorator so the default
        // RangeSelection handler below inserts a paragraph and places
        // the caret.
        if ($isNodeSelection(selection)) {
          const nodes = selection.getNodes();
          if (
            nodes.length === 1 &&
            $isDecoratorNode(nodes[0]) &&
            !nodes[0].isInline()
          ) {
            selection = nodes[0].selectNext();
          }
        }
        if (!$isRangeSelection(selection)) {
          return false;
        }

        $escapeFormatsForTrigger(
          selection,
          'enter',
          'both',
          escapeFormatTriggers.peek(),
        );

        if (event !== null) {
          // If we have beforeinput, then we can avoid blocking
          // the default behavior. This ensures that the iOS can
          // intercept that we're actually inserting a paragraph,
          // and autocomplete, autocapitalize etc work as intended.
          // This can also cause a strange performance issue in
          // Safari, where there is a noticeable pause due to
          // preventing the key down of enter.
          if (
            (IS_IOS || IS_SAFARI || IS_APPLE_WEBKIT) &&
            CAN_USE_BEFORE_INPUT
          ) {
            return false;
          }
          event.preventDefault();
          if (event.shiftKey) {
            return editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false);
          }
        }
        return editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND);
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }
        editor.blur();
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      DROP_COMMAND,
      event => {
        const [, files] = eventFiles(event);
        if (files.length > 0) {
          const x = event.clientX;
          const y = event.clientY;
          const eventRange = caretFromPoint(x, y, editor.getRootElement());
          if (eventRange !== null) {
            const {offset: domOffset, node: domNode} = eventRange;
            const node = $getNearestNodeFromDOMNode(domNode);
            if (node !== null) {
              const selection = $createRangeSelection();
              if ($isTextNode(node)) {
                selection.anchor.set(node.getKey(), domOffset, 'text');
                selection.focus.set(node.getKey(), domOffset, 'text');
              } else {
                const parentKey = node.getParentOrThrow().getKey();
                const offset = node.getIndexWithinParent() + 1;
                selection.anchor.set(parentKey, offset, 'element');
                selection.focus.set(parentKey, offset, 'element');
              }
              const normalizedSelection =
                $normalizeSelection__EXPERIMENTAL(selection);
              $setSelection(normalizedSelection);
            }
            editor.dispatchCommand(DRAG_DROP_PASTE, files);
          }
          event.preventDefault();
          return true;
        }

        return $handleRichTextDrop(event, editor);
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      DRAGSTART_COMMAND,
      event => {
        const [isFileTransfer] = eventFiles(event);
        const selection = $getSelection();
        if (isFileTransfer && !$isRangeSelection(selection)) {
          return false;
        }
        if (
          $isRangeSelection(selection) &&
          !selection.isCollapsed() &&
          event.dataTransfer !== null
        ) {
          // Populate Lexical's own serialization so custom nodes (images,
          // decorators) survive a drop back into a Lexical editor rather than
          // being downgraded to text/html.
          setLexicalClipboardDataTransfer(
            event.dataTransfer,
            $getClipboardDataFromSelection(selection),
          );
          // Mark the drag source so a drop in a different editor can remove
          // the source range to produce cut-and-paste semantics.
          $writeDragSourceToDataTransfer(event.dataTransfer, editor);
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      DRAGOVER_COMMAND,
      event => {
        const [isFileTransfer] = eventFiles(event);
        const selection = $getSelection();
        if (isFileTransfer && !$isRangeSelection(selection)) {
          return false;
        }
        // Do NOT call event.preventDefault() here for text drags. Canceling
        // dragover tells the browser the page will handle the drop itself,
        // which suppresses the native editable drop behavior (drop caret
        // tracking and the beforeinput insertFromDrop that $doDrop relies on
        // for drags that don't originate in a Lexical editor). The only
        // exception is a decorator node, which the browser can't show a drop
        // caret for anyway and whose drops are fully handled by DROP_COMMAND.
        const x = event.clientX;
        const y = event.clientY;
        const eventRange = caretFromPoint(x, y, editor.getRootElement());
        if (eventRange !== null) {
          const node = $getNearestNodeFromDOMNode(eventRange.node);
          if ($isDecoratorNode(node)) {
            event.preventDefault();
          }
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      SELECT_ALL_COMMAND,
      () => {
        // Scope SELECT_ALL only when the caret is inside a named-slot frame:
        // slots are shadow-root isolated, so a whole-document select-all
        // would escape the slot and let a single keystroke replace the host.
        // Every other context (including TableCell shadow roots) keeps the
        // legacy whole-document behavior; block/document scoping elsewhere
        // is provided by the opt-in SelectBlockExtension.
        const selection = $getSelection();
        $selectAll(
          $isRangeSelection(selection) &&
            $getSlotFrame(selection.anchor.getNode()) !== null
            ? selection
            : null,
        );
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      COPY_COMMAND,
      event => {
        copyToClipboard(
          editor,
          objectKlassEquals(event, ClipboardEvent) ? event : null,
        );
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      CUT_COMMAND,
      event => {
        onCutForRichText(event, editor);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      PASTE_COMMAND,
      event => {
        const [, files, hasTextContent] = eventFiles(event);
        if (shouldHandlePasteAsFiles.peek()(files, hasTextContent)) {
          editor.dispatchCommand(DRAG_DROP_PASTE, files);
          return true;
        }

        // if inputs then paste within the input ignore creating a new node on paste event
        if (
          isDOMNode(event.target) &&
          $isSelectionCapturedInDecoratorInput(event.target)
        ) {
          return false;
        }

        const selection = $getSelection();
        if (selection !== null) {
          onPasteForRichText(event, editor);
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_SPACE_COMMAND,
      () => {
        const selection = $getSelection();

        if ($isRangeSelection(selection)) {
          $escapeFormatsForTrigger(
            selection,
            'space',
            'both',
            escapeFormatTriggers.peek(),
          );
        }

        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_TAB_COMMAND,
      () => {
        const selection = $getSelection();

        if ($isRangeSelection(selection)) {
          $escapeFormatsForTrigger(
            selection,
            'tab',
            'both',
            escapeFormatTriggers.peek(),
          );
        }

        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      MOVE_TO_END,
      event => {
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          return $promoteNodeSelectionToBlockEdge(selection, false, event);
        }
        if (!$isRangeSelection(selection)) {
          return false;
        }
        const {anchor} = selection;
        if (anchor.type !== 'element' || anchor.offset !== 0) {
          return false;
        }
        const element = anchor.getNode();
        if (!$isElementNode(element)) {
          return false;
        }
        const firstChild = element.getFirstChild();
        if (!$isDecoratorNode(firstChild) || !firstChild.isInline()) {
          return false;
        }
        // Native browser cursor traversal stops at the inline decorator's
        // contenteditable=false boundary when the caret starts at element
        // offset 0, so MOVE_TO_END leaves the caret stuck. Move it
        // ourselves. `element.selectEnd()` already handles every
        // last-descendant case correctly — text descendant produces a
        // text-type selection at the end of the run, decorator descendant
        // and the empty-element fallback both produce an element-type
        // selection at offset childrenSize.
        const elementKey = element.getKey();
        const ending = element.selectEnd();
        if (event.shiftKey) {
          ending.anchor.set(elementKey, 0, 'element');
        }
        event.preventDefault();
        event.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      MOVE_TO_START,
      event => {
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          return $promoteNodeSelectionToBlockEdge(selection, true, event);
        }
        if (!$isRangeSelection(selection)) {
          return false;
        }
        const {anchor, focus} = selection;
        const focusBlock = $findMatchingParent(
          focus.getNode(),
          (node): node is ElementNode =>
            $isElementNode(node) && !node.isInline(),
        );
        if (focusBlock === null) {
          return false;
        }
        const firstChild = focusBlock.getFirstChild();
        if (!$isDecoratorNode(firstChild) || !firstChild.isInline()) {
          return false;
        }
        // Cross-block selections fall through to native handling. The
        // Chromium boundary bug only matters when both endpoints sit
        // inside the block whose first child is the inline decorator.
        const anchorBlock = $findMatchingParent(
          anchor.getNode(),
          (node): node is ElementNode =>
            $isElementNode(node) && !node.isInline(),
        );
        if (anchorBlock !== focusBlock) {
          return false;
        }
        const blockKey = focusBlock.getKey();
        if (
          focus.type === 'element' &&
          focus.key === blockKey &&
          focus.offset === 0
        ) {
          return false;
        }
        // Symmetric to the MOVE_TO_END case: Chromium stops the native
        // caret at the inline decorator's contenteditable=false boundary
        // when moving backwards, so element offset 0 is unreachable.
        selection.focus.set(blockKey, 0, 'element');
        if (!event.shiftKey) {
          selection.anchor.set(blockKey, 0, 'element');
        }
        event.preventDefault();
        event.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
  );
  return removeListener;
}

export {
  HeadingAnnounceExtension,
  type HeadingAnnounceExtensionConfig,
} from './HeadingAnnounceExtension';
export {
  type RichTextConfig,
  RichTextExtension,
  RichTextImportExtension,
} from './LexicalRichTextExtension';
export {
  RichTextImportRules,
  ShadowRootQuoteRule,
} from './RichTextImportExtension';
