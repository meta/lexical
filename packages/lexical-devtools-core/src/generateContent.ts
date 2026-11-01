/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalCommandLog} from './useLexicalCommandsLog';

import {$generateHtmlFromNodes} from '@lexical/html';
import {$isLinkNode, type LinkNode} from '@lexical/link';
import {$isMarkNode} from '@lexical/mark';
import {$isTableSelection, type TableSelection} from '@lexical/table';
import {
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $getSlotNameWithinHost,
  $isDecoratorNode,
  $isElementNode,
  $isNodeSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  type BaseSelection,
  type DecoratorNode,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type ParagraphNode,
  type RangeSelection,
  type TextNode,
} from 'lexical';

export type CustomPrintNodeFn = (
  node: LexicalNode,
  obfuscateText?: boolean,
) => string | undefined;

// The Object.freeze calls are annotated by hand and the RegExp is built by a
// function declared side-effect free (so the build annotates the call): a
// module-scope call is a side effect to bundlers, which would pin these
// tables into every bundle that imports this module.
const NON_SINGLE_WIDTH_CHARS_REPLACEMENT: Readonly<Record<string, string>> =
  /* @__PURE__ */ Object.freeze({
    '\t': '\\t',
    '\n': '\\n',
  });
/** @__NO_SIDE_EFFECTS__ */
function createNonSingleWidthCharsRegExp(): RegExp {
  return new RegExp(
    Object.keys(NON_SINGLE_WIDTH_CHARS_REPLACEMENT).join('|'),
    'g',
  );
}
const NON_SINGLE_WIDTH_CHARS_REGEX = createNonSingleWidthCharsRegExp();
const SYMBOLS: Record<string, string> = /* @__PURE__ */ Object.freeze({
  ancestorHasNextSibling: '|',
  ancestorIsLastChild: ' ',
  hasNextSibling: '├',
  isLastChild: '└',
  selectedChar: '^',
  selectedLine: '>',
});

const FORMAT_PREDICATES = [
  (node: TextNode | RangeSelection) => node.hasFormat('bold') && 'Bold',
  (node: TextNode | RangeSelection) => node.hasFormat('code') && 'Code',
  (node: TextNode | RangeSelection) => node.hasFormat('italic') && 'Italic',
  (node: TextNode | RangeSelection) =>
    node.hasFormat('strikethrough') && 'Strikethrough',
  (node: TextNode | RangeSelection) =>
    node.hasFormat('subscript') && 'Subscript',
  (node: TextNode | RangeSelection) =>
    node.hasFormat('superscript') && 'Superscript',
  (node: TextNode | RangeSelection) =>
    node.hasFormat('underline') && 'Underline',
  (node: TextNode | RangeSelection) =>
    node.hasFormat('highlight') && 'Highlight',
];

const FORMAT_PREDICATES_PARAGRAPH = [
  (node: ParagraphNode) => node.hasTextFormat('bold') && 'Bold',
  (node: ParagraphNode) => node.hasTextFormat('code') && 'Code',
  (node: ParagraphNode) => node.hasTextFormat('italic') && 'Italic',
  (node: ParagraphNode) =>
    node.hasTextFormat('strikethrough') && 'Strikethrough',
  (node: ParagraphNode) => node.hasTextFormat('subscript') && 'Subscript',
  (node: ParagraphNode) => node.hasTextFormat('superscript') && 'Superscript',
  (node: ParagraphNode) => node.hasTextFormat('underline') && 'Underline',
  (node: ParagraphNode) => node.hasTextFormat('highlight') && 'Highlight',
];

const DETAIL_PREDICATES = [
  (node: TextNode) => node.isDirectionless() && 'Directionless',
  (node: TextNode) => node.isUnmergeable() && 'Unmergeable',
];

const MODE_PREDICATES = [
  (node: TextNode) => node.isToken() && 'Token',
  (node: TextNode) => node.isSegmented() && 'Segmented',
];

