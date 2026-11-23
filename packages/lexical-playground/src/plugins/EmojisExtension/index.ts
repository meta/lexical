/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {effect, namedSignals} from '@lexical/extension';
import {defineExtension, safeCast, TextNode} from 'lexical';

import {$createEmojiNode} from '../../nodes/EmojiNode';

const emojis: Map<string, [string, string]> = new Map([
  [':)', ['emoji happysmile', '🙂']],
  [':D', ['emoji veryhappysmile', '😀']],
  [':(', ['emoji unhappysmile', '🙁']],
  ['<3', ['emoji heart', '❤']],
]);

function $findAndTransformEmoji(node: TextNode): null | TextNode {
  const text = node.getTextContent();

  for (let i = 0; i < text.length; i++) {
    const emojiData = emojis.get(text[i]) || emojis.get(text.slice(i, i + 2));

    if (emojiData !== undefined) {
      const [emojiStyle, emojiText] = emojiData;
      let targetNode;

      if (i === 0) {
        [targetNode] = node.splitText(i + 2);
      } else {
        [, targetNode] = node.splitText(i, i + 2);
      }

      const emojiNode = $createEmojiNode(emojiStyle, emojiText);
      targetNode.replace(emojiNode);
      return emojiNode;
    }
  }

  return null;
}

function $textNodeTransform(node: TextNode): void {
  let targetNode: TextNode | null = node;

  while (targetNode !== null) {
    if (!targetNode.isSimpleText()) {
      return;
    }

    targetNode = $findAndTransformEmoji(targetNode);
  }
}

export interface EmojisConfig {
  /**
   * When true, the extension registers no transform, so typing an
   * emoticon (for example `:)`) leaves the text as typed.
   * Defaults to `false`.
   */
  disabled: boolean;
}

export const EmojisExtension = defineExtension({
  build: (_editor, config) => namedSignals(config),
  config: safeCast<EmojisConfig>({
    disabled: false,
  }),
  name: '@lexical/playground/Emojis',
  register(editor, _config, state) {
    const {disabled} = state.getOutput();
    // Gate on `disabled` from an effect so a disabled emoji
    // extension registers no transform at all.
    return effect(() =>
      disabled.value
        ? undefined
        : editor.registerNodeTransform(TextNode, $textNodeTransform),
    );
  },
});
