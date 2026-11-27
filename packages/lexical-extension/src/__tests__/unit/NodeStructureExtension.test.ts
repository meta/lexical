/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$createCodeNode, CodeNode} from '@lexical/code-core';
import {
  $createHorizontalRuleNode,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  HorizontalRuleExtension,
  HorizontalRuleNode,
  NodeStructureExtension,
  registerNodeStructure,
} from '@lexical/extension';
import {
  $createAutoLinkNode,
  $createLinkNode,
  AutoLinkNode,
  LinkExtension,
  LinkNode,
  type SerializedLinkNode,
} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $isListNode,
  ListExtension,
  ListItemNode,
  ListNode,
  type ListType,
  type SerializedListNode,
} from '@lexical/list';
import {$createMarkNode, MarkNode} from '@lexical/mark';
import {$createOverflowNode, OverflowNode} from '@lexical/overflow';
import {
  $createHeadingNode,
  $createQuoteNode,
  HeadingNode,
  QuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  TableCellNode,
  TableExtension,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getDocument,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  $setState,
  type AnyLexicalExtension,
  booleanValue,
  configExtension,
  createEditor,
  createState,
  DecoratorNode,
  ElementNode,
  getDeclaredNodeStructure,
  INTERNAL_$normalizeNodeStructure,
  INTERNAL_isNodeStructureEnforced,
  type LexicalNode,
  type NodeKey,
  nodeSchema,
  numberValue,
  ParagraphNode,
  type RangeSelection,
  type SerializedParagraphNode,
  stringValue,
  withField,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test} from 'vitest';

function shape(node: LexicalNode): unknown {
  const json = node.exportJSON() as unknown as Record<string, unknown>;
  if (node instanceof ElementNode) {
    return [node.getType(), ...node.getChildren().map(shape)];
  }
  return json.text !== undefined ? String(json.text) : node.getType();
}

function build($init: () => void, withStructure: boolean) {
  const deps: AnyLexicalExtension[] = [
    RichTextExtension,
    ListExtension,
    LinkExtension,
    TableExtension,
    HorizontalRuleExtension,
  ];
  if (withStructure) {
    deps.push(NodeStructureExtension);
  }
  return buildEditorFromExtensions({
    $initialEditorState: $init,
    dependencies: deps,
    name: 'node-structure-test',
    nodes: [CodeNode, OverflowNode],
    onError: e => {
      throw e;
    },
  });
}

function rootShape(editor: ReturnType<typeof build>): unknown {
  return editor.read(() => $getRoot().getChildren().map(shape));
}

function listValues(editor: ReturnType<typeof build>): unknown[] {
  return editor.read(() =>
    $getRoot()
      .getChildren()
      .map(n =>
        $isListNode(n)
          ? n.getChildren().map(c => (c as ListItemNode).getValue())
          : n.getType(),
      ),
  );
}

function listStarts(editor: ReturnType<typeof build>): unknown[] {
  return editor.read(() =>
    $getRoot()
      .getChildren()
      .map(n =>
        $isListNode(n)
          ? [
              n.getStart(),
              ...n.getChildren().map(c => (c as ListItemNode).getTextContent()),
            ]
          : n.getType(),
      ),
  );
}

const $numbered = (
  start: number,
  ...items: (string | (() => LexicalNode[]))[]
) =>
  $getRoot().append(
    $createListNode('number', start).append(
      ...items.map(item =>
        $createListItemNode().append(
          ...(typeof item === 'string' ? [$createTextNode(item)] : item()),
        ),
      ),
    ),
  );

const $paragraphWithRule = () => {
  $getRoot()
    .clear()
    .append(
      $createParagraphNode().append(
        $createTextNode('a'),
        $createHorizontalRuleNode(),
        $createTextNode('b'),
      ),
    );
};

describe('declarations', () => {
  test("Lexical's own nodes", () => {
    expect(getDeclaredNodeStructure(ParagraphNode).children).toBe('inline');
    expect(getDeclaredNodeStructure(HeadingNode).children).toBe('inline');
    expect(getDeclaredNodeStructure(QuoteNode).children).toBe('inline');
    expect(getDeclaredNodeStructure(CodeNode).children).toBe('inline');
    expect(getDeclaredNodeStructure(TableCellNode).children).toBe('block');
    expect(getDeclaredNodeStructure(ListNode).children).toEqual([ListItemNode]);
    expect(getDeclaredNodeStructure(ListNode).mergeAdjacent).toEqual({
      by: ['listType'],
    });
    expect(getDeclaredNodeStructure(ListItemNode).children).toEqual([
      'inline',
      ListNode,
    ]);
    const link = getDeclaredNodeStructure(LinkNode);
    expect(link.inline).toBe(true);
    expect(link.mergeAdjacent!.by).toEqual(['url', 'target', 'rel', 'title']);
    // AutoLinkNode inherits inline/children but turns the merge off.
    const auto = getDeclaredNodeStructure(AutoLinkNode);
    expect(auto.inline).toBe(true);
    expect(auto.children).toBe('inline');
    expect(auto.mergeAdjacent).toBeUndefined();
    expect(getDeclaredNodeStructure(MarkNode).inline).toBe(true);
    // OverflowNode declares nothing (the normalization knows it, see below).
    expect(getDeclaredNodeStructure(OverflowNode)).toEqual({
      declaredBy: {},
      derived: new Set(),
    });
  });

  test('derived fields', () => {
    expect(getDeclaredNodeStructure(ListItemNode).derived).toEqual(
      new Set(['indent', 'value']),
    );
    expect(getDeclaredNodeStructure(ListNode).derived).toEqual(new Set());
    expect(createState('n', {derived: true, parse: Number}).derived).toBe(true);
    expect(createState('n', {parse: Number}).derived).toBe(false);
  });

  test('a class that declares inline gets an isInline() that returns it', () => {
    class Chip extends ElementNode {
      $config() {
        return this.config('test-chip', {extends: ElementNode, inline: true});
      }
    }
    class Box extends ElementNode {
      $config() {
        return this.config('test-box', {extends: ElementNode});
      }
    }
    const editor = createEditor({
      nodes: [Chip, Box],
      onError: e => {
        throw e;
      },
    });
    editor.update(
      () => {
        expect($create(Chip).isInline()).toBe(true);
        expect($create(Box).isInline()).toBe(false);
      },
      {discrete: true},
    );
  });
});

describe('validation at editor creation', () => {
  test('mergeAdjacent.by names an unknown field', () => {
    class Bad extends ElementNode {
      $config() {
        return this.config('test-bad-by', {
          extends: ElementNode,
          mergeAdjacent: {by: ['nope']},
        });
      }
    }
    expect(() => createEditor({nodes: [Bad]})).toThrow(/not a schema field/);
  });

  test('mergeAdjacent.by names a derived field or state', () => {
    const derived = createState('d', {derived: true, parse: Number});
    class Bad extends ElementNode {
      $config() {
        return this.config('test-bad-derived', {
          extends: ElementNode,
          mergeAdjacent: {by: [derived]},
        });
      }
    }
    expect(() => createEditor({nodes: [Bad]})).toThrow(/derived/);
  });

  test('declared inline disagrees with isInline()', () => {
    class Bad extends ElementNode {
      $config() {
        return this.config('test-bad-inline', {
          extends: ElementNode,
          inline: true,
        });
      }
      isInline(): boolean {
        return false;
      }
    }
    expect(() => createEditor({nodes: [Bad]})).toThrow(/isInline/);
  });

  test("a merging group's children must hold inline content", () => {
    class Item extends ElementNode {
      $config() {
        return this.config('test-item', {
          children: 'block',
          extends: ElementNode,
        });
      }
    }
    class Group extends ElementNode {
      $config() {
        return this.config('test-group', {
          children: [Item],
          extends: ElementNode,
          mergeAdjacent: {by: ['format']},
        });
      }
    }
    expect(() => createEditor({nodes: [Item, Group]})).toThrow(
      /hold inline content/,
    );
  });
});

