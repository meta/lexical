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
// HTTP endpoints (GET, JSON responses), used by the e2e suite:
//   /health
//   /delay?room=R&ms=N  delay every server-to-client message in R by N ms, so
//                       that edits made at the same time cross in flight

import * as awarenessProtocol from '@y/protocols/awareness';
import * as syncProtocol from '@y/protocols/sync';
import * as Y from '@y/y';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import http from 'node:http';
import {WebSocketServer} from 'ws';

const HOST = process.env.HOST || 'localhost';
const PORT = Number(process.env.PORT || 1235);

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

/** @type {Map<string, Room>} */
const rooms = new Map();

class Room {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
    this.doc = new Y.Doc();
    // No format cleanup, as on the clients (the binding opts out of it):
    // with it, the relay would delete format items that the clients keep
    // after each update it receives, and send those deletions to everyone.
    this.doc.cleanupFormatting = false;
    /** @type {Map<import('ws').WebSocket, {ids: Set<number>}>} */
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

  /** @param {Uint8Array} message */
  broadcast(message) {
    for (const conn of this.conns.keys()) {
      this.send(conn, message);
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
function getRoom(name) {
  let room = rooms.get(name);
  if (room === undefined) {
    room = new Room(name);
    rooms.set(name, room);
  }
  return room;
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
  room.conns.set(conn, {ids: new Set()});
  conn.on('message', (/** @type {ArrayBuffer} */ data) => {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(data));
      const encoder = encoding.createEncoder();
      const type = decoding.readVarUint(decoder);
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
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const name = url.searchParams.get('room') || '';
  switch (url.pathname) {
    case '/health':
      return json(res, 200, {ok: true, rooms: rooms.size});
    case '/delay': {
      const room = getRoom(name);
      room.delay = Math.max(0, Number(url.searchParams.get('ms') || 0));
      return json(res, 200, {delay: room.delay, room: name});
    }
    default:
      return json(res, 404, {error: 'unknown endpoint'});
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
  console.log(`Yjs 14 (@lexical/y) relay running on ws://${HOST}:${PORT}`);
});