export function generateContent(
  editor: LexicalEditor,
  commandsLog: LexicalCommandLog,
  exportDOM: boolean,
  customPrintNode?: CustomPrintNodeFn,
  obfuscateText: boolean = false,
): string {
  const editorState = editor.getEditorState();
  const editorConfig = editor._config;
  const compositionKey = editor._compositionKey;
  const editable = editor._editable;

  if (exportDOM) {
    let htmlString = '';
    editorState.read(
      () => {
        htmlString = printPrettyHTML($generateHtmlFromNodes(editor));
      },
      {editor},
    );
    return htmlString;
  }

  let res = ' root\n';

  const selectionString = editorState.read(
    () => {
      const selection = $getSelection();

      $visitTree(
        $getRoot(),
        (node: LexicalNode, indent: string[], slotName?: string) => {
          const nodeKey = node.getKey();
          const nodeKeyDisplay = `(${nodeKey})`;
          const typeDisplay = node.getType() || '';
          const isSelected = node.isSelected();
          const slotPrefix =
            slotName !== undefined ? `[slot: ${slotName}] ` : '';
          const slotMeta = $slotValueMetaSuffix(node, slotName);

          res += `${isSelected ? SYMBOLS.selectedLine : ' '} ${indent.join(
            ' ',
          )} ${nodeKeyDisplay} ${slotPrefix}${typeDisplay}${slotMeta} ${printNode(
            node,
            customPrintNode,
            obfuscateText,
          )}\n`;

          res += $printSelectedCharsLine({
            indent,
            isSelected,
            node,
            nodeKeyDisplay,
            selection,
            typeDisplay,
          });
        },
      );

      return selection === null
        ? ': null'
        : $isRangeSelection(selection)
          ? $printRangeSelection(selection)
          : $isTableSelection(selection)
            ? printTableSelection(selection)
            : printNodeSelection(selection);
    },
    {editor},
  );

  res += '\n selection' + selectionString;

  res += '\n\n commands:';

  if (commandsLog.length) {
    for (const {index, type, payload} of commandsLog) {
      res += `\n  └ ${index}. { type: ${type}, payload: ${
        payload instanceof Event ? payload.constructor.name : payload
      } }`;
    }
  } else {
    res += '\n  └ None dispatched.';
  }
  const {version} = editor.constructor;
  res += `\n\n editor${version ? ` (v${version})` : ''}:`;
  res += `\n  └ namespace ${editorConfig.namespace}`;
  if (compositionKey !== null) {
    res += `\n  └ compositionKey ${compositionKey}`;
  }
  res += `\n  └ editable ${String(editable)}`;

  return res;
}

function $printRangeSelection(selection: RangeSelection): string {
  let res = '';

  const formatText = printFormatProperties(selection);

  const anchorSlot = $resolveSlotContext(selection.anchor.getNode());
  const slotSuffix =
    anchorSlot !== null
      ? ` (in slot "${anchorSlot.name}" of ${anchorSlot.host.getType()} { key: ${anchorSlot.host.getKey()} })`
      : '';

  res += `: range${slotSuffix} ${formatText !== '' ? `{ ${formatText} }` : ''} ${
    selection.style !== '' ? `{ style: ${selection.style} } ` : ''
  }`;

  const anchor = selection.anchor;
  const focus = selection.focus;
  const anchorOffset = anchor.offset;
  const focusOffset = focus.offset;

  res += `\n  ├ anchor { key: ${anchor.key}, offset: ${
    anchorOffset === null ? 'null' : anchorOffset
  }, type: ${anchor.type} }`;
  res += `\n  └ focus { key: ${focus.key}, offset: ${
    focusOffset === null ? 'null' : focusOffset
  }, type: ${focus.type} }`;

  return res;
}

// Walk up from `node`, following both __parent and __slotHost, until a
// slot child surfaces — i.e. a node whose `$getSlotNameWithinHost` is not
// null. Returns the slot name and the host that owns it, so the devtools
// can show callers like the selection panel which named slot a caret /
// anchor currently sits in.
function $resolveSlotContext(
  node: LexicalNode,
): {name: string; host: LexicalNode} | null {
  let cursor: LexicalNode | null = node;
  while (cursor !== null) {
    const slotName = $getSlotNameWithinHost(cursor);
    if (slotName !== null) {
      const host = $getSlotHost(cursor);
      if (host !== null) {
        return {host, name: slotName};
      }
    }
    cursor = cursor.getParent() ?? $getSlotHost(cursor);
  }
  return null;
}

