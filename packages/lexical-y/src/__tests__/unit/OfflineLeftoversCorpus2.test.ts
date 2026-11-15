/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Leftovers over the corpus of unsynced edits, seeds 700 to 1399 (see
// utils/offlineLeftoversCorpus). Run with gc off and on (LEXICAL_Y_GC=1).

import {describeLeftoversCorpus} from '../utils/offlineLeftoversCorpus';

describeLeftoversCorpus(700, 1400);
