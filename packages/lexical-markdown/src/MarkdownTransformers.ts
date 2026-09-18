/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode, $isCodeNode, CodeNode} from '@lexical/code-core';
import {
  $createLinkNode,
  $isAutoLinkNode,
  $isLinkNode,
  LinkNode,
} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
  type ListType,
} from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
  HeadingNode,
  type HeadingTagType,
  QuoteNode,
} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createTextNode,
  $findMatchingParent,
  $getState,
  $isLineBreakNode,
  $isTextNode,
  $setState,
  type BaseSelection,
  createState,
  type ElementNode,
  type Klass,
  type LexicalNode,
  type LineBreakNode,
  type TextFormatType,
  type TextNode,
} from 'lexical';

import {isEmptyParagraph, unescapeText} from './utils';

export type Transformer =
  | ElementTransformer
  | MultilineElementTransformer
  | TextFormatTransformer
  | TextMatchTransformer;

export type ElementTransformer = {
  dependencies: Klass<LexicalNode>[];
  /**
   * `export` is called when the `$convertToMarkdownString` is called to convert the editor state into markdown.
   *
   * @param selection - Optional selection to filter exported content. When provided, only selected content should be included.
   * @return return null to cancel the export, even though the regex matched. Lexical will then search for the next transformer.
   */
  export: (
    node: LexicalNode,
    // eslint-disable-next-line no-shadow
    traverseChildren: (node: ElementNode) => string,
    selection?: BaseSelection | null,
  ) => string | null;
  regExp: RegExp;
  /**
   * `replace` is called when markdown is imported or typed in the editor
   *
   * @return return false to cancel the transform, even though the regex matched. Lexical will then search for the next transformer.
   */
  replace: (
    parentNode: ElementNode,
    children: LexicalNode[],
    match: string[],
    /**
     * Whether the match is from an import operation (e.g. through `$convertFromMarkdownString`) or not (e.g. through typing in the editor).
     */
    isImport: boolean,
  ) => boolean | void;
  type: 'element';
  /**
   * When set, `registerMarkdownShortcuts` may run this transformer from `KEY_ENTER_COMMAND`
   * at end-of-line without requiring a trailing space (the update listener still uses the
   * space after the markdown token). Omit or false to disable Enter-triggered shortcuts.
   */
  triggerOnEnter?: boolean;
};

export type MultilineElementTransformer = {
  /**
   * Use this function to manually handle the import process, once the `regExpStart` has matched successfully.
   * Without providing this function, the default behavior is to match until `regExpEnd` is found, or until the end of the document if `regExpEnd.optional` is true.
   *
   * @returns a tuple or null. The first element of the returned tuple is a boolean indicating if a multiline element was imported. The second element is the index of the last line that was processed. If null is returned, the next multilineElementTransformer will be tried. If undefined is returned, the default behavior will be used.
   */
  handleImportAfterStartMatch?: (args: {
    lines: string[];
    rootNode: ElementNode;
    startLineIndex: number;
    startMatch: RegExpMatchArray;
    transformer: MultilineElementTransformer;
  }) => [boolean, number] | null | undefined;
  dependencies: Klass<LexicalNode>[];
  /**
   * `export` is called when the `$convertToMarkdownString` is called to convert the editor state into markdown.
   *
   * @param selection - Optional selection to filter exported content. When provided, only selected content should be included.
   * @return return null to cancel the export, even though the regex matched. Lexical will then search for the next transformer.
   */
  export?: (
    node: LexicalNode,
    // eslint-disable-next-line no-shadow
    traverseChildren: (node: ElementNode) => string,
    selection?: BaseSelection | null,
  ) => string | null;
  /**
   * This regex determines when to start matching
   */
  regExpStart: RegExp;
  /**
   * This regex determines when to stop matching. Anything in between regExpStart and regExpEnd will be matched
   */
  regExpEnd?:
    | RegExp
    | {
        /**
         * Whether the end match is optional. If true, the end match is not required to match for the transformer to be triggered.
         * The entire text from regexpStart to the end of the document will then be matched.
         */
        optional?: true;
        regExp: RegExp;
      };
  /**
   * `replace` is called only when markdown is imported in the editor, not when it's typed
   *
   * @return return false to cancel the transform, even though the regex matched. Lexical will then search for the next transformer.
   */
  replace: (
    rootNode: ElementNode,
    /**
     * During markdown shortcut transforms, children nodes may be provided to the transformer. If this is the case, no `linesInBetween` will be provided and
     * the children nodes should be used instead of the `linesInBetween` to create the new node.
     */
    children: LexicalNode[] | null,
    startMatch: string[],
    endMatch: string[] | null,
    /**
     * linesInBetween includes the text between the start & end matches, split up by lines, not including the matches themselves.
     * This is null when the transformer is triggered through markdown shortcuts (by typing in the editor)
     */
    linesInBetween: string[] | null,
    /**
     * Whether the match is from an import operation (e.g. through `$convertFromMarkdownString`) or not (e.g. through typing in the editor).
     */
    isImport: boolean,
  ) => boolean | void;
  type: 'multiline-element';
};

export type TextFormatTransformer = Readonly<{
  format: readonly TextFormatType[];
  tag: string;
  intraword?: boolean;
  type: 'text-format';
}>;

