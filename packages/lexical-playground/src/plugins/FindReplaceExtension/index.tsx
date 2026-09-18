/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {DecoratorComponentProps} from '@lexical/react/ReactPluginHostExtension';

import './FindReplace.css';

import {
  computed,
  effect,
  namedSignals,
  watchedSignal,
} from '@lexical/extension';
import {ReactExtension} from '@lexical/react/ReactExtension';
import {useExtensionSignalValue} from '@lexical/react/useExtensionSignalValue';
import {createDOMRange, createRectsFromDOMRange} from '@lexical/selection';
import {$dfsWithSlotsIterator} from '@lexical/utils';
import {
  $getNodeByKeyOrThrow,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  configExtension,
  CONTROL_OR_META,
  createCommand,
  defineExtension,
  IS_APPLE,
  isExactShortcutMatch,
  KEY_DOWN_COMMAND,
  type LexicalCommand,
  type LexicalEditor,
  mergeRegister,
  type NodeKey,
} from 'lexical';
import {type JSX, useRef} from 'react';
import {createPortal} from 'react-dom';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TextMatch {
  end: number;
  matchText: string;
  start: number;
}

export interface OffsetEntry {
  globalEnd: number;
  globalStart: number;
  key: NodeKey;
}

export interface MatchPoints {
  anchorKey: NodeKey;
  anchorOffset: number;
  focusKey: NodeKey;
  focusOffset: number;
  format: number;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

export function findMatches(
  text: string,
  searchTerm: string,
  caseSensitive: boolean,
  isRegex: boolean,
): TextMatch[] {
  if (!searchTerm || !text) {
    return [];
  }

  const pattern = isRegex ? searchTerm : escapeRegExp(searchTerm);
  const flags = 'g' + (caseSensitive ? '' : 'i');

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    return [];
  }

  const matches: TextMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    matches.push({
      end: match.index + match[0].length,
      matchText: match[0],
      start: match.index,
    });
  }
  return matches;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function expandReplacement(
  template: string,
  matchText: string,
  searchRegex: RegExp | null,
): string {
  if (!searchRegex) {
    return template;
  }
  return matchText.replace(searchRegex, template);
}

export function $buildOffsetMap(): OffsetEntry[] {
  const entries: OffsetEntry[] = [];
  let offset = 0;
  let prevNonInlineDepth: number | null = null;

  for (const {node, depth} of $dfsWithSlotsIterator()) {
    if ($isElementNode(node) && !node.isInline() && depth > 0) {
      if (prevNonInlineDepth !== null && depth <= prevNonInlineDepth) {
        offset += 2;
      }
      prevNonInlineDepth = depth;
    }

    if ($isLineBreakNode(node)) {
      offset += 1;
    } else if ($isTextNode(node)) {
      const len = node.getTextContentSize();
      entries.push({
        globalEnd: offset + len,
        globalStart: offset,
        key: node.__key,
      });
      offset += len;
    }
  }

  return entries;
}

export function $resolveMatchToPoints(
  match: TextMatch,
  offsetMap: OffsetEntry[],
): MatchPoints | null {
  const anchorEntry = findEntryForOffset(offsetMap, match.start);
  const focusEntry = findEntryForOffset(offsetMap, match.end - 1);
  if (!anchorEntry || !focusEntry) {
    return null;
  }

  const anchorOffset = match.start - anchorEntry.globalStart;
  const focusOffset = match.end - focusEntry.globalStart;
  const isSingleNode = anchorEntry.key === focusEntry.key;
  const anchorNode = $getNodeByKeyOrThrow(anchorEntry.key);
  const format =
    isSingleNode && $isTextNode(anchorNode) ? anchorNode.getFormat() : 0;

  return {
    anchorKey: anchorEntry.key,
    anchorOffset,
    focusKey: focusEntry.key,
    focusOffset,
    format,
  };
}

