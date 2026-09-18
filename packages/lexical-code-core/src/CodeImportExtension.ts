/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  defineImportRule,
  defineOverlayRules,
  type DOMPreprocessFn,
  ImportOverlays,
  sel,
} from '@lexical/html';
import {
  $generateNodesFromRawText,
  isDOMDocumentNode,
  isDOMTextNode,
  isHTMLElement,
} from 'lexical';

import {$createCodeNode} from './CodeNode';

const LANGUAGE_DATA_ATTRIBUTE = 'data-language';
const THEME_DATA_ATTRIBUTE = 'data-theme';

/**
 * True for elements whose `font-family` mentions `monospace` — the
 * heuristic the legacy `<div>` rule uses to spot copy-pasted code blocks
 * (e.g. Google Docs serializes a code block as a styled `<div>`).
 */
function isMonospaceElement(el: HTMLElement): boolean {
  return el.style.fontFamily.match('monospace') !== null;
}

function isMonospaceDescendant(node: HTMLElement): boolean {
  let parent: HTMLElement | null = node.parentElement;
  while (parent !== null) {
    if (isMonospaceElement(parent)) {
      return true;
    }
    parent = parent.parentElement;
  }
  return false;
}

/**
 * Overlay rules active only while {@link GitHubCodeTableRule} is
 * processing its children. Inside the code-table subtree, every `<tr>`
 * and `<td>` unwraps unconditionally — they never become table-row /
 * table-cell nodes (even when `@lexical/table` registers its rules for
 * those tags). Outside the subtree, this overlay isn't installed, so
 * the cost of these rules is never paid against unrelated `<tr>` /
 * `<td>` pastes.
 */
const GitHubCodeTableOverlayRules = defineOverlayRules([
  defineImportRule({
    $import: (ctx, el) => ctx.$importChildren(el),
    match: sel.tag('tr', 'td'),
    name: '@lexical/code/github-code-table/unwrap',
  }),
]);

const PreRule = defineImportRule({
  $import: (ctx, el) => [
    $createCodeNode(
      el.getAttribute(LANGUAGE_DATA_ATTRIBUTE),
      el.getAttribute(THEME_DATA_ATTRIBUTE),
    ).splice(0, 0, ctx.$importChildren(el)),
  ],
  match: sel.tag('pre'),
  name: '@lexical/code/pre',
});

/**
 * Multi-line `<code>` (containing newlines or `<br>`) is treated as a
 * block code element — mirrors the legacy behavior. Single-line `<code>`
 * defers to the inline-format rule from `CoreImportExtension` so it
 * becomes a TextNode with IS_CODE.
 */
const MultilineCodeRule = defineImportRule({
  $import: (ctx, el, $next) => {
    const text = el.textContent || '';
    const isMultiLine = /\r?\n/.test(text) || el.querySelector('br') !== null;
    if (!isMultiLine) {
      return $next();
    }
    return [
      $createCodeNode(
        el.getAttribute(LANGUAGE_DATA_ATTRIBUTE),
        el.getAttribute(THEME_DATA_ATTRIBUTE),
      ).splice(0, 0, ctx.$importChildren(el)),
    ];
  },
  match: sel.tag('code'),
  name: '@lexical/code/code-multiline',
});

/**
 * True for elements carrying BOTH `font-family: …monospace…` and
 * `white-space: pre*` inline — the shape VS Code uses for every line
 * of a copied code block (on every per-line `<div>` on Safari, on
 * the single outer wrapper on Chrome).
 */
function isMonospacePreElement(el: Element): boolean {
  if (!isHTMLElement(el)) {
    return false;
  }
  const ff = el.style.fontFamily;
  const ws = el.style.whiteSpace;
  return (
    typeof ff === 'string' &&
    /monospace/i.test(ff) &&
    typeof ws === 'string' &&
    ws.startsWith('pre')
  );
}

/**
 * Split a monospace-pre wrapper element into logical code lines:
 * `<div>` children contribute their text content as one line,
 * `<br>` children contribute an empty line, inline children (spans
 * and bare text) accumulate into the current line until the next
 * block child.
 *
 * Returns `null` if `el` has no block children (i.e. it's a leaf
 * line, not a wrapper) so the caller can leave it to the
 * sibling-run pass.
 */
