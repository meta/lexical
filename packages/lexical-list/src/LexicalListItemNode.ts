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
  $copyNode,
  $createParagraphNode,
  $getDocument,
  $getSelection,
  $getSiblingCaret,
  $insertNodeToNearestRootAtCaret,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $rewindSiblingCaret,
  $setDirectionFromDOM,
  $setFormatFromDOM,
  addClassNamesToElement,
  type BaseSelection,
  buildImportMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type EditorThemeClasses,
  ElementNode,
  getStyleObjectFromCSS,
  isHTMLElement,
  type LexicalEditor,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  normalizeClassNames,
  type ParagraphNode,
  type RangeSelection,
  removeClassNamesFromElement,
  type SerializedElementNode,
  setDOMStyleFromCSS,
  type Spread,
} from 'lexical';

import {$createListNode, $isListNode, type ListNode, type ListType} from './';
import {$handleIndent, $handleOutdent, mergeLists} from './formatList';
import {$getNewListStart, $isNestedListNode} from './utils';

export type SerializedListItemNode = Spread<
  {
    checked: boolean | undefined;
    value: number;
  },
  SerializedElementNode
>;

function applyMarkerStyles(
  dom: HTMLElement,
  node: ListItemNode,
  prevNode: ListItemNode | null,
): void {
  const nextTextStyle = node.__textStyle;
  const prevTextStyle = prevNode ? prevNode.__textStyle : '';

  if (prevNode !== null && prevTextStyle === nextTextStyle) {
    return;
  }

  const styles: Record<string, string> = getStyleObjectFromCSS(nextTextStyle);
  for (const k in styles) {
    dom.style.setProperty(`--listitem-marker-${k}`, styles[k]);
  }

  if (prevTextStyle !== '') {
    for (const k in getStyleObjectFromCSS(prevTextStyle)) {
      if (!(k in styles)) {
        dom.style.removeProperty(`--listitem-marker-${k}`);
      }
    }
  }
}

/** @noInheritDoc */
export class ListItemNode extends ElementNode {
  /** @internal */
  __value: number;
  /** @internal */
  __checked?: boolean;

  /** @internal */
  $config() {
    return this.config('listitem', {
      $transform: (node: ListItemNode): void => {
        const parent = node.getParent();
        if ($isListNode(parent)) {
          if (parent.getListType() !== 'check' && node.getChecked() != null) {
            node.setChecked(undefined);
          }
        } else if (parent) {
          const newParent = node.createParentElementNode();
          invariant(
            $isListNode(newParent),
            'ListItemNode.createParentElementNode() must return a ListNode',
          );
          // Insert an empty ListNode at the orphan's position, splitting
          // any enclosing non-shadow-root blocks so the ListNode lifts to
          // a valid container before we move the orphan in. The ListNode
          // $transform merges adjacent same-type lists, so neighbouring
          // orphans will coalesce once their own transforms run.
          const children = [node];
          for (const dir of ['previous', 'next'] as const) {
            children.reverse();
            for (const {origin} of $getSiblingCaret(node, dir)) {
              if (!$isListItemNode(origin)) {
                break;
              }
              children.push(origin);
            }
          }
          node.insertBefore(newParent);
          newParent.splice(0, 0, children);
          if (!$isRootOrShadowRoot(parent)) {
            $insertNodeToNearestRootAtCaret(
              newParent,
              $rewindSiblingCaret($getSiblingCaret(newParent, 'next')),
              {$shouldSplit: () => false, removeEmptyDestination: true},
            );
            if (parent.isEmpty() && parent.isAttached()) {
              parent.remove();
            }
          }
        }
      },
      extends: ElementNode,
      importDOM: buildImportMap({
        li: () => ({
          conversion: $convertListItemElement,
          priority: 0,
        }),
      }),
    });
  }

  constructor(
    value: number = 1,
    checked: undefined | boolean = undefined,
    key?: NodeKey,
  ) {
    super(key);
    this.__value = value === undefined ? 1 : value;
    this.__checked = checked;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__value = prevNode.__value;
    this.__checked = prevNode.__checked;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = $getDocument().createElement('li');
    this.updateListItemDOM(null, element, config);

    return element;
  }

