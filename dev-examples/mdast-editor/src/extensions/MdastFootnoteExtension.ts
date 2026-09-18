/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {GetClipboardDataExtension} from '@lexical/clipboard';
import {
  $getExtensionOutput,
  applyFormatToDom,
  DecoratorTextExtension,
  DecoratorTextNode,
} from '@lexical/extension';
import {
  $generateDOMFromRoot,
  $getRenderContextValue,
  defineImportRule,
  DOMImportExtension,
  domOverride,
  DOMRenderExtension,
  ImportTextFormat,
  sel,
} from '@lexical/html';
import {
  type FootnoteDefinition,
  type FootnoteReference,
  MdastExportExtension,
  type MdastExportHandler,
  MdastImportExtension,
  type MdastImportHandler,
  type PhrasingContent,
  RenderContextMarkdownSelection,
  type RootContent,
} from '@lexical/mdast';
import {mergeRegister} from '@lexical/utils';
import {
  $addUpdateTag,
  $create,
  $createParagraphNode,
  $getDocument,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotHost,
  $getState,
  $getStateChange,
  $isDecoratorNode,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isRootNode,
  $isTextNode,
  $nodesOfType,
  $onUpdate,
  $removeSlot,
  $setSelection,
  $setSlot,
  $setState,
  CLEAR_EDITOR_COMMAND,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_BEFORE_EDITOR,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  CONTROL_OR_META,
  createCommand,
  createState,
  defineExtension,
  type DOMExportOutput,
  type EditorConfig,
  type ElementDOMSlot,
  ElementNode,
  HISTORIC_TAG,
  isExactShortcutMatch,
  isHTMLElement,
  KEY_DOWN_COMMAND,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode,
  NODE_STATE_DIRECT,
  type NodeStateVersion,
  registerEventListener,
  registerEventListeners,
  RootNode,
  setDOMUnmanaged,
} from 'lexical';
import {
  gfmFootnoteFromMarkdown,
  gfmFootnoteToMarkdown,
} from 'mdast-util-gfm-footnote';
import {defaultHandlers, type Options} from 'mdast-util-to-markdown';
import {gfmFootnote} from 'micromark-extension-gfm-footnote';

/**
 * The name of the {@link RootNode} slot the {@link FootnotesNode} lives in.
 * Slots accept undeclared names at runtime, so the root can host one without
 * a subclass — the value rides the root's slot Map, outside the children
 * channel, so document editing, selection walks, and the Markdown export of
 * the body never see it.
 */
export const FOOTNOTES_SLOT = 'footnotes';

/** The label as written (`[^label]`); matching is by {@link normalizeLabel}. */
const footnoteLabelState = createState('footnoteLabel', {
  parse: (v): string => (typeof v === 'string' ? v : ''),
});

/** mdast matches footnote identifiers case-insensitively. */
export function normalizeLabel(label: string): string {
  return label.toLowerCase();
}

/* -------------------------------------------------------------------------- *
 * Ref <-> definition navigation                                              *
 * -------------------------------------------------------------------------- */

// Navigation is real fragment navigation (GitHub's shape: `fn-*` ids on the
// definitions, `fnref-*` ids on the references, `<a href="#...">` both
// ways), so the BROWSER owns the scrolling, focus, and history behavior;
// the click listeners only move the lexical selection along with it.

/** The footnotes title's id; every ref's aria-describedby points here. */
const FOOTNOTES_LABEL_ID = 'footnote-label';

function definitionDomId(label: string): string {
  return `fn-${normalizeLabel(label)}`;
}

/** `fnref-label`, `fnref-label-2`, ... for repeated references. */
function referenceDomId(label: string, index: number): string {
  const base = `fnref-${normalizeLabel(label)}`;
  return index === 0 ? base : `${base}-${index + 1}`;
}

// The fragment is percent-decoded before it is matched against ids, so
// encoding here supports any character a label can carry.
function fragmentHref(id: string): string {
  return `#${encodeURIComponent(id)}`;
}

/**
 * Runs a click's selection follow-up AFTER the click's default action (the
 * fragment navigation) has fully settled. The navigation's blur/focus
 * fixup can land asynchronously (Firefox), and a selection applied before
 * it would be clobbered when the resulting selectionchange syncs back into
 * the editor — so wait for the `hashchange` the navigation fires, with a
 * timeout fallback because a same-fragment click navigates without one.
 */
function afterFragmentNavigation(anchor: HTMLElement, fn: () => void): void {
  const win = anchor.ownerDocument.defaultView;
  const controller = new AbortController();
  const abort = controller.abort.bind(controller, undefined);
  const {signal} = controller;
  signal.addEventListener('abort', fn, {once: true});
  if (win) {
    win.addEventListener('hashchange', abort, {
      once: true,
      signal,
    });
    signal.addEventListener(
      'abort',
      clearTimeout.bind(null, setTimeout(abort, 100)),
      {once: true},
    );
  } else {
    abort();
  }
}

/**
 * Every reference in the document grouped by normalized label, each group in
 * document order (slot subtrees included).
 */