// True when the node is a slot-friendly value that the devtools should
// annotate with its semantic role. Shadow-root ElementNodes (editable
// slot values like a Card's title) get `[shadow-root]`; non-inline
// DecoratorNodes that sit in a slot (atomic decorator slot values like a
// Figure's media) get `[atomic decorator]`. Regular children fall
// through with no suffix. Both branches gate on `slotName !== undefined`
// — other shadow-root ElementNodes (table cells, layout items, page
// content, collapsibles) aren't slot values and shouldn't pick up the
// marker outside this feature's scope.
function $slotValueMetaSuffix(
  node: LexicalNode,
  slotName: string | undefined,
): string {
  if (slotName === undefined) {
    return '';
  }
  if ($isElementNode(node) && node.isShadowRoot()) {
    return ' [shadow-root]';
  }
  if ($isDecoratorNode(node) && !(node as DecoratorNode<unknown>).isInline()) {
    return ' [atomic decorator]';
  }
  return '';
}

function printNodeSelection(selection: BaseSelection): string {
  if (!$isNodeSelection(selection)) {
    return '';
  }
  return `: node\n  └ [${Array.from(selection._nodes).join(', ')}]`;
}

function printTableSelection(selection: TableSelection): string {
  return `: table\n  └ { table: ${selection.tableKey}, anchorCell: ${selection.anchor.key}, focusCell: ${selection.focus.key} }`;
}

function $visitTree(
  currentNode: ElementNode | DecoratorNode<unknown>,
  visitor: (node: LexicalNode, indentArr: string[], slotName?: string) => void,
  indent: string[] = [],
) {
  // Slot children walk first (slots-first, mirroring the reconciler /
  // host DOM order), then the regular children list. `visitor` gets the
  // slot name for slot values so the devtools can annotate them.
  const slotEntries: [string, LexicalNode][] = [];
  for (const slotName of $getSlotNames(currentNode)) {
    const slotNode = $getSlot(currentNode, slotName);
    if (slotNode !== null) {
      slotEntries.push([slotName, slotNode]);
    }
  }
  const childNodes = $isElementNode(currentNode)
    ? currentNode.getChildren()
    : [];
  const totalCount = slotEntries.length + childNodes.length;
  let i = 0;

  for (const [slotName, slotNode] of slotEntries) {
    const isLast = i === totalCount - 1;
    visitor(
      slotNode,
      indent.concat(isLast ? SYMBOLS.isLastChild : SYMBOLS.hasNextSibling),
      slotName,
    );
    if ($isElementNode(slotNode) || $isDecoratorNode(slotNode)) {
      $visitTree(
        slotNode,
        visitor,
        indent.concat(
          isLast ? SYMBOLS.ancestorIsLastChild : SYMBOLS.ancestorHasNextSibling,
        ),
      );
    }
    i++;
  }

  for (const childNode of childNodes) {
    const isLast = i === totalCount - 1;
    visitor(
      childNode,
      indent.concat(isLast ? SYMBOLS.isLastChild : SYMBOLS.hasNextSibling),
    );
    // DecoratorNodes can host slots too, so recurse into them like the
    // slot-entry loop above; a decorator's slot subtree would otherwise be
    // invisible whenever the host is reached through the children channel.
    if ($isElementNode(childNode) || $isDecoratorNode(childNode)) {
      $visitTree(
        childNode,
        visitor,
        indent.concat(
          isLast ? SYMBOLS.ancestorIsLastChild : SYMBOLS.ancestorHasNextSibling,
        ),
      );
    }
    i++;
  }
}

function normalize(text: string, obfuscateText: boolean = false) {
  const textToPrint = Object.entries(NON_SINGLE_WIDTH_CHARS_REPLACEMENT).reduce(
    (acc, [key, value]) => acc.replace(new RegExp(key, 'g'), String(value)),
    text,
  );
  if (obfuscateText) {
    return textToPrint.replace(/[^\s]/g, '*');
  }
  return textToPrint;
}

