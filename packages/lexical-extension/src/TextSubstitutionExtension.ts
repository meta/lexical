/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $addUpdateTag,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_LOW,
  defineExtension,
  DELETE_CHARACTER_COMMAND,
  HISTORIC_TAG,
  HISTORY_MERGE_TAG,
  HISTORY_PUSH_TAG,
  type LexicalEditor,
  mergeRegister,
  safeCast,
  type TextNode,
} from 'lexical';

import {namedSignals} from './namedSignals';
import {effect} from './signals';

/**
 * Default text substitutions, applied in the style of Word and Google Docs
 * auto-replace: the alias is replaced the moment its final character is
 * typed. User-supplied {@link TextSubstitutionConfig.substitutions} are
 * merged on top of these, so a user entry for an existing alias wins.
 */
export const DEFAULT_TEXT_SUBSTITUTIONS: Readonly<Record<string, string>> = {
  '(c)': '©',
  '(r)': '®',
  '(tm)': '™',
  '--': '—',
  '-->': '→',
  '->': '→',
  '...': '…',
  '<-': '←',
  '<--': '←',
};

export interface TextSubstitutionConfig {
  /** Set to `true` to disable this extension. */
  disabled: boolean;
  /**
   * Additional substitutions, or overrides for the defaults in
   * {@link DEFAULT_TEXT_SUBSTITUTIONS}. Keys are the alias as typed and
   * values are the replacement text. When aliases overlap, the longest
   * alias wins (so `-->` beats `--`).
   */
  substitutions: Readonly<Record<string, string>>;
}

interface SubstitutionRecord {
  alias: string;
  nodeKey: string;
  replacement: string;
  start: number;
}

/**
 * Tag applied to every update this extension makes itself (the
 * substitution, the chained-substitution rewrite, and the Backspace
 * revert). The update listener skips tagged updates, so the revert of
 * `—` back to `--` — which moves the caret forward by one at the end
 * of the node — is not read as a newly typed character and
 * re-substituted, and a custom entry such as `{':)': '::)'}` cannot
 * loop either.
 */
const TEXT_SUBSTITUTION_TAG = 'text-substitution';

function $findSubstitution(
  text: string,
  entries: readonly (readonly [string, string])[],
): {alias: string; replacement: string; start: number} | null {
  for (const [alias, replacement] of entries) {
    if (alias.length > 0 && alias !== replacement && text.endsWith(alias)) {
      return {alias, replacement, start: text.length - alias.length};
    }
  }
  return null;
}

function $isSubstitutableNode(node: TextNode): boolean {
  const parent = node.getParent();
  if (parent !== null && parent.getType() === 'code') {
    return false;
  }
  // Inline code formatting (and, without a dependency on @lexical/code,
  // a parent whose type is 'code') is left alone: substitutions are a
  // prose feature, and code text must stay verbatim.
  return !node.hasFormat('code');
}

