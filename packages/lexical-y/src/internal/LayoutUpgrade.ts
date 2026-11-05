/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {YSessionHandshake} from './Server';

import {LAYOUT_VERSION, MIN_LAYOUT, SEED_LAYOUT} from './constants';
import {SUPPORTED_FEATURES} from './Layouts';

// How an app declares what happens to a document below MIN_LAYOUT (see
// y.md "Layout upgrades"): `layoutUpgrade`, required by createYCollabConfig.
// Small on purpose, and free of the binding: the core and the server entry
// each bundle a copy, and a handle from either is recognized by both (the
// brand is a registered symbol).

/**
 * The brand of a layout upgrade handle: a registered symbol, so every copy
 * of the package (the core's bundle and the server entry's) recognizes the
 * same handles.
 */
export const LAYOUT_UPGRADE: unique symbol = Symbol.for(
  '@lexical/y/layout-upgrade',
);

/** @experimental What a client sends before any sync message (see checkYSession). */
export interface YClientSession {
  /** The generation its material was made against, null when it has none. */
  readonly generation: string | null;
  /** Whether it holds material: unsent edits or a cached state. */
  readonly material: boolean;
}

/**
 * @experimental How documents below MIN_LAYOUT are upgraded, for
 * `layoutUpgrade` (made by createYServerLayoutUpgrade; `null` declares
 * that such documents stay read only). Open on purpose: `kind` names the
 * strategy (`'server'`, the only one this release makes: the document's
 * server migrates it on load) and later releases may add kinds and fields.
 * The binding behaves the same with any handle (a document below the floor
 * is read only until it is migrated); the handle says what the app
 * declared, in the `'older'` warning, and builds the session handshake.
 */
export interface YLayoutUpgradeHandle {
  readonly [LAYOUT_UPGRADE]: true;
  /** The strategy: `'server'`. */
  readonly kind: string;
  /** The layout documents are upgraded to (MIN_LAYOUT by default). */
  readonly target: number;
  /**
   * The complete handshake a client sends before any sync message
   * (checkYSession): this release's layouts, seed layout and features,
   * with the session's generation and material.
   */
  handshake(session: YClientSession): YSessionHandshake;
}

/** @experimental Options of createYServerLayoutUpgrade. */
export interface YServerLayoutUpgradeOptions {
  /**
   * The layout the server migrates documents to (default MIN_LAYOUT, the
   * runner's and prepareYRoom's default target): from MIN_LAYOUT to
   * LAYOUT_VERSION.
   */
  readonly target?: number;
}

/**
 * @experimental The handshake a client of this release sends (see
 * checkYSession): a version 1 YSessionHandshake with the layouts it reads,
 * the layout its seed records and every feature it supports (always
 * present, sorted), with the session's generation and material.
 */
export function clientHandshake(session: YClientSession): YSessionHandshake {
  return {
    features: [...SUPPORTED_FEATURES].sort(),
    generation: session.generation,
    layouts: [MIN_LAYOUT, LAYOUT_VERSION],
    material: session.material,
    seed: SEED_LAYOUT,
    v: 1,
  };
}

/**
 * @experimental Declare that the document's server upgrades documents below
 * MIN_LAYOUT (it migrates them on load, see y-server.md): the handle for
 * `layoutUpgrade`. Its `handshake()` builds the session handshake, so an
 * app never assembles one by hand.
 */
export function createYServerLayoutUpgrade(
  options: YServerLayoutUpgradeOptions = {},
): YLayoutUpgradeHandle {
  const target = options.target ?? MIN_LAYOUT;
  if (
    !Number.isSafeInteger(target) ||
    target < MIN_LAYOUT ||
    target > LAYOUT_VERSION
  ) {
    throw new RangeError(
      `@lexical/y: a layout upgrade target is a layout from ${MIN_LAYOUT} to ${LAYOUT_VERSION} (got ${String(target)})`,
    );
  }
  return Object.freeze({
    [LAYOUT_UPGRADE]: true as const,
    handshake: clientHandshake,
    kind: 'server',
    target,
  });
}

/**
 * @experimental Whether `value` is a layout upgrade handle (any copy's):
 * the brand, a non-empty `kind`, an integer `target` from 1 and a
 * `handshake` function. A handle declares what the app expects and builds
 * the handshake; it is not proof that a server is wired to migrate.
 */
export function isYLayoutUpgradeHandle(
  value: unknown,
): value is YLayoutUpgradeHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[LAYOUT_UPGRADE] === true &&
    typeof (value as {kind?: unknown}).kind === 'string' &&
    (value as {kind: string}).kind !== '' &&
    Number.isSafeInteger((value as {target?: unknown}).target) &&
    (value as {target: number}).target >= 1 &&
    typeof (value as {handshake?: unknown}).handshake === 'function'
  );
}
