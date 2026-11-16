/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Collab Y offline mode (`@lexical/y/offline`), on with the "Collab Y
// Offline" setting (`?collabYOffline=true`):
//
// - the document is stored in IndexedDB as it is edited, so the page opens
//   with no connection and keeps what was typed (the toolbar's connect
//   button takes the page offline);
// - on reconnect at the same epoch it syncs as usual;
// - when the epoch moved, the page's copy is frozen and captured, and the
//   page opens the room's new document. At stage `replay` (the default)
//   what did not sync is put back at once, in one undo step: the blocks
//   nobody changed since are reapplied, and every other block is inserted
//   after the block it conflicts with, in a collapsible "Offline edits that
//   did not merge" (`leftovers: {wrap}`, required by the API, so no edit is
//   left only in a panel an app could forget). The Offline edits panel
//   says what was reapplied and inserted. At stage `persist` nothing is
//   written until the panel's buttons are used: Reapply for a block nobody
//   changed, Insert for one someone did.
//
// The playground's relay has no epochs, so `?collabYEpoch=<n>` stands in for
// what a server would say: each epoch is its own room, and the panel's
// "Simulate replaced" button plays the server (it copies the document the
// server holds into the next epoch's room, then tells this page the room was
// replaced). `?collabYOfflineStage=persist` turns the automatic replay off.

import {type Signal, signal} from '@lexical/extension';
import {useSignalValue} from '@lexical/react/useExtensionSignalValue';
import {createYDoc, type YCollabBinding} from '@lexical/y';
import {type HeadlessYConfig} from '@lexical/y/headless';
import {
  attachYOfflineSession,
  loadYOffline,
  openYOfflineStore,
  recoverYOfflineEdits,
  replayUnsyncedEdits,
  wrapLeftoversAsQuote,
  Y_OFFLINE_STAGES,
  type YAutoReplay,
  type YLeftovers,
  type YOfflineCapture,
  type YOfflineLoaded,
  type YOfflineRecovered,
  type YOfflineSession,
  type YOfflineStage,
  type YOfflineStore,
} from '@lexical/y/offline';
import {WebsocketProvider} from '@y/websocket';
import {encodeStateAsUpdate} from '@y/y';
import {type SerializedLexicalNode} from 'lexical';
import {type JSX, useCallback} from 'react';

const params = new URLSearchParams(window.location.search);

/** The epoch the playground's "server" is at (see the note above). */
export const COLLAB_Y_EPOCH = params.get('collabYEpoch') || '1';

const requestedStage = params.get('collabYOfflineStage');
/** The rollout stage: `replay` unless the URL says otherwise. */
export const COLLAB_Y_OFFLINE_STAGE: YOfflineStage = Y_OFFLINE_STAGES.includes(
  requestedStage as YOfflineStage,
)
  ? (requestedStage as YOfflineStage)
  : 'replay';

/**
 * `?collabYAutoReplay=none` sends every block to the collapsible section,
 * and `?collabYAutoReplay=<ms>` does so for a copy older than that; by
 * default the blocks nobody changed are reapplied.
 */
const requestedAutoReplay = params.get('collabYAutoReplay');
const COLLAB_Y_AUTO_REPLAY: YAutoReplay =
  requestedAutoReplay === 'none'
    ? 'none'
    : requestedAutoReplay !== null && /^\d+$/.test(requestedAutoReplay)
      ? {maxBaseAge: Number(requestedAutoReplay)}
      : 'replayable';

const LEFTOVERS_LABEL = 'Offline edits that did not merge';
const labelFor = ({capturedAt}: {capturedAt: number}) =>
  `${LEFTOVERS_LABEL} · ${new Date(capturedAt).toLocaleString()}`;
const asQuote = wrapLeftoversAsQuote(labelFor);

/**
 * What the playground does with the blocks a replay cannot apply: it writes
 * them into the document, in a collapsible section after the block they
 * conflict with, as the user had them. An editor without the collapsible
 * nodes gets the default wrapper (a bold label and quotes).
 */
