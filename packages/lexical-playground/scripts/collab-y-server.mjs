#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A minimal in-memory Yjs 14 (`@y/y`) relay for the playground's collab Y
// mode (`@lexical/y`), started by `pnpm run collab:y`.
//
// It speaks the y-websocket wire protocol (sync step 1/2, updates, awareness)
// so the published `@y/websocket` client connects to it. The published
// `@y/websocket-server` still depends on the pre-`@y/y` Yjs 14 prereleases
// (`yjs@14.0.0-*`), whose documents are not compatible with `@y/y`, hence
// this script. It is a development and test server only: no persistence, no
// authentication.
//
//   HOST=localhost PORT=1235 node scripts/collab-y-server.mjs
//
// The URL path is the room (`ws://localhost:1235/<room>`).
//
// It is fenced (collab-y-fence.mjs, docs/collaboration/y-server.md's
// "Migrating stored documents"): a room migrates when it loads, every
// connection presents a handshake in its URL (`g`, `m`, `lo`, `hi`, `seed`)
// and receives the verdict in a message of type 8 (JSON) before any sync, a
// client from before the fence is captured, and a stale client hands its
// material off over HTTP. The fence needs `@lexical/y` built (`pnpm run
// build`); without it, or with COLLAB_Y_FENCE=0, the relay is unfenced.
// COLLAB_Y_MIN_LAYOUT: the floor rooms migrate to when they load (default
// 1: nothing migrates).
//
// HTTP endpoints (JSON responses), used by the e2e suite:
//   GET  /health
//   GET  /delay?room=R&ms=N  delay every server-to-client message in R by N
//                            ms, so that edits made at the same time cross
//   GET  /state?room=R       layout, generation, version, records
//   GET  /records?room=R     the room's quarantine records (recovery list)
//   POST /floor?room=R&n=N   the floor R migrates to when it next loads
//   POST /reload?room=R      the migration moment: barrier (close every
//                            connection), seal, load (migrate), serve
//   POST /handoff?room=R     a stale client's material, JSON {snapshot
//                            (base64), draft, generation, peers, clients}:
//                            stored, acknowledged by hash, then replayed

import * as awarenessProtocol from '@y/protocols/awareness';
import * as syncProtocol from '@y/protocols/sync';
import * as Y from '@y/y';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import http from 'node:http';
import {WebSocketServer} from 'ws';

const HOST = process.env.HOST || 'localhost';
const PORT = Number(process.env.PORT || 1235);
const FLOOR = Number(process.env.COLLAB_Y_MIN_LAYOUT || 1);
/** The highest schema version the playground writes (legacy signals). */
const SCHEMA = Number(process.env.COLLAB_Y_SCHEMA || 1);

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

/** @type {typeof import('./collab-y-fence.mjs') | null} */
let fence = null;
if (process.env.COLLAB_Y_FENCE !== '0') {
  try {
    fence = await import('./collab-y-fence.mjs');
  } catch (error) {
    console.warn(
      `The relay runs unfenced: @lexical/y is not built (pnpm run build). ${String(error)}`,
    );
  }
}

/** @type {Map<string, Room>} live rooms */
const rooms = new Map();
/** @type {Map<string, import('./collab-y-fence.mjs').StoredRoom>} */
const stored = new Map();

/**
 * @typedef {{
 *   ids: Set<number>,
 *   mode: 'sync' | 'stale' | 'legacy' | 'refuse-layout',
 *   generation: string | null,
 *   capture?: import('./collab-y-fence.mjs').Entry,
 * }} Conn
 */

