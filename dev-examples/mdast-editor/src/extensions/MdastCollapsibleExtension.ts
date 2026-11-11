/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $appendNodeToHTML,
  $getRenderContextValue,
  defineImportRule,
  DOMImportExtension,
  domOverride,
  DOMRenderExtension,
  sel,
} from '@lexical/html';
import {
  $exportViaDOM,
  MdastExtension,
  MdastHtmlExtension,
  RenderContextMarkdownExport,
} from '@lexical/mdast';
import {$insertNodeToNearestRoot, mergeRegister} from '@lexical/utils';
import {
  $create,
  $createParagraphNode,
  $getDocument,
  $getSelection,
  $getSlot,
  $getSlotFrame,
  $getSlotHost,
  $getState,
  $getStateChange,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $nodesOfType,
  $setSlot,
  $setState,
  COMMAND_PRIORITY_BEFORE_EDITOR,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  createCommand,
  createState,
  defineExtension,
  type DOMExportOutput,
  type EditorConfig,
  type ElementDOMSlot,
  ElementNode,
  INSERT_PARAGRAPH_COMMAND,
  isHTMLElement,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode,
  type NodeStateVersion,
  registerEventListener,
  type StateValueOrUpdater,
} from 'lexical';

// Whether the section is expanded, stored as NodeState (rather than a bespoke
// serialized field) so it rides copy/paste, undo, and JSON for free. The
// default is open so freshly inserted collapsibles show their content;
// markdown `<details>` without the `open` attribute imports as closed.
const collapsibleOpenState = createState('open', {
  parse: (v): boolean => (typeof v === 'boolean' ? v : true),
});

/**
 * The collapsible section demonstrated by this example: an ElementNode host
 * whose *summary* line lives in a named slot (its own isolated single-line
 * editable region, see the named-slots docs) while the collapsed body is the
 * node's regular children channel. In Markdown it round-trips through the
 * GFM-style raw HTML encoding:
 *
 * ```
 * <details><summary>
 * The *summary* line
 * </summary>
 *
 * The body blocks
 * </details>
 * ```
 *
 * See `MdastCollapsibleExtension` for the mdast wiring.
 */
export class CollapsibleNode extends ElementNode {
  $config() {
    return this.config('collapsible', {
      // The body must always have a block to put the caret in; the summary
      // slot needs no equivalent because a slot value is never removed by
      // editing within it.
      $transform(node: CollapsibleNode) {
        if (node.isEmpty()) {
          node.append($createParagraphNode());
        }
      },
      extends: ElementNode,
      slots: ['summary'],
      stateConfigs: [{flat: true, stateConfig: collapsibleOpenState}],
    });
  }

  isOpen(version?: NodeStateVersion): boolean {
    return $getState(this, collapsibleOpenState, version);
  }

  setOpen(open: StateValueOrUpdater<typeof collapsibleOpenState>): this {
    return $setState(this, collapsibleOpenState, open);
  }

  // Block-level inserts (and the markdown shortcut transforms) land in the
  // body instead of splitting the collapsible, and selection helpers treat
  // the body like a nested document.
  isShadowRoot(): true {
    return true;
  }

  // The host DOM is a styled stand-in for `<details>`: a summary row of
  // chrome (the toggle chevron plus the revealed `summary` slot container)
  // followed by a content element the children channel renders into (see
  // getDOMSlot). A real `<details>` element is deliberately not used —
  // native summary activation inside contentEditable is inconsistent
  // across browsers — so the chevron drives the model state and CSS hides
  // the content element when closed.
  createDOM(_config: EditorConfig, editor: LexicalEditor): HTMLElement {
    // $getDocument, not the global document: the editor's root may live in
    // a Shadow DOM or another realm (iframe).
    const doc = $getDocument();
    const dom = doc.createElement('div');
    dom.className = 'collapsible-container';
    if (this.isOpen()) {
      dom.setAttribute('data-open', 'true');
    }
    const row = doc.createElement('div');
    row.className = 'collapsible-summary-row';
    const toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.className = 'collapsible-toggle';
    // Chrome, not content: keep the caret out of the button.
    toggle.contentEditable = 'false';
    toggle.setAttribute('aria-label', 'Toggle collapsible section');
    // The listener's lifetime is the DOM's own; `void` marks the disposer
    // as intentionally discarded.
    void registerEventListener(toggle, 'click', event => {
      event.preventDefault();
      if (editor.isEditable()) {
        editor.update(() => {
          this.setOpen(open => !open);
        });
      } else if (dom.getAttribute('data-open') === 'true') {
        // Read-only: readers can still expand and collapse, but as VIEW
        // state — the attribute alone, never the document (the exported
        // Markdown must not change). The editable listener in `register`
        // resyncs the attribute from the NodeState when editing resumes.
        dom.removeAttribute('data-open');
      } else {
        dom.setAttribute('data-open', 'true');
      }
    });
    row.appendChild(toggle);
    dom.appendChild(row);
    const content = doc.createElement('div');
    content.className = 'collapsible-content';
    dom.appendChild(content);
    return dom;
  }

