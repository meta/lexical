/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  effect,
  IMEExtension,
  namedSignals,
  RootElementExtension,
  shallowMergeConfig,
  WatchEditableExtension,
} from '@lexical/extension';
import {$isAtNodeEnd} from '@lexical/selection';
import {
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  type BaseSelection,
  BLUR_COMMAND,
  COMMAND_PRIORITY_LOW,
  COMPOSITION_END_TAG,
  COMPOSITION_START_COMMAND,
  defineExtension,
  type EditorState,
  getActiveElement,
  isHTMLElement,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  mergeRegister,
  type NodeKey,
  registerEventListener,
  safeCast,
  setDOMUnmanaged,
} from 'lexical';

import {addSwipeRightListener} from '../../utils/swipe';
import {detectLanguage as defaultDetectLanguage} from './detectLanguage';
import {
  type AutocompleteDictionary,
  createWordlistDictionary,
} from './dictionary';

export {detectLanguage} from './detectLanguage';
export type {
  AutocompleteDictionary,
  WordlistDictionaryOptions,
} from './dictionary';
export {createWordlistDictionary} from './dictionary';

/**
 * Factory that resolves to an {@link AutocompleteDictionary}. Loaders
 * are invoked lazily inside `register` so wordlists are only fetched
 * when the extension is actually enabled — host bundles that never
 * activate `AutocompleteExtension` don't pay for the data.
 */
export type AutocompleteDictionaryLoader =
  () => Promise<AutocompleteDictionary>;

/**
 * Default dictionaries shipped with `AutocompleteExtension` — English
 * (top common words) and Korean (multi-syllable nouns sourced from
 * open-korean-text, Apache 2.0). Each value is a loader that
 * dynamically imports its wordlist on first use so the data ships as
 * its own bundler chunk. Add a language by passing another loader:
 *
 * ```ts
 * configExtension(AutocompleteExtension, {
 *   dictionaries: {
 *     ja: () =>
 *       import('./japanese-dict').then(({JAPANESE_WORDS}) =>
 *         createWordlistDictionary(JAPANESE_WORDS),
 *       ),
 *   },
 * });
 * ```
 *
 * (The extension's `mergeConfig` deep-merges this `dictionaries` map
 * into the defaults, so spreading is not required.)
 */
export const defaultDictionaries: Readonly<
  Record<string, AutocompleteDictionaryLoader>
> = {
  en: () =>
    import('./dictionaries/english').then(({ENGLISH_WORDS}) =>
      createWordlistDictionary(ENGLISH_WORDS, {minPrefixLength: 4}),
    ),
  ko: () =>
    import('./dictionaries/korean').then(({KOREAN_WORDS}) =>
      createWordlistDictionary(KOREAN_WORDS),
    ),
};

/** Default debounce window (ms) for composition-idle suggestions. */
const DEFAULT_COMPOSITION_IDLE_DEBOUNCE_MS = 200;

declare global {
  interface Navigator {
    userAgentData?: {
      mobile: boolean;
    };
  }
}

/**
 * Marker attribute on the per-suggestion ghost decoration element. The
 * element is appended directly into the TextNode's keyed DOM (the
 * `<span data-lexical-text="true">`) as a contentEditable=false sibling of
 * the actual text node, so it never enters the editor state — no history
 * pollution, no collab churn, no `exportDOM` carve-outs.
 *
 * `LexicalTextNode.setTextContent` routes through the node's
 * {@link DOMSlot}, modifying the text node child directly instead of
 * `dom.textContent = ...`, which preserves this sibling across updates.
 */
const AUTOCOMPLETE_GHOST_ATTR = 'data-autocomplete-ghost';

function $search(selection: null | BaseSelection): [boolean, string] {
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return [false, ''];
  }
  const node = selection.getNodes()[0];
  const anchor = selection.anchor;
  // Check siblings?
  if (!$isTextNode(node) || !node.isSimpleText() || !$isAtNodeEnd(anchor)) {
    return [false, ''];
  }
  const word = [];
  const text = node.getTextContent();
  let i = node.getTextContentSize();
  let c;
  while (i-- && i >= 0 && (c = text[i]) !== ' ') {
    word.push(c);
  }
  if (word.length === 0) {
    return [false, ''];
  }
  return [true, word.reverse().join('')];
}