const LEFTOVERS: YLeftovers = {
  wrap: (blocks, context) =>
    ['collapsible-container', 'collapsible-title', 'collapsible-content'].every(
      type => context.hasNode(type),
    )
      ? [
          {
            children: [
              {
                children: [
                  {
                    detail: 0,
                    format: 0,
                    mode: 'normal',
                    style: '',
                    text: labelFor(context),
                    type: 'text',
                    version: 1,
                  },
                ],
                direction: null,
                format: '',
                indent: 0,
                type: 'collapsible-title',
                version: 1,
              },
              {
                children: blocks.map(block => block.yours),
                direction: null,
                format: '',
                indent: 0,
                type: 'collapsible-content',
                version: 1,
              },
            ],
            direction: null,
            format: '',
            indent: 0,
            open: true,
            type: 'collapsible-container',
            version: 1,
          } as SerializedLexicalNode,
        ]
      : asQuote(blocks, context),
};

/** The room of a document at an epoch: epoch 1 is the room without it. */
export function roomAtEpoch(room: string, epoch: string): string {
  return epoch === '1' ? room : `${room}@${epoch}`;
}

/** What was read from the local store before the document is made. */
export interface CollabYOfflinePrepared {
  /** Null when there is no local store here (it says why in `problem`). */
  store: YOfflineStore | null;
  loaded: YOfflineLoaded | null;
  problem: string | null;
}

const prepared = new Map<string, Promise<CollabYOfflinePrepared | null>>();

/**
 * Open the local store and read the document stored for `key`; null with
 * offline mode off. One promise per key, so React's `use` can wait on it.
 */
export function prepareCollabYOffline(
  key: string,
  enabled: boolean,
): Promise<CollabYOfflinePrepared | null> {
  const id = `${enabled}:${key}`;
  let promise = prepared.get(id);
  if (promise === undefined) {
    promise = enabled ? prepare(key) : Promise.resolve(null);
    prepared.set(id, promise);
  }
  return promise;
}

async function prepare(key: string): Promise<CollabYOfflinePrepared> {
  const opened = await openYOfflineStore({
    idb: {
      IDBKeyRange: globalThis.IDBKeyRange,
      indexedDB: globalThis.indexedDB,
    },
  });
  if (!opened.ok) {
    return {loaded: null, problem: opened.error.message, store: null};
  }
  const loaded = await loadYOffline({key, store: opened.value});
  if (!loaded.ok) {
    return {loaded: null, problem: loaded.error.message, store: opened.value};
  }
  return {loaded: loaded.value, problem: null, store: opened.value};
}

export interface CollabYOfflineStatus {
  hasUnsyncedEdits: boolean;
  persisted: boolean;
  problem: string | null;
}

/** The page's offline mode: the session, and what the panel shows. */
export interface CollabYOffline {
  readonly epoch: string;
  readonly stage: YOfflineStage;
  readonly status: Signal<CollabYOfflineStatus>;
  /** What did not sync, per capture (null until the first sync). */
  readonly recovered: Signal<YOfflineRecovered[] | null>;
  /** The provider finished a sync: confirm it, then gather what did not sync. */
  onSynced(): void;
  reapply(captureId: string, blockId: string): Promise<void>;
  /**
   * The blocks of a capture its Insert wrote into the document: a second
   * write would insert them again (a replay with wrap writes a report's
   * leftovers each time it is called), so the panel stops offering them.
   */
  inserted(captureId: string): ReadonlySet<string>;
  dismiss(captureId: string): Promise<void>;
  /** Play the server: move the room to the next epoch (see the note above). */
  simulateReplaced(): Promise<void>;
  /** True once the epoch moved: this document is never synced again. */
  frozen(): boolean;
  dispose(): void;
}

/**
 * The stored document to start from, when it belongs to the epoch the
 * room is at; otherwise the page starts from the server (and a document
 * stored at another epoch becomes a capture after the first sync).
 */
export function storedStateFor(
  from: CollabYOfflinePrepared | null,
): Uint8Array | null {
  return from !== null &&
    from.loaded !== null &&
    from.loaded.epoch === COLLAB_Y_EPOCH
    ? from.loaded.state
    : null;
}

