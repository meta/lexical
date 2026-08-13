/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
} from '@lexical/html';
import {
  $createParagraphNode,
  $getRoot,
  $insertNodes,
  $nodesOfType,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

import {
  $createEquationNode,
  $isEquationNode,
  EquationNode,
} from '../../src/nodes/EquationNode';
import {PlaygroundImportExtension} from '../../src/nodes/PlaygroundImportExtension';
import {EquationsExtension} from '../../src/plugins/EquationsExtension';

const EquationHTMLTestExtension = defineExtension({
  $initialEditorState: null,
  dependencies: [PlaygroundImportExtension, EquationsExtension],
  name: '[test-equation-html]',
});

function exportEquationHtml(equation: string, inline: boolean): string {
  using editor = buildEditorFromExtensions(EquationHTMLTestExtension);
  editor.update(
    () => {
      $getRoot().clear();
      const paragraph = $createParagraphNode();
      $getRoot().append(paragraph);
      paragraph.selectStart();
      $insertNodes([$createEquationNode(equation, inline)]);
    },
    {discrete: true},
  );
  return editor.read(() => $generateHtmlFromNodes(editor, null));
}

function importEquationHtml(htmlString: string): null | string {
  using editor = buildEditorFromExtensions(EquationHTMLTestExtension);
  editor.update(
    () => {
      $getRoot().clear().select();
      const dom = new DOMParser().parseFromString(htmlString, 'text/html');
      $insertNodes($generateNodesFromDOMViaExtension(dom));
    },
    {discrete: true},
  );
  return editor.read(() => {
    const node = $nodesOfType(EquationNode)[0];
    assert($isEquationNode(node), 'expected an EquationNode');
    return node.getEquation();
  });
}

describe('EquationNode HTML round trip', () => {
  it('round trips an equation with non Latin-1 characters', () => {
    const equation = '\u03b1 + \u03b2 = \u03b3';
    expect(importEquationHtml(exportEquationHtml(equation, false))).toBe(
      equation,
    );
  });

  it('still decodes an equation exported before the encoding change', () => {
    // Pure ASCII encodes byte for byte, so HTML written by older builds
    // decodes unchanged.
    const legacy = `<span data-lexical-equation="${btoa(
      'x^2 + y^2',
    )}" data-lexical-inline="true"></span>`;
    expect(importEquationHtml(legacy)).toBe('x^2 + y^2');
  });
});
