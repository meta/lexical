/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A segmented or token text node is stored as one run with one segment key.
// A format another writer puts on part of that run (Yjs restoring a comment
// on undo, or any outside writer) makes every reader show the run as two
// nodes of that mode with the same segment key. When a client then removes
// that format, it stores the run as one again; its editor must show what
// every reader shows (one node), as it does for two plain text nodes that
// store the same attributes, not keep the two nodes Lexical never merges.

import {$addMarkID, $getNodeMarkIDs, $removeMarkID} from '@lexical/mark';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setCompositionKey,
  $setSelection,
  COLLABORATION_TAG,
  type ElementNode,
  type TextModeType,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {NODE_SHAPES} from '../../catalog/nodes';
import {
  freshReader,
  NODES,
  type Peer,
  setup,
  WITH_GC,
} from '../../utils/harness';
import {prepareMarkState} from '../../utils/sizeOps';

/** A text entity class (not simple text, so Lexical never merges it). */
class EntityNode extends TextNode {
  $config() {
    return this.config('test-entity', {extends: TextNode});
  }
}

type RawRoot = {
  format(index: number, length: number, attrs: object): void;
  insert(index: number, content: string, attrs: object): void;
  toDelta(): unknown;
};
const rawRoot = (peer: Peer) => peer.doc.get('lexical-y') as unknown as RawRoot;

/** The stored key of comment id `id` (a NodeState set member). */
const MARK_KEY = (id: string) => `s:markIds\u001f${id}`;

function shape(peer: Peer): string {
  return peer.read(() =>
    ($getRoot().getFirstChildOrThrow() as ElementNode)
      .getChildren()
      .map(child => {
        const node = child as TextNode;
        const ids = $getNodeMarkIDs(node);
        const type = node.getType() === 'text' ? '' : `${node.getType()}/`;
        return `${type}${JSON.stringify(node.getTextContent())}:${node.getMode()}${
          ids.length > 0 ? `[${ids.join(',')}]` : ''
        }`;
      })
      .join(' '),
  );
}

async function expectReadersAgree(peers: Peer[]): Promise<string> {
  for (const peer of peers) {
    expect(peer.errors).toEqual([]);
    expect(
      peer.warnings.filter(
        w => w.includes('self-check') || w.includes('could not be written'),
      ),
    ).toEqual([]);
  }
  const shapes: string[] = [];
  for (const peer of peers) {
    const fresh = await freshReader(peer);
    shapes.push(`${shape(peer)} | fresh ${shape(fresh)}`);
    fresh.stop();
    fresh.doc.destroy();
  }
  for (const line of shapes) {
    const [editor, fresh] = line.split(' | fresh ');
    expect(editor).toBe(fresh);
  }
  return shapes[0].split(' | fresh ')[0];
}

/**
 * The updates `peer` reads back (tagged COLLABORATION_TAG) while `run` runs:
 * after a peer's own write, a read-back of its content.
 */
async function countReads(
  peer: Peer,
  run: () => Promise<void>,
): Promise<number> {
  let reads = 0;
  const off = peer.editor.registerUpdateListener(({tags}) => {
    if (tags.has(COLLABORATION_TAG)) {
      reads++;
    }
  });
  try {
    await run();
  } finally {
    off();
  }
  return reads;
}

