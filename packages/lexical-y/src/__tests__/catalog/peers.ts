/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Peers for the binding dimension of the configuration catalog: an editor
// built from the catalog app extension, bound with `@lexical/y` (YBinding on
// a `createYDoc`), or with `@lexical/yjs` v1 or v2 wired the way the React
// collaboration plugins (and the package's own tests) wire them, on its own
// Y.Doc. Every Yjs update a peer writes is queued as one message to each
// other peer; tests deliver messages one at a time, in any order, so they
// decide what is concurrent and can check that the network settles.

import {
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {
  $createTableCellNode,
  $isTableNode,
  $isTableRowNode,
} from '@lexical/table';
import {
  type BaseBinding,
  createBinding,
  createBindingV2__EXPERIMENTAL,
  type Provider,
  syncLexicalUpdateToYjs,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
  syncYjsChangesToLexical,
  syncYjsChangesToLexicalV2__EXPERIMENTAL,
} from '@lexical/yjs';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $getRoot,
  $isElementNode,
  COLLABORATION_TAG,
  defineExtension,
  type LexicalNode,
  type SerializedEditorState,
  SKIP_COLLAB_TAG,
} from 'lexical';
import * as Yjs from 'yjs';

import {YBinding} from '../..';
import {createYDoc} from '../../headless';
import {catalogAppExtension} from './bind';
import {DEFAULT_CONFIG} from './configs';

export type BindingKind = 'y' | 'yjs-v1' | 'yjs-v2';
export const BINDING_KINDS: readonly BindingKind[] = ['y', 'yjs-v1', 'yjs-v2'];

const REMOTE = 'catalog-remote';

function stubProvider(): Provider {
  const awareness = {
    getLocalState: () => null,
    getStates: () => new Map(),
    off: () => {},
    on: () => {},
    setLocalState: () => {},
    setLocalStateField: () => {},
  };
  return {
    awareness,
    connect: () => {},
    disconnect: () => {},
    off: () => {},
    on: () => {},
  } as unknown as Provider;
}

type AnyDoc = {
  clientID: number;
  on(event: 'update', fn: (u: Uint8Array, origin: unknown) => void): void;
};

export class CatalogPeer {
  readonly editor: LexicalEditorWithDispose;
  readonly doc: Y.Doc | Yjs.Doc;
  readonly yBinding: YBinding | null = null;
  readonly yjsBinding: BaseBinding | null = null;
  readonly warnings: string[] = [];
  readonly errors: unknown[] = [];
  /**
   * After each remote change, a local update of the app's own, as plugins
   * that react to changes make: `'empty'` (a selection restore), or
   * `'tables'` (a table plugin that marks every table dirty, so the table
   * transforms run over the received content).
   */
  followUp: 'none' | 'empty' | 'tables' = 'none';
  /**
   * After each remote change, the app repairs what it owns: `'owner-rows'`
   * pads the short table rows this peer created (a repair gated by owner, so
   * that two peers never pad the same row).
   */
  repair: 'none' | 'owner-rows' = 'none';

  private readonly cleanups: (() => void)[] = [];

