/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {createHash} from 'node:crypto';

/**
 * JSON with every object's keys sorted (and `undefined` members left out),
 * so that two values `toEqual` compares as equal give the same text.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return v;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) {
      out[key] = (v as Record<string, unknown>)[key];
    }
    return out;
  });
}

/** The SHA-256 of `data`, in hex. */
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