function printNode(
  node: LexicalNode,
  customPrintNode?: CustomPrintNodeFn,
  obfuscateText: boolean = false,
) {
  const customPrint: string | undefined = customPrintNode
    ? customPrintNode(node, obfuscateText)
    : undefined;
  if (customPrint !== undefined && customPrint.length > 0) {
    return customPrint;
  }

  if ($isTextNode(node)) {
    const text = node.getTextContent();
    const title =
      text.length === 0 ? '(empty)' : `"${normalize(text, obfuscateText)}"`;
    const properties = printAllTextNodeProperties(node);
    return [title, properties.length !== 0 ? `{ ${properties} }` : null]
      .filter(Boolean)
      .join(' ')
      .trim();
  } else if ($isLinkNode(node)) {
    const link = node.getURL();
    const title =
      link.length === 0 ? '(empty)' : `"${normalize(link, obfuscateText)}"`;
    const properties = printAllLinkNodeProperties(node);
    return [title, properties.length !== 0 ? `{ ${properties} }` : null]
      .filter(Boolean)
      .join(' ')
      .trim();
  } else if ($isMarkNode(node)) {
    return `ids: [ ${node.getIDs().join(', ')} ]`;
  } else if ($isParagraphNode(node)) {
    const formatText = printTextFormatProperties(node);
    let paragraphData = formatText !== '' ? `{ ${formatText} }` : '';
    paragraphData += node.__style ? `(${node.__style})` : '';
    return paragraphData;
  } else {
    return '';
  }
}

function printTextFormatProperties(nodeOrSelection: ParagraphNode) {
  let str = FORMAT_PREDICATES_PARAGRAPH.map(predicate =>
    predicate(nodeOrSelection),
  )
    .filter(Boolean)
    .join(', ')
    .toLocaleLowerCase();

  if (str !== '') {
    str = 'format: ' + str;
  }

  return str;
}

function printAllTextNodeProperties(node: TextNode) {
  return [
    printFormatProperties(node),
    printDetailProperties(node),
    printModeProperties(node),
    printStateProperties(node),
  ]
    .filter(Boolean)
    .join(', ');
}

function printAllLinkNodeProperties(node: LinkNode) {
  return [
    printTargetProperties(node),
    printRelProperties(node),
    printTitleProperties(node),
    printStateProperties(node),
  ]
    .filter(Boolean)
    .join(', ');
}

function printDetailProperties(nodeOrSelection: TextNode) {
  let str = DETAIL_PREDICATES.map(predicate => predicate(nodeOrSelection))
    .filter(Boolean)
    .join(', ')
    .toLocaleLowerCase();

  if (str !== '') {
    str = 'detail: ' + str;
  }

  return str;
}

function printModeProperties(nodeOrSelection: TextNode) {
  let str = MODE_PREDICATES.map(predicate => predicate(nodeOrSelection))
    .filter(Boolean)
    .join(', ')
    .toLocaleLowerCase();

  if (str !== '') {
    str = 'mode: ' + str;
  }

  return str;
}

function printFormatProperties(nodeOrSelection: TextNode | RangeSelection) {
  let str = FORMAT_PREDICATES.map(predicate => predicate(nodeOrSelection))
    .filter(Boolean)
    .join(', ')
    .toLocaleLowerCase();

  if (str !== '') {
    str = 'format: ' + str;
  }

  return str;
}

function printTargetProperties(node: LinkNode) {
  let str = node.getTarget();
  // TODO Fix nullish on LinkNode
  if (str != null) {
    str = 'target: ' + str;
  }
  return str;
}

function printRelProperties(node: LinkNode) {
  let str = node.getRel();
  // TODO Fix nullish on LinkNode
  if (str != null) {
    str = 'rel: ' + str;
  }
  return str;
}

function printTitleProperties(node: LinkNode) {
  let str = node.getTitle();
  // TODO Fix nullish on LinkNode
  if (str != null) {
    str = 'title: ' + str;
  }
  return str;
}

function printStateProperties(node: LexicalNode) {
  if (!node.__state) {
    return false;
  }
  const states = [];
  for (const [stateType, value] of node.__state.knownState.entries()) {
    if (stateType.isEqual(value, stateType.defaultValue)) {
      continue;
    }
    const textValue = JSON.stringify(stateType.unparse(value));
    states.push(`[${stateType.key}: ${textValue}]`);
  }
  let str = states.join(',');
  if (str !== '') {
    str = 'state: ' + str;
  }
  return str;
}

