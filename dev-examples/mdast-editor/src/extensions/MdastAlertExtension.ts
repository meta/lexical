/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  Blockquote,
  MdastExportHandler,
  MdastImportHandler,
  PhrasingContent,
} from '@lexical/mdast';

import {
  BlockSchema,
  defineImportRule,
  DOMImportExtension,
  domOverride,
  DOMRenderExtension,
  sel,
} from '@lexical/html';
import {MdastExtension, MdastShadowRootQuoteExtension} from '@lexical/mdast';
import {$createQuoteNode, $isQuoteNode, QuoteNode} from '@lexical/rich-text';
import {$insertNodeToNearestRoot, mergeRegister} from '@lexical/utils';
import {
  $createParagraphNode,
  $getDocument,
  $getState,
  $setState,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  createCommand,
  createState,
  defineExtension,
  isDOMNode,
  isHTMLElement,
  type LexicalCommand,
  type LexicalEditor,
  registerEventListener,
  registerEventListeners,
  setDOMUnmanaged,
} from 'lexical';

/**
 * The third example custom construct: GitHub-style alerts
 * (https://docs.github.com/en/get-started/writing-on-github — the
 * `> [!NOTE]` blockquote extension). Unlike the collapsible (raw HTML
 * block) and kbd (raw HTML inline run), alerts are *Markdown-syntax*
 * driven, and they need no node class at all:
 *
 * - the alert type is NodeState on the ordinary {@link QuoteNode}, so it
 *   rides copy/paste, undo, and JSON for free;
 * - the chrome (GitHub's `markdown-alert` classes plus the fixed,
 *   non-editable title line) is a {@link DOMRenderExtension} override on
 *   QuoteNode — rendering is customized without subclassing.
 */
/**
 * The canonical alert table: the five types GitHub supports mapped to
 * their fixed titles. Everything else derives from it — the AlertType
 * union, the type list, the marker/class grammars, and the menu.
 */
const ALERT_TITLES = {
  /* eslint-disable sort-keys-fix/sort-keys-fix -- GitHub's documentation order; the menu shows it */
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
  /* eslint-enable sort-keys-fix/sort-keys-fix */
} as const;

export type AlertType = keyof typeof ALERT_TITLES;

const ALERT_TYPES = Object.keys(ALERT_TITLES) as readonly AlertType[];

/** `null` is an ordinary quote; a type makes the same node an alert. */
const alertTypeState = createState('alertType', {
  parse: (v): AlertType | null =>
    typeof v === 'string' && v in ALERT_TITLES ? (v as AlertType) : null,
});

/* -------------------------------------------------------------------------- *
 * Markdown import: a blockquote whose first line is exactly the marker      *
 * -------------------------------------------------------------------------- */

// GitHub's rules: the marker must be alone on the blockquote's first line
// (trailing whitespace tolerated), case-insensitive, and unknown types
// fall through to a plain blockquote.
const MARKER_RE = new RegExp(
  String.raw`^\[!(${ALERT_TYPES.join('|')})\][ \t]*(\n|$)`,
  'i',
);

/**
 * Matches `node` against the alert shape. Returns the type plus the
 * blockquote children with the marker line stripped, or `null` for a plain
 * blockquote. Soft line breaks live inside mdast text values as `\n`, so
 * "marker alone on its line" means the first text child either continues
 * with a newline or ends the paragraph (a hard `break` sibling also ends
 * the line).
 */
function matchAlert(
  node: Blockquote,
): {children: Blockquote['children']; type: AlertType} | null {
  const [first, ...rest] = node.children;
  if (first === undefined || first.type !== 'paragraph') {
    return null;
  }
  const [lead, ...inline] = first.children;
  if (lead === undefined || lead.type !== 'text') {
    return null;
  }
  const match = MARKER_RE.exec(lead.value);
  if (match === null) {
    return null;
  }
  const value = lead.value.slice(match[0].length);
  let children: PhrasingContent[];
  if (value !== '') {
    children = [{...lead, value}, ...inline];
  } else if (match[2] === '\n' || inline.length === 0) {
    children = inline;
  } else if (inline[0].type === 'break') {
    children = inline.slice(1);
  } else {
    // Content on the marker line (`[!NOTE] *x*`): not an alert on GitHub.
    return null;
  }
  return {
    children: children.length > 0 ? [{...first, children}, ...rest] : [...rest],
    type: match[1].toLowerCase() as AlertType,
  };
}

