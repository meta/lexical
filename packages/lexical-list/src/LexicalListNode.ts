/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $applyNodeReplacement,
  $getDocument,
  $isElementNode,
  $setDirectionFromDOM,
  addClassNamesToElement,
  buildImportMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type EditorThemeClasses,
  ElementNode,
  isHTMLElement,
  type LexicalEditor,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  normalizeClassNames,
  removeClassNamesFromElement,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

import {$createListItemNode, $isListItemNode, type ListItemNode} from '.';
import {
  mergeNextSiblingListIfSameType,
  updateChildrenListItemValue,
} from './formatList';
import {$getListDepth} from './utils';

export type SerializedListNode = Spread<
  {
    listType: ListType;
    start: number;
    tag: ListNodeTagType;
  },
  SerializedElementNode
>;

export type ListType = 'number' | 'bullet' | 'check';

export type ListNodeTagType = 'ul' | 'ol';

/** @noInheritDoc */
export class ListNode extends ElementNode {
  /** @internal */
  __tag: ListNodeTagType;
  /** @internal */
  __start: number;
  /** @internal */
  __listType: ListType;

  /** @internal */
  $config() {
    return this.config('list', {
      $transform: (node: ListNode): void => {
        mergeNextSiblingListIfSameType(node);
        updateChildrenListItemValue(node);
      },
      extends: ElementNode,
      importDOM: buildImportMap({
        ol: () => ({
          conversion: $convertListNode,
          priority: 0,
        }),
        ul: () => ({
          conversion: $convertListNode,
          priority: 0,
        }),
      }),
    });
  }

  constructor(listType: ListType = 'number', start: number = 1, key?: NodeKey) {
    super(key);
    const _listType = TAG_TO_LIST_TYPE[listType] || listType;
    this.__listType = _listType;
    this.__tag = _listType === 'number' ? 'ol' : 'ul';
    this.__start = start;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__listType = prevNode.__listType;
    this.__tag = prevNode.__tag;
    this.__start = prevNode.__start;
  }

  getTag(): ListNodeTagType {
    return this.getLatest().__tag;
  }

  setListType(type: ListType): this {
    const writable = this.getWritable();
    writable.__listType = type;
    writable.__tag = type === 'number' ? 'ol' : 'ul';
    return writable;
  }

  getListType(): ListType {
    return this.getLatest().__listType;
  }

  getStart(): number {
    return this.getLatest().__start;
  }

  setStart(start: number): this {
    const self = this.getWritable();
    self.__start = start;
    return self;
  }

  // View

  createDOM(config: EditorConfig, _editor?: LexicalEditor): HTMLElement {
    const tag = this.__tag;
    const dom = $getDocument().createElement(tag);

    if (this.__start !== 1) {
      dom.setAttribute('start', String(this.__start));
    }
    // @ts-expect-error Internal field.
    dom.__lexicalListType = this.__listType;
    $setListThemeClassNames(dom, config.theme, this);

    return dom;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    if (
      prevNode.__tag !== this.__tag ||
      prevNode.__listType !== this.__listType
    ) {
      return true;
    }

    $setListThemeClassNames(dom, config.theme, this);

    if (prevNode.__start !== this.__start) {
      dom.setAttribute('start', String(this.__start));
    }

    return false;
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedListNode>): this {
    return super
      .updateFromJSON(serializedNode)
      .setListType(serializedNode.listType)
      .setStart(serializedNode.start);
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const element = this.createDOM(editor._config, editor);
    if (isHTMLElement(element)) {
      if (this.__start !== 1) {
        element.setAttribute('start', String(this.__start));
      }
      if (this.__listType === 'check') {
        element.setAttribute('__lexicalListType', 'check');
      }
      // $convertListNode reads `dir` back off the <ol>/<ul>, so it has to be
      // written here — this override does not call super.exportDOM, which is
      // where ElementNode would otherwise emit it.
      const direction = this.getDirection();
      if (direction) {
        element.dir = direction;
      }
    }
    return {
      element,
    };
  }

  exportJSON(): SerializedListNode {
    return {
      ...super.exportJSON(),
      listType: this.getListType(),
      start: this.getStart(),
      tag: this.getTag(),
    };
  }

  canBeEmpty(): false {
    return false;
  }

  canIndent(): false {
    return false;
  }

  splice(
    start: number,
    deleteCount: number,
    nodesToInsert: LexicalNode[],
  ): this {
    let listItemNodesToInsert = nodesToInsert;
    for (let i = 0; i < nodesToInsert.length; i++) {
      const node = nodesToInsert[i];
      if (!$isListItemNode(node)) {
        if (listItemNodesToInsert === nodesToInsert) {
          listItemNodesToInsert = [...nodesToInsert];
        }
        const listItem = this.createListItemNode();
        if ($isElementNode(node) && !($isListNode(node) || node.isInline())) {
          // A block can't stay a block inside a list item, so it is unwrapped
          // into its own children — the same conversion $createListOrMerge and
          // ListItemNode.append already perform. Stringifying it with
          // getTextContent() instead would drop every text format and style and
          // replace inline nodes (links, mentions, …) with plain text.
          listItem.append(...node.getChildren());
        } else {
          listItem.append(node);
        }
        listItemNodesToInsert[i] = listItem;
      }
    }
    return super.splice(start, deleteCount, listItemNodesToInsert);
  }

