/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Parts of one stored segmented run (a comment another writer put on part of
// it) while a part is being composed: the author's read-back of the run
// waits until nothing is composed, as a read would make every part one node,
// the composed one included, and rewrite the IME's target. Cases still open
// (inherited: main behaves the same) are test.fails with their issue.

import {$createCodeHighlightNode} from '@lexical/code';
import {$removeMarkID} from '@lexical/mark';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $setCompositionKey,
  $setSelection,
  COLLABORATION_TAG,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {freshReader, type Peer, setup, WITH_GC} from '../../utils/harness';
import {prepareMarkState} from '../../utils/sizeOps';

const mark = 's:markIds\u001fc5';
type RawRoot = {
  format(at: number, length: number, attrs: object): void;
  toDelta(): {children: {insert: unknown; format?: Record<string, unknown>}[]};
};
const raw = (p: Peer) => p.doc.get('lexical-y') as unknown as RawRoot;
const $children = () =>
  (
    $getRoot().getFirstChildOrThrow() as ElementNode
  ).getChildren() as TextNode[];
const stop = (peers: Peer[]) => {
  for (const p of peers) {
    p.stop();
    p.doc.destroy();
  }
};

async function split(make: () => TextNode, at = 6, length = 4) {
  const t = await setup(
    () => $getRoot().append($createParagraphNode().append(make())),
    {gc: WITH_GC, prepare: prepareMarkState},
  );
  t.a.doc.transact(
    () => raw(t.a).format(at, length, {[mark]: true}),
    'outside',
  );
  await t.sync();
  return t;
}

// A read must keep the text and key the browser is composing into.
describe.each([0, 1])('composition in part %s', index => {
  // Inherited (main too): https://github.com/meta/lexical/issues/9739
  test.fails(
    'a remote comment removal preserves the composed target',
    async () => {
      const t = await split(() =>
        $createTextNode('alpha beta').setMode('segmented'),
      );
      try {
        const key = t.b.read(() => $children()[index].getKey());
        const text = t.b.read(() => $children()[index].getTextContent());
        t.b.update(() => {
          const node = $getNodeByKey(key) as TextNode;
          node.select(1, 1);
          $setCompositionKey(key);
        });
        t.a.update(() => $removeMarkID('c5'));
        await t.sync();
        expect(t.b.editor._compositionKey).toBe(key);
        expect(t.b.read(() => $getNodeByKey(key)?.getTextContent())).toBe(text);
      } finally {
        stop(t.peers);
      }
    },
  );
});

// Regression: reading the run back while another part is composed rewrote it
test('flattening other parts in the same line preserves the composed part', async () => {
  const t = await split(() =>
    $createTextNode('alpha beta gamma').setMode('segmented'),
  );
  try {
    const key = t.b.read(() => $children()[0].getKey());
    t.b.update(() => {
      ($getNodeByKey(key) as TextNode).select(1, 1);
      $setCompositionKey(key);
    });
    t.b.update(() => {
      $removeMarkID('c5');
      $setSelection(null);
    });
    await t.sync();
    expect(t.b.editor._compositionKey).toBe(key);
    expect(t.b.read(() => $getNodeByKey(key)?.getTextContent())).toBe('alpha ');
  } finally {
    stop(t.peers);
  }
});

describe.each(['keystroke', 'composition end', 'composing keystroke'])(
  'equal highlight parts: %s',
  action => {
    // A code highlight ignores a stored bold that a full write would remove:
    // these writes keep the keystroke path. The ignored bold does not split
    // the highlight into two nodes (see Reader#$pieces and
    // CodeHighlightStaleFormat.test.ts): read as two, text typed into either
    // part read apart from it in a fresh read.
    test('preserves an ignored stored bold', async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createCodeHighlightNode('alpha beta', 'comment'),
            ),
          ),
        {gc: WITH_GC},
      );
      try {
        t.a.doc.transact(
          () => raw(t.a).format(6, 4, {'f:bold': true}),
          'outside',
        );
        await t.sync();
        expect(
          t.b.read(() =>
            $children().map(n => [n.getTextContent(), n.getFormat()]),
          ),
        ).toEqual([['alpha beta', 0]]);
        if (action === 'keystroke') {
          t.b.update(() => {
            $children()[0].setTextContent('alpha beta!').select(11, 11);
          });
        } else {
          t.b.update(() => {
            $children()[0].select(7, 7);
            $setCompositionKey($children()[0].getKey());
          });
          if (action === 'composition end') {
            t.b.update(() => $setCompositionKey(null));
          } else {
            t.b.update(() =>
              $children()[0].setTextContent('alpha beta!').select(11, 11),
            );
          }
        }
        await t.sync();
        const fresh = await freshReader(t.b);
        expect(fresh.describe()).toBe(t.b.describe());
        const delta = JSON.parse(
          JSON.stringify(raw(t.b).toDelta()),
        ) as ReturnType<RawRoot['toDelta']>;
        const bold = delta.children
          .filter(
            p => typeof p.insert === 'string' && p.format?.['f:bold'] === true,
          )
          .map(p => p.insert)
          .join('');
        expect(bold).toBe('beta');
      } finally {
        stop(t.peers);
      }
    });
  },
);