function $collectFootnoteRefsByLabel(): Map<string, FootnoteRefNode[]> {
  const refs = new Map<string, FootnoteRefNode[]>();
  for (const node of $nodesOfType(FootnoteRefNode)) {
    const label = normalizeLabel(node.getLabel(NODE_STATE_DIRECT));
    const existingNodes = refs.get(label);
    const nodes = existingNodes || [];
    nodes.push(node);
    if (!existingNodes) {
      refs.set(label, nodes);
    }
  }
  return refs;
}

/** Every reference to `label`, in document order (slot subtrees included). */
function $collectFootnoteRefs(label: string): FootnoteRefNode[] {
  return $collectFootnoteRefsByLabel().get(normalizeLabel(label)) ?? [];
}

/**
 * Follows a reference click with the selection: caret to the definition
 * body's start. The scroll is the anchor's own fragment navigation, but
 * following the link moves the focus out of the editor (to the target, or
 * to the body when the target isn't focusable), so restore it — the caret
 * sits exactly where the browser scrolled to, so the focus does not fight
 * the navigation.
 */
function selectDefinition(editor: LexicalEditor, ref: FootnoteRefNode): void {
  editor.update(() => {
    const definition = $findFootnoteDefinition(ref.getLatest().getLabel());
    if (definition !== null) {
      definition.selectStart();
      $onUpdate(() => editor.focus());
    }
  });
}

/**
 * Follows a backlink click with the selection: caret to just after the
 * reference at `index` within the label's references (each rendered
 * backlink is bound to one reference, GitHub-style). Scroll and focus are
 * handled as in {@link selectDefinition}.
 */
function selectReference(
  editor: LexicalEditor,
  definition: FootnoteDefinitionNode,
  index: number,
): void {
  editor.update(() => {
    const refs = $collectFootnoteRefs(definition.getLatest().getLabel());
    const ref = refs[index];
    if (ref === undefined) {
      return;
    }
    const offset = ref.getIndexWithinParent() + 1;
    ref.getParentOrThrow().select(offset, offset);
    $onUpdate(() => editor.focus());
  });
}

/**
 * (Re)builds one definition's backlink chrome: a `↩` anchor per reference
 * (`↩` then `↩²`, `↩³`, ... GitHub-style), each a real fragment link
 * (`role="doc-backlink"`) to its own reference's id — the browser does the
 * jump, the click listener moves the selection along. The container is
 * marked unmanaged so the reconciler and the mutation observer leave it
 * alone inside the managed content DOM.
 */
function renderBacklinks(
  editor: LexicalEditor,
  definition: FootnoteDefinitionNode,
  host: HTMLElement,
  count: number,
): void {
  const doc = host.ownerDocument;
  const label = definition.getLabel();
  const container = doc.createElement('span');
  container.className = 'footnote-def-backlinks';
  container.contentEditable = 'false';
  setDOMUnmanaged(container);
  for (let index = 0; index < count; index++) {
    const backlink = doc.createElement('a');
    backlink.href = fragmentHref(referenceDomId(label, index));
    backlink.className = 'footnote-def-backlink';
    backlink.setAttribute('role', 'doc-backlink');
    backlink.setAttribute('aria-label', `Back to reference ${index + 1}`);
    backlink.setAttribute('title', `Back to reference ${index + 1}`);
    backlink.textContent = '↩';
    if (index > 0) {
      const sup = doc.createElement('sup');
      sup.textContent = String(index + 1);
      backlink.append(sup);
    }
    // See the ref's createDOM for the listener-lifetime and mousedown notes.
    void registerEventListeners(backlink, {
      click: () =>
        afterFragmentNavigation(backlink, () =>
          selectReference(editor, definition, index),
        ),
      mousedown: event => {
        event.preventDefault();
      },
    });
    container.append(backlink);
  }
  host.append(container);
}

/**
 * Keeps the anchor bookkeeping in sync with the document after each update:
 *
 * - Every reference's `<a>` gets its per-label ordinal id (`fnref-a`,
 *   `fnref-a-2`, ...) so definition backlinks can target it. Ids depend on
 *   document order, which createDOM cannot know, so they are (re)assigned
 *   here.
 * - Every definition gets one backlink per reference to its label,
 *   rendered after the note text (inside the body's last paragraph when
 *   there is one, like GitHub, otherwise appended to the body). The chrome
 *   depends on state OUTSIDE the definition node — the references live
 *   anywhere in the document — so it cannot be produced by
 *   createDOM/updateDOM alone; this listener re-anchors and re-counts it
 *   instead, and reconciliation recreating the body DOM simply drops the
 *   chrome for the next pass to rebuild.
 */
