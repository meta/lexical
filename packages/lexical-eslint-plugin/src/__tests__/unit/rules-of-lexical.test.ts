/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {RulesOfLexicalOptions} from '../../rules/rules-of-lexical.js';

import prettier from '@prettier/sync';
import {RuleTester} from 'eslint';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

import plugin from '../../LexicalEslintPlugin.js';

// The given string which may be prefixed or underscored later
const NAME = (name: string) => name;
// This name is always prefixed, never underscored, to create scope conflicts on naive rename
const NAME_PREFIXED = (name: string) =>
  name.replace(/^\$?/, '$').replace(/_$/, '');
// Ensure an underscore if the given name is prefixed
const NAME_UNDERSCORE = (name: string) =>
  !/^\$/.test(name) || /_$/.test(name) ? name : name + '_';
const REEXPORT = (name: string) =>
  /^\$/.test(name)
    ? `\n/** @deprecated renamed to {@link ${name}} by @lexical/eslint-plugin rules-of-lexical */\nexport const ${name.replace(
        /^\$/,
        '',
      )} = ${name};\n`
    : '';

function fmt(
  strings: TemplateStringsArray,
  ...keys: ((name: string) => string)[]
) {
  const rval = (name: string) => {
    const result = [strings[0]];
    keys.forEach((key, i) => {
      result.push(key(name), strings[i + 1]);
    });
    return prettier.format(result.join(''), {parser: 'typescript'});
  };
  rval.keys = keys;
  rval.setOptions = (opts: RulesOfLexicalOptions) => {
    rval.options[0] = opts;
    return rval;
  };
  rval.options = [{}] as [RulesOfLexicalOptions];
  return rval;
}

/**
 * Run through the project's README.md to make sure the docs examples are correct!
 */
function readDocumentedRules() {
  const contents = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'README.md'),
    'utf-8',
  );
  const sections =
    /\n### Valid Examples\n([\s\S]+?)### Invalid Examples\n([\s\S]+?)(?:\n#{1,3}[\s\n]|$)/.exec(
      contents,
    );
  if (!sections) {
    throw new Error('Missing `### Valid Examples` in README.md');
  }
  const valid: RuleTester.ValidTestCase[] = Array.from(
    sections[1].matchAll(/```(?:js|ts|javascript|typescript)\n([\s\S]+?)```/g),
    ([, code]) => ({code}),
  );
  const invalid: RuleTester.InvalidTestCase[] = Array.from(
    sections[2].matchAll(
      /\n#### (.*?)\n(?:[\s\S]+?)```(?:js|ts|javascript|typescript)\n([\s\S]+?)```(?:[\s\S]+?)```(?:js|ts|javascript|typescript)\n([\s\S]+?)```/g,
    ),
    ([, _name, code, output]) => ({
      code,
      errors: [
        {
          messageId: 'rulesOfLexicalReport',
          suggestions: [
            {
              messageId: 'rulesOfLexicalSuggestion',
              output,
            },
          ],
        },
      ],
      output,
    }),
  );
  return {invalid, valid};
}

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2018,
    parserOptions: {
      ecmaFeatures: {jsx: true},
    },
    sourceType: 'module',
  },
});

