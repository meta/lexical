/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  $applyNodeReplacement,
  defineExtension,
  type EditorConfig,
  ParagraphNode,
} from 'lexical';

export class CustomParagraphNode extends ParagraphNode {
  $config() {
    return this.config('custom-paragraph', {extends: ParagraphNode});
  }
  createDOM(config: EditorConfig) {
    const el = super.createDOM(config);
    // Normally this sort of thing would be done with the theme, this is for
    // demonstration purposes only
    el.style.border = '1px dashed black';
    el.style.background = 'linear-gradient(to top, #f7f8f8, #acbb78)';
    return el;
  }
}

export function $createCustomParagraphNode() {
  return $applyNodeReplacement(new CustomParagraphNode());
}

/**
 * Registers CustomParagraphNode and replaces every ParagraphNode with it.
 * `withKlass` lets transforms and listeners registered for ParagraphNode
 * apply to CustomParagraphNode too.
 */
export const CustomParagraphExtension = defineExtension({
  name: '@lexical/examples/node-replacement/CustomParagraph',
  nodes: () => [
    CustomParagraphNode,
    {
      replace: ParagraphNode,
      with: () => $createCustomParagraphNode(),
      withKlass: CustomParagraphNode,
    },
  ],
});