export function registerFootnoteAnchors(editor: LexicalEditor): () => void {
  return editor.registerUpdateListener(({editorState}) => {
    editorState.read(() => {
      const refsByLabel = $collectFootnoteRefsByLabel();
      for (const [label, refs] of refsByLabel) {
        refs.forEach((ref, index) => {
          const dom = editor.getElementByKey(ref.getKey());
          const anchor = dom !== null ? dom.querySelector('a') : null;
          if (anchor !== null) {
            anchor.id = referenceDomId(label, index);
          }
        });
      }
      const footnotes = $getSlot($getRoot(), FOOTNOTES_SLOT);
      if (!$isFootnotesNode(footnotes)) {
        return;
      }
      for (const definition of footnotes.getChildren()) {
        if (!$isFootnoteDefinitionNode(definition)) {
          continue;
        }
        const dom = editor.getElementByKey(definition.getKey());
        if (dom === null) {
          continue;
        }
        const count = (
          refsByLabel.get(normalizeLabel(definition.getLabel())) ?? []
        ).length;
        const lastChild = definition.getLastChild();
        const host =
          ($isParagraphNode(lastChild)
            ? editor.getElementByKey(lastChild.getKey())
            : null) ??
          dom.querySelector<HTMLElement>(':scope > .footnote-def-content');
        const existing = dom.querySelector<HTMLElement>(
          '.footnote-def-backlinks',
        );
        if (
          existing !== null &&
          (host === null ||
            existing.parentElement !== host ||
            existing.childElementCount !== count)
        ) {
          existing.remove();
        } else if (existing !== null) {
          continue;
        }
        if (host !== null && count > 0) {
          renderBacklinks(editor, definition, host, count);
        }
      }
    });
  });
}

/**
 * An inline, atomic footnote reference (`[^label]`). A DecoratorTextNode
 * with no framework content — the superscript marker is plain DOM chrome —
 * so it deletes as a unit and the label is not text the caret can enter,
 * while still carrying a text format bitmask (InlineFormattableNode) so
 * FORMAT_TEXT_COMMAND and format alignment treat it like the text around it.
 */
export class FootnoteRefNode extends DecoratorTextNode {
  $config() {
    return this.config('footnote-ref', {
      extends: DecoratorTextNode,
      stateConfigs: [{flat: true, stateConfig: footnoteLabelState}],
    });
  }

  getLabel(version?: NodeStateVersion): string {
    return $getState(this, footnoteLabelState, version);
  }

  setLabel(label: string): this {
    return $setState(this, footnoteLabelState, label);
  }

  createDOM(_config: EditorConfig, editor: LexicalEditor): HTMLElement {
    const doc = $getDocument();
    const dom = doc.createElement('sup');
    dom.className = 'footnote-ref';
    dom.contentEditable = 'false';
    // A real fragment link (GitHub's markup: role="doc-noteref", described
    // by the footnotes title): the browser owns the click's navigation and
    // scrolling. The per-label ordinal id lands on this anchor via
    // registerFootnoteAnchors.
    const anchor = doc.createElement('a');
    anchor.href = fragmentHref(definitionDomId(this.getLabel()));
    anchor.setAttribute('role', 'doc-noteref');
    anchor.setAttribute('aria-describedby', FOOTNOTES_LABEL_ID);
    anchor.setAttribute('title', 'Go to footnote');
    anchor.textContent = this.getLabel();
    dom.append(anchor);
    // The listeners' lifetimes are the DOM's own; `void` marks the
    // disposers as intentionally discarded. mousedown preventDefault keeps
    // the click from moving the caret; the click keeps its DEFAULT action
    // (the fragment navigation) and the listener only moves the selection
    // along with it.
    void registerEventListeners(anchor, {
      click: () =>
        afterFragmentNavigation(anchor, () => selectDefinition(editor, this)),
      mousedown: event => {
        event.preventDefault();
      },
    });
    // The format bitmask renders as real wrapper tags (<b>, <em>, ...)
    // around the marker, mirroring the text serialization.
    return applyFormatToDom(this, dom);
  }

  updateDOM(prevNode: this): boolean {
    // Label or format changes rebuild the whole marker: a format change
    // alters the wrapper structure around the <sup>, which is not worth
    // patching in place.
    return (
      $getStateChange(this, prevNode, footnoteLabelState) !== null ||
      this.getFormat(NODE_STATE_DIRECT) !==
        prevNode.getFormat(NODE_STATE_DIRECT)
    );
  }

  // Plain-text copy carries the Markdown syntax.
  getTextContent(): string {
    return `[^${this.getLabel()}]`;
  }

  exportDOM(): DOMExportOutput {
    const element = $getDocument().createElement('sup');
    element.setAttribute('data-footnote-ref', this.getLabel());
    element.textContent = `[^${this.getLabel()}]`;
    return {element: applyFormatToDom(this, element)};
  }
}

export function $createFootnoteRefNode(label: string): FootnoteRefNode {
  return $create(FootnoteRefNode).setLabel(label);
}

export function $isFootnoteRefNode(
  node: LexicalNode | null | undefined,
): node is FootnoteRefNode {
  return node instanceof FootnoteRefNode;
}

/**
 * One footnote definition: a `[^label]:` marker (chrome, with a remove
 * button) beside an editable block body. Lives as a child of
 * {@link FootnotesNode}; the node-level transform relocates any definition
 * that lands in the document flow (Markdown import, paste) into the
 * footnotes section, so the body never holds one.
 */
export class FootnoteDefinitionNode extends ElementNode {
  $config() {
    return this.config('footnote-def', {
      $transform(node: FootnoteDefinitionNode) {
        if (node.isEmpty()) {
          node.append($createParagraphNode());
        }
        const parent = node.getParent();
        if (parent !== null && !$isFootnotesNode(parent)) {
          $getFootnotesNode().append(node);
        }
      },
      extends: ElementNode,
      stateConfigs: [{flat: true, stateConfig: footnoteLabelState}],
    });
  }

