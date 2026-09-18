/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {HorizontalRuleExtension} from '@lexical/extension';
import {defineExtension} from 'lexical';

import {CoreImportExtension} from './CoreImportExtension';
import {HorizontalRuleRule} from './coreImportRules';

/**
 * Import rules for {@link HorizontalRuleNode}. The `<hr>` rule is part of
 * {@link CoreImportRules} (gated on `HorizontalRuleNode` registration), so
 * this array exists only for backwards compatibility and introspection.
 *
 * @experimental
 */
export const HorizontalRuleImportRules = [HorizontalRuleRule];

/**
 * Bundles the runtime {@link HorizontalRuleExtension} together with
 * {@link CoreImportExtension}, whose {@link CoreImportRules} include the
 * registration-gated `<hr>` rule.
 *
 * @experimental
 * @deprecated The `<hr>` import rule now ships with
 * {@link CoreImportRules} and activates whenever `HorizontalRuleNode` is
 * registered — depend on `HorizontalRuleExtension` (plus any extension
 * that brings in `CoreImportExtension`) directly instead.
 */
export const HorizontalRuleImportExtension = defineExtension({
  dependencies: [HorizontalRuleExtension, CoreImportExtension],
  name: '@lexical/html/HorizontalRuleImport',
});
