/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Content holding a line feed in a text node, set whole into an editor: the
// editor shows a line break node there, as every reader does. A state taken
// from another editor (`setEditorState(other.getEditorState())`) marks only
// the root dirty and runs only the root's transforms, so the author's
// normalization splits its text too; and initial content written into a
// used root is read back in every container, a table cell's included.

import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createHeadingNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  createEditor,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {$createEquation, flush, NODES} from '../utils/harness';

const $cell = (...children: LexicalNode[]) =>
  $createTableNode().append(
    $createTableRowNode().append(
      $createTableCellNode().append($createParagraphNode().append(...children)),
    ),
  );

const SHAPES: [string, () => LexicalNode[]][] = [
  [
    'a paragraph "a\\nb"',
    () => [$createParagraphNode().append($createTextNode('a\nb'))],
  ],
  [
    'two paragraphs, a line feed in the second',
    () => [
      $createParagraphNode().append($createTextNode('top')),
      $createParagraphNode().append($createTextNode('a\nb')),
    ],
  ],
  [
    'a paragraph "a\\nb" and an equation',
    () => [
      $createParagraphNode().append(
        $createTextNode('a\nb'),
        $createEquation('e'),
      ),
    ],
  ],
  [
    'a paragraph, an equation and "a\\nb"',
    () => [
      $createParagraphNode().append(
        $createEquation('e'),
        $createTextNode('a\nb'),
      ),
    ],
  ],
  [
    'a paragraph "z\\n"',
    () => [$createParagraphNode().append($createTextNode('z\n'))],
  ],
  [
    'a heading "a\\nb"',
    () => [$createHeadingNode('h2').append($createTextNode('a\nb'))],
  ],
  ['a table cell "a\\nb"', () => [$cell($createTextNode('a\nb'))]],
  [
    'a paragraph "a\\nb", then a table',
    () => [
      $createParagraphNode().append($createTextNode('a\nb')),
      $cell($createTextNode('c')),
    ],
  ],
  [
    'a table, then a paragraph "a\\nb"',
    () => [
      $cell($createTextNode('c')),
      $createParagraphNode().append($createTextNode('a\nb')),
    ],
  ],
  [
    'a list item "a\\nb"',
    () => [
      $createListNode('bullet').append(
        $createListItemNode().append($createTextNode('a\nb')),
      ),
    ],
  ],
];

const ROUTES = [
  'initialized into a pristine root',
  'initialized into a used root',
  'initialized into a pristine root, with a node selection',
  'initialized into a used root, with a node selection',
  'set from another editor while bound',
  'parsed and set while bound',
] as const;

function show(editor: LexicalEditor): string {
  return editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map(function d(n: LexicalNode): string {
        return (n as ElementNode).getChildren
          ? `${n.getType()}(${(n as ElementNode).getChildren().map(d).join(' ')})`
          : n.getType() === 'text'
            ? JSON.stringify(n.getTextContent())
            : n.getType();
      })
      .join(' / '),
  );
}

const newEditor = (warnings: string[] = []) =>
  createEditor({
    nodes: NODES,
    onError: e => {
      throw e;
    },
    onWarn: w => warnings.push(w.message),
  });

for (const [name, $make] of SHAPES) {
  for (const route of ROUTES) {
    test(`${name}, ${route}: the editor shows what a fresh reader shows`, async () => {
      const doc = createYDoc();
      if (route.includes('used root')) {
        doc.get('lexical-y').setAttr('used', true);
        doc.get('lexical-y').deleteAttr('used');
      }
      const warnings: string[] = [];
      const editor = newEditor(warnings);
      const binding = new YBinding(editor, doc, {
        schemaVersion: 1,
        selfCheck: true,
      });
      binding.start();
      await flush();
      const source = newEditor();
      source.update(
        () => {
          $getRoot()
            .clear()
            .append(...$make());
          if (route.endsWith('node selection')) {
            const eq = $createEquation('sel');
            ($getRoot().getLastChild() as ElementNode).append(eq);
            const sel = $createNodeSelection();
            sel.add(eq.getKey());
            $setSelection(sel);
          }
        },
        {discrete: true},
      );
      const parsed = () =>
        editor.parseEditorState(
          JSON.stringify(source.getEditorState().toJSON()),
        );
      if (route.endsWith('while bound')) {
        binding.initialize();
        await flush();
        editor.setEditorState(
          route.startsWith('parsed') ? parsed() : source.getEditorState(),
        );
        await flush();
        await new Promise(r => setTimeout(r, 20));
        await flush();
      } else {
        editor.setEditorState(source.getEditorState());
        await flush();
        binding.initialize();
        await flush();
      }
      const d2 = createYDoc();
      Y.applyUpdate(d2, Y.encodeStateAsUpdate(doc));
      const e2 = newEditor();
      const b2 = new YBinding(e2, d2, {schemaVersion: 1, selfCheck: false});
      b2.start();
      await flush();
      expect(show(editor)).toBe(show(e2));
      expect(show(editor)).toMatch(/linebreak/);
      expect(warnings).toEqual([]);
      binding.dispose();
      b2.dispose();
    });
  }
}
