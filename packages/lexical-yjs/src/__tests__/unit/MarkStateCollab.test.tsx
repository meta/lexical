/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Provider, UserState} from '@lexical/yjs';

import {getExtensionDependencyFromEditor} from '@lexical/extension';
import {
  $addMarkID,
  $getNodeMarkIDs,
  $removeMarkID,
  MarkStateExtension,
} from '@lexical/mark';
import {LexicalCollaboration} from '@lexical/react/LexicalCollaborationContext';
import {
  CollaborationPlugin,
  CollaborationPluginV2__EXPERIMENTAL,
} from '@lexical/react/LexicalCollaborationPlugin';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, test} from 'vitest';
import * as Y from 'yjs';

type Version = 'v1' | 'v2';

/**
 * Editors with the official v1 or v2 collaboration plugin, connected by an
 * in-memory network that keeps each sender's updates in order (as a relay
 * server does). Edits are made while offline and then synced, so they are
 * concurrent.
 */
class Network {
  clients: Client[] = [];

  /** Deliver every pending update, in per-sender order, until quiescent */
  flush() {
    let progress = true;
    while (progress) {
      progress = false;
      for (const receiver of this.clients) {
        for (const sender of this.clients) {
          if (sender === receiver || !sender.online || !receiver.online) {
            continue;
          }
          let index = receiver.received.get(sender) || 0;
          while (index < sender.log.length) {
            Y.applyUpdate(receiver.doc, sender.log[index++], this);
            receiver.received.set(sender, index);
            progress = true;
          }
        }
      }
    }
  }
}

class Client implements Provider {
  doc: Y.Doc;
  /** This client's own updates, in order */
  log: Uint8Array[] = [];
  received = new Map<Client, number>();
  online = false;
  editor: LexicalEditor | null = null;
  root: Root | null = null;
  container: HTMLDivElement | null = null;
  listeners = new Map<string, Set<(data: unknown) => void>>();
  awarenessState: UserState | null = null;
  awareness = {
    getLocalState: () => this.awarenessState,
    getStates: () => new Map([[this.doc.clientID, this.awarenessState!]]),
    off() {},
    on() {},
    setLocalState: (state: UserState | null) => {
      this.awarenessState = state;
    },
    setLocalStateField() {},
  };