export type TextMatchTransformer = Readonly<{
  dependencies: Klass<LexicalNode>[];
  /**
   * Determines how a node should be exported to markdown
   */
  export?: (
    node: LexicalNode,
    // eslint-disable-next-line no-shadow
    exportChildren: (node: ElementNode) => string,
    // eslint-disable-next-line no-shadow
    exportFormat: (node: TextNode, textContent: string) => string,
  ) => string | null;
  /**
   * This regex determines what text is matched during markdown imports
   */
  importRegExp?: RegExp;
  /**
   * This regex determines what text is matched for markdown shortcuts while typing in the editor
   */
  regExp: RegExp;
  /**
   * Determines how the matched markdown text should be transformed into a node during the markdown import process
   *
   * @returns nothing, or a TextNode that may be a child of the new node that is created.
   * If a TextNode is returned, text format matching will be applied to it (e.g. bold, italic, etc.)
   */
  replace?: (node: TextNode, match: RegExpMatchArray) => void | TextNode;
  /**
   * For import operations, this function can be used to determine the end index of the match, after `importRegExp` has matched.
   * Without this function, the end index will be determined by the length of the match from `importRegExp`. Manually determining the end index can be useful if
   * the match from `importRegExp` is not the entire text content of the node. That way, `importRegExp` can be used to match only the start of the node, and `getEndIndex`
   * can be used to match the end of the node.
   *
   * @returns The end index of the match, or false if the match was unsuccessful and a different transformer should be tried.
   */
  getEndIndex?: (node: TextNode, match: RegExpMatchArray) => number | false;
  /**
   * Single character that allows the transformer to trigger when typed in the editor. This does not affect markdown imports outside of the markdown shortcut plugin.
   * If the trigger is matched, the `regExp` will be used to match the text in the second step.
   */
  trigger?: string;
  type: 'text-match';
}>;

const ORDERED_LIST_REGEX = /^(\s*)(\d{1,})\.\s/;
const UNORDERED_LIST_REGEX = /^(\s*)[-*+]\s/;
const CHECK_LIST_REGEX = /^(\s*)(?:[-*+]\s)?\s?(\[(\s|x)?\])\s/i;
const HEADING_REGEX = /^(#{1,6})\s/;
const QUOTE_REGEX = /^>\s/;
const CODE_START_REGEX = /^([ \t]*`{3,})([\w-]+)?[ \t]?/;
const CODE_END_REGEX = /^[ \t]*`{3,}$/;
const CODE_SINGLE_LINE_REGEX =
  /^[ \t]*```[^`]+(?:(?:`{1,2}|`{4,})[^`]+)*```(?:[^`]|$)/;
const TABLE_ROW_REG_EXP = /^(?:\|)(.+)(?:\|)\s?$/;

/**
 * Whether `line` is a Markdown table delimiter row such as `| --- | :--: |`.
 *
 * This is the linear-time equivalent of `/^(\| ?:?-*:? ?)+\|\s?$/`. That
 * pattern nests `-*` inside a `(...)+` group, a shape that backtracking regexp
 * engines (e.g. Safari/JavaScriptCore) may run in super-linear time. A manual
 * scan is guaranteed O(n).
 */
export function isTableRowDivider(line: string): boolean {
  // Must start with a leading pipe.
  if (line[0] !== '|') {
    return false;
  }
  const {length} = line;
  let i = 1;
  let cells = 0;
  // Each iteration consumes one ` ?:?-*:? ?\|` cell-and-pipe unit. Cell
  // characters (space, colon, dash) are disjoint from the `|` delimiter, so a
  // greedy scan never needs to backtrack.
  while (i < length) {
    let j = i;
    if (line[j] === ' ') {
      j++;
    }
    if (line[j] === ':') {
      j++;
    }
    while (line[j] === '-') {
      j++;
    }
    if (line[j] === ':') {
      j++;
    }
    if (line[j] === ' ') {
      j++;
    }
    if (line[j] !== '|') {
      break;
    }
    cells++;
    i = j + 1;
  }
  // Require at least one cell, then an optional single trailing whitespace
  // character (`\s?`) before the end of the line (`$`).
  return (
    cells > 0 && (i === length || (i === length - 1 && /\s/.test(line[i])))
  );
}
const TAG_START_REGEX = /^<[a-z_][\w-]*(?:\s[^<>]*)?\/?>/i;
const TAG_END_REGEX = /^<\/[a-z_][\w-]*\s*>/i;
const ENDS_WITH = (regex: RegExp) =>
  new RegExp(`(?:${regex.source})$`, regex.flags);

export const listMarkerState = createState('mdListMarker', {
  parse: v => (typeof v === 'string' && /^[-*+]$/.test(v) ? v : '-'),
  resetOnCopyNode: true,
});

export const codeFenceState = createState('mdCodeFence', {
  parse: val => {
    if (typeof val === 'string' && /^`{3,}$/.test(val)) {
      return val;
    }
    return '```';
  },
  resetOnCopyNode: true,
});

/**
 * The info-string tail after a fenced code block's language (e.g. `title="x"`
 * in ```` ```js title="x" ````). `CodeNode` models only the language, so the
 * rest is kept here to survive the round trip.
 */
export const codeMetaState = createState('mdCodeMeta', {
  parse: val => (typeof val === 'string' ? val : ''),
  resetOnCopyNode: true,
});

export type MarkdownHardLineBreak = string;

export const hardLineBreakState = createState('mdHardLineBreak', {
  parse: (val): MarkdownHardLineBreak => {
    if (typeof val === 'string' && /^(\\| {2,})$/.test(val)) {
      return val;
    }
    return '';
  },
  resetOnCopyNode: true,
});

export function parseMarkdownHardLineBreak(
  line: string,
): [string, MarkdownHardLineBreak] | null {
  if (line.endsWith('\\')) {
    // A trailing backslash is a hard line break only when it is not itself
    // escaped. `foo\\` is an escaped backslash — a literal `\` followed by an
    // ordinary (soft) line ending — so only an odd-length run counts.
    // https://spec.commonmark.org/0.31.2/#backslash-escapes
    let backslashes = 0;
    for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) {
      backslashes++;
    }
    return backslashes % 2 === 1 ? [line.slice(0, -1), '\\'] : null;
  }

  const spaces = line.match(/^(.*?\S)( {2,})$/);
  return spaces ? [spaces[1], spaces[2]] : null;
}

function hasNonWhitespaceContentOnLine(
  children: LexicalNode[],
  endIndex: number,
): boolean {
  for (let i = endIndex - 1; i >= 0; i--) {
    if ($isLineBreakNode(children[i])) {
      return false;
    }
    if (/\S/.test(children[i].getTextContent())) {
      return true;
    }
  }
  return false;
}

