/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $distributeInlineWrapper,
  defineImportRule,
  DOMImportExtension,
  sel,
} from '@lexical/html';
import {
  type MdastExportHandler,
  MdastExtension,
  MdastHtmlExtension,
} from '@lexical/mdast';
import {$findMatchingParent} from '@lexical/utils';
import {
  $create,
  $createTextNode,
  $getDocument,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  createCommand,
  defineExtension,
  type DOMExportOutput,
  ElementNode,
  type LexicalCommand,
  type LexicalNode,
} from 'lexical';

/**
 * The second example custom construct: a keyboard key, GitHub's classic
 * inline-HTML idiom (`press <kbd>Ctrl</kbd>+<kbd>C</kbd>`). Where the
 * collapsible demonstrates the raw HTML *block* path, this node
 * demonstrates the *inline* path: a `<kbd>` run inside a paragraph maps to
 * an inline ElementNode, and Markdown between the raw tags
 * (`<kbd>**Ctrl**</kbd>`) still parses because micromark tokenizes
 * phrasing-level HTML tag by tag. See `MdastKbdExtension` for the wiring.
 */
export class KbdNode extends ElementNode {
  $config() {
    return this.config('kbd', {extends: ElementNode});
  }

  isInline(): true {
    return true;
  }

  // An empty keycap has no width to click into; let normal editing
  // remove the node once its last character is deleted.
  canBeEmpty(): false {
    return false;
  }

  createDOM(): HTMLElement {
    // $getDocument, not the global document: the editor's root may live in
    // a Shadow DOM or another realm (iframe).
    const dom = $getDocument().createElement('kbd');
    dom.className = 'kbd-key';
    return dom;
  }

  updateDOM(): boolean {
    return false;
  }

  // The clipboard/Markdown encoding is the bare tag; the keycap look is
  // the editor theme's, not the document's.
  exportDOM(): DOMExportOutput {
    return {element: $getDocument().createElement('kbd')};
  }
}

export function $createKbdNode(): KbdNode {
  return $create(KbdNode);
}

export function $isKbdNode(
  node: LexicalNode | null | undefined,
): node is KbdNode {
  return node instanceof KbdNode;
}

/* -------------------------------------------------------------------------- *
 * Import: one DOM rule serves Markdown (via MdastHtmlExtension) and HTML     *
 * paste alike                                                                *
 * -------------------------------------------------------------------------- */

const KbdImportRule = defineImportRule({
  $import: (ctx, el) => {
    if (!el.textContent && el.children.length === 0) {
      return [];
    }
    // The <a> pattern: wrap the imported inline run, lifting any block
    // descendants (pasted soup) to siblings instead of nesting them.
    return $distributeInlineWrapper(ctx.$importChildren(el), $createKbdNode);
  },
  match: sel.tag('kbd'),
  name: '@lexical/dev-mdast-editor-example/kbd',
});

/* -------------------------------------------------------------------------- *
 * Export: the inline counterpart of $exportViaDOM — the children serialize  *
 * as ordinary Markdown phrasing between the raw tags                        *
 * -------------------------------------------------------------------------- */

const $exportKbd: MdastExportHandler<KbdNode> = (node, ctx) => [
  {type: 'html', value: '<kbd>'},
  ...ctx.exportInline(node),
  {type: 'html', value: '</kbd>'},
];

/* -------------------------------------------------------------------------- *
 * The extension                                                              *
 * -------------------------------------------------------------------------- */

/**
 * Toggles a keyboard key at the selection: wraps the selected text in a
 * {@link KbdNode} (a placeholder key when the selection is collapsed), or
 * unwraps the key the caret is inside.
 */
export const FORMAT_KBD_COMMAND: LexicalCommand<void> =
  createCommand('FORMAT_KBD_COMMAND');

/**
 * Wires {@link KbdNode} into the Markdown pipeline as GitHub's
 * `<kbd>Ctrl</kbd>` inline-HTML idiom. Like the collapsible there is no
 * kbd-specific Markdown importer — the one DOM rule serves Markdown import
 * and HTML paste — but the export side differs by level: block constructs
 * derive their encoding from `exportDOM` via `$exportViaDOM`, while an
 * inline construct is a phrasing sequence, so the export rule emits the
 * raw open/close tags around the children serialized as ordinary Markdown
 * (`<kbd>**Ctrl**</kbd>` round-trips with the bold intact).
 */
export const MdastKbdExtension = defineExtension({
  dependencies: [
    MdastHtmlExtension,
    configExtension(DOMImportExtension, {
      rules: [KbdImportRule],
    }),
    configExtension(MdastExtension, {
      exportRules: [{$export: $exportKbd, type: KbdNode}],
    }),
  ],
  name: '@lexical/dev-mdast-editor-example/MdastKbd',
  nodes: [KbdNode],
  register: editor =>
    editor.registerCommand(
      FORMAT_KBD_COMMAND,
      () => {
        const selection = $getSelection();
        if (!editor.isEditable() || !$isRangeSelection(selection)) {
          return false;
        }
        const kbd = $findMatchingParent(selection.anchor.getNode(), $isKbdNode);
        if (kbd !== null) {
          // Toggle off: replace the key with its content.
          for (const child of kbd.getChildren()) {
            kbd.insertBefore(child);
          }
          kbd.remove();
          return true;
        }
        const text = selection.getTextContent();
        selection.insertNodes([
          $createKbdNode().append($createTextNode(text === '' ? 'Key' : text)),
        ]);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});
