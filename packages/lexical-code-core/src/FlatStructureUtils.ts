/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {
  $copyNode,
  $createLineBreakNode,
  $createTabNode,
  $getSiblingCaret,
  $getWritableNodeState,
  $isElementNode,
  $isLineBreakNode,
  $isTabNode,
  $isTextNode,
  type CaretDirection,
  getTextDirection,
  type LexicalNode,
  type LineBreakNode,
  NODE_STATE_KEY,
  type RangeSelection,
  type SiblingCaret,
  type TabNode,
  type TextNode,
  tokenizeRawText,
} from 'lexical';

import {
  $createCodeHighlightNode,
  $isCodeHighlightNode,
  type CodeHighlightNode,
} from './CodeHighlightNode';

// The anchor is generic (rather than the narrower
// `CodeHighlightNode | TabNode | LineBreakNode`) because callers may have only
// narrowed as far as TextNode; the matched siblings are always
// CodeHighlightNode/TabNode, and an unmatched anchor is returned unchanged.
function $getLastMatchingCodeNode<
  T extends TextNode | LineBreakNode,
  D extends CaretDirection,
>(anchor: T, direction: D): T | CodeHighlightNode | TabNode {
  let matchingNode: T | CodeHighlightNode | TabNode = anchor;
  for (
    let caret: null | SiblingCaret<LexicalNode, D> = $getSiblingCaret(
      anchor,
      direction,
    );
    caret && ($isCodeHighlightNode(caret.origin) || $isTabNode(caret.origin));
    caret = caret.getAdjacentCaret()
  ) {
    matchingNode = caret.origin;
  }
  return matchingNode;
}

export function $getFirstCodeNodeOfLine<T extends TextNode | LineBreakNode>(
  anchor: T,
): T | CodeHighlightNode | TabNode {
  return $getLastMatchingCodeNode(anchor, 'previous');
}

export function $getLastCodeNodeOfLine<T extends TextNode | LineBreakNode>(
  anchor: T,
): T | CodeHighlightNode | TabNode {
  return $getLastMatchingCodeNode(anchor, 'next');
}

/**
 * Determines the visual writing direction of a code line.
 *
 * Scans the line segments (CodeHighlightNode/TabNode) from start to end
 * and returns the first strong direction found ("ltr" or "rtl").
 * If no strong character is found, falls back to the parent element's
 * direction. Returns null if indeterminate.
 */
export function $getCodeLineDirection(
  anchor: CodeHighlightNode | TabNode | LineBreakNode,
): 'ltr' | 'rtl' | null {
  const start = $getFirstCodeNodeOfLine(anchor);
  const end = $getLastCodeNodeOfLine(anchor);
  let node: null | LexicalNode = start;

  while (node !== null) {
    if ($isCodeHighlightNode(node)) {
      const direction = getTextDirection(node.getTextContent());
      if (direction !== null) {
        return direction;
      }
    }

    if (node === end) {
      break;
    }

    node = node.getNextSibling();
  }

  const parent = start.getParent();
  if ($isElementNode(parent)) {
    const parentDirection = parent.getDirection();
    if (parentDirection === 'ltr' || parentDirection === 'rtl') {
      return parentDirection;
    }
  }

  return null;
}