function $extractMarkdownHardLineBreakMarker(
  previousNode: ElementNode,
): MarkdownHardLineBreak | null {
  const children = previousNode.getChildren();
  const lastChildIndex = children.length - 1;
  const lastChild = children[lastChildIndex];

  if (!$isTextNode(lastChild)) {
    return null;
  }

  const lastText = lastChild.getTextContent();
  const hardLineBreak = parseMarkdownHardLineBreak(lastText);

  if (hardLineBreak !== null) {
    const [text, marker] = hardLineBreak;
    lastChild.setTextContent(text);
    return marker;
  }

  if (
    /^ {2,}$/.test(lastText) &&
    hasNonWhitespaceContentOnLine(children, lastChildIndex)
  ) {
    lastChild.setTextContent('');
    return lastText;
  }

  return null;
}

export function $createMarkdownLineBreakNode(
  previousNode: ElementNode,
): LineBreakNode {
  const lineBreakNode = $createLineBreakNode();
  const hardLineBreak = $extractMarkdownHardLineBreakMarker(previousNode);

  if (hardLineBreak !== null) {
    $setState(lineBreakNode, hardLineBreakState, hardLineBreak);
  }

  return lineBreakNode;
}

/**
 * Block-level shortcuts convert by replacing the enclosing block, which
 * discards it. A QuoteNode holds inline content, so there is nowhere to nest
 * the new block and the quote would simply be lost. Import already refuses:
 * `$convertFromMarkdownString('> # x')` keeps the quote and leaves `# x` as
 * literal text, so the shortcut declines too rather than dropping the quote
 * out from under the caret. See #7407.
 */
function $isUnreplaceableBlock(parentNode: ElementNode): boolean {
  return $isQuoteNode(parentNode);
}

/**
 * CommonMark: "If the leading code fence is indented N spaces, then up to N
 * spaces of indentation are removed from each line of the content (if
 * present)." https://spec.commonmark.org/0.31.2/#fenced-code-blocks
 */
function stripFenceIndent(line: string, indent: number): string {
  let index = 0;
  while (index < indent && (line[index] === ' ' || line[index] === '\t')) {
    index++;
  }
  return line.slice(index);
}

/**
 * Attaches the opening fence's info-string tail to the `CodeNode` that
 * `CODE.replace` just appended. `replace` takes the match rather than the
 * source line, so the tail is applied here, where the line is in hand.
 */
function $setCodeMeta(parentNode: ElementNode, meta: string): void {
  const codeNode = parentNode.getLastChild();
  if (meta && $isCodeNode(codeNode)) {
    $setState(codeNode, codeMetaState, meta);
  }
}

const createBlockNode = (
  createNode: (match: string[]) => ElementNode,
): ElementTransformer['replace'] => {
  return (parentNode, children, match, isImport) => {
    const node = createNode(match);
    node.append(...children);
    parentNode.replace(node);
    if (!isImport) {
      node.select(0, 0);
    }
  };
};

// Amount of spaces that define indentation level
// TODO: should be an option
const LIST_INDENT_SIZE = 4;

function getIndent(whitespaces: string): number {
  const tabs = whitespaces.match(/\t/g);
  const spaces = whitespaces.match(/ /g);

  let indent = 0;

  if (tabs) {
    indent += tabs.length;
  }

  if (spaces) {
    indent += Math.floor(spaces.length / LIST_INDENT_SIZE);
  }

  return indent;
}

/**
 * The column the text after `whitespaces` starts at, expanding a tab to the
 * next multiple of `LIST_INDENT_SIZE` the way CommonMark does.
 */
function getColumn(whitespaces: string): number {
  let column = 0;
  for (const char of whitespaces) {
    column +=
      char === '\t' ? LIST_INDENT_SIZE - (column % LIST_INDENT_SIZE) : 1;
  }
  return column;
}

/**
 * The content columns of the list levels the lines placed so far have left
 * open, outermost first, or null outside a markdown import.
 *
 * A sublist is measured against the column where its parent item's content
 * begins rather than against a fixed number of spaces: that is what lets
 * `1. a` take a three-space sublist while `- a` takes a two-space one, and
 * what keeps two items written at the same column siblings even when that
 * column is deep enough to have opened a level.
 *
 * Only the line that opened a level knows the column it was written at, and
 * nothing in the tree records it afterwards, so the columns are carried from
 * line to line for the length of one import. A shortcut typed into an editor
 * is a line on its own with no such run behind it and keeps reading its indent
 * as a fixed `LIST_INDENT_SIZE` per level, which is the step `$listExport`
 * writes and the one the toolbar and Tab indent by.
 */
let importListColumns: number[] | null = null;
let importJoinsLooseLists = false;

/**
 * Run `fn` with the columns of a single markdown import tracked across the
 * lines it places. Restores whatever was being tracked around it, so an import
 * that runs inside another one does not disturb it.
 *
 * `joinLooseLists` reads a blank line between list lines as making the list
 * loose rather than ending it. An import that preserves new lines keeps blank
 * paragraphs as content, so there a blank line closes the list like any other
 * block.
 *
 * @internal
 */
export function withListIndentColumns<T>(
  joinLooseLists: boolean,
  fn: () => T,
): T {
  const previousColumns = importListColumns;
  const previousJoins = importJoinsLooseLists;
  importListColumns = [];
  importJoinsLooseLists = joinLooseLists;
  try {
    return fn();
  } finally {
    importListColumns = previousColumns;
    importJoinsLooseLists = previousJoins;
  }
}

/**
 * The indent `whitespaces` names given the levels open above it: the innermost
 * level whose content column it reaches, or 0 when it reaches none of them.
 */
function getColumnIndent(
  columns: readonly number[],
  whitespaces: string,
): number {
  const column = getColumn(whitespaces);
  for (let i = columns.length - 1; i >= 0; i--) {
    if (column >= columns[i]) {
      return i + 1;
    }
  }
  return 0;
}

