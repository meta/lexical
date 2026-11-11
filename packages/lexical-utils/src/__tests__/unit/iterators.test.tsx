/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$firstToLastIterator, $lastToFirstIterator} from '@lexical/utils';
import {
  $createParagraphNode,
  $createTextNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  TextNode,
} from 'lexical';
import {createTestEditor} from 'lexical/src/__tests__/utils';
import {beforeEach, describe, expect, it} from 'vitest';

function assertClass<T extends LexicalNode>(v: unknown, klass: Klass<T>): T {
  if (v instanceof klass) {
    return v as T;
  }
  throw new Error(`Value does not extend ${klass.name}`);
}

describe('$firstToLastIterator', () => {
  let editor: LexicalEditor;

  beforeEach(async () => {
    editor = createTestEditor();
    editor._headless = true;
  });

  it(`Iterates from first to last`, () => {
    editor.update(
      () => {
        const parent = $createParagraphNode().splice(
          0,
          0,
          Array.from({length: 5}, (_v, i) => $createTextNode(`${i}`)),
        );
        // Check initial state
        expect(
          parent.getAllTextNodes().map(node => node.getTextContent()),
        ).toEqual(['0', '1', '2', '3', '4']);
        expect(
          Array.from($firstToLastIterator(parent), node => {
            return assertClass(node, TextNode).getTextContent();
          }),
        ).toEqual(['0', '1', '2', '3', '4']);
        // Parent was not affected
        expect(
          parent.getAllTextNodes().map(node => node.getTextContent()),
        ).toEqual(['0', '1', '2', '3', '4']);
      },
      {discrete: true},
    );
  });
  it(`Can handle node removal`, () => {
    editor.update(
      () => {
        const parent = $createParagraphNode().splice(
          0,
          0,
          Array.from({length: 5}, (_v, i) => $createTextNode(`${i}`)),
        );
        // Check initial state
        expect(
          parent.getAllTextNodes().map(node => node.getTextContent()),
        ).toEqual(['0', '1', '2', '3', '4']);
        expect(
          Array.from($firstToLastIterator(parent), node => {
            const rval = assertClass(node, TextNode).getTextContent();
            node.remove();
            return rval;
          }),
        ).toEqual(['0', '1', '2', '3', '4']);
        expect(parent.getChildren()).toEqual([]);
      },
      {discrete: true},
    );
  });
  it(`Detects cycles when nodes move incorrectly`, () => {
    editor.update(
      () => {
        const parent = $createParagraphNode().splice(
          0,
          0,
          Array.from({length: 5}, (_v, i) => $createTextNode(`${i}`)),
        );
        // Check initial state
        expect(
          parent.getAllTextNodes().map(node => node.getTextContent()),
        ).toEqual(['0', '1', '2', '3', '4']);
        expect(() =>
          Array.from($firstToLastIterator(parent), node => {
            const rval = assertClass(node, TextNode).getTextContent();
            parent.append(node);
            return rval;
          }),
        ).toThrow(/\$childIterator: Cycle detected/);
      },
      {discrete: true},
    );
  });
  it(`Can handle nodes moving in the other direction`, () => {
    editor.update(
      () => {
        const parent = $createParagraphNode().splice(
          0,
          0,
          Array.from({length: 5}, (_v, i) => $createTextNode(`${i}`)),
        );
        // Check initial state
        expect(
          parent.getAllTextNodes().map(node => node.getTextContent()),
        ).toEqual(['0', '1', '2', '3', '4']);
        expect(
          Array.from($firstToLastIterator(parent), node => {
            const rval = assertClass(node, TextNode).getTextContent();
            if (node.getPreviousSibling() !== null) {
              parent.splice(0, 0, [node]);
            }
            return rval;
          }),
        ).toEqual(['0', '1', '2', '3', '4']);
        // This mutation reversed the nodes while traversing
        expect(
          parent.getAllTextNodes().map(node => node.getTextContent()),
        ).toEqual(['4', '3', '2', '1', '0']);
      },
      {discrete: true},
    );
  });
});

describe('$lastToFirstIterator', () => {
  let editor: LexicalEditor;

  beforeEach(async () => {
    editor = createTestEditor();
    editor._headless = true;
  });

  it(`Iterates from last to first`, () => {
    editor.update(
      () => {
        const parent = $createParagraphNode().splice(
          0,
          0,
          Array.from({length: 5}, (_v, i) => $createTextNode(`${i}`)),
        );
        // Check initial state
        expect(
          parent.getAllTextNodes().map(node => node.getTextContent()),
        ).toEqual(['0', '1', '2', '3', '4']);
        expect(
          Array.from($lastToFirstIterator(parent), node => {
            return assertClass(node, TextNode).getTextContent();
          }),
        ).toEqual(['4', '3', '2', '1', '0']);
        // Parent was not affected
        expect(
          parent.getAllTextNodes().map(node => node.getTextContent()),
        ).toEqual(['0', '1', '2', '3', '4']);
      },
      {discrete: true},
    );
  });
  it(`Can handle node removal`, () => {
    editor.update(
      () => {
        const parent = $createParagraphNode().splice(
          0,
          0,
          Array.from({length: 5}, (_v, i) => $createTextNode(`${i}`)),
        );
        // Check initial state
        expect(
          parent.getAllTextNodes().map(node => node.getTextContent()),
        ).toEqual(['0', '1', '2', '3', '4']);
        expect(
          Array.from($lastToFirstIterator(parent), node => {
            const rval = assertClass(node, TextNode).getTextContent();
            node.remove();
            return rval;
          }),
        ).toEqual(['4', '3', '2', '1', '0']);
        expect(parent.getChildren()).toEqual([]);
      },
      {discrete: true},
    );
  });
  it(`Can handle nodes moving in the other direction`, () => {
    editor.update(
      () => {
        const parent = $createParagraphNode().splice(
          0,
          0,
          Array.from({length: 5}, (_v, i) => $createTextNode(`${i}`)),
        );
        // Check initial state
        expect(
          parent.getAllTextNodes().map(node => node.getTextContent()),
        ).toEqual(['0', '1', '2', '3', '4']);
        expect(
          Array.from($lastToFirstIterator(parent), node => {
            const rval = assertClass(node, TextNode).getTextContent();
            parent.append(node);
            return rval;
          }),
        ).toEqual(['4', '3', '2', '1', '0']);
        // This mutation reversed the nodes while traversing
        expect(
          parent.getAllTextNodes().map(node => node.getTextContent()),
        ).toEqual(['4', '3', '2', '1', '0']);
      },
      {discrete: true},
    );
  });
});