export function $getStartOfCodeInLine(
  anchor: CodeHighlightNode | TabNode,
  offset: number,
): null | {
  node: CodeHighlightNode | TabNode | LineBreakNode;
  offset: number;
} {
  let last: null | {
    node: CodeHighlightNode | TabNode | LineBreakNode;
    offset: number;
  } = null;
  let lastNonBlank: null | {node: CodeHighlightNode; offset: number} = null;
  let node: null | CodeHighlightNode | TabNode | LineBreakNode = anchor;
  let nodeOffset = offset;
  let nodeTextContent = anchor.getTextContent();

  while (true) {
    if (nodeOffset === 0) {
      const prevSibling: LexicalNode | null = node.getPreviousSibling();
      if (prevSibling === null) {
        node = null;
        break;
      }
      invariant(
        $isCodeHighlightNode(prevSibling) ||
          $isTabNode(prevSibling) ||
          $isLineBreakNode(prevSibling),
        'Expected a valid Code Node: CodeHighlightNode, TabNode, LineBreakNode',
      );
      node = prevSibling;
      if ($isLineBreakNode(node)) {
        last = {
          node,
          offset: 1,
        };
        break;
      }
      nodeOffset = Math.max(0, node.getTextContentSize() - 1);
      nodeTextContent = node.getTextContent();
    } else {
      nodeOffset--;
    }
    const character = nodeTextContent[nodeOffset];
    if ($isCodeHighlightNode(node) && character !== ' ') {
      lastNonBlank = {
        node,
        offset: nodeOffset,
      };
    }
  }
  // lastNonBlank !== null: anchor in the middle of code; move to line beginning
  if (lastNonBlank !== null) {
    return lastNonBlank;
  }
  // Spaces, tabs or nothing ahead of anchor
  let codeCharacterAtAnchorOffset = null;
  if (offset < anchor.getTextContentSize()) {
    if ($isCodeHighlightNode(anchor)) {
      codeCharacterAtAnchorOffset = anchor.getTextContent()[offset];
    }
  } else {
    const nextSibling = anchor.getNextSibling();
    if ($isCodeHighlightNode(nextSibling)) {
      codeCharacterAtAnchorOffset = nextSibling.getTextContent()[0];
    }
  }
  if (
    codeCharacterAtAnchorOffset !== null &&
    codeCharacterAtAnchorOffset !== ' '
  ) {
    // Borderline whitespace and code, move to line beginning
    return last;
  } else {
    const nextNonBlank = findNextNonBlankInLine(anchor, offset);
    if (nextNonBlank !== null) {
      return nextNonBlank;
    } else {
      return last;
    }
  }
}

function findNextNonBlankInLine(
  anchor: LexicalNode,
  offset: number,
): null | {node: CodeHighlightNode; offset: number} {
  let node: null | LexicalNode = anchor;
  let nodeOffset = offset;
  let nodeTextContent = anchor.getTextContent();
  let nodeTextContentSize = anchor.getTextContentSize();

  while (true) {
    if (!$isCodeHighlightNode(node) || nodeOffset === nodeTextContentSize) {
      node = node.getNextSibling();
      if (node === null || $isLineBreakNode(node)) {
        return null;
      }
      if ($isCodeHighlightNode(node)) {
        nodeOffset = 0;
        nodeTextContent = node.getTextContent();
        nodeTextContentSize = node.getTextContentSize();
      }
    }
    if ($isCodeHighlightNode(node)) {
      if (nodeTextContent[nodeOffset] !== ' ') {
        return {
          node,
          offset: nodeOffset,
        };
      }
      nodeOffset++;
    }
  }
}

export function $getEndOfCodeInLine(
  anchor: CodeHighlightNode | TabNode,
): CodeHighlightNode | TabNode {
  const lastNode = $getLastCodeNodeOfLine(anchor);
  invariant(
    !$isLineBreakNode(lastNode),
    'Unexpected lineBreakNode in getEndOfCodeInLine',
  );
  return lastNode;
}

/**
 * Plain split of code text into CodeHighlightNodes (with no highlight
 * type) + LineBreakNodes + TabNodes. Used when the tokenizer opts out
 * of a default language so a previously highlighted block still
 * renders its `\n` / `\t` as real line breaks / tabs, while staying
 * compatible with the indent / shift-lines handlers that only accept
 * CodeHighlightNode + TabNode + LineBreakNode inside a CodeNode.
 */
