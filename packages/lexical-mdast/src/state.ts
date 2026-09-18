/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {createState} from 'lexical';

/**
 * Per-node state used to round-trip the *exact* Markdown syntax a construct was
 * parsed from, so re-serializing produces minimally different output. This is
 * the same technique `@lexical/markdown` uses; the state lives on the Lexical
 * nodes (and therefore survives serialization), and the exporter reads it to
 * reproduce the original marker/fence/break.
 *
 * All of these default to the empty sentinel (`''` / `false`) meaning
 * "unknown" — i.e. the node was not created by a Markdown import. The exporter
 * only pins a node's syntax when the marker is known, so nodes created in the
 * editor defer to the document-level serialization options.
 */

/** The bullet character (`-`, `*`, `+`) an unordered/check `ListNode` used. */
export const listMarkerState = createState('mdastListMarker', {
  parse: (v): '' | '*' | '+' | '-' =>
    v === '-' || v === '*' || v === '+' ? v : '',
  resetOnCopyNode: true,
});

/** The delimiter (`.` or `)`) an ordered `ListNode` used. */
export const orderedMarkerState = createState('mdastOrderedMarker', {
  parse: (v): '' | ')' | '.' => (v === '.' || v === ')' ? v : ''),
  resetOnCopyNode: true,
});

/** The marker (`_`) an italic run used when it was not the default `*`. */
export const emphasisMarkerState = createState('mdastEmphasisMarker', {
  parse: (v): string => (v === '_' ? '_' : ''),
  resetOnCopyNode: true,
});

/** The marker (`_`) a bold run used when it was not the default `*`. */
export const strongMarkerState = createState('mdastStrongMarker', {
  parse: (v): string => (v === '_' ? '_' : ''),
  resetOnCopyNode: true,
});

/** Whether a (level 1/2) `HeadingNode` was written in setext style. */
export const setextState = createState('mdastSetext', {
  parse: (v): boolean => v === true,
  resetOnCopyNode: true,
});

/** The fence a `CodeNode` used (e.g. ```` ``` ````, ````` ```` `````, `~~~`). */
export const codeFenceState = createState('mdastCodeFence', {
  parse: (v): string =>
    typeof v === 'string' && /^(`{3,}|~{3,})$/.test(v) ? v : '',
  resetOnCopyNode: true,
});

/**
 * The info-string tail after a `CodeNode`'s language (e.g. `title=x` in
 * ```` ```js title=x ````). `CodeNode` itself only models the language;
 * this keeps the rest of the info string so it survives the round-trip.
 */
export const codeMetaState = createState('mdastCodeMeta', {
  parse: (v): string => (typeof v === 'string' ? v : ''),
  resetOnCopyNode: true,
});

/**
 * The hard-line-break marker a `LineBreakNode` used (`\` or trailing spaces).
 * The empty sentinel means the break is *soft* (a source newline or an
 * editor-created line break) and serializes as a plain newline.
 */
export const hardLineBreakState = createState('mdastHardLineBreak', {
  parse: (v): string =>
    typeof v === 'string' && /^(\\| {2,})$/.test(v) ? v : '',
  resetOnCopyNode: true,
});

/**
 * Marks a `LineBreakNode` that stands for a *paragraph boundary* inside a
 * container whose Lexical children are inline (blockquote, list item). Set by
 * the import handlers when they join sibling mdast paragraphs; the exporter
 * splits on it to reconstruct the paragraphs.
 */
export const paragraphBreakState = createState('mdastParagraphBreak', {
  parse: (v): boolean => v === true,
  resetOnCopyNode: true,
});

/** The marker (`-`, `*`, `_`) a thematic break / `HorizontalRuleNode` used. */
export const hrMarkerState = createState('mdastHrMarker', {
  parse: (v): string => (v === '-' || v === '*' || v === '_' ? v : ''),
  resetOnCopyNode: true,
});

/**
 * The syntax a `LinkNode` was written in: `'inline'` (`[text](url)`),
 * `'autolink'` (`<url>`), or `'literal'` (a bare GFM autolink literal,
 * `https://…` in prose).
 */
export const linkStyleState = createState('mdastLinkStyle', {
  parse: (v): '' | 'autolink' | 'inline' | 'literal' =>
    v === 'inline' || v === 'autolink' || v === 'literal' ? v : '',
  resetOnCopyNode: true,
});