describe.each(['segmented', 'token'] as TextModeType[])(
  'a %s run split by an outside format',
  mode => {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      for (const remover of ['the outside writer', 'the other client']) {
        test(`ids ${ids.join(',')}, removed by ${remover}: the author shows one node, as every reader`, async () => {
          const t = await setup(
            () => {
              $getRoot().append(
                $createParagraphNode().append(
                  $createTextNode('alpha beta').setMode(mode),
                ),
              );
            },
            {gc: WITH_GC, ids, prepare: prepareMarkState},
          );
          try {
            const [a, b] = t.peers;
            // Yjs restores comment c5 on "beta" only (as an undo of its
            // removal does), on A's document: one run, one segment key.
            const root = a.doc.get('lexical-y') as unknown as {
              format(index: number, length: number, attrs: object): void;
            };
            a.doc.transact(() => {
              root.format(6, 4, {[MARK_KEY('c5')]: true});
            }, 'outside');
            await t.sync();
            expect(shape(a)).toBe(`"alpha ":${mode} "beta":${mode}[c5]`);
            expect(shape(b)).toBe(shape(a));
            const p = remover === 'the outside writer' ? a : b;
            p.update(() => {
              $removeMarkID('c5');
              $setSelection(null);
            });
            await t.sync();
            expect(await expectReadersAgree(t.peers)).toBe(
              `"alpha beta":${mode}`,
            );
          } finally {
            for (const peer of t.peers) {
              peer.stop();
              peer.doc.destroy();
            }
          }
        });
      }
    }

    test('a caret in the second part stays on its character when the author reads the run back', async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('alpha beta').setMode(mode),
            ),
          );
        },
        {gc: WITH_GC, prepare: prepareMarkState},
      );
      try {
        const [a, b] = t.peers;
        const root = a.doc.get('lexical-y') as unknown as {
          format(index: number, length: number, attrs: object): void;
        };
        a.doc.transact(() => {
          root.format(6, 4, {[MARK_KEY('c5')]: true});
        }, 'outside');
        await t.sync();
        b.editor.update(
          () => {
            const beta = (
              $getRoot().getFirstChildOrThrow() as ElementNode
            ).getLastChildOrThrow() as TextNode;
            const selection = $createRangeSelection();
            selection.anchor.set(beta.getKey(), 2, 'text');
            selection.focus.set(beta.getKey(), 2, 'text');
            $setSelection(selection);
            $removeMarkID('c5');
          },
          {discrete: true},
        );
        await t.sync();
        expect(await expectReadersAgree(t.peers)).toBe(`"alpha beta":${mode}`);
        expect(
          b.read(() => {
            const selection = $getSelection();
            return $isRangeSelection(selection)
              ? [
                  selection.anchor.getNode().getTextContent(),
                  selection.anchor.offset,
                  selection.isCollapsed(),
                ]
              : null;
          }),
        ).toEqual(['alpha beta', 8, true]);
      } finally {
        for (const peer of t.peers) {
          peer.stop();
          peer.doc.destroy();
        }
      }
    });

    test('two nodes made apart keep their own segment keys: removing a comment from one keeps two nodes', async () => {
      const t = await setup(
        () => {
          const second = $createTextNode('beta').setMode(mode);
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('alpha ').setMode(mode),
              second,
            ),
          );
          const selection = $createRangeSelection();
          selection.anchor.set(second.getKey(), 0, 'text');
          selection.focus.set(second.getKey(), 4, 'text');
          $addMarkID('c5', selection);
          $setSelection(null);
        },
        {gc: WITH_GC, prepare: prepareMarkState},
      );
      try {
        // Equal attributes but their own segment keys: no read-back
        const reads = await countReads(t.b, async () => {
          t.b.update(() => {
            $removeMarkID('c5');
            $setSelection(null);
          });
          await t.sync();
        });
        expect(reads).toBe(0);
        expect(await expectReadersAgree(t.peers)).toBe(
          `"alpha ":${mode} "beta":${mode}`,
        );
      } finally {
        for (const peer of t.peers) {
          peer.stop();
          peer.doc.destroy();
        }
      }
    });
  },
);

