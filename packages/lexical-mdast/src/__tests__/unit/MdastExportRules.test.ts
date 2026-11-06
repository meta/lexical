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
  $create,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  configExtension,
  DecoratorNode,
  defineExtension,
  ElementNode,
  getStaticNodeConfig,
  TabNode,
  TextNode,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {
  $convertSelectionToMarkdownString,
  $convertToMarkdownString,
  type MdastExportRule,
  MdastExtension,
} from '../../index';

class CustomTextNode extends TextNode {
  $config() {
    return this.config('custom-text', {extends: TextNode});
  }
}

class DerivedTextNode extends CustomTextNode {
  $config() {
    return this.config('derived-text', {extends: CustomTextNode});
  }
}

class AbstractElementNode extends ElementNode {}

class UntypedTextNode extends TextNode {}

class UntypedCustomTextNode extends CustomTextNode {}

class LegacyTextNode extends TextNode {
  static getType(): string {
    return 'legacy-text';
  }
}

class UntypedLegacyTextNode extends LegacyTextNode {}

function createEditor(exportRules: readonly MdastExportRule[]) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [configExtension(MdastExtension, {exportRules})],
      name: '[root]',
      // The intermediate CustomTextNode deliberately is not registered.
      nodes: [DerivedTextNode, LegacyTextNode],
    }),
  );
}

describe('mdast export rule inheritance', () => {
  it.each([
    {label: 'string', type: 'text'},
    {label: 'class', type: TextNode},
  ])('applies a $label rule to text, tabs, and custom subclasses', ({type}) => {
    using editor = createEditor([
      {
        $export: (node: TextNode) => ({
          type: 'text',
          value: `<${node.getType()}>`,
        }),
        type,
      },
    ]);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('text'),
              $createTabNode(),
              $create(DerivedTextNode).setTextContent('custom'),
            ),
          );
      },
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      '\\<text>\\<tab>\\<derived-text>',
    );
  });

  it.each([
    {label: 'string', type: 'tab'},
    {label: 'class', type: TabNode},
  ])(
    'prefers the more specific $label rule regardless of contribution order',
    ({type}) => {
      for (const reverse of [false, true]) {
        const rules: MdastExportRule[] = [
          {$export: () => ({type: 'text', value: 'base'}), type: TextNode},
          {$export: () => ({type: 'text', value: 'specific'}), type},
        ];
        using editor = createEditor(reverse ? rules.reverse() : rules);
        editor.update(
          () =>
            $getRoot()
              .clear()
              .append($createParagraphNode().append($createTabNode())),
          {discrete: true},
        );
        expect(editor.read(() => $convertToMarkdownString())).toBe('specific');
      }
    },
  );

  it.each([
    {label: 'string', type: 'custom-text'},
    {label: 'class', type: CustomTextNode},
  ])(
    'prefers the nearest ancestor $label even when it is not registered',
    ({type}) => {
      using editor = createEditor([
        {$export: () => ({type: 'text', value: 'base'}), type: TextNode},
        {$export: () => ({type: 'text', value: 'nearest'}), type},
      ]);
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $create(DerivedTextNode).setTextContent('custom'),
              ),
            );
        },
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString())).toBe('nearest');
    },
  );

  it.each([
    ['tab', TabNode],
    [TabNode, 'tab'],
  ])(
    'uses contribution order for equivalent string and class rules',
    (first, second) => {
      using editor = createEditor([
        {$export: () => ({type: 'text', value: 'first'}), type: first},
        {$export: () => ({type: 'text', value: 'second'}), type: second},
      ]);
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTabNode())),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString())).toBe('first');
    },
  );

  it.each([
    {label: 'string', type: 'derived-text'},
    {label: 'class', type: DerivedTextNode},
  ])(
    'uses the default export when the selected $label handler returns null',
    ({type}) => {
      using editor = createEditor([
        {$export: () => null, type},
        {$export: () => ({type: 'text', value: 'lower-priority'}), type},
        {
          $export: (node: TextNode) => ({
            type: 'text',
            value: node.getTextContent().toUpperCase(),
          }),
          type: TextNode,
        },
      ]);
      editor.update(
        () =>
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode('a'),
                $create(DerivedTextNode).setTextContent('b'),
                $createTextNode('c'),
              ),
            ),
        {discrete: true},
      );
      expect(editor.read(() => $convertToMarkdownString())).toBe('AbC');
    },
  );

  it.each([
    {name: 'ElementNode', type: ElementNode},
    {name: 'DecoratorNode', type: DecoratorNode},
    {name: 'AbstractElementNode', type: AbstractElementNode},
  ])('rejects $name because it has no node type', ({type}) => {
    expect(() => {
      using _editor = createEditor([
        {$export: () => ({type: 'thematicBreak'}), type},
      ]);
    }).toThrow(
      'MdastExtension: export rule node classes must have their own type.',
    );
  });

  it.each([
    {name: 'UntypedTextNode', type: UntypedTextNode},
    {name: 'UntypedCustomTextNode', type: UntypedCustomTextNode},
    {name: 'UntypedLegacyTextNode', type: UntypedLegacyTextNode},
  ])(
    'rejects $name when its type is inherited, including cached metadata',
    ({type}) => {
      // Computing metadata can synthesize an own getType method. That must not
      // make an inherited type count as a declaration on the subclass.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          getStaticNodeConfig(type);
        }
        expect(() => {
          using _editor = createEditor([
            {$export: () => ({type: 'text', value: 'custom'}), type},
          ]);
        }).toThrow(
          'MdastExtension: export rule node classes must have their own type.',
        );
      }
    },
  );

  it('accepts a type declared with a legacy static getType', () => {
    using editor = createEditor([
      {$export: () => ({type: 'text', value: 'legacy'}), type: LegacyTextNode},
    ]);
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $create(LegacyTextNode).setTextContent('text'),
            ),
          ),
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe('legacy');
  });

  it('uses inherited rules for partially selected custom text', () => {
    using editor = createEditor([
      {
        $export: (node: TextNode) => ({
          type: 'text',
          value: node.getTextContent().toUpperCase(),
        }),
        type: TextNode,
      },
    ]);
    editor.update(
      () => {
        const text = $create(DerivedTextNode).setTextContent('abcde');
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(1, 4);
      },
      {discrete: true},
    );
    expect(editor.read(() => $convertSelectionToMarkdownString())).toBe('BCD');
  });
});