  constructor(
    readonly network: Network,
    clientID: number,
    readonly version: Version = 'v2',
    readonly withMarkState = true,
  ) {
    this.doc = new Y.Doc({gc: false});
    this.doc.clientID = clientID;
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== this.network) {
        this.log.push(update);
      }
    });
  }

  connect() {
    this.online = true;
    this.network.flush();
    this.dispatch('sync', true);
  }

  disconnect() {
    this.online = false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(type: string, callback: (data: any) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(callback);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(type: string, callback: (data: any) => void) {
    const set = this.listeners.get(type);
    if (set) {
      set.delete(callback);
    }
  }

  dispatch(type: string, data: unknown) {
    const set = this.listeners.get(type);
    if (set) {
      set.forEach(callback => callback(data));
    }
  }

  start(parent: HTMLElement) {
    const extension = defineExtension({
      $initialEditorState: null,
      dependencies: this.withMarkState
        ? [RichTextExtension, MarkStateExtension]
        : [RichTextExtension],
      name: '[root]',
      onError: (error: Error) => {
        throw error;
      },
    });
    const container = document.createElement('div');
    parent.appendChild(container);
    this.container = container;
    this.root = createRoot(container);
    const setEditor = (editor: LexicalEditor) => {
      this.editor = editor;
    };
    act(() => {
      this.root!.render(
        <LexicalCollaboration>
          <LexicalExtensionComposer extension={extension}>
            <EditorRef setEditor={setEditor} />
            {this.version === 'v2' ? (
              <CollaborationPluginV2__EXPERIMENTAL
                id="main"
                doc={this.doc}
                provider={this}
                __shouldBootstrapUnsafe={false}
              />
            ) : (
              <CollaborationPlugin
                id="main"
                providerFactory={this.providerFactory}
                shouldBootstrap={false}
              />
            )}
          </LexicalExtensionComposer>
        </LexicalCollaboration>,
      );
    });
  }

  providerFactory = (id: string, yjsDocMap: Map<string, Y.Doc>): Provider => {
    yjsDocMap.set(id, this.doc);
    return this;
  };

  stop() {
    act(() => {
      this.root!.render(null);
    });
    this.container!.remove();
  }

  getEditor(): LexicalEditor {
    return this.editor!;
  }

  async update(fn: () => void) {
    await act(async () => {
      this.getEditor().update(fn, {discrete: true});
    });
  }

  /** Start a new undo step */
  stopCapturing() {
    const undoManager = (
      this.getEditor() as unknown as Record<symbol, Y.UndoManager | undefined>
    )[Symbol.for('@lexical/yjs/UndoManager')];
    if (undoManager) {
      undoManager.stopCapturing();
    }
  }
}

function EditorRef({setEditor}: {setEditor: (editor: LexicalEditor) => void}) {
  const [editor] = useLexicalComposerContext();
  setEditor(editor);
  return null;
}

const P = 'Revenue grew 4% in Q3.';

function $describeNode(node: LexicalNode): string {
  const ids = $getNodeMarkIDs(node);
  const tag = ids.length > 0 ? `[${ids.join(',')}]` : '';
  if ($isTextNode(node)) {
    return JSON.stringify(node.getTextContent()) + tag;
  }
  if ($isElementNode(node)) {
    return `${node.getType()}(${node
      .getChildren()
      .map($describeNode)
      .join(' ')})`;
  }
  return node.getType() + tag;
}

function tree(client: Client): string {
  return client
    .getEditor()
    .read(() => $getRoot().getChildren().map($describeNode).join(' / '));
}

function registry(client: Client): Record<string, string[]> {
  if (!client.withMarkState) {
    return client.getEditor().read(() => {
      const result: Record<string, string[]> = {};
      for (const node of $paragraph().getChildren()) {
        for (const id of $getNodeMarkIDs(node)) {
          (result[id] = result[id] || []).push(node.getTextContent());
        }
      }
      for (const id in result) {
        result[id].sort();
      }
      return result;
    });
  }
  const editor = client.getEditor();
  const {markIDNodeKeys} = getExtensionDependencyFromEditor(
    editor,
    MarkStateExtension,
  ).output;
  return editor.read(() => {
    const result: Record<string, string[]> = {};
    for (const [id, keys] of markIDNodeKeys.value) {
      result[id] = keys
        .map(key => $getNodeByKey(key))
        .map(node => (node ? node.getTextContent() : '<missing>'))
        .sort();
    }
    return result;
  });
}

function $paragraph(): ElementNode {
  return $assertNodeType($getRoot().getFirstChildOrThrow(), $isElementNode);
}

function $locate(offset: number, preferNext: boolean): [TextNode, number] {
  let acc = 0;
  const texts = $paragraph().getAllTextNodes();
  for (let i = 0; i < texts.length; i++) {
    const size = texts[i].getTextContentSize();
    if (
      offset < acc + size ||
      (offset === acc + size && (!preferNext || i === texts.length - 1))
    ) {
      return [texts[i], offset - acc];
    }
    acc += size;
  }
  throw new Error(`offset ${offset} out of range`);
}

function $select(start: number, end = start) {
  const [startNode, startOffset] = $locate(start, start !== end);
  const [endNode, endOffset] = $locate(end, false);
  const selection = $createRangeSelection();
  selection.anchor.set(startNode.getKey(), startOffset, 'text');
  selection.focus.set(endNode.getKey(), endOffset, 'text');
  $setSelection(selection);
  return selection;
}

function $typeAt(offset: number, text: string) {
  $select(offset).insertText(text);
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
});

/**
 * Both client id orders, since Yjs breaks ties between concurrent inserts by
 * client id.
 */
const CLIENT_ID_ORDERS = [
  [1, 2],
  [2, 1],
] as const;

async function setupPeers(
  ids: readonly number[],
  $init: () => void = () => {},
  version: Version = 'v2',
  withMarkState: readonly boolean[] = [],
) {
  const network = new Network();
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const clients = ids.map(
    (id, i) => new Client(network, id, version, withMarkState[i] !== false),
  );
  network.clients.push(...clients);
  for (const client of clients) {
    client.start(parent);
  }
  const [first] = clients;
  await first.update(() => {
    $getRoot()
      .clear()
      .append($createParagraphNode().append($createTextNode(P)));
  });
  await first.update($init);
  await act(async () => network.flush());
  for (const client of clients) {
    client.stopCapturing();
  }
  cleanup = () => {
    for (const client of clients) {
      client.stop();
    }
    parent.remove();
  };
  return {
    clients,
    async offline() {
      for (const client of clients) {
        client.online = false;
      }
    },
    async sync() {
      await act(async () => {
        for (const client of clients) {
          client.online = true;
        }
        network.flush();
      });
    },
  };
}

