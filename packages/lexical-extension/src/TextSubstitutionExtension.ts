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
  type ElementNode,
  HISTORIC_TAG,
  HISTORY_PUSH_TAG,
  type LexicalEditor,
  mergeRegister,
  safeCast,
  shallowMergeConfig,
  type TextNode,
} from 'lexical';

import {namedSignals} from './namedSignals';
import {effect} from './signals';

/**
 * Default text substitutions, in the style of Google Docs
 * (Tools > Preferences > Substitutions): the alias is replaced the
 * moment its final character is typed. User-supplied
 * {@link TextSubstitutionConfig.substitutions} are merged on top of
 * these, so a user entry for an existing alias wins.
 */
export const DEFAULT_TEXT_SUBSTITUTIONS: Readonly<Record<string, string>> = {
  '(c)': '©',
  '(r)': '®',
  '(tm)': '™',
  '--': '–',
  '---': '—',
  '-->': '→',
  '...': '…',
  '1/2': '½',
  '1/3': '⅓',
  '1/4': '¼',
  '1/5': '⅕',
  '1/6': '⅙',
  '1/8': '⅛',
  '2/3': '⅔',
  '2/5': '⅖',
  '3/4': '¾',
  '3/5': '⅗',
  '3/8': '⅜',
  '4/5': '⅘',
  '5/6': '⅚',
  '5/8': '⅝',
  '7/8': '⅞',
  '<--': '←',
  '<==': '⇐',
  '<=>': '⇔',
  '==>': '⇒',
  'c/o': '℅',
};

export interface TextSubstitutionConfig {
  /** Set to `true` to disable this extension. */
  disabled: boolean;
  /**
   * Predicates that exclude a text node's parent from substitution.
   * Each predicate receives the parent element node and returns `true`
   * to skip substitution inside it. Defaults to a single predicate
   * that excludes code blocks. Add your own to exclude other parents,
   * following the `excludeParents` setting in AutoLinkExtension.
   */
  excludeParents: ((parent: ElementNode) => boolean)[];
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
export const TEXT_SUBSTITUTION_TAG = 'text-substitution';

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
  /**
   * Whether the alias is a proper prefix of a longer alias. A prefix
   * alias is not substituted at once: the next character may extend
   * it into the longer alias, so it is held as pending until then.
   */
  isPrefix(alias: string): boolean;
  /**
   * The longest alias (with its replacement) that the text starting
   * at `start` begins with, or `null` when none does. Used when a
   * held-back alias is resolved: the longer alias may start at the
   * held-back alias's position rather than at the end of the text
   * (for example, a held-back `--` followed by a third dash forms
   * `---`, which starts where the `--` started).
   */
  matchAt(
    text: string,
    start: number,
  ): {alias: string; replacement: string; start: number} | null;
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
    return {
      getReplacement: () => undefined,
      isPrefix: () => false,
      match: () => null,
      matchAt: () => null,
    };
  }
  const pattern = new RegExp(
    `(${entries.map(([alias]) => escapeRegExp(alias)).join('|')})$`,
  );
  const replacements = new Map(entries);
  const aliases = entries.map(([alias]) => alias);
  return {
    getReplacement(alias: string): string | undefined {
      return replacements.get(alias);
    },
    isPrefix(alias: string): boolean {
      // A proper prefix is strictly shorter and a prefix of another
      // alias. The longest aliases are never prefixes.
      return aliases.some(
        other => other.length > alias.length && other.startsWith(alias),
      );
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
      // A word alias (one starting with a word character) only fires
      // at a word boundary: typing 'xteh' must not trigger the 'teh'
      // alias. Punctuation aliases ('--', '(c)') are unaffected, since
      // they do not start with a word character.
      if (
        result.index > 0 &&
        /\w/.test(alias[0]) &&
        /\w/.test(text[result.index - 1])
      ) {
        return null;
      }
      return {alias, replacement, start: result.index};
    },
    matchAt(text: string, start: number) {
      // Aliases are sorted longest first, so the first match is the
      // longest alias starting at `start`.
      for (const alias of aliases) {
        if (!text.startsWith(alias, start)) {
          continue;
        }
        const replacement = replacements.get(alias);
        if (replacement === undefined) {
          continue;
        }
        // The same word-boundary rule as match(): a word alias only
        // fires when the character before it is not a word character.
        if (start > 0 && /\w/.test(alias[0]) && /\w/.test(text[start - 1])) {
          continue;
        }
        return {alias, replacement, start};
      }
      return null;
    },
  };
}

/**
 * The default `excludeParents` predicate: code block nodes carry a
 * `__language` property, so a single property lookup identifies them
 * and their subclasses. This replaces a class hierarchy walk, which
 * was too much work to run on every keystroke, and it avoids importing
 * `$isCodeNode` (circular: both `@lexical/code` and `@lexical/code-core`
 * depend on `@lexical/extension`).
 */
