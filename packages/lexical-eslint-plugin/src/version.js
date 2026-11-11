/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @ts-check

/**
 * The version the plugin reports when it runs from source (the monorepo's
 * own lint, the unit tests). The literal is rewritten to the monorepo
 * version by scripts/updateVersion.mjs (`pnpm run update-version`); the
 * published build replaces `process.env.LEXICAL_VERSION` instead.
 */
export const SOURCE_VERSION = '0.53.0+source';