  constructor(
    readonly name: string,
    readonly kind: BindingKind,
    clientID: number,
    onLocalUpdate: (peer: CatalogPeer, update: Uint8Array) => void,
  ) {
    this.editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [catalogAppExtension(DEFAULT_CONFIG)],
        name: `catalog-peer-${name}`,
        onError: (e: Error) => {
          this.errors.push(e);
        },
        onWarn: (w: Error) => void this.warnings.push(String(w)),
      }),
    );
    this.cleanups.push(() => this.editor.dispose());
    const editor = this.editor;
    if (kind === 'y') {
      const doc = createYDoc(null, {gc: false});
      doc.clientID = clientID;
      this.doc = doc;
      const binding = new YBinding(editor, doc, {
        schemaVersion: 1,
        selfCheck: true,
      });
      this.yBinding = binding;
      this.cleanups.push(binding.start());
    } else {
      const doc = new Yjs.Doc({gc: false});
      doc.clientID = clientID;
      this.doc = doc;
      const provider = stubProvider();
      const docMap = new Map([['main', doc]]);
      if (kind === 'yjs-v1') {
        const binding = createBinding(editor, provider, 'main', doc, docMap);
        this.yjsBinding = binding;
        const shared = binding.root.getSharedType();
        const onChanges = (
          events: Parameters<typeof syncYjsChangesToLexical>[2],
          transaction: {origin: unknown},
        ) => {
          if (transaction.origin !== binding) {
            syncYjsChangesToLexical(
              binding,
              provider,
              events,
              transaction.origin instanceof Yjs.UndoManager,
              () => {},
            );
          }
        };
        shared.observeDeep(onChanges as never);
        this.cleanups.push(() => shared.unobserveDeep(onChanges as never));
        this.cleanups.push(
          editor.registerUpdateListener(
            ({
              prevEditorState,
              editorState,
              dirtyLeaves,
              dirtyElements,
              normalizedNodes,
              tags,
            }) => {
              if (!tags.has(SKIP_COLLAB_TAG)) {
                syncLexicalUpdateToYjs(
                  binding,
                  provider,
                  prevEditorState,
                  editorState,
                  dirtyElements,
                  dirtyLeaves,
                  normalizedNodes,
                  tags,
                );
              }
            },
          ),
        );
      } else {
        const binding = createBindingV2__EXPERIMENTAL(
          editor,
          'main',
          doc,
          docMap,
        );
        this.yjsBinding = binding;
        const root = binding.root as Yjs.XmlElement;
        const onChanges = (
          events: Parameters<typeof syncYjsChangesToLexicalV2__EXPERIMENTAL>[2],
          transaction: Parameters<
            typeof syncYjsChangesToLexicalV2__EXPERIMENTAL
          >[3],
        ) => {
          if (transaction.origin !== binding) {
            syncYjsChangesToLexicalV2__EXPERIMENTAL(
              binding,
              provider,
              events,
              transaction,
              transaction.origin instanceof Yjs.UndoManager,
            );
          }
        };
        root.observeDeep(onChanges as never);
        this.cleanups.push(() => root.unobserveDeep(onChanges as never));
        this.cleanups.push(
          editor.registerUpdateListener(
            ({
              prevEditorState,
              editorState,
              dirtyLeaves,
              dirtyElements,
              normalizedNodes,
              tags,
            }) => {
              if (!tags.has(SKIP_COLLAB_TAG)) {
                syncLexicalUpdateToYjsV2__EXPERIMENTAL(
                  binding,
                  provider,
                  prevEditorState,
                  editorState,
                  dirtyElements,
                  dirtyLeaves,
                  normalizedNodes,
                  tags,
                );
              }
            },
          ),
        );
        // The binding initializes its node property table in a queued
        // update.
        editor.read(() => {});
      }
    }
    this.cleanups.push(
      editor.registerUpdateListener(({tags}) => {
        if (this.repair === 'owner-rows' && tags.has(COLLABORATION_TAG)) {
          this.editor.update(() => this.$padOwnRows(), {discrete: true});
        }
      }),
    );
    (this.doc as unknown as AnyDoc).on('update', (update, origin) => {
      if (origin !== REMOTE) {
        onLocalUpdate(this, update);
      }
    });
  }

  /**
   * Whether this peer created `row`: the creator of the row's shared type.
   * `@lexical/yjs` maps nodes to shared types (v2 `mapping`, v1
   * `collabNodeMap`); `@lexical/y` exposes no such mapping, so its peers own
   * no rows (the repair does nothing there).
   */
  private ownsRow(row: LexicalNode): boolean {
    const binding = this.yjsBinding as unknown as {
      mapping?: {
        getSharedType(node: LexicalNode): {_item: Yjs.Item | null} | undefined;
      };
      collabNodeMap?: Map<string, {_xmlText?: {_item: Yjs.Item | null}}>;
    } | null;
    if (binding === null) {
      return false;
    }
    const item =
      binding.mapping !== undefined
        ? binding.mapping.getSharedType(row)?._item
        : binding.collabNodeMap?.get(row.getKey())?._xmlText?._item;
    return item != null && item.id.client === (this.doc as Yjs.Doc).clientID;
  }

  private $padOwnRows(): void {
    const walk = (node: LexicalNode) => {
      if ($isTableNode(node)) {
        const rows = node.getChildren().filter($isTableRowNode);
        const width = Math.max(0, ...rows.map(r => r.getChildrenSize()));
        for (const row of rows) {
          if (this.ownsRow(row)) {
            for (let j = row.getChildrenSize(); j < width; j++) {
              row.append($createTableCellNode().append($createParagraphNode()));
            }
          }
        }
      }
      if ($isElementNode(node)) {
        node.getChildren().forEach(walk);
      }
    };
    walk($getRoot());
  }

  /** A discrete local update, then whatever it queued. */
  update(fn: () => void, tag?: string): void {
    try {
      this.editor.update(fn, {discrete: true, tag});
    } catch (error) {
      this.errors.push(error);
    }
    this.flush();
  }

  /** Commits pending updates (remote changes, follow-ups). */
  flush(): void {
    for (let i = 0; i < 20; i++) {
      const pending = this.editor._pendingEditorState !== null;
      this.editor.read(() => {});
      if (!pending && this.editor._pendingEditorState === null) {
        return;
      }
    }
  }

  apply(update: Uint8Array): void {
    try {
      if (this.kind === 'y') {
        Y.applyUpdate(this.doc as Y.Doc, update, REMOTE);
      } else {
        Yjs.applyUpdate(this.doc as Yjs.Doc, update, REMOTE);
      }
    } catch (error) {
      this.errors.push(error);
    }
    this.flush();
    if (this.followUp === 'empty') {
      this.update(() => {});
    } else if (this.followUp === 'tables') {
      this.update(() => {
        const walk = (node: LexicalNode) => {
          if ($isTableNode(node)) {
            node.markDirty();
          }
          if ($isElementNode(node)) {
            node.getChildren().forEach(walk);
          }
        };
        walk($getRoot());
      });
    }
  }

  /** Cells per row of every table, in document order. */
  tableRows(): number[][] {
    return this.editor.read(() => {
      const out: number[][] = [];
      const walk = (node: LexicalNode) => {
        if ($isTableNode(node)) {
          out.push(
            node
              .getChildren()
              .filter($isTableRowNode)
              .map(r => r.getChildrenSize()),
          );
        }
        if ($isElementNode(node)) {
          node.getChildren().forEach(walk);
        }
      };
      walk($getRoot());
      return out;
    });
  }

  json(): SerializedEditorState {
    return this.editor.getEditorState().toJSON();
  }

  dispose(): void {
    for (const c of this.cleanups.splice(0).reverse()) {
      c();
    }
  }
}

