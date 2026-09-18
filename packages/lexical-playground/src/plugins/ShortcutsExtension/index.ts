/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  KeyboardShortcutsExtension,
  type NamedKeyboardShortcuts,
  signal,
} from '@lexical/extension';
import {$isLinkNode, TOGGLE_LINK_COMMAND} from '@lexical/link';
import {$isListNode, ListNode} from '@lexical/list';
import {$isHeadingNode} from '@lexical/rich-text';
import {$getSelectionStyleValueForProperty} from '@lexical/selection';
import {
  $findMatchingParent,
  $getNearestNodeOfType,
  mergeRegister,
} from '@lexical/utils';
import {
  $getSelection,
  $isRangeSelection,
  $isRootOrShadowRoot,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  createCommand,
  defineExtension,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode,
  OUTDENT_CONTENT_COMMAND,
} from 'lexical';

import {DEFAULT_FONT_SIZE} from '../../context/ToolbarContext';
import {getSelectedNode} from '../../utils/getSelectedNode';
import {sanitizeUrl} from '../../utils/url';
import {INSERT_INLINE_COMMAND} from '../CommentPlugin';
import {
  $clearFormatting,
  $formatBulletList,
  $formatCheckList,
  $formatCode,
  $formatHeading,
  $formatNumberedList,
  $formatParagraph,
  $formatQuote,
  $updateFontSize,
  UpdateFontSizeType,
} from '../ToolbarPlugin/utils';
import {SHORTCUT_BINDINGS} from './shortcuts';

export type ShortcutName = keyof typeof SHORTCUT_BINDINGS;

const SHORTCUT_NAMES = Object.keys(SHORTCUT_BINDINGS) as ShortcutName[];

/**
 * One command per shortcut action, dispatched with the matched
 * KeyboardEvent as its payload. The key bindings in
 * {@link SHORTCUT_BINDINGS} are pure data mapping keystrokes to these
 * commands, so shortcuts can be remapped (or dispatched from menus and
 * buttons) without touching the behavior registered by
 * {@link ShortcutsExtension}.
 */
const SHORTCUT_COMMANDS: Record<
  ShortcutName,
  LexicalCommand<KeyboardEvent>
> = Object.fromEntries(
  SHORTCUT_NAMES.map(name => [
    name,
    createCommand<KeyboardEvent>(`@lexical/playground/Shortcuts/${name}`),
  ]),
) as Record<ShortcutName, LexicalCommand<KeyboardEvent>>;

function buildShortcuts(): NamedKeyboardShortcuts {
  return Object.fromEntries(
    SHORTCUT_NAMES.map(name => [
      name,
      {...SHORTCUT_BINDINGS[name], command: SHORTCUT_COMMANDS[name]},
    ]),
  );
}

function $findTopLevelElement(node: LexicalNode): LexicalNode {
  let topLevelElement =
    node.getKey() === 'root'
      ? node
      : $findMatchingParent(node, e => {
          const parent = e.getParent();
          return parent !== null && $isRootOrShadowRoot(parent);
        });
  if (topLevelElement === null) {
    topLevelElement = node.getTopLevelElementOrThrow();
  }
  return topLevelElement;
}

/**
 * The block type of the current selection (mirrors the computation the
 * toolbar uses for its block format dropdown)
 */
function $getBlockType(): string {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return '';
  }
  const anchorNode = selection.anchor.getNode();
  const element = $findTopLevelElement(anchorNode);
  if ($isListNode(element)) {
    const parentList = $getNearestNodeOfType(anchorNode, ListNode);
    return parentList ? parentList.getListType() : element.getListType();
  }
  return $isHeadingNode(element) ? element.getTag() : element.getType();
}

function $getFontSizeInputValue(): string {
  const selection = $getSelection();
  return $isRangeSelection(selection)
    ? $getSelectionStyleValueForProperty(
        selection,
        'font-size',
        `${DEFAULT_FONT_SIZE}px`,
      ).slice(0, -2)
    : `${DEFAULT_FONT_SIZE}`;
}