describe('other parts of one stored run', () => {
  async function splitRun(make: () => TextNode, at: number, length: number) {
    const t = await setup(
      () => {
        $getRoot().append($createParagraphNode().append(make()));
      },
      {gc: WITH_GC, nodes: [...NODES, EntityNode], prepare: prepareMarkState},
    );
    // Yjs restores comment c5 on part of the run (as an undo of its removal
    // does): one run, one segment key, shown as several nodes.
    t.a.doc.transact(() => {
      rawRoot(t.a).format(at, length, {[MARK_KEY('c5')]: true});
    }, 'outside');
    await t.sync();
    return t;
  }
  const stop = (peers: Peer[]) => {
    for (const peer of peers) {
      peer.stop();
      peer.doc.destroy();
    }
  };

  test('a text entity class split by a comment: the author shows one entity again', async () => {
    const t = await splitRun(
      () => $create(EntityNode).setTextContent('alpha beta'),
      6,
      4,
    );
    try {
      expect(shape(t.b)).toBe(
        'test-entity/"alpha ":normal test-entity/"beta":normal[c5]',
      );
      t.b.update(() => {
        $removeMarkID('c5');
        $setSelection(null);
      });
      await t.sync();
      expect(await expectReadersAgree(t.peers)).toBe(
        'test-entity/"alpha beta":normal',
      );
    } finally {
      stop(t.peers);
    }
  });

  test('a comment removed while its part is composed: no read-back while composing, the parts joined at the next full write', async () => {
    const t = await splitRun(
      () => $createTextNode('alpha beta').setMode('segmented'),
      6,
      4,
    );
    try {
      t.b.editor.update(
        () => {
          const beta = (
            $getRoot().getFirstChildOrThrow() as ElementNode
          ).getLastChildOrThrow() as TextNode;
          $setCompositionKey(beta.getKey());
        },
        {discrete: true},
      );
      // While "beta" is composed, the author keeps the parts: no read-back
      // (it would rewrite the composed node's text under the IME)
      const whileComposing = await countReads(t.b, async () => {
        t.b.editor.update(
          () => {
            $removeMarkID('c5');
            $setSelection(null);
          },
          {discrete: true},
        );
        await t.sync();
      });
      expect(whileComposing).toBe(0);
      expect(shape(t.b)).toBe('"alpha ":segmented "beta":segmented');
      // Nor at its end: the write that ends it takes the keystroke path,
      // which writes the composed part alone
      const atEnd = await countReads(t.b, async () => {
        t.b.editor.update(
          () => {
            $setCompositionKey(null);
          },
          {discrete: true},
        );
        await t.sync();
      });
      expect(atEnd).toBe(0);
      expect(shape(t.b)).toBe('"alpha ":segmented "beta":segmented');
      // The next write of the line through the full writer joins them (here
      // a comment added to the first part and removed again)
      t.b.update(() => {
        const alpha = (
          $getRoot().getFirstChildOrThrow() as ElementNode
        ).getFirstChildOrThrow() as TextNode;
        const selection = $createRangeSelection();
        selection.anchor.set(alpha.getKey(), 0, 'text');
        selection.focus.set(alpha.getKey(), 6, 'text');
        $setSelection(selection);
        $addMarkID('c6', selection);
        $setSelection(null);
      });
      await t.sync();
      t.b.update(() => {
        $removeMarkID('c6');
        $setSelection(null);
      });
      await t.sync();
      expect(await expectReadersAgree(t.peers)).toBe('"alpha beta":segmented');
    } finally {
      stop(t.peers);
    }
  });

  // An emptied part Lexical keeps (token or segmented) is not stored: the
  // author reads it back after the write (see YBinding#readBackUnstored,
  // #9789), and then shows one node for the parts around it, as readers do
  // (the emptied-part case of https://github.com/meta/lexical/issues/9739).
  test('the commented middle part emptied: the author shows one node for the parts around it', async () => {
    const t = await splitRun(
      () => $createTextNode('alpha xbeta').setMode('segmented'),
      6,
      1,
    );
    try {
      expect(shape(t.b)).toBe(
        '"alpha ":segmented "x":segmented[c5] "beta":segmented',
      );
      t.b.update(() => {
        const middle = (
          $getRoot().getFirstChildOrThrow() as ElementNode
        ).getChildAtIndex(1) as TextNode;
        middle.setTextContent('');
        $setSelection(null);
      });
      await t.sync();
      const fresh = await freshReader(t.b);
      try {
        const text = (p: Peer) =>
          p.read(() =>
            ($getRoot().getFirstChildOrThrow() as ElementNode)
              .getChildren()
              .filter(child => child.getTextContentSize() > 0)
              .map(child => JSON.stringify(child.getTextContent()))
              .join(' '),
          );
        expect(text(t.b)).toBe(text(fresh));
        expect(text(fresh)).toBe('"alpha beta"');
      } finally {
        fresh.stop();
        fresh.doc.destroy();
      }
    } finally {
      stop(t.peers);
    }
  });

  test('two tabs sharing a segment key stay two tabs, as every reader shows them', async () => {
    const t = await setup(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('a'),
            $createTabNode(),
            $createTextNode('b'),
          ),
        );
      },
      {gc: WITH_GC, prepare: prepareMarkState},
    );
    try {
      // An outside writer inserts a second tab with the first tab's stored
      // attributes (its segment key included) right after it.
      const delta = JSON.parse(JSON.stringify(rawRoot(t.a).toDelta())) as {
        children: {insert: unknown; format?: object}[];
      };
      const tab = delta.children.find(piece => piece.insert === '\t');
      expect(tab).toBeDefined();
      t.a.doc.transact(() => {
        rawRoot(t.a).insert(2, '\t', {...tab!.format});
      }, 'outside');
      await t.sync();
      // Readers show the tabs apart anyway: no read-back
      const reads = await countReads(t.b, async () => {
        t.b.update(() => {
          for (const node of (
            $getRoot().getFirstChildOrThrow() as ElementNode
          ).getChildren()) {
            if (node.getType() === 'tab') {
              (node as TextNode).toggleFormat('bold');
            }
          }
          $setSelection(null);
        });
        await t.sync();
      });
      expect(reads).toBe(0);
      const tabs = await expectReadersAgree(t.peers);
      expect(tabs.split('tab/').length - 1).toBe(2);
    } finally {
      stop(t.peers);
    }
  });
});

