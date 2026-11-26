/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {RuleTester} from 'eslint';
import tseslint from 'typescript-eslint';
import {describe, expect, it} from 'vitest';

import plugin from '../../index.js';
import rule from '../../rules/no-constant-node-type-comparison.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {ecmaVersion: 2022, sourceType: 'module'},
  },
});

const comparison = [{messageId: 'comparison'}];

describe('no-constant-node-type-comparison', () => {
  it('is exported by the plugin', () => {
    expect(plugin.rules['no-constant-node-type-comparison']).toBe(rule);
  });

  it('is not enabled by the shared configs', () => {
    // Tests may compare types, so eslint.config.mjs scopes it.
    for (const config of Object.values(plugin.configs)) {
      expect(
        config.rules['@lexical/internal/no-constant-node-type-comparison'],
      ).toBeUndefined();
    }
  });

  it('checks JavaScript parsed by espree', () => {
    new RuleTester().run('no-constant-node-type-comparison', rule, {
      invalid: [{code: `node.getType() === 'code';`, errors: comparison}],
      valid: [`node.getType() === 'root';`],
    });
  });

  it('passes RuleTester', () => {
    ruleTester.run('no-constant-node-type-comparison', rule, {
      invalid: [
        {code: `node.getType() === 'code';`, errors: comparison},
        {code: `'code' !== node.getType();`, errors: comparison},
        {code: `node?.getType() == \`code\`;`, errors: comparison},
        {code: `node.getType() != 'code';`, errors: comparison},
        {code: `node.getType() === CodeNode.getType();`, errors: comparison},
      ],
      valid: [
        // The root cannot be subclassed or replaced
        `node.getType() !== 'root';`,
        `node.getType() === RootNode.getType();`,
        // Types compared with each other or a runtime value
        `prev.getType() === next.getType();`,
        `serialized.type !== klass.getType();`,
        `node.getType() === expected;`,
        // A class's own type is not a node's
        `CodeNode.getType() === 'code';`,
        // Only getType() calls in equality comparisons are checked
        `node.__type === 'code';`,
        `switch (node.getType()) {\n  case 'code':\n}`,
        `['code'].includes(node.getType());`,
      ],
    });
  });
});
