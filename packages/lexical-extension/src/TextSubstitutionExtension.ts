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
  COMMAND_PRIORITY_HIGH,
  defineExtension,
  DELETE_CHARACTER_COMMAND,
  HISTORIC_TAG,
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
        if (tags.has(HISTORIC_TAG) || tags.has(COLLABORATION_TAG)) {
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
          !dirtyLeaves.has(anchorKey) ||
          // Only fire on a single typed character, at the end of the
          // node: typing in the middle of a word must not substitute.
          prevSelection.anchor.key !== anchorKey ||
          anchorOffset !== prevSelection.anchor.offset + 1 ||
          anchorOffset !== anchorText.length
        ) {
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
          lastSubstitution.nodeKey === anchorKey
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
            editor.update(() => {
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
                extendedReplacement,
              );
              target.select(
                record.start + extendedReplacement.length,
                record.start + extendedReplacement.length,
              );
              $addUpdateTag(HISTORY_PUSH_TAG);
              lastSubstitution = {
                alias: extendedAlias,
                nodeKey: target.getKey(),
                replacement: extendedReplacement,
                start: record.start,
              };
            });
            return;
          }
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
        lastSubstitution = null;
        let reverted = false;
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
            return;
          }
          const node = selection.anchor.getNode();
          if (
            !$isTextNode(node) ||
            node.getKey() !== record.nodeKey ||
            selection.anchor.offset !== record.start + record.replacement.length
          ) {
            return;
          }
          const text = node.getTextContent();
          if (
            text.slice(
              record.start,
              record.start + record.replacement.length,
            ) !== record.replacement
          ) {
            return;
          }
          node.spliceText(
            record.start,
            record.replacement.length,
            record.alias,
          );
          node.select(
            record.start + record.alias.length,
            record.start + record.alias.length,
          );
          $addUpdateTag(HISTORY_PUSH_TAG);
          reverted = true;
        });
        return reverted;
      },
      COMMAND_PRIORITY_HIGH,
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