  getLabel(version?: NodeStateVersion): string {
    return $getState(this, footnoteLabelState, version);
  }

  setLabel(label: string): this {
    return $setState(this, footnoteLabelState, label);
  }

  // The body behaves like a nested document (block inserts stay inside).
  isShadowRoot(): true {
    return true;
  }

  createDOM(_config: EditorConfig, editor: LexicalEditor): HTMLElement {
    const doc = $getDocument();
    const dom = doc.createElement('div');
    dom.className = 'footnote-def';
    // The refs' anchors target this id; doc-endnote per the DPUB-ARIA
    // (DAISY/EPUB) note vocabulary, matching GitHub's rendered footnotes.
    dom.id = definitionDomId(this.getLabel());
    dom.setAttribute('role', 'doc-endnote');
    const marker = doc.createElement('div');
    marker.className = 'footnote-def-marker';
    // Chrome, not content: keep the caret out of the marker column.
    marker.contentEditable = 'false';
    const label = doc.createElement('span');
    label.className = 'footnote-def-label';
    label.textContent = this.getLabel();
    marker.append(label);
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'footnote-def-remove';
    remove.setAttribute('aria-label', 'Remove footnote');
    remove.textContent = '×';
    // The listener's lifetime is the DOM's own; `void` marks the disposer
    // as intentionally discarded.
    void registerEventListener(remove, 'click', event => {
      event.preventDefault();
      // Deleting a definition (and its refs) is a document change; the
      // button is hidden in read-only via CSS, but guard anyway.
      if (editor.isEditable()) {
        editor.update(() => {
          $removeFootnoteDefinition(this.getLatest());
        });
      }
    });
    marker.append(remove);
    dom.append(marker);
    const content = doc.createElement('div');
    content.className = 'footnote-def-content';
    dom.append(content);
    return dom;
  }

  updateDOM(prevNode: this, dom: HTMLElement): boolean {
    const change = $getStateChange(this, prevNode, footnoteLabelState);
    if (change !== null) {
      dom.id = definitionDomId(change[0]);
      const label = dom.querySelector<HTMLElement>(
        ':scope > .footnote-def-marker > .footnote-def-label',
      );
      if (label !== null) {
        label.textContent = change[0];
      }
    }
    return false;
  }

  // The block children render beside the marker chrome.
  getDOMSlot(element: HTMLElement): ElementDOMSlot<HTMLElement> {
    const content = element.querySelector<HTMLElement>(
      ':scope > .footnote-def-content',
    );
    const domSlot = super.getDOMSlot(element);
    return content !== null ? domSlot.withElement(content) : domSlot;
  }

  // Clipboard HTML: a recognizable envelope (the DOM import rule reads
  // `data-footnote-def` back) with a plain `[^label]:` marker so external
  // paste targets still see which note this is. The marker span is chrome —
  // the import rule skips it; the block children append after it.
  exportDOM(): DOMExportOutput {
    const doc = $getDocument();
    const element = doc.createElement('div');
    element.setAttribute('data-footnote-def', this.getLabel());
    const label = doc.createElement('span');
    label.setAttribute('data-footnote-def-label', '');
    label.textContent = `[^${this.getLabel()}]: `;
    element.append(label);
    return {element};
  }
}

export function $createFootnoteDefinitionNode(
  label: string,
): FootnoteDefinitionNode {
  const node = $create(FootnoteDefinitionNode).setLabel(label);
  node.append($createParagraphNode());
  return node;
}

export function $isFootnoteDefinitionNode(
  node: LexicalNode | null | undefined,
): node is FootnoteDefinitionNode {
  return node instanceof FootnoteDefinitionNode;
}

/**
 * The footnotes section: the value of the root's `footnotes` slot, holding
 * the {@link FootnoteDefinitionNode}s as ordinary children. Rendered at the
 * bottom of the editor by MdastFootnoteExtension's RootNode render override;
 * removed (via the transform) when its last definition goes.
 */
export class FootnotesNode extends ElementNode {
  $config() {
    return this.config('footnotes', {
      $transform(node: FootnotesNode) {
        if (node.isEmpty()) {
          const host = $getSlotHost(node);
          if ($isRootNode(host)) {
            $removeSlot(host, FOOTNOTES_SLOT);
          }
        }
      },
      extends: ElementNode,
    });
  }

  isShadowRoot(): true {
    return true;
  }

  createDOM(): HTMLElement {
    const doc = $getDocument();
    const dom = doc.createElement('section');
    dom.className = 'footnotes';
    // doc-endnotes per the DPUB-ARIA (DAISY/EPUB) note vocabulary.
    dom.setAttribute('role', 'doc-endnotes');
    const title = doc.createElement('div');
    title.className = 'footnotes-title';
    // Chrome, not content. Every ref's aria-describedby points at this
    // title, GitHub-style.
    title.id = FOOTNOTES_LABEL_ID;
    title.contentEditable = 'false';
    title.textContent = 'Footnotes';
    dom.append(title);
    const list = doc.createElement('div');
    list.className = 'footnotes-list';
    dom.append(list);
    return dom;
  }

  updateDOM(): boolean {
    return false;
  }