describe('existing subclasses that inherit a declaration', () => {
  // Classes written before the node-structure keys existed must register
  // exactly as before: an inherited declaration never throws, and a key the
  // class contradicts reads as undeclared for it.
  const nodes = [LinkNode, ListNode, ListItemNode];
  const strict = (e: Error) => {
    throw e;
  };

  class BlockLinkNode extends LinkNode {
    static getType(): string {
      return 'test-block-link';
    }
    static clone(node: BlockLinkNode): BlockLinkNode {
      return new BlockLinkNode(
        node.__url,
        {rel: node.__rel, target: node.__target, title: node.__title},
        node.__key,
      );
    }
    static importJSON(json: SerializedLinkNode): BlockLinkNode {
      return new BlockLinkNode(json.url).updateFromJSON(json);
    }
    // @ts-expect-error LinkNode types isInline() as true; an app subclass
    // written in JavaScript, or with a cast, can still return false.
    isInline(): boolean {
      return false;
    }
  }

  test('a LinkNode subclass whose isInline() returns false', () => {
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        $getRoot().append(
          new BlockLinkNode('https://a').append(
            $createParagraphNode().append($createTextNode('x')),
          ),
        );
      },
      dependencies: [RichTextExtension, ListExtension, LinkExtension],
      name: 'block-link',
      nodes: [BlockLinkNode],
      onError: strict,
    });
    expect(() =>
      createEditor({nodes: [...nodes, BlockLinkNode]}),
    ).not.toThrow();
    const declared = getDeclaredNodeStructure(BlockLinkNode);
    expect(declared.inline).toBeUndefined();
    expect(declared.declaredBy.inline).toBeUndefined();
    // The other inherited keys stay (they agree with the class).
    expect(declared.children).toBe('inline');
    expect(declared.mergeAdjacent!.by).toEqual([
      'url',
      'target',
      'rel',
      'title',
    ]);
    editor.read(() => {
      expect($getRoot().getFirstChildOrThrow().isInline()).toBe(false);
    });
    // LinkNode itself still declares it.
    expect(getDeclaredNodeStructure(LinkNode).inline).toBe(true);
  });

  test('a ListNode subclass with an extra field and a legacy exportJSON', () => {
    class LabeledListNode extends ListNode {
      __label: string;
      constructor(
        listType: ListType = 'bullet',
        start: number = 1,
        key?: NodeKey,
      ) {
        super(listType, start, key);
        this.__label = '';
      }
      static getType(): string {
        return 'test-labeled-list';
      }
      static clone(node: LabeledListNode): LabeledListNode {
        const clone = new LabeledListNode(
          node.__listType,
          node.__start,
          node.__key,
        );
        clone.__label = node.__label;
        return clone;
      }
      static importJSON(
        json: SerializedListNode & {label: string},
      ): LabeledListNode {
        const node = new LabeledListNode().updateFromJSON(json);
        node.__label = json.label;
        return node;
      }
      exportJSON(): SerializedListNode & {label: string} {
        return {...super.exportJSON(), label: this.__label};
      }
    }
    const editor = createEditor({
      nodes: [...nodes, LabeledListNode],
      onError: strict,
    });
    editor.update(
      () => {
        const list = new LabeledListNode('number');
        list.__label = 't';
        $getRoot().append(
          list.append($createListItemNode().append($createTextNode('a'))),
        );
      },
      {discrete: true},
    );
    const json = editor.getEditorState().toJSON();
    expect(json.root.children[0]).toMatchObject({
      label: 't',
      listType: 'number',
      type: 'test-labeled-list',
    });
    const restored = createEditor({
      nodes: [...nodes, LabeledListNode],
      onError: strict,
    });
    restored.setEditorState(restored.parseEditorState(json));
    expect(restored.getEditorState().toJSON()).toEqual(json);
  });

  test('a ParagraphNode subclass whose isInline() returns true', () => {
    class InlineParagraphNode extends ParagraphNode {
      static getType(): string {
        return 'test-inline-paragraph';
      }
      static clone(node: InlineParagraphNode): InlineParagraphNode {
        return new InlineParagraphNode(node.__key);
      }
      static importJSON(json: SerializedParagraphNode): InlineParagraphNode {
        return new InlineParagraphNode().updateFromJSON(json);
      }
      isInline(): boolean {
        return true;
      }
    }
    const editor = createEditor({
      nodes: [...nodes, InlineParagraphNode],
      onError: strict,
    });
    editor.update(
      () => {
        const node = new InlineParagraphNode();
        $getRoot().append($createParagraphNode().append(node));
        expect(node.isInline()).toBe(true);
      },
      {discrete: true},
    );
    expect(
      getDeclaredNodeStructure(InlineParagraphNode).inline,
    ).toBeUndefined();
  });

  test('a subclass that declares the key itself is still checked', () => {
    class Bad extends LinkNode {
      $config() {
        return this.config('test-bad-own-inline', {
          extends: LinkNode,
          inline: false,
        });
      }
      isInline(): true {
        return true;
      }
    }
    expect(() => createEditor({nodes: [LinkNode, Bad]})).toThrow(/isInline/);
  });

  test('isInline() is synthesized only for a class that declares inline itself', () => {
    class Chip extends ElementNode {
      $config() {
        return this.config('test-own-chip', {
          extends: ElementNode,
          inline: true,
        });
      }
    }
    class SubChip extends Chip {
      $config() {
        return this.config('test-sub-chip', {extends: Chip});
      }
    }
    class ModernLink extends LinkNode {
      $config() {
        return this.config('test-modern-link', {extends: LinkNode});
      }
    }
    class PlainBox extends ParagraphNode {
      $config() {
        return this.config('test-plain-box', {extends: ParagraphNode});
      }
    }
    createEditor({
      nodes: [Chip, SubChip, LinkNode, ModernLink, PlainBox, BlockLinkNode],
      onError: strict,
    });
    const own = (k: {prototype: object}) =>
      Object.prototype.hasOwnProperty.call(k.prototype, 'isInline');
    expect(own(Chip)).toBe(true);
    for (const k of [SubChip, ModernLink, PlainBox, ParagraphNode]) {
      expect(own(k)).toBe(false);
    }
    // BlockLinkNode's own isInline() is untouched.
    expect(BlockLinkNode.prototype.isInline()).toBe(false);
    expect(PlainBox.prototype.isInline).toBe(ElementNode.prototype.isInline);
  });
});

