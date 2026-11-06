/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {$isLinkNode, type LinkNode} from '@lexical/link';
import {
  $caretRangeFromSelection,
  $findMatchingParent,
  $isChildCaret,
  $isSiblingCaret,
  type CaretRange,
  type LexicalNode,
  type PointCaret,
  type RangeSelection,
} from 'lexical';

/**
 * Yield every caret that contributes content to the range: the anchor and
 * focus text slices when they are not empty, plus the node carets between
 * them. A collapsed range yields its single caret so that a caret placed
 * inside a link still resolves to that link.
 */
function* $iterRangeContent(range: CaretRange): Generator<PointCaret> {
  if (range.isCollapsed()) {
    yield range.anchor;
    return;
  }
  const [anchorSlice, focusSlice] = range.getTextSlices();
  if (anchorSlice && anchorSlice.distance !== 0) {
    yield anchorSlice.caret;
  }
  yield* range;
  if (focusSlice && focusSlice.distance !== 0) {
    yield focusSlice.caret;
  }
}

/**
 * Resolve the {@link LinkNode} a selection refers to, or `null` when the
 * selection covers anything outside of exactly one link.
 *
 * The range is walked once. Leading {@link ChildCaret}s descend into the
 * elements the range starts at, so a link selected through its paragraph or
 * the root (how some browsers represent select-all) is found on entry. The
 * first caret that carries content decides the link; after the walk leaves
 * that link (a {@link SiblingCaret} whose origin is the link) the only carets
 * allowed are the ones that leave each successive ancestor.
 */
export function $getSelectionLinkNode(
  selection: RangeSelection,
): LinkNode | null {
  let link: LinkNode | null = null;
  // The last element the walk has left, once it is outside the link
  let left: LexicalNode | null = null;
  for (const caret of $iterRangeContent($caretRangeFromSelection(selection))) {
    const {origin} = caret;
    if (left !== null) {
      // Outside the link, the walk may only climb out of its ancestors
      if (!$isSiblingCaret(caret) || !origin.is(left.getParent())) {
        return null;
      }
      left = origin;
      continue;
    }
    if (link === null) {
      if ($isChildCaret(caret) && !$isLinkNode(origin)) {
        // Descending into the first child of an element the range starts at
        continue;
      }
      link = $findMatchingParent(origin, $isLinkNode);
      if (link === null) {
        return null;
      }
    }
    if ($isSiblingCaret(caret) && link.is(origin)) {
      left = link;
    }
  }
  return link;
}