async function setup(
  ids: readonly [number, number],
  $init: () => void = () => {},
  version: Version = 'v2',
) {
  const peers = await setupPeers(ids, $init, version);
  const [a, b] = peers.clients;
  return {...peers, a, b};
}

function expectAll(
  clients: readonly Client[],
  expected: string,
  expectedRegistry: Record<string, string[]>,
) {
  for (const client of clients) {
    expect(tree(client)).toBe(expected);
    expect(registry(client)).toEqual(expectedRegistry);
  }
}

/**
 * Both peers converge on one of `outcomes`: concurrent changes to the ids of
 * the same text, where `@lexical/yjs` keeps one peer's set.
 */
function expectEitherBoth(
  ctx: {a: Client; b: Client},
  outcomes: readonly [string, Record<string, string[]>][],
) {
  const outcome = outcomes.find(([expected]) => expected === tree(ctx.a));
  expect(outcome && outcome[0]).toBe(tree(ctx.a));
  if (outcome) {
    expectBoth(ctx, outcome[0], outcome[1]);
  }
}

function expectBoth(
  {a, b}: {a: Client; b: Client},
  expected: string,
  expectedRegistry: Record<string, string[]>,
) {
  expect(tree(a)).toBe(expected);
  expect(tree(b)).toBe(expected);
  expect(registry(a)).toEqual(expectedRegistry);
  expect(registry(b)).toEqual(expectedRegistry);
  expect(a.doc.toJSON()).toEqual(b.doc.toJSON());
}

describe('MarkStateExtension with collaboration v2', () => {
  for (const order of CLIENT_ID_ORDERS) {
    describe(`client ids ${order.join(',')}`, () => {
      test('W1: typing inside a range ‖ a peer marks it', async () => {
        const ctx = await setup(order);
        await ctx.offline();
        await ctx.a.update(() => $typeAt(13, 'by '));
        await ctx.b.update(() => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue " "grew by 4%"[c1] " in Q3.")', {
          c1: ['grew by 4%'],
        });
      });

      test('W3: two peers mark the same range', async () => {
        const ctx = await setup(order);
        await ctx.offline();
        await ctx.a.update(() => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.b.update(() => {
          $addMarkID('c2', $select(8, 15));
        });
        await ctx.sync();
        // The text is neither moved nor duplicated. @lexical/yjs stores the
        // set as one value, so one peer's set wins and both converge on it.
        expectEitherBoth(ctx, [
          ['paragraph("Revenue " "grew 4%"[c1] " in Q3.")', {c1: ['grew 4%']}],
          ['paragraph("Revenue " "grew 4%"[c2] " in Q3.")', {c2: ['grew 4%']}],
        ]);
      });

      test('typing inside an overlap ‖ a peer adds the second mark', async () => {
        const ctx = await setup(order, () => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.offline();
        await ctx.a.update(() => $typeAt(13, 'by '));
        await ctx.b.update(() => {
          $addMarkID('c2', $select(12, 19));
        });
        await ctx.sync();
        expectBoth(
          ctx,
          'paragraph("Revenue " "grew"[c1] " by 4%"[c1,c2] " in "[c2] "Q3.")',
          {c1: [' by 4%', 'grew'], c2: [' by 4%', ' in ']},
        );
      });

      test('W4: undoing a mark after a peer typed inside it', async () => {
        const ctx = await setup(order);
        await ctx.a.update(() => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.sync();
        ctx.a.stopCapturing();
        await ctx.b.update(() => $typeAt(13, 'by '));
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue " "grew by 4%"[c1] " in Q3.")', {
          c1: ['grew by 4%'],
        });
        await act(async () => {
          ctx.a.getEditor().dispatchCommand(UNDO_COMMAND, undefined);
        });
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue grew by 4% in Q3.")', {});
      });

      test('W4: undoing a mark ‖ a peer types inside it', async () => {
        const ctx = await setup(order);
        await ctx.a.update(() => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.sync();
        ctx.a.stopCapturing();
        await ctx.offline();
        await ctx.b.update(() => $typeAt(13, 'by '));
        await act(async () => {
          ctx.a.getEditor().dispatchCommand(UNDO_COMMAND, undefined);
        });
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue grew by 4% in Q3.")', {});
      });

      test('R1: removing a mark ‖ a peer types inside it', async () => {
        const ctx = await setup(order, () => {
          $addMarkID('c0', $select(8, 15));
        });
        await ctx.offline();
        await ctx.a.update(() => $typeAt(13, 'by '));
        await ctx.b.update(() => $removeMarkID('c0'));
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue grew by 4% in Q3.")', {});
      });

      test('removing one of two marks ‖ a peer types in the overlap', async () => {
        const ctx = await setup(order, () => {
          $addMarkID('c1', $select(8, 15));
          $addMarkID('c2', $select(12, 19));
        });
        await ctx.offline();
        await ctx.a.update(() => $typeAt(13, 'by '));
        await ctx.b.update(() => $removeMarkID('c1'));
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue grew" " by 4% in "[c2] "Q3.")', {
          c2: [' by 4% in '],
        });
      });

      test('text typed at the edge of a mark stays out of it', async () => {
        const ctx = await setup(order, () => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.b.update(() => {
          $select(15);
        });
        await ctx.b.update(() => $select(15).insertText('!'));
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue " "grew 4%"[c1] "! in Q3.")', {
          c1: ['grew 4%'],
        });
      });
    });
  }
});

