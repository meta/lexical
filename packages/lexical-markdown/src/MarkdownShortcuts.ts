/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$isCodeNode} from '@lexical/code-core';
import invariant from '@lexical/internal/invariant';
import {
  $addUpdateTag,
  $createRangeSelection,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $isTextNode,
  $setSelection,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_LOW,
  COMPOSITION_END_TAG,
  type ElementNode,
  HISTORIC_TAG,
  HISTORY_PUSH_TAG,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  type PointType,
  TEXT_TYPE_TO_FORMAT,
  type TextNode,
} from 'lexical';

import {canContainTransformableMarkdown} from './importTextTransformers';
import {
  type ElementTransformer,
  type MultilineElementTransformer,
  type TextFormatTransformer,
  type TextMatchTransformer,
  type Transformer,
  TRANSFORMERS,
} from './MarkdownTransformers';
import {indexBy, PUNCTUATION_OR_SPACE, transformersByType} from './utils';

function runElementTransformers(
  parentNode: ElementNode,
  anchorNode: TextNode,
  anchorOffset: number,
  elementTransformers: readonly ElementTransformer[],
  triggerOnEnter?: boolean,
): boolean {
  const grandParentNode = parentNode.getParent();

  if (
    !$isRootOrShadowRoot(grandParentNode) ||
    parentNode.getFirstChild() !== anchorNode
  ) {
    return false;
  }

  const textContent = anchorNode.getTextContent();

  // Checking for anchorOffset position to prevent any checks for cases when caret is too far
  // from a line start to be a part of block-level markdown trigger.
  //
  // TODO:
  // Can have a quick check if caret is close enough to the beginning of the string (e.g. offset less than 10-20)
  // since otherwise it won't be a markdown shortcut, but tables are exception
  if (!triggerOnEnter) {
    if (textContent[anchorOffset - 1] !== ' ') {
      return false;
    }
  }

  for (const {regExp, replace} of elementTransformers) {
    const match = textContent.match(regExp);

    const expectedMatchLength =
      triggerOnEnter || (match && match[0].endsWith(' '))
        ? anchorOffset
        : anchorOffset - 1;

    if (match && match[0].length === expectedMatchLength) {
      const nextSiblings = anchorNode.getNextSiblings();
      const [leadingNode, remainderNode] = anchorNode.splitText(anchorOffset);
      const siblings = remainderNode
        ? [remainderNode, ...nextSiblings]
        : nextSiblings;
      if (replace(parentNode, siblings, match, false) !== false) {
        leadingNode.remove();
        return true;
      }
    }
  }

  return false;
}

function runMultilineElementTransformers(
  parentNode: ElementNode,
  anchorNode: TextNode,
  anchorOffset: number,
  elementTransformers: readonly MultilineElementTransformer[],
  triggerOnEnter?: boolean,
): boolean {
  const grandParentNode = parentNode.getParent();

  if (
    !$isRootOrShadowRoot(grandParentNode) ||
    parentNode.getFirstChild() !== anchorNode
  ) {
    return false;
  }

  const textContent = anchorNode.getTextContent();

  if (!triggerOnEnter) {
    // Checking for anchorOffset position to prevent any checks for cases when caret is too far
    // from a line start to be a part of block-level markdown trigger.
    //
    // TODO:
    // Can have a quick check if caret is close enough to the beginning of the string (e.g. offset less than 10-20)
    // since otherwise it won't be a markdown shortcut, but tables are exception
    if (textContent[anchorOffset - 1] !== ' ') {
      return false;
    }
  }

  for (const {regExpStart, replace, regExpEnd} of elementTransformers) {
    if (
      (regExpEnd && !('optional' in regExpEnd)) ||
      (regExpEnd && 'optional' in regExpEnd && !regExpEnd.optional)
    ) {
      continue;
    }

    const match = textContent.match(regExpStart);

    if (match) {
      const matchLength =
        triggerOnEnter || match[0].endsWith(' ')
          ? anchorOffset
          : anchorOffset - 1;

      if (match[0].length !== matchLength) {
        continue;
      }

      const nextSiblings = anchorNode.getNextSiblings();
      const [leadingNode, remainderNode] = anchorNode.splitText(anchorOffset);
      const siblings = remainderNode
        ? [remainderNode, ...nextSiblings]
        : nextSiblings;

      if (replace(parentNode, siblings, match, null, null, false) !== false) {
        leadingNode.remove();
        return true;
      }
    }
  }

  return false;
}

