/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Storage follows the class's declarations; `isInline()` still decides
// where an instance sits. One class declares itself not inline below a
// format class, one flips with a field, one is an inline paragraph.
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  $isTextNode,
  booleanValue,
  ElementNode,
  getDeclaredNodeStructure,
  type LexicalNode,
  nodeSchema,
  ParagraphNode,
  stringValue,
  type TextNode,
  withField,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {
  $block,
  expectConverged,
  NODES,
  type Peer,
  setup,
} from '../utils/harness';

const tagSchema = nodeSchema<TagNode>()({
  tag: withField(stringValue(), {field: '__tag'}),
});

// An inline element declared as a format, like LinkNode.
class TagNode extends ElementNode {
  __tag = '';
  $config() {
    return this.config('test_tag', {
      children: 'inline',
      extends: ElementNode,
      inline: true,
      json: tagSchema,
      mergeAdjacent: {by: ['tag']},
    });
  }
  createDOM(): HTMLElement {
    return $getDocument().createElement('span');
  }
  updateDOM(): boolean {
    return false;
  }
  isInline(): boolean {
    return true;
  }
  setTag(tag: string): this {
    const self = this.getWritable();
    self.__tag = tag;
    return self;
  }
}

// Inherits children and mergeAdjacent from TagNode, but declares itself a
// block: a block holding inline content, so a line.
class BlockTagNode extends TagNode {
  $config() {
    return this.config('test_block_tag', {
      extends: TagNode,
      inline: false,
    });
  }
  isInline(): boolean {
    return false;
  }
}

// Written like an app's subclass from before `inline` existed: it inherits
// TagNode's `inline: true` without declaring it, and its own isInline()
// returns false. It registers, and the inherited key reads as undeclared, so
// it is not stored as a format.
class LegacyBlockTagNode extends TagNode {
  $config() {
    return this.config('test_legacy_block_tag', {extends: TagNode});
  }
  isInline(): boolean {
    return false;
  }
}

const toggleSchema = nodeSchema<ToggleTagNode>()({
  block: withField(booleanValue(), {field: '__block'}),
});

// Inline unless its `block` field is set.
class ToggleTagNode extends TagNode {
  __block = false;
  $config() {
    return this.config('test_toggle_tag', {
      extends: TagNode,
      json: toggleSchema,
    });
  }
  isInline(): boolean {
    return !this.__block;
  }
  setBlock(block: boolean): this {
    const self = this.getWritable();
    self.__block = block;
    return self;
  }
}

// Inherits `children: 'inline'` from ParagraphNode, but is inline.
class InlineParagraphNode extends ParagraphNode {
  $config() {
    return this.config('test_inline_paragraph', {extends: ParagraphNode});
  }
  isInline(): true {
    return true;
  }
}

const nodes = [
  ...NODES,
  TagNode,
  BlockTagNode,
  LegacyBlockTagNode,
  ToggleTagNode,
  InlineParagraphNode,
];

const $toggle = (): ToggleTagNode =>
  $assertNodeType(
    $block([0]).getChildAtIndex(1),
    (node): node is ToggleTagNode => node instanceof ToggleTagNode,
  );

function $text(node: LexicalNode | null): TextNode {
  return $assertNodeType((node as ElementNode).getFirstChild(), $isTextNode);
}

/** The names of the child nodes and the format keys stored in the root. */
/**
 * The stored names: child nodes, and the format keys over the characters
 * (over every child with `onAll`, nodes and markers too).
 */
function stored(peer: Peer, onAll = true): string[] {
  const out = new Set<string>();
  for (const c of peer.binding.root.toArray()) {
    if (c instanceof Y.Node) {
      out.add(c.name);
    }
  }
  const delta = peer.binding.root.toDelta().toJSON() as {
    children?: {insert?: unknown; format?: Record<string, unknown>}[];
  };
  for (const c of delta.children ?? []) {
    if (!onAll && typeof c.insert !== 'string') {
      continue;
    }
    for (const k of Object.keys(c.format ?? {})) {
      out.add(k);
    }
  }
  return [...out].sort();
}