// Every text variant of the catalog that stores a segment key (a TextNode
// subclass or a mode other than normal), split by a comment on its last
// character and the comment removed: the author shows one node again.
describe.each(
  NODE_SHAPES.filter(
    variant =>
      variant.kind === 'text' &&
      variant.tags.includes('text-variant') &&
      variant.$inline !== undefined &&
      !variant.name.startsWith('tab/'),
  ).map(variant => [variant.name, variant] as const),
)('catalog %s', (_name, variant) => {
  test('split by a comment on its last character and the comment removed: the author shows one node', async ctx => {
    const t = await setup(
      () => {
        $getRoot().append($createParagraphNode().append(...variant.$inline!()));
      },
      {
        gc: WITH_GC,
        nodes: [...NODES, ...variant.classes],
        prepare: prepareMarkState,
      },
    );
    try {
      const before = t.b.read(() => {
        const children = (
          $getRoot().getFirstChildOrThrow() as ElementNode
        ).getChildren();
        return children.length === 1 && children[0] instanceof TextNode
          ? children[0].getTextContent()
          : null;
      });
      const chars = before === null ? [] : Array.from(before);
      if (chars.length < 2) {
        // One character (an emoji) cannot be split by a comment
        ctx.skip();
        return;
      }
      const last = chars[chars.length - 1];
      t.a.doc.transact(() => {
        rawRoot(t.a).format(before!.length - last.length, last.length, {
          [MARK_KEY('c5')]: true,
        });
      }, 'outside');
      await t.sync();
      const parts = shape(t.b);
      expect(
        t.b.read(() =>
          ($getRoot().getFirstChildOrThrow() as ElementNode).getChildrenSize(),
        ),
      ).toBe(2);
      t.b.update(() => {
        $removeMarkID('c5');
        $setSelection(null);
      });
      await t.sync();
      // One node of the first part's type and mode, with the whole text
      const [, prefix, mode] = /^((?:[\w-]+\/)?)".*":(\w+)/.exec(parts)!;
      expect(await expectReadersAgree(t.peers)).toBe(
        `${prefix}${JSON.stringify(before)}:${mode}`,
      );
    } finally {
      for (const peer of t.peers) {
        peer.stop();
        peer.doc.destroy();
      }
    }
  });
});
