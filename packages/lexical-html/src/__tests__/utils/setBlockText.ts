/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The `$setBlockText` of the Block IDs documentation page
// (packages/lexical-website/docs/extensions/block-ids.md), as written there.
// Keep the two in sync (BlockIdDocs.test.ts checks it).

import {
  $createTextNode,
  $getSlotNames,
  $isElementNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';

// Changes a block's text in place: only the characters that differ, in the
// block's own text nodes. block.replace(newBlock) would re-create the block,
// and what a collaborator types in it meanwhile would not stay where they
// typed it. Returns false, changing nothing, unless the block holds only
// simple text (no tabs, hashtags or other special text nodes), directly or
// in inline elements such as links: no line breaks, nested blocks, named
// slots or decorators, even ones without text. Text added at the edge of an
// inline element that takes no text there (a link) goes beside it, as typing
// does.
export function $setBlockText(block: LexicalNode, text: string): boolean {
  if (!$isElementNode(block) || !$holdsOnlyText(block)) {
    return false;
  }
  const nodes = block.getAllTextNodes();
  const old = nodes.map(node => node.getTextContent()).join('');
  let start = 0;
  while (start < old.length && old[start] === text[start]) {
    start++;
  }
  let end = 0;
  while (
    end < old.length - start &&
    end < text.length - start &&
    old[old.length - 1 - end] === text[text.length - 1 - end]
  ) {
    end++;
  }
  const inserted = text.slice(start, text.length - end);
  const deleteEnd = old.length - end;
  let offset = 0;
  let done = false;
  for (const node of nodes) {
    const size = node.getTextContentSize();
    const from = Math.max(start - offset, 0);
    const to = Math.min(deleteEnd - offset, size);
    if (
      !done &&
      (start - offset < size ||
        (start - offset === size && start === deleteEnd))
    ) {
      // The node where the change starts (for an insert at a node boundary,
      // the node before it): delete and insert there.
      if (start === deleteEnd) {
        $insertText(node, from, inserted);
      } else {
        node.spliceText(from, to - from, inserted);
      }
      done = true;
    } else if (to > from) {
      node.spliceText(from, to - from, '');
    }
    offset += size;
  }
  if (!done && inserted !== '') {
    block.append($createTextNode(inserted));
  }
  return true;
}

function $holdsOnlyText(element: ElementNode): boolean {
  // Named slots hold blocks of their own (and count in getTextContent).
  return (
    $getSlotNames(element).length === 0 &&
    element
      .getChildren()
      .every(
        child =>
          ($isTextNode(child) && child.isSimpleText()) ||
          ($isElementNode(child) && child.isInline() && $holdsOnlyText(child)),
      )
  );
}

// Inserts text at `at` in `node`, or, at an edge of inline elements that
// take no text there (canInsertTextAfter or canInsertTextBefore is false, as
// for a link or a mark), beside the outermost of them.
function $insertText(node: TextNode, at: number, text: string): void {
  if (text === '') {
    return;
  }
  const atEnd = at === node.getTextContentSize();
  let outermost: ElementNode | null = null;
  for (
    let inner: LexicalNode = node, parent = node.getParent();
    $isElementNode(parent) && parent.isInline();
    inner = parent, parent = parent.getParent()
  ) {
    if (
      atEnd
        ? inner.getNextSibling() !== null
        : at !== 0 || inner.getPreviousSibling() !== null
    ) {
      break;
    }
    if (atEnd ? !parent.canInsertTextAfter() : !parent.canInsertTextBefore()) {
      outermost = parent;
    }
  }
  if (outermost === null) {
    node.spliceText(at, 0, text);
    return;
  }
  const beside = atEnd
    ? outermost.getNextSibling()
    : outermost.getPreviousSibling();
  if ($isTextNode(beside) && beside.isSimpleText()) {
    beside.spliceText(atEnd ? 0 : beside.getTextContentSize(), 0, text);
  } else if (atEnd) {
    outermost.insertAfter($createTextNode(text));
  } else {
    outermost.insertBefore($createTextNode(text));
  }
}