function registerTextSubstitution(
  editor: LexicalEditor,
  substitutions: Readonly<Record<string, string>>,
) {
  // Longest alias first, so '-->' wins over '--' and '<--' over '<-'.
  const entries = Object.entries(substitutions).sort(
    (a, b) => b[0].length - a[0].length,
  );
  const substitutionMap = new Map(entries);
  let lastSubstitution: SubstitutionRecord | null = null;

  return mergeRegister(
    editor.registerUpdateListener(
      ({dirtyLeaves, editorState, prevEditorState, tags}) => {
        if (
          tags.has(HISTORIC_TAG) ||
          tags.has(COLLABORATION_TAG) ||
          tags.has(TEXT_SUBSTITUTION_TAG)
        ) {
          return;
        }
        if (!editor.isEditable() || editor.isComposing()) {
          return;
        }
        const selection = editorState.read($getSelection);
        const prevSelection = prevEditorState.read($getSelection);
        if (
          !$isRangeSelection(selection) ||
          !$isRangeSelection(prevSelection) ||
          !selection.isCollapsed() ||
          selection.is(prevSelection)
        ) {
          // Any update that is not the extension's own, and not a
          // collapsed caret move of exactly one character, invalidates
          // the "Backspace reverts" record: moving the caret back after
          // an earlier substitution must not restore its alias.
          lastSubstitution = null;
          return;
        }
        const anchorKey = selection.anchor.key;
        const anchorOffset = selection.anchor.offset;
        const anchorNode = editorState._nodeMap.get(anchorKey);
        // Node reads need an active editor-state context, which the
        // update listener does not provide — read through editorState.
        const anchorText = $isTextNode(anchorNode)
          ? editorState.read(() => anchorNode.getTextContent())
          : null;
        if (
          anchorText === null ||
          // Only fire on a single typed character, at the end of the
          // node: typing in the middle of a word must not substitute.
          prevSelection.anchor.key !== anchorKey ||
          anchorOffset !== prevSelection.anchor.offset + 1 ||
          anchorOffset !== anchorText.length
        ) {
          // A caret move (or any other non-typing update) that is not
          // the chained-substitution case invalidates the record.
          lastSubstitution = null;
          return;
        }
        const text = anchorText;
        // Longest-alias-wins, second chance: typing '--' already fired
        // the '--' -> '—' substitution, so a following '>' makes the
        // text '—>'. If alias + typed char is itself an alias, replace
        // the replacement (plus the typed char) with the longer alias's
        // replacement instead of leaving '—>' behind.
        if (
          lastSubstitution !== null &&
          lastSubstitution.nodeKey === anchorKey &&
          dirtyLeaves.has(anchorKey)
        ) {
          const typedChar = text[anchorOffset - 1];
          const extendedAlias = lastSubstitution.alias + typedChar;
          const extendedReplacement = substitutionMap.get(extendedAlias);
          if (
            extendedReplacement !== undefined &&
            text.slice(lastSubstitution.start, anchorOffset) ===
              lastSubstitution.replacement + typedChar
          ) {
            const record = lastSubstitution;
            // Undo for a chained alias works in one step by splitting
            // the rewrite in two. First, rewrite the intermediate text
            // (e.g. '—>') back to the full alias ('-->') in an update
            // tagged HISTORY_MERGE_TAG (and NOT HISTORY_PUSH_TAG, which
            // would defeat the merge): history folds it into the
            // keystroke entry that typed the final character, so that
            // entry now ends at '-->' instead of '—>'. Then, from that
            // update's onUpdate, apply the longer replacement in its
            // own HISTORY_PUSH_TAG update. One Ctrl+Z therefore
            // restores '-->', and a second undo reverts the keystroke
            // that produced it — instead of the old '—>' residue.
            editor.update(
              () => {
                const currentSelection = $getSelection();
                if (!$isRangeSelection(currentSelection)) {
                  return;
                }
                const target = currentSelection.anchor.getNode();
                if (!$isTextNode(target) || !$isSubstitutableNode(target)) {
                  return;
                }
                target.spliceText(
                  record.start,
                  record.replacement.length + 1,
                  extendedAlias,
                );
                target.select(
                  record.start + extendedAlias.length,
                  record.start + extendedAlias.length,
                );
                $addUpdateTag(HISTORY_MERGE_TAG);
                $addUpdateTag(TEXT_SUBSTITUTION_TAG);
              },
              {
                onUpdate: () => {
                  editor.update(() => {
                    const currentSelection = $getSelection();
                    if (!$isRangeSelection(currentSelection)) {
                      return;
                    }
                    const target = currentSelection.anchor.getNode();
                    if (!$isTextNode(target) || !$isSubstitutableNode(target)) {
                      return;
                    }
                    const current = target.getTextContent();
                    if (
                      current.slice(
                        record.start,
                        record.start + extendedAlias.length,
                      ) !== extendedAlias
                    ) {
                      return;
                    }
                    target.spliceText(
                      record.start,
                      extendedAlias.length,
                      extendedReplacement,
                    );
                    target.select(
                      record.start + extendedReplacement.length,
                      record.start + extendedReplacement.length,
                    );
                    $addUpdateTag(HISTORY_PUSH_TAG);
                    $addUpdateTag(TEXT_SUBSTITUTION_TAG);
                    lastSubstitution = {
                      alias: extendedAlias,
                      nodeKey: target.getKey(),
                      replacement: extendedReplacement,
                      start: record.start,
                    };
                  });
                },
              },
            );
            return;
          }
        }
        // Any other typed character is a new edit, not a continuation
        // of the previous substitution: the old record is stale.
        lastSubstitution = null;
        if (!dirtyLeaves.has(anchorKey)) {
          return;
        }
        const match = $findSubstitution(text, entries);
        if (match === null) {
          return;
        }
        editor.update(() => {
          const node = $getSelection();
          if (!$isRangeSelection(node)) {
            return;
          }
          const target = node.anchor.getNode();
          if (!$isTextNode(target) || !$isSubstitutableNode(target)) {
            return;
          }
          const current = target.getTextContent();
          if (!current.endsWith(match.alias)) {
            return;
          }
          target.spliceText(match.start, match.alias.length, match.replacement);
          target.select(
            match.start + match.replacement.length,
            match.start + match.replacement.length,
          );
          $addUpdateTag(HISTORY_PUSH_TAG);
          $addUpdateTag(TEXT_SUBSTITUTION_TAG);
          lastSubstitution = {
            alias: match.alias,
            nodeKey: target.getKey(),
            replacement: match.replacement,
            start: match.start,
          };
        });
      },
    ),
    editor.registerCommand(
      DELETE_CHARACTER_COMMAND,
      (isBackward: boolean) => {
        if (!isBackward || lastSubstitution === null) {
          return false;
        }
        const record = lastSubstitution;
        // A command handler already runs inside an update, so the
        // revert is done directly here — a nested editor.update()
        // would only be queued, letting the rich-text delete handler
        // remove the replacement first. Returning true stops that
        // handler from running at all.
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          lastSubstitution = null;
          return false;
        }
        const node = selection.anchor.getNode();
        if (
          !$isTextNode(node) ||
          node.getKey() !== record.nodeKey ||
          selection.anchor.offset !== record.start + record.replacement.length
        ) {
          lastSubstitution = null;
          return false;
        }
        const text = node.getTextContent();
        if (
          text.slice(record.start, record.start + record.replacement.length) !==
          record.replacement
        ) {
          lastSubstitution = null;
          return false;
        }
        lastSubstitution = null;
        node.spliceText(record.start, record.replacement.length, record.alias);
        node.select(
          record.start + record.alias.length,
          record.start + record.alias.length,
        );
        $addUpdateTag(HISTORY_PUSH_TAG);
        $addUpdateTag(TEXT_SUBSTITUTION_TAG);
        return true;
      },
      // RichTextExtension's delete handler runs at COMMAND_PRIORITY_EDITOR
      // (0); LOW (1) runs before it, so returning true here stops the
      // character from being deleted instead of reverted.
      COMMAND_PRIORITY_LOW,
    ),
  );
}