export function createCollabYOffline(input: {
  binding: YCollabBinding;
  from: CollabYOfflinePrepared;
  key: string;
  /** The headless configuration of the same editor, for the reports. */
  config: HeadlessYConfig;
  /** The relay, and this document's room without its epoch. */
  endpoint: string;
  room: string;
  /** Stop syncing the page's document for good (its provider). */
  stopSync: () => void;
}): CollabYOffline {
  const {binding, config, from, key} = input;
  const {store} = from;
  const stage = store === null ? 'off' : COLLAB_Y_OFFLINE_STAGE;
  const status = signal<CollabYOfflineStatus>({
    hasUnsyncedEdits: false,
    persisted: store !== null,
    problem: from.problem,
  });
  const recovered = signal<YOfflineRecovered[] | null>(null);
  // Kept across reloads (this page's storage), so a reload at stage
  // 'persist' does not offer a block again; Insert deletes a capture once
  // everything of it is in the document, so a recovery at 'replay' does not
  // write it again.
  const insertedKey = (captureId: string) =>
    `lexical-playground:collab-y-inserted:${key}:${captureId}`;
  const insertedOf = (captureId: string): Set<string> => {
    try {
      const stored = window.localStorage.getItem(insertedKey(captureId));
      return new Set(stored === null ? [] : (JSON.parse(stored) as string[]));
    } catch {
      return new Set();
    }
  };
  const useStored = storedStateFor(from) !== null;
  const session: YOfflineSession = attachYOfflineSession({
    binding,
    epoch: COLLAB_Y_EPOCH,
    key,
    loaded: useStored && from.loaded !== null ? from.loaded : undefined,
    onError: error => {
      status.value = {
        ...status.peek(),
        persisted: false,
        problem: error.message,
      };
    },
    stage,
    store,
  });
  const doc = binding.binding.doc;
  const refreshStatus = () => {
    const before = status.peek();
    const next = {
      hasUnsyncedEdits: session.hasUnsyncedEdits,
      persisted: session.persisted,
      problem: session.persisted ? from.problem : before.problem,
    };
    if (
      next.hasUnsyncedEdits !== before.hasUnsyncedEdits ||
      next.persisted !== before.persisted ||
      next.problem !== before.problem
    ) {
      status.value = next;
    }
  };
  const onTransaction = () => {
    refreshStatus();
    void session.flush().then(refreshStatus);
  };
  doc.on('afterTransaction', onTransaction);
  refreshStatus();

  const recover = async () => {
    if (binding.status.kind !== 'active') {
      return;
    }
    try {
      const result = await recoverYOfflineEdits({
        autoReplay: COLLAB_Y_AUTO_REPLAY,
        binding,
        config,
        epoch: COLLAB_Y_EPOCH,
        key,
        leftovers: LEFTOVERS,
        session,
        stage,
        store,
      });
      if (result.ok) {
        recovered.value = result.value;
      } else {
        status.value = {...status.peek(), problem: result.error.message};
      }
    } catch (error) {
      // The reports could not be made (the headless editor): the captures
      // are still stored, and the panel offers their text.
      const captures = store === null ? null : await store.captures(key);
      recovered.value =
        captures !== null && captures.ok
          ? captures.value.map(capture => ({
              capture,
              replay: null,
              report: {
                error: {code: 'failed', message: String(error)},
                ok: false,
              },
            }))
          : [];
    }
  };
  let recovering: Promise<void> | null = null;

  return {
    dismiss: async captureId => {
      if (store !== null) {
        await store.deleteCapture(key, captureId);
      }
      await recover();
    },
    dispose: () => {
      doc.off('afterTransaction', onTransaction);
      session.dispose();
    },
    epoch: COLLAB_Y_EPOCH,
    frozen: () => session.ended,
    inserted: insertedOf,
    onSynced: () => {
      if (session.ended) {
        return;
      }
      // The epoch is the room's (the provider is connected to it).
      void session.serverEpoch(COLLAB_Y_EPOCH).then(verdict => {
        if (verdict.kind === 'same' && !session.ended) {
          session.markSynced();
          refreshStatus();
          recovering ??= recover();
        }
      });
    },
    reapply: async (captureId, blockId) => {
      const entry = (recovered.peek() ?? []).find(
        r => r.capture.id === captureId,
      );
      if (entry !== undefined && entry.report.ok) {
        // A block nobody changed is put back; one someone changed is
        // inserted after it, in the collapsible section.
        try {
          const result = replayUnsyncedEdits({
            // The user asked for this block: it is put back whatever its age.
            autoReplay: 'replayable',
            binding,
            leftovers: LEFTOVERS,
            only: [blockId],
            report: entry.report.value,
          });
          if (result.inserted.length > 0) {
            const written = insertedOf(captureId);
            written.add(blockId);
            window.localStorage.setItem(
              insertedKey(captureId),
              JSON.stringify([...written]),
            );
            // What of it is still only in the capture: a block with content
            // neither inserted here nor in the document (a replayable block
            // reapplied before is no longer in the report).
            const rest = entry.report.value.blocks.filter(
              block => block.yours !== null && !written.has(block.id),
            );
            if (rest.length === 0 && store !== null) {
              // Everything of it with content is in the document now.
              await store.deleteCapture(key, captureId);
              window.localStorage.removeItem(insertedKey(captureId));
            }
          }
        } catch (error) {
          // Nothing was written (the editor update failed, or the binding
          // did not store it): the block stays offered.
          console.error(error);
        }
      }
      await recover();
    },
    recovered,
    simulateReplaced: async () => {
      const next = String((Number(COLLAB_Y_EPOCH) || 1) + 1);
      // Stop syncing this document for good, then freeze and capture it:
      // nothing of it may reach the old room again (a reconnect included;
      // the toolbar's Connect does nothing once it is frozen).
      input.stopSync();
      const verdict = await session.serverEpoch(next);
      if (verdict.kind !== 'moved') {
        return;
      }
      // The server reloads the room from what it holds (the relay's room at
      // this epoch), as a real replace or upgrade would.
      const oldRoom = roomAtEpoch(input.room, COLLAB_Y_EPOCH);
      const serverState = await readRoom(input.endpoint, oldRoom);
      const seeded =
        serverState === null
          ? false
          : await seedRoom(
              input.endpoint,
              roomAtEpoch(input.room, next),
              serverState,
            );
      if (!seeded) {
        status.value = {
          ...status.peek(),
          problem:
            'The relay did not answer, so the room was not replaced. This page is frozen and its edits are stored on this device: reload when the relay is back.',
        };
        return;
      }
      const url = new URL(window.location.href);
      url.searchParams.set('collabYEpoch', next);
      window.location.href = url.toString();
    },
    stage,
    status,
  };
}