describe('NodeStructureExtension', () => {
  const $paraWithTable = () => {
    const table = $createTableNode().append(
      $createTableRowNode().append(
        $createTableCellNode().append(
          $createParagraphNode().append($createTextNode('cell')),
        ),
      ),
    );
    $getRoot().append(
      $createParagraphNode().append(
        $createTextNode('before'),
        table,
        $createTextNode('after'),
      ),
    );
  };

  test('off by default: a block in a paragraph stays', () => {
    using editor = build($paraWithTable, false);
    expect(rootShape(editor)).toEqual([
      [
        'paragraph',
        'before',
        ['table', ['tablerow', ['tablecell', ['paragraph', 'cell']]]],
        'after',
      ],
    ]);
  });

  test('a block in a paragraph is lifted out (paragraph split)', () => {
    using editor = build($paraWithTable, true);
    expect(rootShape(editor)).toEqual([
      ['paragraph', 'before'],
      ['table', ['tablerow', ['tablecell', ['paragraph', 'cell']]]],
      ['paragraph', 'after'],
    ]);
  });

  test('an OverflowNode stays in its paragraph', () => {
    using editor = build(() => {
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('within'),
          $createOverflowNode().append($createTextNode('over')),
        ),
      );
    }, true);
    expect(rootShape(editor)).toEqual([
      ['paragraph', 'within', ['overflow', 'over']],
    ]);
    editor.read(() => {
      const overflow = $assertNodeType(
        $getRoot().getFirstChildOrThrow(),
        $isElementNode,
      ).getLastChild();
      // Its behaviour is unchanged: still not inline for the caret.
      expect(overflow!.isInline()).toBe(false);
    });
  });

  test('inline content in a table cell is wrapped in a paragraph', () => {
    using editor = build(() => {
      $getRoot().append(
        $createTableNode().append(
          $createTableRowNode().append(
            $createTableCellNode().append(
              $createTextNode('a'),
              $createParagraphNode().append($createTextNode('b')),
              $createTextNode('c'),
            ),
          ),
        ),
      );
    }, true);
    expect(rootShape(editor)).toEqual([
      [
        'table',
        [
          'tablerow',
          [
            'tablecell',
            ['paragraph', 'a'],
            ['paragraph', 'b'],
            ['paragraph', 'c'],
          ],
        ],
      ],
    ]);
  });

  test('a shadow root quote keeps its blocks', () => {
    using editor = build(() => {
      $getRoot().append(
        $createQuoteNode({shadowRoot: true}).append(
          $createParagraphNode().append($createTextNode('one')),
          $createParagraphNode().append($createTextNode('two')),
        ),
      );
    }, true);
    expect(rootShape(editor)).toEqual([
      ['quote', ['paragraph', 'one'], ['paragraph', 'two']],
    ]);
  });

  test('paragraphs in a list item become lines of the item', () => {
    using editor = build(() => {
      const x = $createTextNode('x');
      $getRoot().append(
        $createListNode('bullet').append($createListItemNode().append(x)),
      );
      // insertAfter, not ListItemNode.append (which unwraps blocks itself).
      const p = $createParagraphNode().append($createTextNode('p'));
      x.insertAfter(p);
      p.insertAfter($createParagraphNode().append($createTextNode('q')));
    }, true);
    // As the HTML import of <li>x<p>p</p><p>q</p></li> gives.
    expect(rootShape(editor)).toEqual([
      ['list', ['listitem', 'x', 'linebreak', 'p', 'linebreak', 'q']],
    ]);
  });

  test('a table in a list item is lifted out of the list', () => {
    using editor = build(() => {
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('x')),
          $createListItemNode().append(
            $createTableNode().append(
              $createTableRowNode().append(
                $createTableCellNode().append(
                  $createParagraphNode().append($createTextNode('c')),
                ),
              ),
            ),
          ),
          $createListItemNode().append($createTextNode('y')),
        ),
      );
    }, true);
    const shapes = rootShape(editor) as unknown[];
    // No text lost or duplicated, and the table is no longer in the list.
    expect(JSON.stringify(shapes).match(/"[xyc]"/g)).toEqual([
      '"x"',
      '"c"',
      '"y"',
    ]);
    expect((shapes as unknown[][]).map(s => s[0])).toContain('table');
  });

  test('a heading inside a link becomes a heading holding the link', () => {
    using editor = build(() => {
      $getRoot().append(
        $createParagraphNode().append(
          $createLinkNode('https://a').append(
            $createHeadingNode('h1').append($createTextNode('Lexical')),
          ),
        ),
      );
    }, true);
    expect(rootShape(editor)).toEqual([['heading', ['link', 'Lexical']]]);
    expect(
      editor.read(() =>
        ($getRoot().getAllTextNodes()[0].getParent() as LinkNode).getURL(),
      ),
    ).toBe('https://a');
  });

  test('a quote holding paragraphs stays one quote, with line breaks', () => {
    using editor = build(() => {
      $getRoot().append(
        $createQuoteNode().append(
          $createParagraphNode().append($createTextNode('a')),
          $createParagraphNode().append($createTextNode('b')),
        ),
        $createQuoteNode().append(
          $createTextNode('x'),
          $createParagraphNode().append($createTextNode('c')),
          $createTextNode('y'),
        ),
      );
    }, true);
    // As markdown's "> a\n>\n> b" imports (and Shift+Enter in a quote).
    expect(rootShape(editor)).toEqual([
      ['quote', 'a', 'linebreak', 'b'],
      ['quote', 'x', 'linebreak', 'c', 'linebreak', 'y'],
    ]);
  });

  test('an empty paragraph in a quote keeps its line', () => {
    using editor = build(() => {
      const empty = $createParagraphNode();
      $getRoot().append(
        $createQuoteNode().append(
          $createParagraphNode(),
          $createParagraphNode().append($createTextNode('a')),
          empty,
        ),
      );
      empty.select();
    }, true);
    expect(rootShape(editor)).toEqual([
      ['quote', 'linebreak', 'a', 'linebreak'],
    ]);
    editor.read(() => {
      // The caret that was in the last (empty) paragraph is on that line.
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      const quote = $getRoot().getFirstChildOrThrow();
      expect([selection.anchor.key, selection.anchor.offset]).toEqual([
        quote.getKey(),
        3,
      ]);
    });
  });

  test('typed blocks inside a quote are split around and keep their type', () => {
    using editor = build(() => {
      $getRoot().append(
        $createQuoteNode().append(
          $createParagraphNode().append($createTextNode('a')),
          $createHeadingNode('h2').append($createTextNode('h')),
          $createParagraphNode().append($createTextNode('b')),
          $createCodeNode().append($createTextNode('c')),
          $createQuoteNode().append($createTextNode('q')),
          $createParagraphNode().append($createTextNode('d')),
        ),
      );
    }, true);
    expect(rootShape(editor)).toEqual([
      ['quote', 'a'],
      ['heading', 'h'],
      ['quote', 'b'],
      ['code', 'c'],
      ['quote', 'q'],
      ['quote', 'd'],
    ]);
  });

  test('paragraphs in other blocks that hold inline content become lines', () => {
    using editor = build(() => {
      $getRoot().append(
        $createCodeNode().append(
          $createParagraphNode().append($createTextNode('one')),
          $createParagraphNode().append($createTextNode('two')),
        ),
        $createHeadingNode('h1').append(
          $createTextNode('x'),
          $createLineBreakNode(),
          $createParagraphNode().append($createTextNode('y')),
        ),
      );
    }, true);
    expect(rootShape(editor)).toEqual([
      ['code', 'one', 'linebreak', 'two'],
      ['heading', 'x', 'linebreak', 'linebreak', 'y'],
    ]);
  });

  test('a list item inside a paragraph is lifted without throwing', () => {
    using editor = build(() => {
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('a'),
          $createListItemNode().append($createTextNode('item')),
          $createTextNode('b'),
        ),
      );
    }, true);
    expect(rootShape(editor)).toEqual([
      ['paragraph', 'a'],
      ['list', ['listitem', 'item']],
      ['paragraph', 'b'],
    ]);
  });

  test('a caret between two merged links stays between their contents', () => {
    using editor = build(() => {
      const p = $createParagraphNode().append(
        $createLinkNode('https://a').append($createTextNode('one')),
        $createLinkNode('https://a').append($createTextNode('two')),
      );
      $getRoot().append(p);
      p.select(1, 1);
    }, true);
    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      const point = selection.anchor;
      const node = point.getNode();
      // At the boundary: after "one", not after "onetwo".
      const text = node.getTextContent().slice(0, point.offset);
      expect(['one', 'onetwo'].includes(text) ? text : point.type).not.toBe(
        'onetwo',
      );
    });
  });

  test('adjacent equal links merge; different ones do not', () => {
    using editor = build(() => {
      $getRoot().append(
        $createParagraphNode().append(
          $createLinkNode('https://a').append($createTextNode('1')),
          $createLinkNode('https://a').append($createTextNode('2')),
          $createLinkNode('https://b').append($createTextNode('3')),
        ),
      );
    }, true);
    expect(rootShape(editor)).toEqual([
      ['paragraph', ['link', '12'], ['link', '3']],
    ]);
  });

  test('a subclass override of shouldMergeAdjacentLink keeps deciding', () => {
    class NoMergeLink extends LinkNode {
      $config() {
        return this.config('test-nomerge-link', {extends: LinkNode});
      }
      shouldMergeAdjacentLink(): boolean {
        return false;
      }
    }
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        $getRoot().append(
          $createParagraphNode().append(
            $create(NoMergeLink)
              .setURL('https://a')
              .append($createTextNode('1')),
            $create(NoMergeLink)
              .setURL('https://a')
              .append($createTextNode('2')),
          ),
        );
      },
      dependencies: [RichTextExtension, LinkExtension, NodeStructureExtension],
      name: 'override',
      nodes: [NoMergeLink],
    });
    expect(rootShape(editor)).toEqual([
      ['paragraph', ['test-nomerge-link', '1'], ['test-nomerge-link', '2']],
    ]);
  });

  test('a class that declares mergeAdjacent merges; a subclass that inherits it merges by its own code', () => {
    const tagSchema = nodeSchema<TagNode>()({
      tag: withField(stringValue(), {field: '__tag'}),
    });
    class TagNode extends ElementNode {
      __tag = '';
      $config() {
        return this.config('test-tag', {
          children: 'inline',
          extends: ElementNode,
          inline: true,
          json: tagSchema,
          mergeAdjacent: {by: ['tag']},
        });
      }
    }
    class SubTagNode extends TagNode {
      $config() {
        return this.config('test-subtag', {extends: TagNode});
      }
    }
    const $tag = (klass: typeof TagNode, tag: string, text: string) => {
      const node = $create(klass);
      node.__tag = tag;
      return node.append($createTextNode(text));
    };
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        $getRoot().append(
          $createParagraphNode().append(
            $tag(TagNode, 'a', '1'),
            $tag(TagNode, 'a', '2'),
            $tag(TagNode, 'b', '3'),
          ),
          $createParagraphNode().append(
            $tag(SubTagNode, 'a', '4'),
            $tag(SubTagNode, 'a', '5'),
          ),
        );
      },
      dependencies: [RichTextExtension, NodeStructureExtension],
      name: 'tags',
      nodes: [TagNode, SubTagNode],
    });
    expect(rootShape(editor)).toEqual([
      ['paragraph', ['test-tag', '12'], ['test-tag', '3']],
      // Its own code (here none) merges a subclass: an override of a merge
      // method is never bypassed.
      ['paragraph', ['test-subtag', '4'], ['test-subtag', '5']],
    ]);
  });

  test('adjacent lists of one type merge, whatever their start', () => {
    using editor = build(() => {
      $getRoot().append(
        $createListNode('number', 1).append(
          $createListItemNode().append($createTextNode('a')),
        ),
        $createListNode('number', 5).append(
          $createListItemNode().append($createTextNode('b')),
        ),
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('c')),
        ),
      );
    }, true);
    expect(rootShape(editor)).toEqual([
      ['list', ['listitem', 'a'], ['listitem', 'b']],
      ['list', ['listitem', 'c']],
    ]);
  });

  test('a block decorator splits an ordered list wherever it sits in the item; numbering continues', () => {
    const $hr = () => $createHorizontalRuleNode();
    const $t = (text: string) => $createTextNode(text);
    // The list starts at 5: x is 5, the item holding the rule is 6.
    const cases: [string, () => LexicalNode[], unknown[]][] = [
      [
        'first',
        () => [$hr(), $t('b')],
        [[5, 'x'], 'horizontalrule', [6, 'b', 'y']],
      ],
      [
        'middle',
        () => [$t('a'), $hr(), $t('b')],
        [[5, 'x', 'a'], 'horizontalrule', [7, 'b', 'y']],
      ],
      [
        'last',
        () => [$t('a'), $hr()],
        [[5, 'x', 'a'], 'horizontalrule', [7, 'y']],
      ],
      ['alone', () => [$hr()], [[5, 'x'], 'horizontalrule', [6, 'y']]],
    ];
    for (const [name, $item, expected] of cases) {
      using editor = build(() => $numbered(5, 'x', $item, 'y'), true);
      expect([name, listStarts(editor)]).toEqual([name, expected]);
      // The item values follow: the second list continues the numbering.
      expect(listValues(editor)).toEqual(
        (expected as unknown[]).map(e =>
          Array.isArray(e) ? e.slice(1).map((_, i) => (e[0] as number) + i) : e,
        ),
      );
    }
  });

  test('a block decorator in the first or last item of an ordered list', () => {
    const cases: [() => void, unknown[]][] = [
      [
        () => $numbered(3, () => [$createHorizontalRuleNode()], 'y'),
        ['horizontalrule', [3, 'y']],
      ],
      [
        () => $numbered(3, 'x', () => [$createHorizontalRuleNode()]),
        [[3, 'x'], 'horizontalrule'],
      ],
    ];
    for (const [$init, expected] of cases) {
      using editor = build($init, true);
      expect(listStarts(editor)).toEqual(expected);
    }
  });

  test('a block decorator put in a list item later splits the same way', () => {
    using editor = build(() => $numbered(5, 'x', 'a', 'y'), true);
    editor.update(
      () => {
        const item = $assertNodeType(
          $assertNodeType(
            $getRoot().getFirstChildOrThrow(),
            $isListNode,
          ).getChildAtIndex(1),
          $isElementNode,
        );
        item.getFirstChildOrThrow().insertBefore($createHorizontalRuleNode());
      },
      {discrete: true},
    );
    expect(listStarts(editor)).toEqual([
      [5, 'x'],
      'horizontalrule',
      [6, 'a', 'y'],
    ]);
  });

  test('a block lifted out of a list item splits the list and keeps its type', () => {
    const $h = () => $createHeadingNode('h2').append($createTextNode('h'));
    const cases: [() => LexicalNode[], unknown[]][] = [
      [
        () => [$h(), $createTextNode('a')],
        [[1, 'x'], 'heading', [2, 'a', 'y']],
      ],
      [
        () => [$createTextNode('a'), $h()],
        [[1, 'x', 'a'], 'heading', [3, 'y']],
      ],
      [
        () => [$createCodeNode().append($createTextNode('c'))],
        [[1, 'x'], 'code', [2, 'y']],
      ],
    ];
    for (const [$item, expected] of cases) {
      using editor = build(() => $numbered(1, 'x', $item, 'y'), true);
      expect(listStarts(editor)).toEqual(expected);
    }
  });

  test('no table, row or text is lost when blocks are lifted out of a list', () => {
    const $table = (text: string) =>
      $createTableNode().append(
        $createTableRowNode().append(
          $createTableCellNode().append(
            $createParagraphNode().append($createTextNode(text)),
          ),
        ),
      );
    using editor = build(() => {
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append(
            $createHorizontalRuleNode(),
            $createTextNode('x'),
          ),
          $createListItemNode().append(
            $table('t1'),
            $table('t2'),
            $createTextNode('y'),
          ),
        ),
      );
    }, true);
    const table = (text: string) => [
      'table',
      ['tablerow', ['tablecell', ['paragraph', text]]],
    ];
    expect(rootShape(editor)).toEqual([
      'horizontalrule',
      ['list', ['listitem', 'x']],
      table('t1'),
      table('t2'),
      ['list', ['listitem', 'y']],
    ]);
  });

  test('a paragraph in a block in a holder: the result does not depend on which is repaired first', () => {
    const $doc = () =>
      $getRoot().append(
        $createCodeNode().append(
          $createParagraphNode().append(
            $createHeadingNode('h1').append($createTextNode('h')),
            $createTextNode('a'),
          ),
        ),
      );
    using built = build($doc, true);
    const want = rootShape(built);
    expect(want).toEqual([
      ['heading', 'h'],
      ['code', 'a'],
    ]);
    // The same document built with the extension off, then every element
    // marked dirty inner first once it is on.
    using editor = buildEditorFromExtensions({
      $initialEditorState: $doc,
      dependencies: [
        RichTextExtension,
        configExtension(NodeStructureExtension, {disabled: true}),
      ],
      name: 'order',
      nodes: [CodeNode],
    });
    editor.update(
      () => {
        const all: LexicalNode[] = [];
        const walk = (n: LexicalNode) => {
          if ($isElementNode(n)) {
            n.getChildren().forEach(walk);
          }
          all.push(n);
        };
        $getRoot().getChildren().forEach(walk);
        all.forEach(n => n.markDirty());
      },
      {discrete: true},
    );
    getExtensionDependencyFromEditor(
      editor,
      NodeStructureExtension,
    ).output.disabled.value = false;
    expect(rootShape(editor)).toEqual(want);
  });

  test('an element caret after a lifted block stays after it', () => {
    // What is before and after the caret in its element, and where that
    // element is. A point at an end of a text node (where the normalization
    // puts an element point next to it) reads as the point next to the node.
    const caret = (editor: ReturnType<typeof build>) =>
      editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        const {anchor} = selection;
        const node = anchor.getNode();
        if ($isTextNode(node)) {
          const text = node.getTextContent();
          return [
            anchor.offset > 0
              ? text.slice(0, anchor.offset)
              : (node.getPreviousSibling()?.getTextContent() ?? '^'),
            anchor.offset < text.length
              ? text.slice(anchor.offset)
              : (node.getNextSibling()?.getTextContent() ?? '$'),
            node.getParentOrThrow().getIndexWithinParent(),
          ];
        }
        assert($isElementNode(node));
        return [
          node.getChildAtIndex(anchor.offset - 1)?.getTextContent() ?? '^',
          node.getChildAtIndex(anchor.offset)?.getTextContent() ?? '$',
          node.getIndexWithinParent(),
        ];
      });
    // At the end of a paragraph split around a rule: after "b".
    using end = build(() => {
      const p = $createParagraphNode().append(
        $createTextNode('a'),
        $createHorizontalRuleNode(),
        $createTextNode('b'),
      );
      $getRoot().append(p);
      p.select(3, 3);
    }, true);
    expect(caret(end)).toEqual(['b', '$', 2]);
    // Right after the rule: at the start of the second part.
    using after = build(() => {
      const p = $createParagraphNode().append(
        $createTextNode('a'),
        $createHorizontalRuleNode(),
        $createTextNode('b'),
      );
      $getRoot().append(p);
      p.select(2, 2);
    }, true);
    expect(caret(after)).toEqual(['^', 'b', 2]);
    // Right before it: at the end of the first part.
    using before = build(() => {
      const p = $createParagraphNode().append(
        $createTextNode('a'),
        $createHorizontalRuleNode(),
        $createTextNode('b'),
      );
      $getRoot().append(p);
      p.select(1, 1);
    }, true);
    expect(caret(before)).toEqual(['a', '$', 0]);
    // In a list item, after a link that follows the rule.
    using item = build(() => {
      const li = $createListItemNode();
      $getRoot().append($createListNode('number').append(li));
      ElementNode.prototype.splice.call(li, 0, 0, [
        $createTextNode('x'),
        $createHorizontalRuleNode(),
        $createLinkNode('https://a').append($createTextNode('y')),
      ]);
      li.select(3, 3);
    }, true);
    expect(rootShape(item)).toEqual([
      ['list', ['listitem', 'x']],
      'horizontalrule',
      ['list', ['listitem', ['link', 'y']]],
    ]);
    expect(caret(item)).toEqual(['y', '$', 0]);
  });

  test('a text caret survives the split of its node', () => {
    using editor = build(() => $numbered(1, 'x', 'y'), true);
    editor.update(
      () => {
        const text = $getRoot().getAllTextNodes()[0];
        text.select(1, 1);
        text.insertAfter($createHorizontalRuleNode());
      },
      {discrete: true},
    );
    editor.update(() => $getSelection()!.insertText('1'), {discrete: true});
    expect(listStarts(editor)).toEqual([[1, 'x1'], 'horizontalrule', [2, 'y']]);
  });

  test('a list item holding a paragraph and a nested list gets no stray line break', () => {
    using editor = build(() => {
      const li = $createListItemNode();
      $getRoot().append($createListNode('bullet').append(li));
      ElementNode.prototype.splice.call(li, 0, 0, [
        $createParagraphNode().append($createTextNode('a')),
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('b')),
        ),
      ]);
    }, true);
    // The nested list then moves into an item of its own (a list item
    // holding a nested list holds nothing else).
    expect(rootShape(editor)).toEqual([
      ['list', ['listitem', 'a'], ['listitem', ['list', ['listitem', 'b']]]],
    ]);
  });

  test('a block in a mark keeps the mark on its content', () => {
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('a'),
            $createMarkNode(['m']).append(
              $createTextNode('b'),
              $createHeadingNode('h1').append($createTextNode('h')),
            ),
          ),
        );
      },
      dependencies: [RichTextExtension, NodeStructureExtension],
      name: 'mark',
      nodes: [MarkNode],
    });
    expect(rootShape(editor)).toEqual([
      ['paragraph', 'a', ['mark', 'b']],
      ['heading', ['mark', 'h']],
    ]);
  });

  test('the importers read whether an editor enforces the structure', () => {
    using on = build(() => {}, true);
    using off = build(() => {}, false);
    expect(INTERNAL_isNodeStructureEnforced(on)).toBe(true);
    expect(INTERNAL_isNodeStructureEnforced(off)).toBe(false);
    expect(INTERNAL_isNodeStructureEnforced(createEditor({nodes: []}))).toBe(
      false,
    );
  });

  test('normalization is a pure function of the document', () => {
    const run = () => {
      using editor = build($paraWithTable, true);
      return JSON.stringify(editor.getEditorState().toJSON());
    };
    expect(run()).toBe(run());
  });
});