function runTextMatchTransformers(
  anchorNode: TextNode,
  anchorOffset: number,
  transformersByTrigger: Readonly<Record<string, TextMatchTransformer[]>>,
): boolean {
  let textContent = anchorNode.getTextContent();
  const lastChar = textContent[anchorOffset - 1];
  const transformers = transformersByTrigger[lastChar];

  if (transformers == null) {
    return false;
  }

  // If typing in the middle of content, remove the tail to do
  // reg exp match up to a string end (caret position)
  if (anchorOffset < textContent.length) {
    textContent = textContent.slice(0, anchorOffset);
  }

  for (const transformer of transformers) {
    if (!transformer.replace || !transformer.regExp) {
      continue;
    }
    const match = textContent.match(transformer.regExp);

    if (match === null) {
      continue;
    }

    const startIndex = match.index || 0;
    const endIndex = startIndex + match[0].length;
    let replaceNode;

    if (startIndex === 0) {
      [replaceNode] = anchorNode.splitText(endIndex);
    } else {
      [, replaceNode] = anchorNode.splitText(startIndex, endIndex);
    }

    replaceNode.selectNext(0, 0);
    transformer.replace(replaceNode, match);
    return true;
  }

  return false;
}

function $runTextFormatTransformers(
  anchorNode: TextNode,
  anchorOffset: number,
  textFormatTransformers: Readonly<
    Record<string, readonly TextFormatTransformer[]>
  >,
): boolean {
  const textContent = anchorNode.getTextContent();
  const closeTagEndIndex = anchorOffset - 1;
  const closeChar = textContent[closeTagEndIndex];
  // Quick check if we're possibly at the end of inline markdown style
  const matchers = textFormatTransformers[closeChar];

  if (!matchers) {
    return false;
  }

  for (const matcher of matchers) {
    const {tag} = matcher;
    const tagLength = tag.length;
    const closeTagStartIndex = closeTagEndIndex - tagLength + 1;

    // If tag is not single char check if rest of it matches with text content
    if (tagLength > 1) {
      if (
        !isEqualSubString(textContent, closeTagStartIndex, tag, 0, tagLength)
      ) {
        continue;
      }
    }

    // Space before closing tag cancels inline markdown
    if (textContent[closeTagStartIndex - 1] === ' ') {
      continue;
    }

    // Some tags can not be used within words, hence should have newline/space/punctuation after it
    const afterCloseTagChar = textContent[closeTagEndIndex + 1];

    if (
      matcher.intraword === false &&
      afterCloseTagChar &&
      !PUNCTUATION_OR_SPACE.test(afterCloseTagChar)
    ) {
      continue;
    }

    const closeNode = anchorNode;
    let openNode = closeNode;
    let openTagStartIndex = getOpenTagStartIndex(
      textContent,
      closeTagStartIndex,
      tag,
    );

    // Go through text node siblings and search for opening tag
    // if haven't found it within the same text node as closing tag
    let sibling: LexicalNode | null = openNode;

    while (openTagStartIndex < 0 && (sibling = sibling.getPreviousSibling())) {
      if ($isLineBreakNode(sibling)) {
        break;
      }

      if ($isTextNode(sibling)) {
        if (sibling.hasFormat('code')) {
          continue;
        }
        const siblingTextContent = sibling.getTextContent();
        openNode = sibling;
        openTagStartIndex = getOpenTagStartIndex(
          siblingTextContent,
          siblingTextContent.length,
          tag,
        );
      }
    }

    // Opening tag is not found
    if (openTagStartIndex < 0) {
      continue;
    }

    // No content between opening and closing tag
    if (
      openNode === closeNode &&
      openTagStartIndex + tagLength === closeTagStartIndex
    ) {
      continue;
    }

    // Checking longer tags for repeating chars (e.g. *** vs **)
    const prevOpenNodeText = openNode.getTextContent();

    if (
      openTagStartIndex > 0 &&
      prevOpenNodeText[openTagStartIndex - 1] === closeChar
    ) {
      continue;
    }

    // Some tags can not be used within words, hence should have newline/space/punctuation before it
    const beforeOpenTagChar = prevOpenNodeText[openTagStartIndex - 1];

    if (
      matcher.intraword === false &&
      beforeOpenTagChar &&
      !PUNCTUATION_OR_SPACE.test(beforeOpenTagChar)
    ) {
      continue;
    }

    // Per CommonMark, code spans take precedence over other inline formatting
    if (
      !matcher.format.includes('code') &&
      $isInsideUnclosedCodeSpan(openNode, openTagStartIndex)
    ) {
      continue;
    }

    // Clean text from opening and closing tags (starting from closing tag
    // to prevent any offset shifts if we start from opening one)
    const prevCloseNodeText = closeNode.getTextContent();
    const closeNodeText =
      prevCloseNodeText.slice(0, closeTagStartIndex) +
      prevCloseNodeText.slice(closeTagEndIndex + 1);
    closeNode.setTextContent(closeNodeText);
    const openNodeText =
      openNode === closeNode ? closeNodeText : prevOpenNodeText;
    openNode.setTextContent(
      openNodeText.slice(0, openTagStartIndex) +
        openNodeText.slice(openTagStartIndex + tagLength),
    );
    const selection = $getSelection();
    const nextSelection = $createRangeSelection();
    $setSelection(nextSelection);
    // Adjust offset based on deleted chars
    const newOffset =
      closeTagEndIndex - tagLength * (openNode === closeNode ? 2 : 1) + 1;
    nextSelection.anchor.set(openNode.__key, openTagStartIndex, 'text');
    nextSelection.focus.set(closeNode.__key, newOffset, 'text');

    // Apply formatting to selected text
    for (const format of matcher.format) {
      nextSelection.formatText(format, TEXT_TYPE_TO_FORMAT[format]);
    }

    // Collapse selection up to the focus point
    nextSelection.anchor.set(
      nextSelection.focus.key,
      nextSelection.focus.offset,
      nextSelection.focus.type,
    );

    // Remove formatting from collapsed selection
    for (const format of matcher.format) {
      if (nextSelection.hasFormat(format)) {
        nextSelection.toggleFormat(format);
      }
    }

    if ($isRangeSelection(selection)) {
      nextSelection.format = selection.format;
    }

    return true;
  }

  return false;
}