/**
 * The column this line opens its content at: where the matched marker ends,
 * with tabs expanded, so `-\ta` opens at the tab stop and not two columns in.
 * A check list item is marked by its bullet — the `[ ]` is content — so
 * `- [ ] a` opens where `- a` does. Capped one `LIST_INDENT_SIZE` past the
 * marker so that the indent `$listExport` writes always nests: a sublist of
 * `100. ` is exported with four spaces, short of that marker's real content
 * column.
 */
function getContentColumn(match: string[], listType: ListType): number {
  let prefix = match[0];
  if (listType === 'check') {
    const bullet = prefix.slice(match[1].length).match(/^[-*+]\s/);
    if (bullet) {
      prefix = match[1] + bullet[0];
    }
  }
  return Math.min(getColumn(prefix), getColumn(match[1]) + LIST_INDENT_SIZE);
}

/**
 * Record the content column that this line leaves open for the lines below it,
 * closing the levels it stepped back out of.
 */
function setOpenColumn(
  columns: number[],
  indent: number,
  match: string[],
  listType: ListType,
): void {
  // An indent read from `getIndent` rather than from the columns can name a
  // level no line of this import opened, so any gap below it is filled with
  // the fixed step that reading assumed.
  for (let i = columns.length; i < indent; i++) {
    columns[i] = (i + 1) * LIST_INDENT_SIZE;
  }
  columns.length = indent;
  columns[indent] = getContentColumn(match, listType);
}

const listReplace = (listType: ListType): ElementTransformer['replace'] => {
  return (parentNode, children, match, isImport) => {
    if (
      $isHeadingNode(parentNode) ||
      (!isImport && $isUnreplaceableBlock(parentNode))
    ) {
      return false;
    }

    const previousNode = parentNode.getPreviousSibling();
    const nextNode = parentNode.getNextSibling();
    const listItem = $createListItemNode(
      // CHECK_LIST_REGEX matches case-insensitively, so `[X]` is checked too.
      listType === 'check' ? /^x$/i.test(match[3] || '') : undefined,
    );
    const firstMatchChar = match[0].trim()[0];
    const listMarker =
      (listType === 'bullet' || listType === 'check') &&
      firstMatchChar === listMarkerState.parse(firstMatchChar)
        ? firstMatchChar
        : undefined;
    // A block of another kind closes every level above this line. Blank lines
    // do not: they only make the list loose, and a blank line must not decide
    // how the line after it is read, or the same sublist would be read one way
    // written tightly and another written with a blank line before it. So the
    // line is measured against, and placed into, the list it follows across
    // any blank lines, and the levels close only when the nearest block that
    // is not one is no longer the list itself. Outside such an import — a
    // typed shortcut, or an import that keeps its blank lines as content — a
    // blank line above the line is a block like any other.
    const columns = importListColumns;
    let precedingBlock = previousNode;
    if (columns !== null) {
      if (importJoinsLooseLists) {
        while (precedingBlock !== null && isEmptyParagraph(precedingBlock)) {
          precedingBlock = precedingBlock.getPreviousSibling();
        }
      }
      if (!$isListNode(precedingBlock)) {
        columns.length = 0;
      }
    }
    const indent =
      columns === null || columns.length === 0
        ? getIndent(match[1])
        : getColumnIndent(columns, match[1]);
    if ($isListNode(nextNode) && nextNode.getListType() === listType) {
      const firstChild = nextNode.getFirstChild();
      if (firstChild !== null) {
        firstChild.insertBefore(listItem);
      } else {
        // should never happen, but let's handle gracefully, just in case.
        nextNode.append(listItem);
      }
      // The new list item lands at index 0, so the typed number becomes the
      // list's starting value. #8677. An indented item only passes through —
      // `setIndent` below moves it into a sublist — so its number belongs to
      // that sublist, not to the list it leaves.
      if (listType === 'number' && indent === 0) {
        nextNode.setStart(Number(match[2]));
      }
      parentNode.remove();
    } else if (
      $isListNode(precedingBlock) &&
      (precedingBlock.getListType() === listType || indent > 0)
    ) {
      // An item of the same type continues the list, and inherits the
      // existing sequence — the typed number is intentionally ignored. An
      // indented item of another type belongs inside it too: it is appended
      // at the top level here, `setIndent` below moves it to its level, and a
      // list of the right type is spliced in once the level it lands in is
      // known.
      precedingBlock.append(listItem);
      parentNode.remove();
    } else {
      const list = $createListNode(
        listType,
        listType === 'number' ? Number(match[2]) : undefined,
      );
      list.append(listItem);
      parentNode.replace(list);
    }
    listItem.append(...children);
    if (!isImport) {
      listItem.select(0, 0);
    }
    if (indent) {
      listItem.setIndent(indent);
      $retypeNestedList(listItem, listType, match);
    }
    // The marker belongs to the list the item actually ends up in, which is
    // only known once it has been indented and retyped.
    const listNode = listItem.getParent();
    if (listMarker && $isListNode(listNode)) {
      $setState(listNode, listMarkerState, listMarker);
    }
    if (columns !== null) {
      setOpenColumn(columns, indent, match, listType);
    }
  };
};

/**
 * `setIndent` nests an item by copying the list it is in, so an item whose
 * type differs from the list above it lands in a nested list of the wrong
 * type. Split it out into a list of its own type, in place, so that a sublist
 * can change type the way CommonMark lets it — `1. a` may be followed by an
 * indented `- b`, and that by an indented `- [ ] c`.
 */
function $retypeNestedList(
  listItem: ListItemNode,
  listType: ListType,
  match: string[],
): void {
  const nestedList = listItem.getParent();
  if (!$isListNode(nestedList) || nestedList.getListType() === listType) {
    return;
  }
  const wrapper = nestedList.getParent();
  if (!$isListItemNode(wrapper)) {
    return;
  }
  const retypedList = $createListNode(
    listType,
    listType === 'number' ? Number(match[2]) : undefined,
  );
  // `setIndent` either appends the item to the nested list or puts it in
  // front of it, so the list of its own type belongs on whichever side of the
  // one it was placed in it already sits on.
  const isFirst = listItem.getPreviousSibling() === null;
  // `append` moves the item without disturbing the selection, which
  // `remove` would relocate to a sibling and leave there — the caret has to
  // stay in the item the shortcut just created.
  retypedList.append(listItem);
  const retypedWrapper = $createListItemNode();
  retypedWrapper.append(retypedList);
  if (isFirst) {
    wrapper.insertBefore(retypedWrapper);
  } else {
    wrapper.insertAfter(retypedWrapper);
  }
  if (nestedList.getChildrenSize() === 0) {
    wrapper.remove();
  }
}