describe('merging', () => {
  test('a ListNode subclass merges as it does without the extension', () => {
    class SubListNode extends ListNode {
      $config() {
        return this.config('test-sub-list', {extends: ListNode});
      }
    }
    const $list = (sub: boolean, text: string) =>
      (sub ? $create(SubListNode) : $createListNode())
        .setListType('bullet')
        .append($createListItemNode().append($createTextNode(text)));
    for (const [first, second] of [
      [false, false],
      [true, true],
      [false, true],
    ]) {
      const shapes = [false, true].map(withStructure => {
        const editor = buildEditorFromExtensions({
          $initialEditorState: () => {
            $getRoot().append($list(first, 'a'), $list(second, 'b'));
          },
          dependencies: withStructure
            ? [RichTextExtension, ListExtension, NodeStructureExtension]
            : [RichTextExtension, ListExtension],
          name: 'sub-list',
          nodes: [SubListNode],
          onError: e => {
            throw e;
          },
        });
        const result = editor.read(() =>
          $getRoot()
            .getChildren()
            .map(child => child.getTextContent()),
        );
        editor.dispose();
        return result;
      });
      expect(shapes[1]).toEqual(shapes[0]);
    }
  });

  test('ListNode: the extension and the list transform merge the same lists', () => {
    // A list brought next to another one by a repair (lifted out of a
    // paragraph) merges just as two lists that were adjacent already.
    using editor = build(() => {
      $getRoot().append(
        $createListNode('number', 2).append(
          $createListItemNode().append($createTextNode('a')),
        ),
      );
      const p = $createParagraphNode();
      $getRoot().append(p);
      ElementNode.prototype.splice.call(p, 0, 0, [
        $createListNode('number', 7).append(
          $createListItemNode().append($createTextNode('b')),
        ),
      ]);
      $getRoot().append(
        $createListNode('number', 9).append(
          $createListItemNode().append($createTextNode('c')),
        ),
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('d')),
        ),
      );
    }, true);
    expect(listStarts(editor)).toEqual([
      [2, 'a', 'b', 'c'],
      [1, 'd'],
    ]);
    expect(listValues(editor)).toEqual([[2, 3, 4], [1]]);
  });

  test('ListNode: the extension merges lists exactly as the list transform does, nested lists at the seam included', () => {
    const $doc = () => {
      const nested = (text: string) =>
        $createListItemNode().append(
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode(text)),
          ),
        );
      $getRoot().append(
        $createListNode('number', 3).append(
          $createListItemNode().append($createTextNode('x')),
          nested('a'),
        ),
        $createListNode('number', 8).append(
          nested('b'),
          $createListItemNode().append($createTextNode('y')),
        ),
      );
    };
    using on = build($doc, true);
    using off = build($doc, false);
    expect(rootShape(on)).toEqual([
      [
        'list',
        ['listitem', 'x'],
        ['listitem', ['list', ['listitem', 'a'], ['listitem', 'b']]],
        ['listitem', 'y'],
      ],
    ]);
    expect(rootShape(off)).toEqual(rootShape(on));
    expect(JSON.stringify(on.getEditorState().toJSON())).toBe(
      JSON.stringify(off.getEditorState().toJSON()),
    );
  });

  test('AutoLinkNode never merges', () => {
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createAutoLinkNode('https://a').append($createTextNode('1')),
            $createAutoLinkNode('https://a').append($createTextNode('2')),
          ),
        );
      },
      dependencies: [RichTextExtension, LinkExtension, NodeStructureExtension],
      name: 'autolink',
      nodes: [AutoLinkNode],
    });
    expect(rootShape(editor)).toEqual([
      ['paragraph', ['autolink', '1'], ['autolink', '2']],
    ]);
  });

  test('a class with an unrelated transform of its own is still merged', () => {
    const tagSchema = nodeSchema<CleanTagNode>()({
      tag: withField(stringValue(), {field: '__tag'}),
    });
    class CleanTagNode extends ElementNode {
      __tag = '';
      $config() {
        return this.config('test-clean-tag', {
          $transform: (node: CleanTagNode) => {
            if (node.isEmpty()) {
              node.remove();
            }
          },
          children: [ParagraphNode],
          extends: ElementNode,
          json: tagSchema,
          mergeAdjacent: {by: ['tag']},
        });
      }
    }
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        for (const text of ['a', 'b']) {
          const node = $create(CleanTagNode);
          node.__tag = 't';
          $getRoot().append(
            node.append($createParagraphNode().append($createTextNode(text))),
          );
        }
      },
      dependencies: [RichTextExtension, NodeStructureExtension],
      name: 'clean-tag',
      nodes: [CleanTagNode],
    });
    expect(rootShape(editor)).toEqual([
      ['test-clean-tag', ['paragraph', 'a'], ['paragraph', 'b']],
    ]);
  });

  test('mergeAdjacent.by naming a NodeState', () => {
    const color = createState('color', {parse: v => String(v ?? '')});
    class ColorNode extends ElementNode {
      $config() {
        return this.config('test-color', {
          children: 'inline',
          extends: ElementNode,
          inline: true,
          mergeAdjacent: {by: [color]},
          stateConfigs: [{flat: true, stateConfig: color}],
        });
      }
    }
    const $color = (value: string, text: string) =>
      $setState($create(ColorNode), color, value).append($createTextNode(text));
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        $getRoot().append(
          $createParagraphNode().append(
            $color('red', '1'),
            $color('red', '2'),
            $color('blue', '3'),
          ),
        );
      },
      dependencies: [RichTextExtension, NodeStructureExtension],
      name: 'color',
      nodes: [ColorNode],
    });
    expect(rootShape(editor)).toEqual([
      ['paragraph', ['test-color', '12'], ['test-color', '3']],
    ]);
  });

  test('an inherited mergeAdjacent that does not fit the subclass is dropped', () => {
    class Item extends ElementNode {
      $config() {
        return this.config('test-fit-item', {
          children: 'inline',
          extends: ElementNode,
        });
      }
    }
    class BlockItem extends ElementNode {
      $config() {
        return this.config('test-fit-block-item', {
          children: 'block',
          extends: ElementNode,
        });
      }
    }
    class Group extends ElementNode {
      $config() {
        return this.config('test-fit-group', {
          children: [Item],
          extends: ElementNode,
          mergeAdjacent: {by: ['format']},
        });
      }
    }
    // Lists children its own merging rule cannot hold: the inherited
    // mergeAdjacent reads as undeclared, and registering never throws.
    class BlockGroup extends Group {
      $config() {
        return this.config('test-fit-block-group', {
          children: [BlockItem],
          extends: Group,
        });
      }
    }
    expect(() =>
      createEditor({nodes: [Item, BlockItem, Group, BlockGroup]}),
    ).not.toThrow();
    expect(getDeclaredNodeStructure(Group).mergeAdjacent).toEqual({
      by: ['format'],
    });
    expect(getDeclaredNodeStructure(BlockGroup).mergeAdjacent).toBeUndefined();
  });
});