// Per CommonMark spec, code spans take precedence over other inline
// formatting. Returns true if there is an unclosed backtick (code span
// opener) in the text preceding the given offset, which means the offset
// is inside a code span that hasn't been closed yet.
function $isInsideUnclosedCodeSpan(node: TextNode, offset: number): boolean {
  let backtickCount = 0;

  const text = node.getTextContent();
  for (let i = 0; i < offset; i++) {
    if (text[i] === '`') {
      backtickCount++;
    }
  }

  return backtickCount % 2 !== 0;
}

function getOpenTagStartIndex(
  string: string,
  maxIndex: number,
  tag: string,
): number {
  const tagLength = tag.length;

  for (let i = maxIndex; i >= tagLength; i--) {
    const startIndex = i - tagLength;

    if (
      isEqualSubString(string, startIndex, tag, 0, tagLength) && // Space after opening tag cancels transformation
      string[startIndex + tagLength] !== ' '
    ) {
      return startIndex;
    }
  }

  return -1;
}

/**
 * Text coordinate of a point, measured in characters from the start of its
 * parent element rather than from the start of its own node.
 *
 * The "did the user type exactly one character?" heuristic compares the anchor
 * offset before and after an update, but node transforms (hashtags, autolinks,
 * ...) can split or merge the leaves around the caret within that same update.
 * The anchor then lands in a different node and the two raw offsets are no
 * longer comparable, so a single typed character can look like a large jump and
 * the shortcut is skipped (#5366). Rebasing both offsets on the parent element
 * keeps them comparable; when the leaves around the caret are unchanged this is
 * the previous offset plus a constant on both sides, so the comparison is
 * unaffected.
 */
function $getOffsetInParent(point: PointType): number {
  const node = point.getNode();

  // A text point's offset is already a character count within its own node. An
  // element point's is a child index, so the characters it stands after are
  // those of the children before it.
  let offset = 0;

  if ($isTextNode(node)) {
    offset = point.offset;
  } else if ($isElementNode(node)) {
    for (const child of node.getChildren().slice(0, point.offset)) {
      offset += child.getTextContentSize();
    }
  }

  for (
    let sibling = node.getPreviousSibling();
    sibling !== null;
    sibling = sibling.getPreviousSibling()
  ) {
    offset += sibling.getTextContentSize();
  }

  return offset;
}

function isEqualSubString(
  stringA: string,
  aStart: number,
  stringB: string,
  bStart: number,
  length: number,
): boolean {
  for (let i = 0; i < length; i++) {
    if (stringA[aStart + i] !== stringB[bStart + i]) {
      return false;
    }
  }

  return true;
}

