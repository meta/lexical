/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {type EntityMatch, registerLexicalTextEntity} from '@lexical/text';
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  mergeRegister,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

class TestEntityNode extends TextNode {
  $config() {
    return this.config('test-entity-5466', {extends: TextNode});
  }

  isTextEntity(): true {
    return true;
  }
}

function $createTestEntityNode(text: string): TestEntityNode {
  return $applyNodeReplacement(new TestEntityNode(text));
}

// Matches `${…}` placeholders, as in the report.
function getMatch(text: string): null | EntityMatch {
  const match = /\$\{[^}]*\}/.exec(text);
  return match === null
    ? null
    : {end: match.index + match[0].length, start: match.index};
}

/**
 * Renders the paragraph children as `E:"…"` for entity nodes and `T:"…"` for
 * plain text nodes.
 */
function $describeTextNodes(): string {
  return $getRoot()
    .getAllTextNodes()
    .map(
      node =>
        `${node instanceof TestEntityNode ? 'E' : 'T'}:${JSON.stringify(
          node.getTextContent(),
        )}`,
    )
    .join(' ');
}

describe('registerLexicalTextEntity (#5466)', () => {
  // The second text node is bold so that it is not normalized into the first
  // one. That leaves the match at the end of a text node that still has a
  // TextNode sibling, which is the shape produced by $insertNodes.
  const cases: [string, string, string, string][] = [
    [
      'x ${A}',
      ' tail',
      'T:"x " E:"${A}" T:" tail"',
      'replaces a match that ends the node and does not start at offset 0',
    ],
    [
      'x ${A} y ${B}',
      ' tail',
      'T:"x " E:"${A}" T:" y " E:"${B}" T:" tail"',
      'replaces the last of several matches in the same node',
    ],
    [
      '${A} ${B} ${C}',
      ' tail',
      'E:"${A}" T:" " E:"${B}" T:" " E:"${C}" T:" tail"',
      'replaces every match when the first one starts at offset 0',
    ],
    [
      'x ${A} y',
      ' tail',
      'T:"x " E:"${A}" T:" y" T:" tail"',
      'replaces a match that does not end the node (control)',
    ],
    [
      'x ${A',
      'B} tail',
      'T:"x ${A" T:"B} tail"',
      'leaves a match that only completes inside the sibling (control)',
    ],
  ];

  for (const [first, second, expected, description] of cases) {
    test(description, async () => {
      using editor = buildEditorFromExtensions({
        name: 'test',
        nodes: [TestEntityNode],
        register: editor_ =>
          mergeRegister(
            ...registerLexicalTextEntity(
              editor_,
              getMatch,
              TestEntityNode,
              textNode => $createTestEntityNode(textNode.getTextContent()),
            ),
          ),
      });

      editor.update(() => {
        const paragraph = $createParagraphNode();
        paragraph.append(
          $createTextNode(first),
          $createTextNode(second).toggleFormat('bold'),
        );
        $getRoot().clear().append(paragraph);
      });

      editor.read(() => {
        expect($describeTextNodes()).toBe(expected);
      });
    });
  }
});