/** What a room holds on the relay, or null when the relay does not answer. */
function readRoom(endpoint: string, room: string): Promise<Uint8Array | null> {
  return new Promise(resolve => {
    const doc = createYDoc(null);
    const provider = new WebsocketProvider(endpoint, room, doc, {
      disableBc: true,
    });
    const finish = (state: Uint8Array | null) => {
      clearTimeout(timer);
      provider.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => finish(null), 3000);
    provider.on('sync', (isSynced: boolean) => {
      if (isSynced) {
        finish(encodeStateAsUpdate(doc));
      }
    });
  });
}

/**
 * Put `state` into a room, as a server that reloaded a document would.
 * False when the relay does not answer.
 */
function seedRoom(
  endpoint: string,
  room: string,
  state: Uint8Array,
): Promise<boolean> {
  return new Promise(resolve => {
    const provider = new WebsocketProvider(endpoint, room, createYDoc(state), {
      disableBc: true,
    });
    let settled = false;
    const finish = (seeded: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        // Sync step 2 (this document's content) was sent with step 1.
        setTimeout(() => {
          provider.destroy();
          resolve(seeded);
        }, 200);
      }
    };
    const timer = setTimeout(() => finish(false), 3000);
    provider.on('sync', (isSynced: boolean) => {
      if (isSynced) {
        finish(true);
      }
    });
  });
}

/** The plain text of a serialized block. */
function previewOf(node: unknown): string {
  if (typeof node !== 'object' || node === null) {
    return '';
  }
  const {children, text} = node as {children?: unknown; text?: unknown};
  if (typeof text === 'string') {
    return text;
  }
  return Array.isArray(children) ? children.map(previewOf).join('') : '';
}

function copy(text: string): void {
  void navigator.clipboard.writeText(text);
}

const CHANGE_LABEL = {
  added: 'Added',
  changed: 'Changed',
  deleted: 'Deleted',
} as const;

