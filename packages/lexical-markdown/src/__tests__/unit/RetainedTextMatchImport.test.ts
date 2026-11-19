/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {createHeadlessEditor} from '@lexical/headless';
import {$createLinkNode, $isLinkNode, LinkNode} from '@lexical/link';
import {
  $convertFromMarkdownString,
  $generateNodesFromMarkdownString,
  LINK,
  TEXT_FORMAT_TRANSFORMERS,
  type TextMatchTransformer,
  type Transformer,
} from '@lexical/markdown';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  type ElementNode,
  TEXT_TYPE_TO_FORMAT,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

const TRANSFORMERS: Transformer[] = [...TEXT_FORMAT_TRANSFORMERS, LINK];
const FORMAT_IN_PLACE: TextMatchTransformer = {
  dependencies: [],
  importRegExp: /@[^ ]+/,
  regExp: /@[^ ]+/,
  replace(node) {
    node.toggleFormat('highlight');
  },
  type: 'text-match',
};

function importText(
  markdown: string,
  transformers: Transformer[],
  detached: boolean,
) {
  const editor = createHeadlessEditor({
    nodes: [LinkNode],
    onError(error) {
      throw error;
    },
  });
  let result!: {text: string; format: number; url: string | null}[];
  editor.update(
    () => {
      let container: ElementNode;
      if (detached) {
        const [paragraph] = $generateNodesFromMarkdownString(
          markdown,
          transformers,
        );
        assert($isElementNode(paragraph));
        expect(paragraph.isAttached()).toBe(false);
        expect($getRoot().getChildrenSize()).toBe(0);
        container = paragraph;
      } else {
        $convertFromMarkdownString(markdown, transformers);
        container = $getRoot();
      }
      result = container.getAllTextNodes().map(node => {
        const parent = node.getParent();
        return {
          format: node.getFormat(),
          text: node.getTextContent(),
          url: $isLinkNode(parent) ? parent.getURL() : null,
        };
      });
    },
    {discrete: true},
  );
  return result;
}

describe.each([false, true])(
  'retained text matches (detached: %s)',
  detached => {
    describe.each(['', 'prefix '])('with prefix %j', prefix => {
      function read(markdown: string, transformer?: TextMatchTransformer) {
        return importText(
          prefix + markdown,
          transformer ? [transformer, ...TRANSFORMERS] : TRANSFORMERS,
          detached,
        );
      }

      it.each([
        [String.raw`@a\*b`, '@a*b'],
        [String.raw`@a\\\*b`, String.raw`@a\*b`],
        ['@a&#65;b', '@aAb'],
        ['@a&#38;#65;b', '@a&#65;b'],
      ])('unescapes text formatted in place exactly once: %s', (md, text) => {
        const nodes = read(md, FORMAT_IN_PLACE);
        expect(nodes.map(node => node.text).join('')).toBe(prefix + text);
        expect(nodes[nodes.length - 1].format).toBe(
          TEXT_TYPE_TO_FORMAT.highlight,
        );
      });

      it.each([
        [String.raw`[a\*b]](url)`, '[a*b]](url)'],
        ['[a&#65;]](url)', '[aA]](url)'],
      ])('unescapes text a link transformer declines: %s', (md, text) => {
        const nodes = read(md);
        expect(nodes.map(node => node.text).join('')).toBe(prefix + text);
        expect(nodes.every(node => node.url === null)).toBe(true);
      });

      it('unescapes a matched node reused inside a link without returning it', () => {
        const nodes = read(String.raw`@a\\\*b`, {
          ...FORMAT_IN_PLACE,
          dependencies: [LinkNode],
          replace(node) {
            const link = $createLinkNode('https://example.com');
            node.replace(link);
            link.append(node);
          },
        });
        expect(nodes[nodes.length - 1]).toEqual({
          format: 0,
          text: String.raw`@a\*b`,
          url: 'https://example.com',
        });
      });

      it('does not unescape a returned node twice', () => {
        const nodes = read(String.raw`@a\\\*b`, {
          ...FORMAT_IN_PLACE,
          replace(node) {
            return node.setTextContent(node.getTextContent().slice(1));
          },
        });
        expect(nodes.map(node => node.text).join('')).toBe(
          prefix + String.raw`a\*b`,
        );
      });

      it('keeps literal content when a transformer formats the node as code', () => {
        const text = String.raw`@a\*&#65;b`;
        const nodes = read(text, {
          ...FORMAT_IN_PLACE,
          replace(node) {
            node.toggleFormat('code');
          },
        });
        expect(nodes[nodes.length - 1]).toEqual({
          format: TEXT_TYPE_TO_FORMAT.code,
          text,
          url: null,
        });
      });

      it('leaves newly generated replacement text literal', () => {
        const text = String.raw`literal\*&#65;`;
        const nodes = read('@replace', {
          ...FORMAT_IN_PLACE,
          replace(node) {
            node.replace($createTextNode(text));
          },
        });
        expect(nodes.map(node => node.text).join('')).toBe(prefix + text);
      });
    });
  },
);