// One import handler per mdast type, so this rule owns 'blockquote'
// entirely: the non-alert branch replicates MdastShadowRootQuoteExtension's
// handler (a shadow-root QuoteNode holding the imported block children —
// alerts hold block content on GitHub, lists and code included).
const $importAlertBlockquote: MdastImportHandler<Blockquote> = (node, ctx) => {
  const alert = matchAlert(node);
  const quote = $createQuoteNode({shadowRoot: true});
  if (alert !== null) {
    $setState(quote, alertTypeState, alert.type);
  }
  const blocks = (alert === null ? node.children : alert.children).flatMap(
    child => ctx.importNode(child),
  );
  // A marker-only alert (`> [!NOTE]`) has no body left; the caret still
  // needs a block to land in.
  quote.append(...(blocks.length > 0 ? blocks : [$createParagraphNode()]));
  return [quote];
};

/* -------------------------------------------------------------------------- *
 * Markdown export: prepend the marker line to the ordinary quote output     *
 * -------------------------------------------------------------------------- */

// Shadows the core 'quote' export handler, so the alert-less path mirrors
// it exactly: a shadow-root quote's block children dispatch directly, a
// legacy (typed `> `) quote's inline content reassembles into paragraphs.
const $exportAlertQuote: MdastExportHandler = (node, ctx) => {
  if (!$isQuoteNode(node)) {
    return null;
  }
  const children = (
    node.isShadowRoot() ? ctx.exportChildren(node) : ctx.exportBlocks(node)
  ) as Blockquote['children'];
  const type = $getState(node, alertTypeState);
  if (type !== null) {
    // 'html'-typed so to-markdown emits the marker verbatim — as 'text' it
    // would escape the bracket (`\[!NOTE]`) and stop matching on re-import.
    const marker = {
      type: 'html',
      value: `[!${type.toUpperCase()}]`,
    } as const;
    const first = children[0];
    if (first !== undefined && first.type === 'paragraph') {
      // The GitHub-canonical shape: the marker and the first paragraph
      // share one blockquote paragraph (`> [!NOTE]\n> body`, no `>` blank
      // line between). A break with no recorded marker is soft and
      // serializes as a plain newline.
      first.children.unshift(marker, {type: 'break'});
    } else {
      // First block is a list/code/etc.: the marker gets its own
      // paragraph (GitHub renders the blank-line form too).
      children.unshift({children: [marker], type: 'paragraph'});
    }
  }
  return {children, type: 'blockquote'};
};

/* -------------------------------------------------------------------------- *
 * Rendering: a DOMRenderExtension override on QuoteNode, no subclass        *
 * -------------------------------------------------------------------------- */

/**
 * Builds the non-editable title chrome: a labelled trigger that opens a
 * small dropdown menu offering the five alert types plus "Convert to
 * blockquote" (which clears the state back to a plain quote). All plain
 * DOM — the menu lives inside the title element, which is marked with
 * `setDOMUnmanaged` so the mutation observer doesn't evict the click-time
 * insertion — and is torn down on selection, Escape, or an outside
 * pointerdown.
 */
