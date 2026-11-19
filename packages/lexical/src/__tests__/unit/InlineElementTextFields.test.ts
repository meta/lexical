/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

import {$generateJSONFromSelectedNodes} from '@lexical/clipboard';
import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $parseSerializedNode,
  $selectAll,
  defineExtension,
  ElementNode,
  type LexicalNode,
  type SerializedLexicalNode,
} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

// An element's textFormat and textStyle are persisted only when it has no
// text a reconcile would derive them from (#7968). A reconcile derives them
// from the element's first text at any depth; for an inline element (a link,
// a mark) the JSON now follows that rule too, so a link whose text sits in a
// mark no longer persists them. A block keeps the direct-children check, so
// the JSON of a paragraph whose text is all inside links is unchanged.

class InlineWrapperNode extends ElementNode {
  $config() {
    return this.config('test-inline-wrapper', {extends: ElementNode});
  }
  isInline(): boolean {
    return true;
  }
}

/** An inline element whose clone reads the JSON of the node it is made from. */
class CloneReadsJSONNode extends InlineWrapperNode {
  $config() {
    return this.config('test-clone-reads-json', {extends: InlineWrapperNode});
  }
  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    prevNode.exportJSON();
  }
}

function $wrapper(...children: LexicalNode[]): InlineWrapperNode {
  return $create(InlineWrapperNode)
    .setTextFormat(1)
    .setTextStyle('color: red')
    .append(...children);
}

function withEditor(fn: () => void): void {
  using editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      name: '[inline-element-text-fields]',
      nodes: [InlineWrapperNode, CloneReadsJSONNode],
    }),
  );
  editor.update(fn, {discrete: true});
}

type Fields = {textFormat?: number; textStyle?: string};

function fields(node: ElementNode): Fields {
  const json = node.exportJSON();
  return {textFormat: json.textFormat, textStyle: json.textStyle};
}

/**
 * What ElementNode persists for a block (ParagraphNode's exportJSON then
 * backfills them from its first text child for #7971).
 */
function serialized(node: ElementNode): Fields {
  return {
    textFormat: node.getSerializedTextFormat(),
    textStyle: node.getSerializedTextStyle(),
  };
}

const PERSISTED: Fields = {textFormat: 1, textStyle: 'color: red'};
const OMITTED: Fields = {textFormat: undefined, textStyle: undefined};