  getDOMSlot(element: HTMLElement): ElementDOMSlot<HTMLElement> {
    const list = element.querySelector<HTMLElement>(':scope > .footnotes-list');
    const domSlot = super.getDOMSlot(element);
    return list !== null ? domSlot.withElement(list) : domSlot;
  }
}

export function $isFootnotesNode(
  node: LexicalNode | null | undefined,
): node is FootnotesNode {
  return node instanceof FootnotesNode;
}

/**
 * The document's footnotes section, created (and slotted onto the root) on
 * first use.
 */
export function $getFootnotesNode(): FootnotesNode {
  const root = $getRoot();
  const existing = $getSlot(root, FOOTNOTES_SLOT);
  if ($isFootnotesNode(existing)) {
    return existing;
  }
  const node = $create(FootnotesNode);
  $setSlot(root, FOOTNOTES_SLOT, node);
  return node;
}

/** The definition matching `label`, if the document has one. */
export function $findFootnoteDefinition(
  label: string,
): FootnoteDefinitionNode | null {
  const footnotes = $getSlot($getRoot(), FOOTNOTES_SLOT);
  if (!$isFootnotesNode(footnotes)) {
    return null;
  }
  const normalized = normalizeLabel(label);
  for (const child of footnotes.getChildren()) {
    if (
      $isFootnoteDefinitionNode(child) &&
      normalizeLabel(child.getLabel()) === normalized
    ) {
      return child;
    }
  }
  return null;
}

/** The definition matching `label`, created (empty) when missing. */
export function $ensureFootnoteDefinition(
  label: string,
): FootnoteDefinitionNode {
  const existing = $findFootnoteDefinition(label);
  if (existing !== null) {
    return existing;
  }
  const definition = $createFootnoteDefinitionNode(label);
  $getFootnotesNode().append(definition);
  return definition;
}

/**
 * Removes a definition and cascades to every reference carrying its label —
 * a `[^label]` marker with no definition would be dead chrome. This is what
 * the × button in the definition's marker calls; the section itself cleans
 * up via the FootnotesNode transform once its last definition goes.
 */
export function $removeFootnoteDefinition(
  definition: FootnoteDefinitionNode,
): void {
  // A caret inside the removed body would dangle (and abort the update);
  // drop the selection first.
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    const anchorNode = selection.anchor.getNode();
    if (
      anchorNode === definition ||
      anchorNode.getParents().some(parent => parent === definition)
    ) {
      $setSelection(null);
    }
  }
  for (const ref of $collectFootnoteRefs(definition.getLabel())) {
    ref.remove();
  }
  definition.remove();
}

/**
 * Drops the footnotes section entirely. MdastFootnoteExtension hooks this
 * up to CLEAR_EDITOR_COMMAND: `$convertFromMarkdownString` (and the default
 * clear handler) only clear the root's children, and slots are a separate
 * channel, so a stale section would otherwise survive a document
 * replacement (loading a repro link, Reset).
 */
export function $clearFootnotes(): void {
  const root = $getRoot();
  if ($isFootnotesNode($getSlot(root, FOOTNOTES_SLOT))) {
    $removeSlot(root, FOOTNOTES_SLOT);
  }
}

/* -------------------------------------------------------------------------- *
 * Markdown import: refs inline, definitions relocated to the footnotes slot  *
 * -------------------------------------------------------------------------- */

// The surrounding emphasis/strong/delete formats (`**x[^a]**`) land on the
// ref's DecoratorTextNode format bitmask, the way they land on text nodes.
const $importFootnoteReference: MdastImportHandler<FootnoteReference> = (
  node,
  ctx,
) => [
  $createFootnoteRefNode(node.label ?? node.identifier).setFormat(ctx.format),
];

// Definitions import as ordinary flow nodes; the FootnoteDefinitionNode
// transform relocates them into the root's footnotes slot in the same
// update, so this also covers paste and any other entry path.
const $importFootnoteDefinition: MdastImportHandler<FootnoteDefinition> = (
  node,
  ctx,
) => {
  const definition = $create(FootnoteDefinitionNode).setLabel(
    node.label ?? node.identifier,
  );
  definition.append(...node.children.flatMap(child => ctx.importNode(child)));
  return [definition];
};

/* -------------------------------------------------------------------------- *
 * Markdown export: refs from the walk, definitions appended by the root      *
 * handler                                                                    *
 * -------------------------------------------------------------------------- */

const $exportFootnoteRef: MdastExportHandler<FootnoteRefNode> = node => {
  let content: PhrasingContent = {
    identifier: normalizeLabel(node.getLabel()),
    label: node.getLabel(),
    type: 'footnoteReference',
  };
  // The format bitmask re-wraps in phrasing containers, nesting in the same
  // order as the core text serialization (emphasis innermost).
  if (node.hasFormat('italic')) {
    content = {children: [content], type: 'emphasis'};
  }
  if (node.hasFormat('bold')) {
    content = {children: [content], type: 'strong'};
  }
  if (node.hasFormat('strikethrough')) {
    content = {children: [content], type: 'delete'};
  }
  return content;
};

