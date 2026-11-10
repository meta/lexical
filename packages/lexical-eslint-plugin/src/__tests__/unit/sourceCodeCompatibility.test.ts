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

describe.each([true, false])(
  'source code compatibility (getScope: %s)',
  hasGetScope => {
    it.each([
      {
        code: 'function getRoot() { return $getRoot(); }',
        expectedCount: 1,
        ruleName: 'rules-of-lexical',
      },
      {
        code: 'function updateEditor(editor) { editor.update(() => editor.update(() => {})); }',
        expectedCount: 1,
        ruleName: 'no-nested-editor-updates',
      },
      {
        code: 'editor.update(() => editor.update(() => {}));',
        expectedCount: 1,
        ruleName: 'no-nested-editor-updates',
      },
      {
        code: 'const editor = createEditor(); editor.update(() => { { editor.update(() => {}); } });',
        expectedCount: 1,
        ruleName: 'no-nested-editor-updates',
      },
      {
        code: 'const editor = createEditor(); editor.update(() => { const editor = createEditor(); editor.update(() => {}); });',
        expectedCount: 0,
        ruleName: 'no-nested-editor-updates',
      },
      {
        code: 'editor.update(() => { const editor = createEditor(); editor.update(() => {}); });',
        expectedCount: 0,
        ruleName: 'no-nested-editor-updates',
      },
      {
        code: 'const editor = createEditor(); editor.update(() => { { const editor = createEditor(); editor.update(() => {}); } });',
        expectedCount: 0,
        ruleName: 'no-nested-editor-updates',
      },
    ] as const)(
      '$ruleName preserves diagnostics with an ESLint 8 context',
      ({code, expectedCount, ruleName}) => {
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
                      const sourceCode = hasGetScope
                        ? context.sourceCode
                        : Object.create(context.sourceCode, {
                            getScope: {value: undefined},
                          });
                      return rule.create(
                        legacyContext
                          ? Object.create(context, {
                              getSourceCode: {value: () => sourceCode},
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
        expect(messages).toHaveLength(expectedCount);
        for (const message of messages) {
          expect(message.ruleId).toBe(`@lexical/${ruleName}`);
        }
        // Include fix and suggestion payloads in the compatibility check.
        expect(verify(true)).toEqual(messages);
      },
    );
  },
);
