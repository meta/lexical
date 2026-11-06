/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// The boundary matrix (see utils/boundaryMatrix) on jsdom's browser (not
// Safari).

import {runBoundaryMatrix} from '../utils/boundaryMatrix';

runBoundaryMatrix('not Safari');