function isCodeBlockParent(parent: ElementNode): boolean {
  return '__language' in parent;
}

function registerTextSubstitution(
  editor: LexicalEditor,
  substitutions: Readonly<Record<string, string | null>>,
  excludeParents: ((parent: ElementNode) => boolean)[],
) {
  const matcher = buildSubstitutionMatcher(substitutions);
  let lastSubstitution: SubstitutionRecord | null = null;
  // An alias that matched but was held back because it is a proper
  // prefix of a longer alias: the next typed character may extend it
  // into that longer alias, so the substitution waits one keystroke.
  // Resolved on the next update: extended into the longer alias, applied
  // as-is when the next character cannot extend it, or dropped when the
  // next character makes it part of a longer word or a markdown pattern.
  let pendingSubstitution: SubstitutionRecord | null = null;

  function $isSubstitutableNode(node: TextNode): boolean {
    const parent = node.getParent();
    if (parent !== null && excludeParents.some(pred => pred(parent))) {
      return false;
    }
    // Inline code formatting is left alone: substitutions are a prose
    // feature, and code text must stay verbatim.
    return !node.hasFormat('code');
  }

  // Splice a substitution into its node at the recorded position and
  // place the caret after the replacement. `caretOffset` is the caret
  // in the text as it stands before this splice; the caret moves left
  // by the length change, so a substitution applied one keystroke late
  // (after a held-back alias) still leaves the typed character after
  // it in place.
  function applySubstitution(
    record: SubstitutionRecord,
    caretOffset: number,
  ): void {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return;
      }
      const target = selection.anchor.getNode();
      if (!$isTextNode(target) || !$isSubstitutableNode(target)) {
        return;
      }
      const current = target.getTextContent();
      if (
        current.slice(record.start, record.start + record.alias.length) !==
        record.alias
      ) {
        return;
      }
      target.spliceText(record.start, record.alias.length, record.replacement);
      const newOffset =
        caretOffset - (record.alias.length - record.replacement.length);
      target.select(newOffset, newOffset);
      $addUpdateTag(HISTORY_PUSH_TAG);
      $addUpdateTag(TEXT_SUBSTITUTION_TAG);
      lastSubstitution = {
        alias: record.alias,
        nodeKey: target.getKey(),
        replacement: record.replacement,
        start: record.start,
      };
    });
  }

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
          // Only fire on a single typed character. The caret need
          // not be at the end of the node: the alias is matched
          // against the text before the caret, so typing in the
          // middle of a word substitutes too.
          prevSelection.anchor.key !== anchorKey ||
          anchorOffset !== prevSelection.anchor.offset + 1
        ) {
          // A caret move (or any other non-typing update) that is not
          // the chained-substitution case invalidates the records.
          lastSubstitution = null;
          pendingSubstitution = null;
          return;
        }
        // The text before the caret is what the alias is matched
        // against, so a substitution can fire in the middle of a node
        // as well as at its end.
        const text = anchorText.slice(0, anchorOffset);
        // Resolve a held-back alias first: the character just typed
        // decides whether it extends into a longer alias, stands on
        // its own, or is part of a longer word or a markdown pattern.
        if (
          pendingSubstitution !== null &&
          pendingSubstitution.nodeKey === anchorKey
        ) {
          const pending = pendingSubstitution;
          pendingSubstitution = null;
          // A line of only dashes may become a markdown horizontal
          // rule, which needs exactly three dashes. While the line
          // is three dashes or fewer, keep the alias held back: the
          // markdown transform may claim it, and if the user types
          // a fourth dash the alias is applied below instead. This
          // check comes before the longer-alias check, so that typing
          // the third dash keeps '---' as-is rather than substituting
          // it into an em dash at once.
          const isShortDashesLine =
            pending.alias === '--' && /^-+$/.test(text) && text.length <= 3;
          if (isShortDashesLine) {
            pendingSubstitution = pending;
            return;
          }
          const longer = matcher.match(text);
          const extendsPending =
            longer !== null &&
            longer.alias.length > pending.alias.length &&
            longer.alias.startsWith(pending.alias) &&
            longer.start === pending.start;
          if (!extendsPending) {
            const typedChar = text[text.length - 1];
            const isWordAlias = /\w/.test(pending.alias[0]);
            const isWordChar = typedChar !== undefined && /\w/.test(typedChar);
            if (!(isWordAlias && isWordChar)) {
              // A longer alias may start where the held-back alias
              // started (for example, a held-back '--' followed by
              // a third dash forms '---'). Apply the longest such
              // alias instead of the held-back one.
              const longerAtStart = matcher.matchAt(text, pending.start);
              if (
                longerAtStart !== null &&
                longerAtStart.alias.length > pending.alias.length
              ) {
                applySubstitution(
                  {...longerAtStart, nodeKey: anchorKey},
                  anchorOffset,
                );
                return;
              }
              // The alias was not extended, so it stands: apply it
              // now, one keystroke late. The alias sits at
              // pending.start and the typed character follows it, so
              // the caret moves left by the length change.
              applySubstitution(pending, anchorOffset);
              return;
            }
            // Otherwise the alias is dropped: a word character after
            // a word alias means it is part of a longer word (typing
            // 'tehran' must not trigger 'teh').
          }
          // When the alias extends into a longer one, the normal match
          // below finds that longer alias; the pending record is
          // already cleared.
        }
        // The chained-substitution rewrite is gone: a prefix alias is
        // held back as pending instead of being substituted at once,
        // so there is no intermediate replacement to undo when the
        // next character extends it into the longer alias. The pending
        // resolution above finds the longer alias directly.
        lastSubstitution = null;
        if (!dirtyLeaves.has(anchorKey)) {
          return;
        }
        const match = matcher.match(text);
        if (match === null) {
          return;
        }
        // Hold the alias back when it may still grow: a proper prefix
        // of a longer alias (so '--' can become '-->'), or a word
        // alias (so 'teh' does not fire inside 'tehran'). The next
        // typed character decides whether it extends, stands, or is
        // dropped. Anything else substitutes at once.
        const isWordAlias = /\w/.test(match.alias[0]);
        if (matcher.isPrefix(match.alias) || isWordAlias) {
          pendingSubstitution = {
            alias: match.alias,
            nodeKey: anchorKey,
            replacement: match.replacement,
            start: match.start,
          };
          return;
        }
        applySubstitution(
          {
            alias: match.alias,
            nodeKey: anchorKey,
            replacement: match.replacement,
            start: match.start,
          },
          anchorOffset,
        );
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
 * Typing `--` produces `–`, `---` produces `—`, `(c)` produces `©`, and so on; see
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
 * Substitutions fire wherever the caret is, at the end of a text node
 * or in the middle of one: the alias is matched against the text
 * before the caret.
 *
 * An alias that may still grow is held back one keystroke: one that is
 * a proper prefix of a longer alias (so `--` can become `-->`), or a
 * word alias (so `teh` does not fire inside `tehran`). The next typed
 * character decides: it extends into the longer alias, the held-back
 * alias is applied as-is, or it is dropped when the character makes it
 * part of a longer word. A held-back alias is dropped when the caret
 * moves away before the next character is typed.
 *
 * By default, substitutions do not fire inside code blocks. Pass
 * {@link TextSubstitutionConfig.excludeParents} to skip substitution
 * inside other parents, following the `excludeParents` setting in
 * AutoLinkExtension.
 *
 * Known interactions: `--` is not substituted when the line is only
 * dashes, so typing `---` still triggers a horizontal-rule markdown
 * shortcut. A held-back `--` is dropped on a line of only dashes, so
 * typing `---->` substitutes the `-->` at the end (`--→`): the leading
 * `--` stays as typed because the line was only dashes when it was
 * typed. In collaborative editors, undo ignores the history-push
 * boundary. On Android Chrome, Backspace is handled natively by the
 * browser, so the Backspace-restore behaviour may not apply there. IME
 * input may also skip substitution: when an IME composition commits the
 * alias's final character, the composition-end update is not treated as
 * typed input, so the alias is left as typed.
 */
export const TextSubstitutionExtension = defineExtension({
  build(editor, config, state) {
    return namedSignals(config);
  },
  config: safeCast<TextSubstitutionConfig>({
    disabled: false,
    excludeParents: [isCodeBlockParent],
    substitutions: DEFAULT_TEXT_SUBSTITUTIONS,
  }),
  mergeConfig(config, overrides) {
    const merged = shallowMergeConfig(config, overrides);
    if (overrides.substitutions !== undefined) {
      // A `null` value removes the substitution, including a default:
      // buildSubstitutionMatcher filters nulls out, so there is no
      // need to delete them here.
      merged.substitutions = {
        ...config.substitutions,
        ...overrides.substitutions,
      };
    }
    if (Array.isArray(overrides.excludeParents)) {
      merged.excludeParents = [
        ...config.excludeParents,
        ...overrides.excludeParents,
      ];
    }
    return merged;
  },
  name: '@lexical/extension/TextSubstitution',
  register(editor, config, state) {
    const {disabled, excludeParents, substitutions} = state.getOutput();
    return effect(() => {
      if (disabled.value) {
        return undefined;
      }
      return registerTextSubstitution(
        editor,
        substitutions.value,
        excludeParents.value,
      );
    });
  },
});
