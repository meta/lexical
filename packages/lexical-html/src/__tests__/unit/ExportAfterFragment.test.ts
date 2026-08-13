/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {$generateHtmlFromNodes} from '@lexical/html';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $applyNodeReplacement,
  $createTextNode,
  $getDocument,
  $getRoot,
  type DOMExportOutput,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {describe, expect, it} from 'vitest';

// DOMExportOutput.after may return a replacement element. When `element` is a
// DocumentFragment the exporter appends it to the parent first, which moves
// its children out and empties it — so the replacement written back into the
// fragment afterwards never reaches the output.

class FragmentExportNode extends ElementNode {
  $config() {
    return this.config('fragment-export', {extends: ElementNode});
  }

  createDOM(): HTMLElement {
    return $getDocument().createElement('div');
  }

  updateDOM(): false {
    return false;
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const doc = $getDocument();
    return {
      after: () => {
        const replacement = doc.createElement('section');
        replacement.setAttribute('data-replaced', 'true');
        return replacement;
      },
      element: doc.createDocumentFragment(),
    };
  }
}

function $createFragmentExportNode(): FragmentExportNode {
  return $applyNodeReplacement(new FragmentExportNode());
}

class ElementExportNode extends ElementNode {
  $config() {
    return this.config('element-export', {extends: ElementNode});
  }

  createDOM(): HTMLElement {
    return $getDocument().createElement('div');
  }

  updateDOM(): false {
    return false;
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const doc = $getDocument();
    return {
      after: () => {
        const replacement = doc.createElement('section');
        replacement.setAttribute('data-replaced', 'true');
        return replacement;
      },
      element: doc.createElement('div'),
    };
  }
}

function $createElementExportNode(): ElementExportNode {
  return $applyNodeReplacement(new ElementExportNode());
}

function buildEditor(factory: () => LexicalNode) {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        $getRoot().clear().append(factory());
      },
      dependencies: [RichTextExtension],
      name: '[after-fragment]',
      nodes: [FragmentExportNode, ElementExportNode],
    }),
  );
}

describe('DOMExportOutput.after returning a replacement', () => {
  it('applies the replacement when element is a DocumentFragment', () => {
    using editor = buildEditor(() =>
      $createFragmentExportNode().append($createTextNode('body')),
    );
    const html = editor.read(() => $generateHtmlFromNodes(editor, null));
    expect(html).toContain('data-replaced="true"');
  });

  it('applies the replacement when element is an HTMLElement (control)', () => {
    using editor = buildEditor(() =>
      $createElementExportNode().append($createTextNode('body')),
    );
    const html = editor.read(() => $generateHtmlFromNodes(editor, null));
    expect(html).toContain('data-replaced="true"');
  });
});