/**
 * Latency (ms) of the simulated autocomplete server. Modeled after a
 * remote completion service (think GMail Smart Compose) so the
 * extension exercises its async query / dismiss path even when the
 * dictionary lookup itself is synchronous.
 */
const QUERY_LATENCY_MS = 200;

function query(
  dictionaryPromise: Promise<AutocompleteDictionary | undefined>,
  searchText: string,
  signal: AbortSignal,
): Promise<null | string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(async () => {
      signal.removeEventListener('abort', onAbort);
      let dictionary: AutocompleteDictionary | undefined;
      try {
        dictionary = await dictionaryPromise;
      } catch (e) {
        reject(e);
        return;
      }
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (dictionary === undefined) {
        resolve(null);
        return;
      }
      resolve(dictionary.query(searchText));
    }, QUERY_LATENCY_MS);
    signal.addEventListener('abort', onAbort, {once: true});
  });
}

/**
 * Backward word-scan on a raw string. Mirrors {@link $search} but
 * operates on DOM text directly — used by the composition-idle path
 * which reads `<span data-lexical-text>` content while a composition
 * is in progress, since the corresponding TextNode in EditorState
 * lags the IME's incremental compositionupdate stream.
 *
 * `\s` here (not a literal `' '` as in `$search`) intentionally
 * matches the wider Unicode whitespace set — Safari's Korean IME
 * commits a U+00A0 NBSP instead of U+0020 between composed text
 * and the caret, and U+3000 IDEOGRAPHIC SPACE shows up in some
 * Chinese / Japanese IME flows. Treating all of these as boundaries
 * keeps the prefix free of trailing whitespace artifacts that would
 * otherwise corrupt language detection (last-codepoint dispatch on
 * an invisible space would fall through to `en`).
 *
 * @internal Exposed for unit tests.
 */
export function extractTrailingWord(text: string): string {
  const trimmed = text.replace(/\s+$/u, '');
  const match = trimmed.match(/\S+$/u);
  return match === null ? '' : match[0];
}

/**
 * Read the visible text of a TextNode's keyed DOM, excluding any
 * autocomplete ghost child the extension may have appended. Direct
 * `dom.textContent` would fold in the ghost's "...권 (TAB)" suffix
 * and feed it back into the next query.
 *
 * Zero-width formatting characters (ZWSP, ZWNJ, ZWJ, BOM) that
 * browsers and some IMEs scatter into composition spans for caret
 * positioning are stripped so language detection sees the real
 * Hangul / kana / kanji codepoints instead of an invisible trailing
 * `\u200B` that would force-fallback to English.
 *
 * @internal Exposed for unit tests.
 */
export function getCompositionTextFromDOM(dom: HTMLElement): string {
  let text = '';
  for (const node of dom.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
    } else if (
      isHTMLElement(node) &&
      !node.hasAttribute(AUTOCOMPLETE_GHOST_ATTR)
    ) {
      text += node.textContent ?? '';
    }
  }
  return text.replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function formatSuggestionText(suggestion: string): string {
  // eslint-disable-next-line compat/compat
  const userAgentData = window.navigator.userAgentData;
  const isMobile =
    userAgentData !== undefined
      ? userAgentData.mobile
      : window.innerWidth <= 800 && window.innerHeight <= 600;

  return `${suggestion} ${isMobile ? '(SWIPE \u2B95)' : '(TAB)'}`;
}

/**
 * Render / update / remove the ghost decoration on a TextNode's keyed DOM.
 * Always reconciles to exactly zero or one ghost in the editor.
 */