function $renderAlertTitle(
  node: QuoteNode,
  editor: LexicalEditor,
): HTMLElement {
  const doc = $getDocument();
  const title = doc.createElement('div');
  title.className = 'markdown-alert-title';
  // Chrome, not content: keep the caret out of the fixed title.
  title.contentEditable = 'false';
  // The dropdown is appended here at click time — outside of
  // reconciliation, where the mutation observer would normally revert
  // unknown DOM. Marking the subtree unmanaged (like a decorator's)
  // makes lexical leave its contents alone.
  setDOMUnmanaged(title);
  title.setAttribute('role', 'button');
  title.setAttribute('aria-haspopup', 'menu');
  title.setAttribute('aria-expanded', 'false');
  title.setAttribute('title', 'Change the alert type');
  const label = doc.createElement('span');
  label.className = 'markdown-alert-title-label';
  title.append(label);

  let openMenuEl: HTMLElement | null = null;
  // Repeated calls are no-ops: mergeRegister empties its list after running.
  let closeMenu = mergeRegister();
  const openMenu = (): void => {
    const menu = doc.createElement('div');
    menu.className = 'markdown-alert-menu';
    menu.setAttribute('role', 'menu');
    const current = editor.read('latest', () =>
      $getState(node, alertTypeState),
    );
    const addItem = (text: string, value: AlertType | null): void => {
      const item = doc.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(value === current));
      item.className = [
        'markdown-alert-menu-item',
        value === null
          ? 'markdown-alert-menu-remove'
          : `markdown-alert-${value}`,
        value === current ? 'is-current' : '',
      ]
        .filter(Boolean)
        .join(' ');
      item.textContent = text;
      // The item's lifetime is the menu's own; the disposer is
      // intentionally discarded.
      void registerEventListener(item, 'click', event => {
        event.preventDefault();
        // Don't bubble into the title's own click handler (a toggle).
        event.stopPropagation();
        closeMenu();
        editor.update(() => {
          $setState(node, alertTypeState, value);
        });
      });
      menu.append(item);
    };
    for (const t of ALERT_TYPES) {
      addItem(ALERT_TITLES[t], t);
    }
    addItem('Convert to blockquote', null);
    // Anchored inside the (unmanaged) title, so it scrolls with its
    // trigger for free.
    title.append(menu);
    openMenuEl = menu;
    title.setAttribute('aria-expanded', 'true');
    closeMenu = mergeRegister(
      () => {
        menu.remove();
        openMenuEl = null;
        title.setAttribute('aria-expanded', 'false');
      },
      // Dismissal listeners live only while the menu is open. Capture so
      // dismissal wins even over handlers that stop propagation.
      registerEventListeners(
        doc,
        {
          keydown: event => {
            if (event.key === 'Escape') {
              closeMenu();
            }
          },
          pointerdown: event => {
            if (!isDOMNode(event.target) || !title.contains(event.target)) {
              closeMenu();
            }
          },
        },
        true,
      ),
    );
  };
  // The listeners' lifetimes are the DOM's own; `void` marks the disposer
  // as intentionally discarded.
  void registerEventListeners(title, {
    click: event => {
      event.preventDefault();
      if (openMenuEl !== null) {
        closeMenu();
      } else if (editor.isEditable()) {
        // Every menu entry mutates the document (type change or convert to
        // blockquote), so the dropdown simply doesn't open in read-only.
        openMenu();
      }
    },
    // Toolbar-style trigger: preventDefault on mousedown keeps the editor's
    // selection (and the caret scroll-into-view that would follow) untouched.
    mousedown: event => {
      event.preventDefault();
    },
  });
  return title;
}

/**
 * Idempotent sync of the alert chrome onto the quote's DOM: GitHub's
 * `markdown-alert` / `markdown-alert-<type>` classes plus a non-editable
 * title line (GitHub alerts have fixed titles — no custom text). Runs from
 * `$decorateDOM`, so it covers creation, `alertType` changes, and the
 * state being removed (undo or "Convert to blockquote") alike.
 */
function $syncAlertChrome(
  node: QuoteNode,
  dom: HTMLElement,
  editor: LexicalEditor,
): void {
  const type = $getState(node, alertTypeState);
  dom.classList.toggle('markdown-alert', type !== null);
  for (const t of ALERT_TYPES) {
    dom.classList.toggle(`markdown-alert-${t}`, t === type);
  }
  let title = dom.querySelector<HTMLElement>(':scope > .markdown-alert-title');
  if (type === null) {
    if (title !== null) {
      title.remove();
    }
    return;
  }
  if (title === null) {
    title = $renderAlertTitle(node, editor);
    dom.prepend(title);
  }
  const label = title.querySelector<HTMLElement>(
    ':scope > .markdown-alert-title-label',
  );
  if (label !== null) {
    label.textContent = ALERT_TITLES[type];
  }
}