const $listExport = (
  listNode: ListNode,
  exportChildren: (node: ElementNode) => string,
  depth: number,
  selection?: BaseSelection | null,
): string => {
  const output = [];
  const children = listNode.getChildren();
  let index = 0;
  for (const listItemNode of children) {
    if ($isListItemNode(listItemNode)) {
      if (listItemNode.getChildrenSize() === 1) {
        const firstChild = listItemNode.getFirstChild();
        if ($isListNode(firstChild)) {
          const nestedResult = $listExport(
            firstChild,
            exportChildren,
            depth + 1,
            selection,
          );
          if (nestedResult) {
            output.push(nestedResult);
          }
          continue;
        }
      }
      // Skip unselected list items when selection is provided
      if (
        selection &&
        !listItemNode.getChildren().some(child => child.isSelected(selection))
      ) {
        continue;
      }
      const indent = ' '.repeat(depth * LIST_INDENT_SIZE);
      const listType = listNode.getListType();
      const listMarker = $getState(listNode, listMarkerState);
      const prefix =
        listType === 'number'
          ? `${listNode.getStart() + index}. `
          : listType === 'check'
            ? `${listMarker} [${listItemNode.getChecked() ? 'x' : ' '}] `
            : listMarker + ' ';
      let childrenText = exportChildren(listItemNode);
      if (listType !== 'number') {
        childrenText = childrenText.replace(/^(\s{0,3}\d+)(\.\s)/, '$1\\$2');
      }
      output.push(indent + prefix + childrenText);
      index++;
    }
  }

  return output.join('\n');
};

const $replaceWithHeading = createBlockNode(match => {
  const tag = ('h' + match[1].length) as HeadingTagType;
  return $createHeadingNode(tag);
});

export const HEADING: ElementTransformer = {
  dependencies: [HeadingNode],
  export: (node, exportChildren) => {
    if (!$isHeadingNode(node)) {
      return null;
    }
    const level = Number(node.getTag().slice(1));
    return '#'.repeat(level) + ' ' + exportChildren(node);
  },
  regExp: HEADING_REGEX,
  replace: (parentNode, children, match, isImport) => {
    if (!isImport && $isUnreplaceableBlock(parentNode)) {
      return false;
    }
    return $replaceWithHeading(parentNode, children, match, isImport);
  },
  triggerOnEnter: true,
  type: 'element',
};

export const QUOTE: ElementTransformer = {
  dependencies: [QuoteNode],
  export: (node, exportChildren) => {
    if (!$isQuoteNode(node)) {
      return null;
    }

    const lines = exportChildren(node).split('\n');
    const output = [];
    for (const line of lines) {
      output.push('> ' + line);
    }
    return output.join('\n');
  },
  regExp: QUOTE_REGEX,
  replace: (parentNode, children, _match, isImport) => {
    if (isImport) {
      const previousNode = parentNode.getPreviousSibling();
      if ($isQuoteNode(previousNode)) {
        previousNode.splice(previousNode.getChildrenSize(), 0, [
          $createMarkdownLineBreakNode(previousNode),
          ...children,
        ]);
        parentNode.remove();
        return;
      }
    }

    const node = $createQuoteNode();
    node.append(...children);
    parentNode.replace(node);
    if (!isImport) {
      node.select(0, 0);
    }
  },
  triggerOnEnter: true,
  type: 'element',
};