describe('registration', () => {
  test('registerNodeStructure: idempotent, and disposed by its last registration', () => {
    const editor = createEditor({
      nodes: [HorizontalRuleNode],
      onError: e => {
        throw e;
      },
    });
    const $broken = () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append(
            $createTextNode('a'),
            $createHorizontalRuleNode(),
          ),
        );
    };
    const rootTypes = () => editor.read(() => $getRoot().getChildren().map(sh));
    const sh = (n: LexicalNode): unknown =>
      $isElementNode(n)
        ? [n.getType(), ...n.getChildren().map(sh)]
        : n.getType();
    const first = registerNodeStructure(editor);
    const second = registerNodeStructure(editor);
    editor.update($broken, {discrete: true});
    expect(rootTypes()).toEqual([['paragraph', 'text'], 'horizontalrule']);
    first();
    first();
    editor.update($broken, {discrete: true});
    expect(rootTypes()).toEqual([['paragraph', 'text'], 'horizontalrule']);
    second();
    expect(INTERNAL_isNodeStructureEnforced(editor)).toBe(false);
    editor.update($broken, {discrete: true});
    expect(rootTypes()).toEqual([['paragraph', 'text', 'horizontalrule']]);
  });

  test('disabled: the declarations are only read; turning it on normalizes the document', () => {
    using editor = buildEditorFromExtensions({
      $initialEditorState: $paragraphWithRule,
      dependencies: [
        RichTextExtension,
        HorizontalRuleExtension,
        configExtension(NodeStructureExtension, {disabled: true}),
      ],
      name: 'disabled',
    });
    expect(rootShape(editor)).toEqual([
      ['paragraph', 'a', 'horizontalrule', 'b'],
    ]);
    expect(INTERNAL_isNodeStructureEnforced(editor)).toBe(false);
    getExtensionDependencyFromEditor(
      editor,
      NodeStructureExtension,
    ).output.disabled.value = false;
    expect(rootShape(editor)).toEqual([
      ['paragraph', 'a'],
      'horizontalrule',
      ['paragraph', 'b'],
    ]);
  });

  test('each editor enforces its own registration (nested editors too)', () => {
    using parent = build(() => {}, true);
    const nested = createEditor({
      nodes: [HorizontalRuleNode],
      onError: e => {
        throw e;
      },
      parentEditor: parent,
    });
    nested.update($paragraphWithRule, {discrete: true});
    const nestedTypes = () =>
      nested.read(() =>
        $getRoot()
          .getChildren()
          .map(n => n.getType()),
      );
    expect(nestedTypes()).toEqual(['paragraph']);
    const dispose = registerNodeStructure(nested);
    expect(nestedTypes()).toEqual(['paragraph', 'horizontalrule', 'paragraph']);
    dispose();
  });

  test("a table cell's declared children: inline content is wrapped in a paragraph", () => {
    // A decorator that turns inline while its cell is not written: core's
    // shadow root transform never sees it, the extension does.
    class ChipNode extends DecoratorNode<null> {
      __inline = false;
      $config() {
        return this.config('test-chip-decorator', {
          extends: DecoratorNode,
          json: nodeSchema<ChipNode>()({
            inline: withField(booleanValue(), {field: '__inline'}),
          }),
        });
      }
      createDOM(): HTMLElement {
        return $getDocument().createElement('span');
      }
      updateDOM(): false {
        return false;
      }
      decorate(): null {
        return null;
      }
      isInline(): boolean {
        return this.getLatest().__inline;
      }
    }
    const run = (withStructure: boolean) => {
      using editor = buildEditorFromExtensions({
        $initialEditorState: () => {
          $getRoot().append(
            $createTableNode().append(
              $createTableRowNode().append(
                $createTableCellNode().append($create(ChipNode)),
              ),
            ),
          );
        },
        // The table nodes alone: TableExtension's own transforms write the
        // cell, so core's transform would see it too.
        dependencies: [
          RichTextExtension,
          ...(withStructure ? [NodeStructureExtension] : []),
        ],
        name: 'cell',
        nodes: [ChipNode, TableNode, TableRowNode, TableCellNode],
      });
      // Commit the initial state, in which every node is dirty.
      editor.read(() => {});
      editor.update(
        () => {
          const table = $assertNodeType(
            $getRoot().getFirstChildOrThrow(),
            $isElementNode,
          );
          const row = $assertNodeType(
            table.getFirstChildOrThrow(),
            $isElementNode,
          );
          const cell = $assertNodeType(
            row.getFirstChildOrThrow(),
            $isElementNode,
          );
          const chip = cell.getFirstChildOrThrow();
          assert(chip instanceof ChipNode);
          chip.getWritable().__inline = true;
        },
        {discrete: true},
      );
      return rootShape(editor);
    };
    const cell = (...children: unknown[]) => [
      ['table', ['tablerow', ['tablecell', ...children]]],
    ];
    expect(run(false)).toEqual(cell('test-chip-decorator'));
    expect(run(true)).toEqual(cell(['paragraph', 'test-chip-decorator']));
  });

  test('an OverflowNode subclass is exempt too; a class that only shares the type name is not', () => {
    class MyOverflowNode extends OverflowNode {
      $config() {
        return this.config('test-my-overflow', {extends: OverflowNode});
      }
    }
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('within'),
            $create(MyOverflowNode).append($createTextNode('over')),
          ),
        );
      },
      dependencies: [RichTextExtension, NodeStructureExtension],
      name: 'overflow',
      nodes: [MyOverflowNode],
    });
    expect(rootShape(editor)).toEqual([
      ['paragraph', 'within', ['test-my-overflow', 'over']],
    ]);
    class FakeOverflowNode extends ParagraphNode {
      $config() {
        return this.config('overflow', {extends: ParagraphNode});
      }
    }
    using fake = buildEditorFromExtensions({
      $initialEditorState: () => {
        const p = $createParagraphNode();
        $getRoot().append(p);
        ElementNode.prototype.splice.call(p, 0, 0, [
          $createTextNode('a'),
          $create(FakeOverflowNode).append($createTextNode('b')),
        ]);
      },
      dependencies: [RichTextExtension, NodeStructureExtension],
      name: 'fake-overflow',
      nodes: [FakeOverflowNode],
    });
    // A paragraph (not OverflowNode) in a paragraph becomes lines of it.
    expect(rootShape(fake)).toEqual([['paragraph', 'a', 'linebreak', 'b']]);
  });

  test('INTERNAL_$normalizeNodeStructure normalizes a subtree now, without the extension', () => {
    const tagSchema = nodeSchema<BlockTagNode>()({
      tag: withField(stringValue(), {field: '__tag'}),
    });
    class BlockTagNode extends ElementNode {
      __tag = '';
      $config() {
        return this.config('test-block-tag', {
          children: 'inline',
          extends: ElementNode,
          json: tagSchema,
          mergeAdjacent: {by: ['tag']},
        });
      }
    }
    // No extension: the code that changed the document calls it itself.
    using editor = buildEditorFromExtensions({
      dependencies: [RichTextExtension, HorizontalRuleExtension],
      name: 'internal',
      nodes: [BlockTagNode],
    });
    editor.update(
      () => {
        const tag = (...children: LexicalNode[]) => {
          const node = $create(BlockTagNode);
          node.__tag = 't';
          return node.append(...children);
        };
        $getRoot()
          .clear()
          .append(
            tag($createTextNode('a')),
            tag($createTextNode('b'), $createHorizontalRuleNode()),
          );
      },
      {discrete: true},
    );
    // Nothing enforces the structure yet.
    expect(rootShape(editor)).toEqual([
      ['test-block-tag', 'a'],
      ['test-block-tag', 'b', 'horizontalrule'],
    ]);
    // The second node is split around the rule, then merged with its equal
    // sibling. (Core then joins the two text nodes.)
    editor.update(
      () => INTERNAL_$normalizeNodeStructure($getRoot().getLastChildOrThrow()),
      {discrete: true},
    );
    const normalized = [['test-block-tag', 'ab'], 'horizontalrule'];
    expect(rootShape(editor)).toEqual(normalized);
    editor.update(() => INTERNAL_$normalizeNodeStructure($getRoot()), {
      discrete: true,
    });
    expect(rootShape(editor)).toEqual(normalized);
  });
});