export function $plainifyCodeContent(text: string): LexicalNode[] {
  const out: LexicalNode[] = [];
  tokenizeRawText(text, {
    linebreak: () => out.push($createLineBreakNode()),
    tab: () => out.push($createTabNode()),
    text: part => out.push($createCodeHighlightNode(part)),
  });
  return out;
}

/**
 * Give `to` (a new token) the NodeState of `from` (the old node its text came
 * from), flat states included, for the keys `to` does not hold already: what
 * the tokenizer set on the token, or its class sets when it is made, stays.
 * Text leaving a code block is copied the other way round (see the
 * highlighters' own copy): there the old token's values win.
 */
function $copyNodeState(from: LexicalNode, to: LexicalNode): void {
  // @internal access, like `__text`: the NodeState of the node
  const json: Record<string, unknown> = from.__state
    ? from.__state.toJSON()
    : {};
  // The keys `to` already holds (what the tokenizer set on the token) stay
  // as they are, as $carryNodeState leaves them.
  const held = new Set<string>();
  const own = to.getLatest().__state;
  if (own !== undefined) {
    const [unknownState, knownState] = own.getInternalState();
    for (const stateConfig of knownState.keys()) {
      held.add(stateConfig.key);
    }
    for (const key of Object.keys(unknownState || {})) {
      held.add(key);
    }
  }
  const state = $getWritableNodeState(to);
  for (const [key, value] of Object.entries(json)) {
    if (key === NODE_STATE_KEY) {
      for (const [nestedKey, nestedValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (!held.has(nestedKey)) {
          state.updateFromUnknown(nestedKey, nestedValue);
        }
      }
    } else if (!held.has(key)) {
      state.updateFromUnknown(key, value);
    }
  }
  // States the node knows by their StateConfig stay known on the copy (a
  // StateConfig not registered for the copy's class would otherwise be
  // read back as an unknown JSON value: a set-valued state, for one). As in
  // the JSON: not a default value (the copy keeps what it has, such as state
  // its replacement class sets), and the value of a key the copy's class
  // has another StateConfig for stays parsed with that one (above).
  if (from.__state) {
    const {sharedConfigMap} = state.sharedNodeState;
    for (const [config, value] of from.__state.getInternalState()[1]) {
      if (held.has(config.key) || config.isEqual(value, config.defaultValue)) {
        continue;
      }
      const registered = sharedConfigMap.get(config.key);
      if (registered === undefined || registered === config) {
        state.updateFromKnown(config, value);
      }
    }
  }
}

/** Whether `node` has NodeState (such as comment ids or a suggestion). */
function hasNodeState(node: LexicalNode): boolean {
  // @internal access, like `__text`
  return (
    node.__state !== undefined && Object.keys(node.__state.toJSON()).length > 0
  );
}

/**
 * @internal
 * For a highlighter that tokenizes a code block again: `nextNodes`, the new
 * tokens of the text of `prevNodes` (the block's children), with the
 * NodeState of `prevNodes` kept (such as comment ids or a suggestion, which
 * collaboration stores on the text). A token is split at the boundaries of
 * each node with NodeState, and each part is a copy of the token (its class,
 * its fields and the NodeState the tokenizer gave it) with the NodeState of
 * the node its text came from, for the keys the token does not hold. A new
 * tab or line break gets the NodeState of the tab or line break at the same
 * offset in `prevNodes`, the same way.
 * Returns `nextNodes` itself when no node of `prevNodes` has NodeState.
 */
export function $keepCodeNodeState(
  prevNodes: LexicalNode[],
  nextNodes: LexicalNode[],
): LexicalNode[] {
  // The common case, on every keystroke in code: no NodeState at all.
  if (!prevNodes.some(hasNodeState)) {
    return nextNodes;
  }
  const spans: {end: number; node: LexicalNode; start: number}[] = [];
  // The tabs and line breaks with NodeState, by their offset.
  const breaks = new Map<number, LexicalNode>();
  let at = 0;
  for (const node of prevNodes) {
    const size = node.getTextContentSize();
    if (hasNodeState(node)) {
      if ($isTabNode(node) || $isLineBreakNode(node)) {
        breaks.set(at, node);
      } else if (size > 0 && $isTextNode(node)) {
        spans.push({end: at + size, node, start: at});
      }
    }
    at += size;
  }
  if (spans.length === 0 && breaks.size === 0) {
    return nextNodes;
  }
  const out: LexicalNode[] = [];
  let next = 0;
  at = 0;
  for (const node of nextNodes) {
    const size = node.getTextContentSize();
    const start = at;
    const end = at + size;
    at = end;
    while (next < spans.length && spans[next].end <= start) {
      next++;
    }
    const prevBreak = breaks.get(start);
    if (
      prevBreak !== undefined &&
      (($isTabNode(node) && $isTabNode(prevBreak)) ||
        ($isLineBreakNode(node) && $isLineBreakNode(prevBreak)))
    ) {
      $copyNodeState(prevBreak, node);
      out.push(node);
      continue;
    }
    if (
      !$isCodeHighlightNode(node) ||
      next === spans.length ||
      spans[next].start >= end
    ) {
      out.push(node);
      continue;
    }
    const text = node.getTextContent();
    let pos = start;
    let k = next;
    while (pos < end) {
      const span = k < spans.length && spans[k].start < end ? spans[k] : null;
      let partEnd = end;
      let from: LexicalNode | null = null;
      if (span !== null && pos < span.start) {
        partEnd = span.start;
      } else if (span !== null) {
        partEnd = Math.min(end, span.end);
        from = span.node;
      }
      let part: CodeHighlightNode = node;
      if (partEnd - pos !== size) {
        // A part of the token: the same class as the token, with its fields
        // and the NodeState the tokenizer gave it (not reset).
        part = $copyNode(node, true);
        part.setTextContent(text.slice(pos - start, partEnd - start));
      }
      if (from !== null) {
        $copyNodeState(from, part);
        if (partEnd === span!.end) {
          k++;
        }
      }
      out.push(part);
      pos = partEnd;
    }
  }
  return out;
}

/**
 * Strip up to `tabSize` leading spaces from a {@link CodeHighlightNode} that
 * starts a code line, to support outdenting space-indented code lines (e.g.
 * code formatted with prettier). Returns true if any spaces were stripped.
 *
 * Best-effort: a line with fewer than `tabSize` leading spaces has all of
 * them stripped, matching VS Code / IntelliJ behavior.
 *
 * Selection is preserved relative to line content. Anchor/focus offsets
 * pointing into `node` shift left by the number of stripped characters
 * (clamped to 0). The underlying TextNode mutation does not adjust
 * selection offsets that already point into the old text, so we patch
 * them up explicitly.
 */
export function $outdentLeadingSpaces(
  node: CodeHighlightNode,
  tabSize: number,
  selection: RangeSelection,
): boolean {
  if (!Number.isInteger(tabSize) || tabSize <= 0) {
    return false;
  }
  const text = node.getTextContent();
  const leading = /^ +/.exec(text);
  if (!leading) {
    return false;
  }
  const stripCount = Math.min(tabSize, leading[0].length);
  const lineKey = node.getKey();
  const oldAnchorOffset =
    selection.anchor.key === lineKey && selection.anchor.type === 'text'
      ? selection.anchor.offset
      : null;
  const oldFocusOffset =
    selection.focus.key === lineKey && selection.focus.type === 'text'
      ? selection.focus.offset
      : null;
  node.spliceText(0, stripCount, '');
  if (oldAnchorOffset !== null) {
    selection.anchor.set(
      lineKey,
      Math.max(0, oldAnchorOffset - stripCount),
      'text',
    );
  }
  if (oldFocusOffset !== null) {
    selection.focus.set(
      lineKey,
      Math.max(0, oldFocusOffset - stripCount),
      'text',
    );
  }
  return true;
}
