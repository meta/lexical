/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The size gate at production's argument limit (see utils/sizeShapes.ts).

import {describeMigration3to4, UNITS} from '../utils/sizeShapes';

describeMigration3to4(Math.ceil(UNITS / 3), 'ab');