/**
 * The v1 binding stores the NodeState of a node in a Y.Map, the ids as one
 * entry, so of two concurrent changes to the ids of the same TextNode one
 * wins. It syncs a TextNode split as a delete and a re-insert of the text, so
 * concurrent edits that each split the same TextNode still move or duplicate
 * text (see the known limitations below).
 */
describe('MarkStateExtension with collaboration v1', () => {
  // "grew 4%" is its own TextNode, so marking exactly that text splits
  // nothing, and it keeps c9 when another id is removed, so it is not merged
  // with its neighbors either.
  const $initRun = () => {
    $addMarkID('c0', $select(8, 15));
    $addMarkID('c9', $select(8, 15));
  };
  for (const order of CLIENT_ID_ORDERS) {
    describe(`client ids ${order.join(',')}`, () => {
      test('two peers mark the same TextNode: one set wins', async () => {
        const ctx = await setup(order, $initRun, 'v1');
        await ctx.offline();
        await ctx.a.update(() => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.b.update(() => {
          $addMarkID('c2', $select(8, 15));
        });
        await ctx.sync();
        expectEitherBoth(ctx, [
          [
            'paragraph("Revenue " "grew 4%"[c0,c1,c9] " in Q3.")',
            {c0: ['grew 4%'], c1: ['grew 4%'], c9: ['grew 4%']},
          ],
          [
            'paragraph("Revenue " "grew 4%"[c0,c2,c9] " in Q3.")',
            {c0: ['grew 4%'], c2: ['grew 4%'], c9: ['grew 4%']},
          ],
        ]);
      });

      test('resolving a mark ‖ a peer types inside it', async () => {
        const ctx = await setup(order, $initRun, 'v1');
        await ctx.offline();
        await ctx.a.update(() => $typeAt(13, 'by '));
        await ctx.b.update(() => $removeMarkID('c0'));
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue " "grew by 4%"[c9] " in Q3.")', {
          c9: ['grew by 4%'],
        });
      });

      test('undoing a mark after a peer typed inside it', async () => {
        const ctx = await setup(order, $initRun, 'v1');
        await ctx.a.update(() => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.sync();
        ctx.a.stopCapturing();
        await ctx.b.update(() => $typeAt(13, 'by '));
        await ctx.sync();
        expectBoth(
          ctx,
          'paragraph("Revenue " "grew by 4%"[c0,c1,c9] " in Q3.")',
          {c0: ['grew by 4%'], c1: ['grew by 4%'], c9: ['grew by 4%']},
        );
        await act(async () => {
          ctx.a.getEditor().dispatchCommand(UNDO_COMMAND, undefined);
        });
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue " "grew by 4%"[c0,c9] " in Q3.")', {
          c0: ['grew by 4%'],
          c9: ['grew by 4%'],
        });
      });
    });
  }
});

