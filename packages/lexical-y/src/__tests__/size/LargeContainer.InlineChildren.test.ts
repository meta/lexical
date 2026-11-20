/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The size gate at production's argument limit (see utils/sizeShapes.ts).

import {describeShape, SHAPES} from '../utils/sizeShapes';

describeShape(SHAPES[3]);