function splitMonospaceWrapperLines(el: HTMLElement): string[] | null {
  let hasBlockChild = false;
  const lines: string[] = [];
  let acc = '';
  let hasAcc = false;
  const flush = () => {
    if (hasAcc) {
      lines.push(acc);
      acc = '';
      hasAcc = false;
    }
  };
  for (const child of Array.from(el.childNodes)) {
    if (isHTMLElement(child)) {
      if (child.tagName === 'DIV') {
        flush();
        lines.push(child.textContent || '');
        hasBlockChild = true;
      } else if (child.tagName === 'BR') {
        flush();
        lines.push('');
        hasBlockChild = true;
      } else {
        acc += child.textContent || '';
        hasAcc = true;
      }
    } else if (isDOMTextNode(child)) {
      const t = child.textContent || '';
      if (t.length > 0) {
        acc += t;
        hasAcc = true;
      }
    }
  }
  flush();
  return hasBlockChild ? lines : null;
}

/**
 * Returns `true` if `root` contains the structural signature of a
 * VS Code code-block paste:
 *
 *  - a monospace+pre `<div>` wrapper with at least one block (`<div>` /
 *    `<br>`) child — the Chrome shape, or
 *  - two or more consecutive monospace+pre siblings — the Safari shape.
 *
 * Walked once in preprocess; the matching overlay is only installed
 * when this returns `true` so an unrelated paste doesn't pay for the
 * detection or rule cost.
 */
function looksLikeVscodePaste(root: ParentNode): boolean {
  for (const child of Array.from(root.children)) {
    if (isHTMLElement(child) && isMonospacePreElement(child)) {
      const lines = splitMonospaceWrapperLines(child);
      if (lines !== null) {
        return true;
      }
      const next = child.nextElementSibling;
      if (next && isMonospacePreElement(next)) {
        return true;
      }
      continue;
    }
    if (looksLikeVscodePaste(child)) {
      return true;
    }
  }
  return false;
}

/**
 * Match a monospace+pre `<div>` whose direct children include block
 * (`<div>` / `<br>`) elements — the Chrome shape, one outer wrapper
 * around per-line `<div>`s and `<br>`s. Emits a single CodeNode whose
 * text is the wrapper's lines joined by `\n`.
 */
const VscodeWrapperRule = defineImportRule({
  $import: (_ctx, el, $next) => {
    if (!isMonospacePreElement(el) || isMonospaceDescendant(el)) {
      return $next();
    }
    const lines = splitMonospaceWrapperLines(el);
    if (lines === null || lines.length === 0) {
      return $next();
    }
    return [
      $createCodeNode().splice(
        0,
        0,
        $generateNodesFromRawText(lines.join('\n')),
      ),
    ];
  },
  match: sel.tag('div'),
  name: '@lexical/code/vscode-wrapper',
});

/**
 * Match the first of a run of consecutive monospace+pre `<div>` /
 * `<br>` siblings (the Safari shape) and emit one CodeNode for the
 * whole run. When the framework's per-child dispatch lands on a
 * subsequent sibling in the same run, the prev-sibling check below
 * returns `[]` so the run is only emitted once.
 */
const VscodeLineRunRule = defineImportRule({
  $import: (_ctx, el, $next) => {
    if (!isMonospacePreElement(el) || isMonospaceDescendant(el)) {
      return $next();
    }
    const prev = el.previousElementSibling;
    if (prev && isMonospacePreElement(prev)) {
      // An earlier sibling's walk already absorbed `el` into its run.
      return [];
    }
    const lines: string[] = [];
    let cur: Element | null = el;
    while (cur && isMonospacePreElement(cur)) {
      lines.push(cur.tagName === 'BR' ? '' : cur.textContent || '');
      cur = cur.nextElementSibling;
    }
    if (lines.length < 2) {
      return $next();
    }
    return [
      $createCodeNode().splice(
        0,
        0,
        $generateNodesFromRawText(lines.join('\n')),
      ),
    ];
  },
  match: sel.tag('div', 'br'),
  name: '@lexical/code/vscode-line-run',
});

const VscodeCodePasteOverlay = defineOverlayRules([
  VscodeWrapperRule,
  VscodeLineRunRule,
]);