describe('getDeclaredNodeStructure', () => {
  test('returns immutable results', () => {
    const declared = getDeclaredNodeStructure(ListItemNode);
    expect(Object.isFrozen(declared)).toBe(true);
    expect(Object.isFrozen(declared.declaredBy)).toBe(true);
    (declared.derived as Set<string>).add('checked');
    expect(getDeclaredNodeStructure(ListItemNode).derived).toEqual(
      new Set(['indent', 'value']),
    );
  });

  test('an inherited inline is dropped when the subclass isInline() cannot be evaluated without an instance', () => {
    class StatefulLinkNode extends LinkNode {
      $config() {
        return this.config('test-stateful-link', {extends: LinkNode});
      }
      // @ts-expect-error LinkNode types isInline() as true.
      isInline(): boolean {
        return this.getLatest().__url !== '';
      }
    }
    expect(() =>
      createEditor({nodes: [LinkNode, StatefulLinkNode]}),
    ).not.toThrow();
    expect(getDeclaredNodeStructure(StatefulLinkNode).inline).toBeUndefined();
    expect(getDeclaredNodeStructure(LinkNode).inline).toBe(true);
  });

  test('a derived schema field in mergeAdjacent.by is refused with its own message', () => {
    const schema = nodeSchema<CountedNode>()({
      count: withField(numberValue(0), {derived: true, field: '__count'}),
    });
    class CountedNode extends ElementNode {
      __count = 0;
      $config() {
        return this.config('test-counted', {
          extends: ElementNode,
          json: schema,
          mergeAdjacent: {by: ['count']},
        });
      }
    }
    expect(getDeclaredNodeStructure(CountedNode).derived).toEqual(
      new Set(['count']),
    );
    expect(() => createEditor({nodes: [CountedNode]})).toThrow(
      /names count, which is derived/,
    );
  });

  test('a custom group wraps a stray child in the first class it lists', () => {
    class Item extends ElementNode {
      $config() {
        return this.config('test-wrap-item', {
          children: 'inline',
          extends: ElementNode,
        });
      }
    }
    class Group extends ElementNode {
      $config() {
        return this.config('test-wrap-group', {
          children: [Item, ParagraphNode],
          extends: ElementNode,
        });
      }
    }
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        const group = $create(Group);
        $getRoot().append(group);
        ElementNode.prototype.splice.call(group, 0, 0, [
          $createTextNode('a'),
          $createLineBreakNode(),
          $createParagraphNode().append($createTextNode('p')),
          $createTextNode('b'),
        ]);
      },
      dependencies: [RichTextExtension, NodeStructureExtension],
      name: 'group',
      nodes: [Item, Group],
    });
    expect(rootShape(editor)).toEqual([
      [
        'test-wrap-group',
        ['test-wrap-item', 'a', 'linebreak'],
        ['paragraph', 'p'],
        ['test-wrap-item', 'b'],
      ],
    ]);
  });
});