export const CODE: MultilineElementTransformer = {
  dependencies: [CodeNode],
  export: (node: LexicalNode) => {
    if (!$isCodeNode(node)) {
      return null;
    }
    const textContent = node.getTextContent();
    let fence = $getState(node, codeFenceState);

    if (textContent.indexOf(fence) > -1) {
      const backticks = textContent.match(/`{3,}/g);
      if (backticks) {
        const maxLength = Math.max(...backticks.map(b => b.length));
        fence = '`'.repeat(maxLength + 1);
      }
    }
    const language = node.getLanguage() || '';
    const meta = language ? $getState(node, codeMetaState) : '';

    return (
      fence +
      language +
      (meta ? ' ' + meta : '') +
      (textContent ? '\n' + textContent : '') +
      '\n' +
      fence
    );
  },

  handleImportAfterStartMatch: ({
    lines,
    rootNode,
    startLineIndex,
    startMatch,
  }) => {
    const fence = startMatch[1];
    const fenceLength = fence.trim().length;
    const currentLine = lines[startLineIndex];
    const afterFenceIndex = startMatch.index! + fence.length;
    const afterFence = currentLine.slice(afterFenceIndex);

    const singleLineEndRegex = new RegExp(`\`{${fenceLength},}$`);

    if (singleLineEndRegex.test(afterFence)) {
      const endMatch = afterFence.match(singleLineEndRegex);
      const content = afterFence.slice(0, afterFence.lastIndexOf(endMatch![0]));

      const fakeStartMatch = [...startMatch] as RegExpMatchArray;
      fakeStartMatch[2] = '';

      CODE.replace(
        rootNode,
        null,
        fakeStartMatch as RegExpMatchArray,
        endMatch,
        [content],
        true,
      );
      return [true, startLineIndex];
    }

    const multilineEndRegex = new RegExp(`^[ \\t]*\`{${fenceLength},}$`);

    for (let i = startLineIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (multilineEndRegex.test(line)) {
        const endMatch = line.match(multilineEndRegex);
        const linesInBetween = lines.slice(startLineIndex + 1, i);

        // Everything after the opening fence is the info string, and only its
        // first word is the language. When a language was captured, whatever
        // follows it on that line is metadata (```js title="x", ```ts {1,3})
        // and must not be prepended to the block's content.
        // https://spec.commonmark.org/0.31.2/#fenced-code-blocks
        //
        // With no language captured the fence carries no info string, so the
        // remainder is kept as content (``` code) as before.
        //
        // Either way the slot itself is always occupied: `replace` follows the
        // default $importMultiline contract, where linesInBetween[0] is the
        // remainder of the opening fence line and is discarded when blank. So
        // an empty placeholder goes in when the remainder is metadata, and a
        // blank remainder is unshifted rather than skipped — otherwise a code
        // block that genuinely starts with a blank line would have that line
        // mistaken for the (empty) remainder and dropped.
        const meta = startMatch[2]
          ? currentLine.slice(startMatch[0].length).trim()
          : '';
        linesInBetween.unshift(
          meta ? '' : currentLine.slice(startMatch[0].length),
        );

        CODE.replace(
          rootNode,
          null,
          startMatch,
          endMatch,
          linesInBetween,
          true,
        );
        $setCodeMeta(rootNode, meta);
        return [true, i];
      }
    }

    const linesInBetween = lines.slice(startLineIndex + 1);
    linesInBetween.unshift(currentLine.slice(startMatch[0].length));

    CODE.replace(rootNode, null, startMatch, null, linesInBetween, true);
    return [true, lines.length - 1];
  },

  regExpEnd: {
    optional: true,
    regExp: CODE_END_REGEX,
  },
  regExpStart: CODE_START_REGEX,

  replace: (
    rootNode,
    children,
    startMatch,
    endMatch,
    linesInBetween,
    isImport,
  ) => {
    let codeBlockNode: CodeNode;
    let code: string;

    const fence = startMatch[1] ? startMatch[1].trim() : '```';
    const language = startMatch[2] || undefined;
    // `startMatch[1]` keeps the whitespace that precedes the opening fence.
    const fenceIndent = startMatch[1]
      ? startMatch[1].length - startMatch[1].trimStart().length
      : 0;

    if (!children && linesInBetween) {
      if (linesInBetween.length === 1) {
        if (endMatch) {
          codeBlockNode = $createCodeNode(language);
          code = stripFenceIndent(linesInBetween[0], fenceIndent);
        } else {
          codeBlockNode = $createCodeNode(language);
          code = linesInBetween[0].startsWith(' ')
            ? linesInBetween[0].slice(1)
            : linesInBetween[0];
        }
      } else {
        codeBlockNode = $createCodeNode(language);

        if (linesInBetween.length > 0) {
          if (linesInBetween[0].trim().length === 0) {
            linesInBetween.shift();
          } else if (linesInBetween[0].startsWith(' ')) {
            linesInBetween[0] = linesInBetween[0].slice(1);
          }
        }

        while (
          linesInBetween.length > 0 &&
          !linesInBetween[linesInBetween.length - 1].length
        ) {
          linesInBetween.pop();
        }

        code = linesInBetween
          .map(line => stripFenceIndent(line, fenceIndent))
          .join('\n');
      }

      $setState(codeBlockNode, codeFenceState, fence);

      const textNode = $createTextNode(code);
      codeBlockNode.append(textNode);
      rootNode.append(codeBlockNode);
    } else if (children) {
      if (!isImport && $isUnreplaceableBlock(rootNode)) {
        return false;
      }
      createBlockNode(match => {
        return $createCodeNode(match ? match[2] : undefined);
      })(rootNode, children, startMatch, isImport);
    }
  },

  type: 'multiline-element',
};

export const UNORDERED_LIST: ElementTransformer = {
  dependencies: [ListNode, ListItemNode],
  export: (node, exportChildren, selection) => {
    return $isListNode(node)
      ? $listExport(node, exportChildren, 0, selection)
      : null;
  },
  regExp: UNORDERED_LIST_REGEX,
  replace: listReplace('bullet'),
  triggerOnEnter: true,
  type: 'element',
};

export const CHECK_LIST: ElementTransformer = {
  dependencies: [ListNode, ListItemNode],
  export: (node, exportChildren, selection) => {
    return $isListNode(node)
      ? $listExport(node, exportChildren, 0, selection)
      : null;
  },
  regExp: CHECK_LIST_REGEX,
  replace: listReplace('check'),
  triggerOnEnter: true,
  type: 'element',
};

export const ORDERED_LIST: ElementTransformer = {
  dependencies: [ListNode, ListItemNode],
  export: (node, exportChildren, selection) => {
    return $isListNode(node)
      ? $listExport(node, exportChildren, 0, selection)
      : null;
  },
  regExp: ORDERED_LIST_REGEX,
  replace: listReplace('number'),
  triggerOnEnter: true,
  type: 'element',
};

export const INLINE_CODE: TextFormatTransformer = {
  format: ['code'],
  tag: '`',
  type: 'text-format',
};

