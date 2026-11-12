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
  $getEditor,
  $isElementNode,
  $setDirectionFromDOM,
  addClassNamesToElement,
  aliasedValue,
  buildImportMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type EditorThemeClasses,
  ElementNode,
  enumValue,
  getDeclaredNodeStructure,
  INTERNAL_isNodeStructureEnforced,
  isHTMLElement,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  type LexicalParseJSON,
  type NodeKey,
  nodeSchema,
  normalizeClassNames,
  numberValue,
  removeClassNamesFromElement,
  type SerializedElementNode,
  type SerializedPartial,
  type Spread,
  withAccessors,
  withField,
} from 'lexical';

import {$createListItemNode, $isListItemNode} from '.';
import {
  mergeNestedListsAtSeam,
  mergeNextSiblingListIfSameType,
  updateChildrenListItemValue,
} from './formatList';
import {GENERATED_LIST} from './LexicalListGeneratedJSON';
import {ListItemNode} from './LexicalListItemNode';
import {$getListDepth} from './utils';

function $structureMerges(list: ListNode): boolean {
  const klass = list.constructor as Klass<ListNode>;
  const next = list.getNextSibling();
  return (
    next !== null &&
    next.constructor === klass &&
    INTERNAL_isNodeStructureEnforced($getEditor()) &&
    getDeclaredNodeStructure(klass).declaredBy.mergeAdjacent === klass
  );
}

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

// A literal rather than a `Record<string, ListType>` so that the alias table
// below keeps its keys: they are what the schema reports as the legacy
// spellings it accepts.
const TAG_TO_LIST_TYPE = {
  ol: 'number',
  ul: 'bullet',
} as const satisfies Readonly<Record<string, ListType>>;

const listNodeSchema = nodeSchema<ListNode>()({
  // 'ul'/'ol' are the legacy tag-form listType some older documents carry,
  // stated as an alias table rather than a transform: the mapping is data, so
  // the codegen can compile this property's parse, where an arbitrary
  // function would have taken the whole class out of the import half.
  // Read straight off the field; applied through setListType, which also
  // maintains the derived __tag, so the setter stays a method.
  listType: withAccessors(
    aliasedValue(enumValue(['number', 'bullet', 'check']), TAG_TO_LIST_TYPE),
    {getter: {field: '__listType'}},
  ),
  start: withField(numberValue(1), {
    field: '__start',
  }),
  // Derived from listType rather than stored: written on export, and
  // deliberately not applied on import.
  tag: withAccessors(enumValue(['ul', 'ol']), {
    getter: {field: '__tag'},
    setter: null,
  }),
});

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ListNode {
  exportJSON(compact?: false): SerializedListNode;
  exportJSON(compact: boolean): SerializedPartial<SerializedListNode>;
  updateFromJSON(serializedNode: LexicalParseJSON<SerializedListNode>): this;
}

/** @noInheritDoc */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
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
        // Where NodeStructureExtension enforces declared structure, it merges
        // adjacent lists itself (by mergeAdjacent below, joining nested lists
        // at the seam as mergeLists does), the same way whichever list is
        // dirty.
        if (!$structureMerges(node)) {
          mergeNextSiblingListIfSameType(node);
        }
        updateChildrenListItemValue(node);
      },
      children: [ListItemNode],
      extends: ElementNode,
      generated: GENERATED_LIST,
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
      json: listNodeSchema,
      // What mergeNextSiblingListIfSameType compares (start is not).
      mergeAdjacent: {by: ['listType']},
    });
  }

  constructor(listType: ListType = 'number', start: number = 1, key?: NodeKey) {
    super(key);
    // Widened for the lookup: the parameter's type excludes the legacy tag
    // spellings, and this normalizes them for a caller that passes one anyway.
    const _listType: ListType =
      (TAG_TO_LIST_TYPE as Readonly<Record<string, ListType>>)[listType] ||
      listType;
    this.__listType = _listType;
    this.__tag = _listType === 'number' ? 'ol' : 'ul';
    this.__start = start;
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

  canBeEmpty(): false {
    return false;
  }

  /**
   * @internal Not public API: called by the node structure normalization
   * (`NodeStructureExtension`), which `lexical` implements and so cannot
   * import list code, on this list once it has merged the next one into it
   * (`last` was this list's last item, `first` the other's first): joins
   * nested lists at the seam, as mergeLists does, but only items whose only
   * child is the nested list, so that nothing else in them is removed or
   * moved.
   */
  INTERNAL_$afterStructureMerge(
    last: LexicalNode | null,
    first: LexicalNode | null,
  ): void {
    mergeNestedListsAtSeam(last, first, true);
  }

  /**
   * @internal Not public API: called by the node structure normalization
   * (`NodeStructureExtension`) on each later part of a list it splits around
   * a block it lifts out: an ordered list continues the numbering of the
   * items that precede the part, so the part starts at the next number.
   */
  INTERNAL_$afterStructureSplit(
    original: ListNode,
    preceding: readonly LexicalNode[],
  ): void {
    if (this.getListType() === 'number') {
      let start = original.getStart();
      for (const node of preceding) {
        // As updateChildrenListItemValue counts: an item that only wraps a
        // nested list has no number of its own.
        if ($isListItemNode(node) && !$isListNode(node.getFirstChild())) {
          start++;
        }
      }
      this.setStart(start);
    }
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
