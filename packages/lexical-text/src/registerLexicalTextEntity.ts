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
  };

  const getMode = (node: TextNode): number => {
    return node.getLatest().__mode;
  };

  const $textNodeTransform = (node: TextNode) => {
    if (!node.isSimpleText()) {
      return;
    }

    let prevSibling = node.getPreviousSibling();
    let text = node.getTextContent();
    let currentNode = node;
    let match;

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
            prevSibling.setTextContent(newTextContent);

            if (diff === text.length) {
              node.remove();
            } else {
              const remainingText = text.slice(diff);
              node.setTextContent(remainingText);
            }

            return;
          }
        }
      } else if (prevMatch === null || prevMatch.start < previousText.length) {
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
      replacementNode.setFormat(nodeToReplace.getFormat());
      nodeToReplace.replace(replacementNode);

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
