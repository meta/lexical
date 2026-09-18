/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {configExtension, defineExtension} from 'lexical';

import {CoreImportRules} from './coreImportRules';
import {DOMImportExtension} from './DOMImportExtension';

/**
 * Bundles {@link CoreImportRules} into a {@link DOMImportExtension}-aware
 * extension. Node-providing extensions that contribute import rules
 * (`RichTextExtension`, `ListExtension`, `LinkExtension`,
 * `TableExtension`, `CodeExtension`, …) depend on this themselves, so
 * most editors get it implicitly; depend on it directly to get the
 * equivalent of the legacy core `importDOM` behavior for `<p>`,
 * `<span>`, `<b>`, `<strong>`, `<em>`, `<i>`, `<code>`, `<mark>`,
 * `<s>`, `<sub>`, `<sup>`, `<u>`, `<br>`, and `#text` (plus `<hr>`
 * when `HorizontalRuleNode` is registered).
 *
 * @experimental
 */
export const CoreImportExtension = defineExtension({
  dependencies: [
    configExtension(DOMImportExtension, {
      rules: CoreImportRules,
    }),
  ],
  name: '@lexical/html/CoreImport',
});