function syncGhost(
  editor: LexicalEditor,
  textNodeKey: NodeKey | null,
  ghostText: string | null,
): void {
  // Always tear down every existing ghost first. This keeps the invariant
  // "at most one ghost in the editor at a time" trivially: even if a race
  // (e.g. async query resolving as the user starts typing again) attempts
  // to add a second one, the next call collapses back to one.
  const root = editor.getRootElement();
  if (root) {
    for (const el of root.querySelectorAll(`[${AUTOCOMPLETE_GHOST_ATTR}]`)) {
      el.remove();
    }
  }
  if (textNodeKey === null || ghostText === null) {
    return;
  }
  const dom = editor.getElementByKey(textNodeKey);
  if (!dom) {
    return;
  }
  const ghost = dom.ownerDocument.createElement('span');
  ghost.setAttribute(AUTOCOMPLETE_GHOST_ATTR, 'true');
  ghost.setAttribute('contenteditable', 'false');
  ghost.className = 'PlaygroundEditorTheme__autocomplete';
  ghost.textContent = ghostText;
  // Mark the ghost as outside Lexical's mutation tracking so the
  // reconciler doesn't reconcile it away when it sees an unknown DOM
  // child appear inside the TextNode's keyed span.
  setDOMUnmanaged(ghost);
  dom.appendChild(ghost);
}

export interface AutocompleteConfig {
  disabled: boolean;
  /**
   * Map of language tag to a loader that resolves to an
   * {@link AutocompleteDictionary}. The extension picks the loader by
   * passing the typed prefix through `detectLanguage` and looking up
   * the result, then invokes it on first use and caches the resolved
   * dictionary. Default is {@link defaultDictionaries} (English +
   * Korean) — each value uses a dynamic `import()` so wordlists are
   * code-split and only fetched when the extension is enabled.
   */
  dictionaries: Readonly<Record<string, AutocompleteDictionaryLoader>>;
  /**
   * Override default language detection. Receives the typed prefix and
   * returns the language tag to look up in `dictionaries`. Default is
   * the export from `./detectLanguage` (last-codepoint script range).
   */
  detectLanguage: (text: string) => string;
  /**
   * Soft-commit window (ms) for IME composition. While a composition is
   * active, the extension schedules a debounced query that fires after
   * this many milliseconds without a new `compositionupdate` event.
   * The natural typing pause between words in Korean and Japanese —
   * where the IME never fires `compositionend` on its own — becomes
   * the trigger for the ghost.
   *
   * Default `200`. Set to `0` to disable the soft-commit path entirely
   * and only show ghosts on explicit composition end.
   */
  compositionIdleDebounceMs: number;
}

function mergeAutocompleteConfig(
  config: AutocompleteConfig,
  overrides: Partial<AutocompleteConfig>,
): AutocompleteConfig {
  const merged = shallowMergeConfig(config, overrides);
  if (overrides.dictionaries) {
    merged.dictionaries = {
      ...config.dictionaries,
      ...overrides.dictionaries,
    };
  }
  return merged;
}