  extractWithChild(child: LexicalNode): boolean {
    return $isListItemNode(child);
  }

  /**
   * Create an appropriate ListItemNode to be a child of this ListNode,
   * {@link $createListItemNode} is the default implementation.
   *
   * @returns A new ListItemNode.
   */
  createListItemNode(): ListItemNode {
    return $createListItemNode();
  }
}

function $setListThemeClassNames(
  dom: HTMLElement,
  editorThemeClasses: EditorThemeClasses,
  node: ListNode,
): void {
  const classesToAdd = [];
  const classesToRemove = [];
  const listTheme = editorThemeClasses.list;

  if (listTheme !== undefined) {
    const listLevelsClassNames = listTheme[`${node.__tag}Depth`] || [];
    const listDepth = $getListDepth(node) - 1;
    const normalizedListDepth = listDepth % listLevelsClassNames.length;
    const listLevelClassName = listLevelsClassNames[normalizedListDepth];
    const listClassName = listTheme[node.__tag];
    let nestedListClassName;
    const nestedListTheme = listTheme.nested;
    const checklistClassName = listTheme.checklist;

    if (nestedListTheme !== undefined && nestedListTheme.list) {
      nestedListClassName = nestedListTheme.list;
    }

    if (listClassName !== undefined) {
      classesToAdd.push(listClassName);
    }

    if (checklistClassName !== undefined && node.__listType === 'check') {
      classesToAdd.push(checklistClassName);
    }

    if (listLevelClassName !== undefined) {
      classesToAdd.push(...normalizeClassNames(listLevelClassName));
      for (let i = 0; i < listLevelsClassNames.length; i++) {
        if (i !== normalizedListDepth) {
          classesToRemove.push(...normalizeClassNames(listLevelsClassNames[i]));
        }
      }
    }

    if (nestedListClassName !== undefined) {
      const nestedListItemClasses = normalizeClassNames(nestedListClassName);

      if (listDepth > 1) {
        classesToAdd.push(...nestedListItemClasses);
      } else {
        classesToRemove.push(...nestedListItemClasses);
      }
    }
  }

  if (classesToRemove.length > 0) {
    removeClassNamesFromElement(dom, ...classesToRemove);
  }

  if (classesToAdd.length > 0) {
    addClassNamesToElement(dom, ...classesToAdd);
  }
}

/*
 * This function normalizes the children of a ListNode after the conversion from HTML,
 * ensuring that they are all ListItemNodes and contain either a single nested ListNode
 * or some other inline content.
 */
function $normalizeChildren(
  nodes: LexicalNode[],
  listNode: ListNode,
): ListItemNode[] {
  const $createWrapperItem = listNode.createListItemNode.bind(listNode);

  const normalizedListItems: ListItemNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if ($isListItemNode(node)) {
      normalizedListItems.push(node);
      const children = node.getChildren();
      if (children.length > 1) {
        children.forEach(child => {
          if ($isListNode(child)) {
            normalizedListItems.push($createWrapperItem().append(child));
          }
        });
      }
    } else {
      normalizedListItems.push($createWrapperItem().append(node));
    }
  }
  return normalizedListItems;
}

function isDomChecklist(domNode: HTMLElement) {
  if (
    domNode.getAttribute('__lexicallisttype') === 'check' ||
    // is github checklist
    domNode.classList.contains('contains-task-list') ||
    // is joplin checklist
    domNode.getAttribute('data-is-checklist') === '1'
  ) {
    return true;
  }
  // if children are checklist items, the node is a checklist ul. Applicable for googledoc checklist pasting.
  for (const child of domNode.childNodes) {
    if (isHTMLElement(child) && child.hasAttribute('aria-checked')) {
      return true;
    }
  }
  return false;
}

function isHTMLOListElement(node: unknown): node is HTMLOListElement {
  return isHTMLElement(node) && node.nodeName.toLowerCase() === 'ol';
}

function $convertListNode(
  domNode: HTMLOListElement | HTMLUListElement,
): DOMConversionOutput {
  let node: ListNode;
  if (isHTMLOListElement(domNode)) {
    const start = domNode.start;
    node = $createListNode('number', start);
  } else if (isDomChecklist(domNode)) {
    node = $createListNode('check');
  } else {
    node = $createListNode('bullet');
  }
  $setDirectionFromDOM(node, domNode);
  return {
    after: children => $normalizeChildren(children, node),
    node,
  };
}

const TAG_TO_LIST_TYPE: Record<string, ListType> = {
  ol: 'number',
  ul: 'bullet',
};

/**
 * Creates a ListNode of listType.
 * @param listType - The type of list to be created. Can be 'number', 'bullet', or 'check'.
 * @param start - Where an ordered list starts its count, start = 1 if left undefined.
 * @returns The new ListNode
 */
export function $createListNode(
  listType: ListType = 'number',
  start = 1,
): ListNode {
  return $applyNodeReplacement(new ListNode(listType, start));
}

/**
 * Checks to see if the node is a ListNode.
 * @param node - The node to be checked.
 * @returns true if the node is a ListNode, false otherwise.
 */
export function $isListNode(
  node: LexicalNode | null | undefined,
): node is ListNode {
  return node instanceof ListNode;
}