const AlertRenderOverride = domOverride([QuoteNode], {
  $decorateDOM: (nextNode, _prevNode, dom, editor) => {
    $syncAlertChrome(nextNode, dom, editor);
  },
  // HTML export (clipboard / $generateHtmlFromNodes) carries the alert as
  // GitHub's rendered markup: the classes plus a title element that the
  // import rule below strips back off.
  $exportDOM: (node, $next) => {
    const output = $next();
    const type = $getState(node, alertTypeState);
    if (type === null || !isHTMLElement(output.element)) {
      return output;
    }
    output.element.classList.add('markdown-alert', `markdown-alert-${type}`);
    const title = $getDocument().createElement('p');
    title.className = 'markdown-alert-title';
    title.textContent = ALERT_TITLES[type];
    output.element.prepend(title);
    return output;
  },
  // The title is chrome ahead of the children channel: anchor the
  // lexical-managed range after it so the reconciler never touches it.
  $getDOMSlot: (node, dom, $next) => {
    const title = dom.querySelector<HTMLElement>(
      ':scope > .markdown-alert-title',
    );
    const slot = $next();
    return title === null ? slot : slot.withAfter(title);
  },
});

/* -------------------------------------------------------------------------- *
 * HTML paste: GitHub's rendered alert markup (and our own export) imports   *
 * -------------------------------------------------------------------------- */

const ALERT_CLASS_RE = new RegExp(
  String.raw`(?:^|\s)markdown-alert-(${ALERT_TYPES.join('|')})(?:\s|$)`,
);

const AlertDOMImportRule = defineImportRule({
  $import: (ctx, el, $next) => {
    const match = ALERT_CLASS_RE.exec(el.className);
    if (match === null) {
      // The base class without a type class: not alert markup after all.
      return $next();
    }
    // The fixed title is chrome; only the body is content.
    for (const title of el.querySelectorAll(':scope > .markdown-alert-title')) {
      title.remove();
    }
    return [
      $setState(
        $createQuoteNode({shadowRoot: true}),
        alertTypeState,
        match[1] as AlertType,
      ).splice(0, 0, ctx.$importChildren(el, {schema: BlockSchema})),
    ];
  },
  // GitHub renders alerts as a classed <div>; our exportDOM keeps the
  // <blockquote>.
  match: sel.tag('div', 'blockquote').classAll('markdown-alert'),
  name: '@lexical/dev-mdast-editor-example/alert-html',
});

/* -------------------------------------------------------------------------- *
 * The extension                                                              *
 * -------------------------------------------------------------------------- */

/**
 * Inserts an alert of the given type at the selection, with the caret in
 * its (empty) body. The title click cycles the type afterwards.
 */
export const INSERT_ALERT_COMMAND: LexicalCommand<AlertType> = createCommand(
  'INSERT_ALERT_COMMAND',
);

/**
 * GitHub-style alerts (`> [!NOTE]` … `> [!CAUTION]`) for the Markdown
 * pipeline, demonstrating a Markdown-syntax-driven construct with no
 * custom node: the type is NodeState on {@link QuoteNode} and every
 * rendering concern is a {@link DOMRenderExtension} override. Import
 * recognizes the marker per GitHub's rules (first line of the blockquote,
 * alone on its line, case-insensitive, unknown types stay plain quotes);
 * export prepends the canonical uppercase marker to the ordinary quote
 * serialization. HTML paste of GitHub's rendered alert markup maps back
 * to the same state.
 */
export const MdastAlertExtension = defineExtension({
  dependencies: [
    // Alert bodies are block content (paragraphs, lists, code), so quotes
    // import as shadow roots; the import rule above replicates this
    // extension's handler for the plain-quote branch.
    MdastShadowRootQuoteExtension,
    configExtension(DOMImportExtension, {
      rules: [AlertDOMImportRule],
    }),
    configExtension(DOMRenderExtension, {
      overrides: [AlertRenderOverride],
    }),
    configExtension(MdastExtension, {
      exportRules: [{$export: $exportAlertQuote, type: QuoteNode}],
      importRules: [{$import: $importAlertBlockquote, type: 'blockquote'}],
    }),
  ],
  name: '@lexical/dev-mdast-editor-example/MdastAlert',
  register: editor =>
    editor.registerCommand(
      INSERT_ALERT_COMMAND,
      alertType => {
        if (!editor.isEditable()) {
          return false;
        }
        const quote = $setState(
          $createQuoteNode({shadowRoot: true}),
          alertTypeState,
          alertType,
        ).append($createParagraphNode());
        $insertNodeToNearestRoot(quote);
        quote.selectStart();
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});