describe('carets, empty inline elements and dirty order', () => {
  function buildEditor() {
    return buildEditorFromExtensions({
      dependencies: [
        RichTextExtension,
        ListExtension,
        LinkExtension,
        configExtension(TableExtension, {hasHorizontalScroll: false}),
        HorizontalRuleExtension,
        NodeStructureExtension,
      ],
      name: 'node-structure-carets',
      nodes: [MarkNode, OverflowNode],
      onError: e => {
        throw e;
      },
    });
  }

  /** Children put in as they are (no override rewrites them). */
  function put<T extends ElementNode>(parent: T, children: LexicalNode[]): T {
    ElementNode.prototype.splice.call(
      parent,
      parent.getChildrenSize(),
      0,
      children,
    );
    return parent;
  }

  /**
   * Load a document as an update applied with skipTransforms leaves it (not
   * normalized), then mark every node dirty in `order`.
   */
  function loadThenNormalize(
    editor: ReturnType<typeof buildEditor>,
    $build: () => LexicalNode[],
    order: 'outer first' | 'inner first' = 'outer first',
    $select: () => void = () => {},
  ): void {
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(...$build());
        $select();
      },
      {discrete: true, skipTransforms: true},
    );
    editor.update(
      () => {
        const nodes: LexicalNode[] = [];
        const walk = (node: LexicalNode) => {
          if (order === 'outer first') {
            nodes.push(node);
          }
          if ($isElementNode(node)) {
            node.getChildren().forEach(walk);
          }
          if (order === 'inner first') {
            nodes.push(node);
          }
        };
        $getRoot().getChildren().forEach(walk);
        nodes.forEach(node => node.markDirty());
      },
      {discrete: true},
    );
  }

  function content(editor: ReturnType<typeof buildEditor>): string {
    return editor.read(() => {
      let out = '';
      const walk = (node: LexicalNode) => {
        if ($isElementNode(node)) {
          node.getChildren().forEach(walk);
        } else if (node instanceof HorizontalRuleNode) {
          out += '#';
        } else if ($isTextNode(node)) {
          // Line breaks are left out: joining paragraphs adds them.
          out += node.getTextContent();
        }
      };
      $getRoot().getChildren().forEach(walk);
      return out;
    });
  }

  const $t = (text: string) => $createTextNode(text);
  const $p = (...children: LexicalNode[]) =>
    put($createParagraphNode(), children);
  const $hr = () => $createHorizontalRuleNode();

  test.each<[string, () => LexicalNode[], number[], number, string]>([
    [
      'after a mark split around a paragraph',
      () => [$p(put($createMarkNode(['m']), [$t('a'), $p($t('b')), $t('c')]))],
      [0],
      1,
      'abcZ',
    ],
    [
      'after a quote lifted out of a list item and split around a rule',
      () => [
        put($createListNode('bullet'), [
          put($createListItemNode(), [
            $t('x'),
            put($createQuoteNode(), [$p($t('a')), $hr(), $t('b')]),
          ]),
        ]),
      ],
      [0, 0],
      2,
      'xa#bZ',
    ],
    [
      'after a paragraph split around a rule',
      () => [$p($t('a'), $hr(), $t('b'))],
      [],
      1,
      'a#bZ',
    ],
    [
      'before a list whose first item starts with a rule',
      () => [
        put($createListNode('number'), [
          put($createListItemNode(), [$hr(), $t('y')]),
        ]),
      ],
      [],
      0,
      'Z#y',
    ],
  ])(
    'an element caret %s keeps its place in the content',
    (_name, $build, path, offset, want) => {
      using editor = buildEditor();
      loadThenNormalize(editor, $build, 'outer first', () => {
        let node: LexicalNode = $getRoot();
        for (const i of path) {
          node = (node as ElementNode).getChildAtIndex(i)!;
        }
        const selection = $createRangeSelection();
        selection.anchor.set(node.getKey(), offset, 'element');
        selection.focus.set(node.getKey(), offset, 'element');
        $setSelection(selection);
      });
      editor.update(() => $getSelection()!.insertText('Z'), {discrete: true});
      expect(content(editor)).toBe(want);
    },
  );

  test.each<[string, () => LexicalNode[], unknown]>([
    [
      'an empty link in an OverflowNode before a rule in a list item',
      () => [
        put($createListNode('bullet'), [
          put($createListItemNode(), [
            put($createOverflowNode(), [$createLinkNode('https://a')]),
            $hr(),
            $t('y'),
          ]),
        ]),
      ],
      ['horizontalrule', ['list', ['listitem', 'y']]],
    ],
    [
      'an empty mark before a quote in a table cell',
      () => [
        $createTableNode().append(
          $createTableRowNode().append(
            put($createTableCellNode(), [
              $createMarkNode(['m']),
              put($createQuoteNode(), [$t('x')]),
            ]),
          ),
        ),
      ],
      [['table', ['tablerow', ['tablecell', ['quote', 'x']]]]],
    ],
    [
      'an empty link alone in a list',
      () => [
        put($createListNode('bullet'), [$createLinkNode('https://a')]),
        $p($t('z')),
      ],
      [['paragraph', 'z']],
    ],
  ])(
    '%s is removed before its holder is repaired, whatever the dirty order',
    (_name, $build, want) => {
      for (const order of ['outer first', 'inner first'] as const) {
        using editor = buildEditor();
        loadThenNormalize(editor, $build, order);
        expect(editor.read(() => $getRoot().getChildren().map(shape))).toEqual(
          want,
        );
      }
    },
  );

  test('a node whose rule changes is checked again, though no child was written', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createQuoteNode().append($t('a')));
      },
      {discrete: true},
    );
    editor.update(
      () => {
        // A shadow root holds blocks: its text is wrapped in a paragraph.
        ($getRoot().getFirstChild() as QuoteNode).setIsShadowRoot(true);
      },
      {discrete: true},
    );
    expect(editor.read(() => $getRoot().getChildren().map(shape))).toEqual([
      ['quote', ['paragraph', 'a']],
    ]);
  });

  test('items a list renumbers are not visited; what changed still is', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createListNode('number').append(
              ...['a', 'b', 'c', 'd'].map(text =>
                $createListItemNode().append($t(text)),
              ),
            ),
          );
      },
      {discrete: true},
    );
    // A new item renumbers every item after it, which leaves them as they
    // were otherwise; a rule added in the same update still splits the list.
    editor.update(
      () => {
        $getRoot().getAllTextNodes()[0].select(1, 1);
        ($getSelection() as RangeSelection).insertParagraph();
        $getRoot().getAllTextNodes()[1].insertAfter($hr());
      },
      {discrete: true},
    );
    expect(
      editor.read(() =>
        $getRoot()
          .getChildren()
          .map(n =>
            $isListNode(n)
              ? [n.getStart(), ...n.getChildren().map(c => c.getTextContent())]
              : n.getType(),
          ),
      ),
    ).toEqual([[1, 'a', '', 'b'], 'horizontalrule', [4, 'c', 'd']]);
  });
});

