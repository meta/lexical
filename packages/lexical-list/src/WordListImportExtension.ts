/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  createImportState,
  defineImportRule,
  defineOverlayRules,
  type DOMImportContext,
  DOMImportExtension,
  type DOMPreprocessFn,
  ImportOverlays,
  InlineSchema,
  sel,
} from '@lexical/html';
import {
  configExtension,
  defineExtension,
  getStyleObjectFromCSS,
  isHTMLElement,
} from 'lexical';

import {ListExtension} from './LexicalListExtension';
import {$createListItemNode} from './LexicalListItemNode';
import {$createListNode, type ListNode} from './LexicalListNode';

const WORD_LIST_CLASS_RE = /^MsoListParagraph(CxSp(First|Middle|Last))?$/;
const WORD_NUMBERED_RE = /^[A-Za-z0-9]+[.)]/;
const WORD_GENERATOR_RE = /Microsoft Word/i;

/**
 * `mso-list` is a Microsoft non-standard CSS property, so neither
 * browsers nor JSDOM surface it through `el.style`. Worse, the default
 * `$inlineStylesFromStyleSheets` preprocess writes each element's
 * inline style through `CSSStyleDeclaration.setProperty`, which
 * re-serializes the `style` attribute and drops the unknown property
 * altogether. {@link $installWordListPasteOverlay} runs first (it is
 * pushed onto the preprocess stack, so it sits on top) and snapshots
 * `mso-list` onto this `data-*` attribute, which survives the later
 * stylesheet-inlining pass.
 */
const MSO_LIST_DATA_ATTR = 'data-mso-list';

