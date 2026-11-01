/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Comments stored as set-valued NodeState (MarkStateExtension's `markIds`,
// an `arraySetValue` state): each id is its own text format, so concurrent
// comments on overlapping text merge.
// @vitest-environment node

import {
  $addMarkID,
  $getNodeMarkIDs,
  $removeMarkID,
  MarkStateExtension,
} from '@lexical/mark';
import * as Y from '@y/y';
import {
  $createRangeSelection,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {editYState, readYState, seedYState} from '../../headless';
import {
  $p,
  $selectIn,
  type Delivery,
  expectConverged,
  freshReader,
  type Peer,
  type Setup,
  setup as setupPeers,
} from '../utils/harness';
import {prepareMarkState as prepare} from '../utils/sizeOps';

function setup(
  init: () => void,
  options: Parameters<typeof setupPeers>[1] = {},
): Promise<Setup> {
  return setupPeers(init, {...options, prepare});
}

const P = 'Revenue grew 4% in Q3.';

function $describe(node: LexicalNode): string {
  const ids = $getNodeMarkIDs(node);
  const tag = ids.length > 0 ? `[${ids.join(',')}]` : '';
  if ($isTextNode(node)) {
    return JSON.stringify(node.getTextContent()) + tag;
  }
  if ($isElementNode(node)) {
    return `${node.getType()}(${node.getChildren().map($describe).join(' ')})`;
  }
  return node.getType() + tag;
}

function marks(peer: Peer): string {
  return peer.read(() => $getRoot().getChildren().map($describe).join(' / '));
}

async function expectMarks(peers: Peer[], expected: string) {
  await expectConverged(peers);
  for (const peer of peers) {
    expect(marks(peer)).toBe(expected);
  }
}

/** Every Yjs format key used for a mark id in the root sequence */
function storedMarkKeys(peer: Peer): string[] {
  const keys = new Set<string>();
  const children = peer.binding.root.toDelta().toJSON().children as {
    format?: Record<string, unknown>;
    attributes?: Record<string, unknown>;
  }[];
  for (const child of children) {
    for (const key of Object.keys({...child.format, ...child.attributes})) {
      if (key.includes('markIds')) {
        keys.add(key);
      }
    }
  }
  return Array.from(keys).sort();
}

const MATRIX: [number[], Delivery][] = [
  [[1, 2], 'causal'],
  [[2, 1], 'causal'],
  [[1, 2], 'sender'],
  [[2, 1], 'sender'],
];

describe.each(MATRIX)('ids %j %s', (ids, delivery) => {
  const init = (fn?: () => void) => () => {
    $getRoot().append($p(P));
    if (fn) {
      fn();
    }
  };

  test('each id is its own format key', async () => {
    const t = await setup(
      init(() => {
        $addMarkID('c1', $selectIn([0], 8, 15));
        $addMarkID('c2', $selectIn([0], 12, 19));
      }),
      {delivery, ids},
    );
    expect(storedMarkKeys(t.b)).toEqual([
      's:markIds\u001fc1',
      's:markIds\u001fc2',
    ]);
    await expectMarks(
      t.peers,
      'paragraph("Revenue " "grew"[c1] " 4%"[c1,c2] " in "[c2] "Q3.")',
    );
  });

  test('typing inside a range ‖ a peer marks it', async () => {
    const t = await setup(init(), {delivery, ids});
    t.offline();
    t.a.update(() => $selectIn([0], 13).insertText('by '));
    t.b.update(() => {
      $addMarkID('c1', $selectIn([0], 8, 15));
    });
    await t.sync();
    await expectMarks(
      t.peers,
      'paragraph("Revenue " "grew by 4%"[c1] " in Q3.")',
    );
  });

  test('two peers mark the same range', async () => {
    const t = await setup(init(), {delivery, ids});
    t.offline();
    t.a.update(() => {
      $addMarkID('c1', $selectIn([0], 8, 15));
    });
    t.b.update(() => {
      $addMarkID('c2', $selectIn([0], 8, 15));
    });
    await t.sync();
    await expectMarks(
      t.peers,
      'paragraph("Revenue " "grew 4%"[c1,c2] " in Q3.")',
    );
  });

  test('two peers mark overlapping ranges', async () => {
    const t = await setup(init(), {delivery, ids});
    t.offline();
    t.a.update(() => {
      $addMarkID('c1', $selectIn([0], 8, 15));
    });
    t.b.update(() => {
      $addMarkID('c2', $selectIn([0], 12, 19));
    });
    await t.sync();
    await expectMarks(
      t.peers,
      'paragraph("Revenue " "grew"[c1] " 4%"[c1,c2] " in "[c2] "Q3.")',
    );
  });

  test('resolving a mark ‖ a peer types inside it', async () => {
    const t = await setup(
      init(() => {
        $addMarkID('c1', $selectIn([0], 8, 15));
      }),
      {delivery, ids},
    );
    t.offline();
    t.a.update(() => $selectIn([0], 13).insertText('by '));
    t.b.update(() => $removeMarkID('c1'));
    await t.sync();
    await expectMarks(t.peers, 'paragraph("Revenue grew by 4% in Q3.")');
  });

  test('resolving one of two marks ‖ a peer types in the overlap', async () => {
    const t = await setup(
      init(() => {
        $addMarkID('c1', $selectIn([0], 8, 15));
        $addMarkID('c2', $selectIn([0], 12, 19));
      }),
      {delivery, ids},
    );
    t.offline();
    t.a.update(() => $selectIn([0], 13).insertText('by '));
    t.b.update(() => {
      $addMarkID('c3', $selectIn([0], 8, 12));
      $removeMarkID('c2');
    });
    await t.sync();
    await expectMarks(
      t.peers,
      'paragraph("Revenue " "grew"[c1,c3] " by 4%"[c1] " in Q3.")',
    );
  });

  test('undoing a mark ‖ a peer types inside it', async () => {
    const t = await setup(init(), {delivery, ids});
    t.a.update(() => {
      $addMarkID('c1', $selectIn([0], 8, 15));
    });
    await t.sync();
    t.offline();
    t.b.update(() => $selectIn([0], 13).insertText('by '));
    t.a.undo();
    await t.sync();
    await expectMarks(t.peers, 'paragraph("Revenue grew by 4% in Q3.")');
  });
});

describe('a peer that does not know the state', () => {
  test('keeps each id as its own format when it edits marked text', async () => {
    // Only the first editor (peer a) knows `markIds`; peer b and the fresh
    // reader keep the per-id formats as ordinary NodeState keys.
    let editors = 0;
    const t = await setupPeers(
      () => {
        $getRoot().append($p(P));
        $addMarkID('c1', $selectIn([0], 8, 15));
        $addMarkID('c2', $selectIn([0], 12, 19));
      },
      {
        prepare: editor => {
          if (editors++ === 0) {
            prepare(editor);
          }
        },
      },
    );
    t.offline();
    t.b.update(() => $selectIn([0], 13).insertText('by '));
    t.a.update(() => {
      $addMarkID('c3', $selectIn([0], 8, 12));
    });
    await t.sync();
    for (const peer of t.peers) {
      expect(peer.errors).toEqual([]);
      expect(storedMarkKeys(peer)).toEqual([
        's:markIds\u001fc1',
        's:markIds\u001fc2',
        's:markIds\u001fc3',
      ]);
    }
    expect(marks(t.a)).toBe(
      'paragraph("Revenue " "grew"[c1,c3] " by 4%"[c1,c2] " in "[c2] "Q3.")',
    );
    expect(t.b.read(() => $getRoot().getTextContent())).toBe(
      'Revenue grew by 4% in Q3.',
    );
  });
});

describe('three peers', () => {
  test.each([[[1, 2, 3]], [[2, 3, 1]], [[3, 2, 1]]])(
    'remove ‖ type in the overlap ‖ type elsewhere %j',
    async ids => {
      const t = await setup(
        () => {
          $getRoot().append($p('Revenue grew by 4% in Q3.'));
          $addMarkID('c1', $selectIn([0], 8, 18));
          $addMarkID('c2', $selectIn([0], 12, 22));
        },
        {ids},
      );
      t.offline();
      t.a.update(() => $removeMarkID('c1'));
      t.b.update(() => $selectIn([0], 14).insertText('XX'));
      t.c.update(() => $selectIn([0], 0).insertText('Z'));
      await t.sync();
      await expectMarks(
        t.peers,
        'paragraph("ZRevenue grew" " bXXy 4% in "[c2] "Q3.")',
      );
    },
  );
});

describe('line breaks', () => {
  test('two peers mark overlapping ranges across a line break', async () => {
    const t = await setup(() => {
      $getRoot().append($p('abcd'));
      $selectIn([0], 2).insertLineBreak();
    });
    t.offline();
    // "ab" "\n" "cd": select from offset 1 of "ab" to offset 1 of "cd"
    t.a.update(() => {
      const [ab, , cd] = $assertNodeType(
        $getRoot().getFirstChildOrThrow(),
        $isElementNode,
      ).getChildren();
      const selection = $createRangeSelection();
      selection.anchor.set(ab.getKey(), 1, 'text');
      selection.focus.set(cd.getKey(), 1, 'text');
      $addMarkID('c1', selection);
    });
    t.b.update(() => {
      const [ab, , cd] = $assertNodeType(
        $getRoot().getFirstChildOrThrow(),
        $isElementNode,
      ).getChildren();
      const selection = $createRangeSelection();
      selection.anchor.set(ab.getKey(), 0, 'text');
      selection.focus.set(cd.getKey(), 2, 'text');
      $addMarkID('c2', selection);
    });
    await t.sync();
    await expectMarks(
      t.peers,
      'paragraph("a"[c2] "b"[c1,c2] linebreak[c1,c2] "c"[c1,c2] "d"[c2])',
    );
  });
});

describe('mark ids on the wire', () => {
  // Yjs stores format names as UTF-8, which turns a lone surrogate into
  // U+FFFD: '\ud800' and '\ud801' would both read back as '\ufffd'.
  const IDS = [
    '\ud800',
    '\ud801',
    '\udc00',
    'x\udbff',
    '\ud83d\ude00',
    'a',
    '"a"',
    '\u001f',
    '\u001fa',
    '\u001f"a"',
  ];
  const isWellFormed = (s: string) =>
    !/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/.test(
      s,
    );

  test('ids that are not well-formed UTF-16 keep every code unit on every peer and a fresh reader', async () => {
    const t = await setup(() => $getRoot().append($p('probe')));
    t.a.update(() => {
      for (const id of IDS) {
        $addMarkID(id, $selectIn([0], 0, 5));
      }
      $setSelection(null);
    });
    await t.sync();
    await expectConverged(t.peers);
    const expected = JSON.stringify([...IDS].sort());
    const read = (peer: Peer) =>
      JSON.stringify(
        peer.read(() => $getNodeMarkIDs($getRoot().getFirstDescendant()!)),
      );
    for (const peer of t.peers) {
      expect(read(peer)).toBe(expected);
      expect(peer.warnings).toEqual([]);
      // Every stored name is well-formed: what UTF-8 keeps.
      for (const key of storedMarkKeys(peer)) {
        expect(isWellFormed(key)).toBe(true);
      }
    }
    expect(read(await freshReader(t.a))).toBe(expected);
    // A peer that removes one of them removes only that one.
    t.b.update(() => $removeMarkID('\ud800'));
    await t.sync();
    await expectConverged(t.peers);
    const rest = JSON.stringify(IDS.filter(id => id !== '\ud800').sort());
    for (const peer of t.peers) {
      expect(read(peer)).toBe(rest);
    }
    expect(read(await freshReader(t.b))).toBe(rest);
  });
});

describe('a JSON copy of a commented text node', () => {
  // A server agent that does not know the comments state (nodes only) loads a
  // node's JSON back into it, as a generic JSON round trip does.
  const FULL = {
    extensions: [MarkStateExtension],
    schemaVersion: 1,
    selfCheck: true,
  };
  const BARE = {nodes: [], schemaVersion: 1, selfCheck: true};
  const $text = (): TextNode => {
    const node = $getRoot().getFirstDescendant();
    if (!$isTextNode(node)) {
      throw new Error('expected text');
    }
    return node;
  };
  const seed = (config: typeof FULL | typeof BARE) =>
    seedYState(config, () => {
      $getRoot().append($p('probe'));
      $addMarkID('A', $selectIn([0], 0, 5));
      $setSelection(null);
    });
  const ids = (bytes: Uint8Array) =>
    readYState(bytes, FULL, () => [...$getNodeMarkIDs($text())]);
  const $copy = (change?: (json: {$?: Record<string, unknown>}) => void) => {
    const node = $text();
    const json = JSON.parse(JSON.stringify(node.exportJSON()));
    if (change) {
      change(json);
    }
    node.updateFromJSON(json);
    $setSelection(null);
  };
  const merge = (state: Uint8Array, ...updates: (Uint8Array | null)[]) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    for (const update of updates) {
      if (update !== null) {
        Y.applyUpdate(doc, update);
      }
    }
    return Y.encodeStateAsUpdate(doc);
  };

  test.each([
    ['full', FULL, FULL],
    ['nodes only', FULL, BARE],
    ['nodes only, seeded nodes only', BARE, BARE],
  ])(
    'an unchanged copy writes nothing (%s)',
    (_name, seedConfig, agentConfig) => {
      const agent = editYState(seed(seedConfig), agentConfig, () => $copy(), {
        writer: null,
      });
      expect(agent.update).toBeNull();
      expect(agent.warnings).toEqual([]);
    },
  );

  test.each([
    ['nodes only', FULL, BARE],
    ['nodes only everywhere', BARE, BARE],
    ['full', FULL, FULL],
  ])(
    'a copy does not bring back a comment a human resolved at the same time (%s)',
    (_name, seedConfig, agentConfig) => {
      const state = seed(seedConfig);
      // The human resolves A and adds B.
      const human = editYState(
        state,
        seedConfig,
        () => {
          $removeMarkID('A');
          $addMarkID('B', $selectIn([0], 0, 5));
          $setSelection(null);
        },
        {writer: null},
      );
      expect(ids(human.state)).toEqual(['B']);
      // At the same time the agent copies the node, and with a text edit.
      for (const edit of [false, true]) {
        const agent = editYState(
          state,
          agentConfig,
          () => {
            $copy();
            if (edit) {
              $text().spliceText(2, 0, '!');
            }
          },
          {writer: null},
        );
        expect(agent.warnings).toEqual([]);
        expect(ids(merge(state, human.update, agent.update))).toEqual(['B']);
        expect(ids(merge(state, agent.update, human.update))).toEqual(['B']);
      }
    },
  );

  test('a changed copy writes only the members it adds or removes', () => {
    const state = seed(FULL);
    // The human resolves A.
    const human = editYState(
      state,
      FULL,
      () => {
        $removeMarkID('A');
        $setSelection(null);
      },
      {writer: null},
    );
    // The agent adds C in the JSON, which still holds A.
    const agent = editYState(
      state,
      BARE,
      () =>
        $copy(json => {
          json.$ = {...json.$, markIds: ['A', 'C']};
        }),
      {writer: null},
    );
    expect(agent.warnings).toEqual([]);
    expect(ids(merge(state, human.update, agent.update))).toEqual(['C']);
    expect(ids(merge(state, agent.update, human.update))).toEqual(['C']);
  });
});