describe('@lexical/y when an instance is not what its class declares', () => {
  test('the declaration is read from the class, never from an instance', () => {
    expect(getDeclaredNodeStructure(BlockTagNode).inline).toBe(false);
    expect(getDeclaredNodeStructure(ToggleTagNode).inline).toBe(true);
    expect(getDeclaredNodeStructure(LegacyBlockTagNode).inline).toBe(undefined);
    expect(getDeclaredNodeStructure(InlineParagraphNode).children).toBe(
      'inline',
    );
  });

  test('a block subclass of a format class is stored as a line', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $create(BlockTagNode).setTag('a').append($createTextNode('abc')),
          $createParagraphNode().append($createTextNode('after')),
        ),
      {nodes},
    );
    expect(stored(t.a)).not.toContain('b:test_block_tag');
    expect(stored(t.a)).not.toContain('w:test_block_tag');
    t.offline();
    t.a.update(() => {
      $text($getRoot().getFirstChild()).spliceText(3, 0, 'X');
    });
    t.b.update(() => {
      $text($getRoot().getFirstChild()).spliceText(0, 0, 'Y');
    });
    await t.sync();
    await expectConverged(
      t.peers,
      'test_block_tag("YabcX") / paragraph("after")',
    );
    expect(t.a.warnings).toEqual([]);
  });

  test('a subclass that inherits inline but returns false from isInline() is not a format', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $create(LegacyBlockTagNode)
            .setTag('a')
            .append($createTextNode('abc')),
          $createParagraphNode().append($createTextNode('after')),
        ),
      {nodes},
    );
    expect(stored(t.a)).not.toContain('test_legacy_block_tag');
    t.offline();
    t.a.update(() => {
      $text($getRoot().getFirstChild()).spliceText(3, 0, 'X');
    });
    t.b.update(() => {
      $text($getRoot().getFirstChild()).spliceText(0, 0, 'Y');
    });
    await t.sync();
    await expectConverged(
      t.peers,
      'test_legacy_block_tag("YabcX") / paragraph("after")',
    );
    expect(t.a.warnings).toEqual([]);
  });

  test('a line class that is inline is stored as an inline node', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('a '),
            $create(InlineParagraphNode).append($createTextNode('in')),
            $createTextNode(' b'),
          ),
        ),
      {nodes},
    );
    expect(stored(t.a)).toContain('i:test_inline_paragraph');
    t.offline();
    t.a.update(() => {
      $text($block([0]).getChildAtIndex(1)).spliceText(2, 0, 'X');
    });
    t.b.update(() => {
      $assertNodeType($block([0]).getLastChild(), $isTextNode).spliceText(
        2,
        0,
        'Y',
      );
    });
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("a " test_inline_paragraph("inX") " bY")',
    );
  });

  test.each([false, true])(
    'an instance whose isInline() flips is written again in its new form (flip back: %s)',
    async flipBack => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('a '),
              $create(ToggleTagNode)
                .setTag('a')
                .append($createTextNode('link')),
              $createTextNode(' b'),
            ),
          ),
        {nodes},
      );
      // Inline: a format over its characters.
      expect(stored(t.a)).toContain('w:test_toggle_tag');
      t.a.update(() => {
        $toggle().setBlock(true);
      });
      await t.sync();
      // Now a block: the normalization lifts it out of the paragraph (a
      // paragraph holds inline content), on the author and on every reader.
      await expectConverged(
        t.peers,
        'paragraph("a ") / test_toggle_tag("link") / paragraph(" b")',
      );
      expect(stored(t.a)).toContain('b:test_toggle_tag');
      // No character carries the inline form any more (the delete of its
      // text leaves its format items, see Cursor#delete).
      expect(stored(t.a, false)).not.toContain('w:test_toggle_tag');
      const $lifted = () =>
        $assertNodeType(
          $getRoot().getChildAtIndex(1),
          (node): node is ToggleTagNode => node instanceof ToggleTagNode,
        );
      expect(t.b.read(() => $lifted().isInline())).toBe(false);
      if (flipBack) {
        t.b.update(() => {
          $lifted().setBlock(false);
        });
        await t.sync();
        await expectConverged(t.peers);
        const d = t.a.describe();
        for (const tok of ['"a "', '"link"', '" b"']) {
          expect(d.split(tok).length - 1).toBe(1);
        }
      }
    },
  );

  // A flip changes the node's representation (its characters are written
  // again), like a move: text a peer types inside it at the same time lands
  // next to it. Nothing is lost and every peer converges; the block is then
  // lifted out of the paragraph.
  test.each([
    [[1, 2], 'causal'],
    [[2, 1], 'causal'],
    [[1, 2], 'sender'],
    [[2, 1], 'sender'],
  ] as const)(
    'a flip races typing inside the node (ids %j, %s)',
    async (ids, delivery) => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('a '),
              $create(ToggleTagNode)
                .setTag('a')
                .append($createTextNode('link')),
              $createTextNode(' b'),
            ),
          ),
        {delivery, ids: [...ids], nodes},
      );
      t.offline();
      t.a.update(() => {
        $toggle().setBlock(true);
      });
      t.b.update(() => {
        $text($toggle()).spliceText(4, 0, 'Z');
      });
      await t.sync();
      // The flipping client's own update lifts the node out of the paragraph
      // (the normalization runs on what it writes), as a delete and a
      // re-insert of its text: "Z", typed after that text, lands on one side
      // of the node or the other depending on the client ids, as any
      // concurrent insert at a deleted position does, and keeps the format it
      // was typed with, the inline form (a delete keeps the format items
      // around the deleted text, see Cursor#delete).
      await expectConverged(
        t.peers,
        ids[0] === 1
          ? 'paragraph("a ") / test_toggle_tag("link") / paragraph(test_toggle_tag("Z") " b")'
          : 'paragraph("a " test_toggle_tag("Z")) / test_toggle_tag("link") / paragraph(" b")',
      );
      expect(
        t.a.read(() =>
          $assertNodeType(
            $getRoot().getChildAtIndex(1),
            (node): node is ToggleTagNode => node instanceof ToggleTagNode,
          ).isInline(),
        ),
      ).toBe(false);
    },
  );
});