  updateDOM(prevNode: this, dom: HTMLElement): boolean {
    const change = $getStateChange(this, prevNode, collapsibleOpenState);
    if (change !== null) {
      if (change[0]) {
        dom.setAttribute('data-open', 'true');
      } else {
        dom.removeAttribute('data-open');
      }
    }
    return false;
  }

  // The linked-list children (the body blocks) render into the content
  // element rather than the host, so the summary row stays chrome. When the
  // reconciler asks about the summary slot's own subtree it passes the slot
  // container as `element`; the `:scope >` query misses there and falls back
  // to the default slot, which is exactly right.
  getDOMSlot(element: HTMLElement): ElementDOMSlot<HTMLElement> {
    const content = element.querySelector<HTMLElement>(
      ':scope > .collapsible-content',
    );
    const domSlot = super.getDOMSlot(element);
    return content !== null ? domSlot.withElement(content) : domSlot;
  }

  // HTML export mirrors the GFM encoding: a real `<details>`/`<summary>`.
  // Slots ride a separate Map, so the exporter never descends into them on
  // its own — emit the summary explicitly; the body children serialize
  // through the normal child path into this element. This shell is the
  // single source of truth for the Markdown encoding too, where the two
  // destinations diverge on the summary element:
  //
  // - Markdown (`$exportViaDOM`): a `data-lexical-slot` marker tells the
  //   exporter which slot embeds here; it swaps the wrapper's content (and
  //   the children position) for embedded Markdown and strips the marker.
  // - HTML clipboard: the serialized slot content itself — the import rule
  //   maps `<summary>` back by tag, so no internal marker leaks out.
  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const doc = $getDocument();
    const element = doc.createElement('details');
    if (this.isOpen()) {
      element.setAttribute('open', '');
    }
    const summary = $getSlot(this, 'summary');
    if ($isElementNode(summary)) {
      const summaryElement = doc.createElement('summary');
      if ($getRenderContextValue(RenderContextMarkdownExport, editor)) {
        summaryElement.setAttribute('data-lexical-slot', 'summary');
      } else {
        $appendNodeToHTML(editor, summary, summaryElement);
      }
      element.append(summaryElement);
    }
    return {element};
  }
}

export function $createCollapsibleNode(open: boolean = true): CollapsibleNode {
  // Single-line summary: the bare paragraph IS the slot value (the slot link
  // itself is the virtual shadow root, no container wrapper needed).
  return $setSlot($create(CollapsibleNode), 'summary', $createParagraphNode())
    .append($createParagraphNode())
    .setOpen(open);
}

export function $isCollapsibleNode(
  node: LexicalNode | null | undefined,
): node is CollapsibleNode {
  return node instanceof CollapsibleNode;
}

/* -------------------------------------------------------------------------- *
 * Import: one DOM rule serves Markdown (via MdastHtmlExtension) and HTML     *
 * paste alike                                                                *
 * -------------------------------------------------------------------------- */

/** Appends `nodes` to `target` flattened to inline content (a single-line
 * field): block elements contribute their children, block decorators and
 * line breaks are dropped. */
function $appendInline(target: ElementNode, nodes: LexicalNode[]): void {
  for (const node of nodes) {
    if ($isElementNode(node) && !node.isInline()) {
      $appendInline(target, node.getChildren());
    } else if (
      !$isLineBreakNode(node) &&
      !($isDecoratorNode(node) && !node.isInline())
    ) {
      target.append(node);
    }
  }
}

/** Wraps stray inline runs in paragraphs so the result is block-level,
 * dropping whitespace-only runs (formatting whitespace between the raw
 * HTML tags). */
function $wrapInlineInBlocks(nodes: LexicalNode[]): LexicalNode[] {
  const blocks: LexicalNode[] = [];
  let pending: LexicalNode[] = [];
  const flushPending = () => {
    const significant = pending.some(
      node => !($isTextNode(node) && node.getTextContent().trim() === ''),
    );
    if (significant) {
      blocks.push($createParagraphNode().splice(0, 0, pending));
    }
    pending = [];
  };
  for (const node of nodes) {
    if (($isElementNode(node) || $isDecoratorNode(node)) && !node.isInline()) {
      flushPending();
      blocks.push(node);
    } else {
      pending.push(node);
    }
  }
  flushPending();
  return blocks;
}