/**
 * Registers the playground's keyboard shortcuts through
 * {@link KeyboardShortcutsExtension}: the key bindings are contributed to
 * its named shortcut table (a signal, so they can be remapped or disabled
 * at runtime), and this extension registers the command listeners that
 * implement each action.
 *
 * The output exposes an `isLinkEditMode` signal that the link shortcut
 * sets, consumed by the floating link editor UI.
 */
export const ShortcutsExtension = defineExtension({
  build() {
    return {isLinkEditMode: /* @__PURE__ */ signal(false)};
  },
  dependencies: [
    configExtension(KeyboardShortcutsExtension, {
      shortcuts: /* @__PURE__ */ buildShortcuts(),
    }),
  ],
  name: '@lexical/playground/Shortcuts',
  register(editor, config, state) {
    const {isLinkEditMode} = state.getOutput();
    const listen = (
      name: ShortcutName,
      $onShortcut: (fromEditor: LexicalEditor) => void,
    ) =>
      editor.registerCommand(
        SHORTCUT_COMMANDS[name],
        (event, fromEditor) => {
          $onShortcut(fromEditor);
          event.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      );
    return mergeRegister(
      listen('NORMAL', () => $formatParagraph()),
      listen('HEADING1', () => $formatHeading($getBlockType(), 'h1')),
      listen('HEADING2', () => $formatHeading($getBlockType(), 'h2')),
      listen('HEADING3', () => $formatHeading($getBlockType(), 'h3')),
      listen('NUMBERED_LIST', () => $formatNumberedList($getBlockType())),
      listen('BULLET_LIST', () => $formatBulletList($getBlockType())),
      listen('CHECK_LIST', () => $formatCheckList($getBlockType())),
      listen('CODE_BLOCK', () => $formatCode($getBlockType())),
      listen('QUOTE', () => $formatQuote($getBlockType())),
      listen('ADD_COMMENT', e => e.dispatchCommand(INSERT_INLINE_COMMAND)),
      listen('INCREASE_FONT_SIZE', () =>
        $updateFontSize(UpdateFontSizeType.increment, $getFontSizeInputValue()),
      ),
      listen('DECREASE_FONT_SIZE', () =>
        $updateFontSize(UpdateFontSizeType.decrement, $getFontSizeInputValue()),
      ),
      listen('INSERT_CODE_BLOCK', e =>
        e.dispatchCommand(FORMAT_TEXT_COMMAND, 'code'),
      ),
      listen('STRIKETHROUGH', e =>
        e.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough'),
      ),
      listen('LOWERCASE', e =>
        e.dispatchCommand(FORMAT_TEXT_COMMAND, 'lowercase'),
      ),
      listen('UPPERCASE', e =>
        e.dispatchCommand(FORMAT_TEXT_COMMAND, 'uppercase'),
      ),
      listen('CAPITALIZE', e =>
        e.dispatchCommand(FORMAT_TEXT_COMMAND, 'capitalize'),
      ),
      listen('CENTER_ALIGN', e =>
        e.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center'),
      ),
      listen('JUSTIFY_ALIGN', e =>
        e.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'justify'),
      ),
      listen('LEFT_ALIGN', e =>
        e.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'left'),
      ),
      listen('RIGHT_ALIGN', e =>
        e.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'right'),
      ),
      listen('SUBSCRIPT', e =>
        e.dispatchCommand(FORMAT_TEXT_COMMAND, 'subscript'),
      ),
      listen('SUPERSCRIPT', e =>
        e.dispatchCommand(FORMAT_TEXT_COMMAND, 'superscript'),
      ),
      listen('INDENT', e => e.dispatchCommand(INDENT_CONTENT_COMMAND)),
      listen('OUTDENT', e => e.dispatchCommand(OUTDENT_CONTENT_COMMAND)),
      listen('CLEAR_FORMATTING', () => $clearFormatting()),
      listen('INSERT_LINK', e => {
        const selection = $getSelection();
        let isLink = false;
        if ($isRangeSelection(selection)) {
          const node = getSelectedNode(selection);
          isLink = $isLinkNode(node) || $isLinkNode(node.getParent());
        }
        isLinkEditMode.value = !isLink;
        e.dispatchCommand(
          TOGGLE_LINK_COMMAND,
          isLink ? null : sanitizeUrl('https://'),
        );
      }),
    );
  },
});
