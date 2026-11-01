/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

export type {SerializedCodeNode} from '@lexical/code-core';
export {
  $createCodeHighlightNode,
  $createCodeNode,
  $getCodeLineDirection,
  $getEndOfCodeInLine,
  $getFirstCodeNodeOfLine,
  $getLastCodeNodeOfLine,
  $getStartOfCodeInLine,
  $isCodeHighlightNode,
  $isCodeNode,
  $outdentLeadingSpaces,
  CodeExtension,
  CodeHighlightNode,
  type CodeIndentConfig,
  CodeIndentExtension,
  CodeNode,
  DEFAULT_CODE_LANGUAGE,
  getDefaultCodeLanguage,
} from '@lexical/code-core';