const DetailsImportRule = defineImportRule({
  $import: (ctx, el) => {
    const collapsible = $createCollapsibleNode(el.hasAttribute('open')).clear();
    const summary = $getSlot(collapsible, 'summary');
    const body: LexicalNode[] = [];
    for (const child of Array.from(el.childNodes)) {
      if (isHTMLElement(child) && child.tagName === 'SUMMARY') {
        if ($isElementNode(summary)) {
          $appendInline(summary, ctx.$importChildren(child));
        }
      } else {
        body.push(...ctx.$importOne(child));
      }
    }
    // Drop the seeded body paragraph if there's any body
    const blocks = $wrapInlineInBlocks(body);
    if (blocks.length > 0) {
      collapsible.splice(0, collapsible.getChildrenSize(), blocks);
    }
    return [collapsible];
  },
  match: sel.tag('details'),
  name: '@lexical/dev-mdast-editor-example/details',
});

/* -------------------------------------------------------------------------- *
 * The extension                                                              *
 * -------------------------------------------------------------------------- */

export const INSERT_COLLAPSIBLE_COMMAND: LexicalCommand<void> = createCommand(
  'INSERT_COLLAPSIBLE_COMMAND',
);

// Enter inside the summary slot is a core no-op (the slot value is a bare
// paragraph, a single-line field); map it to "open the section and move the
// caret to the body", mirroring how the playground's collapsible treats
// Enter in its title.
function $handleSummaryEnter(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return false;
  }
  const frame = $getSlotFrame(selection.anchor.getNode());
  if (frame === null) {
    return false;
  }
  const host = $getSlotHost(frame);
  if (!$isCollapsibleNode(host)) {
    return false;
  }
  host.setOpen(true);
  const firstBlock = host.getFirstChild();
  if ($isElementNode(firstBlock)) {
    firstBlock.selectStart();
  }
  return true;
}

/**
 * Wires {@link CollapsibleNode} into the Markdown pipeline using the GFM-style
 * `<details><summary>…</summary>…</details>` encoding, with Markdown syntax
 * inside the construct working in both directions (the summary line too, which
 * GitHub leaves raw). There is no details-specific Markdown importer or
 * serializer: {@link MdastHtmlExtension} routes raw HTML blocks (and the
 * Markdown text inside them) through the editor's DOM import rules, so the one
 * `<details>` rule here serves Markdown import and HTML paste alike, and
 * `$exportViaDOM` derives the Markdown encoding from the node's own `exportDOM`
 * shell — the summary phrasing and body blocks embed as ordinary Markdown
 * between the raw tags.
 *
 * The summary line is edited in the node's named `summary` slot, revealed
 * in-lexical with a `$getSlotTargetElement` render override (the Card
 * pattern from the playground — no React chrome).
 */
export const MdastCollapsibleExtension = defineExtension({
  dependencies: [
    MdastHtmlExtension,
    configExtension(DOMImportExtension, {
      rules: [DetailsImportRule],
    }),
    configExtension(DOMRenderExtension, {
      overrides: [
        domOverride([CollapsibleNode], {
          $getSlotTargetElement: (_node, _slotName, hostDom) =>
            hostDom.querySelector<HTMLElement>(
              ':scope > .collapsible-summary-row',
            ),
        }),
      ],
    }),
    configExtension(MdastExtension, {
      // Export is fully generic: $exportViaDOM renders CollapsibleNode's own
      // exportDOM shell and embeds the summary slot and body children as
      // Markdown — no construct-specific serialization at all.
      exportRules: [{$export: $exportViaDOM, type: CollapsibleNode}],
    }),
  ],
  name: '@lexical/dev-mdast-editor-example/MdastCollapsible',
  nodes: [CollapsibleNode],
  register: editor =>
    mergeRegister(
      // Read-only toggles are view-only (see the chevron listener), so the
      // data-open attributes may have diverged from the NodeState; resync
      // every collapsible when editing resumes.
      editor.registerEditableListener(editable => {
        if (!editable) {
          return;
        }
        editor.read(() => {
          for (const node of $nodesOfType(CollapsibleNode)) {
            const dom = editor.getElementByKey(node.getKey());
            if (dom === null) {
              continue;
            }
            if (node.isOpen()) {
              dom.setAttribute('data-open', 'true');
            } else {
              dom.removeAttribute('data-open');
            }
          }
        });
      }),
      editor.registerCommand(
        INSERT_COLLAPSIBLE_COMMAND,
        () => {
          if (!editor.isEditable()) {
            return false;
          }
          const collapsible = $createCollapsibleNode();
          $insertNodeToNearestRoot(collapsible);
          const summary = $getSlot(collapsible, 'summary');
          if ($isElementNode(summary)) {
            summary.selectStart();
          }
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      editor.registerCommand(
        INSERT_PARAGRAPH_COMMAND,
        $handleSummaryEnter,
        COMMAND_PRIORITY_BEFORE_EDITOR,
      ),
    ),
});
