/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {MdastBlockMatch} from './MdastStream';
import type {CompiledMdast} from './types';
import type {ElementNode, LexicalEditor, LexicalNode, TextNode} from 'lexical';

import {$createCodeNode, $isCodeNode} from '@lexical/code-core';
import {
  $createHorizontalRuleNode,
  HorizontalRuleNode,
} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
} from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteNode,
  $isQuoteNode,
  type QuoteNode,
} from '@lexical/rich-text';
import {
  $addUpdateTag,
  $createParagraphNode,
  $findMatchingParent,
  $getEditor,
  $getNodeByKey,
  $getSelection,
  $isBlockContainer,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setState,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_BEFORE_EDITOR,
  COMPOSITION_END_TAG,
  HISTORIC_TAG,
  HISTORY_PUSH_TAG,
  KEY_ENTER_COMMAND,
  mergeRegister,
} from 'lexical';

import {$append, $listTypeFromMdast} from './handlers';
import {MarkdownStreamScanner} from './MdastStream';
import {codeFenceState, codeMetaState, hrMarkerState} from './state';

/**
 * Block markers are at most a few characters (`'###### '`, `'   999. '`,
 * `'- [x] '`); when the caret is past this column a space cannot complete a
 * block marker, so the micromark scan is skipped entirely. A thematic break
 * is the one exception, see {@link THEMATIC_BREAK_LINE}.
 */
const MAX_BLOCK_MARKER_LENGTH = 24;

/**
 * A line that is only a thematic break: three or more of the same `-`, `*`
 * or `_`, with spaces or tabs between them allowed (CommonMark 4.1). A rule
 * has no length limit, so a space typed after a long one is still scanned
 * past {@link MAX_BLOCK_MARKER_LENGTH}, as Enter already does.
 */
const THEMATIC_BREAK_LINE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** Removes the first `n` characters from the leading text nodes of `element`. */
function $stripLeading(element: ElementNode, n: number): void {
  let remaining = n;
  let child = element.getFirstChild();
  while (remaining > 0 && child) {
    if (!$isTextNode(child)) {
      break;
    }
    const text = child.getTextContent();
    if (text.length <= remaining) {
      const next = child.getNextSibling();
      remaining -= text.length;
      child.remove();
      child = next;
    } else {
      child.setTextContent(text.slice(remaining));
      remaining = 0;
    }
  }
}

/**
 * Installs `block` in place of `container`, except for an inline-content quote
 * (see {@link $isShortcutQuote}) which keeps its identity and adopts the block
 * as a child instead.
 *
 * A QuoteNode may only hold block-level children once it has opted in to
 * shadow root behaviour, so adopting the block also sets that flag — leaving
 * it unset would produce a quote holding a block without the state that makes
 * it legal, which is not the tree {@link MdastShadowRootQuoteExtension}
 * imports for `> ## H2`.
 */
function $placeBlock(container: ElementNode, block: LexicalNode): void {
  if ($isQuoteNode(container)) {
    container.setIsShadowRoot(true).append(block);
  } else {
    container.replace(block);
  }
}

/**
 * Creates the quote for the `> ` shortcut with the registry's import
 * handlers, so a typed quote is the same kind as a loaded one. With
 * {@link MdastShadowRootQuoteExtension} that is a shadow root quote, which
 * holds paragraphs. A rule may give the empty quote an empty paragraph for
 * the caret (the mdast-editor example's alert rule does), so a shadow root
 * quote that holds only empty paragraphs is kept too. Falls back to a plain
 * QuoteNode when the import makes something else.
 */
function $createShortcutQuote(
  scanner: MarkdownStreamScanner,
  match: MdastBlockMatch & {kind: 'blockquote'},
): QuoteNode {
  const imported = scanner.importBlock(match.node);
  const quote = imported.length === 1 ? imported[0] : null;
  return $isQuoteNode(quote) &&
    (quote.isEmpty() ||
      (quote.isShadowRoot() &&
        quote
          .getChildren()
          .every(child => $isParagraphNode(child) && child.isEmpty())))
    ? quote
    : $createQuoteNode();
}