describe('textFormat and textStyle of an inline element', () => {
  test('are omitted when its text sits in an inline element inside it', () => {
    withEditor(() => {
      const inner = $wrapper($createTextNode('text'));
      const outer = $wrapper(inner);
      const outermost = $wrapper($wrapper($wrapper($createTextNode('deep'))));
      $getRoot().append($createParagraphNode().append(outer, outermost));
      expect(fields(outer)).toEqual(OMITTED);
      expect(fields(inner)).toEqual(OMITTED);
      expect(fields(outermost)).toEqual(OMITTED);
    });
  });

  test('are omitted when it holds text of its own, as before', () => {
    withEditor(() => {
      const wrapper = $wrapper($createTextNode('text'));
      $getRoot().append($createParagraphNode().append(wrapper));
      expect(fields(wrapper)).toEqual(OMITTED);
    });
  });

  test('are persisted when it holds no text at any depth, as before', () => {
    withEditor(() => {
      const empty = $wrapper();
      const lineBreak = $wrapper($createLineBreakNode());
      const nested = $wrapper($wrapper($createLineBreakNode()));
      $getRoot().append(
        $createParagraphNode().append(empty, lineBreak, nested),
      );
      expect(fields(empty)).toEqual(PERSISTED);
      expect(fields(lineBreak)).toEqual(PERSISTED);
      expect(fields(nested)).toEqual(PERSISTED);
    });
  });

  test('a stored value is read and no longer written once it has text inside', () => {
    withEditor(() => {
      const stored = {
        children: [
          {
            children: [
              {
                detail: 0,
                format: 1,
                mode: 'normal',
                style: 'color: red',
                text: 'text',
                type: 'text',
                version: 1,
              },
            ],
            direction: null,
            format: '',
            indent: 0,
            textFormat: 1,
            textStyle: 'color: red',
            type: 'test-inline-wrapper',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        textFormat: 1,
        textStyle: 'color: red',
        type: 'test-inline-wrapper',
        version: 1,
      } as SerializedLexicalNode;
      const outer = $parseSerializedNode(stored) as InlineWrapperNode;
      expect(outer.getTextFormat()).toBe(1);
      expect(outer.getTextStyle()).toBe('color: red');
      $getRoot().append($createParagraphNode().append(outer));
      expect(fields(outer)).toEqual(OMITTED);
    });
  });
});

describe('textFormat and textStyle of a block', () => {
  test('are persisted when its text is all inside inline elements, as before', () => {
    withEditor(() => {
      const paragraph = $createParagraphNode()
        .setTextFormat(1)
        .setTextStyle('color: red')
        .append($wrapper($createTextNode('text')));
      $getRoot().append(paragraph);
      expect(serialized(paragraph)).toEqual(PERSISTED);
    });
  });

  test('are omitted when it holds text of its own, as before', () => {
    withEditor(() => {
      const paragraph = $createParagraphNode()
        .setTextFormat(1)
        .setTextStyle('color: red')
        .append($createTextNode('text'), $wrapper($createTextNode('more')));
      $getRoot().append(paragraph);
      expect(serialized(paragraph)).toEqual(OMITTED);
    });
  });
});

/** getFirstChild calls while `fn` runs. */
function countGetFirstChild(fn: () => void): number {
  const getFirstChild = ElementNode.prototype.getFirstChild;
  let count = 0;
  const spy = vi
    .spyOn(ElementNode.prototype, 'getFirstChild')
    .mockImplementation(function (this: ElementNode) {
      count++;
      return getFirstChild.call(this);
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return count;
}

/** Each node's exportJSON, as the clipboard exports a selection. */
function $exportEach(node: LexicalNode): unknown {
  const json = node.exportJSON() as {children?: unknown[]};
  if (node instanceof ElementNode) {
    json.children = node.getChildren().map($exportEach);
  }
  return json;
}

describe('serializing inline elements nested inside each other', () => {
  for (const where of [
    'a committed state',
    'an update',
    'a copy after a change in the same update',
  ] as const) {
    test(`stays linear in the depth when each carries text fields, in ${where}`, () => {
      const calls: number[] = [];
      for (const depth of [64, 128, 256]) {
        using editor = buildEditorFromExtensions(
          defineExtension({
            $initialEditorState: null,
            name: '[inline-element-text-fields-depth]',
            nodes: [InlineWrapperNode],
          }),
        );
        editor.update(
          () => {
            let node: LexicalNode = $createTextNode('leaf');
            for (let i = 0; i < depth; i++) {
              node = $wrapper(node);
            }
            $getRoot().append($createParagraphNode().append(node));
          },
          {discrete: true},
        );
        let json = '';
        calls.push(
          countGetFirstChild(() => {
            if (where === 'a committed state') {
              json = JSON.stringify(editor.getEditorState().toJSON());
            } else if (where === 'an update') {
              editor.update(
                () => {
                  json = JSON.stringify($exportEach($getRoot()));
                },
                {discrete: true},
              );
            } else {
              editor.update(
                () => {
                  $getRoot().getAllTextNodes()[0].toggleFormat('italic');
                  $selectAll();
                  json = JSON.stringify(
                    $generateJSONFromSelectedNodes(editor, $getSelection()),
                  );
                },
                {discrete: true},
              );
            }
          }),
        );
        expect(json).toContain('leaf');
      }
      // Doubling the depth doubles the walk (about 2x), where a walk of
      // each element's whole subtree would quadruple it.
      expect(calls[1] / calls[0]).toBeLessThan(3);
      expect(calls[2] / calls[1]).toBeLessThan(3);
    });
  }

  test('a change in an update is seen by the next serialization in it', () => {
    withEditor(() => {
      const text = $createTextNode('text');
      const inner = $wrapper(text);
      const outer = $wrapper(inner);
      $getRoot().append($createParagraphNode().append(outer));
      expect(fields(outer)).toEqual(OMITTED);
      text.remove();
      inner.append($createLineBreakNode());
      expect(fields(outer)).toEqual(PERSISTED);
      inner.append($createTextNode('again'));
      expect(fields(outer)).toEqual(OMITTED);
    });
  });

  test('a clone that reads JSON before the change it is made for does not keep what the change replaces', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[inline-element-text-fields-clone]',
        nodes: [InlineWrapperNode, CloneReadsJSONNode],
      }),
    );
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $create(CloneReadsJSONNode)
              .setTextFormat(1)
              .append($createTextNode('leaf')),
          ),
        );
      },
      {discrete: true},
    );
    let inside: Fields = {};
    editor.update(
      () => {
        const wrapper = (
          $getRoot().getFirstChildOrThrow() as ElementNode
        ).getFirstChildOrThrow() as CloneReadsJSONNode;
        wrapper.getFirstChildOrThrow().remove();
        inside = fields(wrapper);
      },
      {discrete: true},
    );
    expect(inside.textFormat).toBe(1);
    const committed = editor.getEditorState().toJSON() as unknown as {
      root: {children: {children: Fields[]}[]};
    };
    expect(committed.root.children[0].children[0].textFormat).toBe(1);
  });
});
