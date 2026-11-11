/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A headless collaboration harness for BlockIdExtension tests: each peer is
// an extension-built editor with a v1 or v2 @lexical/yjs binding wired the
// way the React collaboration plugins wire it, on its own Y.Doc. Peers
// exchange state-vector diffs only when `sync()` is called, and only while
// both are online, so tests decide exactly which edits are concurrent.

import {
  $getBlockId,
  BlockIdExtension,
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {ListExtension} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  type BaseBinding,
  createBinding,
  createBindingV2__EXPERIMENTAL,
  createUndoManager,
  type Provider,
  syncLexicalUpdateToYjs,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
  syncYjsChangesToLexical,
  syncYjsChangesToLexicalV2__EXPERIMENTAL,
} from '@lexical/yjs';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isRootNode,
  $parseSerializedNode,
  COLLABORATION_TAG,
  configExtension,
  DELETE_CHARACTER_COMMAND,
  type ElementNode,
  HISTORY_MERGE_TAG,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type SerializedEditorState,
  type SerializedElementNode,
  type SerializedLexicalNode,
  SKIP_COLLAB_TAG,
} from 'lexical';
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  UndoManager,
  type XmlElement,
  type XmlText,
} from 'yjs';

export type CollabVersion = 1 | 2;

const REMOTE = 'remote';

function createStubProvider(): Provider {
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

export interface PeerOptions {
  $isIdentifiedBlock?: (node: LexicalNode) => boolean;
  /** Build the editor without BlockIdExtension (an older client). */
  withoutBlockIds?: boolean;
  /**
   * Leave the editor as built, so that the first content it gets (seeded or
   * received) is a load and gets positional ids. By default the editor has
   * had content once (before the binding exists), so the blocks a test seeds
   * are edits and get ids from `generateId`.
   */
  fresh?: boolean;
}

/** Tags the updates a test makes through {@link Peer.update}. */
const PEER_UPDATE_TAG = 'test-peer-update';

export class Peer {
  readonly name: string;
  readonly doc: Doc;
  readonly editor: LexicalEditorWithDispose;
  readonly binding: BaseBinding;
  readonly undoManager: UndoManager;
  online = true;
  /**
   * Lexical commits this peer made on its own: neither its explicit updates
   * ({@link Peer.update}) nor remote changes. BlockIdExtension's repairs.
   */
  repairs = 0;
  /** Yjs updates this peer produced locally. */
  localYjsUpdates = 0;
  private readonly cleanup: () => void;

  constructor(name: string, version: CollabVersion, options: PeerOptions = {}) {
    this.name = name;
    this.doc = new Doc({gc: false});
    // Deterministic client ids, so concurrent edits merge the same way on
    // every run.
    this.doc.clientID = 1000 + name.charCodeAt(0);
    let counter = 0;
    this.editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        ListExtension,
        ...(options.withoutBlockIds
          ? []
          : [
              configExtension(BlockIdExtension, {
                // Peer-unique deterministic ids: `a1`, `a2`, … on peer `a`.
                generateId: () => `${name}${++counter}`,
                ...(options.$isIdentifiedBlock
                  ? {$isIdentifiedBlock: options.$isIdentifiedBlock}
                  : {}),
              }),
            ]),
      ],
      name: `[collab-${name}]`,
    });
    if (!options.fresh) {
      const updateOptions = {discrete: true, tag: HISTORY_MERGE_TAG} as const;
      this.editor.update(() => {
        $getRoot().append($createParagraphNode());
      }, updateOptions);
      this.editor.update(() => {
        $getRoot().clear();
      }, updateOptions);
    }
    const provider = createStubProvider();
    const docMap = new Map([['main', this.doc]]);
    const editor = this.editor;
    const removeRepairCounter = editor.registerUpdateListener(({tags}) => {
      if (!tags.has(PEER_UPDATE_TAG) && !tags.has(COLLABORATION_TAG)) {
        this.repairs++;
      }
    });
    this.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) {
        this.localYjsUpdates++;
      }
    });
    if (version === 1) {
      const binding = createBinding(editor, provider, 'main', this.doc, docMap);
      this.binding = binding;
      const sharedRoot = binding.root.getSharedType();
      const onChanges = (
        events: Parameters<typeof syncYjsChangesToLexical>[2],
        transaction: {origin: unknown},
      ) => {
        if (transaction.origin !== binding) {
          syncYjsChangesToLexical(
            binding,
            provider,
            events,
            transaction.origin instanceof UndoManager,
            () => {},
          );
        }
      };
      sharedRoot.observeDeep(onChanges as never);
      const removeListener = editor.registerUpdateListener(
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
      );
      this.undoManager = createUndoManager(binding, sharedRoot as XmlText);
      this.cleanup = () => {
        sharedRoot.unobserveDeep(onChanges as never);
        removeListener();
      };
    } else {
      const binding = createBindingV2__EXPERIMENTAL(
        editor,
        'main',
        this.doc,
        docMap,
      );
      this.binding = binding;
      const root = binding.root as XmlElement;
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
            transaction.origin instanceof UndoManager,
          );
        }
      };
      root.observeDeep(onChanges as never);
      const removeListener = editor.registerUpdateListener(
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
      );
      this.undoManager = createUndoManager(binding, root);
      this.cleanup = () => {
        root.unobserveDeep(onChanges as never);
        removeListener();
      };
    }
    // Every change is its own undo step.
    this.undoManager.captureTimeout = 0;
    const cleanup = this.cleanup;
    this.cleanup = () => {
      cleanup();
      removeRepairCounter();
    };
  }

  /** Run a discrete local update. */
  update(fn: () => void, tag?: string): void {
    this.editor.update(fn, {
      discrete: true,
      tag: tag === undefined ? PEER_UPDATE_TAG : [tag, PEER_UPDATE_TAG],
    });
    this.flush();
  }

  /** Commit pending updates (remote changes, scheduled repairs). */
  flush(): void {
    for (let i = 0; i < 20; i++) {
      const pending = this.editor._pendingEditorState !== null;
      this.editor.read(() => {});
      if (!pending && this.editor._pendingEditorState === null) {
        return;
      }
    }
  }

  undo(): void {
    this.undoManager.undo();
    this.flush();
  }

  redo(): void {
    this.undoManager.redo();
    this.flush();
  }

  json(): SerializedEditorState {
    return this.editor.getEditorState().toJSON();
  }

  /** `type:text:id` for each identified block, in document order. */
  blocks(
    isIdentified: (node: LexicalNode) => boolean = node =>
      $isRootNode(node.getParent()),
  ): string[] {
    return this.editor.read(() => {
      const out: string[] = [];
      const walk = (node: LexicalNode) => {
        if (isIdentified(node)) {
          out.push(
            `${node.getType()}:${node.getTextContent()}:${$getBlockId(node)}`,
          );
        }
        if ($isElementNode(node)) {
          node.getChildren().forEach(walk);
        }
      };
      $getRoot().getChildren().forEach(walk);
      return out;
    });
  }

  dispose(): void {
    this.cleanup();
    this.editor.dispose();
  }
}

