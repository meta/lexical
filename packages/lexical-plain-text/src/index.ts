/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getHtmlContent,
  $handlePlainTextDrop,
  $insertDataTransferForPlainText,
  $writeDragSourceToDataTransfer,
} from '@lexical/clipboard';
import {DragonExtension} from '@lexical/dragon';
import {
  NormalizeInlineElementsExtension,
  NormalizeTripleClickSelectionExtension,
} from '@lexical/extension';
import {
  $moveCharacter,
  $shouldOverrideDefaultCharacterSelection,
} from '@lexical/selection';
import {objectKlassEquals} from '@lexical/utils';
import {
  $getSelection,
  $getSlotFrame,
  $isRangeSelection,
  $selectAll,
  CAN_USE_BEFORE_INPUT,
  COMMAND_PRIORITY_EDITOR,
  type CommandPayloadType,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  COPY_COMMAND,
  CUT_COMMAND,
  CUT_TAG,
  defineExtension,
  DELETE_CHARACTER_COMMAND,
  DELETE_LINE_COMMAND,
  DELETE_WORD_COMMAND,
  DRAGSTART_COMMAND,
  DROP_COMMAND,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  IS_APPLE_WEBKIT,
  IS_IOS,
  IS_SAFARI,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  mergeRegister,
  PASTE_COMMAND,
  PASTE_TAG,
  REMOVE_TEXT_COMMAND,
  SELECT_ALL_COMMAND,
} from 'lexical';

function onCopyForPlainText(
  event: CommandPayloadType<typeof COPY_COMMAND>,
  editor: LexicalEditor,
): void {
  editor.update(() => {
    if (event !== null) {
      const clipboardData = objectKlassEquals(event, KeyboardEvent)
        ? null
        : event.clipboardData;
      const selection = $getSelection();

      if (
        selection !== null &&
        !selection.isCollapsed() &&
        clipboardData != null
      ) {
        event.preventDefault();
        const htmlString = $getHtmlContent(editor);

        if (htmlString !== null) {
          clipboardData.setData('text/html', htmlString);
        }

        clipboardData.setData('text/plain', selection.getTextContent());
      }
    }
  });
}

function onPasteForPlainText(
  event: CommandPayloadType<typeof PASTE_COMMAND>,
  editor: LexicalEditor,
): void {
  event.preventDefault();
  editor.update(
    () => {
      const selection = $getSelection();
      const clipboardData = objectKlassEquals(event, ClipboardEvent)
        ? event.clipboardData
        : null;
      if (clipboardData != null && $isRangeSelection(selection)) {
        $insertDataTransferForPlainText(clipboardData, selection);
      }
    },
    {
      // PASTE_TAG gives the paste its own undo entry: @lexical/history treats
      // the tag as a history boundary so undoing a paste does not also undo any
      // typing that preceded it (see #8609).
      tag: PASTE_TAG,
    },
  );
}

function onCutForPlainText(
  event: CommandPayloadType<typeof CUT_COMMAND>,
  editor: LexicalEditor,
): void {
  onCopyForPlainText(event, editor);
  editor.update(
    () => {
      const selection = $getSelection();

      if ($isRangeSelection(selection)) {
        selection.removeText();
      }
    },
    {
      // CUT_TAG gives the cut its own undo entry: @lexical/history treats the
      // tag as a history boundary so undoing a cut does not also undo any typing
      // that preceded it (see #8609).
      tag: CUT_TAG,
    },
  );
}