function findEntryForOffset(
  offsetMap: OffsetEntry[],
  offset: number,
): OffsetEntry | null {
  let lo = 0;
  let hi = offsetMap.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const entry = offsetMap[mid];
    if (offset < entry.globalStart) {
      hi = mid - 1;
    } else if (offset >= entry.globalEnd) {
      lo = mid + 1;
    } else {
      return entry;
    }
  }
  return null;
}

export function $replaceMatch(
  points: MatchPoints,
  replacementText: string,
  match: TextMatch,
  searchRegex: RegExp | null,
): void {
  const finalText = searchRegex
    ? expandReplacement(replacementText, match.matchText, searchRegex)
    : replacementText;
  const anchorNode = $getNodeByKeyOrThrow(points.anchorKey);
  const focusNode = $getNodeByKeyOrThrow(points.focusKey);
  if (!$isTextNode(anchorNode) || !$isTextNode(focusNode)) {
    return;
  }
  if (points.anchorKey === points.focusKey) {
    anchorNode.spliceText(
      points.anchorOffset,
      points.focusOffset - points.anchorOffset,
      finalText,
      true,
    );
    return;
  }
  const selection = anchorNode.select(0, 0);
  selection.setTextNodeRange(
    anchorNode,
    points.anchorOffset,
    focusNode,
    points.focusOffset,
  );
  selection.format = points.format;
  selection.insertText(finalText);
}

export function $replaceAllMatches(
  matches: TextMatch[],
  offsetMap: OffsetEntry[],
  replacementText: string,
  searchRegex: RegExp | null,
): number {
  let count = 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    const points = $resolveMatchToPoints(matches[i], offsetMap);
    if (points) {
      $replaceMatch(points, replacementText, matches[i], searchRegex);
      count++;
    }
  }
  return count;
}