  updateListItemDOM(
    prevNode: ListItemNode | null,
    dom: HTMLLIElement,
    config: EditorConfig,
  ) {
    updateListItemChecked(dom, this, prevNode);

    dom.value = this.__value;
    $setListItemThemeClassNames(dom, config.theme, this);
    const prevStyle = prevNode ? prevNode.__style : '';
    const nextStyle = this.__style;

    if (prevStyle !== nextStyle) {
      setDOMStyleFromCSS(dom.style, nextStyle, prevStyle);
    }
    applyMarkerStyles(dom, this, prevNode);
  }

  updateDOM(
    prevNode: ListItemNode,
    dom: HTMLElement,
    config: EditorConfig,
  ): boolean {
    // @ts-expect-error - this is always HTMLListItemElement
    const element: HTMLLIElement = dom;
    this.updateListItemDOM(prevNode, element, config);
    return false;
  }

  updateFromJSON(
    serializedNode: LexicalUpdateJSON<SerializedListItemNode>,
  ): this {
    return super
      .updateFromJSON(serializedNode)
      .setValue(serializedNode.value)
      .setChecked(serializedNode.checked);
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const element = this.createDOM(editor._config);

    const formatType = this.getFormatType();
    if (formatType) {
      element.style.textAlign = formatType;
    }

    const direction = this.getDirection();
    if (direction) {
      element.dir = direction;
    }

    if ($isNestedListNode(this)) {
      return {
        after(containerElement) {
          if (isHTMLElement(containerElement)) {
            const prevSibling = containerElement.previousElementSibling;
            if (isHTMLElement(prevSibling) && prevSibling.nodeName === 'LI') {
              while (containerElement.firstChild) {
                prevSibling.append(containerElement.firstChild);
              }
              containerElement.remove();
            }
          }
          return containerElement;
        },
        element,
      };
    }

    return {
      element,
    };
  }

  exportJSON(): SerializedListItemNode {
    return {
      ...super.exportJSON(),
      checked: this.getChecked(),
      value: this.getValue(),
    };
  }

  append(...nodes: LexicalNode[]): this {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];