describe('LexicalEslintPlugin', () => {
  it('exports a plugin with meta and rules', () => {
    expect(Object.keys(plugin).sort()).toEqual(
      expect.arrayContaining(['meta', 'rules']),
    );
  });
});
(['rules-of-lexical'] as const).forEach(ruleName => {
  const namedRules = [
    fmt`const ${NAME} = () => $getRoot();`,
    fmt`const ${NAME} = () => { return $getRoot(); }`,
    fmt`function ${NAME}() { return $getRoot(); }`,
    fmt`export default function ${NAME}() { return $getRoot(); }`,
    fmt`
    function ${NAME}() { return $getRoot(); }
    export default function caller(editor) { return editor.getState().read(() => ${NAME}()); }`,
    fmt`
    function render() {
      const ${NAME} = () => { return $getRoot(); }
      return editor.getState().read(() => ${NAME}());
    }
    `,
    fmt`
    function render() {
      const ${NAME} = useCallback(() => { return $getRoot(); }, []);
      return editor.getState().read(() => ${NAME}());
    }
    `,
    fmt`
    const ${NAME} = (node) => {
      if ($isMarkNode(node)) {
        $unwrapMarkNode(node);
        return;
      }
      if ($isElementNode(node)) {
        const children = node.getChildren();
        for (const child of children) {
          ${NAME}(child);
        }
      }
    };
    `,
    fmt`
    import {${NAME_PREFIXED}} from '../../nodes/KeywordNode';
    export default function KeywordsPlugin() {
      const ${NAME_UNDERSCORE} = useCallback((textNode) => {
        return ${NAME_PREFIXED}(textNode.getTextContent());
      }, []);
    }
    `,
    fmt`
    export function ${NAME}() {
      $getRoot();
    }${REEXPORT}
    `,
    fmt`
    export const ${NAME} = () => $getRoot();${REEXPORT}
    `,
    fmt`
    import {${NAME_PREFIXED}, $createTextNode} from 'lexical';
    function $test() {
      return ${NAME_UNDERSCORE}(text);
    }
    const ${NAME_UNDERSCORE} = (text) => {
      const node = ${NAME_PREFIXED}();
      node.append($createTextNode(text));
    };
    `,
  ];
  describe(ruleName, () => {
    const documentedRules = readDocumentedRules();
    it('has valid documented rules', () => {
      expect(documentedRules.valid).not.toEqual([]);
    });
    it('has invalid documented rules', () => {
      expect(documentedRules.invalid).not.toEqual([]);
    });
    const rule = plugin.rules[ruleName];
    ruleTester.run(ruleName, rule, {
      invalid: [
        ...documentedRules.invalid,
        ...namedRules.map((codegen, i): RuleTester.InvalidTestCase => {
          const caller = `func${i}`;
          const suggestName =
            `$${caller}` + (codegen.keys.includes(NAME_UNDERSCORE) ? '_' : '');
          return {
            code: codegen(caller),
            errors: [
              {
                messageId: 'rulesOfLexicalReport',
                suggestions: [
                  {
                    data: {
                      callee: '$getRoot',
                      caller,
                      suggestName,
                    },
                    messageId: 'rulesOfLexicalSuggestion',
                    output: codegen(suggestName),
                  },
                ],
              },
            ],
            options: codegen.options,
            output: codegen(suggestName),
          };
        }),
      ],
      valid: [
        ...documentedRules.valid,
        ...[
          // this is used in tests
          fmt`async function testCase() { await update(() => { $getRoot() }) }`,
          // accepted by .update
          fmt`editor.update(() => $getRoot());`,
          // Accepted by .read
          fmt`editor.getEditorState().read(() => $getRoot());`,
          // accepted by being in a class definition
          fmt`
        class Foo extends TextNode {
          mutator() {
            $getRoot();
          }
        }`,
          fmt`
        export function $isSelectionCapturedInDecorator(node) {
          return $isDecoratorNode($getNearestNodeFromDOMNode(node));
        }
        `,
          fmt`new Option({ onSelect: (_node) => $getRoot() })`,
          fmt`new Option({ onSelect: function (_node) { $getRoot() } })`,
          fmt`new Option({ onSelect: function onSelect(_node) { $getRoot() } })`,
          fmt`new Option({ onSelect(_node) { $getRoot() } })`,
          fmt`export function INTERNAL_$function() { return $getRoot() }`.setOptions(
            {isDollarFunction: '^INTERNAL_\\$'},
          ),
          fmt`export function INTERNAL_function() { return $getRoot() }`.setOptions(
            {isIgnoredFunction: '^INTERNAL_'},
          ),
          ...namedRules,
        ].map((codegen, i) => ({
          code: codegen(`$func${i}`),
          options: codegen.options,
        })),
      ],
    });
  });
});
