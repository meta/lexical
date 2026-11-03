/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A reader leaves out of its node boundaries only the format bits a text
// class does not keep, judged by what the class's own setFormat does with
// each bit (see textFormatKept). Overriding setFormat is not enough to drop
// them: a class can forward to TextNode's, keep some bits, or turn one bit
// into another. Expectations come from each class's setter in an editor
// without collaboration, not from another bound editor.

import {
  $create,
  $createParagraphNode,
  $getRoot,
  createEditor,
  type Klass,
  TEXT_TYPE_TO_FORMAT,
  type TextFormatType,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  expectConverged,
  freshReader,
  NODES,
  type Peer,
  setup,
} from '../../utils/harness';

const bitsOf = (format: TextFormatType | number) =>
  typeof format === 'number' ? format : TEXT_TYPE_TO_FORMAT[format];

class ForwardFormatNode extends TextNode {
  $config() {
    return this.config('test-forward-format', {extends: TextNode});
  }
  setFormat(format: TextFormatType | number): this {
    return super.setFormat(format);
  }
}
class KeepItalicNode extends TextNode {
  $config() {
    return this.config('test-keep-italic', {extends: TextNode});
  }
  setFormat(format: TextFormatType | number): this {
    return super.setFormat(bitsOf(format) & TEXT_TYPE_TO_FORMAT.italic);
  }
}
class DropAllNode extends TextNode {
  $config() {
    return this.config('test-drop-all', {extends: TextNode});
  }
  setFormat(_format: TextFormatType | number): this {
    return this;
  }
}
class InheritsDropAllNode extends DropAllNode {
  $config() {
    return this.config('test-inherits-drop-all', {extends: DropAllNode});
  }
}
class BoldAsItalicNode extends TextNode {
  $config() {
    return this.config('test-bold-as-italic', {extends: TextNode});
  }
  setFormat(format: TextFormatType | number): this {
    const bits = bitsOf(format);
    return super.setFormat(
      bits & TEXT_TYPE_TO_FORMAT.bold
        ? (bits & ~TEXT_TYPE_TO_FORMAT.bold) | TEXT_TYPE_TO_FORMAT.italic
        : bits,
    );
  }
}
class ThrowingSetterNode extends TextNode {
  $config() {
    return this.config('test-throwing-setter', {extends: TextNode});
  }
  setFormat(format: TextFormatType | number): this {
    // Only a node an editor created has a key: a probe without one throws.
    if (this.__key === undefined) {
      throw new Error('no key');
    }
    return super.setFormat(format);
  }
}

const CLASSES: Klass<TextNode>[] = [
  ForwardFormatNode,
  KeepItalicNode,
  DropAllNode,
  InheritsDropAllNode,
  BoldAsItalicNode,
  ThrowingSetterNode,
];

/** What `klass` shows for `format`, in an editor without collaboration. */
function shownBy(klass: Klass<TextNode>, format: number): number {
  const editor = createEditor({
    nodes: [klass],
    onError: e => {
      throw e;
    },
  });
  let shown = -1;
  editor.update(
    () => {
      const node = $create(klass).setTextContent('x').setFormat(format);
      $getRoot().append($createParagraphNode().append(node));
      shown = node.getFormat();
    },
    {discrete: true},
  );
  return shown;
}

type RawRoot = {
  format(at: number, length: number, attrs: object): void;
  toDelta(): {children: {insert: unknown}[]};
};

function formatRaw(p: Peer, text: string, attrs: object) {
  const root = p.doc.get('lexical-y') as unknown as RawRoot;
  const flat = root
    .toDelta()
    .children.map(piece =>
      typeof piece.insert === 'string' ? piece.insert : '\u0001',
    )
    .join('');
  const at = flat.indexOf(text);
  expect(at).toBeGreaterThanOrEqual(0);
  p.doc.transact(() => root.format(at, text.length, attrs), 'outside');
}

const nodesOf = (p: Peer) =>
  p.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => [n.getTextContent(), n.getFormat()]),
  );

for (const klass of CLASSES) {
  describe.each([false, true])(`${klass.name}, gc %s`, gc => {
    const nodes = [...NODES, klass];

    test('a stored format reads as the class shows it', async () => {
      const bold = TEXT_TYPE_TO_FORMAT.bold;
      const italic = TEXT_TYPE_TO_FORMAT.italic;
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $create(klass)
                .setTextContent('alpha beta')
                .setFormat(bold | italic),
            ),
          ),
        {gc, nodes},
      );
      const expected = [['alpha beta', shownBy(klass, bold | italic)]];
      expect(nodesOf(t.a)).toEqual(expected);
      expect(nodesOf(t.b)).toEqual(expected);
      expect(nodesOf(await freshReader(t.b))).toEqual(expected);
      await expectConverged(t.peers);
    });

    for (const name of ['bold', 'italic'] as const) {
      test(`a stored ${name} over part of a node splits it only where the class shows it`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append(
                $create(klass).setTextContent('alpha beta'),
              ),
            ),
          {gc, nodes},
        );
        formatRaw(t.a, 'beta', {[`f:${name}`]: true});
        await t.sync();
        const shown = shownBy(klass, TEXT_TYPE_TO_FORMAT[name]);
        const expected =
          shown === 0
            ? [['alpha beta', 0]]
            : [
                ['alpha ', 0],
                ['beta', shown],
              ];
        expect(nodesOf(t.b)).toEqual(expected);
        // Typing at the start of the formatted part reads back as typed.
        t.b.update(() => {
          const node = $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent().includes('beta'))!;
          const i = node.getTextContent().indexOf('beta');
          node.select(i, i).insertText('X');
        });
        await t.sync();
        const fresh = await freshReader(t.b);
        expect(fresh.describe()).toBe(t.b.describe());
        await expectConverged(t.peers);
        expect(t.b.warnings.filter(w => /self-check/.test(w))).toEqual([]);
      });
    }
  });
}
