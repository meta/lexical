/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {RuleTester} from 'eslint';
import {describe, expect, it} from 'vitest';

import plugin from '../../index.js';
import rule from '../../rules/no-pure-annotation.js';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

describe('no-pure-annotation', () => {
  it('is exported by the plugin with a fixer', () => {
    expect(plugin.rules['no-pure-annotation']).toBe(rule);
    expect(rule.meta!.fixable).toBe('code');
  });

  it('passes RuleTester', () => {
    const IMPORT = `import {defineExtension, safeCast} from 'lexical';`;
    ruleTester.run('no-pure-annotation', rule, {
      invalid: [
        {
          code: `${IMPORT}\nexport const E = /* @__PURE__ */ defineExtension({name: 'e'});`,
          errors: [{messageId: 'unnecessaryPureAnnotation'}],
          output: `${IMPORT}\nexport const E = defineExtension({name: 'e'});`,
        },
        {
          // Terser's # sigil is the same annotation.
          code: `import {createCommand} from 'lexical';\nexport const C = /* #__PURE__ */ createCommand('C');`,
          errors: [{messageId: 'unnecessaryPureAnnotation'}],
          output: `import {createCommand} from 'lexical';\nexport const C = createCommand('C');`,
        },
        {
          // Prettier moves a long one onto its own line; the fix takes the
          // line break with it.
          code: `${IMPORT}\nexport const E =\n  /* @__PURE__ */\n  defineExtension({name: 'e'});`,
          errors: [{messageId: 'unnecessaryPureAnnotation'}],
          output: `${IMPORT}\nexport const E =\n  defineExtension({name: 'e'});`,
        },
        {
          // Nested argument-position calls were annotated too.
          code: `${IMPORT}\nexport const E = /* @__PURE__ */ defineExtension({config: /* @__PURE__ */ safeCast({a: 1}), name: 'e'});`,
          errors: [
            {messageId: 'unnecessaryPureAnnotation'},
            {messageId: 'unnecessaryPureAnnotation'},
          ],
          output: `${IMPORT}\nexport const E = defineExtension({config: safeCast({a: 1}), name: 'e'});`,
        },
        {
          // An aliased import is the same factory.
          code: `import {defineExtension as define} from '@lexical/extension';\nexport const E = /* @__PURE__ */ define({name: 'e'});`,
          errors: [{messageId: 'unnecessaryPureAnnotation'}],
          output: `import {defineExtension as define} from '@lexical/extension';\nexport const E = define({name: 'e'});`,
        },
        {
          // A factory declared in this module as side-effect free, which is
          // how the factory modules themselves are written.
          code: `/**\n * @__NO_SIDE_EFFECTS__\n */\nexport function createCommand(type) {\n  return {type};\n}\nexport const C = /* @__PURE__ */ createCommand('C');`,
          errors: [{messageId: 'unnecessaryPureAnnotation'}],
          output: `/**\n * @__NO_SIDE_EFFECTS__\n */\nexport function createCommand(type) {\n  return {type};\n}\nexport const C = createCommand('C');`,
        },
        {
          // Custom function list replaces the default.
          code: `import {myFactory} from 'lexical';\nconst x = /* @__PURE__ */ myFactory();`,
          errors: [{messageId: 'unnecessaryPureAnnotation'}],
          options: [{functions: ['myFactory']}],
          output: `import {myFactory} from 'lexical';\nconst x = myFactory();`,
        },
      ],
      valid: [
        {
          // What the sources should look like.
          code: `${IMPORT}\nexport const E = defineExtension({name: 'e'});`,
        },
        {
          // Somebody else's same-named helper: the build will not annotate
          // this call, so its annotation is load-bearing and not ours to
          // remove. This is the reason the rule resolves the binding rather
          // than matching on the name.
          code: `import {safeCast} from './my-utils';\nexport const config = /* @__PURE__ */ safeCast({a: 1});`,
        },
        {
          // Not one of the factories the build annotates.
          code: `const rule = {match: /* @__PURE__ */ sel.tag('o:p')};\nexport default rule;`,
        },
        {
          // Deferred calls are never annotated by the build, so an
          // annotation there was deliberate too.
          code: `${IMPORT}\nexport function make() { return /* @__PURE__ */ defineExtension({name: 'e'}); }`,
        },
        {
          // A comment that is not the annotation.
          code: `${IMPORT}\nexport const E = /* the extension */ defineExtension({name: 'e'});`,
        },
        {
          // Custom function list replaces the default.
          code: `${IMPORT}\nexport const E = /* @__PURE__ */ defineExtension({name: 'n'});`,
          options: [{functions: ['myFactory']}],
        },
      ],
    });
  });
});