      if ($isElementNode(node) && this.canMergeWith(node)) {
        const children = node.getChildren();
        this.append(...children);
        node.remove();
      } else {
        super.append(node);
      }
    }

    return this;
  }

  replace<N extends LexicalNode>(
    replaceWithNode: N,
    includeChildren?: boolean,
  ): N {
    if ($isListItemNode(replaceWithNode)) {
      return super.replace(replaceWithNode);
    }
    this.setIndent(0);
    const list = this.getParentOrThrow();
    if (!$isListNode(list)) {
      return replaceWithNode;
    }
    if (list.__first === this.getKey()) {
      list.insertBefore(replaceWithNode);
    } else if (list.__last === this.getKey()) {
      list.insertAfter(replaceWithNode);
    } else {
      // Split the list
      const newList = $copyNode(list);
      let nextSibling = this.getNextSibling();
      while (nextSibling) {
        const nodeToAppend = nextSibling;
        nextSibling = nextSibling.getNextSibling();
        newList.append(nodeToAppend);
      }
      list.insertAfter(replaceWithNode);
      replaceWithNode.insertAfter(newList);
    }
    const toReplaceKey = this.__key;
    let prevSizeBeforeChildrenTransfer = 0;
    if (includeChildren) {
      invariant(
        $isElementNode(replaceWithNode),
        'includeChildren should only be true for ElementNodes',
      );
      prevSizeBeforeChildrenTransfer = replaceWithNode.getChildrenSize();
      replaceWithNode.splice(
        prevSizeBeforeChildrenTransfer,
        0,
        this.getChildren(),
      );
    }
    // The base LexicalNode.replace remaps element-anchored selection points
    // from the replaced node to the replacement, but this override skips
    // super and the trailing this.remove() would otherwise drop selection
    // onto a sibling list item via moveSelectionPointToSibling. Mirror the
    // base behavior here for the element-anchored case.
    if (includeChildren && $isElementNode(replaceWithNode)) {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        for (const point of selection.getStartEndPoints()) {
          if (point.key === toReplaceKey && point.type === 'element') {
            point.set(
              replaceWithNode.getKey(),
              prevSizeBeforeChildrenTransfer + point.offset,
              'element',
            );
          }
        }
      }
    }
    this.remove();
    if (list.getChildrenSize() === 0) {
      list.remove();
    }
    return replaceWithNode;
  }

  insertAfter(node: LexicalNode, restoreSelection = true): LexicalNode {
    const listNode = this.getParentOrThrow();

    if (!$isListNode(listNode)) {
      invariant(
        false,
        'insertAfter: list node is not parent of list item node',
      );
    }

    if ($isListItemNode(node)) {
      return super.insertAfter(node, restoreSelection);
    }

    const siblings = this.getNextSiblings();

    // Split the lists and insert the node in between them
    listNode.insertAfter(node, restoreSelection);

    if (siblings.length !== 0) {
      const newListNode = $copyNode(listNode);
      // $copyNode carries the original list's start, which would restart the
      // numbering at the split. The items moving into the new list keep the
      // numbers they were already rendered with, so the new list has to start
      // from the first of them (see issue #7032).
      const firstSibling = siblings[0];
      if (
        newListNode.getListType() === 'number' &&
        $isListItemNode(firstSibling)
      ) {
        newListNode.setStart($getNewListStart(listNode, firstSibling));
      }

      siblings.forEach(sibling => newListNode.append(sibling));

      node.insertAfter(newListNode, restoreSelection);
    }

    return node;
  }

  remove(preserveEmptyParent?: boolean): void {
    const prevSibling = this.getPreviousSibling();
    const nextSibling = this.getNextSibling();
    super.remove(preserveEmptyParent);

    if (
      prevSibling &&
      nextSibling &&
      $isNestedListNode(prevSibling) &&
      $isNestedListNode(nextSibling) &&
      // Only join the surrounding sublists when they are the same kind of
      // list, otherwise the second one loses its listType.
      prevSibling.getFirstChild().getListType() ===
        nextSibling.getFirstChild().getListType()
    ) {
      mergeLists(prevSibling.getFirstChild(), nextSibling.getFirstChild());
      nextSibling.remove();
    }
  }

  resetOnCopyNodeFrom(original: this): void {
    super.resetOnCopyNodeFrom(original);
    if (original.getChecked()) {
      this.setChecked(false);
    }
  }

  insertNewAfter(
    _: RangeSelection,
    restoreSelection = true,
  ): ListItemNode | ParagraphNode {
    const newElement = $copyNode(this);

    this.insertAfter(newElement, restoreSelection);

    return newElement;
  }

  collapseAtStart(selection: RangeSelection): boolean {
    if ($isNestedListNode(this)) {
      return false;
    }

    const listNode = this.getParentOrThrow();
    const listNodeParent = listNode.getParentOrThrow();

    if ($isListItemNode(listNodeParent)) {
      $handleOutdent(this);
      return true;
    }

    const paragraph = $createParagraphNode().append(...this.getChildren());

    const nextSiblings = this.getNextSiblings();
    if (nextSiblings.length > 0) {
      const newList = $copyNode(listNode);
      newList.append(...nextSiblings);
      listNode.insertAfter(newList);
    }
    listNode.insertAfter(paragraph);
    this.remove();
    if (listNode.getChildrenSize() === 0) {
      listNode.remove();
    }
    paragraph.selectStart();

    return true;
  }

  getValue(): number {
    const self = this.getLatest();

    return self.__value;
  }

  setValue(value: number): this {
    const self = this.getWritable();
    self.__value = value;
    return self;
  }

  getChecked(): boolean | undefined {
    const self = this.getLatest();

    let listType: ListType | undefined;

    const parent = this.getParent();
    if ($isListNode(parent)) {
      listType = parent.getListType();
    }

    return listType === 'check' ? Boolean(self.__checked) : undefined;
  }

  setChecked(checked?: boolean): this {
    const self = this.getWritable();
    self.__checked = checked;
    return self;
  }

  toggleChecked(): this {
    const self = this.getWritable();
    return self.setChecked(!self.__checked);
  }

  getIndent(): number {
    // If we don't have a parent, we are likely serializing
    const parent = this.getParent();
    if (parent === null || !this.isAttached()) {
      return this.getLatest().__indent;
    }
    // ListItemNode should always have a ListNode for a parent.
    let listNodeParent = parent.getParentOrThrow();
    let indentLevel = 0;
    while ($isListItemNode(listNodeParent)) {
      listNodeParent = listNodeParent.getParentOrThrow().getParentOrThrow();
      indentLevel++;
    }

    return indentLevel;
  }

  setIndent(indent: number): this {
    invariant(typeof indent === 'number', 'Invalid indent value.');
    indent = Math.floor(indent);
    invariant(indent >= 0, 'Indent value must be non-negative.');
    let currentIndent = this.getIndent();
    while (currentIndent !== indent) {
      if (currentIndent < indent) {
        $handleIndent(this);
        currentIndent++;
      } else {
        $handleOutdent(this);
        currentIndent--;
      }
    }

    return this;
  }

  /** @deprecated @internal */
  canInsertAfter(node: LexicalNode): boolean {
    return $isListItemNode(node);
  }

  /** @deprecated @internal */
  canReplaceWith(replacement: LexicalNode): boolean {
    return $isListItemNode(replacement);
  }

  canMergeWith(node: LexicalNode): boolean {
    return $isListItemNode(node) || $isParagraphNode(node);
  }

  extractWithChild(child: LexicalNode, selection: BaseSelection): boolean {
    if (!$isRangeSelection(selection)) {
      return false;
    }

    const anchorNode = selection.anchor.getNode();
    const focusNode = selection.focus.getNode();

    return (
      this.isParentOf(anchorNode) &&
      this.isParentOf(focusNode) &&
      this.getTextContent().length === selection.getTextContent().length
    );
  }

  isParentRequired(): true {
    return true;
  }

  createParentElementNode(): ListNode {
    return $createListNode('bullet');
  }

  canMergeWhenEmpty(): true {
    return true;
  }
}