/**
 * VS Code → browser code-block pastes ship the block as either:
 *
 *  - **Chrome**: one outer
 *    `<div style="font-family: …monospace…; white-space: pre">…</div>`
 *    wrapping per-line `<div>`s and `<br>`s.
 *  - **Safari**: a flat run of sibling
 *    `<div style="…monospace…; white-space: pre">…</div>` and
 *    `<br style="…monospace…; …">` elements with no wrapping
 *    monospace ancestor (the styles are duplicated onto every
 *    element).
 *
 * The legacy `<div>` rule (and {@link DivRule}) produces one CodeNode
 * per `<div>` on Safari and concatenates inner divs without
 * separating `\n`s on Chrome. This preprocess scans once for the
 * structural signature and, only when it matches, pushes
 * {@link VscodeCodePasteOverlay} onto {@link ImportOverlays} so the
 * VS Code-specific rules participate in the walk. Pastes from other
 * sources pay only the detection cost.
 *
 * @experimental
 */
export const $installVscodeCodePasteOverlay: DOMPreprocessFn = (
  dom,
  ctx,
  $next,
) => {
  const root: ParentNode = isDOMDocumentNode(dom) ? dom.body : dom;
  if (looksLikeVscodePaste(root)) {
    ctx.session.update(ImportOverlays, prev => [
      ...prev,
      VscodeCodePasteOverlay,
    ]);
  }
  $next();
};

/**
 * A `<div style="font-family: …monospace…">` (Google-Docs-style code
 * block) creates a CodeNode. Descendant elements inside a monospace
 * wrapper just unwrap so their text content flows into the surrounding
 * CodeNode.
 */
const DivRule = defineImportRule({
  $import: (ctx, el, $next) => {
    if (isMonospaceElement(el)) {
      return [$createCodeNode().splice(0, 0, ctx.$importChildren(el))];
    }
    if (isMonospaceDescendant(el)) {
      // Unwrap so children flow into the enclosing CodeNode.
      return ctx.$importChildren(el);
    }
    return $next();
  },
  match: sel.tag('div'),
  name: '@lexical/code/div',
});

/**
 * GitHub raw-file-view `<table class="js-file-line-container">` becomes
 * a CodeNode. Walking the table's children pushes an overlay (see
 * {@link GitHubCodeTableOverlayRules}) so `<tr>` / `<td>` inside this
 * subtree unwrap unconditionally — without paying the predicate cost
 * on every other `<tr>` / `<td>` paste elsewhere.
 */
const GitHubCodeTableRule = defineImportRule({
  $import: (ctx, el) => [
    $createCodeNode().splice(
      0,
      0,
      ctx.$importChildren(el, {rules: GitHubCodeTableOverlayRules}),
    ),
  ],
  match: sel.tag('table').classAll('js-file-line-container'),
  name: '@lexical/code/github-code-table',
});

/**
 * Stray `<td class="js-file-line">` (cell with the explicit GitHub code-
 * line class but no surrounding code-table wrapper) — unwrap so the
 * descendant text flows up into whatever context the cell is in. The
 * class is part of the selector itself, so no runtime guard.
 */
const GitHubCodeCellByClassRule = defineImportRule({
  $import: (ctx, el) => ctx.$importChildren(el),
  match: sel.tag('td').classAll('js-file-line'),
  name: '@lexical/code/github-code-cell-by-class',
});

/**
 * Import rules for {@link CodeNode}.
 *
 * Specific class-restricted rules (GitHub raw-file-view detectors) are
 * registered before the generic `<table>` / `<tr>` / `<td>` rules so
 * they win dispatch.
 *
 * Registered by {@link CodeExtension} itself (together with
 * `CoreImportExtension` and the {@link $installVscodeCodePasteOverlay}
 * preprocess), so any editor that uses the code extension can import
 * these shapes through the `DOMImportExtension` pipeline without further
 * configuration.
 *
 * @experimental
 */
export const CodeImportRules = [
  // Higher-priority (more-specific) rules first:
  GitHubCodeTableRule,
  GitHubCodeCellByClassRule,
  MultilineCodeRule,
  PreRule,
  DivRule,
];
