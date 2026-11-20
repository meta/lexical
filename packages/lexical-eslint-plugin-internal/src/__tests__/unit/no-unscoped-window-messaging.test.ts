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
import rule from '../../rules/no-unscoped-window-messaging.js';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

// TypeScript-only syntax (`as const`, `satisfies`) needs the TS parser; the
// rule runs on .ts sources in the repo, so these forms reach it in practice.
const tsRuleTester = new RuleTester({
  languageOptions: {
    parser: /** @type {any} */ tseslint.parser,
    parserOptions: {ecmaVersion: 2022, sourceType: 'module'},
  },
});

const IMPORT = `import {initPegasusTransport} from '@webext-pegasus/transport/window';`;

describe('no-unscoped-window-messaging', () => {
  it('is exported by the plugin', () => {
    expect(plugin.rules['no-unscoped-window-messaging']).toBe(rule);
  });

  it('is not enabled by the shared configs', () => {
    // It is about one messaging API in one package, so eslint.config.mjs
    // scopes it rather than the plugin turning it on everywhere.
    const configs = [
      plugin.configs.all,
      plugin.configs.recommended,
      plugin.configs['flat/all'],
    ];
    for (const config of configs) {
      expect(
        config.rules['@lexical/internal/no-unscoped-window-messaging'],
      ).toBeUndefined();
    }
  });

  it('passes RuleTester', () => {
    ruleTester.run('no-unscoped-window-messaging', rule, {
      invalid: [
        {
          code: `${IMPORT}\ninitPegasusTransport({namespace: 'my-extension'});`,
          errors: [{messageId: 'staticMessagingNamespace'}],
        },
        {
          code: `${IMPORT}\ninitPegasusTransport({allowWindowMessagingForNamespace: 'my-extension'});`,
          errors: [{messageId: 'staticMessagingNamespace'}],
        },
        {
          // A template literal with no substitutions is still a constant.
          code: `${IMPORT}\ninitPegasusTransport({namespace: \`my-extension\`});`,
          errors: [{messageId: 'staticMessagingNamespace'}],
        },
        {
          // ...and so is one built only from constants.
          code: `${IMPORT}\nconst PREFIX = 'my';\ninitPegasusTransport({namespace: \`\${PREFIX}-extension\`});`,
          errors: [{messageId: 'staticMessagingNamespace'}],
        },
        {
          code: `${IMPORT}\ninitPegasusTransport({namespace: 'my' + '-extension'});`,
          errors: [{messageId: 'staticMessagingNamespace'}],
        },
        {
          // A local const only moves the constant somewhere else.
          code: `${IMPORT}\nconst NAME = 'my-extension';\ninitPegasusTransport({namespace: NAME});`,
          errors: [{messageId: 'staticMessagingNamespace'}],
        },
        {
          // Aliasing the import does not change what is being called.
          code: `import {initPegasusTransport as init} from '@webext-pegasus/transport/window';\ninit({namespace: 'my-extension'});`,
          errors: [{messageId: 'staticMessagingNamespace'}],
        },
        {
          // Neither does reaching it through a namespace import.
          code: `import * as transport from '@webext-pegasus/transport/window';\ntransport.initPegasusTransport({namespace: 'my-extension'});`,
          errors: [{messageId: 'staticMessagingNamespace'}],
        },
        {
          // A parameter of the same name must not hide the module binding
          // the initializer actually resolves to.
          code: `${IMPORT}\nconst NAME = 'my-extension';\nfunction start(other) { initPegasusTransport({namespace: NAME}); }`,
          errors: [{messageId: 'staticMessagingNamespace'}],
        },
        {
          code: `${IMPORT}\nimport {EXTENSION_NAME} from './constants';\ninitPegasusTransport({namespace: EXTENSION_NAME});`,
          errors: [{messageId: 'importedMessagingNamespace'}],
        },
        {
          code: `window.postMessage(payload, '*');`,
          errors: [{messageId: 'wildcardTargetOrigin'}],
        },
        {
          code: `frame.contentWindow.postMessage(payload, '*', [port]);`,
          errors: [{messageId: 'wildcardTargetOrigin'}],
        },
        {
          code: `window.postMessage(payload, \`*\`);`,
          errors: [{messageId: 'wildcardTargetOrigin'}],
        },
        {
          code: `const ANY = '*';\nwindow.postMessage(payload, ANY);`,
          errors: [{messageId: 'wildcardTargetOrigin'}],
        },
        {
          code: `send({data, targetOrigin: '*'});`,
          errors: [{messageId: 'wildcardTargetOrigin'}],
        },
      ],
      valid: [
        {
          // Derived per page load, which is the point.
          code: `${IMPORT}\nconst namespace = crypto.randomUUID();\ninitPegasusTransport({namespace});`,
        },
        {
          code: `${IMPORT}\ninitPegasusTransport({namespace: readNamespaceFromScriptTag()});`,
        },
        {
          code: `${IMPORT}\nfunction start(namespace) { initPegasusTransport({namespace}); }`,
        },
        {
          // A `let` initialized with a constant and reassigned is not fixed.
          code: `${IMPORT}\nlet ns = 'placeholder';\nns = crypto.randomUUID();\ninitPegasusTransport({namespace: ns});`,
        },
        {
          // A parameter shadowing a module constant is the parameter.
          code: `${IMPORT}\nconst NAME = 'my-extension';\nfunction start(NAME) { initPegasusTransport({namespace: NAME}); }`,
        },
        {
          // Same name, different function: not the transport initializer.
          code: `function initPegasusTransport(options) {}\ninitPegasusTransport({namespace: 'my-extension'});`,
        },
        {
          // An initializer imported from somewhere else entirely.
          code: `import {initPegasusTransport} from './local-helper';\ninitPegasusTransport({namespace: 'my-extension'});`,
        },
        {
          // No options at all: these contexts open no page-facing channel.
          code: `${IMPORT}\ninitPegasusTransport();`,
        },
        {
          // Unrelated options are not the rule's business.
          code: `${IMPORT}\ninitPegasusTransport({retries: 3});`,
        },
        {
          code: `window.postMessage(payload, 'https://example.com');`,
        },
        {
          code: `window.postMessage(payload, origin);`,
        },
        {
          // Not a targetOrigin, just a value that happens to be '*'.
          code: `matchAll({pattern: '*'});`,
        },
      ],
    });
  });

  it('sees through TypeScript assertions', () => {
    tsRuleTester.run('no-unscoped-window-messaging', rule, {
      invalid: [
        {
          code: `${IMPORT}\ninitPegasusTransport({namespace: 'my-extension' as const});`,
          errors: [{messageId: 'staticMessagingNamespace'}],
        },
        {
          code: `${IMPORT}\ninitPegasusTransport({namespace: 'my-extension' satisfies string});`,
          errors: [{messageId: 'staticMessagingNamespace'}],
        },
        {
          code: `${IMPORT}\nimport {EXTENSION_NAME} from './constants';\ninitPegasusTransport({namespace: EXTENSION_NAME as string});`,
          errors: [{messageId: 'importedMessagingNamespace'}],
        },
        {
          code: `window.postMessage(payload, '*' as const);`,
          errors: [{messageId: 'wildcardTargetOrigin'}],
        },
      ],
      valid: [
        {
          code: `${IMPORT}\ninitPegasusTransport({namespace: crypto.randomUUID() as string});`,
        },
      ],
    });
  });
});