function readWordListLevel(el: HTMLElement): number {
  // mso-list looks like "l<N> level<M> lfo<X>"; pluck the level number.
  const m = (el.getAttribute(MSO_LIST_DATA_ATTR) || '').match(/level(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

function findMarkerSpan(el: HTMLElement): Element | null {
  return el.querySelector(`span[${MSO_LIST_DATA_ATTR}="Ignore"]`);
}

function readWordMarker(el: HTMLElement): string {
  const span = findMarkerSpan(el);
  return span ? (span.textContent || '').trim() : '';
}

function classifyWordListType(marker: string): 'number' | 'bullet' {
  return WORD_NUMBERED_RE.test(marker) ? 'number' : 'bullet';
}

function stripWordMarker(el: HTMLElement): void {
  // The marker span is wrapped in an outer <span> directly under the
  // <p>; remove that outer wrapper.
  const inner = findMarkerSpan(el);
  if (!inner) {
    return;
  }
  let outer: Element = inner;
  while (
    outer.parentElement &&
    outer.parentElement !== el &&
    outer.parentElement.nodeName === 'SPAN'
  ) {
    outer = outer.parentElement;
  }
  outer.remove();
}

function isWordListParagraph(node: Node): node is HTMLElement {
  return isHTMLElement(node) && WORD_LIST_CLASS_RE.test(node.className);
}

interface WordListItem {
  el: HTMLElement;
  level: number;
  marker: string;
}

function $buildWordListTree(
  ctx: DOMImportContext,
  items: readonly WordListItem[],
): ListNode {
  const root = $createListNode(classifyWordListType(items[0].marker));
  type Frame = {list: ListNode; level: number};
  const stack: Frame[] = [{level: items[0].level, list: root}];
  for (const item of items) {
    while (stack.length > 1 && stack[stack.length - 1].level > item.level) {
      stack.pop();
    }
    if (item.level > stack[stack.length - 1].level) {
      // Lexical's nested-list convention (see `$isNestedListNode`): a
      // sublist lives inside its OWN ListItemNode wrapper that is a
      // sibling of the items above it, not inside the previous content
      // item. The wrapper has no own content, just the sublist as its
      // first child.
      const sub = $createListNode(classifyWordListType(item.marker));
      stack[stack.length - 1].list.append($createListItemNode().append(sub));
      stack.push({level: item.level, list: sub});
    }
    stripWordMarker(item.el);
    stack[stack.length - 1].list.append(
      $createListItemNode().splice(
        0,
        0,
        ctx.$importChildren(item.el, {schema: InlineSchema}),
      ),
    );
  }
  return root;
}

/**
 * Per-import session WeakSet tracking `<p class="MsoListParagraph*">`
 * elements already absorbed by an earlier sibling's list-construction
 * pass, so the framework's normal child iteration treats them as
 * no-ops. The default is `null` and the rule lazily installs a fresh
 * WeakSet per session, because `createImportState`'s default factory
 * runs once at state creation and its result is shared across sessions.
 */
const WordListConsumed = createImportState<WeakSet<Element> | null>(
  '@lexical/list/word-consumed-list-items',
  () => null,
);

const WordListParagraphRule = defineImportRule({
  $import: (ctx, el) => {
    let consumed = ctx.session.get(WordListConsumed);
    if (consumed === null) {
      consumed = new WeakSet();
      ctx.session.set(WordListConsumed, consumed);
    }
    if (consumed.has(el)) {
      return [];
    }
    const items: WordListItem[] = [];
    let cur: Node | null = el;
    while (cur && isWordListParagraph(cur)) {
      consumed.add(cur);
      items.push({
        el: cur,
        level: readWordListLevel(cur),
        marker: readWordMarker(cur),
      });
      // MsoListParagraph (no CxSp suffix) is a single-item run.
      if (
        cur.classList.contains('MsoListParagraphCxSpLast') ||
        cur.className === 'MsoListParagraph'
      ) {
        break;
      }
      cur = cur.nextElementSibling;
    }
    return [$buildWordListTree(ctx, items)];
  },
  match: sel
    .tag('p')
    .classAny(
      'MsoListParagraph',
      'MsoListParagraphCxSpFirst',
      'MsoListParagraphCxSpMiddle',
      'MsoListParagraphCxSpLast',
    ),
  name: '@lexical/list/word-list-paragraph',
});

// <o:p> is Office's "paragraph end" marker, emitted inside every Word
// paragraph including the list ones; it always produces nothing.
const WordOfficeParagraphRule = defineImportRule({
  $import: () => [],
  match: sel.tag('o:p'),
  name: '@lexical/list/word-o-p',
});

const WordListPasteOverlay = defineOverlayRules([
  WordOfficeParagraphRule,
  WordListParagraphRule,
]);

/**
 * MS Word pastes have no `<ol>`/`<ul>`/`<li>` at all: a list is a flat
 * run of `<p class="MsoListParagraph*">` siblings whose marker ("1.",
 * "·", "a)") lives in a nested `<span style="mso-list:Ignore">`, with
 * `style="mso-list:l<N> level<M> lfo<X>"` on the paragraph naming the
 * list and its nesting depth.
 *
 * This preprocess looks once for
 * `<meta name="Generator" content="Microsoft Word…">` and, only when it
 * matches, snapshots the `mso-list` declarations (see
 * {@link MSO_LIST_DATA_ATTR}) and pushes a Word-specific overlay onto
 * {@link ImportOverlays}. The overlay's rule walks forward through
 * siblings to collect a complete run and rebuilds it as a nested
 * {@link ListNode} tree. Pastes from other sources pay only the
 * detection cost.
 *
 * Installed by {@link WordListImportExtension}.
 */
const $installWordListPasteOverlay: DOMPreprocessFn = (dom, ctx, $next) => {
  const meta = dom.querySelector('meta[name="Generator"]');
  if (meta && WORD_GENERATOR_RE.test(meta.getAttribute('content') || '')) {
    for (const el of Array.from(dom.querySelectorAll('[style*="mso-list"]'))) {
      const msoList = getStyleObjectFromCSS(el.getAttribute('style') || '')[
        'mso-list'
      ];
      if (msoList) {
        el.setAttribute(MSO_LIST_DATA_ATTR, msoList);
      }
    }
    ctx.session.update(ImportOverlays, prev => [...prev, WordListPasteOverlay]);
  }
  $next();
};

/**
 * Word list paste support for {@link ListNode}: opt in by adding this to
 * an editor's dependencies. {@link ListExtension} does not depend on it,
 * so an editor that never pastes from Word does not bundle any of it.
 *
 * ```ts
 * defineExtension({
 *   dependencies: [WordListImportExtension],
 *   name: 'my-editor',
 * });
 * ```
 *
 * @experimental
 */
export const WordListImportExtension = defineExtension({
  dependencies: [
    // The overlay builds ListNodes, so the nodes have to be registered.
    ListExtension,
    configExtension(DOMImportExtension, {
      preprocess: [$installWordListPasteOverlay],
    }),
  ],
  name: '@lexical/list/WordListImport',
});