/**
 * Replaces `container` with a horizontal rule, and puts the caret in a new
 * empty paragraph under it: the new line that the typed space or Enter asks
 * for. The marker must be the whole line. `--- text` is a paragraph in
 * Markdown, so a space typed between `---` and text converts nothing.
 *
 * A rule converts only where Markdown can write one: at the top level or
 * inside a quote. A table cell, for example, has no Markdown for a rule (the
 * GFM table export writes one after the table), so `---` typed in a cell
 * stays text. Checking the ancestors this way, rather than for a table cell,
 * keeps `@lexical/table` out of editors that don't use tables.
 *
 * An editor can import `thematicBreak` as its own node, without
 * `HorizontalRuleExtension`. There the line stays text too, rather than
 * fail on a node the editor doesn't have.
 */
function $applyThematicBreak(
  container: ElementNode,
  markerLength: number,
): boolean {
  const line = container.getTextContent();
  if (
    !$getEditor().hasNode(HorizontalRuleNode) ||
    line.length !== markerLength ||
    !container.getChildren().every($isTextNode) ||
    $findMatchingParent(
      container.getParentOrThrow(),
      node => !$isQuoteNode(node),
    )
  ) {
    return false;
  }
  $stripLeading(container, markerLength);
  const rule = $createHorizontalRuleNode();
  // Keep the typed marker (`-`, `*` or `_`) so export writes the same rule.
  $setState(rule, hrMarkerState, line.trimStart()[0]);
  const next = $createParagraphNode();
  $placeBlock(container, rule);
  rule.insertAfter(next);
  next.select();
  return true;
}

/**
 * Replaces `paragraph` with the block construct described by `match`, keeping
 * the content that followed the marker. `paragraph` is the shortcut container:
 * a ParagraphNode, or an inline-content QuoteNode that adopts the new block
 * rather than being replaced by it.
 */