export function registerPlainText(editor: LexicalEditor): () => void {
  const removeListener = mergeRegister(
    editor.registerCommand(
      DELETE_CHARACTER_COMMAND,
      isBackward => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        selection.deleteCharacter(isBackward);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      DELETE_WORD_COMMAND,
      isBackward => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        selection.deleteWord(isBackward);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      DELETE_LINE_COMMAND,
      isBackward => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        selection.deleteLine(isBackward);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      CONTROLLED_TEXT_INSERTION_COMMAND,
      eventOrText => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        if (typeof eventOrText === 'string') {
          selection.insertText(eventOrText);
        } else {
          const dataTransfer = eventOrText.dataTransfer;

          if (dataTransfer != null) {
            $insertDataTransferForPlainText(dataTransfer, selection);
          } else {
            const data = eventOrText.data;

            if (data) {
              selection.insertText(data);
            }
          }
        }

        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      REMOVE_TEXT_COMMAND,
      () => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        selection.removeText();
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      INSERT_LINE_BREAK_COMMAND,
      selectStart => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        selection.insertLineBreak(selectStart);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      INSERT_PARAGRAPH_COMMAND,
      () => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        selection.insertLineBreak();
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      payload => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        const event = payload;
        const isHoldingShift = event.shiftKey;

        if ($shouldOverrideDefaultCharacterSelection(selection, true)) {
          event.preventDefault();
          $moveCharacter(selection, isHoldingShift, true);
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      payload => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        const event = payload;
        const isHoldingShift = event.shiftKey;

        if ($shouldOverrideDefaultCharacterSelection(selection, false)) {
          event.preventDefault();
          $moveCharacter(selection, isHoldingShift, false);
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      event => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        // On iOS, blocking the keydown event's default prevents the system
        // keyboard from updating its autocomplete/autocorrect suggestion bar
        // after Backspace. Returning false here skips event.preventDefault()
        // on keydown; the beforeinput deleteContentBackward handler still runs
        // and performs the deletion, so editing behavior is unchanged.
        // See https://github.com/facebook/lexical/issues/5841
        if (IS_IOS && CAN_USE_BEFORE_INPUT) {
          return false;
        }

        event.preventDefault();
        return editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_DELETE_COMMAND,
      event => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        event.preventDefault();
        return editor.dispatchCommand(DELETE_CHARACTER_COMMAND, false);
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      KEY_ENTER_COMMAND,
      event => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        if (event !== null) {
          // If we have beforeinput, then we can avoid blocking
          // the default behavior. This ensures that the iOS can
          // intercept that we're actually inserting a paragraph,
          // and autocomplete, autocapitalize etc work as intended.
          // This can also cause a strange performance issue in
          // Safari, where there is a noticeable pause due to
          // preventing the key down of enter.
          if (
            (IS_IOS || IS_SAFARI || IS_APPLE_WEBKIT) &&
            CAN_USE_BEFORE_INPUT
          ) {
            return false;
          }

          event.preventDefault();
        }

        return editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false);
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      SELECT_ALL_COMMAND,
      () => {
        // Scope SELECT_ALL only when the caret is inside a named-slot frame:
        // slots are shadow-root isolated, so a whole-document select-all
        // would escape the slot and let a single keystroke replace the host.
        // Every other context (including TableCell shadow roots) keeps the
        // legacy whole-document behavior; block/document scoping elsewhere
        // is provided by the opt-in SelectBlockExtension.
        const selection = $getSelection();
        $selectAll(
          $isRangeSelection(selection) &&
            $getSlotFrame(selection.anchor.getNode()) !== null
            ? selection
            : null,
        );
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      COPY_COMMAND,
      event => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        onCopyForPlainText(event, editor);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      CUT_COMMAND,
      event => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        onCutForPlainText(event, editor);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      PASTE_COMMAND,
      event => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection)) {
          return false;
        }

        onPasteForPlainText(event, editor);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      DROP_COMMAND,
      event => $handlePlainTextDrop(event, editor),
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      DRAGSTART_COMMAND,
      event => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }
        // Mark the drag source so a drop in a different editor can remove
        // the source range to produce cut-and-paste semantics.
        if (!selection.isCollapsed() && event.dataTransfer !== null) {
          $writeDragSourceToDataTransfer(event.dataTransfer, editor);
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
  );
  return removeListener;
}

/**
 * An extension to register \@lexical/plain-text behavior
 */
export const PlainTextExtension = defineExtension({
  conflictsWith: ['@lexical/rich-text'],
  dependencies: [
    DragonExtension,
    NormalizeInlineElementsExtension,
    NormalizeTripleClickSelectionExtension,
  ],
  name: '@lexical/plain-text',
  register: registerPlainText,
});