function buildSearchRegex(
  searchTerm: string,
  caseSensitive: boolean,
): RegExp | null {
  try {
    return new RegExp(searchTerm, caseSensitive ? '' : 'i');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Highlight rendering (scoped per editor instance)
// ---------------------------------------------------------------------------

const SUPPORTS_CSS_HIGHLIGHTS =
  typeof Highlight !== 'undefined' &&
  typeof CSS !== 'undefined' &&
  'highlights' in CSS;

interface HighlightState {
  allHighlight: Highlight | null;
  allName: string;
  currentHighlight: Highlight | null;
  currentName: string;
  overlayContainer: HTMLDivElement | null;
  originalParentPosition: string | null;
  styleElement: HTMLStyleElement | null;
}

function createHighlightState(editorKey: string): HighlightState {
  return {
    allHighlight: null,
    allName: `lexical-find-replace-match-${editorKey}`,
    currentHighlight: null,
    currentName: `lexical-find-replace-current-${editorKey}`,
    originalParentPosition: null,
    overlayContainer: null,
    styleElement: null,
  };
}

function ensureHighlightRegistered(state: HighlightState, doc: Document): void {
  if (state.allHighlight) {
    return;
  }
  // eslint-disable-next-line compat/compat -- guarded by SUPPORTS_CSS_HIGHLIGHTS
  state.allHighlight = new Highlight();
  // eslint-disable-next-line compat/compat -- guarded by SUPPORTS_CSS_HIGHLIGHTS
  state.currentHighlight = new Highlight();
  CSS.highlights.set(state.allName, state.allHighlight);
  CSS.highlights.set(state.currentName, state.currentHighlight);
  const style = doc.createElement('style');
  style.textContent =
    `::highlight(${state.allName}) { background-color: rgba(255, 255, 0, 0.4); color: inherit; }\n` +
    `::highlight(${state.currentName}) { background-color: rgba(255, 165, 0, 0.6); color: inherit; }\n` +
    `@media (forced-colors: active) {\n` +
    `  ::highlight(${state.allName}) { background-color: Highlight; color: HighlightText; forced-color-adjust: none; }\n` +
    `  ::highlight(${state.currentName}) { background-color: Mark; color: MarkText; forced-color-adjust: none; }\n` +
    `}`;
  doc.head.appendChild(style);
  state.styleElement = style;
}

function disposeHighlightState(state: HighlightState): void {
  if (state.allHighlight) {
    state.allHighlight.clear();
    CSS.highlights.delete(state.allName);
    state.allHighlight = null;
  }
  if (state.currentHighlight) {
    state.currentHighlight.clear();
    CSS.highlights.delete(state.currentName);
    state.currentHighlight = null;
  }
  if (state.styleElement) {
    state.styleElement.remove();
    state.styleElement = null;
  }
  if (state.overlayContainer) {
    if (state.originalParentPosition !== null) {
      const parent = state.overlayContainer.parentElement;
      if (parent) {
        parent.style.position = state.originalParentPosition;
      }
      state.originalParentPosition = null;
    }
    state.overlayContainer.remove();
    state.overlayContainer = null;
  }
}

function $updateHighlights(
  editor: LexicalEditor,
  matches: TextMatch[],
  currentIndex: number,
  state: HighlightState,
): void {
  clearHighlights(state);

  if (matches.length === 0 || !editor.getRootElement()) {
    return;
  }

  const offsetMap = $buildOffsetMap();

  if (SUPPORTS_CSS_HIGHLIGHTS) {
    const doc = editor.getRootElement()?.ownerDocument ?? document;
    ensureHighlightRegistered(state, doc);

    for (let i = 0; i < matches.length; i++) {
      const points = $resolveMatchToPoints(matches[i], offsetMap);
      if (!points) {
        continue;
      }
      const anchorNode = $getNodeByKeyOrThrow(points.anchorKey);
      const focusNode = $getNodeByKeyOrThrow(points.focusKey);
      const range = createDOMRange(
        editor,
        anchorNode,
        points.anchorOffset,
        focusNode,
        points.focusOffset,
      );
      if (!range) {
        continue;
      }
      state.allHighlight!.add(range);
      if (i === currentIndex) {
        state.currentHighlight!.add(range);
        scrollRangeIntoView(range);
      }
    }
  } else {
    $updateOverlayHighlights(editor, matches, currentIndex, offsetMap, state);
  }
}

function scrollRangeIntoView(range: Range): void {
  const el = range.startContainer.parentElement;
  el?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
}

function clearHighlights(state: HighlightState): void {
  if (state.allHighlight) {
    state.allHighlight.clear();
  }
  if (state.currentHighlight) {
    state.currentHighlight.clear();
  }
  clearOverlayHighlights(state);
}

// ---------------------------------------------------------------------------
// Legacy fallback: overlay spans
// ---------------------------------------------------------------------------

function getOverlayContainer(
  editor: LexicalEditor,
  state: HighlightState,
): HTMLDivElement {
  if (state.overlayContainer) {
    return state.overlayContainer;
  }
  const root = editor.getRootElement();
  if (!root) {
    throw new Error('No root element');
  }
  const doc = root.ownerDocument;
  const parent = root.parentElement!;
  if (getComputedStyle(parent).position === 'static') {
    state.originalParentPosition = parent.style.position;
    parent.style.position = 'relative';
  }
  const container = doc.createElement('div');
  container.style.position = 'absolute';
  container.style.top = '0';
  container.style.left = '0';
  container.style.pointerEvents = 'none';
  parent.appendChild(container);
  state.overlayContainer = container;
  return container;
}

function clearOverlayHighlights(state: HighlightState): void {
  if (state.overlayContainer) {
    state.overlayContainer.innerHTML = '';
  }
}

function $updateOverlayHighlights(
  editor: LexicalEditor,
  matches: TextMatch[],
  currentIndex: number,
  offsetMap: OffsetEntry[],
  state: HighlightState,
): void {
  const container = getOverlayContainer(editor, state);
  container.innerHTML = '';
  const rootElement = editor.getRootElement();
  if (!rootElement) {
    return;
  }
  const doc = rootElement.ownerDocument;
  const containerRect = container.offsetParent
    ? container.offsetParent.getBoundingClientRect()
    : rootElement.getBoundingClientRect();

  for (let i = 0; i < matches.length; i++) {
    const points = $resolveMatchToPoints(matches[i], offsetMap);
    if (!points) {
      continue;
    }
    const anchorNode = $getNodeByKeyOrThrow(points.anchorKey);
    const focusNode = $getNodeByKeyOrThrow(points.focusKey);
    const range = createDOMRange(
      editor,
      anchorNode,
      points.anchorOffset,
      focusNode,
      points.focusOffset,
    );
    if (!range) {
      continue;
    }
    const rects = createRectsFromDOMRange(editor, range);
    const isCurrent = i === currentIndex;
    if (isCurrent) {
      scrollRangeIntoView(range);
    }
    for (const rect of rects) {
      const span = doc.createElement('span');
      span.style.position = 'absolute';
      span.style.top = `${rect.top - containerRect.top}px`;
      span.style.left = `${rect.left - containerRect.left}px`;
      span.style.width = `${rect.width}px`;
      span.style.height = `${rect.height}px`;
      span.style.backgroundColor = isCurrent
        ? 'rgba(255, 165, 0, 0.6)'
        : 'rgba(255, 255, 0, 0.4)';
      span.style.pointerEvents = 'none';
      container.appendChild(span);
    }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const TOGGLE_FIND_REPLACE_COMMAND: LexicalCommand<void> = createCommand(
  'TOGGLE_FIND_REPLACE_COMMAND',
);

export const CLOSE_FIND_REPLACE_COMMAND: LexicalCommand<void> = createCommand(
  'CLOSE_FIND_REPLACE_COMMAND',
);

export const FIND_NEXT_COMMAND: LexicalCommand<void> =
  createCommand('FIND_NEXT_COMMAND');

export const FIND_PREV_COMMAND: LexicalCommand<void> =
  createCommand('FIND_PREV_COMMAND');

export const REPLACE_CURRENT_COMMAND: LexicalCommand<void> = createCommand(
  'REPLACE_CURRENT_COMMAND',
);

export const REPLACE_ALL_COMMAND: LexicalCommand<void> = createCommand(
  'REPLACE_ALL_COMMAND',
);

export const SET_SEARCH_TERM_COMMAND: LexicalCommand<string> = createCommand(
  'SET_SEARCH_TERM_COMMAND',
);

export const SET_REPLACE_TERM_COMMAND: LexicalCommand<string> = createCommand(
  'SET_REPLACE_TERM_COMMAND',
);

export const TOGGLE_CASE_SENSITIVE_COMMAND: LexicalCommand<void> =
  createCommand('TOGGLE_CASE_SENSITIVE_COMMAND');

export const TOGGLE_REGEX_COMMAND: LexicalCommand<void> = createCommand(
  'TOGGLE_REGEX_COMMAND',
);

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export const FindReplaceExtension = defineExtension({
  build: editor => {
    const named = namedSignals({
      caseSensitive: false,
      currentIndex: 0,
      isOpen: false,
      isRegex: false,
      replaceTerm: '',
      searchTerm: '',
    });

    const cachedText = watchedSignal(
      () => editor.read('latest', () => $getRoot().getTextContent()),
      s =>
        editor.registerTextContentListener(text => {
          s.value = text;
        }),
    );

    const matches = computed(() => {
      if (!named.isOpen.value) {
        return [];
      }
      return findMatches(
        cachedText.value,
        named.searchTerm.value,
        named.caseSensitive.value,
        named.isRegex.value,
      );
    });

    const effectiveIndex = computed(() => {
      const m = matches.value;
      const idx = named.currentIndex.value;
      return m.length > 0 ? Math.min(idx, m.length - 1) : 0;
    });

    const regexError = computed(() => {
      if (!named.isRegex.value || !named.searchTerm.value) {
        return false;
      }
      try {
        RegExp(named.searchTerm.value);
        return false;
      } catch {
        return true;
      }
    });

    return {...named, cachedText, effectiveIndex, matches, regexError};
  },
  name: '@lexical/playground/FindReplace',
  register: (editor, _config, state) => {
    const output = state.getOutput();
    const highlightState = createHighlightState(editor.getKey());

    return mergeRegister(
      editor.registerCommand(
        TOGGLE_FIND_REPLACE_COMMAND,
        () => {
          output.isOpen.value = !output.isOpen.peek();
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),

      editor.registerCommand(
        CLOSE_FIND_REPLACE_COMMAND,
        () => {
          output.isOpen.value = false;
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),

      editor.registerCommand(
        FIND_NEXT_COMMAND,
        () => {
          const len = output.matches.peek().length;
          if (len > 0) {
            output.currentIndex.value = (output.currentIndex.peek() + 1) % len;
          }
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),

      editor.registerCommand(
        FIND_PREV_COMMAND,
        () => {
          const len = output.matches.peek().length;
          if (len > 0) {
            output.currentIndex.value =
              (output.currentIndex.peek() - 1 + len) % len;
          }
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),

      editor.registerCommand(
        REPLACE_CURRENT_COMMAND,
        () => {
          const m = output.matches.peek();
          if (m.length === 0) {
            return true;
          }
          const idx = output.effectiveIndex.peek();
          const replaceText = output.replaceTerm.peek();
          const regex = output.isRegex.peek()
            ? buildSearchRegex(
                output.searchTerm.peek(),
                output.caseSensitive.peek(),
              )
            : null;
          editor.update(
            () => {
              const offsetMap = $buildOffsetMap();
              const points = $resolveMatchToPoints(m[idx], offsetMap);
              if (points) {
                $replaceMatch(points, replaceText, m[idx], regex);
              }
            },
            {discrete: true},
          );
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),

      editor.registerCommand(
        REPLACE_ALL_COMMAND,
        () => {
          const m = output.matches.peek();
          if (m.length === 0) {
            return true;
          }
          const replaceText = output.replaceTerm.peek();
          const regex = output.isRegex.peek()
            ? buildSearchRegex(
                output.searchTerm.peek(),
                output.caseSensitive.peek(),
              )
            : null;
          editor.update(
            () => {
              const offsetMap = $buildOffsetMap();
              $replaceAllMatches(m, offsetMap, replaceText, regex);
            },
            {discrete: true},
          );
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),

      editor.registerCommand(
        SET_SEARCH_TERM_COMMAND,
        term => {
          output.searchTerm.value = term;
          output.currentIndex.value = 0;
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),

      editor.registerCommand(
        SET_REPLACE_TERM_COMMAND,
        term => {
          output.replaceTerm.value = term;
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),

      editor.registerCommand(
        TOGGLE_CASE_SENSITIVE_COMMAND,
        () => {
          output.caseSensitive.value = !output.caseSensitive.peek();
          output.currentIndex.value = 0;
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),

      editor.registerCommand(
        TOGGLE_REGEX_COMMAND,
        () => {
          output.isRegex.value = !output.isRegex.peek();
          output.currentIndex.value = 0;
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),

      editor.registerCommand(
        KEY_DOWN_COMMAND,
        event => {
          if (
            isExactShortcutMatch(event, 'f', CONTROL_OR_META) ||
            isExactShortcutMatch(event, 'f', {altKey: true, metaKey: true})
          ) {
            event.preventDefault();
            editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
            return true;
          }
          if (output.isOpen.peek()) {
            if (
              isExactShortcutMatch(event, 'g', CONTROL_OR_META) ||
              isExactShortcutMatch(event, 'g', {
                ...CONTROL_OR_META,
                shiftKey: true,
              })
            ) {
              event.preventDefault();
              editor.dispatchCommand(
                event.shiftKey ? FIND_PREV_COMMAND : FIND_NEXT_COMMAND,
              );
              return true;
            }
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),

      effect(() => {
        const m = output.matches.value;
        const idx = output.effectiveIndex.value;
        const open = output.isOpen.value;

        clearHighlights(highlightState);
        if (!open || m.length === 0) {
          return;
        }
        editor.read(() => {
          $updateHighlights(editor, m, idx, highlightState);
        });
      }),

      () => disposeHighlightState(highlightState),
    );
  },
});

// ---------------------------------------------------------------------------
// React UI
// ---------------------------------------------------------------------------

function FindReplacePanel({
  context,
}: DecoratorComponentProps): JSX.Element | null {
  const [editor] = context;

  const isOpen = useExtensionSignalValue(FindReplaceExtension, 'isOpen');
  const searchTerm = useExtensionSignalValue(
    FindReplaceExtension,
    'searchTerm',
  );
  const replaceTerm = useExtensionSignalValue(
    FindReplaceExtension,
    'replaceTerm',
  );
  const caseSensitive = useExtensionSignalValue(
    FindReplaceExtension,
    'caseSensitive',
  );
  const isRegex = useExtensionSignalValue(FindReplaceExtension, 'isRegex');
  const matches = useExtensionSignalValue(FindReplaceExtension, 'matches');
  const effectiveIndex = useExtensionSignalValue(
    FindReplaceExtension,
    'effectiveIndex',
  );
  const regexError = useExtensionSignalValue(
    FindReplaceExtension,
    'regexError',
  );

  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      editor.dispatchCommand(CLOSE_FIND_REPLACE_COMMAND);
      editor.focus();
      return;
    }
    if (e.key === 'Tab') {
      const panel: HTMLElement = e.currentTarget as HTMLElement;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>('input, button'),
      );
      if (focusables.length === 0) {
        return;
      }
      const active = panel.ownerDocument.activeElement;
      const idx =
        active instanceof HTMLElement ? focusables.indexOf(active) : -1;
      const next = e.shiftKey
        ? idx <= 0
          ? focusables.length - 1
          : idx - 1
        : idx >= focusables.length - 1
          ? 0
          : idx + 1;
      e.preventDefault();
      focusables[next].focus();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      editor.dispatchCommand(
        e.shiftKey ? FIND_PREV_COMMAND : FIND_NEXT_COMMAND,
      );
      return;
    }
    if (
      isExactShortcutMatch(e, 'g', CONTROL_OR_META) ||
      isExactShortcutMatch(e, 'g', {...CONTROL_OR_META, shiftKey: true})
    ) {
      e.preventDefault();
      editor.dispatchCommand(
        e.shiftKey ? FIND_PREV_COMMAND : FIND_NEXT_COMMAND,
      );
    } else if (
      isExactShortcutMatch(e, 'f', CONTROL_OR_META) ||
      isExactShortcutMatch(e, 'f', {altKey: true, metaKey: true})
    ) {
      e.preventDefault();
      searchInputRef.current?.focus();
    }
  };

  if (!isOpen) {
    return null;
  }

  const rootElement = editor.getRootElement();
  const portalTarget = rootElement?.ownerDocument?.body ?? document.body;

  return createPortal(
    <div
      className="find-replace-panel"
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-label="Find and Replace">
      <input
        ref={searchInputRef}
        autoFocus={true}
        className="find-replace-input"
        style={{gridColumn: 1, gridRow: 1}}
        type="text"
        placeholder="Find..."
        value={searchTerm}
        onChange={e => {
          editor.dispatchCommand(SET_SEARCH_TERM_COMMAND, e.target.value);
        }}
        aria-label="Search text"
      />
      <input
        className="find-replace-input"
        style={{gridColumn: 1, gridRow: 2}}
        type="text"
        placeholder="Replace..."
        value={replaceTerm}
        onChange={e => {
          editor.dispatchCommand(SET_REPLACE_TERM_COMMAND, e.target.value);
        }}
        aria-label="Replace text"
      />
      <button
        className="find-replace-toggle"
        style={{gridColumn: 3, gridRow: 1}}
        onClick={() => {
          editor.dispatchCommand(TOGGLE_CASE_SENSITIVE_COMMAND);
        }}
        title="Match case"
        aria-label="Match case"
        aria-pressed={caseSensitive}>
        Aa
      </button>
      <button
        className="find-replace-toggle"
        style={{gridColumn: 4, gridRow: 1}}
        onClick={() => {
          editor.dispatchCommand(TOGGLE_REGEX_COMMAND);
        }}
        title="Use regular expression"
        aria-label="Use regular expression"
        aria-pressed={isRegex}>
        .*
      </button>
      <button
        className="find-replace-btn"
        style={{gridColumn: 6, gridRow: 1}}
        onClick={() => editor.dispatchCommand(FIND_PREV_COMMAND)}
        disabled={matches.length === 0}
        title={
          IS_APPLE ? 'Previous match (⇧⌘G)' : 'Previous match (Ctrl+Shift+G)'
        }
        aria-label="Previous match">
        <svg viewBox="0 0 16 16">
          <path d="M8 4l5 6H3z" />
        </svg>
      </button>
      <button
        className="find-replace-btn"
        style={{gridColumn: 7, gridRow: 1}}
        onClick={() => editor.dispatchCommand(FIND_NEXT_COMMAND)}
        disabled={matches.length === 0}
        title={IS_APPLE ? 'Next match (⌘G)' : 'Next match (Ctrl+G)'}
        aria-label="Next match">
        <svg viewBox="0 0 16 16">
          <path d="M8 12L3 6h10z" />
        </svg>
      </button>
      <div className="find-replace-row2-actions">
        <button
          className="find-replace-action"
          onClick={() => editor.dispatchCommand(REPLACE_CURRENT_COMMAND)}
          disabled={matches.length === 0}
          aria-label="Replace current match">
          Replace
        </button>
        <button
          className="find-replace-action"
          onClick={() => editor.dispatchCommand(REPLACE_ALL_COMMAND)}
          disabled={matches.length === 0}
          aria-label="Replace all matches">
          All
        </button>
      </div>
      <button
        className="find-replace-btn"
        style={{gridColumn: 9, gridRow: 1}}
        onClick={() => {
          editor.dispatchCommand(CLOSE_FIND_REPLACE_COMMAND);
          editor.focus();
        }}
        title="Close (Escape)"
        aria-label="Close">
        <svg viewBox="0 0 16 16">
          <path d="M12.2 4.5l-.7-.7L8 7.3 4.5 3.8l-.7.7L7.3 8l-3.5 3.5.7.7L8 8.7l3.5 3.5.7-.7L8.7 8z" />
        </svg>
      </button>
      <span className="find-replace-count" style={{gridColumn: 2, gridRow: 1}}>
        {regexError
          ? 'Invalid regex'
          : matches.length > 0
            ? `${effectiveIndex + 1} / ${matches.length}`
            : 'No results'}
      </span>
      <div
        className="find-replace-separator"
        style={{gridColumn: 5, gridRow: 1}}
      />
      <div
        className="find-replace-separator"
        style={{gridColumn: 8, gridRow: 1}}
      />
    </div>,
    portalTarget,
  );
}

export const ReactFindReplaceExtension = defineExtension({
  dependencies: [
    FindReplaceExtension,
    configExtension(ReactExtension, {
      decorators: [FindReplacePanel],
    }),
  ],
  name: '@lexical/playground/ReactFindReplace',
});