const $exportFootnoteDefinition: MdastExportHandler<FootnoteDefinitionNode> = (
  node,
  ctx,
) => ({
  // A freshly minted definition holds one empty paragraph; dropping it
  // serializes as a clean `[^label]:` instead of `[^label]: ` with a
  // trailing space.
  children: (ctx.exportChildren(node) as FootnoteDefinition['children']).filter(
    child => !(child.type === 'paragraph' && child.children.length === 0),
  ),
  identifier: normalizeLabel(node.getLabel()),
  label: node.getLabel(),
  type: 'footnoteDefinition',
});

// The registry's text-run accumulator merges adjacent same-format TEXT into
// one delimiter pair, but a formatted ref exports through its own handler,
// so `**x**` + `**[^a]**` would sit side by side and serialize as the
// broken `**x****[^a]**` / `*em**[^a]*` shapes. Folding adjacent same-type
// wrappers back together before serialization keeps the emitted Markdown
// re-parseable (`**x[^a]**`).
const MERGEABLE_PHRASING = new Set(['delete', 'emphasis', 'strong']);

function mergeAdjacentPhrasing(node: {children?: unknown[]}): void {
  const children = (node.children ?? []) as {
    type: string;
    children?: unknown[];
  }[];
  for (let i = children.length - 1; i > 0; i--) {
    const prev = children[i - 1];
    const current = children[i];
    if (
      MERGEABLE_PHRASING.has(current.type) &&
      prev.type === current.type &&
      prev.children !== undefined &&
      current.children !== undefined
    ) {
      prev.children.push(...current.children);
      children.splice(i, 1);
    }
  }
  children.forEach(mergeAdjacentPhrasing);
}

/** Every footnoteReference identifier in an mdast (sub)tree. */
function collectFootnoteReferenceIds(
  node: {type?: string; identifier?: string; children?: unknown[]},
  out: Set<string>,
): void {
  if (node.type === 'footnoteReference' && node.identifier !== undefined) {
    out.add(node.identifier);
  }
  for (const child of node.children ?? []) {
    collectFootnoteReferenceIds(child as {type?: string}, out);
  }
}

// The footnotes live on a root slot, outside the children walk, so nothing
// dispatches them during a normal export. A contributed to-markdown `root`
// handler runs synchronously inside the exporting editor.read(), where the
// slot is readable and the registry's exporter re-entrant: serialize the
// section as its own subtree and append the definitions to the document
// tree before delegating. gfmFootnoteToMarkdown then emits the `[^label]:`
// syntax (multi-block continuation indent included) at the document end.
const footnotesRootHandler = {
  handlers: {
    root: (node, parent, state, info) => {
      const footnotes = $getSlot($getRoot(), FOOTNOTES_SLOT);
      if ($isFootnotesNode(footnotes) && !footnotes.isEmpty()) {
        const {$convertToMdast} = $getExtensionOutput(MdastExportExtension);
        // On a whole-document export ALL definitions ride along, in section
        // order — an editor preserves content, unlike a renderer, so
        // unreferenced definitions survive the round trip too. A selection
        // export (a clipboard copy) instead scopes them to the references
        // that made it into the exported tree.
        let definitions: RootContent[] = $convertToMdast(footnotes).children;
        if ($getRenderContextValue(RenderContextMarkdownSelection) !== null) {
          const referenced = new Set<string>();
          collectFootnoteReferenceIds(node, referenced);
          definitions = definitions.filter(
            child =>
              child.type === 'footnoteDefinition' &&
              referenced.has(child.identifier),
          );
        }
        node.children.push(...definitions);
      }
      mergeAdjacentPhrasing(node);
      return defaultHandlers.root(node, parent, state, info);
    },
  },
} satisfies Options;

/* -------------------------------------------------------------------------- *
 * Rendering: the root slot's container reveals at the document bottom        *
 * -------------------------------------------------------------------------- */

// Slot containers park hidden slots-first in the host DOM. For the root's
// footnotes slot, reveal at the BOTTOM instead: a chrome anchor element is
// appended to the root DOM (created during reconciliation, so the mutation
// observer never sees it as foreign), $getSlotTargetElement re-parents the
// container into it, and $getDOMSlot bounds the root's managed children
// range before the anchor so new blocks always insert above the section.
const FootnotesRenderOverride = domOverride([RootNode], {
  $getDOMSlot: (_node, dom, $next) => {
    const anchor = dom.querySelector<HTMLElement>(':scope > .footnotes-anchor');
    const slot = $next();
    return anchor === null ? slot : slot.withBefore(anchor);
  },
  $getSlotTargetElement: (_node, slotName, hostDom, $next) => {
    if (slotName !== FOOTNOTES_SLOT) {
      return $next();
    }
    let anchor = hostDom.querySelector<HTMLElement>(
      ':scope > .footnotes-anchor',
    );
    if (anchor === null) {
      anchor = $getDocument().createElement('div');
      anchor.className = 'footnotes-anchor';
      hostDom.append(anchor);
    }
    return anchor;
  },
});

/* -------------------------------------------------------------------------- *
 * HTML paste: our own clipboard encoding                                     *
 * -------------------------------------------------------------------------- */

const FootnoteRefDOMImportRule = defineImportRule({
  // The accumulated format context (<b>, <em>, ... ancestors) carries onto
  // the ref, matching how the core #text rule applies it to text.
  $import: (ctx, el) => [
    $createFootnoteRefNode(
      el.getAttribute('data-footnote-ref') || '',
    ).setFormat(ctx.get(ImportTextFormat)),
  ],
  match: sel.tag('sup').attr('data-footnote-ref', true),
  name: '@lexical/dev-mdast-editor-example/footnote-ref-html',
});

