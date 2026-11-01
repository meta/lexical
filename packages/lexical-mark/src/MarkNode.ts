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
  $isRangeSelection,
  addClassNamesToElement,
  arrayValue,
  type BaseSelection,
  type EditorConfig,
  ElementNode,
  type LexicalNode,
  type LexicalParseJSON,
  type NodeKey,
  nodeSchema,
  type RangeSelection,
  removeClassNamesFromElement,
  type SerializedElementNode,
  type SerializedPartial,
  type Spread,
  stringValue,
  withAccessors,
} from 'lexical';

import {GENERATED_MARK} from './LexicalMarkGeneratedJSON';

export type SerializedMarkNode = Spread<
  {
    ids: string[];
  },
  SerializedElementNode
>;

// Single source of truth for parsing the node-specific properties of a
// SerializedMarkNode (those it adds over a SerializedElementNode).
const markNodeSchema = nodeSchema<MarkNode>()({
  // The getter stays a method: getIDs hands out a copy, so the export does not
  // give a caller the node's own array. The setter is the field it writes,
  // which is also what tells the clone where `ids` lives.
  ids: withAccessors(arrayValue(stringValue()), {
    getter: 'getIDs',
    setter: {field: '__ids', method: 'setIDs'},
  }),
});

const NO_IDS: readonly string[] = [];

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface MarkNode {
  exportJSON(compact?: false): SerializedMarkNode;
  exportJSON(compact: boolean): SerializedPartial<SerializedMarkNode>;
  updateFromJSON(serializedNode: LexicalParseJSON<SerializedMarkNode>): this;
}

/** @noInheritDoc */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class MarkNode extends ElementNode {
  /** @internal */
  __ids: readonly string[];

  $config() {
    return this.config('mark', {
      children: 'inline',
      extends: ElementNode,
      generated: GENERATED_MARK,
      inline: true,
      json: markNodeSchema,
    });
  }

  constructor(ids: readonly string[] = NO_IDS, key?: NodeKey) {
    super(key);
    this.__ids = ids;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = $getDocument().createElement('mark');
    addClassNamesToElement(element, config.theme.mark);
    if (this.__ids.length > 1) {
      addClassNamesToElement(element, config.theme.markOverlap);
    }
    return element;
  }

  updateDOM(
    prevNode: this,
    element: HTMLElement,
    config: EditorConfig,
  ): boolean {
    const prevIDs = prevNode.__ids;
    const nextIDs = this.__ids;
    const prevIDsCount = prevIDs.length;
    const nextIDsCount = nextIDs.length;
    const overlapTheme = config.theme.markOverlap;

    // Mirror createDOM's rule (`ids.length > 1` carries the overlap class)
    // rather than enumerating transitions: only 1 -> 2 and N -> 1 used to be
    // handled, so e.g. 1 -> 3 never gained the class and 2 -> 0 never lost it.
    const hadOverlap = prevIDsCount > 1;
    const hasOverlap = nextIDsCount > 1;
    if (hadOverlap !== hasOverlap) {
      if (hasOverlap) {
        addClassNamesToElement(element, overlapTheme);
      } else {
        removeClassNamesFromElement(element, overlapTheme);
      }
    }
    return false;
  }

  hasID(id: string): boolean {
    return this.getIDs().includes(id);
  }

  getIDs(): string[] {
    return Array.from(this.getLatest().__ids);
  }

  setIDs(ids: readonly string[]): this {
    const self = this.getWritable();
    self.__ids = ids;
    return self;
  }

  addID(id: string): this {
    const self = this.getWritable();
    return self.__ids.includes(id) ? self : self.setIDs([...self.__ids, id]);
  }

  deleteID(id: string): this {
    const self = this.getWritable();
    const idx = self.__ids.indexOf(id);
    if (idx === -1) {
      return self;
    }
    const ids = Array.from(self.__ids);
    ids.splice(idx, 1);
    return self.setIDs(ids);
  }

  insertNewAfter(
    selection: RangeSelection,
    restoreSelection = true,
  ): null | ElementNode {
    const markNode = $createMarkNode(this.__ids);
    this.insertAfter(markNode, restoreSelection);
    return markNode;
  }

  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return false;
  }

  canBeEmpty(): false {
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
    if (!$isRangeSelection(selection) || destination === 'html') {
      return false;
    }
    const anchor = selection.anchor;
    const focus = selection.focus;
    const anchorNode = anchor.getNode();
    const focusNode = focus.getNode();
    const isBackward = selection.isBackward();
    const selectionLength = isBackward
      ? anchor.offset - focus.offset
      : focus.offset - anchor.offset;
    return (
      this.isParentOf(anchorNode) &&
      this.isParentOf(focusNode) &&
      this.getTextContent().length === selectionLength
    );
  }

  excludeFromCopy(destination: 'clone' | 'html'): boolean {
    return destination !== 'clone';
  }
}

export function $createMarkNode(ids: readonly string[] = NO_IDS): MarkNode {
  return $applyNodeReplacement(new MarkNode(ids));
}

export function $isMarkNode(node: LexicalNode | null): node is MarkNode {
  return node instanceof MarkNode;
}