function CaptureView({
  entry,
  offline,
}: {
  entry: YOfflineRecovered;
  offline: CollabYOffline;
}): JSX.Element {
  const capture: YOfflineCapture = entry.capture;
  // Without the blocks this page's Insert already wrote.
  const written = offline.inserted(capture.id);
  const blocks = entry.report.ok
    ? entry.report.value.blocks.filter(block => !written.has(block.id))
    : [];
  const applied = entry.replay === null ? 0 : entry.replay.applied.length;
  // The blocks written for what did not merge: by this call, or (after a
  // refresh) as the capture records them.
  const inserted =
    entry.replay !== null
      ? entry.replay.inserted.length
      : capture.resolved !== undefined
        ? capture.resolved.inserted.length
        : 0;
  const fallbacks =
    entry.replay === null
      ? []
      : entry.replay.leftovers.flatMap(place =>
          place.fallback === null ? [] : [place.fallback],
        );
  return (
    <section
      className="collab-y-offline-capture"
      data-test-id="collab-y-offline-capture">
      <div className="collab-y-offline-capture-title">
        <strong>Offline edits</strong> from epoch {capture.epoch ?? 'none'}
        {applied > 0 ? ` · ${applied} reapplied` : ''}
        {inserted > 0
          ? ` · ${inserted} block${inserted === 1 ? '' : 's'} inserted under "${LEFTOVERS_LABEL}"`
          : ''}
        {applied > 0 || (inserted > 0 && entry.replay !== null)
          ? ' (undo to revert)'
          : ''}
        {capture.text !== null ? (
          <button
            type="button"
            onClick={() => copy(capture.text ?? '')}
            title="Copy the whole document as you had it">
            Copy all
          </button>
        ) : null}
        <button
          type="button"
          data-test-id="collab-y-offline-dismiss"
          onClick={() => void offline.dismiss(capture.id)}>
          Dismiss
        </button>
      </div>
      {fallbacks.map(fallback => (
        <div key={fallback} className="collab-y-offline-problem">
          {fallback}
        </div>
      ))}
      {!entry.report.ok ? (
        <div className="collab-y-offline-problem">
          These edits could not be compared with the document; their text is
          kept (Copy all).
        </div>
      ) : blocks.length === 0 ? (
        <div className="collab-y-offline-empty">
          {entry.report.value.orderDiffers
            ? 'Your copy has its blocks in another order; the rest is in the document.'
            : inserted > 0
              ? 'Everything is in the document: what did not merge is in a collapsible section after the block it conflicts with.'
              : 'Everything is in the document.'}
        </div>
      ) : (
        blocks.map(block => {
          const preview = previewOf(block.yours ?? block.base);
          return (
            <div
              key={block.id}
              className="collab-y-offline-block"
              data-test-id="collab-y-offline-block"
              data-change={block.change}
              data-replayable={block.replayable}>
              <span className="collab-y-offline-change">
                {CHANGE_LABEL[block.change]}
              </span>
              <span className="collab-y-offline-preview">{preview}</span>
              <button type="button" onClick={() => copy(preview)}>
                Copy
              </button>
              <button
                type="button"
                data-test-id="collab-y-offline-reapply"
                title={
                  block.replayable
                    ? 'Put this block back as you had it'
                    : block.yours === null
                      ? 'Someone changed this block since, so it stays'
                      : `Someone changed this block since: insert yours after it, under "${LEFTOVERS_LABEL}"`
                }
                disabled={!block.replayable && block.yours === null}
                onClick={() => void offline.reapply(capture.id, block.id)}>
                {block.replayable ? 'Reapply' : 'Insert'}
              </button>
            </div>
          );
        })
      )}
    </section>
  );
}

/** The status line and the Offline edits panel. */
export function CollabYOfflinePanel({
  offline,
}: {
  offline: CollabYOffline;
}): JSX.Element {
  const status = useSignalValue(offline.status);
  const recovered = useSignalValue(offline.recovered);
  const simulate = useCallback(
    () => void offline.simulateReplaced(),
    [offline],
  );
  return (
    <div className="collab-y-offline" data-test-id="collab-y-offline">
      <div
        className="collab-y-offline-status"
        data-test-id="collab-y-offline-status"
        data-unsynced={status.hasUnsyncedEdits}
        data-persisted={status.persisted}>
        Offline mode ({offline.stage}) · epoch {offline.epoch} ·{' '}
        {status.persisted ? 'saved on this device' : 'not saved on this device'}{' '}
        · {status.hasUnsyncedEdits ? 'edits waiting to sync' : 'synced'}
        <button
          type="button"
          data-test-id="collab-y-offline-replace"
          onClick={simulate}
          title="Play the server: move this room to the next epoch">
          Simulate replaced
        </button>
      </div>
      {status.problem !== null ? (
        <div className="collab-y-offline-problem" role="status">
          {status.problem}
        </div>
      ) : null}
      {(recovered ?? []).map(entry => (
        <CaptureView key={entry.capture.id} entry={entry} offline={offline} />
      ))}
    </div>
  );
}
