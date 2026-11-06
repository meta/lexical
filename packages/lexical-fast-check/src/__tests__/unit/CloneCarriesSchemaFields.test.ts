/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {CodeHighlightNode, CodeNode} from '@lexical/code';
import {nodeArbitrary} from '@lexical/fast-check';
import {AutoLinkNode, LinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {MarkNode} from '@lexical/mark';
import {DecoratorBlockNode} from '@lexical/react/LexicalDecoratorBlockNode';
import {HeadingNode} from '@lexical/rich-text';
import {
  $createTableNode,
  $createTableRowNode,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import * as fc from 'fast-check';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  createEditor,
  type Klass,
  type LexicalExportJSON,
  type LexicalNode,
  type LexicalParseJSON,
  type NodeKey,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

/**
 * The property this file exists for: a node's `afterCloneFrom` has to carry
 * every property its serialization schema declares. Declaring a new schema
 * property and failing to copy it is silent — the field still exists on the
 * clone (the constructor set it), it just holds the constructor's default
 * instead of the value, so the node loses data on the next `getWritable()`
 * rather than failing anywhere.
 *
 * A field-backed property is carried by the `afterCloneFrom` synthesized from
 * the schema, so what these tests watch for is a class where that derivation
 * does not apply: a property declared through accessor methods, which names no
 * field for anything to copy, and a class that writes its own `afterCloneFrom`
 * and so is trusted with all of its own fields.
 *
 * Generated values are what make this work. A hand-written fixture tends to use
 * defaults, and a dropped field compares equal to its default, so the bug is
 * invisible exactly when the test looks like it passed. `nodeArbitrary` draws
 * from the schema's own domain, so the values are in-domain and mostly not the
 * default, and fast-check shrinks a failure to the one property at fault.
 */
function expectCloneCarriesSchemaFields<T extends LexicalNode>(
  klass: Klass<T>,
  props: LexicalParseJSON<LexicalExportJSON<T>>,
  options: {
    /** Further classes the editor has to know about to hold the node. */
    readonly nodes?: readonly Klass<LexicalNode>[];
    /**
     * Put the node somewhere the tree accepts it, for a class whose parent is
     * part of what it is: a `ListItemNode` resolves its `indent` by counting
     * list ancestors, so an unparented one cannot even be given the property
     * under test.
     */
    readonly place?: (node: T) => void;
  } = {},
): void {
  const editor = createEditor({
    namespace: 'clone-property',
    nodes: [klass, ...(options.nodes || [])],
    onError(error) {
      throw error;
    },
  });
  let key: NodeKey = '';
  let before: unknown;
  let original: LexicalNode | null = null;

  // A node is only cloned across updates: within one, $setNodeKey has put it in
  // `_cloneNotNeeded` and getWritable() hands back the very same object, so a
  // single-update test would never reach afterCloneFrom at all.
  editor.update(
    () => {
      const node = $create(klass);
      const root = $getRoot().clear();
      if (options.place) {
        options.place(node);
      } else if ($isElementNode(node)) {
        // Kept alive the way the TextNode case is: an empty element is removed
        // between the two updates, and an inline one has to sit in a block.
        node.append($createTextNode('x'));
        root.append(
          node.isInline() ? $createParagraphNode().append(node) : node,
        );
      } else {
        root.append($createParagraphNode().append(node));
      }
      // After placement, not before: a property read off the node's position
      // in the tree cannot be applied to a node that has none.
      node.updateFromJSON(props);
      key = node.getKey();
      original = node;
    },
    {discrete: true},
  );

  // Read once the update has settled, so the comparison is against the values
  // the node actually ended up with: a `$transform` may legitimately change
  // one (`ListItemNode` renumbers `value` from its position in the list), and
  // reading inside the update above compared the clone against a value that
  // was already stale before anything was cloned.
  //
  // An element's exportJSON always writes `children: []` — the tree is
  // serialized by the traversal around it — so the child added above does not
  // enter the comparison.
  editor.read(() => {
    before = $getNodeByKey(key)!.exportJSON();
  });

  editor.update(
    () => {
      const writable = $getNodeByKey(key)!.getWritable();
      // The clone actually happened, so what follows is a real assertion.
      expect(writable).not.toBe(original);
      expect(writable.exportJSON()).toEqual(before);
    },
    {discrete: true},
  );
}

/**
 * A concrete `DecoratorBlockNode`, which the base class is not: it declares its
 * schema under `Symbol.for('DecoratorBlockNode')` for subclasses to compose.
 * Nothing renders here — no root element is attached — so `decorate` is never
 * reached.
 */
class TestDecoratorBlockNode extends DecoratorBlockNode {
  $config() {
    return this.config('test-decorator-block', {extends: DecoratorBlockNode});
  }

  decorate(): never {
    throw new Error('TestDecoratorBlockNode is never rendered');
  }
}

/**
 * One case per class the generator writes a clone helper for, which
 * `generateNodeJSON.test.ts` holds this file to.
 *
 * `ElementNode` is the one without a case of its own: it is abstract, so its
 * `direction`, `indent`, `textFormat` and `textStyle` are reached through
 * every element below — `HeadingNode`, `ListNode`, `TableCellNode` and the
 * rest all fail if its half of the copy stops happening.
 */
describe('a clone carries every serialization schema property', () => {
  test('TextNode', () => {
    fc.assert(
      fc.property(nodeArbitrary(TextNode), props => {
        // Everything but `text` is used exactly as generated. An empty
        // TextNode is removed by normalization between the two updates, so
        // there would be nothing left to clone — this keeps the node alive
        // without constraining any of the properties under test.
        expectCloneCarriesSchemaFields(TextNode, {...props, text: 'x'});
      }),
    );
  });

  test('HeadingNode', () => {
    fc.assert(
      fc.property(nodeArbitrary(HeadingNode), props => {
        expectCloneCarriesSchemaFields(HeadingNode, props);
      }),
    );
  });

  test('LinkNode', () => {
    fc.assert(
      fc.property(nodeArbitrary(LinkNode), props => {
        expectCloneCarriesSchemaFields(LinkNode, props);
      }),
    );
  });

  test('AutoLinkNode', () => {
    fc.assert(
      fc.property(nodeArbitrary(AutoLinkNode), props => {
        expectCloneCarriesSchemaFields(AutoLinkNode, props);
      }),
    );
  });

  test('MarkNode', () => {
    fc.assert(
      fc.property(nodeArbitrary(MarkNode), props => {
        expectCloneCarriesSchemaFields(MarkNode, props);
      }),
    );
  });

  // CodeNode writes its own afterCloneFrom for the one field its schema does
  // not name (`__isSyntaxHighlightSupported`) and calls the generated half for
  // the rest. Deleting that call is exactly the mistake this notices.
  test('CodeNode', () => {
    fc.assert(
      fc.property(nodeArbitrary(CodeNode), props => {
        expectCloneCarriesSchemaFields(CodeNode, props);
      }),
    );
  });

  test('CodeHighlightNode', () => {
    fc.assert(
      fc.property(nodeArbitrary(CodeHighlightNode), props => {
        expectCloneCarriesSchemaFields(CodeHighlightNode, {
          ...props,
          text: 'x',
        });
      }),
    );
  });

  test('ListNode', () => {
    fc.assert(
      fc.property(nodeArbitrary(ListNode), props => {
        expectCloneCarriesSchemaFields(ListNode, props, {
          nodes: [ListItemNode],
          // A list's children are items, and an empty list does not survive to
          // the second update.
          place: list => {
            $getRoot().append(list.append($createListItemNode()));
          },
        });
      }),
    );
  });

  // `indent` is resolved by counting the item's list ancestors rather than
  // from a field, so this is the one class that has to be in a tree before the
  // properties under test can be applied at all.
  test('ListItemNode', () => {
    fc.assert(
      fc.property(nodeArbitrary(ListItemNode), props => {
        expectCloneCarriesSchemaFields(ListItemNode, props, {
          nodes: [ListNode],
          place: item => {
            $getRoot().append($createListNode('bullet').append(item));
          },
        });
      }),
    );
  });

  test('TableNode', () => {
    fc.assert(
      fc.property(nodeArbitrary(TableNode), props => {
        expectCloneCarriesSchemaFields(TableNode, props, {
          nodes: [TableRowNode, TableCellNode],
          place: table => {
            $getRoot().append(table.append($createTableRowNode()));
          },
        });
      }),
    );
  });

  test('TableRowNode', () => {
    fc.assert(
      fc.property(nodeArbitrary(TableRowNode), props => {
        expectCloneCarriesSchemaFields(TableRowNode, props, {
          nodes: [TableNode, TableCellNode],
          place: row => {
            $getRoot().append($createTableNode().append(row));
          },
        });
      }),
    );
  });

  // DecoratorBlockNode has no concrete node type of its own, so the clone that
  // carries its `format` is reached through a subclass, which is how every
  // application meets it.
  test('DecoratorBlockNode', () => {
    fc.assert(
      fc.property(nodeArbitrary(TestDecoratorBlockNode), props => {
        expectCloneCarriesSchemaFields(TestDecoratorBlockNode, props);
      }),
    );
  });

  test('TableCellNode', () => {
    fc.assert(
      fc.property(nodeArbitrary(TableCellNode), props => {
        expectCloneCarriesSchemaFields(TableCellNode, props, {
          nodes: [TableNode, TableRowNode],
          place: cell => {
            $getRoot().append(
              $createTableNode().append(
                $createTableRowNode().append(
                  cell.append($createParagraphNode()),
                ),
              ),
            );
          },
        });
      }),
    );
  });
});
