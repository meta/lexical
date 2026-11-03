/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A reader reads text whose stored attributes differ only in format bits as
// one node when the nodes it builds from them show the same (see
// Reader#$showSame): a code highlight shows no bit, so a bit stored over part
// of one does not split it. Whether a class shows a bit is what its own
// setFormat does on the node: a class can forward to TextNode's, keep some
// bits, turn one bit into another, or decide from its own fields, and a
// subclass of a format-less class can bring formats back. Expected formats
// come from each class's setter in an editor without collaboration, not
// from another bound editor.

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
class FieldGatedNode extends TextNode {
  // Set by the constructor: a node an editor builds keeps every bit.
  __keepsFormats: boolean = true;
  $config() {
    return this.config('test-field-gated', {extends: TextNode});
  }
  setFormat(format: TextFormatType | number): this {
    return this.__keepsFormats ? super.setFormat(format) : this;
  }
}
/** Drops every bit, without declaring canHaveFormat() false. */
class UndeclaredDropAllNode extends TextNode {
  $config() {
    return this.config('test-undeclared-drop-all', {extends: TextNode});
  }
  setFormat(_format: TextFormatType | number): this {
    return this;
  }
}
/** Declares it has no format, as CodeHighlightNode does. */
class DropAllNode extends TextNode {
  $config() {
    return this.config('test-drop-all', {extends: TextNode});
  }
  canHaveFormat(): boolean {
    return false;
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
/** A format-less class's subclass that brings formats back. */
class RestoresFormatsNode extends DropAllNode {
  $config() {
    return this.config('test-restores-formats', {extends: DropAllNode});
  }
  setFormat(format: TextFormatType | number): this {
    return TextNode.prototype.setFormat.call(this, format) as this;
  }
}
/** Declares no format but keeps TextNode's setter. */
class DeclaresOnlyNode extends TextNode {
  $config() {
    return this.config('test-declares-only', {extends: TextNode});
  }
  canHaveFormat(): boolean {
    return false;
  }
}

const CLASSES: Klass<TextNode>[] = [
  ForwardFormatNode,
  KeepItalicNode,
  BoldAsItalicNode,
  FieldGatedNode,
  UndeclaredDropAllNode,
  DropAllNode,
  InheritsDropAllNode,
  RestoresFormatsNode,
  DeclaresOnlyNode,
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
      test(`a stored ${name} over part of a node reads as the class shows it`, async () => {
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
        // One node where the class does not show the bit, apart where it
        // does.
        expect(nodesOf(t.b)).toEqual(
          shown === 0
            ? [['alpha beta', 0]]
            : [
                ['alpha ', 0],
                ['beta', shown],
              ],
        );
        expect((await freshReader(t.b)).describe()).toBe(t.b.describe());
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

/** Keeps formats only on text of 8 or more characters. */
class LengthGatedNode extends TextNode {
  $config() {
    return this.config('test-length-gated', {extends: TextNode});
  }
  setFormat(format: TextFormatType | number): this {
    return super.setFormat(this.getTextContent().length >= 8 ? format : 0);
  }
  setTextContent(text: string): this {
    super.setTextContent(text);
    return text.length < 8 ? super.setFormat(0) : this;
  }
}

describe.each([false, true])('a setter that depends on the text, gc %s', gc => {
  // Apart, neither part shows the bold; merged, the node would: the runs
  // stay apart, as on main.
  test('runs merge only where the merged node shows the same', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append(
            $create(LengthGatedNode).setTextContent('alpha beta'),
          ),
        ),
      {gc, nodes: [...NODES, LengthGatedNode]},
    );
    formatRaw(t.a, 'alp', {'f:bold': true});
    await t.sync();
    for (const peer of t.peers) {
      expect(nodesOf(peer).every(([, format]) => format === 0)).toBe(true);
    }
    expect(nodesOf(await freshReader(t.b))).toEqual([
      ['alp', 0],
      ['ha beta', 0],
    ]);
    await expectConverged(t.peers);
  });
});

/** Shows its formats only while its text holds an X. */
class HasXFormatsNode extends TextNode {
  $config() {
    return this.config('test-has-x-formats', {extends: TextNode});
  }
  setFormat(format: TextFormatType | number): this {
    return super.setFormat(this.getTextContent().includes('X') ? format : 0);
  }
}

describe.each([false, true])(
  'a setter that depends on the text content, gc %s',
  gc => {
    // Outside the contract: a TextNode's shown format must not depend on
    // its text content or on where it is attached (the same assumption as
    // TextNode#splitText and mergeWithSibling). "ab" (stored bold) and "cd" show no format apart or
    // merged, so they read as one node; typing X into the plain "cd" makes
    // the merged node show the bold, so a fresh read cuts the line where
    // the author, which does not read its own line again, does not.
    test.fails('typing into a merged node reads back as typed', async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $create(HasXFormatsNode).setTextContent('abcd'),
            ),
          ),
        {gc, nodes: [...NODES, HasXFormatsNode]},
      );
      formatRaw(t.a, 'ab', {'f:bold': true});
      await t.sync();
      t.b.update(() => {
        const node = $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent().includes('cd'))!;
        const i = node.getTextContent().indexOf('cd');
        node.select(i, i).insertText('X');
      });
      await t.sync();
      expect((await freshReader(t.b)).describe()).toBe(t.b.describe());
      await expectConverged(t.peers);
    });
  },
);

/** Shows its formats only while attached. */
class AttachedFormatsNode extends TextNode {
  $config() {
    return this.config('test-attached-formats', {extends: TextNode});
  }
  getFormat(): number {
    return this.getParent() === null ? 0 : super.getFormat();
  }
  setFormat(format: TextFormatType | number): this {
    return super.setFormat(format);
  }
}

describe.each([false, true])(
  'a format that depends on attachment, gc %s',
  gc => {
    // Outside the contract (see above): the nodes $showSame compares are not
    // attached, so they show no format and the runs read as one, and the
    // attached node then shows the first run's bold over both.
    test.fails(
      'a stored bold over part of a node reads where it is stored',
      async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append(
                $create(AttachedFormatsNode).setTextContent('ab'),
              ),
            ),
          {gc, nodes: [...NODES, AttachedFormatsNode]},
        );
        formatRaw(t.a, 'a', {'f:bold': true});
        await t.sync();
        expect(nodesOf(await freshReader(t.b))).toEqual([
          ['a', 1],
          ['b', 0],
        ]);
      },
    );
  },
);
