/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {Linter} from 'eslint';
import {describe, expect, it} from 'vitest';

import plugin from '../../LexicalEslintPlugin.js';

describe('source code compatibility', () => {
  it.each([
    {
      code: 'function getRoot() { return $getRoot(); }',
      ruleName: 'rules-of-lexical',
    },
    {
      code: 'function updateEditor(editor) { editor.update(() => editor.update(() => {})); }',
      ruleName: 'no-nested-editor-updates',
    },
  ] as const)(
    '$ruleName preserves diagnostics with an ESLint 8 context',
    ({code, ruleName}) => {
      const rule = plugin.rules[ruleName];
      const linter = new Linter();
      const verify = (legacyContext: boolean) =>
        linter.verify(code, {
          plugins: {
            '@lexical': {
              rules: {
                [ruleName]: {
                  ...rule,
                  create(context) {
                    return rule.create(
                      legacyContext
                        ? Object.create(context, {
                            getSourceCode: {value: () => context.sourceCode},
                            sourceCode: {value: undefined},
                          })
                        : context,
                    );
                  },
                },
              },
            },
          },
          rules: {[`@lexical/${ruleName}`]: 'error'},
        });

      const messages = verify(false);
      expect(messages).toHaveLength(1);
      expect(messages[0].ruleId).toBe(`@lexical/${ruleName}`);
      // Include fix and suggestion payloads in the compatibility check.
      expect(verify(true)).toEqual(messages);
    },
  );
});
