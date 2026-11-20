/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {HorizontalRuleRule} from './coreImportRules';

/**
 * Import rules for {@link HorizontalRuleNode}. The `<hr>` rule is part of
 * {@link CoreImportRules} (gated on `HorizontalRuleNode` registration), so
 * this array exists only for backwards compatibility and introspection.
 *
 * @experimental
 */
export const HorizontalRuleImportRules = [HorizontalRuleRule];