class Room {
  /**
   * @param {string} name
   * @param {Y.Doc} doc
   * @param {import('./collab-y-fence.mjs').StoredRoom | null} store
   */
  constructor(name, doc, store) {
    this.name = name;
    this.doc = doc;
    this.store = store;
    // No format cleanup, as on the clients (the binding opts out of it):
    // with it, the relay would delete format items that the clients keep
    // after each update it receives, and send those deletions to everyone.
    this.doc.cleanupFormatting = false;
    /** @type {Map<import('ws').WebSocket, Conn>} */
    this.conns = new Map();
    this.delay = 0;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);
    this.awareness.on('update', ({added, updated, removed}, conn) => {
      const entry = conn != null ? this.conns.get(conn) : undefined;
      if (entry !== undefined) {
        added.forEach(id => entry.ids.add(id));
        removed.forEach(id => entry.ids.delete(id));
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          added.concat(updated, removed),
        ),
      );
      this.broadcast(encoding.toUint8Array(encoder));
    });
    this.doc.on('update', update => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
    });
  }

  /** The room's current generation (null when unfenced). */
  generation() {
    return this.store === null
      ? null
      : fence.describeGeneration(this.doc, this.store);
  }

  /**
   * To every session that syncs.
   *
   * @param {Uint8Array} message
   */
  broadcast(message) {
    for (const [conn, entry] of this.conns) {
      if (entry.mode === 'sync') {
        this.send(conn, message);
      }
    }
  }

  /**
   * @param {import('ws').WebSocket} conn
   * @param {Uint8Array} message
   */
  send(conn, message) {
    const go = () => {
      if (conn.readyState > 1) {
        this.close(conn);
        return;
      }
      try {
        conn.send(message, error => error != null && this.close(conn));
      } catch {
        this.close(conn);
      }
    };
    if (this.delay > 0) {
      setTimeout(go, this.delay);
    } else {
      go();
    }
  }

  /** @param {import('ws').WebSocket} conn */
  close(conn) {
    const entry = this.conns.get(conn);
    if (entry !== undefined) {
      this.conns.delete(conn);
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [...entry.ids],
        null,
      );
    }
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
}

/** @param {string} name */
function getStore(name) {
  let store = stored.get(name);
  if (store === undefined) {
    store = new fence.StoredRoom(name, {floor: FLOOR});
    stored.set(name, store);
  }
  return store;
}

/** The live room, loaded (and migrated) on first use. @param {string} name */
function getRoom(name) {
  let room = rooms.get(name);
  if (room === undefined) {
    if (fence === null) {
      room = new Room(name, new Y.Doc(), null);
    } else {
      const store = getStore(name);
      room = new Room(name, store.load(), store);
    }
    rooms.set(name, room);
  }
  return room;
}

/**
 * The migration moment for one room: stop serving it (every connection
 * closes; their clients reconnect with their handshake), seal what it
 * applied, and load it again, which migrates it when it is below its floor.
 *
 * @param {string} name
 */
function reload(name) {
  const room = rooms.get(name);
  if (room !== undefined) {
    rooms.delete(name);
    for (const conn of [...room.conns.keys()]) {
      room.close(conn);
    }
    room.store.seal(room.doc);
  }
  return getRoom(name);
}

/**
 * @param {Room} room
 * @param {import('ws').WebSocket} conn
 * @param {unknown} body
 */
function sendFence(room, conn, body) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, fence.MESSAGE_FENCE);
  encoding.writeVarString(encoder, JSON.stringify(body));
  room.send(conn, encoding.toUint8Array(encoder));
}

/**
 * A captured session's sync message: keep its document and later updates,
 * never apply them; answer the snapshot with the signal.
 *
 * @param {Room} room
 * @param {import('ws').WebSocket} conn
 * @param {Conn} entry
 * @param {decoding.Decoder} decoder
 */
function onCaptured(room, conn, entry, decoder) {
  const step = decoding.readVarUint(decoder);
  if (step === syncProtocol.messageYjsSyncStep1) {
    return;
  }
  const update = decoding.readVarUint8Array(decoder);
  const capture = entry.capture.capture;
  const first = capture.material().snapshot === null;
  capture.add(update);
  if (first) {
    const signal = capture.signal(SCHEMA);
    if (signal !== null) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, signal.update);
      room.send(conn, encoding.toUint8Array(encoder));
    }
  }
}

/**
 * @param {import('ws').WebSocket} conn
 * @param {import('node:http').IncomingMessage} req
 */