export interface Message {
  readonly from: CatalogPeer;
  readonly to: CatalogPeer;
  readonly u: Uint8Array;
}

export class CatalogNet {
  readonly peers: CatalogPeer[] = [];
  readonly queue: Message[] = [];
  delivered = 0;

  constructor(readonly kind: BindingKind) {}

  add(name: string): CatalogPeer {
    const peer = new CatalogPeer(
      name,
      this.kind,
      1000 + this.peers.length,
      (from, u) => {
        for (const to of this.peers) {
          if (to !== from) {
            this.queue.push({from, to, u});
          }
        }
      },
    );
    this.peers.push(peer);
    return peer;
  }

  /**
   * Delivers the oldest message on the channel (sender to receiver) of the
   * message at `index`: channels keep their order, as a relay's do.
   */
  deliverAt(index: number): void {
    const chosen = this.queue[index];
    if (chosen === undefined) {
      return;
    }
    const first = this.queue.findIndex(
      m => m.from === chosen.from && m.to === chosen.to,
    );
    const [m] = this.queue.splice(first, 1);
    if (m !== undefined) {
      this.delivered++;
      m.to.apply(m.u);
    }
  }

  /**
   * Delivers messages in the order `pick` chooses until the queue is empty
   * or `limit` were delivered. Returns how many it delivered and how many
   * were left.
   */
  settle(
    limit: number,
    pick: (length: number) => number = () => 0,
  ): {delivered: number; left: number; maxBytes: number} {
    let delivered = 0;
    let maxBytes = 0;
    while (this.queue.length > 0 && delivered < limit) {
      for (const m of this.queue) {
        maxBytes = Math.max(maxBytes, m.u.length);
      }
      this.deliverAt(pick(this.queue.length));
      delivered++;
    }
    return {delivered, left: this.queue.length, maxBytes};
  }

  dispose(): void {
    for (const p of this.peers) {
      p.dispose();
    }
  }
}
