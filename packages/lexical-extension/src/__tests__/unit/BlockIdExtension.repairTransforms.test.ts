/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $getBlockId,
  BlockIdExtension,
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
  NodeStructureExtension,
} from '@lexical/extension';
import {$createQuoteNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  COLLABORATION_TAG,
  configExtension,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// `repairTransforms`: whether the update that names the blocks an update
// applied with skipTransforms (or tagged COLLABORATION_TAG or HISTORIC_TAG)
// left without an id runs the editor's transforms.

function build(repairTransforms?: boolean): LexicalEditorWithDispose {
  let n = 0;
  const editor = buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      RichTextExtension,
      NodeStructureExtension,
      configExtension(BlockIdExtension, {
        generateId: () => `g${++n}`,
        ...(repairTransforms === undefined ? {} : {repairTransforms}),
      }),
    ],
    name: 'test',
    onError: e => {
      throw e;
    },
  });
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode('one')));
    },
    {discrete: true},
  );
  return editor;
}

/** Each block as `type(text)#id`, nested blocks in brackets. */
function describeDoc(editor: LexicalEditorWithDispose): string {
  return editor.getEditorState().read(() => {
    const visit = (n: LexicalNode): string => {
      if (!$isElementNode(n) || n.isInline()) {
        return JSON.stringify(n.getTextContent());
      }
      return `${n.getType()}#${$getBlockId(n) ?? 'none'}[${n
        .getChildren()
        .map(visit)
        .join(' ')}]`;
    };
    return $getRoot().getChildren().map(visit).join(' / ');
  });
}

/** A quote holding two paragraphs, which NodeStructureExtension joins. */
function $appendQuoteOfParagraphs(): void {
  $getRoot().append(
    $createQuoteNode().append(
      $createParagraphNode().append($createTextNode('a')),
      $createParagraphNode().append($createTextNode('b')),
    ),
  );
}

describe('BlockIdExtension repairTransforms', () => {
  test('defaults to true: the follow-up update runs the transforms', () => {
    using editor = build();
    // The update leaves the blocks it adds without ids and the quote's
    // paragraphs unjoined; the follow-up names them and, running
    // NodeStructureExtension's transforms, joins the paragraphs.
    editor.update($appendQuoteOfParagraphs, {
      discrete: true,
      skipTransforms: true,
    });
    expect(describeDoc(editor)).toMatch(
      /^paragraph#[\w-]+\["one"\] \/ quote#[\w-]+\["a" "\\n" "b"\]$/,
    );
  });

  test('false: the follow-up of an update applied with skipTransforms only sets ids', () => {
    using editor = build(false);
    editor.update($appendQuoteOfParagraphs, {
      discrete: true,
      skipTransforms: true,
    });
    // The structure is as the update left it; every block is named, with
    // the positional ids every reader of that document derives, not
    // generated ones.
    const doc = describeDoc(editor);
    expect(doc).toMatch(
      /^paragraph#[\w-]+\["one"\] \/ quote#[\w-]+\[paragraph#[\w-]+\["a"\] paragraph#[\w-]+\["b"\]\]$/,
    );
    expect(doc).not.toMatch(/#g\d|#none/);
  });

  test('false: the follow-up of an update tagged COLLABORATION_TAG names the blocks alike', () => {
    using a = build(true);
    using b = build(false);
    for (const editor of [a, b]) {
      editor.update($appendQuoteOfParagraphs, {
        discrete: true,
        tag: COLLABORATION_TAG,
      });
    }
    // The update ran its own transforms; the follow-up only names.
    expect(describeDoc(b)).toBe(describeDoc(a));
    expect(describeDoc(b)).not.toMatch(/#g\d|#none/);
  });

  test('false: the blocks it names get the ids the default gives them', () => {
    using a = build(true);
    using b = build(false);
    for (const editor of [a, b]) {
      // Content that the structure normalization keeps as it is.
      editor.update(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('two')),
            $createParagraphNode().append($createTextNode('three')),
          );
        },
        {discrete: true, skipTransforms: true},
      );
    }
    expect(describeDoc(b)).toBe(describeDoc(a));
    // A later local edit gets a generated id, as with the default.
    b.update(
      () => {
        ($getRoot().getLastChild() as ElementNode).insertAfter(
          $createParagraphNode().append($createTextNode('four')),
        );
      },
      {discrete: true},
    );
    expect(describeDoc(b)).toMatch(/paragraph#g1\["four"\]$/);
  });
});
