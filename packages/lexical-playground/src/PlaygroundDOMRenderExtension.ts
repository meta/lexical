/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {domOverride, DOMRenderExtension} from '@lexical/html';
import {
  $getDocument,
  configExtension,
  defineExtension,
  isBlockDomNode,
  isHTMLElement,
  ParagraphNode,
} from 'lexical';

/**
 * Replaces the legacy `buildHTMLConfig().export` map: when a ParagraphNode
 * serializes to `<p>` but ends up wrapping any block-level child, swap the
 * `<p>` for a `<div role="paragraph">` (carrying over all attributes) so
 * the resulting HTML stays well-formed.
 */
export const PlaygroundDOMRenderExtension = defineExtension({
  dependencies: [
    configExtension(DOMRenderExtension, {
      overrides: [
        domOverride([ParagraphNode], {
          $exportDOM: (node, $next, editor) => {
            const output = $next();
            if (
              !isHTMLElement(output.element) ||
              output.element.tagName !== 'P'
            ) {
              return output;
            }
            const innerAfter = output.after;
            return {
              ...output,
              after: generatedElement => {
                if (innerAfter) {
                  generatedElement = innerAfter(generatedElement);
                }
                if (
                  !isHTMLElement(generatedElement) ||
                  generatedElement.tagName !== 'P'
                ) {
                  return generatedElement;
                }
                for (const childNode of generatedElement.childNodes) {
                  if (isBlockDomNode(childNode)) {
                    const div = $getDocument().createElement('div');
                    div.setAttribute('role', 'paragraph');
                    for (const attr of generatedElement.attributes) {
                      div.setAttribute(attr.name, attr.value);
                    }
                    while (generatedElement.firstChild) {
                      div.appendChild(generatedElement.firstChild);
                    }
                    return div;
                  }
                }
                return generatedElement;
              },
            };
          },
        }),
      ],
    }),
  ],
  name: '@lexical/playground/DOMRender',
});
