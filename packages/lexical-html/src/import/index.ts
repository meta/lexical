/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {parseSelector} from './parseCss';
import {selBase} from './sel';

/**
 * Combinator-and-parser-based builder for {@link CompiledSelector}s. The
 * runtime shape returned by these factory methods is opaque; consumers
 * should never inspect or construct selector objects directly.
 *
 * @experimental
 * @lexical-pure-namespace
 */
export const sel = {
  any: selBase.any,
  comment: selBase.comment,
  /**
   * Parse a reduced CSS-selector subset and return a builder you can chain
   * combinator methods off of.
   */
  css: parseSelector,
  tag: selBase.tag,
  text: selBase.text,
} as const;

export {CoreImportExtension} from './CoreImportExtension';
export {CoreImportRules} from './coreImportRules';
export {defineImportRule} from './defineImportRule';
export {
  type CompiledOverlayRules,
  defineOverlayRules,
  type DOMImportRuleEntry,
} from './defineOverlayRules';
export {
  $generateNodesFromDOMViaExtension,
  type DOMImportConfig,
  DOMImportExtension,
} from './DOMImportExtension';
export {
  HorizontalRuleImportExtension,
  HorizontalRuleImportRules,
} from './HorizontalRuleImportExtension';
export {
  $getImportContextValue,
  $withImportContext,
  createImportState,
  defaultIsInline,
  defaultPreservesWhitespace,
  ImportOverlays,
  ImportSource,
  ImportSourceDataTransfer,
  type ImportSourceKind,
  ImportTextFormat,
  ImportTextStyle,
  ImportWhitespaceConfig,
  type IsInlineForWhitespace,
  type IsPreserveWhitespaceDom,
  type WhitespaceImportConfig,
} from './ImportContext';
export {$inlineStylesFromStyleSheets} from './inlineStylesFromStyleSheets';
export {parseSelector} from './parseCss';
export {
  $distributeInlineWrapper,
  $isBlockLevel,
  $propagateTextAlignToBlockChildren,
  BlockSchema,
  InlineSchema,
  NestedBlockSchema,
  RootSchema,
} from './schemas';
export {isElementOfTag} from './sel';
export type {
  AnyDOMImportRule,
  AttrMatchOptions,
  CapturesOfSelector,
  ChildSchema,
  CompiledSelector,
  DOMImportContext,
  DOMImportExtensionOutput,
  DOMImportFn,
  DOMImportRule,
  DOMPreprocessContext,
  DOMPreprocessFn,
  ElementSelectorBuilder,
  GenerateNodesFromDOMOptions,
  ImportChildrenOpts,
  ImportContextPairOrUpdater,
  ImportNodeOpts,
  ImportSession,
  ImportStateConfig,
  NodeOfSelector,
  StyleMatchOptions,
} from './types';