// Computes a CommonMark-compliant fence and padded content for an inline code
// span: https://spec.commonmark.org/#code-spans
export function getCodeSpanDelimiter(content: string): {
  fence: string;
  padded: string;
} {
  const backtickRuns = content.match(/`+/g);
  const longestRun = backtickRuns
    ? Math.max(...backtickRuns.map(run => run.length))
    : 0;
  const fence = '`'.repeat(longestRun + 1);
  const needsPadding =
    content.length === 0 ||
    content.includes('`') ||
    (/^\s/.test(content) && /\s$/.test(content));
  const padded = needsPadding ? ` ${content} ` : content;
  return {fence, padded};
}

export const HIGHLIGHT: TextFormatTransformer = {
  format: ['highlight'],
  tag: '==',
  type: 'text-format',
};

export const BOLD_ITALIC_STAR: TextFormatTransformer = {
  format: ['bold', 'italic'],
  tag: '***',
  type: 'text-format',
};

export const BOLD_ITALIC_UNDERSCORE: TextFormatTransformer = {
  format: ['bold', 'italic'],
  intraword: false,
  tag: '___',
  type: 'text-format',
};

export const BOLD_STAR: TextFormatTransformer = {
  format: ['bold'],
  tag: '**',
  type: 'text-format',
};

export const BOLD_UNDERSCORE: TextFormatTransformer = {
  format: ['bold'],
  intraword: false,
  tag: '__',
  type: 'text-format',
};

export const STRIKETHROUGH: TextFormatTransformer = {
  format: ['strikethrough'],
  tag: '~~',
  type: 'text-format',
};

export const ITALIC_STAR: TextFormatTransformer = {
  format: ['italic'],
  tag: '*',
  type: 'text-format',
};

export const ITALIC_UNDERSCORE: TextFormatTransformer = {
  format: ['italic'],
  intraword: false,
  tag: '_',
  type: 'text-format',
};

// `unescapeText` decodes a numeric character reference and a CommonMark reader
// decodes the named ones too, so an `&` that begins one cannot be written raw
// in a link destination or the URL comes back as the character it names. It
// goes out as `&#38;` instead, which both of them read back as a single `&`.
// An `&` that begins nothing is an ordinary character and stays as it is, so a
// query string keeps the separators it was written with.
function escapeCharacterReferences(value: string): string {
  return value.replace(
    /&(?=#\d+;|#[Xx][\dA-Fa-f]+;|[A-Za-z][\dA-Za-z]*;)/g,
    '&#38;',
  );
}

// Order of text transformers matters:
//
// - code should go first as it prevents any transformations inside
// - then longer tags match (e.g. ** or __ should go before * or _)
export const LINK: TextMatchTransformer = {
  dependencies: [LinkNode],
  export: (node, exportChildren, exportFormat) => {
    if (!$isLinkNode(node) || $isAutoLinkNode(node)) {
      return null;
    }
    const textContent = exportChildren(node);
    let title = node.getTitle();

    // A title is read back through `unescapeText` as well, so a character
    // reference in it needs the same treatment the destination gets below.
    if (title != null) {
      title = escapeCharacterReferences(title).replace(/([\\"])/g, '\\$1');
    }

    // A raw destination cannot hold whitespace, so a URL that has any is
    // written in the pointy form, where only `<`, `>` and a backslash need an
    // escape. An empty URL goes there too, since the raw form has nothing left
    // to match. Everywhere else the destination is written raw, where a
    // parenthesis would close it early, a backslash would start an escape, and
    // only a `<` in first place turns it into the pointy form. An angle
    // bracket anywhere else is an ordinary character and goes out as it is.
    //
    // Neither shape may hold a line ending, so a literal one would leave a
    // destination that no reader can close and would split the paragraph in
    // two. It goes out as the character reference that `unescapeText` and a
    // CommonMark reader both turn back into the line ending.
    //
    // That spelling only survives because a reader decodes it, so an `&` that
    // already begins a character reference has to go out as one itself, or the
    // URL comes back as whatever the reference names. Escaping it first keeps
    // the references written for the line endings below out of its way.
    const rawUrl = node.getURL();
    const escapedUrl = escapeCharacterReferences(rawUrl);
    const url =
      rawUrl === '' || /\s/.test(rawUrl)
        ? `<${escapedUrl
            .replace(/([\\<>])/g, '\\$1')
            .replace(/\r/g, '&#13;')
            .replace(/\n/g, '&#10;')}>`
        : escapedUrl.replace(/([\\()])/g, '\\$1').replace(/^</, '\\<');

    const linkContent = title
      ? `[${textContent}](${url} "${title}")`
      : `[${textContent}](${url})`;

    return linkContent;
  },
  // A link destination comes in two shapes, is itself optional, and may have
  // whitespace on either side of it inside the parentheses. Between `<` and
  // `>` it holds anything but a line ending and an unescaped angle bracket,
  // whitespace included. Written raw it may not begin with `<`, and it holds a
  // backslash and whatever follows it, a balanced pair of parentheses, or any
  // other character that is not a space, a parenthesis or a backslash. An
  // angle bracket anywhere but the first character is an ordinary character
  // there. A backslash in front of whitespace escapes nothing, so that branch
  // takes the backslash on its own and lets the whitespace end the
  // destination.
  //
  // The parentheses nest three deep. A regular expression cannot count them,
  // so the depth is a limit written down rather than a general rule, and no
  // URL in the wild reaches past the one level a disambiguated Wikipedia
  // article needs.
  //
  // A title comes after the destination and whitespace, in any of the three
  // spellings CommonMark gives it. Inside every shape here no two alternatives
  // can match at the same place, so none of them has anything to backtrack
  // over.
  //
  // The trailing whitespace sits inside the optional group with the
  // destination rather than after it. Outside, it would neighbour the leading
  // `\s*` whenever the destination is absent, and two runs of the same
  // whitespace side by side can be split between them in as many ways as there
  // are characters, which costs a quadratic walk of every run that never
  // reaches the closing parenthesis.
  importRegExp:
    /(?:\[(.+?)\])(?:\(\s*(?:(?:<((?:\\.|[^<>\n\\])*)>|((?!<)(?:\\[^\s]|\\(?=\s)|\((?:\\[^\s]|[^\s()\\]|\((?:\\[^\s]|[^\s()\\]|\((?:\\[^\s]|[^\s()\\])*\))*\))*\)|[^\s()\\])+))(?:\s+(?:"((?:[^"]*\\")*[^"]*)"|'((?:[^']*\\')*[^']*)'|\(((?:\\.|[^()\\])*)\)))?\s*)?\))/,
  regExp:
    /(?:\[([^[\]]*(?:\[[^[\]]*\][^[\]]*)*)\])(?:\(\s*(?:(?:<((?:\\.|[^<>\n\\])*)>|((?!<)(?:\\[^\s]|\\(?=\s)|\((?:\\[^\s]|[^\s()\\]|\((?:\\[^\s]|[^\s()\\]|\((?:\\[^\s]|[^\s()\\])*\))*\))*\)|[^\s()\\])+))(?:\s+(?:"((?:[^"]*\\")*[^"]*)"|'((?:[^']*\\')*[^']*)'|\(((?:\\.|[^()\\])*)\)))?\s*)?\))$/,
  replace: (textNode, match) => {
    // https://spec.commonmark.org/0.31.2/#inline-link
    if ($findMatchingParent(textNode, $isLinkNode)) {
      return;
    }
    const [
      ,
      linkText,
      pointyLinkUrl,
      rawLinkUrl,
      quotedTitle,
      apostrophedTitle,
      parenthesizedTitle,
    ] = match;

    // At most one destination shape matched, either may legitimately be empty,
    // and `[a]()` matches with no destination at all, so none of this can fall
    // back on truthiness.
    const linkUrl = unescapeText(pointyLinkUrl ?? rawLinkUrl ?? '');
    // A title has three spellings and only the one that matched is defined.
    const rawLinkTitle = quotedTitle ?? apostrophedTitle ?? parenthesizedTitle;
    const linkTitle =
      rawLinkTitle != null ? unescapeText(rawLinkTitle) : undefined;
    const linkNode = $createLinkNode(linkUrl, {title: linkTitle});
    const openBracketAmount = linkText.split('[').length - 1;
    const closeBracketAmount = linkText.split(']').length - 1;
    let parsedLinkText = linkText;
    let outsideLinkText = '';
    if (openBracketAmount < closeBracketAmount) {
      return;
    } else if (openBracketAmount > closeBracketAmount) {
      const linkTextParts = linkText.split('[');
      outsideLinkText = '[' + linkTextParts[0];
      parsedLinkText = linkTextParts.slice(1).join('[');
    }
    const linkTextNode = $createTextNode(parsedLinkText);
    linkTextNode.setFormat(textNode.getFormat());
    linkNode.append(linkTextNode);
    textNode.replace(linkNode);

    if (outsideLinkText) {
      linkNode.insertBefore($createTextNode(outsideLinkText));
    }
    return linkTextNode;
  },
  trigger: ')',
  type: 'text-match',
};

export const ELEMENT_TRANSFORMERS: ElementTransformer[] = [
  HEADING,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
];

export const MULTILINE_ELEMENT_TRANSFORMERS: MultilineElementTransformer[] = [
  CODE,
];

// Order of text format transformers matters:
//
// - code should go first as it prevents any transformations inside
// - then longer tags match (e.g. ** or __ should go before * or _)
export const TEXT_FORMAT_TRANSFORMERS: TextFormatTransformer[] = [
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  HIGHLIGHT,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH,
];

export const TEXT_MATCH_TRANSFORMERS: TextMatchTransformer[] = [LINK];

export const TRANSFORMERS: Transformer[] = [
  ...ELEMENT_TRANSFORMERS,
  ...MULTILINE_ELEMENT_TRANSFORMERS,
  ...TEXT_FORMAT_TRANSFORMERS,
  ...TEXT_MATCH_TRANSFORMERS,
];

export function normalizeMarkdown(
  input: string,
  shouldMergeAdjacentLines = false,
): string {
  const lines = input.split('\n');
  let codeBlockFenceLength = 0;
  const sanitizedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trimEnd();
    const lastLine = sanitizedLines[sanitizedLines.length - 1];
    const hardLineBreak =
      i < lines.length - 1 ? parseMarkdownHardLineBreak(rawLine) : null;
    const lastLineHasHardLineBreak =
      lastLine !== undefined && parseMarkdownHardLineBreak(lastLine) !== null;

    // Code blocks of ```single line``` don't toggle the inCodeBlock flag
    if (CODE_SINGLE_LINE_REGEX.test(line)) {
      sanitizedLines.push(line);
      continue;
    }

    if (codeBlockFenceLength === 0) {
      // An opening fence may carry an info string (e.g. ```ts)
      const openMatch = line.match(CODE_START_REGEX);
      if (openMatch) {
        codeBlockFenceLength = openMatch[1].trim().length;
        sanitizedLines.push(line);
        continue;
      }
    } else {
      // A code block is closed only by a bare fence (no info string) that is at
      // least as long as the opening fence. Fence-like lines that carry an info
      // string (e.g. a nested ```ts) are part of the code block's content.
      if (
        CODE_END_REGEX.test(line) &&
        line.trim().length >= codeBlockFenceLength
      ) {
        codeBlockFenceLength = 0;
        sanitizedLines.push(line);
        continue;
      }
      // Inside a code block, keep the line unchanged
      sanitizedLines.push(rawLine);
      continue;
    }

    // In markdown the concept of "empty paragraphs" does not exist.
    // Blocks must be separated by an empty line. Non-empty adjacent lines must be merged.
    if (
      line === '' ||
      lastLine === '' ||
      !lastLine ||
      HEADING_REGEX.test(lastLine) ||
      HEADING_REGEX.test(line) ||
      QUOTE_REGEX.test(line) ||
      ORDERED_LIST_REGEX.test(line) ||
      UNORDERED_LIST_REGEX.test(line) ||
      CHECK_LIST_REGEX.test(line) ||
      TABLE_ROW_REG_EXP.test(line) ||
      isTableRowDivider(line) ||
      lastLineHasHardLineBreak ||
      !shouldMergeAdjacentLines ||
      TAG_START_REGEX.test(line) ||
      TAG_END_REGEX.test(line) ||
      ENDS_WITH(TAG_END_REGEX).test(lastLine) ||
      ENDS_WITH(TAG_START_REGEX).test(lastLine) ||
      CODE_END_REGEX.test(lastLine)
    ) {
      // When not merging, preserve trailing whitespace (e.g. hard line-break
      // markers "  " or non-breaking spaces). Whitespace-only lines still
      // collapse to '' because trimEnd() already reduced them, so they
      // continue to act as paragraph separators.
      sanitizedLines.push(
        (!shouldMergeAdjacentLines && line !== '') || hardLineBreak !== null
          ? rawLine
          : line,
      );
    } else {
      sanitizedLines[sanitizedLines.length - 1] =
        lastLine + ' ' + (hardLineBreak === null ? line : rawLine).trimStart();
    }
  }

  return sanitizedLines.join('\n');
}