function $setListItemThemeClassNames(
  dom: HTMLElement,
  editorThemeClasses: EditorThemeClasses,
  node: ListItemNode,
): void {
  const listTheme = editorThemeClasses.list;
  if (!listTheme) {
    return;
  }

  const listItemClassName = listTheme.listitem;
  const nestedListItemClassName = listTheme.nested && listTheme.nested.listitem;
  const parentNode = node.getParent();
  const isCheckList =
    $isListNode(parentNode) && parentNode.getListType() === 'check';
  const checked = node.getChecked();
  const isNested = node.getChildren().some(child => $isListNode(child));

  // Always remove the variable theme classes first so that the className
  // string stays in a canonical order regardless of how the dom got here
  // (fresh create vs. cross-parent reuse). classList.remove on a missing
  // class is a no-op, so this is safe even on a freshly-created element.
  const classesToRemove: string[] = [];
  if (listTheme.listitemChecked !== undefined) {
    classesToRemove.push(listTheme.listitemChecked);
  }
  if (listTheme.listitemUnchecked !== undefined) {
    classesToRemove.push(listTheme.listitemUnchecked);
  }
  if (nestedListItemClassName !== undefined) {
    classesToRemove.push(...normalizeClassNames(nestedListItemClassName));
  }
  if (classesToRemove.length > 0) {
    removeClassNamesFromElement(dom, ...classesToRemove);
  }

  const classesToAdd: string[] = [];
  if (listItemClassName !== undefined) {
    classesToAdd.push(...normalizeClassNames(listItemClassName));
  }
  if (isCheckList) {
    const checkClassName = checked
      ? listTheme.listitemChecked
      : listTheme.listitemUnchecked;
    if (checkClassName !== undefined) {
      classesToAdd.push(checkClassName);
    }
  }
  if (nestedListItemClassName !== undefined && isNested) {
    classesToAdd.push(...normalizeClassNames(nestedListItemClassName));
  }
  if (classesToAdd.length > 0) {
    addClassNamesToElement(dom, ...classesToAdd);
  }
}

