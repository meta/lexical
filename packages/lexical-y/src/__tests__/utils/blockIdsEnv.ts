/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Imported before the harness by a test that runs the fuzz with block ids
// (WITH_BLOCK_IDS is read when the harness loads); the test deletes the
// variable again once its imports are evaluated.
process.env.LEXICAL_Y_BLOCK_ID = '1';
