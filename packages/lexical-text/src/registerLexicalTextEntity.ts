/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {
  $createTextNode,
  $isTextNode,
  type EditorState,
  INTERNAL_$recordTextMove,
  INTERNAL_$recordTextRetype,
  INTERNAL_getActiveEditorState,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  TextNode,
} from 'lexical';

export type EntityMatch = {end: number; start: number};

// How many matches in a text node are passed over to check the node after it,
// where its transform returns before the loop that checks that node.
const MAX_MATCHES_PASSED = 8;

// How many times one update turns the same token or segmented entity back into
// text before it leaves it as an entity.
const MAX_TURNED_INTO_TEXT = 2;

/**
 * Returns a tuple that can be rested (...) into mergeRegister to clean up
 * node transforms listeners that transforms text into another node, eg. a HashtagNode.
 * @example
 * ```ts
 *   useEffect(() => {
    return mergeRegister(
      ...registerLexicalTextEntity(editor, getMatch, targetNode, createNode),
    );
  }, [createNode, editor, getMatch, targetNode]);
 * ```
 * Where targetNode is the type of node containing the text you want to transform (like a text input),
 * then getMatch uses a regex to find a matching text and creates the proper node to include the matching text.
 * @param editor - The lexical editor.
 * @param getMatch - Finds a matching string that satisfies a regex expression.
 * @param targetNode - The node type that contains text to match with. eg. HashtagNode
 * @param createNode - A function that creates a new node to contain the matched text. eg createHashtagNode
 * @returns An array containing the plain text and reverse node transform listeners.
 */
