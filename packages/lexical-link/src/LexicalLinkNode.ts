/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {
  $applyNodeReplacement,
  $caretFromPoint,
  $copyNode,
  $findMatchingParent,
  $getChildCaret,
  $getDocument,
  $getSelection,
  $insertNodeToNearestRootAtCaret,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isSiblingCaret,
  $normalizeCaret,
  $normalizeSelection__EXPERIMENTAL,
  $rewindSiblingCaret,
  $setPointFromCaret,
  $setSelection,
  addClassNamesToElement,
  type BaseSelection,
  createCommand,
  type DOMConversionOutput,
  type EditorConfig,
  ElementNode,
  isHTMLAnchorElement,
  type LexicalCommand,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type Point,
  type PointCaret,
  type PointType,
  type RangeSelection,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

export type LinkAttributes = {
  rel?: null | string;
  target?: null | string;
  title?: null | string;
};

export type AutoLinkAttributes = Partial<
  Spread<LinkAttributes, {isUnlinked?: boolean}>
>;

export type SerializedLinkNode = Spread<
  {
    url: string;
  },
  Spread<LinkAttributes, SerializedElementNode>
>;

type LinkHTMLElementType = HTMLAnchorElement | HTMLSpanElement;

const SUPPORTED_URL_PROTOCOLS = new Set([
  'http:',
  'https:',
  'mailto:',
  'sms:',
  'tel:',
]);

/** @noInheritDoc */
export class LinkNode extends ElementNode {
  /** @internal */
  __url: string;
  /** @internal */
  __target: null | string;
  /** @internal */
  __rel: null | string;
  /** @internal */
  __title: null | string;

  $config() {
    return this.config('link', {
      extends: ElementNode,
      importDOM: {
        a: () => ({
          conversion: $convertAnchorElement,
          priority: 1,
        }),
      },
    });
  }

  constructor(
    url: string = '',
    attributes: LinkAttributes = {},
    key?: NodeKey,
  ) {
    super(key);
    const {target = null, rel = null, title = null} = attributes;
    this.__url = url;
    this.__target = target;
    this.__rel = rel;
    this.__title = title;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__url = prevNode.__url;
    this.__rel = prevNode.__rel;
    this.__target = prevNode.__target;
    this.__title = prevNode.__title;
  }

  createDOM(config: EditorConfig): LinkHTMLElementType {
    const element = $getDocument().createElement('a');
    this.updateLinkDOM(null, element, config);
    addClassNamesToElement(element, config.theme.link);
    return element;
  }

  updateLinkDOM(
    prevNode: this | null,
    anchor: LinkHTMLElementType,
    config: EditorConfig,
  ) {
    if (isHTMLAnchorElement(anchor)) {
      if (!prevNode || prevNode.__url !== this.__url) {
        anchor.href = this.sanitizeUrl(this.__url);
      }
      for (const attr of ['target', 'rel', 'title'] as const) {
        const key = `__${attr}` as const;
        const value = this[key];
        if (!prevNode || prevNode[key] !== value) {
          if (value) {
            anchor[attr] = value;
          } else {
            anchor.removeAttribute(attr);
          }
        }
      }
    }
  }

  updateDOM(
    prevNode: this,
    anchor: LinkHTMLElementType,
    config: EditorConfig,
  ): boolean {
    this.updateLinkDOM(prevNode, anchor, config);
    return false;
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedLinkNode>): this {
    return super
      .updateFromJSON(serializedNode)
      .setURL(serializedNode.url)
      .setRel(serializedNode.rel || null)
      .setTarget(serializedNode.target || null)
      .setTitle(serializedNode.title || null);
  }

  sanitizeUrl(url: string): string {
    const rawUrl = url;
    url = formatUrl(url);
    try {
      const parsedUrl = new URL(formatUrl(url));

      if (!SUPPORTED_URL_PROTOCOLS.has(parsedUrl.protocol)) {
        return 'about:blank';
      }
    } catch {
      // `new URL()` threw, so we could not verify the protocol via the
      // parser. Preserve fail-secure behavior: default unparseable URLs to
      // `about:blank` and only allow through inputs that positively match an
      // allowlisted scheme.
      //
      // Check the ORIGINAL input, not the `formatUrl()` output: `formatUrl()`
      // prepends `https://` to anything it does not recognize as already
      // having a scheme, which would mask a control-character-obfuscated
      // scheme (e.g. `java\x00script:` becomes `https://java\x00script:`).
      //
      // Before extracting the scheme, strip C0 control characters, DEL and
      // whitespace, mirroring how browsers ignore these when resolving a
      // scheme. Without this, control-character-obfuscated schemes that throw
      // in `new URL()` but are still navigated by some browsers would slip
      // past a naive scheme check and retain their original, attacker-
      // controlled value. Stripping C0 control characters and DEL is the
      // intended, security-relevant behavior here.
      // eslint-disable-next-line no-control-regex
      const normalizedUrl = rawUrl.replace(/[\u0000-\u001F\u007F\s]/g, '');
      const schemeMatch = normalizedUrl.match(/^([a-z][a-z0-9+.-]*):/i);
      if (
        schemeMatch != null &&
        !SUPPORTED_URL_PROTOCOLS.has(`${schemeMatch[1].toLowerCase()}:`)
      ) {
        // An explicit, non-allowlisted scheme survived normalization (e.g.
        // `javascript:`, `data:`) — neutralize it. Inputs with no scheme
        // (relative URLs such as `/path` or `#anchor`) or an allowlisted
        // scheme are left unchanged: they cannot carry a dangerous scheme
        // and are handled elsewhere.
        return 'about:blank';
      }
    }
    return url;
  }

  exportJSON(): SerializedLinkNode | SerializedAutoLinkNode {
    return {
      ...super.exportJSON(),
      rel: this.getRel(),
      target: this.getTarget(),
      title: this.getTitle(),
      url: this.getURL(),
    };
  }

  getURL(): string {
    return this.getLatest().__url;
  }

  setURL(url: string): this {
    const writable = this.getWritable();
    writable.__url = url;
    return writable;
  }

  getTarget(): null | string {
    return this.getLatest().__target;
  }

  setTarget(target: null | string): this {
    const writable = this.getWritable();
    writable.__target = target;
    return writable;
  }

  getRel(): null | string {
    return this.getLatest().__rel;
  }

  setRel(rel: null | string): this {
    const writable = this.getWritable();
    writable.__rel = rel;
    return writable;
  }

  getTitle(): null | string {
    return this.getLatest().__title;
  }

  setTitle(title: null | string): this {
    const writable = this.getWritable();
    writable.__title = title;
    return writable;
  }

  insertNewAfter(
    _: RangeSelection,
    restoreSelection = true,
  ): null | ElementNode {
    const linkNode = $copyNode(this);
    this.insertAfter(linkNode, restoreSelection);
    return linkNode;
  }

  canInsertTextBefore(): false {
    return false;
  }

  canInsertTextAfter(): false {
    return false;
  }

  canBeEmpty(): boolean {
    return false;
  }

  isInline(): true {
    return true;
  }

  extractWithChild(
    child: LexicalNode,
    selection: BaseSelection,
    destination: 'clone' | 'html',
  ): boolean {
    if (!$isRangeSelection(selection)) {
      return false;
    }

    const anchorNode = selection.anchor.getNode();
    const focusNode = selection.focus.getNode();

    return (
      (this.is(anchorNode) || this.isParentOf(anchorNode)) &&
      (this.is(focusNode) || this.isParentOf(focusNode)) &&
      selection.getTextContent().length > 0
    );
  }

  isEmailURI(): boolean {
    return this.__url.startsWith('mailto:');
  }

  isWebSiteURI(): boolean {
    return (
      this.__url.startsWith('https://') || this.__url.startsWith('http://')
    );
  }

  shouldMergeAdjacentLink(otherLink: LinkNode): boolean {
    return (
      this.getType() === otherLink.getType() &&
      this.__url === otherLink.__url &&
      this.__target === otherLink.__target &&
      this.__rel === otherLink.__rel &&
      this.__title === otherLink.__title
    );
  }
}

type CaretPair = [PointCaret<'next'>, PointCaret<'previous'>];

function $saveCaretPair(point: PointType): CaretPair {
  const next = $caretFromPoint(point, 'next');
  return [next, next.getFlipped()];
}

function $restoreCaretPair(point: PointType, pair: CaretPair): void {
  for (const caret of pair) {
    if (caret.origin.isAttached()) {
      const normalized = $normalizeCaret(caret);
      $setPointFromCaret(point, normalized);
      return;
    }
  }
}

/**
 * Extracts block-level children from a LinkNode, splitting
 * ancestor nodes as needed to maintain a valid document structure.
 * @param link - The LinkNode to normalize
 */
export function $linkNodeTransform(link: LinkNode): void {
  const selection = $getSelection();
  let anchorPair: CaretPair | null = null;
  let focusPair: CaretPair | null = null;
  if ($isRangeSelection(selection)) {
    anchorPair = $saveCaretPair(selection.anchor);
    focusPair = $saveCaretPair(selection.focus);
  }
  function $restoreSelection(): void {
    if ($isRangeSelection(selection)) {
      $restoreCaretPair(selection.anchor, anchorPair!);
      $restoreCaretPair(selection.focus, focusPair!);
      $normalizeSelection__EXPERIMENTAL(selection);
    }
  }

  let transformed = false;
  for (const caret of $getChildCaret(link, 'next')) {
    const node = caret.origin;
    if ($isElementNode(node) && !node.isInline()) {
      const blockChildren = node.getChildren();
      if (blockChildren.length > 0) {
        const innerLink = $copyNode(link);
        innerLink.append(...blockChildren);
        node.append(innerLink);
        transformed = true;
      }
      $insertNodeToNearestRootAtCaret(node, $rewindSiblingCaret(caret), {
        $shouldSplit: () => false,
      });
    }
  }
  // Fix a caret pair that points to the end of the absorbing link,
  // which would shift when new children are appended during merge.
  function $fixMergeBoundaryCaret(
    pair: CaretPair,
    absorbingLink: LinkNode,
    mergingLink: LinkNode,
  ): CaretPair {
    const [next, prev] = pair;
    const $isAffected = (caret: PointCaret) =>
      $isSiblingCaret(caret) && caret.origin.is(absorbingLink);
    if (!$isAffected(next) && !$isAffected(prev)) {
      return pair;
    }
    // Resolve the merge boundary from the merging link's start, since
    // those children survive the move and represent the boundary position.
    const fixed = $normalizeCaret($getChildCaret(mergingLink, 'next'));
    return [fixed, fixed.getFlipped()];
  }

  if (link.isAttached()) {
    const prevSibling = link.getPreviousSibling();
    if ($isLinkNode(prevSibling) && prevSibling.shouldMergeAdjacentLink(link)) {
      if (anchorPair) {
        anchorPair = $fixMergeBoundaryCaret(anchorPair, prevSibling, link);
      }
      if (focusPair) {
        focusPair = $fixMergeBoundaryCaret(focusPair, prevSibling, link);
      }
      prevSibling.append(...link.getChildren());
      link.remove();
      $restoreSelection();
      return;
    }
    const nextSibling = link.getNextSibling();
    if ($isLinkNode(nextSibling) && link.shouldMergeAdjacentLink(nextSibling)) {
      if (anchorPair) {
        anchorPair = $fixMergeBoundaryCaret(anchorPair, link, nextSibling);
      }
      if (focusPair) {
        focusPair = $fixMergeBoundaryCaret(focusPair, link, nextSibling);
      }
      link.append(...nextSibling.getChildren());
      nextSibling.remove();
      transformed = true;
    }
  }
  if (!transformed) {
    return;
  }
  if (!link.canBeEmpty() && link.isEmpty()) {
    const parent = link.getParent();
    link.remove();
    if (parent && parent.isEmpty()) {
      parent.remove();
    }
  }

  $restoreSelection();
}

function $convertAnchorElement(domNode: Node): DOMConversionOutput {
  let node = null;
  if (isHTMLAnchorElement(domNode)) {
    const content = domNode.textContent;
    if ((content !== null && content !== '') || domNode.children.length > 0) {
      node = $createLinkNode(domNode.getAttribute('href') || '', {
        rel: domNode.getAttribute('rel'),
        target: domNode.getAttribute('target'),
        title: domNode.getAttribute('title'),
      });
    }
  }
  return {node};
}

/**
 * Takes a URL and creates a LinkNode.
 * @param url - The URL the LinkNode should direct to.
 * @param attributes - Optional HTML a tag attributes \\{ target, rel, title \\}
 * @returns The LinkNode.
 */
export function $createLinkNode(
  url: string = '',
  attributes?: LinkAttributes,
): LinkNode {
  return $applyNodeReplacement(new LinkNode(url, attributes));
}

/**
 * Determines if node is a LinkNode.
 * @param node - The node to be checked.
 * @returns true if node is a LinkNode, false otherwise.
 */
export function $isLinkNode(
  node: LexicalNode | null | undefined,
): node is LinkNode {
  return node instanceof LinkNode;
}

export type SerializedAutoLinkNode = Spread<
  {
    isUnlinked: boolean;
  },
  SerializedLinkNode
>;

// Custom node type to override `canInsertTextAfter` that will
// allow typing within the link
export class AutoLinkNode extends LinkNode {
  /** @internal */
  /** Indicates whether the autolink was ever unlinked. **/
  __isUnlinked: boolean;

  constructor(
    url: string = '',
    attributes: AutoLinkAttributes = {},
    key?: NodeKey,
  ) {
    super(url, attributes, key);
    this.__isUnlinked =
      attributes.isUnlinked !== undefined && attributes.isUnlinked !== null
        ? attributes.isUnlinked
        : false;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__isUnlinked = prevNode.__isUnlinked;
  }

  $config() {
    return this.config('autolink', {extends: LinkNode});
  }

  shouldMergeAdjacentLink(_otherLink: LinkNode): boolean {
    return false;
  }

  getIsUnlinked(): boolean {
    return this.__isUnlinked;
  }

  setIsUnlinked(value: boolean): this {
    const self = this.getWritable();
    self.__isUnlinked = value;
    return self;
  }

  createDOM(config: EditorConfig): LinkHTMLElementType {
    if (this.__isUnlinked) {
      return $getDocument().createElement('span');
    } else {
      return super.createDOM(config);
    }
  }

  updateDOM(
    prevNode: this,
    anchor: LinkHTMLElementType,
    config: EditorConfig,
  ): boolean {
    return (
      super.updateDOM(prevNode, anchor, config) ||
      prevNode.__isUnlinked !== this.__isUnlinked
    );
  }

  updateFromJSON(
    serializedNode: LexicalUpdateJSON<SerializedAutoLinkNode>,
  ): this {
    return super
      .updateFromJSON(serializedNode)
      .setIsUnlinked(serializedNode.isUnlinked || false);
  }

  exportJSON(): SerializedAutoLinkNode {
    return {
      ...super.exportJSON(),
      isUnlinked: this.__isUnlinked,
    };
  }

  // insertNewAfter is deliberately not overridden: LinkNode's implementation
  // uses $copyNode, which runs clone() + afterCloneFrom() and so carries the
  // element props (format/indent/style/dir/textFormat/textStyle) and NodeState
  // as well as the link attributes. Enumerating properties by hand here
  // dropped all of those, and rebuilt the node as a base AutoLinkNode even for
  // a subclass. AutoLinkNode.afterCloneFrom already carries __isUnlinked.
}

/**
 * Takes a URL and creates an AutoLinkNode. AutoLinkNodes are generally automatically generated
 * during typing, which is especially useful when a button to generate a LinkNode is not practical.
 * @param url - The URL the LinkNode should direct to.
 * @param attributes - Optional HTML a tag attributes. \\{ target, rel, title \\}
 * @returns The LinkNode.
 */
export function $createAutoLinkNode(
  url: string = '',
  attributes?: AutoLinkAttributes,
): AutoLinkNode {
  return $applyNodeReplacement(new AutoLinkNode(url, attributes));
}

/**
 * Determines if node is an AutoLinkNode.
 * @param node - The node to be checked.
 * @returns true if node is an AutoLinkNode, false otherwise.
 */
export function $isAutoLinkNode(
  node: LexicalNode | null | undefined,
): node is AutoLinkNode {
  return node instanceof AutoLinkNode;
}

export const TOGGLE_LINK_COMMAND: LexicalCommand<
  string | ({url: string} & LinkAttributes) | null
> = /* @__PURE__ */ createCommand('TOGGLE_LINK_COMMAND');

function $getPointNode(point: Point, offset: number): LexicalNode | null {
  if (point.type === 'element') {
    const node = point.getNode();
    invariant(
      $isElementNode(node),
      '$getPointNode: element point is not an ElementNode',
    );
    const childNode = node.getChildren()[point.offset + offset];
    return childNode || null;
  }
  return null;
}

/**
 * Preserve the logical start/end of a RangeSelection in situations where
 * the point is an element that may be reparented in the callback.
 *
 * @param $fn The function to run
 * @returns The result of the callback
 */
function $withSelectedNodes<T>($fn: () => T): T {
  const initialSelection = $getSelection();
  if (!$isRangeSelection(initialSelection)) {
    return $fn();
  }
  const normalized = $normalizeSelection__EXPERIMENTAL(initialSelection);
  const isBackwards = normalized.isBackward();
  const anchorNode = $getPointNode(normalized.anchor, isBackwards ? -1 : 0);
  const focusNode = $getPointNode(normalized.focus, isBackwards ? 0 : -1);
  const rval = $fn();
  if (anchorNode || focusNode) {
    const updatedSelection = $getSelection();
    if ($isRangeSelection(updatedSelection)) {
      const finalSelection = updatedSelection.clone();
      if (anchorNode) {
        const anchorParent = anchorNode.getParent();
        if (anchorParent) {
          finalSelection.anchor.set(
            anchorParent.getKey(),
            anchorNode.getIndexWithinParent() + (isBackwards ? 1 : 0),
            'element',
          );
        }
      }
      if (focusNode) {
        const focusParent = focusNode.getParent();
        if (focusParent) {
          finalSelection.focus.set(
            focusParent.getKey(),
            focusNode.getIndexWithinParent() + (isBackwards ? 0 : 1),
            'element',
          );
        }
      }
      $setSelection($normalizeSelection__EXPERIMENTAL(finalSelection));
    }
  }
  return rval;
}

/**
 * Splits a LinkNode by removing selected children from it.
 * Handles three cases: selection at start, end, or middle of the link.
 * @param parentLink - The LinkNode to split
 * @param extractedNodes - The nodes that were extracted from the selection
 */
function $splitLinkAtSelection(
  parentLink: LinkNode,
  extractedNodes: LexicalNode[],
): void {
  const extractedKeys = new Set(
    extractedNodes.filter(n => parentLink.isParentOf(n)).map(n => n.getKey()),
  );

  const allChildren = parentLink.getChildren();
  // Check if a child is an extracted node OR contains an extracted node
  // This handles nested structures like LinkNode > HeadingNode > TextNode
  const isExtractedChild = (child: LexicalNode): boolean =>
    extractedKeys.has(child.getKey()) ||
    ($isElementNode(child) &&
      extractedNodes.some(
        n => parentLink.isParentOf(n) && child.isParentOf(n),
      ));

  const extractedChildren = allChildren.filter(isExtractedChild);

  if (extractedChildren.length === allChildren.length) {
    allChildren.forEach(child => parentLink.insertBefore(child));
    parentLink.remove();
    return;
  }

  const firstExtractedIndex = allChildren.findIndex(isExtractedChild);
  const lastExtractedIndex = allChildren.findLastIndex(isExtractedChild);

  const isAtStart = firstExtractedIndex === 0;
  const isAtEnd = lastExtractedIndex === allChildren.length - 1;

  if (isAtStart) {
    extractedChildren.forEach(child => parentLink.insertBefore(child));
  } else if (isAtEnd) {
    for (let i = extractedChildren.length - 1; i >= 0; i--) {
      parentLink.insertAfter(extractedChildren[i]);
    }
  } else {
    for (let i = extractedChildren.length - 1; i >= 0; i--) {
      parentLink.insertAfter(extractedChildren[i]);
    }

    const trailingChildren = allChildren.slice(lastExtractedIndex + 1);
    if (trailingChildren.length > 0) {
      const newLink = $copyNode(parentLink);

      extractedChildren[extractedChildren.length - 1].insertAfter(newLink);
      trailingChildren.forEach(child => newLink.append(child));
    }
  }
}

/**
 * Generates or updates a LinkNode. It can also delete a LinkNode if the URL is null,
 * but saves any children and brings them up to the parent node.
 * @param urlOrAttributes - The URL the link directs to, or an attributes object with an url property
 * @param attributes - Optional HTML a tag attributes. \\{ target, rel, title \\}
 */
export function $toggleLink(
  urlOrAttributes: null | string | (LinkAttributes & {url: null | string}),
  attributes: LinkAttributes = {},
): void {
  let url: null | string;
  if (urlOrAttributes && typeof urlOrAttributes === 'object') {
    const {url: urlProp, ...rest} = urlOrAttributes;
    url = urlProp;
    attributes = {...rest, ...attributes};
  } else {
    url = urlOrAttributes;
  }
  const {target, title} = attributes;
  const rel = attributes.rel === undefined ? 'noreferrer' : attributes.rel;
  const selection = $getSelection();

  if (
    selection === null ||
    (!$isRangeSelection(selection) && !$isNodeSelection(selection))
  ) {
    return;
  }

  if ($isNodeSelection(selection)) {
    const nodes = selection.getNodes();
    if (nodes.length === 0) {
      return;
    }

    // Handle all selected nodes
    nodes.forEach(node => {
      if (url === null) {
        // Remove link
        const linkParent = $findMatchingParent(
          node,
          (parent): parent is LinkNode =>
            !$isAutoLinkNode(parent) && $isLinkNode(parent),
        );
        if (linkParent) {
          linkParent.insertBefore(node);
          if (linkParent.getChildren().length === 0) {
            linkParent.remove();
          }
        }
      } else {
        // Add/Update link
        const existingLink = $findMatchingParent(
          node,
          (parent): parent is LinkNode =>
            !$isAutoLinkNode(parent) && $isLinkNode(parent),
        );
        if (existingLink) {
          existingLink.setURL(url);
          if (target !== undefined) {
            existingLink.setTarget(target);
          }
          if (rel !== undefined) {
            existingLink.setRel(rel);
          }
          if (title !== undefined) {
            existingLink.setTitle(title);
          }
        } else {
          const linkNode = $createLinkNode(url, {rel, target, title});
          node.insertBefore(linkNode);
          linkNode.append(node);
        }
      }
    });
    return;
  }

  if (selection.isCollapsed() && url === null) {
    for (const node of selection.getNodes()) {
      const parentLink = $findMatchingParent(
        node,
        (parent): parent is LinkNode =>
          !$isAutoLinkNode(parent) && $isLinkNode(parent),
      );
      if (parentLink !== null) {
        parentLink
          .getParentOrThrow()
          .splice(
            parentLink.getIndexWithinParent(),
            0,
            parentLink.getChildren(),
          );
        parentLink.remove();
      }
      return;
    }
  }

  // Handle RangeSelection
  const nodes = selection.extract();

  if (url === null) {
    const processedLinks = new Set<NodeKey>();

    nodes.forEach(node => {
      const parentLink = $findMatchingParent(
        node,
        (parent): parent is LinkNode =>
          !$isAutoLinkNode(parent) && $isLinkNode(parent),
      );

      if (parentLink !== null) {
        const linkKey = parentLink.getKey();

        if (processedLinks.has(linkKey)) {
          return;
        }

        $splitLinkAtSelection(parentLink, nodes);
        processedLinks.add(linkKey);
      }
    });
    return;
  }
  const updatedNodes = new Set<NodeKey>();
  const updateLinkNode = (linkNode: LinkNode) => {
    if (updatedNodes.has(linkNode.getKey())) {
      return;
    }
    updatedNodes.add(linkNode.getKey());
    linkNode.setURL(url);
    if (target !== undefined) {
      linkNode.setTarget(target);
    }
    if (rel !== undefined) {
      linkNode.setRel(rel);
    }
    if (title !== undefined) {
      linkNode.setTitle(title);
    }
  };
  // Add or merge LinkNodes
  if (nodes.length === 1) {
    const firstNode = nodes[0];
    // if the first node is a LinkNode or if its
    // parent is a LinkNode, we update the URL, target and rel.
    const linkNode = $findMatchingParent(firstNode, $isLinkNode);
    if (linkNode !== null) {
      return updateLinkNode(linkNode);
    }
  }

  $withSelectedNodes(() => {
    let linkNode: LinkNode | null = null;
    for (const node of nodes) {
      if (!node.isAttached()) {
        continue;
      }
      const parentLinkNode = $findMatchingParent(node, $isLinkNode);
      if (parentLinkNode) {
        updateLinkNode(parentLinkNode);
        continue;
      }
      if ($isElementNode(node)) {
        if (!node.isInline()) {
          // Ignore block nodes, if there are any children we will see them
          // later and wrap in a new LinkNode
          continue;
        }
        if ($isLinkNode(node)) {
          // If it's not an autolink node and we don't already have a LinkNode
          // in this block then we can update it and re-use it
          if (
            !$isAutoLinkNode(node) &&
            (linkNode === null || !linkNode.getParentOrThrow().isParentOf(node))
          ) {
            updateLinkNode(node);
            linkNode = node;
            continue;
          }
          // Unwrap LinkNode, we already have one or it's an AutoLinkNode
          for (const child of node.getChildren()) {
            node.insertBefore(child);
          }
          node.remove();
          continue;
        }
      }
      const prevLinkNode = node.getPreviousSibling();
      if ($isLinkNode(prevLinkNode) && prevLinkNode.is(linkNode)) {
        prevLinkNode.append(node);
        continue;
      }
      linkNode = $createLinkNode(url, {rel, target, title});
      node.insertAfter(linkNode);
      linkNode.append(node);
    }
  });
}

const PHONE_NUMBER_REGEX = /^\+?[0-9\s()-]{5,}$/;

/**
 * Formats a URL string by adding appropriate protocol if missing
 *
 * @param url - URL to format
 * @returns Formatted URL with appropriate protocol
 */
export function formatUrl(url: string): string {
  // Check if URL already has a protocol
  if (url.match(/^[a-z][a-z0-9+.-]*:/i)) {
    // URL already has a protocol, leave it as is
    return url;
  }
  // Check if it's a relative path (starting with '/', '.', or '#')
  else if (url.match(/^[/#.]/)) {
    // Relative path, leave it as is
    return url;
  }

  // Check for email address
  else if (url.includes('@')) {
    return `mailto:${url}`;
  }

  // Check for phone number
  else if (PHONE_NUMBER_REGEX.test(url)) {
    return `tel:${url}`;
  }

  // For everything else, return with https:// prefix
  return `https://${url}`;
}