function $applyBlock(
  paragraph: ElementNode,
  match: MdastBlockMatch,
  scanner: MarkdownStreamScanner,
): boolean {
  if (match.kind === 'thematicBreak') {
    return $applyThematicBreak(paragraph, match.markerLength);
  }
  // Capture the fence before the marker is stripped from the paragraph.
  const fence =
    match.kind === 'code'
      ? paragraph.getTextContent().match(/^[ \t]*(`{3,}|~{3,})/)
      : null;
  $stripLeading(paragraph, match.markerLength);
  const remaining = paragraph.getChildren();

  if (match.kind === 'code') {
    const code = $createCodeNode(match.node.lang || undefined);
    // Keep the typed fence and info-string tail so export reproduces them.
    if (fence) {
      $setState(code, codeFenceState, fence[1]);
    }
    if (match.node.meta) {
      $setState(code, codeMetaState, match.node.meta);
    }
    $append(code, remaining);
    $placeBlock(paragraph, code);
    code.selectStart();
    return true;
  }

  let target: ElementNode;
  let selectInto: ElementNode;
  if (match.kind === 'heading') {
    const heading = $append(
      $createHeadingNode(`h${match.node.depth}`),
      remaining,
    );
    target = heading;
    selectInto = heading;
  } else if (match.kind === 'blockquote') {
    const quote = $createShortcutQuote(scanner, match);
    if (quote.isShadowRoot()) {
      // The typed text goes into the paragraph the import seeded, if any, so
      // the quote holds one line, as the import of `> a` gives.
      const [seeded, ...extra] = quote.getChildren();
      extra.forEach(node => node.remove());
      const line = $isParagraphNode(seeded) ? seeded : $createParagraphNode();
      $append(line, remaining);
      if (line !== seeded) {
        $append(quote, [line]);
      }
      selectInto = line;
    } else {
      $append(quote, remaining);
      selectInto = quote;
    }
    target = quote;
  } else {
    const listNode = match.node;
    const listType = $listTypeFromMdast(listNode);
    const start =
      listNode.ordered && listNode.start != null ? listNode.start : 1;
    const list = $createListNode(listType, start);
    const firstItem = listNode.children[0];
    const checked =
      firstItem &&
      firstItem.type === 'listItem' &&
      typeof firstItem.checked === 'boolean'
        ? firstItem.checked
        : undefined;
    const item = $append($createListItemNode(checked), remaining);
    $append(list, [item]);
    target = list;
    selectInto = item;
  }

  $placeBlock(paragraph, target);
  selectInto.selectStart();
  return true;
}

/**
 * Cheap check that `text` (up to the caret) could plausibly contain a closed
 * inline construct ending in `closeChar`, before paying for a micromark parse.
 * A closing `)` needs a `](` link infix; any other delimiter needs an earlier
 * occurrence of itself to act as the opener.
 */
function mayCloseInlineConstruct(text: string, closeChar: string): boolean {
  return closeChar === ')'
    ? text.lastIndexOf('](') > 0
    : text.lastIndexOf(closeChar, text.length - 2) !== -1;
}

/**
 * Materializes the inline construct ending at `anchorOffset` inside
 * `anchorNode`, replacing the raw markdown span with formatted Lexical nodes.
 */
function $applyInline(
  anchorNode: TextNode,
  anchorOffset: number,
  scanner: MarkdownStreamScanner,
): boolean {
  const upTo = anchorNode.getTextContent().slice(0, anchorOffset);
  const inlineNode = scanner.scanInline(upTo);
  if (!inlineNode || !inlineNode.position) {
    return false;
  }
  const start = inlineNode.position.start.offset ?? 0;
  const end = anchorOffset;

  let target: TextNode;
  if (start <= 0) {
    [target] = anchorNode.splitText(end);
  } else {
    const parts = anchorNode.splitText(start, end);
    target = parts.length === 3 ? parts[1] : parts[parts.length - 1];
  }

  const lexicalNodes = scanner.importInline(inlineNode);
  if (lexicalNodes.length === 0) {
    return false;
  }

  let prev: LexicalNode = lexicalNodes[0];
  target.replace(prev);
  for (let i = 1; i < lexicalNodes.length; i++) {
    prev.insertAfter(lexicalNodes[i]);
    prev = lexicalNodes[i];
  }

  if ($isTextNode(prev)) {
    const size = prev.getTextContentSize();
    prev.select(size, size);
  } else {
    prev.selectNext(0, 0);
  }
  return true;
}

/**
 * Matches a GFM task-list checkbox marker (`[ ] `, `[x] `) typed at line
 * start. Exactly one character is required between the brackets, matching
 * micromark's gfm-task-list-item grammar — `[]` is not a checkbox.
 */
const CHECKBOX_REGEX = /^\[([ xX])\]\s$/;

/**
 * Handles a checkbox marker typed at the start of a line. micromark only
 * recognizes a task-list item once it already has a list-item prefix, so by
 * the time the user types `[ ] ` the paragraph is usually already a bullet
 * list item (from the earlier `- ` shortcut). This promotes that item — or a
 * bare paragraph — to a Lexical check list.
 */
function $tryCheckbox(
  anchorNode: TextNode,
  parent: ElementNode,
  anchorOffset: number,
): boolean {
  if (parent.getFirstChild() !== anchorNode) {
    return false;
  }
  const prefix = parent.getTextContent().slice(0, anchorOffset);
  const match = prefix.match(CHECKBOX_REGEX);
  if (!match) {
    return false;
  }
  const checked = match[1].toLowerCase() === 'x';

  if ($isListItemNode(parent)) {
    const list = parent.getParent();
    if (!$isListNode(list) || list.getListType() === 'number') {
      return false;
    }
    $stripLeading(parent, match[0].length);
    list.setListType('check');
    parent.setChecked(checked);
    return true;
  }

  if ($isShortcutParagraph(parent, anchorNode)) {
    $stripLeading(parent, match[0].length);
    const remaining = parent.getChildren();
    const list = $createListNode('check');
    const item = $append($createListItemNode(checked), remaining);
    $append(list, [item]);
    parent.replace(list);
    item.selectStart();
    return true;
  }

  return false;
}

function $isShortcutParagraph(
  node: LexicalNode,
  anchorNode: TextNode,
): boolean {
  return (
    $isParagraphNode(node) &&
    $isBlockContainer(node.getParent()) &&
    node.getFirstChild() === anchorNode
  );
}

const ShortcutQuoteBrand: unique symbol = Symbol.for(
  '@lexical/mdast/ShortcutQuoteBrand',
);

/**
 * A blockquote imported by the default handler holds inline content directly,
 * so a block marker typed at its start has no enclosing paragraph to convert.
 * The marker still has to take effect, because import already produces the
 * nested shape: `> ## H2` imports as a QuoteNode holding a HeadingNode. Only
 * the leading text is eligible, so a quote that already starts with a block is
 * left alone. Shadow root quotes are excluded — they hold paragraphs, which
 * {@link $isShortcutParagraph} already accepts. See #7407.
 */
function $isShortcutQuote(
  node: LexicalNode,
  anchorNode: TextNode,
): node is QuoteNode & {[ShortcutQuoteBrand]: never} {
  return (
    $isQuoteNode(node) &&
    !node.isShadowRoot() &&
    $isBlockContainer(node.getParent()) &&
    node.getFirstChild() === anchorNode
  );
}

/** The element a block marker typed at `anchorNode` may convert. */
function $isShortcutContainer(
  node: LexicalNode,
  anchorNode: TextNode,
): boolean {
  return (
    $isShortcutParagraph(node, anchorNode) || $isShortcutQuote(node, anchorNode)
  );
}

/**
 * Registers streaming Markdown shortcuts on `editor` from the
 * {@link CompiledMdast} registry. As the user types, the current line/inline
 * buffer is fed back through micromark (the same parser as full-document
 * import) and recognized constructs are transformed in place:
 *
 * - Block markers (`# `, `> `, `- `, `1. `, `- [ ] `) convert the paragraph
 *   into the matching Lexical block as soon as the trailing space is typed.
 *   Typed at the start of a blockquote they nest the block inside the quote,
 *   matching what import produces for `> ## H2`.
 * - A marker-only line (`` ```lang ``, `## `, `- `) converts on
 *   <kbd>Enter</kbd>.
 * - A thematic break (`---`, `***`, `___`) alone on its line converts to a
 *   horizontal rule on space or <kbd>Enter</kbd>, with the caret in a new
 *   paragraph under it.
 * - Inline constructs (`*em*`, `**strong**`, `` `code` ``, `~~del~~`,
 *   `[text](url)`, plus registered `inlineShortcutTypes`) convert when their
 *   closing delimiter is typed.
 *
 * Wired up by {@link MdastShortcutsExtension}; this is an internal helper, not
 * part of the package's public API.
 */
export function registerMarkdownShortcuts(
  editor: LexicalEditor,
  compiled: CompiledMdast,
): () => void {
  const scanner = new MarkdownStreamScanner(compiled);
  const inlineTriggers = scanner.inlineTriggers;
  // Composition end fires per IME commit (every CJK syllable, dead-key
  // resolve, ...). Only enter the transformer pass when the just-committed
  // character can plausibly close a trigger.
  const compositionEndTriggers = new Set<string>([' ', ...inlineTriggers]);

  return mergeRegister(
    editor.registerUpdateListener(
      ({tags, dirtyLeaves, editorState, prevEditorState}) => {
        // Ignore updates from collaboration and undo/redo (changes already
        // calculated), and anything that dirtied no leaves (pure selection
        // moves) before paying for any editor-state reads.
        if (
          dirtyLeaves.size === 0 ||
          tags.has(COLLABORATION_TAG) ||
          tags.has(HISTORIC_TAG)
        ) {
          return;
        }
        // If the editor is still composing we must wait for the commit.
        if (editor.isComposing()) {
          return;
        }
        // A composition commit lands without moving the selection (and may
        // commit several characters at once), so it bypasses the typed-one-
        // character heuristics below.
        const isCompositionEnd = tags.has(COMPOSITION_END_TAG);

        const selection = editorState.read($getSelection);
        const prevSelection = prevEditorState.read($getSelection);
        if (
          !$isRangeSelection(selection) ||
          !$isRangeSelection(prevSelection) ||
          !selection.isCollapsed() ||
          (selection.is(prevSelection) && !isCompositionEnd)
        ) {
          return;
        }
        const anchorKey = selection.anchor.key;
        const anchorOffset = selection.anchor.offset;
        const anchorNode = editorState._nodeMap.get(anchorKey);
        if (!$isTextNode(anchorNode) || !dirtyLeaves.has(anchorKey)) {
          return;
        }
        // Only react to a single typed character: the caret must have
        // advanced exactly one position (or sit right after the first
        // character of a fresh node). This keeps paste, drag-drop, and
        // deletions — which can leave the caret after a delimiter — from
        // firing destructive transforms.
        if (
          !isCompositionEnd &&
          anchorOffset !== 1 &&
          !(
            prevSelection.anchor.key === anchorKey &&
            anchorOffset === prevSelection.anchor.offset + 1
          )
        ) {
          return;
        }
        const textContent = editorState.read(() => anchorNode.getTextContent());
        const typedChar = textContent[anchorOffset - 1];
        if (isCompositionEnd && !compositionEndTriggers.has(typedChar)) {
          return;
        }
        if (typedChar !== ' ' && !inlineTriggers.has(typedChar)) {
          return;
        }
        // Cheap prefilter: an inline construct needs an opener earlier in the
        // text; skip the micromark parse when there is none.
        if (
          typedChar !== ' ' &&
          !mayCloseInlineConstruct(
            textContent.slice(0, anchorOffset),
            typedChar,
          )
        ) {
          return;
        }

        editor.update(() => {
          const node = $getNodeByKey(anchorKey);
          if (!$isTextNode(node) || node.hasFormat('code')) {
            // Per CommonMark, code spans take precedence over any other
            // inline construct; never transform inside one.
            return;
          }
          const parent = node.getParent();
          if (parent === null || $isCodeNode(parent)) {
            return;
          }

          let transformed = false;
          if (typedChar === ' ') {
            if (
              scanner.supportsTaskListItems &&
              $tryCheckbox(node, parent, anchorOffset)
            ) {
              transformed = true;
            } else if ($isShortcutContainer(parent, node)) {
              // The marker must end exactly at the caret, so scanning the
              // prefix is sufficient (and cheaper than the whole line).
              const prefix = node.getTextContent().slice(0, anchorOffset);
              const match =
                anchorOffset <= MAX_BLOCK_MARKER_LENGTH ||
                THEMATIC_BREAK_LINE.test(prefix)
                  ? scanner.scanBlock(prefix)
                  : null;
              if (
                match &&
                match.kind !== 'code' &&
                match.markerLength === anchorOffset
              ) {
                transformed = $applyBlock(parent, match, scanner);
              }
            }
          } else {
            transformed = $applyInline(node, anchorOffset, scanner);
          }

          if (transformed) {
            $addUpdateTag(HISTORY_PUSH_TAG);
          }
        });
      },
    ),
    editor.registerCommand(
      KEY_ENTER_COMMAND,
      event => {
        if (event !== null && event.shiftKey) {
          return false;
        }
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }
        const anchorNode = selection.anchor.getNode();
        if (!$isTextNode(anchorNode) || anchorNode.hasFormat('code')) {
          return false;
        }
        const parent = anchorNode.getParent();
        const anchorOffset = selection.anchor.offset;
        if (
          parent === null ||
          $isCodeNode(parent) ||
          !$isShortcutContainer(parent, anchorNode) ||
          anchorOffset !== anchorNode.getTextContentSize()
        ) {
          return false;
        }
        const match = scanner.scanBlock(parent.getTextContent());
        // Only convert when the whole line is the marker (`## `, `- `, `---`,
        // '```lang title=x'). A line with content after the marker was either
        // already converted at the trailing space, or deliberately reverted
        // with undo — Enter must not re-convert it.
        if (
          match &&
          match.markerLength === anchorOffset &&
          $applyBlock(parent, match, scanner)
        ) {
          if (event !== null) {
            event.preventDefault();
          }
          return true;
        }
        return false;
      },
      // The lowest priority that still pre-empts the default rich-text Enter
      // handler: prepended to the editor-priority queue, so every listener at
      // LOW and above (and none of the defaults) runs first.
      COMMAND_PRIORITY_BEFORE_EDITOR,
    ),
  );
}