// Reads back the envelope exportDOM emits (copying a selection with refs
// appends the referenced definitions to the clipboard HTML — see the
// GetClipboardDataExtension config below). The definition lands in the flow
// at the paste position and the node transform relocates it into the
// footnotes slot.
const FootnoteDefDOMImportRule = defineImportRule({
  $import: (ctx, el) => {
    const definition = $create(FootnoteDefinitionNode).setLabel(
      el.getAttribute('data-footnote-def') || '',
    );
    const content: ReturnType<typeof ctx.$importOne> = [];
    for (const child of Array.from(el.childNodes)) {
      // The `[^label]:` marker span is chrome, not content.
      if (
        isHTMLElement(child) &&
        child.hasAttribute('data-footnote-def-label')
      ) {
        continue;
      }
      content.push(...ctx.$importOne(child));
    }
    // The body is block content; wrap stray inline runs in paragraphs.
    let paragraph = null;
    for (const child of content) {
      if (
        ($isElementNode(child) || $isDecoratorNode(child)) &&
        !child.isInline()
      ) {
        paragraph = null;
        definition.append(child);
      } else {
        if (paragraph === null) {
          paragraph = $createParagraphNode();
          definition.append(paragraph);
        }
        paragraph.append(child);
      }
    }
    return [definition];
  },
  match: sel.tag('div').attr('data-footnote-def', true),
  name: '@lexical/dev-mdast-editor-example/footnote-def-html',
});

/* -------------------------------------------------------------------------- *
 * Clipboard export: selected refs carry their definitions                    *
 * -------------------------------------------------------------------------- */

// Copying part of a document detaches references from the notes they point
// at, so the definitions for every ref in the selection ride along at the
// end of the payload: the Markdown path scopes the root handler above via
// the selection option, and this handler appends the definitions' HTML
// (each in its data-footnote-def envelope) after the default clipboard
// serialization.
const FootnoteClipboardConfig = configExtension(GetClipboardDataExtension, {
  $exportMimeType: {
    'text/html': [
      (selection, $next) => {
        const html = $next();
        if (html === null || html === '' || selection === null) {
          return html;
        }
        const labels = new Set(
          selection
            .getNodes()
            .filter($isFootnoteRefNode)
            .map(node => normalizeLabel(node.getLabel())),
        );
        const footnotes = $getSlot($getRoot(), FOOTNOTES_SLOT);
        if (labels.size === 0 || !$isFootnotesNode(footnotes)) {
          return html;
        }
        const container = $getDocument().createElement('div');
        for (const definition of footnotes.getChildren()) {
          if (
            $isFootnoteDefinitionNode(definition) &&
            labels.has(normalizeLabel(definition.getLabel()))
          ) {
            $generateDOMFromRoot(container, definition);
          }
        }
        return html + container.innerHTML;
      },
    ],
  },
});

/* -------------------------------------------------------------------------- *
 * The `[^label]` typing shortcut                                             *
 * -------------------------------------------------------------------------- */

// micromark only tokenizes `[^label]` as a footnote reference when the
// label is already defined in the parsed document, so the streaming
// shortcut engine's fragment re-parse can never recognize one (the same
// reason the package special-cases task-list checkboxes). A small update
// listener handles it instead: typing `]` after `[^label` materializes the
// reference and creates the (empty) definition when it doesn't exist yet.
const SHORTCUT_RE = /\[\^([^\s[\]^]+)\]$/;
export const FOOTNOTE_SHORTCUT_TAG = 'footnote-shortcut';

function registerFootnoteShortcut(editor: LexicalEditor): () => void {
  return editor.registerUpdateListener(({editorState, dirtyLeaves, tags}) => {
    if (
      dirtyLeaves.size === 0 ||
      tags.has(FOOTNOTE_SHORTCUT_TAG) ||
      tags.has(HISTORIC_TAG) ||
      tags.has(COLLABORATION_TAG) ||
      !editor.isEditable()
    ) {
      return;
    }
    const match = editorState.read(
      () => {
        const selection = $getSelection();
        if (
          !$isRangeSelection(selection) ||
          !selection.isCollapsed() ||
          selection.anchor.type !== 'text'
        ) {
          return null;
        }
        const node = selection.anchor.getNode();
        const offset = selection.anchor.offset;
        if (
          !$isTextNode(node) ||
          !node.isSimpleText() ||
          node.hasFormat('code') ||
          !dirtyLeaves.has(node.getKey()) ||
          node.getTextContent().charAt(offset - 1) !== ']'
        ) {
          return null;
        }
        const found = SHORTCUT_RE.exec(node.getTextContent().slice(0, offset));
        return found === null
          ? null
          : {
              end: offset,
              key: node.getKey(),
              label: found[1],
              start: offset - found[0].length,
            };
      },
      {editor},
    );
    if (match === null) {
      return;
    }
    editor.update(() => {
      const node = $getNodeByKey(match.key);
      if (!$isTextNode(node)) {
        return;
      }
      $addUpdateTag(FOOTNOTE_SHORTCUT_TAG);
      let target;
      if (match.start <= 0) {
        [target] = node.splitText(match.end);
      } else {
        const parts = node.splitText(match.start, match.end);
        target = parts.length === 3 ? parts[1] : parts[parts.length - 1];
      }
      // The ref inherits the typed text's format, like the typed
      // characters it replaces.
      const ref = $createFootnoteRefNode(match.label).setFormat(
        target.getFormat(),
      );
      target.replace(ref);
      $ensureFootnoteDefinition(match.label);
      // Caret lands after the new reference (an element point on the
      // parent, so it works whether or not a sibling follows).
      const offset = ref.getIndexWithinParent() + 1;
      ref.getParentOrThrow().select(offset, offset);
    });
  });
}

