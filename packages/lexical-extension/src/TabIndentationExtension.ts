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
  ElementNode,
  INDENT_CONTENT_COMMAND,
  INSERT_TAB_COMMAND,
  KEY_TAB_COMMAND,
  type Klass,
  type LexicalCommand,
  type LexicalEditor,
  mergeRegister,
  OUTDENT_CONTENT_COMMAND,
  type RangeSelection,
  RootNode,
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
 * Indentation from anywhere other than the indent command must stay below
 * maxIndent too (#5170), so clamp it with a transform on every block element
 * type that may be indented. This applies to all content, not only pastes:
 * the initial or loaded editor state, `setEditorState`, collaboration
 * updates and nodes inserted from code. Registering marks every element
 * dirty, so the whole document is checked (and clamped) once at that point.
 */
function registerMaxIndentTransforms(
  editor: LexicalEditor,
  maxIndent: number,
  $getCanIndent: () => CanIndentPredicate,
): () => void {
  const $clampIndent = (node: ElementNode) => {
    if (node.getIndent() >= maxIndent && $getCanIndent()(node)) {
      node.setIndent(maxIndent - 1);
    }
  };
  const removers: (() => void)[] = [];
  for (const {klass} of editor._nodes.values()) {
    if (klass.prototype instanceof ElementNode && klass !== RootNode) {
      removers.push(
        editor.registerNodeTransform(klass as Klass<ElementNode>, $clampIndent),
      );
    }
  }
  return mergeRegister(...removers);
}

/**
 * Registers a `KEY_TAB_COMMAND` handler that makes Tab and Shift+Tab indent and
 * outdent block elements (and otherwise insert a tab). Pass `maxIndent` to cap
 * the indent depth (indents below `maxIndent`), and `$canIndent` to control
 * which elements may be indented. The `maxIndent` cap applies to any content,
 * including pastes, loaded state, `setEditorState` and collaboration updates;
 * deeper indents already in the document are clamped once on registration.
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
  const $getCanIndent = () =>
    typeof $canIndent === 'function' ? $canIndent : $canIndent.peek();
  let unregisterClamp: () => void;
  if (typeof maxIndent === 'number') {
    unregisterClamp = maxIndent
      ? registerMaxIndentTransforms(editor, maxIndent, $getCanIndent)
      : () => {};
  } else if (maxIndent) {
    unregisterClamp = effect(() => {
      const currentMaxIndent = maxIndent.value;
      if (currentMaxIndent) {
        return registerMaxIndentTransforms(
          editor,
          currentMaxIndent,
          $getCanIndent,
        );
      }
    });
  } else {
    unregisterClamp = () => {};
  }
  return mergeRegister(
    unregisterClamp,
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