/**
 * `@lexical/yjs` stores the ids of a leaf as one value, so concurrent changes
 * to the ids of the same text keep one peer's set: the write Yjs orders last
 * (for concurrent writes, the one from the higher client id). A removed id
 * can come back, and an added one can be dropped. This is the behavior
 * documented in the Comments and Annotations page.
 */
describe('MarkStateExtension with collaboration: concurrent changes to the same ids', () => {
  for (const version of ['v2', 'v1'] as const) {
    for (const order of CLIENT_ID_ORDERS) {
      test(`${version}: removing c1 ‖ a peer adds c2 to the same text (client ids ${order.join(',')})`, async () => {
        const ctx = await setup(
          order,
          () => {
            $addMarkID('c1', $select(8, 15));
            $addMarkID('c9', $select(8, 15));
          },
          version,
        );
        await ctx.offline();
        await ctx.a.update(() => $removeMarkID('c1'));
        await ctx.b.update(() => {
          $addMarkID('c2', $select(8, 15));
        });
        await ctx.sync();
        if (order[1] > order[0]) {
          // b's set wins: the resolved c1 comes back
          expectBoth(
            ctx,
            'paragraph("Revenue " "grew 4%"[c1,c2,c9] " in Q3.")',
            {
              c1: ['grew 4%'],
              c2: ['grew 4%'],
              c9: ['grew 4%'],
            },
          );
        } else {
          // a's set wins: c2 is dropped
          expectBoth(ctx, 'paragraph("Revenue " "grew 4%"[c9] " in Q3.")', {
            c9: ['grew 4%'],
          });
        }
      });
    }
  }
});

/**
 * Known limitations, pinned so that a change in behavior shows up here. All
 * peers converge in these cases, but a mark can spread onto text nobody
 * marked, or be dropped. The two-peer versions of the races above are
 * correct.
 */
describe('MarkStateExtension with collaboration: known limitations', () => {
  // v1: removing the last id of a TextNode lets normalization merge it with
  // its neighbors, which v1 syncs as a delete and a re-insert of the text, so
  // a peer's concurrent keystroke inside it is moved (to the end of the
  // paragraph here). The same happens to any concurrent TextNode split or
  // merge in v1, with or without marks.
  for (const order of CLIENT_ID_ORDERS) {
    test.fails(
      `v1: resolving the only mark of a TextNode ‖ a peer types inside it (client ids ${order.join(',')})`,
      async () => {
        const ctx = await setup(
          order,
          () => {
            $addMarkID('c0', $select(8, 15));
          },
          'v1',
        );
        await ctx.offline();
        await ctx.a.update(() => $typeAt(13, 'by '));
        await ctx.b.update(() => $removeMarkID('c0'));
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue grew by 4% in Q3.")', {});
      },
    );
  }

  // Mark across two paragraphs ‖ Backspace at the start of the second. One
  // order drops c1 from "Second", the other spreads it onto " line.". This
  // stays order dependent: v2 syncs the join as a delete and a re-insert of
  // the second paragraph's text, and where the marked part lands relative to
  // the Yjs format boundaries depends on the order of the concurrent edits.
  for (const order of CLIENT_ID_ORDERS) {
    test.fails(
      `mark across two paragraphs ‖ merge them (client ids ${order.join(',')})`,
      async () => {
        const ctx = await setup(order, () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Second line.')),
          );
        });
        await ctx.offline();
        await ctx.a.update(() => {
          const first = $paragraph().getFirstChildOrThrow();
          const second = $assertNodeType(
            $getRoot().getLastChildOrThrow(),
            $isElementNode,
          ).getFirstChildOrThrow();
          const selection = $createRangeSelection();
          selection.anchor.set(first.getKey(), 16, 'text');
          selection.focus.set(second.getKey(), 6, 'text');
          $addMarkID('c1', selection);
        });
        await ctx.b.update(() => {
          $assertNodeType(
            $assertNodeType(
              $getRoot().getLastChildOrThrow(),
              $isElementNode,
            ).getFirstChildOrThrow(),
            $isTextNode,
          )
            .select(0, 0)
            .deleteCharacter(true);
        });
        await ctx.sync();
        expectAll(
          ctx.clients,
          'paragraph("Revenue grew 4% " "in Q3.Second"[c1] " line.")',
          {c1: ['in Q3.Second']},
        );
      },
    );
  }
});