export const AutocompleteExtension = defineExtension({
  build: (editor, config) => namedSignals(config),
  config: safeCast<AutocompleteConfig>({
    compositionIdleDebounceMs: DEFAULT_COMPOSITION_IDLE_DEBOUNCE_MS,
    detectLanguage: defaultDetectLanguage,
    dictionaries: defaultDictionaries,
    disabled: false,
  }),
  dependencies: [IMEExtension, RootElementExtension, WatchEditableExtension],
  mergeConfig: mergeAutocompleteConfig,
  name: '@lexical/playground/autocomplete',
  register: (editor: LexicalEditor, config, state) => {
    const ime = state.getDependency(IMEExtension).output;
    const editableSignal = state.getDependency(WatchEditableExtension).output;
    const rootElemSignal = state.getDependency(RootElementExtension).output;
    let activeTextNodeKey: NodeKey | null = null;
    let lastMatch: string | null = null;
    let lastSuggestion: string | null = null;
    let searchController: AbortController | null = null;
    let pendingCompositionTimer: number | null = null;
    // Caches resolved dictionaries by loader identity so each dynamic
    // import only runs once per loader. A host that swaps the loader
    // for a language gets a fresh load on the next query.
    const dictionaryCache = new Map<
      AutocompleteDictionaryLoader,
      Promise<AutocompleteDictionary>
    >();

    function loadDictionary(
      loader: AutocompleteDictionaryLoader | undefined,
    ): Promise<AutocompleteDictionary | undefined> {
      if (loader === undefined) {
        return Promise.resolve(undefined);
      }
      let cached = dictionaryCache.get(loader);
      if (cached === undefined) {
        cached = loader();
        dictionaryCache.set(loader, cached);
      }
      return cached;
    }
    function clearPendingCompositionTimer() {
      if (pendingCompositionTimer !== null) {
        clearTimeout(pendingCompositionTimer);
        pendingCompositionTimer = null;
      }
    }

    // Suggestions belong only to the editor that currently holds focus. In
    // collab the idle peer receives the same content updates, and under the v2
    // binding its synced selection lands at a word end — without this it would
    // render a ghost in an editor nobody is typing in. Checked at update time
    // (rather than tracked via FOCUS/BLUR) so it is robust to autofocus racing
    // extension registration.
    function isEditorFocused(): boolean {
      const rootElem = editor.getRootElement();
      // getActiveElement rather than ownerDocument.activeElement, which reports
      // the shadow host (not contained in rootElem) when the editor is in a
      // shadow root.
      const active = rootElem ? getActiveElement(rootElem) : null;
      return rootElem != null && active != null && rootElem.contains(active);
    }

    function dismiss() {
      activeTextNodeKey = null;
      lastMatch = null;
      lastSuggestion = null;
      if (searchController !== null) {
        searchController.abort();
        searchController = null;
      }
      syncGhost(editor, null, null);
    }

    function tryCompositionSuggestion() {
      pendingCompositionTimer = null;
      const composingNode = ime.composingTextNode.value;
      if (composingNode === null) {
        return;
      }
      const composingKey = composingNode.getKey();
      const dom = editor.getElementByKey(composingKey);
      if (dom === null) {
        return;
      }
      const text = getCompositionTextFromDOM(dom);
      if (text.length === 0) {
        return;
      }
      const prefix = extractTrailingWord(text);
      if (prefix.length === 0 || prefix === lastMatch) {
        return;
      }
      if (searchController !== null) {
        searchController.abort();
      }
      syncGhost(editor, null, null);
      lastMatch = prefix;
      lastSuggestion = null;
      activeTextNodeKey = null;
      const controller = new AbortController();
      searchController = controller;
      const language = output.detectLanguage.value(prefix);
      query(
        loadDictionary(output.dictionaries.value[language]),
        prefix,
        controller.signal,
      )
        .then(newSuggestion => {
          applyCompositionSuggestion(
            controller,
            composingKey,
            prefix,
            newSuggestion,
          );
        })
        .catch(e => {
          if (!(e instanceof DOMException && e.name === 'AbortError')) {
            console.error(e);
          }
        });
    }

    function applyCompositionSuggestion(
      refController: AbortController,
      composingKey: NodeKey,
      prefix: string,
      newSuggestion: string | null,
    ) {
      const composingNode = ime.composingTextNode.value;
      if (
        searchController !== refController ||
        newSuggestion === null ||
        composingNode === null ||
        composingNode.getKey() !== composingKey
      ) {
        return;
      }
      const dom = editor.getElementByKey(composingKey);
      if (dom === null) {
        return;
      }
      // Re-read DOM at resolve time — the user may have typed past the
      // prefix while the query was in flight (e.g. 200ms latency).
      if (extractTrailingWord(getCompositionTextFromDOM(dom)) !== prefix) {
        return;
      }
      activeTextNodeKey = composingKey;
      lastSuggestion = newSuggestion;
      syncGhost(editor, composingKey, formatSuggestionText(newSuggestion));
    }

    function onCompositionUpdateDOM() {
      const debounceMs = output.compositionIdleDebounceMs.value;
      if (debounceMs <= 0) {
        return;
      }
      // Don't dismiss the existing ghost here — if the user has just paused
      // (ghost shown), then pressed Tab, the IME typically fires one final
      // `compositionupdate` for the in-flight syllable right before
      // `compositionend`. Dismissing would clear `lastSuggestion` between
      // the ghost render and the Tab commit. The debounced query that lands
      // in `tryCompositionSuggestion` replaces (or clears) the stale ghost.
      clearPendingCompositionTimer();
      pendingCompositionTimer = window.setTimeout(
        tryCompositionSuggestion,
        debounceMs,
      );
    }

    function onCompositionEndDOM() {
      clearPendingCompositionTimer();
      // Safari / WebKit defers Lexical's COMPOSITION_END_TAG-tagged
      // update until the next keydown, so any composition-idle ghost
      // would otherwise stay stale until the user presses another key.
      // The synthetic handleUpdate here doesn't *replace* that pending
      // update — at microtask time the EditorState may still reflect
      // pre-end state. It just forces handleUpdate to be considered
      // once with the tag set, bypassing the `editor.isComposing()`
      // skip; the real post-commit ghost lands when Lexical's actual
      // tagged update arrives shortly after. Chrome / Firefox fire
      // their tagged update synchronously, so the microtask hits a
      // post-commit state and the later real update is the redundant
      // (idempotent) one.
      Promise.resolve().then(() => {
        handleUpdate({
          editorState: editor.getEditorState(),
          tags: new Set([COMPOSITION_END_TAG]),
        });
      });
    }

    function applyAsyncSuggestion(
      refController: AbortController,
      newSuggestion: string | null,
    ) {
      if (searchController !== refController || newSuggestion === null) {
        return;
      }
      if (!isEditorFocused()) {
        return;
      }
      editor.read('latest', () => {
        const selection = $getSelection();
        const [hasMatch, match] = $search(selection);
        if (!hasMatch || match !== lastMatch || !$isRangeSelection(selection)) {
          return;
        }
        const node = selection.getNodes()[0];
        if (!$isTextNode(node)) {
          return;
        }
        activeTextNodeKey = node.getKey();
        lastSuggestion = newSuggestion;
        syncGhost(
          editor,
          activeTextNodeKey,
          formatSuggestionText(newSuggestion),
        );
      });
    }

    function handleUpdate({
      editorState,
      tags,
    }: {
      editorState: EditorState;
      tags: Set<string>;
    }) {
      // Only the focused editor shows suggestions (see isEditorFocused).
      if (!isEditorFocused()) {
        dismiss();
        return;
      }
      // Skip the normal update path while a composition is in progress —
      // querying on every committed `compositionupdate` flickers the ghost
      // as Korean 자모 / Japanese kana stream through partial syllables.
      // The composition-idle debounce (`tryCompositionSuggestion`) takes
      // over while composing; the post-commit update (with the
      // `COMPOSITION_END_TAG` tag) re-enters this path.
      if (!tags.has(COMPOSITION_END_TAG) && editor.isComposing()) {
        return;
      }
      editorState.read(
        () => {
          const selection = $getSelection();
          const [hasMatch, match] = $search(selection);
          if (!hasMatch) {
            dismiss();
            return;
          }
          if (match === lastMatch) {
            // Same prefix, but the active TextNode key may have changed if
            // the user moved the cursor between nodes with the same prefix.
            if ($isRangeSelection(selection)) {
              const node = selection.getNodes()[0];
              if ($isTextNode(node)) {
                const key = node.getKey();
                if (key !== activeTextNodeKey) {
                  activeTextNodeKey = key;
                  syncGhost(
                    editor,
                    activeTextNodeKey,
                    lastSuggestion
                      ? formatSuggestionText(lastSuggestion)
                      : null,
                  );
                }
              }
            }
            return;
          }
          // New prefix — clear any stale ghost while waiting for the async
          // suggestion, then kick off a fresh query.
          if (searchController !== null) {
            searchController.abort();
          }
          syncGhost(editor, null, null);
          lastMatch = match;
          lastSuggestion = null;
          activeTextNodeKey = null;
          const controller = new AbortController();
          searchController = controller;
          const language = output.detectLanguage.value(match);
          query(
            loadDictionary(output.dictionaries.value[language]),
            match,
            controller.signal,
          )
            .then(newSuggestion => {
              applyAsyncSuggestion(controller, newSuggestion);
            })
            .catch(e => {
              if (!(e instanceof DOMException && e.name === 'AbortError')) {
                console.error(e);
              }
            });
        },
        {editor},
      );
    }

    function $commitSuggestion(): boolean {
      if (activeTextNodeKey === null || lastSuggestion === null) {
        return false;
      }
      const node = $getNodeByKey(activeTextNodeKey);
      if (!$isTextNode(node)) {
        // Active TextNode has been replaced (e.g. user toggled format,
        // splitting the run). Drop the stale ghost so the next keystroke
        // cycles a fresh suggestion instead of leaving a no-op Tab press.
        dismiss();
        return false;
      }
      // Mid-composition Tab on the same TextNode (the composition-idle
      // UX path — ghost rendered while the IME is still composing). A
      // plain spliceText would race the in-flight syllable and the
      // resulting DOM lands torn ("사용 |용" instead of "사용권"). Read
      // the settled text from the DOM, write the combined string, and
      // clear the composition key so the IME stops trying to merge into
      // a node it no longer controls.
      const composingNode = ime.composingTextNode.value;
      if (
        composingNode !== null &&
        composingNode.getKey() === activeTextNodeKey
      ) {
        const dom = editor.getElementByKey(activeTextNodeKey);
        if (dom !== null) {
          const liveText = getCompositionTextFromDOM(dom);
          const fullText = liveText + lastSuggestion;
          node.setTextContent(fullText);
          $setCompositionKey(null);
          node.select();
          dismiss();
          return true;
        }
      }
      // Append the raw suggestion text (without the "(TAB)" hint) at the
      // end of the active text node.
      node.spliceText(node.getTextContentSize(), 0, lastSuggestion, true);
      dismiss();
      return true;
    }

    function $handleCommitCommand(event: Event): boolean {
      // `triggerCommandListeners` already wraps each listener bucket in
      // `updateEditorSync`, so `$commitSuggestion` runs in an active editor
      // context here. Wrapping in `editor.update({discrete: true})` from
      // inside that existing update would defer the splice to a microtask,
      // leaving `didCommit` stuck at `false` long enough for the next
      // handler (e.g. tab indentation) to insert a tab before the suggestion
      // lands.
      const didCommit = $commitSuggestion();
      if (didCommit) {
        event.preventDefault();
      }
      return didCommit;
    }

    function handleSwipeRight(_force: number, event: TouchEvent) {
      // Touch handler isn't called from a command-listener pipeline, so it
      // needs its own update context. `discrete: true` keeps the splice
      // synchronous relative to the touch event so `preventDefault` is
      // accurate.
      let didCommit = false;
      editor.update(
        () => {
          didCommit = $commitSuggestion();
        },
        {discrete: true},
      );
      if (didCommit) {
        event.preventDefault();
      }
    }

    const output = state.getOutput();
    return effect(() => {
      const rootElem = rootElemSignal.value;
      const editable = editableSignal.value;
      if (output.disabled.value || !rootElem || !editable) {
        return;
      }
      // Pre-warm the dictionary cache so the dynamic `import()` lands in
      // the background instead of on the user's first keystroke. The
      // promises sit in `dictionaryCache` and the first `query` call
      // resolves against the already-in-flight (or settled) load.
      for (const loader of Object.values(output.dictionaries.value)) {
        loadDictionary(loader);
      }
      return mergeRegister(
        registerEventListener(
          rootElem,
          'compositionupdate',
          onCompositionUpdateDOM,
        ),
        registerEventListener(rootElem, 'compositionend', onCompositionEndDOM),
        editor.registerUpdateListener(handleUpdate),
        // Drop the ghost as soon as the editor loses focus, rather than
        // waiting for the next update.
        editor.registerCommand(
          BLUR_COMMAND,
          () => {
            dismiss();
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        // Dismiss any stale ghost (carried over from pre-composition
        // keyboard input) so the user gets a clean slate while typing
        // the new prefix. The composition target's TextNode key is
        // tracked by IMEExtension and consumed via `ime.composingTextNode`.
        editor.registerCommand(
          COMPOSITION_START_COMMAND,
          () => {
            dismiss();
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(
          KEY_TAB_COMMAND,
          $handleCommitCommand,
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(
          KEY_ARROW_RIGHT_COMMAND,
          $handleCommitCommand,
          COMMAND_PRIORITY_LOW,
        ),
        addSwipeRightListener(rootElem, handleSwipeRight),
        clearPendingCompositionTimer,
        // Tear down on dispose: clear any ghost still attached so a fresh
        // build doesn't see leftover decoration.
        dismiss,
      );
    });
  },
});
