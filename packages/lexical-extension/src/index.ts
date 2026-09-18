/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

export {type AutoFocusConfig, AutoFocusExtension} from './AutoFocusExtension';
export {
  type ClearEditorConfig,
  ClearEditorExtension,
  registerClearEditor,
} from './ClearEditorExtension';
export {
  $defaultShouldInsertAfter,
  type ClickAfterLastBlockConfig,
  ClickAfterLastBlockExtension,
  type ClickAfterLastBlockOutput,
} from './ClickAfterLastBlockExtension';
export {getKnownTypesAndNodes, type KnownTypesAndNodes} from './config';
export {
  $applyFormatToDom,
  $isDecoratorTextNode,
  applyFormatFromStyle,
  applyFormatToDom,
  DecoratorTextExtension,
  DecoratorTextNode,
  type SerializedDecoratorTextNode,
} from './DecoratorTextExtension';
export {EditorStateExtension} from './EditorStateExtension';
export {
  $getExtensionDependency,
  $getExtensionOutput,
  $getPeerDependency,
} from './getExtensionDependency';
export {getExtensionDependencyFromEditor} from './getExtensionDependencyFromEditor';
export {
  getPeerDependencyFromEditor,
  getPeerDependencyFromEditorOrThrow,
} from './getPeerDependencyFromEditor';
export {
  type HMRConfig,
  HMRExtension,
  type HMROutput,
  type HotContext,
} from './HMRExtension';
export {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  HorizontalRuleExtension,
  HorizontalRuleNode,
  INSERT_HORIZONTAL_RULE_COMMAND,
  type SerializedHorizontalRuleNode,
} from './HorizontalRuleExtension';
export {IMEExtension} from './IMEExtension';
export {
  type InitialStateConfig,
  InitialStateExtension,
} from './InitialStateExtension';
export {
  formatKeyboardShortcut,
  type FormatKeyboardShortcutOptions,
  type KeyboardShortcutsConfig,
  KeyboardShortcutsExtension,
  type NamedKeyboardShortcuts,
} from './KeyboardShortcutsExtension';
export {buildEditorFromExtensions, LexicalBuilder} from './LexicalBuilder';
export {
  namedSignals,
  type NamedSignalsOptions,
  type NamedSignalsOutput,
} from './namedSignals';
export {NestedEditorExtension} from './NestedEditorExtension';
export {
  type NodeSelectionDataSelectedConfig,
  NodeSelectionDataSelectedExtension,
} from './NodeSelectionDataSelectedExtension';
export {NodeSelectionExtension} from './NodeSelectionExtension';
export {
  type NormalizeInlineElementsConfig,
  NormalizeInlineElementsExtension,
} from './NormalizeInlineElementsExtension';
export {
  type NormalizeTripleClickSelectionConfig,
  NormalizeTripleClickSelectionExtension,
  type NormalizeTripleClickSelectionOutput,
} from './NormalizeTripleClickSelectionExtension';
export {
  type PreventSelectAllConfig,
  PreventSelectAllExtension,
} from './PreventSelectAllExtension';
export {RootElementExtension} from './RootElementExtension';
export {
  type SelectBlockConfig,
  SelectBlockExtension,
} from './SelectBlockExtension';
export {SelectionAlwaysOnDisplayExtension} from './SelectionAlwaysOnDisplayExtension';
export {
  batch,
  computed,
  effect,
  type ReadonlySignal,
  type Signal,
  signal,
  type SignalOptions,
  untracked,
} from './signals';
export {
  type CanIndentPredicate,
  registerTabIndentation,
  type TabIndentationConfig,
  TabIndentationExtension,
} from './TabIndentationExtension';
export {WatchEditableExtension} from './WatchEditableExtension';
export {watchedSignal} from './watchedSignal';
export {
  type AnyLexicalExtension,
  type AnyLexicalExtensionArgument,
  type CompiledKeyboardShortcuts,
  compileKeyboardShortcuts,
  configExtension,
  CONTROL_OR_ALT,
  CONTROL_OR_META,
  declarePeerDependency,
  defineExtension,
  type ExtensionConfigBase,
  type ExtensionRegisterState,
  type InitialEditorStateType,
  type KeyboardShortcut,
  type KeyboardShortcutMatch,
  type LexicalEditorWithDispose,
  type LexicalExtension,
  type LexicalExtensionArgument,
  type LexicalExtensionConfig,
  type LexicalExtensionDependency,
  type LexicalExtensionInit,
  type LexicalExtensionName,
  type LexicalExtensionOutput,
  type NormalizedLexicalExtensionArgument,
  type NormalizedPeerDependency,
  type OutputComponentExtension,
  safeCast,
  shallowMergeConfig,
} from 'lexical';
