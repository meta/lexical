/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  registerMarkdownShortcuts,
} from '@lexical/markdown';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  createEditor,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

import {
  $createEquationNode,
  $isEquationNode,
  EquationNode,
} from '../../src/nodes/EquationNode';
import {$isImageNode, ImageNode} from '../../src/nodes/ImageNode';
import {
  BLOCK_EQUATION,
  EQUATION,
  IMAGE,
} from '../../src/plugins/MarkdownTransformers';

const EQUATION_TRANSFORMERS = [BLOCK_EQUATION, EQUATION];
const MarkdownShortcutTestExtension = defineExtension({
  dependencies: [RichTextExtension],
  name: 'MarkdownShortcutTest',
  nodes: [EquationNode],
  register: editor => registerMarkdownShortcuts(editor, EQUATION_TRANSFORMERS),
});

function typeMarkdown(editor: LexicalEditor, text: string) {
  editor.update(() => {
    const selection = $getSelection();
    if (!($isRangeSelection(selection) && selection.isCollapsed())) {
      $getRoot().selectEnd();
    }
  });
  for (const char of text) {
    editor.update(() => $getSelection()?.insertText(char), {discrete: true});
  }
  editor.read(() => {});
}

describe('playground EQUATION markdown transformer', () => {
  it('exports inline equations with single dollar delimiters', () => {
    const editor = createEditor({nodes: [EquationNode]});

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createEquationNode('x^2 + y^2 = z^2', true));
        $getRoot().append(paragraph);
      },
      {discrete: true},
    );

    const markdown = editor
      .getEditorState()
      .read(() => $convertToMarkdownString(EQUATION_TRANSFORMERS));

    expect(markdown).toBe('$x^2 + y^2 = z^2$');
  });

  it('exports block equations with double dollar delimiters', () => {
    const editor = createEditor({nodes: [EquationNode]});

    editor.update(
      () => {
        $getRoot().append($createEquationNode('x^2 + y^2 = z^2', false));
      },
      {discrete: true},
    );

    const markdown = editor
      .getEditorState()
      .read(() => $convertToMarkdownString(EQUATION_TRANSFORMERS));

    expect(markdown).toBe('$$\nx^2 + y^2 = z^2\n$$');
  });

  it('imports multiline double dollar equations as block equations', () => {
    const editor = createEditor({nodes: [EquationNode]});

    editor.update(
      () => {
        $convertFromMarkdownString(
          '$$\nx^2 + y^2 = z^2\n$$',
          EQUATION_TRANSFORMERS,
        );
      },
      {discrete: true},
    );

    editor.read(() => {
      const equation = $getRoot().getFirstChildOrThrow();
      assert($isEquationNode(equation), 'Root child must be an EquationNode');
      expect(equation.getEquation()).toBe('x^2 + y^2 = z^2');
      expect(equation.isInline()).toBe(false);
    });
  });

  it('imports single dollar equations as inline equations', () => {
    const editor = createEditor({nodes: [EquationNode]});

    editor.update(
      () => {
        $convertFromMarkdownString('$x^2 + y^2 = z^2$', EQUATION_TRANSFORMERS);
      },
      {discrete: true},
    );

    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');

      const equation = paragraph.getFirstChildOrThrow();
      assert(
        $isEquationNode(equation),
        'Paragraph child must be an EquationNode',
      );
      expect(equation.getEquation()).toBe('x^2 + y^2 = z^2');
      expect(equation.isInline()).toBe(true);
    });
  });

  it('imports escaped dollars inside inline equations', () => {
    const editor = createEditor({nodes: [EquationNode]});

    editor.update(
      () => {
        $convertFromMarkdownString('$price = \\$5$', EQUATION_TRANSFORMERS);
      },
      {discrete: true},
    );

    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');

      const equation = paragraph.getFirstChildOrThrow();
      assert(
        $isEquationNode(equation),
        'Paragraph child must be an EquationNode',
      );
      expect(equation.getEquation()).toBe('price = $5');
      expect(equation.isInline()).toBe(true);
    });
  });

  it('exports inline equations without creating block-equation ambiguity', () => {
    const editor = createEditor({nodes: [EquationNode]});

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append(
          $createTextNode('$'),
          $createEquationNode('x^2 + y^2 = z^2', true),
          $createTextNode('$'),
        );
        $getRoot().append(paragraph);
      },
      {discrete: true},
    );

    const markdown = editor
      .getEditorState()
      .read(() => $convertToMarkdownString(EQUATION_TRANSFORMERS));

    expect(markdown).toBe('$$x^2 + y^2 = z^2$$');

    const nextEditor = createEditor({nodes: [EquationNode]});
    nextEditor.update(
      () => {
        $convertFromMarkdownString(markdown, EQUATION_TRANSFORMERS);
      },
      {discrete: true},
    );

    nextEditor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      const children = paragraph.getChildren();
      expect(children.map(child => child.getTextContent())).toEqual([
        '$',
        'x^2 + y^2 = z^2',
        '$',
      ]);
      assert(
        $isEquationNode(children[1]),
        'Middle child must be an EquationNode',
      );
      expect(children[1].isInline()).toBe(true);
    });
  });

  it('exports inline equations containing dollar signs without block-equation ambiguity', () => {
    const editor = createEditor({nodes: [EquationNode]});

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createEquationNode('price = $5', true));
        $getRoot().append(paragraph);
      },
      {discrete: true},
    );

    const markdown = editor
      .getEditorState()
      .read(() => $convertToMarkdownString(EQUATION_TRANSFORMERS));

    expect(markdown).toBe('$price = \\$5$');

    const nextEditor = createEditor({nodes: [EquationNode]});
    nextEditor.update(
      () => {
        $convertFromMarkdownString(markdown, EQUATION_TRANSFORMERS);
      },
      {discrete: true},
    );

    nextEditor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');

      const equation = paragraph.getFirstChildOrThrow();
      assert(
        $isEquationNode(equation),
        'Paragraph child must be an EquationNode',
      );
      expect(equation.getEquation()).toBe('price = $5');
      expect(equation.isInline()).toBe(true);
    });
  });

  it('uses a block equation when typing double dollar markdown', () => {
    using editor = buildEditorFromExtensions(MarkdownShortcutTestExtension);
    typeMarkdown(editor, '$$x^2 + y^2 = z^2$$');

    editor.read(() => {
      const equation = $getRoot().getFirstChildOrThrow();
      assert($isEquationNode(equation), 'Root child must be an EquationNode');
      expect(equation.getEquation()).toBe('x^2 + y^2 = z^2');
      expect(equation.isInline()).toBe(false);
    });
  });
});

const ImageMarkdownTestExtension = defineExtension({
  dependencies: [RichTextExtension],
  name: 'ImageMarkdownTest',
  nodes: [ImageNode],
});

describe('playground IMAGE markdown transformer', () => {
  it('imports image with the same default maxWidth as $createImageNode', () => {
    using editor = buildEditorFromExtensions(ImageMarkdownTestExtension);

    editor.update(
      () => {
        $convertFromMarkdownString('![alt text](http://example.com/img.png)', [
          IMAGE,
        ]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      assert($isParagraphNode(paragraph), 'Root child must be a paragraph');
      const image = paragraph.getFirstChildOrThrow();
      assert($isImageNode(image), 'Paragraph child must be an ImageNode');
      expect(image.getAltText()).toBe('alt text');
      expect(image.__maxWidth).toBe(500);
    });
  });
});
