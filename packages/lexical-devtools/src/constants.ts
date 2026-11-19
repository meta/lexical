/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

export const EXTENSION_NAME = 'lexical-devtools';

/**
 * Name of the query string parameter used to hand the per-page-load window
 * messaging namespace from the content script to the injected script.
 *
 * The namespace itself is generated at runtime and is deliberately NOT a
 * constant -- see `entrypoints/content/index.ts`.
 */
export const CHANNEL_NAMESPACE_PARAM = 'ns';
