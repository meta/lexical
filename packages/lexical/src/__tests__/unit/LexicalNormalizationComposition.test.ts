/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setCompositionKey,
  COLLABORATION_TAG,
  COMPOSITION_END_TAG,
  COMPOSITION_START_TAG,
  createEditor,
  type ElementNode,
  HISTORIC_TAG,
  HISTORY_MERGE_TAG,
  type LexicalEditor,
  type NodeKey,
  PASTE_TAG,
  SKIP_COLLAB_TAG,
  type TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

// Without DEFER_COMPOSITION_MERGE_TAG, an IME composition does not change how
// text nodes are normalized: a text node that becomes adjacent to the composed
// node, with the same format, is merged with it in the same update, exactly as
// when nothing is being composed. That includes updates tagged
// COLLABORATION_TAG or SKIP_COLLAB_TAG. Every scenario runs twice, once with the
// composition key on the composed node and once without, and the two runs
// must produce identical editor states (JSON) and node identities.

type Op = {
  name: string;
  $run: (composed: TextNode) => void;
};

const OPS: Op[] = [
  {
    $run: composed => composed.insertBefore($createTextNode('j1z')),
    name: 'insert before',
  },
  {
    $run: composed => composed.insertAfter($createTextNode('j3z')),
    name: 'insert after',
  },
  {
    $run: composed => {
      composed.insertBefore($createTextNode('j1z'));
      composed.insertAfter($createTextNode('j3z'));
    },
    name: 'insert on both sides',
  },
  {
    // The bold node between plain text and the composed node goes away.
    $run: composed => composed.getPreviousSibling()!.remove(),
    name: 'remove the bold node before',
  },
  {
    $run: composed => composed.getNextSibling()!.remove(),
    name: 'remove the bold node after',
  },
  {
    $run: composed => (composed.getPreviousSibling() as TextNode).setFormat(0),
    name: 'unbold the node before',
  },
  {
    // A line join from another source: the next line's text moves next to the
    // composition.
    $run: composed => {
      const line = composed.getParentOrThrow();
      const next = line.getNextSibling() as ElementNode;
      line.append(...next.getChildren());
      next.remove();
    },
    name: 'join the next line',
  },
];

const TAGS: (string | undefined)[] = [
  undefined,
  COLLABORATION_TAG,
  HISTORIC_TAG,
  HISTORY_MERGE_TAG,
  PASTE_TAG,
  SKIP_COLLAB_TAG,
  COMPOSITION_START_TAG,
  COMPOSITION_END_TAG,
];

type Outcome = {
  steps: {json: string; nodes: string[]}[];
};

function createTestEditor(): LexicalEditor {
  return createEditor({
    namespace: 'test',
    onError: (e: Error) => {
      throw e;
    },
  });
}

/** The text node holding the composed text (it may have been merged). */
function $composedText(): TextNode {
  for (const node of $getRoot().getAllTextNodes()) {
    if (node.getTextContent().includes('に')) {
      return node;
    }
  }
  throw new Error('the composed text is gone');
}

function run(
  op: Op,
  tag: string | undefined,
  skipTransforms: false | true,
  composing: boolean,
): Outcome {
  const editor = createTestEditor();
  const labels = new Map<NodeKey, string>();
  const snapshot = () =>
    editor.read(() => ({
      json: JSON.stringify(editor.getEditorState().toJSON()),
      nodes: $getRoot()
        .getChildren()
        .map(node => $assertNodeType(node, $isElementNode))
        .flatMap(line => line.getChildren())
        .map(
          n =>
            `${labels.get(n.getKey()) || 'new'}:${n.getTextContent()}` +
            ($isTextNode(n) && n.getFormat() !== 0 ? '{b}' : ''),
        ),
    }));
  const steps: Outcome['steps'] = [];
  editor.update(
    () => {
      const before = $createTextNode('j1z');
      const bold1 = $createTextNode('B').toggleFormat('bold');
      const composed = $createTextNode('にj2z');
      const bold2 = $createTextNode('C').toggleFormat('bold');
      const after = $createTextNode('j3z');
      const joined = $createTextNode('k1z');
      const isBold = op.name.includes('bold');
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append(
            ...(isBold ? [before, bold1, composed, bold2, after] : [composed]),
          ),
          $createParagraphNode().append(joined),
        );
      for (const [node, label] of [
        [before, 'before'],
        [bold1, 'bold1'],
        [composed, 'composed'],
        [bold2, 'bold2'],
        [after, 'after'],
        [joined, 'joined'],
      ] as const) {
        labels.set(node.getKey(), label);
      }
      composed.select(1, 1);
      if (composing) {
        $setCompositionKey(composed.getKey());
      } else {
        composed.getWritable();
      }
    },
    {discrete: true},
  );
  steps.push(snapshot());
  editor.update(
    () => {
      op.$run($composedText());
    },
    {discrete: true, tag, ...(skipTransforms ? {skipTransforms} : {})},
  );
  steps.push(snapshot());
  // The next composition step: the composed node's text changes.
  editor.update(
    () => {
      const node = $composedText();
      node.setTextContent(node.getTextContent().replace('に', 'にほ'));
    },
    {discrete: true},
  );
  steps.push(snapshot());
  // The composition ends.
  editor.update(
    () => {
      if (composing) {
        $setCompositionKey(null);
      } else {
        $composedText().getWritable();
      }
    },
    {discrete: true},
  );
  steps.push(snapshot());
  return {steps};
}

describe('Normalization next to an IME composition, without DEFER_COMPOSITION_MERGE_TAG', () => {
  for (const op of OPS) {
    for (const tag of TAGS) {
      for (const skipTransforms of [false, true]) {
        test(`${op.name}, tag ${tag || '(none)'}${skipTransforms ? ', skipTransforms' : ''}`, () => {
          expect(run(op, tag, skipTransforms, true)).toEqual(
            run(op, tag, skipTransforms, false),
          );
        });
      }
    }
  }

  test('text inserted before the composed node merges with it at once', () => {
    const {steps} = run(OPS[0], undefined, false, true);
    expect(steps.map(s => s.nodes)).toEqual([
      ['composed:にj2z', 'joined:k1z'],
      ['new:j1zにj2z', 'joined:k1z'],
      ['new:j1zにほj2z', 'joined:k1z'],
      ['new:j1zにほj2z', 'joined:k1z'],
    ]);
  });

  test('a line joined into the composing line merges at once', () => {
    const {steps} = run(OPS[6], undefined, true, true);
    expect(steps.map(s => s.nodes)).toEqual([
      ['composed:にj2z', 'joined:k1z'],
      ['composed:にj2zk1z'],
      ['composed:にほj2zk1z'],
      ['composed:にほj2zk1z'],
    ]);
  });
});