describe('formatting, list seams, orphan list items and the root', () => {
  function buildEditor(withStructure = true) {
    return buildEditorFromExtensions({
      dependencies: [
        RichTextExtension,
        ListExtension,
        LinkExtension,
        configExtension(TableExtension, {hasHorizontalScroll: false}),
        HorizontalRuleExtension,
        ...(withStructure ? [NodeStructureExtension] : []),
      ],
      name: 'node-structure-round-9',
      nodes: [MarkNode, OverflowNode],
      onError: e => {
        throw e;
      },
    });
  }

  /** Children put in as they are (no override rewrites them). */
  function put<T extends ElementNode>(parent: T, children: LexicalNode[]): T {
    ElementNode.prototype.splice.call(
      parent,
      parent.getChildrenSize(),
      0,
      children,
    );
    return parent;
  }

  /** The shape of the document, with each link's URL and each mark's ids. */
  function annotated(editor: ReturnType<typeof buildEditor>): unknown {
    const walk = (node: LexicalNode): unknown =>
      node instanceof MarkNode
        ? [`mark:${node.getIDs().join(',')}`, ...node.getChildren().map(walk)]
        : node instanceof LinkNode
          ? [`link:${node.getURL()}`, ...node.getChildren().map(walk)]
          : shape(node) instanceof Array
            ? [node.getType(), ...(node as ElementNode).getChildren().map(walk)]
            : shape(node);
    return editor.read(() => $getRoot().getChildren().map(walk));
  }

  function load(
    editor: ReturnType<typeof buildEditor>,
    $build: () => LexicalNode[],
  ): void {
    editor.update(() => put($getRoot().clear(), $build()), {discrete: true});
  }

  const $t = (text: string) => $createTextNode(text);
  const $li = (...children: LexicalNode[]) =>
    put($createListItemNode(), children);
  const $ul = (...children: LexicalNode[]) =>
    put($createListNode('bullet'), children);
  const $nested = (text: string, ...rest: LexicalNode[]) =>
    $li(put($createListNode('number'), [$li($t(text))]), ...rest);

  test('a list, table or shadow root lifted out of a link or mark keeps them on all its text', () => {
    const cases: [() => LexicalNode[], unknown][] = [
      [
        () => [
          $createParagraphNode().append(
            put($createMarkNode(['c1']), [$ul($li($t('x')))]),
          ),
        ],
        [['list', ['listitem', ['mark:c1', 'x']]]],
      ],
      [
        () => [
          $createParagraphNode().append(
            put($createMarkNode(['c1']), [
              $ul($li($t('x'), $ul($li($t('y'))))),
            ]),
          ),
        ],
        [
          [
            'list',
            ['listitem', ['mark:c1', 'x']],
            ['listitem', ['list', ['listitem', ['mark:c1', 'y']]]],
          ],
        ],
      ],
      [
        () => [
          $createParagraphNode().append(
            put($createLinkNode('https://a'), [
              put($createMarkNode(['c1']), [$ul($li($t('x')))]),
            ]),
          ),
        ],
        [['list', ['listitem', ['link:https://a', ['mark:c1', 'x']]]]],
      ],
      [
        () => [
          $createParagraphNode().append(
            put($createMarkNode(['c1']), [
              $t('l'),
              $createTableNode().append(
                $createTableRowNode().append(
                  $createTableCellNode().append(
                    $createParagraphNode().append($t('cell')),
                  ),
                ),
              ),
            ]),
          ),
        ],
        [
          ['paragraph', ['mark:c1', 'l']],
          [
            'table',
            ['tablerow', ['tablecell', ['paragraph', ['mark:c1', 'cell']]]],
          ],
        ],
      ],
      [
        () => [
          $createParagraphNode().append(
            put($createMarkNode(['c1']), [
              put($createQuoteNode({shadowRoot: true} as never), [
                $createParagraphNode().append($t('s')),
              ]),
            ]),
          ),
        ],
        [['quote', ['paragraph', ['mark:c1', 's']]]],
      ],
      [
        // An OverflowNode is wrapped inside, as LinkNode's own transform
        // leaves it.
        () => [
          $createParagraphNode().append(
            put($createMarkNode(['c1']), [
              $ul($li($t('x'), put($createOverflowNode(), [$t('y')]))),
            ]),
          ),
        ],
        [
          [
            'list',
            ['listitem', ['mark:c1', 'x'], ['overflow', ['mark:c1', 'y']]],
          ],
        ],
      ],
    ];
    for (const [$build, expected] of cases) {
      using editor = buildEditor();
      load(editor, $build);
      expect(annotated(editor)).toEqual(expected);
    }
  });

  test('a list item outside a list, in a link, keeps the link as it does without the extension', () => {
    // The shape pasting <a href="https://a">l<li>x</li></a> builds.
    const $build = () => [
      $createParagraphNode().append(
        put($createLinkNode('https://a'), [$t('l'), $li($t('x'))]),
      ),
    ];
    using on = buildEditor();
    using off = buildEditor(false);
    load(on, $build);
    load(off, $build);
    expect(annotated(on)).toEqual([
      ['paragraph', ['link:https://a', 'l']],
      ['list', ['listitem', ['link:https://a', 'x']]],
    ]);
    expect(annotated(on)).toEqual(annotated(off));
  });

  test('lists that merge keep what follows or precedes a nested list in an item at the seam', () => {
    // That content moves into an item of its own (a list item holding a
    // nested list holds nothing else), so the wrapper items that then meet
    // join their nested lists.
    // Removing what separated them.
    {
      using editor = buildEditor();
      load(editor, () => [
        $ul($nested('a')),
        $createParagraphNode().append($t('sep')),
        $ul($nested('b', $t('tail'))),
      ]);
      editor.update(() => $getRoot().getChildAtIndex(1)!.remove(), {
        discrete: true,
      });
      expect(rootShape(editor)).toEqual([
        [
          'list',
          ['listitem', ['list', ['listitem', 'a'], ['listitem', 'b']]],
          ['listitem', 'tail'],
        ],
      ]);
    }
    // Loaded next to each other, the first item at the seam holding more.
    {
      using editor = buildEditor();
      load(editor, () => [$ul($nested('a', $t('x'))), $ul($nested('b'))]);
      expect(rootShape(editor)).toEqual([
        [
          'list',
          ['listitem', ['list', ['listitem', 'a']]],
          ['listitem', 'x'],
          ['listitem', ['list', ['listitem', 'b']]],
        ],
      ]);
    }
    // A list lifted out of a link next to an equal one.
    {
      using editor = buildEditor();
      load(editor, () => [
        $createParagraphNode().append(
          put($createLinkNode('https://a'), [$ul($nested('a'))]),
        ),
        $ul($nested('b', $t('tail'))),
      ]);
      expect(annotated(editor)).toEqual([
        [
          'list',
          [
            'listitem',
            ['list', ['listitem', ['link:https://a', 'a']], ['listitem', 'b']],
          ],
          ['listitem', 'tail'],
        ],
      ]);
    }
    // Items that only wrap a nested list still join, as without the
    // extension.
    const $chain = () => [
      $ul($nested('a')),
      $ul($nested('b'), $nested('c'), $li($t('d'))),
    ];
    using on = buildEditor();
    using off = buildEditor(false);
    load(on, $chain);
    load(off, $chain);
    expect(rootShape(on)).toEqual([
      [
        'list',
        ['listitem', ['list', ['listitem', 'a'], ['listitem', 'b']]],
        ['listitem', ['list', ['listitem', 'c']]],
        ['listitem', 'd'],
      ],
    ]);
    expect(JSON.stringify(on.getEditorState().toJSON())).toBe(
      JSON.stringify(off.getEditorState().toJSON()),
    );
  });

  test('items the seam joins are still normalized: the result is a fixed point', () => {
    const $build = () => [
      $ul($nested('a')),
      $ul(
        $li(
          put($createListNode('number'), [
            $li(
              $createParagraphNode().append($t('p')),
              $createParagraphNode().append($t('q')),
            ),
          ]),
        ),
      ),
    ];
    using loaded = buildEditor();
    load(loaded, $build);
    using normalized = buildEditor(false);
    normalized.update(
      () => {
        put($getRoot().clear(), $build());
        INTERNAL_$normalizeNodeStructure($getRoot());
      },
      {discrete: true, skipTransforms: true},
    );
    const expected = [
      [
        'list',
        [
          'listitem',
          ['list', ['listitem', 'a'], ['listitem', 'p', 'linebreak', 'q']],
        ],
      ],
    ];
    expect(rootShape(loaded)).toEqual(expected);
    expect(rootShape(normalized)).toEqual(expected);
  });

  test('a caret next to a list item outside a list keeps its place', () => {
    const typeAt = (
      $build: () => ElementNode,
      offset: number,
    ): [unknown, unknown] => {
      using editor = buildEditor();
      editor.update(
        () => {
          const holder = $build();
          put($getRoot().clear(), [holder]);
          holder.select(offset, offset);
        },
        {discrete: true},
      );
      editor.update(() => $getSelection()!.insertText('Z'), {
        discrete: true,
      });
      return [
        rootShape(editor),
        editor.read(() => {
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          return selection.anchor.getNode().isAttached();
        }),
      ];
    };
    // After an empty item: still after "a".
    expect(
      typeAt(() => put($createParagraphNode(), [$t('a'), $li()]), 2),
    ).toEqual([
      [
        ['paragraph', 'aZ'],
        ['list', ['listitem']],
      ],
      true,
    ]);
    expect(typeAt(() => put($createQuoteNode(), [$t('a'), $li()]), 2)).toEqual([
      [
        ['quote', 'aZ'],
        ['list', ['listitem']],
      ],
      true,
    ]);
    // Before an item: after "a"; after it: after its content.
    expect(
      typeAt(() => put($createParagraphNode(), [$t('a'), $li($t('x'))]), 1),
    ).toEqual([
      [
        ['paragraph', 'aZ'],
        ['list', ['listitem', 'x']],
      ],
      true,
    ]);
    expect(
      typeAt(() => put($createParagraphNode(), [$t('a'), $li($t('x'))]), 2),
    ).toEqual([
      [
        ['paragraph', 'a'],
        ['list', ['listitem', 'x']],
        ['paragraph', 'Z'],
      ],
      true,
    ]);
    // The only content of its paragraph: no lost selection.
    expect(typeAt(() => put($createParagraphNode(), [$li()]), 1)).toEqual([
      [
        ['list', ['listitem']],
        ['paragraph', 'Z'],
      ],
      true,
    ]);
  });

  test('inline content at the root is wrapped whenever core would wrap it', () => {
    const run = (withStructure: boolean, $edit: () => void) => {
      using editor = buildEditor(withStructure);
      load(editor, () => [$createParagraphNode().append($t('p'))]);
      // Left at the root by an update that runs no transform.
      editor.update(() => put($getRoot(), [$t('stray')]), {
        discrete: true,
        skipTransforms: true,
      });
      editor.update($edit, {discrete: true});
      return rootShape(editor);
    };
    const edits: (() => void)[] = [
      // An edit somewhere else.
      () =>
        $assertNodeType(
          $getRoot().getFirstDescendant(),
          $isTextNode,
        ).setTextContent('pp'),
      // An update that only marks the root dirty.
      () => $getRoot().markDirty(),
    ];
    for (const $edit of edits) {
      expect(run(true, $edit)).toEqual(run(false, $edit));
    }
    expect(run(true, edits[0])).toEqual([
      ['paragraph', 'pp'],
      ['paragraph', 'stray'],
    ]);
  });
});