export function registerLexicalTextEntity<T extends TextNode>(
  editor: LexicalEditor,
  getMatch: (text: string) => null | EntityMatch,
  targetNode: Klass<T>,
  createNode: (textNode: TextNode) => T,
): (() => void)[] {
  const isTargetNode = (node: LexicalNode | null | undefined): node is T => {
    return node instanceof targetNode;
  };

  const $replaceWithSimpleText = (node: TextNode): void => {
    const textNode = $createTextNode(node.getTextContent())
      .setFormat(node.getFormat())
      .setStyle(node.getStyle())
      .setDetail(node.getDetail());
    node.replace(textNode);
    // The same characters in a plain text node (for collaboration).
    INTERNAL_$recordTextRetype(node, textNode);
  };

  // The keys of the text nodes the entity transform marked dirty, by pending
  // editor state (one update, or the updates batched into one commit).
  const markedInUpdate = new WeakMap<EditorState, Set<NodeKey>>();

  // How many times each token or segmented entity was turned back into text,
  // by pending editor state (one update, or the updates batched into one
  // commit) and its parent, offset and text.
  const turnedIntoTextInUpdate = new WeakMap<
    EditorState,
    Map<string, number>
  >();

  // Whether a token or segmented entity with the same parent, offset and text
  // as `entity` was turned back into text as many times as it may be in one
  // update; counts this time if not.
  const $wasTurnedIntoText = (entity: TextNode): boolean => {
    let offset = 0;
    for (
      let node = entity.getPreviousSibling();
      node !== null;
      node = node.getPreviousSibling()
    ) {
      offset += node.getTextContentSize();
    }
    const parent = entity.getParent();
    const id = `${parent === null ? '' : parent.getKey()}:${offset}:${entity.getTextContent()}`;
    const updateState =
      INTERNAL_getActiveEditorState() || editor.getEditorState();
    let turned = turnedIntoTextInUpdate.get(updateState);
    if (turned === undefined) {
      turned = new Map();
      turnedIntoTextInUpdate.set(updateState, turned);
    }
    const count = turned.get(id) || 0;
    if (count >= MAX_TURNED_INTO_TEXT) {
      return true;
    }
    turned.set(id, count + 1);
    return false;
  };

  const getMode = (node: TextNode): number => {
    return node.getLatest().__mode;
  };

  // Whether the first match of `textAfter` after `text` starts where
  // `textAfter` does, passing over the matches of `text` as the loop below
  // does (it leaves those as text when the transform returns before it), and
  // telling a match that ends where `textAfter` starts (which touches it) from
  // one that starts there. Null when `text` has more matches than are worth
  // passing over.
  const getFirstMatchAfter = (
    text: string,
    textAfter: string,
  ): boolean | null => {
    const combinedText = text + textAfter;
    let offset = 0;
    for (let i = 0; i < MAX_MATCHES_PASSED; i++) {
      const match = getMatch(combinedText.slice(offset));
      if (match === null) {
        return false;
      }
      const start = offset + match.start;
      const end = offset + match.end;
      if (end <= start) {
        return null;
      }
      if (end >= text.length) {
        return start === text.length;
      }
      offset = end;
    }
    return null;
  };

  // Whether the node after `node` is a text entity (an entity right after
  // another is handled by the entity's own transform).
  const isNextTextEntity = (node: TextNode): boolean => {
    const after = node.getNextSibling();
    return $isTextNode(after) && after.isTextEntity();
  };

  // Whether a text node after `entity` is not text it was split from: one in
  // another format, style or detail, or not simple text.
  const isTextAfterOutsideSource = (entity: TextNode): boolean => {
    const after = entity.getNextSibling();
    return (
      $isTextNode(after) &&
      !(
        after.isSimpleText() &&
        !isTargetNode(after) &&
        after.getFormat() === entity.getFormat() &&
        after.getStyle() === entity.getStyle() &&
        after.getDetail() === entity.getDetail()
      )
    );
  };

  // Whether `entity`, right after a simple text node with `textBefore`, is an
  // entity the transforms keep: the first match from `textBefore` on starts
  // where it does, with the text after it in its source node (the simple text
  // node after it in the same format, style and detail, which it was split
  // from), as the check that made it an entity found it; and that match still
  // holds with the text of any other text node after it, as the check that
  // keeps a match at the end of a node from becoming an entity found it. When
  // `textBefore` has too many matches to tell, `ifUnsure` is returned.
  const isEntityAfter = (
    textBefore: string,
    entity: TextNode,
    ifUnsure: boolean,
  ): boolean => {
    const holds = (result: boolean | null) =>
      result === null ? ifUnsure : result;
    const entityText = entity.getTextContent();
    const after = entity.getNextSibling();
    if (!$isTextNode(after)) {
      return holds(getFirstMatchAfter(textBefore, entityText));
    }
    const isSuffix = !isTextAfterOutsideSource(entity);
    const withAfter = getFirstMatchAfter(
      textBefore,
      entityText + after.getTextContent(),
    );
    if (isSuffix) {
      return holds(withAfter);
    }
    return (
      holds(withAfter) && holds(getFirstMatchAfter(textBefore, entityText))
    );
  };

  // Checks the entity after a simple text node whose transform returned
  // before its loop, which checks that node: it is turned back into text
  // unless the first match from this node's text on, with the text after the
  // entity, starts where the entity does, as it must for a match at the start
  // of a node to be made an entity.
  const $checkNextSibling = (node: TextNode, text: string) => {
    const nextSibling = node.getNextSibling();
    if (isTargetNode(nextSibling)) {
      const entityText = nextSibling.getTextContent();
      const entityMatch = getMatch(entityText);
      if (
        // Leave an entity that its own transform is still splitting or
        // turning back into text to that transform.
        entityMatch === null ||
        entityMatch.start !== 0 ||
        entityMatch.end !== entityText.length
      ) {
        return;
      }
      if (!isEntityAfter(text, nextSibling, true)) {
        $replaceWithSimpleText(nextSibling);
      }
    }
  };

  const $textNodeTransform = (node: TextNode) => {
    if (!node.isSimpleText()) {
      return;
    }

    let prevSibling = node.getPreviousSibling();
    let text = node.getTextContent();
    let currentNode = node;
    let match;
    // The first match of the previous text node's text and this node's.
    let firstMatch: null | EntityMatch = null;

    if ($isTextNode(prevSibling)) {
      const previousText = prevSibling.getTextContent();
      const combinedText = previousText + text;
      const prevMatch = getMatch(combinedText);
      firstMatch = prevMatch;

      if (isTargetNode(prevSibling)) {
        if (
          prevMatch === null ||
          (getMode(prevSibling) !== 0 &&
            // A token or segmented entity followed by text is turned back
            // into text, unless the same entity was already turned back into
            // text twice for this pending editor state: the transforms would
            // only make it again and turn it back forever. It is kept then,
            // and takes the text its match extends into, as an entity in
            // normal mode does.
            !(
              prevMatch.start === 0 &&
              prevMatch.end >= previousText.length &&
              $wasTurnedIntoText(prevSibling)
            ))
        ) {
          $replaceWithSimpleText(prevSibling);

          return;
        } else {
          const diff = prevMatch.end - previousText.length;

          if (diff > 0) {
            const concatText = text.slice(0, diff);
            const newTextContent = previousText + concatText;
            prevSibling.select();
            // The entity takes the first `diff` characters of this node: a
            // move of those characters (for collaboration).
            const entityNode = prevSibling;
            INTERNAL_$recordTextMove(node, entityNode, diff, () => {
              entityNode.setTextContent(newTextContent);

              if (diff === text.length) {
                node.remove();
              } else {
                const remainingText = text.slice(diff);
                node.setTextContent(remainingText);
              }
            });

            return;
          }
        }
      } else if (prevMatch === null || prevMatch.start < previousText.length) {
        $checkNextSibling(node, text);
        return;
      }
    }

    let prevMatchLengthToSkip = 0;

    while (true) {
      const remainingText = text;
      match = getMatch(remainingText);
      const nextText = match === null ? '' : remainingText.slice(match.end);
      text = nextText;

      if (nextText === '') {
        const nextSibling = currentNode.getNextSibling();

        if ($isTextNode(nextSibling)) {
          // The match ends where this node ends, so the next sibling's text may
          // extend, shorten or invalidate it. Re-run getMatch over the text that
          // is still to be processed plus the sibling's text and bail out unless
          // the same match is found at the same offset. Matches that were
          // already replaced (or skipped) are excluded from `remainingText`, so
          // the comparison is against `match.start` rather than 0.
          const combinedText = remainingText + nextSibling.getTextContent();
          const nextMatch = getMatch(combinedText);

          if (nextMatch === null) {
            if (isTargetNode(nextSibling)) {
              // Unless the transforms keep it there, which they do for a
              // match that needs the text after it in its source node.
              if (!isEntityAfter(remainingText, nextSibling, false)) {
                $replaceWithSimpleText(nextSibling);
              }
            } else {
              nextSibling.markDirty();
            }

            return;
          } else if (match === null || nextMatch.start !== match.start) {
            return;
          }
        }
      }

      if (match === null) {
        return;
      }

      if (
        match.start === 0 &&
        $isTextNode(prevSibling) &&
        (prevSibling.isTextEntity() ||
          // The transform of a simple text node checks the entity after it
          // with its own text in front, and turns it back into text if that
          // is no match. Leave a match there as text (and any match right
          // after it) rather than make an entity that check undoes, which
          // would make the two transforms undo each other forever (#9637).
          (prevSibling.isSimpleText() &&
            match.end > 0 &&
            (prevMatchLengthToSkip > 0 ||
              (getMatch(
                prevSibling.getTextContent() +
                  remainingText.slice(0, match.end),
              ) === null &&
                // Unless it is this match with the text after it too.
                !(
                  firstMatch !== null &&
                  firstMatch.start === prevSibling.getTextContentSize() &&
                  firstMatch.end ===
                    prevSibling.getTextContentSize() + match.end
                )))))
      ) {
        prevMatchLengthToSkip += match.end;
        continue;
      }

      let nodeToReplace;
      if (match.start === 0) {
        [nodeToReplace, currentNode] = currentNode.splitText(match.end);
      } else {
        [, nodeToReplace, currentNode] = currentNode.splitText(
          match.start + prevMatchLengthToSkip,
          match.end + prevMatchLengthToSkip,
        );
      }

      invariant(
        nodeToReplace !== undefined,
        '%s should not be undefined. You may want to check splitOffsets passed to the splitText.',
        'nodeToReplace',
      );

      const replacementNode = createNode(nodeToReplace);
      replacementNode
        .setFormat(nodeToReplace.getFormat())
        .setStyle(nodeToReplace.getStyle())
        .setDetail(nodeToReplace.getDetail());
      nodeToReplace.replace(replacementNode);
      // The same characters in the entity node (for collaboration), where
      // createNode gave it the same text.
      INTERNAL_$recordTextRetype(nodeToReplace, replacementNode);

      if (currentNode == null) {
        return;
      }
      prevMatchLengthToSkip = 0;
      prevSibling = replacementNode;
    }
  };

  const $reverseNodeTransform = (node: T) => {
    const text = node.getTextContent();
    const match = getMatch(text);

    if (match === null || match.start !== 0) {
      $replaceWithSimpleText(node);

      return;
    }

    if (text.length > match.end) {
      // This will split out the rest of the text as simple text
      node.splitText(match.end);

      return;
    }

    const prevSibling = node.getPreviousSibling();

    if (
      $isTextNode(prevSibling) &&
      prevSibling.isSimpleText() &&
      // The text node before it checks it on its own while it is a match
      // after its text.
      !isNextTextEntity(node) &&
      !isEntityAfter(prevSibling.getTextContent(), node, true)
    ) {
      // The text after this entity may have changed so that the transforms
      // no longer keep it after the text before it: the transform of the text
      // node before it turns it back into text then. Once per pending editor
      // state, as the transforms of other entities may leave it dirty again.
      const updateState =
        INTERNAL_getActiveEditorState() || editor.getEditorState();
      let marked = markedInUpdate.get(updateState);
      if (marked === undefined) {
        marked = new Set();
        markedInUpdate.set(updateState, marked);
      }
      if (!marked.has(prevSibling.getKey())) {
        marked.add(prevSibling.getKey());
        prevSibling.markDirty();
      }
    }

    if ($isTextNode(prevSibling) && prevSibling.isTextEntity()) {
      $replaceWithSimpleText(prevSibling);
      $replaceWithSimpleText(node);
    }

    const nextSibling = node.getNextSibling();

    if ($isTextNode(nextSibling) && nextSibling.isTextEntity()) {
      $replaceWithSimpleText(nextSibling);

      // This may have already been converted in the previous block
      if (isTargetNode(node)) {
        $replaceWithSimpleText(node);
      }
    }
  };

  const removePlainTextTransform = editor.registerNodeTransform(
    TextNode,
    $textNodeTransform,
  );
  const removeReverseNodeTransform = editor.registerNodeTransform(
    targetNode,
    $reverseNodeTransform,
  );

  return [removePlainTextTransform, removeReverseNodeTransform];
}
