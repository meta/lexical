/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// [docs:emoji-node] Read directly by the Creating an Extension guide.
import {
  defineImportRule,
  DOMImportExtension,
  domOverride,
  DOMRenderExtension,
  sel,
} from '@lexical/html';
import {version as emojiVersion} from 'emoji-datasource-facebook/package.json';
import {
  $create,
  $isTextNode,
  configExtension,
  defineExtension,
  isHTMLElement,
  nodeSchema,
  stringValue,
  TextNode,
  withField,
} from 'lexical';

import findEmoji from './findEmoji';

const emojiNodeSchema = nodeSchema<EmojiNode>()({
  unifiedID: withField(stringValue(), {field: '__unifiedID'}),
});

export class EmojiNode extends TextNode {
  __unifiedID: string = '';

  $config() {
    return this.config('emoji', {
      extends: TextNode,
      json: emojiNodeSchema,
    });
  }

  getUnifiedID(): string {
    return this.getLatest().__unifiedID;
  }

  setUnifiedID(unifiedID: string): this {
    const self = this.getWritable();
    self.__unifiedID = unifiedID.toLowerCase();
    return self;
  }
}

export function $createEmojiNode(unifiedID: string): EmojiNode {
  const text = String.fromCodePoint(
    ...unifiedID.split('-').map(value => parseInt(value, 16)),
  );
  return $create(EmojiNode)
    .setTextContent(text)
    .setMode('token')
    .setUnifiedID(unifiedID);
}
// [/docs:emoji-node]

// [docs:emoji-extension] Read directly by the Creating an Extension guide.
const BASE_EMOJI_URI = `https://cdn.jsdelivr.net/npm/emoji-datasource-facebook@${emojiVersion}/img/facebook/64`;

function applyEmojiImage(dom: HTMLElement, unifiedID: string): void {
  const url = `${BASE_EMOJI_URI}/${encodeURIComponent(unifiedID.toLowerCase())}.png`;
  const backgroundImage = `url('${url}')`;
  if (dom.dataset.emojiUrl === url) {
    // TextNode may have updated inline styles. Restore the loaded background
    // without clearing it or starting another preload for the same image.
    if (dom.classList.contains('emoji-node-loaded')) {
      dom.style.backgroundImage = backgroundImage;
    }
    return;
  }
  // Keep the native emoji visible while loading, including for missing images.
  dom.classList.remove('emoji-node-loaded');
  dom.style.backgroundImage = '';
  dom.dataset.emojiUrl = url;
  const image = dom.ownerDocument.createElement('img');
  image.onload = () => {
    // A different ID may have been assigned while this image was loading.
    if (dom.dataset.emojiUrl === url) {
      dom.style.backgroundImage = backgroundImage;
      dom.classList.add('emoji-node-loaded');
    }
  };
  image.src = url;
}

function $textNodeTransform(node: TextNode): void {
  if (!node.isSimpleText() || node.hasFormat('code')) {
    return;
  }

  const text = node.getTextContent();

  // Find only 1st occurrence as transform will be re-run anyway for the rest
  // because newly inserted nodes are considered to be dirty
  const emojiMatch = findEmoji(text);
  if (emojiMatch === null) {
    return;
  }

  let targetNode;
  if (emojiMatch.position === 0) {
    // First text chunk within string, splitting into 2 parts
    [targetNode] = node.splitText(
      emojiMatch.position + emojiMatch.shortcode.length,
    );
  } else {
    // In the middle of a string
    [, targetNode] = node.splitText(
      emojiMatch.position,
      emojiMatch.position + emojiMatch.shortcode.length,
    );
  }

  const emojiNode = $createEmojiNode(emojiMatch.unifiedID)
    .setFormat(targetNode.getFormat())
    .setStyle(targetNode.getStyle());
  targetNode.replace(emojiNode);
}

// [/docs:emoji-extension]

// [docs:emoji-html] Read directly by the Creating an Extension guide.
const EmojiImportRule = defineImportRule({
  $import(_context, element, $next) {
    // Preserve the usual text import behavior, including nested formatting.
    const nodes = $next();
    const node = nodes[0];
    if (nodes.length === 1 && $isTextNode(node)) {
      const text = node.getTextContent();
      const unifiedID = Array.from(text, char =>
        char.codePointAt(0)!.toString(16).padStart(4, '0'),
      ).join('-');
      const attribute = element.getAttribute('data-emoji-id');
      // Only restore the emoji when the attribute agrees with the actual text.
      // Invalid or mismatched attributes leave the imported content unchanged.
      if (attribute !== null && unifiedID === attribute.toLowerCase()) {
        return [
          $create(EmojiNode)
            .setUnifiedID(unifiedID)
            .setTextContent(text)
            .setMode('token')
            .setFormat(node.getFormat())
            .setStyle(node.getStyle()),
        ];
      }
    }
    return nodes;
  },
  match: sel.any().attr('data-emoji-id', true),
  name: '@lexical/examples/emoji',
});

export const EmojiExtension = defineExtension({
  dependencies: [
    configExtension(DOMImportExtension, {rules: [EmojiImportRule]}),
    configExtension(DOMRenderExtension, {
      overrides: [
        domOverride([EmojiNode], {
          $decorateDOM(node, _prevNode, dom) {
            dom.classList.add('emoji-node');
            applyEmojiImage(dom, node.getUnifiedID());
          },
          $exportDOM(node, $next) {
            const output = $next();
            if (isHTMLElement(output.element)) {
              output.element.setAttribute('data-emoji-id', node.getUnifiedID());
            }
            return output;
          },
        }),
      ],
    }),
  ],
  name: '@lexical/examples/Emoji',
  nodes: () => [EmojiNode],
  register(editor) {
    return editor.registerNodeTransform(TextNode, $textNodeTransform);
  },
});
// [/docs:emoji-html]