export class Network {
  readonly peers: Peer[] = [];
  readonly version: CollabVersion;

  constructor(version: CollabVersion) {
    this.version = version;
  }

  add(name: string, options?: PeerOptions): Peer {
    const peer = new Peer(name, this.version, options);
    this.peers.push(peer);
    return peer;
  }

  /** Deliver everything `from` has to `to`, regardless of `online`. */
  deliver(from: Peer, to: Peer): void {
    applyUpdate(
      to.doc,
      encodeStateAsUpdate(from.doc, encodeStateVector(to.doc)),
      REMOTE,
    );
    to.flush();
  }

  /**
   * Exchange updates between online peers until nothing changes. Returns the
   * number of rounds that delivered something.
   */
  sync(maxRounds = 50): number {
    let rounds = 0;
    for (let round = 0; round < maxRounds; round++) {
      let delivered = false;
      const online = this.peers.filter(peer => peer.online);
      for (const from of online) {
        for (const to of online) {
          if (from === to) {
            continue;
          }
          const diff = encodeStateAsUpdate(from.doc, encodeStateVector(to.doc));
          const before = encodeStateVector(to.doc);
          applyUpdate(to.doc, diff, REMOTE);
          const after = encodeStateVector(to.doc);
          if (!sameBytes(before, after)) {
            delivered = true;
          }
        }
      }
      for (const peer of this.peers) {
        peer.flush();
      }
      if (!delivered) {
        return rounds;
      }
      rounds++;
    }
    throw new Error(`Network did not settle in ${maxRounds} rounds`);
  }

  dispose(): void {
    for (const peer of this.peers) {
      peer.dispose();
    }
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * The ids a reader gives the top-level blocks of `json`: a fresh headless
 * editor with BlockIdExtension (default config, random generator) loads it
 * with `setEditorState`, as a server reading a stored document would.
 */
export function readIds(
  json: SerializedEditorState,
  options: {$isIdentifiedBlock?: (node: LexicalNode) => boolean} = {},
): string[] {
  const reader = buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      RichTextExtension,
      ListExtension,
      configExtension(BlockIdExtension, options),
    ],
    name: '[reader]',
  });
  try {
    reader.setEditorState(reader.parseEditorState(json));
    return reader.read(() =>
      $getRoot()
        .getChildren()
        .map(node => `${$getBlockId(node)}`),
    );
  } finally {
    reader.dispose();
  }
}

/** A deep copy that keeps NodeState, as a Lexical-JSON paste does. */
export function $deepCopy<T extends LexicalNode>(node: T): T {
  const serialize = (n: LexicalNode): SerializedLexicalNode => {
    const json = n.exportJSON();
    if ($isElementNode(n)) {
      (json as SerializedElementNode).children = n.getChildren().map(serialize);
    }
    return json;
  };
  return $parseSerializedNode(serialize(node)) as T;
}

export function $block(index: number): ElementNode {
  const node = $getRoot().getChildAtIndex(index);
  if (!$isElementNode(node)) {
    throw new Error(`No element block at ${index}`);
  }
  return node;
}

/** Collapse the selection `offset` characters into block `index`. */
export function $caretAt(index: number, offset: number): void {
  const block = $block(index);
  let remaining = offset;
  for (const text of block.getAllTextNodes()) {
    const size = text.getTextContentSize();
    if (remaining <= size) {
      text.select(remaining, remaining);
      return;
    }
    remaining -= size;
  }
  block.selectEnd();
}

export function $enter(editor: LexicalEditor, index: number, offset: number) {
  $caretAt(index, offset);
  editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
}

/** Backspace at the start of block `index` (joins it into the previous). */
export function $join(editor: LexicalEditor, index: number) {
  $block(index).selectStart();
  editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
}

export function $type(index: number, offset: number, text: string) {
  $caretAt(index, offset);
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    selection.insertText(text);
  }
}