function $printSelectedCharsLine({
  indent,
  isSelected,
  node,
  nodeKeyDisplay,
  selection,
  typeDisplay,
}: {
  indent: string[];
  isSelected: boolean;
  node: LexicalNode;
  nodeKeyDisplay: string;
  selection: BaseSelection | null;
  typeDisplay: string;
}) {
  // No selection or node is not selected.
  if (
    !$isTextNode(node) ||
    !$isRangeSelection(selection) ||
    !isSelected ||
    $isElementNode(node)
  ) {
    return '';
  }

  // No selected characters.
  const anchor = selection.anchor;
  const focus = selection.focus;

  if (
    node.getTextContent() === '' ||
    (anchor.getNode() === selection.focus.getNode() &&
      anchor.offset === focus.offset)
  ) {
    return '';
  }

  const [start, end] = $getSelectionStartEnd(node, selection);

  if (start === end) {
    return '';
  }

  const selectionLastIndent =
    indent[indent.length - 1] === SYMBOLS.hasNextSibling
      ? SYMBOLS.ancestorHasNextSibling
      : SYMBOLS.ancestorIsLastChild;

  const indentionChars = [
    ...indent.slice(0, indent.length - 1),
    selectionLastIndent,
  ];
  const unselectedChars = Array(start + 1).fill(' ');
  const selectedChars = Array(end - start).fill(SYMBOLS.selectedChar);
  const paddingLength = typeDisplay.length + 2; // 1 for the space after + 1 for the double quote.

  const nodePrintSpaces = Array(nodeKeyDisplay.length + paddingLength).fill(
    ' ',
  );

  return (
    [
      SYMBOLS.selectedLine,
      indentionChars.join(' '),
      [...nodePrintSpaces, ...unselectedChars, ...selectedChars].join(''),
    ].join(' ') + '\n'
  );
}

function printPrettyHTML(str: string) {
  // eslint-disable-next-line no-restricted-syntax
  const div = document.createElement('div');
  div.innerHTML = str.trim();
  return prettifyHTML(div, 0).innerHTML;
}

function prettifyHTML(node: Element, level: number) {
  const indentBefore = new Array(level++ + 1).join('  ');
  const indentAfter = new Array(level - 1).join('  ');
  let textNode;

  for (let i = 0; i < node.children.length; i++) {
    // eslint-disable-next-line no-restricted-syntax
    textNode = document.createTextNode('\n' + indentBefore);
    node.insertBefore(textNode, node.children[i]);
    prettifyHTML(node.children[i], level);
    if (node.lastElementChild === node.children[i]) {
      // eslint-disable-next-line no-restricted-syntax
      textNode = document.createTextNode('\n' + indentAfter);
      node.appendChild(textNode);
    }
  }

  return node;
}

function $getSelectionStartEnd(
  node: LexicalNode,
  selection: BaseSelection,
): [number, number] {
  const anchorAndFocus = selection.getStartEndPoints();
  if ($isNodeSelection(selection) || anchorAndFocus === null) {
    return [-1, -1];
  }
  const [anchor, focus] = anchorAndFocus;
  const textContent = node.getTextContent();
  const textLength = textContent.length;

  let start = -1;
  let end = -1;

  // Only one node is being selected.
  if (anchor.type === 'text' && focus.type === 'text') {
    const anchorNode = anchor.getNode();
    const focusNode = focus.getNode();

    if (
      anchorNode === focusNode &&
      node === anchorNode &&
      anchor.offset !== focus.offset
    ) {
      [start, end] =
        anchor.offset < focus.offset
          ? [anchor.offset, focus.offset]
          : [focus.offset, anchor.offset];
    } else if (node === anchorNode) {
      [start, end] = anchorNode.isBefore(focusNode)
        ? [anchor.offset, textLength]
        : [0, anchor.offset];
    } else if (node === focusNode) {
      [start, end] = focusNode.isBefore(anchorNode)
        ? [focus.offset, textLength]
        : [0, focus.offset];
    } else {
      // Node is within selection but not the anchor nor focus.
      [start, end] = [0, textLength];
    }
  }

  // Account for non-single width characters.
  const numNonSingleWidthCharBeforeSelection = (
    textContent.slice(0, start).match(NON_SINGLE_WIDTH_CHARS_REGEX) || []
  ).length;
  const numNonSingleWidthCharInSelection = (
    textContent.slice(start, end).match(NON_SINGLE_WIDTH_CHARS_REGEX) || []
  ).length;

  return [
    start + numNonSingleWidthCharBeforeSelection,
    end +
      numNonSingleWidthCharBeforeSelection +
      numNonSingleWidthCharInSelection,
  ];
}