export function registerMarkdownShortcuts(
  editor: LexicalEditor,
  transformers: Transformer[] = TRANSFORMERS,
): () => void {
  const byType = transformersByType(transformers);
  const elementTransformersForEnter = byType.element.filter(
    t => t.triggerOnEnter,
  );
  const textFormatTransformersByTrigger = indexBy(
    byType.textFormat,
    ({tag}) => tag[tag.length - 1],
  );
  const textMatchTransformersByTrigger = indexBy(
    byType.textMatch,
    ({trigger}) => trigger,
  );
  // Composition end fires per IME commit (every CJK syllable, German dead-key
  // resolve, etc.). Most of those have nothing to do with markdown, so only
  // enter the transformer pass when the just-committed character can plausibly
  // close a trigger. Space covers element/multilineElement triggers (`# `,
  // `- `, ...) and text-match triggers carry their own single-character triggers.
  const compositionEndTriggerChars = new Set<string>([' ']);
  for (const t of byType.textFormat) {
    compositionEndTriggerChars.add(t.tag.slice(-1));
  }
  for (const t of byType.textMatch) {
    if (t.trigger !== undefined) {
      compositionEndTriggerChars.add(t.trigger);
    }
  }

  for (const transformer of transformers) {
    const type = transformer.type;
    if (
      type === 'element' ||
      type === 'text-match' ||
      type === 'multiline-element'
    ) {
      const dependencies = transformer.dependencies;
      for (const node of dependencies) {
        if (!editor.hasNode(node)) {
          invariant(
            false,
            'MarkdownShortcuts: missing dependency %s for transformer. Ensure node dependency is included in editor initial config.',
            node.getType(),
          );
        }
      }
    }
  }

  const $transform = (
    parentNode: ElementNode,
    anchorNode: TextNode,
    anchorOffset: number,
  ): boolean => {
    if (
      runElementTransformers(
        parentNode,
        anchorNode,
        anchorOffset,
        byType.element,
      )
    ) {
      return true;
    }

    if (
      runMultilineElementTransformers(
        parentNode,
        anchorNode,
        anchorOffset,
        byType.multilineElement,
      )
    ) {
      return true;
    }

    if (
      runTextMatchTransformers(
        anchorNode,
        anchorOffset,
        textMatchTransformersByTrigger,
      )
    ) {
      return true;
    }

    if (
      $runTextFormatTransformers(
        anchorNode,
        anchorOffset,
        textFormatTransformersByTrigger,
      )
    ) {
      return true;
    }

    return false;
  };

  return mergeRegister(
    editor.registerUpdateListener(
      ({tags, dirtyLeaves, editorState, prevEditorState}) => {
        // Ignore updates from collaboration and undo/redo (as changes already calculated)
        if (tags.has(COLLABORATION_TAG) || tags.has(HISTORIC_TAG)) {
          return;
        }

        // If editor is still composing (i.e. backticks) we must wait before the user confirms the key
        if (editor.isComposing()) {
          return;
        }

        // composition end commits the composed text without moving the
        // selection (compositionupdate already did) and may jump the anchor by
        // more than one when multi-character commits land at once. Skip the
        // typed-character heuristics so a trailing trigger character can still
        // fire its transform.
        const isCompositionEnd = tags.has(COMPOSITION_END_TAG);

        const selection = editorState.read($getSelection);
        const prevSelection = prevEditorState.read($getSelection);

        // We expect selection to be a collapsed range and not match previous one (as we want
        // to trigger transforms only as user types)
        if (
          !$isRangeSelection(prevSelection) ||
          !$isRangeSelection(selection) ||
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

        if (
          !isCompositionEnd &&
          anchorOffset !== 1 &&
          editorState.read(() => $getOffsetInParent(selection.anchor)) >
            prevEditorState.read(() =>
              $getOffsetInParent(prevSelection.anchor),
            ) +
              1
        ) {
          return;
        }

        if (isCompositionEnd) {
          const closeChar = editorState.read(() => anchorNode.getTextContent())[
            anchorOffset - 1
          ];
          if (!compositionEndTriggerChars.has(closeChar)) {
            return;
          }
        }

        editor.update(() => {
          if (!canContainTransformableMarkdown(anchorNode)) {
            return;
          }

          const parentNode = anchorNode.getParent();

          if (parentNode === null || $isCodeNode(parentNode)) {
            return;
          }

          if ($transform(parentNode, anchorNode, selection.anchor.offset)) {
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

        const anchorOffset = selection.anchor.offset;
        const anchorNode = selection.anchor.getNode();

        if (
          !$isTextNode(anchorNode) ||
          !canContainTransformableMarkdown(anchorNode)
        ) {
          return false;
        }

        const parentNode = anchorNode.getParent();

        if (parentNode === null || $isCodeNode(parentNode)) {
          return false;
        }

        const textContent = anchorNode.getTextContent();

        if (anchorOffset !== textContent.length) {
          return false;
        }

        if (
          runMultilineElementTransformers(
            parentNode,
            anchorNode,
            anchorOffset,
            byType.multilineElement,
            true,
          ) ||
          runElementTransformers(
            parentNode,
            anchorNode,
            anchorOffset,
            elementTransformersForEnter,
            true,
          )
        ) {
          if (event !== null) {
            event.preventDefault();
          }
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_LOW,
    ),
  );
}