/**
 * An extension that auto-replaces text aliases as they are typed, in the
 * style of Word and Google Docs (see issue #9706).
 *
 * Typing `--` produces `—`, `(c)` produces `©`, and so on; see
 * {@link DEFAULT_TEXT_SUBSTITUTIONS} for the full default list, and pass
 * {@link TextSubstitutionConfig.substitutions} for custom aliases.
 *
 * The replacement is applied as its own editor update (tagged with
 * `HISTORY_PUSH_TAG`), so a single Ctrl+Z / undo reverts the replacement
 * and restores the alias text. A single Backspace pressed immediately
 * after a replacement — with the caret still right after it and no other
 * edits in between — restores the alias text instead of deleting one
 * character.
 *
 * To turn off a single default, map it to itself, e.g.
 * `{'--': '--'}`: an alias equal to its replacement is never applied.
 * Substitutions only fire at the end of a text node, so typing `--` in
 * the middle of an existing sentence does not substitute.
 *
 * Known interactions: typing `---` cannot trigger a horizontal-rule
 * markdown shortcut alongside this extension, because `--` is replaced
 * with `—` before the third `-` is typed. A chained substitution
 * (`--` then `>` producing `→`) is arranged so that one Ctrl+Z
 * restores the full alias (`-->`), and a second Ctrl+Z reverts the
 * keystroke that produced it. In collaborative editors, undo ignores the
 * history-push boundary. On Android Chrome, Backspace is handled
 * natively by the browser, so the Backspace-restore behaviour may not
 * apply there. IME input may also skip substitution: when an IME
 * composition commits the alias's final character, the composition-end
 * update is not treated as typed input, so the alias is left as typed.
 */
export const TextSubstitutionExtension = defineExtension({
  build(editor, config, state) {
    return namedSignals(config);
  },
  config: safeCast<TextSubstitutionConfig>({
    disabled: false,
    substitutions: {},
  }),
  name: '@lexical/extension/TextSubstitution',
  register(editor, config, state) {
    const {disabled, substitutions} = state.getOutput();
    return effect(() => {
      if (disabled.value) {
        return undefined;
      }
      const merged: Record<string, string> = {
        ...DEFAULT_TEXT_SUBSTITUTIONS,
        ...substitutions.value,
      };
      return registerTextSubstitution(editor, merged);
    });
  },
});