function onConnection(conn, req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const name = decodeURIComponent(url.pathname.slice(1));
  const room = getRoom(name);
  conn.binaryType = 'arraybuffer';
  /** @type {Conn} */
  const entry = {generation: null, ids: new Set(), mode: 'sync'};
  room.conns.set(conn, entry);
  if (room.store !== null) {
    const handshake = fence.handshakeOf(url.searchParams);
    const {verdict, initialize} = room.store.verdict(room.doc, handshake);
    const generation = room.generation();
    entry.mode =
      verdict === 'admit' || verdict === 'bootstrap' ? 'sync' : verdict;
    entry.generation = entry.mode === 'sync' ? generation : null;
    if (handshake !== null) {
      sendFence(room, conn, {
        generation,
        initialize: initialize ?? false,
        verdict,
      });
    }
    if (verdict === 'legacy') {
      entry.capture = room.store.capture();
      for (const message of entry.capture.capture.messages) {
        room.send(conn, message);
      }
    } else if (verdict === 'refuse-layout') {
      setTimeout(() => room.close(conn), 100);
    }
  }
  conn.on('message', (/** @type {ArrayBuffer} */ data) => {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(data));
      const encoder = encoding.createEncoder();
      const type = decoding.readVarUint(decoder);
      if (entry.mode === 'legacy') {
        if (type === MESSAGE_SYNC) {
          onCaptured(room, conn, entry, decoder);
        }
        return;
      }
      if (entry.mode !== 'sync') {
        // A stale or refused session: nothing it sends is applied.
        return;
      }
      if (room.store !== null && entry.generation !== room.generation()) {
        // An update made against another generation never reaches the
        // document (the room migrated under this session).
        entry.mode = 'stale';
        room.close(conn);
        return;
      }
      if (type === MESSAGE_SYNC) {
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn);
        if (encoding.length(encoder) > 1) {
          room.send(conn, encoding.toUint8Array(encoder));
        }
      } else if (type === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(
          room.awareness,
          decoding.readVarUint8Array(decoder),
          conn,
        );
      } else if (type === MESSAGE_QUERY_AWARENESS) {
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(room.awareness, [
            ...room.awareness.getStates().keys(),
          ]),
        );
        room.send(conn, encoding.toUint8Array(encoder));
      }
    } catch (error) {
      console.error(`[${name}]`, error);
    }
  });
  let alive = true;
  conn.on('pong', () => {
    alive = true;
  });
  const ping = setInterval(() => {
    if (!alive) {
      room.close(conn);
      return;
    }
    alive = false;
    try {
      conn.ping();
    } catch {
      room.close(conn);
    }
  }, 30000);
  conn.on('close', () => {
    clearInterval(ping);
    room.close(conn);
  });
  if (entry.mode !== 'sync') {
    return;
  }
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, room.doc);
  room.send(conn, encoding.toUint8Array(encoder));
  const states = room.awareness.getStates();
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, [
        ...states.keys(),
      ]),
    );
    room.send(conn, encoding.toUint8Array(awarenessEncoder));
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json(res, status, body) {
  res.writeHead(status, {
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(body));
}

/** @param {import('node:http').IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const name = url.searchParams.get('room') || '';
  if (req.method === 'OPTIONS') {
    return json(res, 204, null);
  }
  try {
    switch (url.pathname) {
      case '/health':
        return json(res, 200, {
          fence: fence !== null,
          ok: true,
          rooms: rooms.size,
        });
      case '/delay': {
        const room = getRoom(name);
        room.delay = Math.max(0, Number(url.searchParams.get('ms') || 0));
        return json(res, 200, {delay: room.delay, room: name});
      }
    }
    if (fence === null) {
      return json(res, 404, {error: 'the relay is unfenced'});
    }
    switch (url.pathname) {
      case '/state': {
        const room = rooms.get(name);
        return json(res, 200, getStore(name).describe(room?.doc ?? null));
      }
      case '/records':
        return json(res, 200, getStore(name).list());
      case '/floor': {
        const store = getStore(name);
        store.floor = Math.max(1, Number(url.searchParams.get('n') || 1));
        return json(res, 200, {floor: store.floor, room: name});
      }
      case '/reload': {
        const room = reload(name);
        return json(res, 200, room.store.describe(room.doc));
      }
      case '/handoff': {
        if (req.method !== 'POST') {
          return json(res, 405, {error: 'POST'});
        }
        const body = JSON.parse(await readBody(req));
        const room = getRoom(name);
        const entry = room.store.handoff(
          {
            clients: Array.isArray(body.clients)
              ? body.clients.filter(c => Number.isSafeInteger(c))
              : [],
            draft: body.draft ?? null,
            generation: body.generation ?? null,
            peers: body.peers !== false,
            snapshot: new Uint8Array(Buffer.from(body.snapshot, 'base64')),
          },
          room.doc,
        );
        return json(res, 200, {
          hash: entry.record.hash,
          id: entry.id,
          replay: entry.replay,
        });
      }
      default:
        return json(res, 404, {error: 'unknown endpoint'});
    }
  } catch (error) {
    console.error(`[${name}]`, error);
    return json(res, 500, {error: String(error)});
  }
});

const wss = new WebSocketServer({noServer: true});
wss.on('connection', onConnection);
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req);
  });
});
server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    `Yjs 14 (@lexical/y) relay running on ws://${HOST}:${PORT} (${fence === null ? 'unfenced' : `fenced, floor ${FLOOR}`})`,
  );
});
