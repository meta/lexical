/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Leftovers over the corpus of unsynced edits, seeds 0 to 699 (see
// utils/offlineLeftoversCorpus). Run with gc off and on (LEXICAL_Y_GC=1).

import {describeLeftoversCorpus} from '../utils/offlineLeftoversCorpus';

describeLeftoversCorpus(0, 700);