function updateListItemChecked(
  dom: HTMLElement,
  listItemNode: ListItemNode,
  prevListItemNode: ListItemNode | null,
): void {
  const parent = listItemNode.getParent();
  const isCheckbox =
    $isListNode(parent) &&
    parent.getListType() === 'check' &&
    // Only add attributes for leaf list items
    !$isListNode(listItemNode.getFirstChild());
  if (!isCheckbox) {
    dom.removeAttribute('role');
    dom.removeAttribute('tabIndex');
    dom.removeAttribute('aria-checked');
  } else {
    dom.setAttribute('role', 'checkbox');
    dom.setAttribute('tabIndex', '-1');
    dom.setAttribute(
      'aria-checked',
      listItemNode.getChecked() ? 'true' : 'false',
    );
  }
}

function $convertListItemElement(domNode: HTMLElement): DOMConversionOutput {
  const isGitHubCheckList = domNode.classList.contains('task-list-item');
  if (isGitHubCheckList) {
    for (const child of domNode.children) {
      if (child.tagName === 'INPUT') {
        return $convertCheckboxInput(child);
      }
    }
  }

  const isJoplinCheckList = domNode.classList.contains('joplin-checkbox');
  if (isJoplinCheckList) {
    for (const child of domNode.children) {
      if (
        child.classList.contains('checkbox-wrapper') &&
        child.children.length > 0 &&
        child.children[0].tagName === 'INPUT'
      ) {
        return $convertCheckboxInput(child.children[0]);
      }
    }
  }

  const ariaCheckedAttr = domNode.getAttribute('aria-checked');
  const checked =
    ariaCheckedAttr === 'true'
      ? true
      : ariaCheckedAttr === 'false'
        ? false
        : undefined;

  const node = $createListItemNode(checked);
  $setFormatFromDOM(node, domNode);

  return {
    after: setFormatFromChildren.bind(null, node),
    node: $setDirectionFromDOM(node, domNode),
  };
}

function $convertCheckboxInput(domNode: Element): DOMConversionOutput {
  const isCheckboxInput = domNode.getAttribute('type') === 'checkbox';
  if (!isCheckboxInput) {
    return {node: null};
  }
  const checked = domNode.hasAttribute('checked');
  const node = $createListItemNode(checked);
  return {after: setFormatFromChildren.bind(null, node), node};
}

function setFormatFromChildren(
  listItemNode: ListItemNode,
  children: LexicalNode[],
): LexicalNode[] {
  const firstChild = children[0];
  // google doc sets the alignment of the <p> tag inside the <li>
  if (
    children.length === 1 &&
    $isParagraphNode(firstChild) &&
    !listItemNode.getFormatType() &&
    firstChild.getFormatType()
  ) {
    listItemNode.setFormat(firstChild.getFormatType());
    return firstChild.getChildren();
  }
  return children;
}

/**
 * Creates a new List Item node, passing true/false will convert it to a checkbox input.
 * @param checked - Is the List Item a checkbox and, if so, is it checked? undefined/null: not a checkbox, true/false is a checkbox and checked/unchecked, respectively.
 * @returns The new List Item.
 */
export function $createListItemNode(checked?: boolean): ListItemNode {
  return $applyNodeReplacement(new ListItemNode(undefined, checked));
}

/**
 * Checks to see if the node is a ListItemNode.
 * @param node - The node to be checked.
 * @returns true if the node is a ListItemNode, false otherwise.
 */
export function $isListItemNode(
  node: LexicalNode | null | undefined,
): node is ListItemNode {
  return node instanceof ListItemNode;
}
