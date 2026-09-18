/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {effect, namedSignals} from '@lexical/extension';
import {defineExtension, safeCast, TextNode} from 'lexical';

import {
  $createSpecialTextNode,
  SpecialTextNode,
} from '../../nodes/SpecialTextNode';

const BRACKETED_TEXT_REGEX = /\[([^[\]]+)\]/;

function $findAndTransformText(node: TextNode): null | TextNode {
  const text = node.getTextContent();

  const match = BRACKETED_TEXT_REGEX.exec(text);
  if (match) {
    const matchedText = match[1];
    const startIndex = match.index;

    let targetNode;
    if (startIndex === 0) {
      [targetNode] = node.splitText(startIndex + match[0].length);
    } else {
      [, targetNode] = node.splitText(startIndex, startIndex + match[0].length);
    }

    const specialTextNode = $createSpecialTextNode(matchedText);
    targetNode.replace(specialTextNode);
    return specialTextNode;
  }

  return null;
}

function $textNodeTransform(node: TextNode): void {
  let targetNode: TextNode | null = node;

  while (targetNode !== null) {
    if (!targetNode.isSimpleText()) {
      return;
    }

    targetNode = $findAndTransformText(targetNode);
  }
}

export interface SpecialTextConfig {
  disabled: boolean;
}

export const SpecialTextExtension = defineExtension({
  build: (editor, config) => namedSignals(config),
  config: safeCast<SpecialTextConfig>({disabled: true}),
  name: '@lexical/playground/SpecialText',
  nodes: [SpecialTextNode],
  register: (editor, config, state) =>
    effect(() => {
      if (state.getOutput().disabled.value) {
        return;
      }
      return editor.registerNodeTransform(TextNode, $textNodeTransform);
    }),
});
