/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $addUpdateTag,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_BEFORE_EDITOR,
  defineExtension,
  DELETE_CHARACTER_COMMAND,
  HISTORIC_TAG,
  HISTORY_MERGE_TAG,
  HISTORY_PUSH_TAG,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  safeCast,
  shallowMergeConfig,
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
   *
   * Set an alias to `null` to remove it, including a default: for
   * example, `{'--': null}` turns the `--` substitution off. An alias
   * that maps to itself (for example, `{'--': '--'}`) is ignored.
   */
  substitutions: Readonly<Record<string, string | null>>;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface SubstitutionMatcher {
  /**
   * The replacement for the alias that the text ends with, or `null`
   * when it ends with no alias. When aliases overlap, the longest
   * alias wins (so `-->` beats `--`).
   */
  match(
    text: string,
  ): {alias: string; replacement: string; start: number} | null;
  /** The replacement for one alias, or `undefined` when it is not one. */
  getReplacement(alias: string): string | undefined;
}

/**
 * Compile the substitutions into a single matcher. The matcher is built
 * once per configuration change, not once per keystroke: invalid entries
 * (an empty alias, a `null` value, or an alias that maps to itself) are
 * filtered out here, the remaining aliases are sorted longest first so
 * the alternation tries the longest alias first, and a single regex
 * anchored at the end of the text does the matching. A per-keystroke
 * scan over every entry would repeat all of that work on every typed
 * character.
 */
function buildSubstitutionMatcher(
  substitutions: Readonly<Record<string, string | null>>,
): SubstitutionMatcher {
  const entries = Object.entries(substitutions)
    .filter(
      (entry): entry is [string, string] =>
        entry[1] !== null && entry[0].length > 0 && entry[0] !== entry[1],
    )
    .sort((a, b) => b[0].length - a[0].length);
  if (entries.length === 0) {
    return {getReplacement: () => undefined, match: () => null};
  }
  const pattern = new RegExp(
    `(${entries.map(([alias]) => escapeRegExp(alias)).join('|')})$`,
  );
  const replacements = new Map(entries);
  return {
    getReplacement(alias: string): string | undefined {
      return replacements.get(alias);
    },
    match(text: string) {
      const result = pattern.exec(text);
      if (result === null) {
        return null;
      }
      const alias = result[1];
      const replacement = replacements.get(alias);
      if (replacement === undefined) {
        return null;
      }
      return {alias, replacement, start: result.index};
    },
  };
}

/**
 * Whether the node is a code block node. `$isCodeNode` from
 * `@lexical/code` cannot be used here: both `@lexical/code` and
 * `@lexical/code-core` depend on `@lexical/extension`, so importing it
 * would be circular. Instead, walk the node's class hierarchy for a
 * static `getType()` of `'code'`, which also matches a subclass that
 * overrides `getType()` with its own type string — the case a plain
 * `getType()` check misses.
 */
function $isCodeBlock(node: LexicalNode | null | undefined): boolean {
  let ctor: unknown;
  if (node !== null && node !== undefined) {
    ctor = node.constructor;
  }
  while (typeof ctor === 'function') {
    const getType = (ctor as {getType?: unknown}).getType;
    if (typeof getType === 'function') {
      try {
        if (getType.call(ctor) === 'code') {
          return true;
        }
      } catch {
        // The base LexicalNode.getType() throws for abstract classes
        // (ElementNode and the like), which have no concrete type:
        // keep walking up the hierarchy.
      }
    }
    ctor = Object.getPrototypeOf(ctor);
  }
  return false;
}

function $isSubstitutableNode(node: TextNode): boolean {
  const parent = node.getParent();
  if (parent !== null && $isCodeBlock(parent)) {
    return false;
  }
  // Inline code formatting is left alone: substitutions are a prose
  // feature, and code text must stay verbatim.
  return !node.hasFormat('code');
}

function registerTextSubstitution(
  editor: LexicalEditor,
  substitutions: Readonly<Record<string, string | null>>,
) {
  const matcher = buildSubstitutionMatcher(substitutions);
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
        const selection = editorState.read($getSelection, {editor});
        const prevSelection = prevEditorState.read($getSelection, {editor});
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
        // Node reads need an active editor, which the update listener
        // does not provide — read the node through editorState with
        // {editor}, using the public $getNodeByKey.
        const anchorText = editorState.read(
          () => {
            const anchorNode = $getNodeByKey(anchorKey);
            return $isTextNode(anchorNode) ? anchorNode.getTextContent() : null;
          },
          {editor},
        );
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
          const extendedReplacement = matcher.getReplacement(extendedAlias);
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
        const match = matcher.match(text);
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
      // The delete handler only needs to run before RichTextExtension's
      // own delete handler (COMMAND_PRIORITY_EDITOR, 0), so it uses
      // COMMAND_PRIORITY_BEFORE_EDITOR: the lowest priority that still
      // runs before the editor's handlers, leaving higher-priority
      // handlers (other plugins) first. Returning true here stops the
      // character from being deleted instead of reverted.
      COMMAND_PRIORITY_BEFORE_EDITOR,
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
 * To turn off a single default, map it to `null`, e.g. `{'--': null}`.
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
    substitutions: DEFAULT_TEXT_SUBSTITUTIONS,
  }),
  mergeConfig(config, overrides) {
    const merged = shallowMergeConfig(config, overrides);
    if (overrides.substitutions !== undefined) {
      const substitutions = {
        ...config.substitutions,
        ...overrides.substitutions,
      };
      // A `null` value removes the substitution, including a default.
      for (const [alias, replacement] of Object.entries(
        overrides.substitutions,
      )) {
        if (replacement === null) {
          delete substitutions[alias];
        }
      }
      merged.substitutions = substitutions;
    }
    return merged;
  },
  name: '@lexical/extension/TextSubstitution',
  register(editor, config, state) {
    const {disabled, substitutions} = state.getOutput();
    return effect(() => {
      if (disabled.value) {
        return undefined;
      }
      return registerTextSubstitution(editor, substitutions.value);
    });
  },
});
