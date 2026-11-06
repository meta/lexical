/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {getStyleObjectFromCSS as getStyleObjectFromCSS_} from 'lexical';

import {$trimTextContentFromAnchor} from './lexical-node';

export {
  $addNodeStyle,
  $ensureForwardRangeSelection,
  $forEachSelectedTextNode,
  $isAtNodeEnd,
  $patchStyleText,
  $sliceSelectedTextNodeContent,
  $trimTextContentFromAnchor,
} from './lexical-node';
export {
  $convertContiguousNodeSelection,
  $exitNodeSelectionToward,
} from './node-selection';
export {
  $copyBlockFormatIndent,
  $getSelectionStyleValueForProperty,
  $isAtEdgeOfElement,
  $isParentElementRTL,
  $moveCaretSelection,
  $moveCharacter,
  $setBlocksType,
  $shouldOverrideDefaultCharacterSelection,
  $wrapNodes,
} from './range-selection';
export {
  $getComputedStyleForElement,
  $getComputedStyleForParent,
  $isParentRTL,
  createDOMRange,
  createRectsFromDOMRange,
  getCSSFromStyleObject,
} from './utils';
/** @deprecated moved to the `lexical` package */
export const getStyleObjectFromCSS = getStyleObjectFromCSS_;
/** @deprecated renamed to {@link $trimTextContentFromAnchor} by @lexical/eslint-plugin rules-of-lexical */
export const trimTextContentFromAnchor = $trimTextContentFromAnchor;
export {
  /** @deprecated moved to the lexical package */ $cloneWithProperties,
  /** @deprecated moved to the lexical package */ $selectAll,
} from 'lexical';
