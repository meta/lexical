/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ReadonlySignal} from '@lexical/extension';

import {
  ClipboardDOMImportExtension,
  GetClipboardDataExtension,
} from '@lexical/clipboard';
import {CodeShikiExtension} from '@lexical/code-shiki';
import {
  computed,
  EditorStateExtension,
  TabIndentationExtension,
  WatchEditableExtension,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {CheckListExtension, ListExtension} from '@lexical/list';
import {
  $convertSelectionToMarkdownString,
  $convertToMarkdownString,
  MdastCommonMarkExtension,
  MdastExtension,
  MdastGfmExtension,
  MdastShortcutsExtension,
} from '@lexical/mdast';
import {
  $createHeadingNode,
  $isQuoteNode,
  type HeadingTagType,
  RichTextExtension,
} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {TableExtension} from '@lexical/table';
import {mergeRegister} from '@lexical/utils';
import {
  $caretFromPoint,
  $createParagraphNode,
  $getCollapsedCaretRange,
  $getSelection,
  $getSiblingCaret,
  $isChildCaret,
  $isRangeSelection,
  $setSelectionFromCaretRange,
  COMMAND_PRIORITY_BEFORE_EDITOR,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  createCommand,
  defineExtension,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalCommand,
} from 'lexical';

import {HtmlTextFormatExtension} from './HtmlTextFormatExtension';
import {MdastAlertExtension} from './MdastAlertExtension';
import {
  $isCollapsibleNode,
  MdastCollapsibleExtension,
} from './MdastCollapsibleExtension';
import {MdastFootnoteExtension} from './MdastFootnoteExtension';
import {MdastKbdExtension} from './MdastKbdExtension';

/**
 * Reformats the current selection's blocks as a paragraph. Toolbars
 * and other UI should dispatch this command rather than calling
 * `$setBlocksType` directly so this extension is the single owner of
 * block-formatting behavior.
 */
export const FORMAT_PARAGRAPH_COMMAND: LexicalCommand<void> = createCommand(
  'FORMAT_PARAGRAPH_COMMAND',
);

/**
 * Reformats the current selection's blocks as the given heading.
 */
export const FORMAT_HEADING_COMMAND: LexicalCommand<HeadingTagType> =
  createCommand('FORMAT_HEADING_COMMAND');

export interface MdastEditorOutput {
  /**
   * A signal mirroring `editor.isEditable()`. The toolbar reads it to
   * disable everything that would change the document while the editor is
   * read-only — where the only allowed changes are to the selection. (The
   * Markdown source pane has its own, independent lock: either side can be
   * read-only while the other stays editable.)
   */
  isEditable: ReadonlySignal<boolean>;
  /** A signal observing the editor's contents as a Markdown string. */
  markdown: ReadonlySignal<string>;
}

/**
 * The Markdown wiring for this example. Compare with the legacy
 * `examples/markdown-editor` `MarkdownExtension`: because
 * `@lexical/mdast` ships extension-ready, there is no transformer list
 * to curate, no `registerMarkdownShortcuts` call, no checklist
 * text-match workaround (typing `[ ] ` / `[x] ` in a list item is
 * built in), and no newline-normalization configuration — the
 * CommonMark and GFM bundles bring their grammar and nodes, and
 * {@link MdastShortcutsExtension} drives the typing shortcuts from that
 * grammar. What's left here is example-specific plumbing: the editing
 * behavior extensions, the `markdown` preview signal, and the block
 * format commands the toolbar dispatches.
 */
export const MdastEditorExtension = defineExtension({
  build(editor, _config, state): MdastEditorOutput {
    const editorState = state.getDependency(EditorStateExtension).output;
    return {
      isEditable: state.getDependency(WatchEditableExtension).output,
      markdown: computed(() =>
        editorState.value.read(() => $convertToMarkdownString(), {editor}),
      ),
    };
  },
  dependencies: [
    // The grammar is granular: CommonMark and GFM are separate bundles,
    // MdastExtension holds import and export, and the typing shortcuts
    // follow whatever grammar is present.
    MdastCommonMarkExtension,
    MdastGfmExtension,
    MdastExtension,
    MdastShortcutsExtension,
    // Example custom construct: a collapsible section whose summary line is
    // edited in a named slot, encoded in Markdown as a GFM-style raw
    // `<details><summary>` block.
    MdastCollapsibleExtension,
    // The inline counterpart: keyboard keys as GitHub's `<kbd>` idiom.
    MdastKbdExtension,
    // Markdown-syntax-driven construct: GitHub alerts (`> [!NOTE]`) as
    // NodeState on the ordinary QuoteNode + a DOMRenderExtension override.
    MdastAlertExtension,
    // GFM footnotes: `[^label]` refs inline, definitions in a FootnotesNode
    // on a root slot, appended to the Markdown via a to-markdown root
    // handler.
    MdastFootnoteExtension,
    // Text formats Markdown can't express (underline, highlight, sub/sup,
    // inline color) round-trip as inline HTML.
    HtmlTextFormatExtension,
    // Shiki syntax highlighting for the code blocks (brings its own
    // CodeExtension / CodeIndentExtension dependencies).
    CodeShikiExtension,
    RichTextExtension,
    // Table editing. What a GFM table can't hold (blocks in a cell, merged
    // cells) is written as near as GFM allows.
    TableExtension,
    ListExtension,
    CheckListExtension,
    HistoryExtension,
    TabIndentationExtension,
    EditorStateExtension,
    WatchEditableExtension,
    // Route HTML paste through the same DOMImportExtension rules that
    // serve Markdown import (the default clipboard handler still uses the
    // legacy `$generateNodesFromDOM`), so pasted `<details>`, `<kbd>`, and
    // GitHub alert markup import through the example's rules too.
    ClipboardDOMImportExtension,
    // Copy operations also put the selection's Markdown serialization on
    // the clipboard as text/markdown, so Markdown-aware targets can take
    // the source form (footnote definitions included — the selection
    // export appends the ones its refs point at).
    configExtension(GetClipboardDataExtension, {
      $exportMimeType: {
        'text/markdown': [
          selection =>
            selection === null
              ? null
              : $convertSelectionToMarkdownString(selection),
        ],
      },
    }),
  ],
  name: '@lexical/dev-mdast-editor-example/MdastEditor',
  register(editor) {
    return mergeRegister(
      editor.registerCommand(
        FORMAT_PARAGRAPH_COMMAND,
        () => {
          const selection = $getSelection();
          if (editor.isEditable() && $isRangeSelection(selection)) {
            $setBlocksType(selection, () => $createParagraphNode());
          }
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      editor.registerCommand(
        FORMAT_HEADING_COMMAND,
        tag => {
          const selection = $getSelection();
          if (editor.isEditable() && $isRangeSelection(selection)) {
            $setBlocksType(selection, () => $createHeadingNode(tag));
          }
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      // Remove the empty paragraph and exit the node before creating a
      // new one if enter is pressed from an terminal empty paragraph
      // in a CollapsibleNode or QuoteNode
      editor.registerCommand(
        INSERT_PARAGRAPH_COMMAND,
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection) && selection.isCollapsed()) {
            const caret = $caretFromPoint(selection.focus, 'next');
            if (
              $isChildCaret(caret) &&
              caret.origin.isEmpty() &&
              caret.origin.isLastChild()
            ) {
              const parent = caret.origin.getParent();
              if ($isCollapsibleNode(parent) || $isQuoteNode(parent)) {
                caret.origin.remove();
                $setSelectionFromCaretRange(
                  $getCollapsedCaretRange($getSiblingCaret(parent, 'next')),
                );
              }
            }
          }
          return false;
        },
        COMMAND_PRIORITY_BEFORE_EDITOR,
      ),
    );
  },
});
