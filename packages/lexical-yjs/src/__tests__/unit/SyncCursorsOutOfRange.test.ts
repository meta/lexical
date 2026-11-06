/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $getAnchorAndFocusForUserState,
  type Binding,
  createBinding,
  initLocalState,
  type Provider,
  type ProviderAwareness,
  type SyncCursorPositionsFn,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
  type UserState,
} from '@lexical/yjs';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  createEditor,
  type LexicalEditor,
  SKIP_COLLAB_TAG,
} from 'lexical';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import * as Y from 'yjs';

// Origin used when relaying an update into a peer doc, so the relayed update is
// never echoed back to its sender.
const RELAY_ORIGIN = Symbol('relay');

// Cursor rendering needs real layout (getBoundingClientRect), which jsdom
// cannot provide. Nothing under test depends on it, so it is stubbed while the
// rest of the binding-level sync still runs.
const noopSyncCursorPositions: SyncCursorPositionsFn = () => {};

interface TestClient {
  binding: Binding;
  doc: Y.Doc;
  editor: LexicalEditor;
  provider: Provider;
}

// A real provider delivers remote updates on a fresh event-loop callback, not
// nested inside the local editor's own update. We reproduce that by queueing
// cross-client deliveries and flushing them from the top of the test stack.
let pendingDeliveries: (() => void)[] = [];

// Teardown callbacks for resources acquired during a test (editor update
// listeners, Yjs deep observers, transport subscriptions and docs); run in
// afterEach in reverse order.
let cleanups: (() => void)[] = [];

function flushDeliveries(): void {
  while (pendingDeliveries.length > 0) {
    const deliveries = pendingDeliveries;
    pendingDeliveries = [];
    for (const deliver of deliveries) {
      deliver();
    }
  }
}

/**
 * Deliver queued cross-client updates and let Lexical settle. Applying a remote
 * update runs `syncYjsChangesToLexical`, whose `editor.update` is non-discrete
 * and therefore commits on a microtask (see LexicalUpdates `$beginUpdate`). We
 * flush the transport and drain microtasks in a bounded loop so the assertions
 * observe the committed editor state. This is deterministic: there is no real
 * timing involved, only the (FIFO) microtask queue.
 */
async function synchronize(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    flushDeliveries();
    await Promise.resolve();
  }
}

function createAwareness(doc: Y.Doc): ProviderAwareness {
  let localState: UserState | null = null;
  return {
    getLocalState: () => localState,
    getStates: () => {
      const states = new Map<number, UserState>();
      if (localState !== null) {
        states.set(doc.clientID, localState);
      }
      return states;
    },
    off: () => {},
    on: () => {},
    setLocalState: state => {
      localState = state;
    },
    setLocalStateField: (field, value) => {
      if (localState !== null) {
        localState = {...localState, [field]: value};
      }
    },
  };
}

/**
 * A minimal headless collaboration client: a real Lexical editor wired to a
 * real Yjs binding through the public `syncLexicalUpdateToYjs` /
 * `syncYjsChangesToLexical` functions. This is the same wiring the React
 * `CollaborationPlugin` performs, minus the browser, iframes and DOM cursor
 * rendering.
 */