// Safari/WebKit can keep an empty text target during composition. An empty
// stored segment must likewise remain addressable until the composition ends.
// Inherited (main too): https://github.com/meta/lexical/issues/9739
test.fails(
  'a remote format read preserves an empty composed segment',
  async () => {
    const t = await split(() =>
      $createTextNode('alpha beta').setMode('segmented'),
    );
    try {
      const key = t.b.read(() => $children()[1].getKey());
      t.b.update(() => {
        const node = $getNodeByKey(key) as TextNode;
        node.select(0, 0);
        $setCompositionKey(key);
        node.setTextContent('');
      });
      await t.sync();
      expect(t.b.read(() => $getNodeByKey(key)?.getTextContent())).toBe('');
      t.a.update(() => $children()[0].toggleFormat('italic'));
      await t.sync();
      expect(t.b.editor._compositionKey).toBe(key);
      expect(t.b.read(() => $getNodeByKey(key)?.getTextContent())).toBe('');
    } finally {
      stop(t.peers);
    }
  },
);

// Inherited (main too): https://github.com/meta/lexical/issues/9739
test.fails(
  'composition ended in a collaboration-tagged update still joins the deferred parts',
  async () => {
    const t = await split(() =>
      $createTextNode('alpha beta').setMode('segmented'),
    );
    try {
      t.b.update(() => {
        const node = $children()[1];
        node.select(1, 1);
        $setCompositionKey(node.getKey());
      });
      t.b.update(() => $removeMarkID('c5'));
      await t.sync();
      t.b.editor.update(() => $setCompositionKey(null), {
        discrete: true,
        tag: COLLABORATION_TAG,
      });
      await t.sync();
      expect(t.b.read(() => $children().map(n => n.getTextContent()))).toEqual([
        'alpha beta',
      ]);
    } finally {
      stop(t.peers);
    }
  },
);

describe.each([0, 1])(
  'local removal with two parts, composing part %s',
  index => {
    // The parts are joined at the next write of the line that reads back, not
    // at the composition end: https://github.com/meta/lexical/issues/9739
    test.fails(
      'holds the target and joins the parts at the ordinary composition end',
      async () => {
        const t = await split(() =>
          $createTextNode('alpha beta').setMode('segmented'),
        );
        try {
          const key = t.b.read(() => $children()[index].getKey());
          const text = t.b.read(() => $children()[index].getTextContent());
          t.b.update(() => {
            ($getNodeByKey(key) as TextNode).select(1, 1);
            $setCompositionKey(key);
          });
          t.b.update(() => $removeMarkID('c5'));
          await t.sync();
          expect(t.b.editor._compositionKey).toBe(key);
          expect(t.b.read(() => $getNodeByKey(key)?.getTextContent())).toBe(
            text,
          );
          t.b.update(() => $setCompositionKey(null));
          await t.sync();
          expect(
            t.b.read(() => $children().map(n => n.getTextContent())),
          ).toEqual(['alpha beta']);
        } finally {
          stop(t.peers);
        }
      },
    );
  },
);

// Simple text keeps the read-back it had before while a node is composed
// (equal NodeState that Lexical compares by reference): the composition
// rule holds back only parts of a stored run.
test('simple text keeps its read-back during a composition', async () => {
  const $opaque = (text: string) =>
    $createTextNode(text).updateFromJSON({
      $: {opaque: {nested: {level: 7}, tag: 'equal'}},
      detail: 0,
      format: 0,
      mode: 'normal',
      style: '',
      text,
    });
  const t = await setup(
    () => $getRoot().append($createParagraphNode().append($opaque('one'))),
    {gc: WITH_GC},
  );
  try {
    const key = t.b.read(() => $children()[0].getKey());
    t.b.update(() => {
      ($getNodeByKey(key) as TextNode).select(1, 1);
      $setCompositionKey(key);
    });
    let reads = 0;
    const off = t.b.editor.registerUpdateListener(({tags}) => {
      if (tags.has(COLLABORATION_TAG)) {
        reads++;
      }
    });
    t.b.update(() =>
      ($getRoot().getFirstChildOrThrow() as ElementNode).append($opaque('two')),
    );
    await t.sync();
    off();
    expect(reads).toBe(1);
    expect(t.b.editor._compositionKey).toBe(key);
    expect(t.b.read(() => $getNodeByKey(key)?.getTextContent())).toBe('one');
  } finally {
    stop(t.peers);
  }
});
