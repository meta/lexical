/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getNearestBlockElementAncestorOrThrow,
  $handleIndentAndOutdent,
} from '@lexical/utils';
import {
  $createRangeSelection,
  $getSelection,
  $isBlockElementNode,
  $isRangeSelection,
  $normalizeSelection__EXPERIMENTAL,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_EDITOR,
  defineExtension,
  type ElementNode,
  INDENT_CONTENT_COMMAND,
  INSERT_TAB_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalCommand,
  type LexicalEditor,
  mergeRegister,
  OUTDENT_CONTENT_COMMAND,
  type RangeSelection,
  safeCast,
} from 'lexical';

import {namedSignals} from './namedSignals';
import {effect, type ReadonlySignal} from './signals';

function $indentOverTab(selection: RangeSelection): boolean {
  // const handled = new Set();
  const nodes = selection.getNodes();
  const canIndentBlockNodes = nodes.filter(
    node => $isBlockElementNode(node) && node.canIndent(),
  );
  // 1. If selection spans across canIndent block nodes: indent
  if (canIndentBlockNodes.length > 0) {
    return true;
  }
  // 2. If first (anchor/focus) is at block start: indent
  const anchor = selection.anchor;
  const focus = selection.focus;
  const first = focus.isBefore(anchor) ? focus : anchor;
  const firstNode = first.getNode();
  const firstBlock = $getNearestBlockElementAncestorOrThrow(firstNode);
  if (firstBlock.canIndent()) {
    const firstBlockKey = firstBlock.getKey();
    let selectionAtStart = $createRangeSelection();
    selectionAtStart.anchor.set(firstBlockKey, 0, 'element');
    selectionAtStart.focus.set(firstBlockKey, 0, 'element');
    selectionAtStart = $normalizeSelection__EXPERIMENTAL(selectionAtStart);
    if (selectionAtStart.anchor.is(first)) {
      return true;
    }
  }
  // 3. Else: tab
  return false;
}

export type CanIndentPredicate = (node: ElementNode) => boolean;

function $defaultCanIndent(node: ElementNode) {
  return node.canIndent();
}

/**
 * Registers a `KEY_TAB_COMMAND` handler that makes Tab and Shift+Tab indent and
 * outdent block elements (and otherwise insert a tab). Pass `maxIndent` to cap
 * the indent depth and `$canIndent` to control which elements may be indented.
 *
 * @returns A cleanup function that unregisters the handler.
 */
export function registerTabIndentation(
  editor: LexicalEditor,
  maxIndent?: number | ReadonlySignal<null | number>,
  $canIndent:
    | CanIndentPredicate
    | ReadonlySignal<CanIndentPredicate> = $defaultCanIndent,
) {
  return mergeRegister(
    editor.registerCommand(
      KEY_TAB_COMMAND,
      event => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }
        event.preventDefault();
        const command: LexicalCommand<void> = $indentOverTab(selection)
          ? event.shiftKey
            ? OUTDENT_CONTENT_COMMAND
            : INDENT_CONTENT_COMMAND
          : INSERT_TAB_COMMAND;
        return editor.dispatchCommand(command);
      },
      COMMAND_PRIORITY_EDITOR,
    ),

    editor.registerCommand(
      INDENT_CONTENT_COMMAND,
      () => {
        const currentMaxIndent: null | number =
          typeof maxIndent === 'number'
            ? maxIndent
            : maxIndent
              ? maxIndent.peek()
              : null;

        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }

        const $currentCanIndent =
          typeof $canIndent === 'function' ? $canIndent : $canIndent.peek();

        return $handleIndentAndOutdent(block => {
          if ($currentCanIndent(block)) {
            const newIndent = block.getIndent() + 1;
            if (!currentMaxIndent || newIndent < currentMaxIndent) {
              block.setIndent(newIndent);
            }
          }
        });
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
  );
}

export interface TabIndentationConfig {
  disabled: boolean;
  maxIndent: null | number;
  /**
   * By default, indents are set on all elements for which the {@link ElementNode.canIndent} returns true.
   * This option allows you to set indents for specific nodes without overriding the method for others.
   */
  $canIndent: CanIndentPredicate;
}

/**
 * This extension adds the ability to indent content using the tab key. Generally, we don't
 * recommend using this plugin as it could negatively affect accessibility for keyboard
 * users, causing focus to become trapped within the editor.
 */
export const TabIndentationExtension = defineExtension({
  build(editor, config, state) {
    return namedSignals(config);
  },
  config: safeCast<TabIndentationConfig>({
    $canIndent: $defaultCanIndent,
    disabled: false,
    maxIndent: null,
  }),
  name: '@lexical/extension/TabIndentation',
  register(editor, config, state) {
    const {disabled, maxIndent, $canIndent} = state.getOutput();
    return effect(() => {
      if (!disabled.value) {
        return registerTabIndentation(editor, maxIndent, $canIndent);
      }
    });
  },
});
