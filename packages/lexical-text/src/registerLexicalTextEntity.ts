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
  INTERNAL_$recordTextMove,
  INTERNAL_$recordTextRetype,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  TextNode,
} from 'lexical';

export type EntityMatch = {end: number; start: number};

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

  const getMode = (node: TextNode): number => {
    return node.getLatest().__mode;
  };

  // The first match in `text` when it follows `prefix`, with offsets in
  // `text`; null if there is none, or if it starts in `prefix`.
  const matchAfter = (prefix: string, text: string): null | EntityMatch => {
    if (prefix === '') {
      return getMatch(text);
    }
    const found = getMatch(prefix + text);
    return found === null || found.start < prefix.length
      ? null
      : {end: found.end - prefix.length, start: found.start - prefix.length};
  };

  // Whether `match` in `node`'s text `text` stays an entity: an entity node
  // is checked on its own text (see $reverseNodeTransform), which is the
  // text createNode gives it (it may change it, say to lower case).
  const $staysEntity = (
    node: TextNode,
    text: string,
    match: EntityMatch,
  ): boolean => {
    const isWhole = (whole: string) => {
      const alone = getMatch(whole);
      return alone !== null && alone.start === 0 && alone.end === whole.length;
    };
    const source = text.slice(match.start, match.end);
    if (isWhole(source)) {
      return true;
    }
    // A detached node, which the update's garbage collection removes.
    const made = createNode(
      $createTextNode(source)
        .setFormat(node.getFormat())
        .setStyle(node.getStyle())
        .setDetail(node.getDetail()),
    ).getTextContent();
    return made !== source && isWhole(made);
  };

  const $textNodeTransform = (node: TextNode) => {
    if (!node.isSimpleText()) {
      return;
    }

    let prevSibling = node.getPreviousSibling();
    let text = node.getTextContent();
    let currentNode = node;
    let match;
    // The text of a plain previous sibling, which the first match in this
    // node is found with: a match at the start of this node's own text may
    // not be one after that text ("x" + "dog": no "dog"), and the previous
    // sibling's own transform checks it that way (see the next sibling check
    // below), so finding it here without that text would make an entity the
    // sibling's transform undoes, again and again.
    let prefix = '';

    if ($isTextNode(prevSibling)) {
      const previousText = prevSibling.getTextContent();
      const combinedText = previousText + text;
      const prevMatch = getMatch(combinedText);

      if (isTargetNode(prevSibling)) {
        if (prevMatch === null || getMode(prevSibling) !== 0) {
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
        return;
      } else {
        prefix = previousText;
      }
    }

    let prevMatchLengthToSkip = 0;

    while (true) {
      const remainingText = text;
      // Only the first match follows the previous sibling's text.
      const before = prefix;
      prefix = '';
      match = matchAfter(before, remainingText);
      if (
        before !== '' &&
        match !== null &&
        !$staysEntity(currentNode, remainingText, match)
      ) {
        // A match that needs the text before it (a lookbehind) would be
        // made an entity and undone again: it is left as text, and the
        // rest of this node is matched as it was.
        prevMatchLengthToSkip += match.end;
        text = remainingText.slice(match.end);
        continue;
      }
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
          const nextMatch = matchAfter(before, combinedText);

          if (nextMatch === null) {
            if (isTargetNode(nextSibling)) {
              $replaceWithSimpleText(nextSibling);
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
        prevSibling.isTextEntity()
      ) {
        prevMatchLengthToSkip += match.end;
        continue;
      }

      let nodeToReplace;
      if (match.start + prevMatchLengthToSkip === 0) {
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