/* -------------------------------------------------------------------------- *
 * The extension                                                              *
 * -------------------------------------------------------------------------- */

/**
 * Inserts a footnote reference at the selection (auto-numbered label),
 * creates its empty definition, and moves the caret into the definition
 * body to type the note.
 */
export const INSERT_FOOTNOTE_COMMAND: LexicalCommand<void> = createCommand(
  'INSERT_FOOTNOTE_COMMAND',
);

/**
 * GFM footnotes for the Markdown pipeline, demonstrating begin/end-of-document
 * data managed outside the children channel:
 *
 * - `[^label]` references are inline {@link FootnoteRefNode} decorators; the
 *   definitions live in a {@link FootnotesNode} held in a `footnotes` slot on
 *   the RootNode and rendered at the bottom of the editor via a RootNode
 *   render override.
 * - Import uses the GFM footnote grammar; imported definitions relocate from
 *   the flow into the slot by node transform. Export appends the definitions
 *   from the slot to the document end via a contributed to-markdown `root`
 *   handler (the slot is outside the export walk).
 * - Typing `[^label]` materializes a reference (and its definition) — a
 *   bespoke trigger, since micromark only recognizes references whose
 *   definition exists in the parsed text.
 */
export const MdastFootnoteExtension = defineExtension({
  dependencies: [
    // FootnoteRefNode extends DecoratorTextNode: refs participate in
    // FORMAT_TEXT_COMMAND and format alignment like the text around them.
    DecoratorTextExtension,
    FootnoteClipboardConfig,
    configExtension(DOMImportExtension, {
      rules: [FootnoteRefDOMImportRule, FootnoteDefDOMImportRule],
    }),
    configExtension(DOMRenderExtension, {
      overrides: [FootnotesRenderOverride],
    }),
    configExtension(MdastImportExtension, {
      exportRules: [
        {$export: $exportFootnoteRef, type: 'footnote-ref'},
        {$export: $exportFootnoteDefinition, type: 'footnote-def'},
      ],
      importRules: [
        {$import: $importFootnoteReference, type: 'footnoteReference'},
        {$import: $importFootnoteDefinition, type: 'footnoteDefinition'},
      ],
      mdastExtensions: [/* @__PURE__ */ gfmFootnoteFromMarkdown()],
      micromarkExtensions: [/* @__PURE__ */ gfmFootnote()],
      toMarkdownExtensions: [
        /* @__PURE__ */ gfmFootnoteToMarkdown(),
        footnotesRootHandler,
      ],
    }),
  ],
  name: '@lexical/dev-mdast-editor-example/MdastFootnote',
  nodes: [FootnoteRefNode, FootnoteDefinitionNode, FootnotesNode],
  register: editor =>
    mergeRegister(
      registerFootnoteShortcut(editor),
      registerFootnoteAnchors(editor),
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        event => {
          if (
            editor.isEditable() &&
            isExactShortcutMatch(event, 'f', {
              ...CONTROL_OR_META,
              altKey: true,
            })
          ) {
            event.preventDefault();
            event.stopPropagation();
            editor.dispatchCommand(INSERT_FOOTNOTE_COMMAND);
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_BEFORE_EDITOR,
      ),
      // Slots are a separate channel from the children that
      // CLEAR_EDITOR_COMMAND's default handler clears, so clearing the
      // editor participates here: drop the footnotes section, then fall
      // through (return false) to the ClearEditorExtension handler.
      editor.registerCommand(
        CLEAR_EDITOR_COMMAND,
        () => {
          $clearFootnotes();
          return false;
        },
        COMMAND_PRIORITY_BEFORE_EDITOR,
      ),
      editor.registerCommand(
        INSERT_FOOTNOTE_COMMAND,
        () => {
          const selection = $getSelection();
          if (!editor.isEditable() || !$isRangeSelection(selection)) {
            return false;
          }
          let label = selection.getTextContent().trim();
          if (!label) {
            // Smallest unused numeric label.
            const footnotes = $getSlot($getRoot(), FOOTNOTES_SLOT);
            const used = new Set(
              ($isFootnotesNode(footnotes) ? footnotes.getChildren() : [])
                .filter($isFootnoteDefinitionNode)
                .map(definition => normalizeLabel(definition.getLabel())),
            );
            let n = 1;
            while (used.has(String(n))) {
              n++;
            }
            label = String(n);
          }
          selection.insertNodes([$createFootnoteRefNode(label)]);
          // Jump into the new definition to type the note.
          $ensureFootnoteDefinition(label).selectEnd();
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    ),
});
