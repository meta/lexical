/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {RuleTester} from 'eslint';
import {describe, expect, it} from 'vitest';

import plugin from '../../LexicalEslintPlugin.js';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

describe('y-collab-status', () => {
  const rule = plugin.rules['y-collab-status'];

  it('is in the recommended config, as an error', () => {
    expect(plugin.configs.recommended.rules['@lexical/y-collab-status']).toBe(
      'error',
    );
  });

  it('reports a primary config without onYStatus, and suggests null', () => {
    ruleTester.run('y-collab-status', rule, {
      invalid: [
        {
          code: `configExtension(YCollabExtension, {doc, schemaVersion: 1, synced: true});`,
          errors: [
            {
              messageId: 'missingOnYStatus',
              suggestions: [
                {
                  messageId: 'addNull',
                  output: `configExtension(YCollabExtension, {doc, schemaVersion: 1, synced: true, onYStatus: null});`,
                },
              ],
            },
          ],
        },
        {
          code: `const x = lexical.configExtension(y.YCollabExtension, {'doc': d, schemaVersion: 2});`,
          errors: [
            {
              messageId: 'missingOnYStatus',
              suggestions: [
                {
                  messageId: 'addNull',
                  output: `const x = lexical.configExtension(y.YCollabExtension, {'doc': d, schemaVersion: 2, onYStatus: null});`,
                },
              ],
            },
          ],
        },
      ],
      valid: [
        // A handler, or null.
        `configExtension(YCollabExtension, {doc, onYStatus: show, schemaVersion: 1});`,
        `configExtension(YCollabExtension, {doc, onYStatus: null, schemaVersion: 1});`,
        // An override of a yCollab(...) or createYCollabConfig(...) dependency.
        `configExtension(YCollabExtension, {captureTimeout: null});`,
        // What a spread or a computed key holds is not known here.
        `configExtension(YCollabExtension, {...base, doc});`,
        `configExtension(YCollabExtension, {[key]: value, doc});`,
        // A config that is not an object literal: the type is checked.
        `configExtension(YCollabExtension, createYCollabConfig(input));`,
        // Another extension.
        `configExtension(OtherExtension, {doc});`,
      ],
    });
  });
});