function createClient(): TestClient {
  const doc = new Y.Doc({gc: false});
  const provider = {
    awareness: createAwareness(doc),
    connect: () => {},
    disconnect: () => {},
    off: () => {},
    on: () => {},
  } as unknown as Provider;
  const editor = createEditor({
    namespace: 'collab-out-of-range',
    onError: error => {
      throw error;
    },
  });
  const docMap = new Map([['main', doc]]);
  const binding = createBinding(editor, provider, 'main', doc, docMap);

  // Lexical update -> Yjs
  const removeUpdateListener = editor.registerUpdateListener(
    ({
      prevEditorState,
      editorState,
      dirtyElements,
      dirtyLeaves,
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

  // Yjs -> Lexical update
  const sharedType = binding.root.getSharedType();
  const onYjsTreeChanges = (
    // The `any` matches the vendor Yjs observeDeep callback types, as in
    // @lexical/react's useYjsCollaboration.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events: Y.YEvent<any>[],
    transaction: Y.Transaction,
  ) => {
    if (transaction.origin !== binding) {
      syncYjsChangesToLexical(
        binding,
        provider,
        events,
        false,
        noopSyncCursorPositions,
      );
    }
  };
  sharedType.observeDeep(onYjsTreeChanges);

  cleanups.push(() => {
    removeUpdateListener();
    sharedType.unobserveDeep(onYjsTreeChanges);
    doc.destroy();
  });

  return {binding, doc, editor, provider};
}

/** Relay all document updates between the clients (queued, flushed on demand). */
function connect(clients: TestClient[]): void {
  for (const client of clients) {
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === RELAY_ORIGIN) {
        return;
      }
      for (const other of clients) {
        if (other !== client) {
          pendingDeliveries.push(() =>
            Y.applyUpdate(other.doc, update, RELAY_ORIGIN),
          );
        }
      }
    };
    client.doc.on('update', onUpdate);
    cleanups.push(() => client.doc.off('update', onUpdate));
  }
}

/**
 * Builds a paragraph whose last child is a line break and places a collapsed
 * caret on the resulting empty final line (an element point after the line
 * break). Returns the paragraph's key.
 *
 * This is the shape that triggered the bug fixed in
 * https://github.com/meta/lexical/pull/8652: the caret's relative position
 * decodes to an index past the element's last child, which previously
 * collapsed to the start of the element.
 */
function setupCaretOnEmptyFinalLine(client: TestClient): string {
  let paragraphKey = '';
  client.editor.update(
    () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode('hello'), $createLineBreakNode());
      $getRoot().append(paragraph);
      paragraphKey = paragraph.getKey();
    },
    {discrete: true},
  );
  client.editor.update(
    () => {
      const paragraph = $getNodeByKey(paragraphKey);
      if ($isElementNode(paragraph)) {
        // offset 2 == after [text, lineBreak] == the empty final line
        paragraph.select(2, 2);
      }
    },
    {discrete: true},
  );
  return paragraphKey;
}

function readAnchor(
  editor: LexicalEditor,
): {key: string; offset: number; type: 'element' | 'text'} | null {
  return editor.read('latest', () => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      return null;
    }
    return {
      key: selection.anchor.key,
      offset: selection.anchor.offset,
      type: selection.anchor.type,
    };
  });
}

describe('SyncCursors out-of-range relative position (PR #8652)', () => {
  let local: TestClient;
  let remote: TestClient;

  beforeEach(() => {
    pendingDeliveries = [];
    local = createClient();
    remote = createClient();
    connect([local, remote]);
    initLocalState(local.provider, 'Local', '#ff0000', true, {});
  });

  afterEach(() => {
    // Dispose in reverse acquisition order: transport subscriptions first, then
    // each client's editor listener / Yjs observer, then the doc itself.
    for (let i = cleanups.length - 1; i >= 0; i--) {
      cleanups[i]();
    }
    cleanups = [];
    pendingDeliveries = [];
  });

  test('resolves a caret past the last child to the element end, not the start', () => {
    const paragraphKey = setupCaretOnEmptyFinalLine(local);

    // The caret was encoded into awareness via the real selection sync.
    const userState = local.provider.awareness.getLocalState();
    expect(userState).not.toBeNull();
    expect(userState!.anchorPos).not.toBeNull();
    expect(userState!.focusPos).not.toBeNull();

    // Resolve that awareness state back to a node key + offset through the
    // public binding-level API. Before the fix this collapsed to offset 0 (the
    // start of the paragraph); after the fix it resolves to the element end
    // (the number of children == 2).
    const {anchorKey, anchorOffset, focusKey, focusOffset} = local.editor.read(
      'latest',
      () => $getAnchorAndFocusForUserState(local.binding, userState!),
    );

    expect(anchorKey).toBe(paragraphKey);
    expect(focusKey).toBe(paragraphKey);
    expect(anchorOffset).toBe(2);
    expect(focusOffset).toBe(2);
  });

  test('keeps the local caret on the empty final line when a collaborator edits', async () => {
    const paragraphKey = setupCaretOnEmptyFinalLine(local);
    await synchronize();

    // Precondition: the local caret is the element point on the empty final line.
    expect(readAnchor(local.editor)).toEqual({
      key: paragraphKey,
      offset: 2,
      type: 'element',
    });

    // A collaborator makes an unrelated edit (appends a new paragraph). On
    // delivery this runs the local-cursor restoration path inside
    // syncYjsChangesToLexical.
    remote.editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('remote edit'));
        $getRoot().append(paragraph);
      },
      {discrete: true},
    );
    await synchronize();

    // The remote edit must have arrived.
    expect(
      local.editor.read('latest', () => $getRoot().getChildrenSize()),
    ).toBe(2);

    // The local caret must remain on the empty final line. Before the fix it
    // jumped to offset 0 (the start of the block).
    expect(readAnchor(local.editor)).toEqual({
      key: paragraphKey,
      offset: 2,
      type: 'element',
    });
  });
});
