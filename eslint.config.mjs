/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {fixupPluginRules} from '@eslint/compat';
import js from '@eslint/js';
import lexicalInternalPlugin from '@lexical/eslint-plugin-internal';
import prettierConfig from 'eslint-config-prettier';
import compat from 'eslint-plugin-compat';
import _headerPlugin from 'eslint-plugin-header';
import importXPlugin from 'eslint-plugin-import-x';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import _noFunctionDeclareAfterReturn from 'eslint-plugin-no-function-declare-after-return';
import noOnlyTests from 'eslint-plugin-no-only-tests';
import _reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import _sortKeysFix from 'eslint-plugin-sort-keys-fix';
import globals from 'globals';
import {createRequire} from 'module';
import tseslint from 'typescript-eslint';

// Direct file path imports for local CJS packages (bypasses package.json exports map)
import lexicalPlugin from './packages/lexical-eslint-plugin/src/LexicalEslintPlugin.js';

const require = createRequire(import.meta.url);
const restrictedGlobals = require('confusing-browser-globals');

// Wrap legacy plugins that use removed ESLint APIs (context.getScope, etc.)
const reactPlugin = fixupPluginRules(_reactPlugin);
const sortKeysFix = fixupPluginRules(_sortKeysFix);
const noFunctionDeclareAfterReturn = fixupPluginRules(
  _noFunctionDeclareAfterReturn,
);

// eslint-plugin-header doesn't define meta.schema (required by ESLint 10
// when rule options are provided) and uses removed context.getSourceCode().
const headerPlugin = fixupPluginRules({
  rules: Object.fromEntries(
    Object.entries(_headerPlugin.rules).map(([name, rule]) => [
      name,
      {
        ...rule,
        meta: {
          ...rule.meta,
          schema: [{type: 'string'}, {type: 'string'}],
        },
      },
    ]),
  ),
});

const OFF = 0;
const WARN = 1;
const ERROR = 2;

export default [
  // Global ignores (replaces .eslintignore)
  {
    ignores: [
      '**/dist/',
      '**/flow-typed/',
      '**/build/',
      'packages/**/npm/',
      '**/__tests__/integration/fixtures/',
      'packages/lexical-website/static/dev-examples/',
      '**/dist-size/',
      '**/*.js.flow',
      '**/*.d.ts',
      '**/playwright*/',
      '**/node_modules/',
      '.ts-temp/',
      '**/.docusaurus/',
      // Build output that only the package's own .gitignore names, which
      // ESLint does not read: next build writes .next/, wxt writes .output/.
      // Linting a bundle is meaningless and the rules that walk its AST can
      // fail outright on generated code.
      '**/.next/',
      '**/.output/',
      'playwright-report/',
      'test-results/',
      'examples/*svelte*/',
      'libdefs/',
      '**/.wxt/',
      '**/*.www.cjs',
      '**/typedoc-sidebar.cjs',
      '**/.next/',
    ],
  },

  // Base: eslint recommended
  js.configs.recommended,

  // Internal Lexical plugin (flat config)
  lexicalInternalPlugin.configs['flat/all'],

  // Base configuration for all files
  {
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.jest,
        ...globals.jasmine,
        JSX: true,
        __DEV__: true,
      },
      sourceType: 'script',
    },

    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },

    plugins: {
      header: headerPlugin,
      'import-x': importXPlugin,
      'jsx-a11y': fixupPluginRules(jsxA11yPlugin),
      'no-function-declare-after-return': noFunctionDeclareAfterReturn,
      'no-only-tests': noOnlyTests,
      react: reactPlugin,
      'simple-import-sort': simpleImportSort,
      'sort-keys-fix': sortKeysFix,
    },

    rules: {
      '@lexical/internal/no-imports-from-self': ERROR,
      'accessor-pairs': OFF,
      'consistent-return': OFF,
      curly: [ERROR, 'all'],
      'dot-location': [ERROR, 'property'],
      'dot-notation': [ERROR, {allowPattern: '^(error|warn)$'}],
      'eol-last': ERROR,
      eqeqeq: [ERROR, 'allow-null'],
      'header/header': [2, 'scripts/www/headerTemplate.js'],
      'import-x/first': ERROR,
      'import-x/newline-after-import': ERROR,
      'import-x/no-duplicates': ERROR,
      indent: OFF,
      'jsx-a11y/aria-props': WARN,
      'jsx-a11y/aria-role': WARN,
      'jsx-a11y/interactive-supports-focus': [
        WARN,
        {
          tabbable: [
            'button',
            'checkbox',
            'link',
            'searchbox',
            'spinbutton',
            'switch',
            'textbox',
          ],
        },
      ],
      'jsx-a11y/no-interactive-element-to-noninteractive-role': [
        WARN,
        {tr: ['none', 'presentation']},
      ],
      'jsx-a11y/no-noninteractive-element-interactions': [
        WARN,
        {handlers: ['onClick']},
      ],
      'jsx-a11y/no-noninteractive-element-to-interactive-role': [
        WARN,
        {
          li: ['menuitem', 'option', 'row', 'tab', 'treeitem'],
          ol: [
            'listbox',
            'menu',
            'menubar',
            'radiogroup',
            'tablist',
            'tree',
            'treegrid',
          ],
          table: ['grid'],
          td: ['gridcell'],
          ul: [
            'listbox',
            'menu',
            'menubar',
            'radiogroup',
            'tablist',
            'tree',
            'treegrid',
          ],
        },
      ],
      'jsx-a11y/no-noninteractive-tabindex': WARN,
      'jsx-a11y/no-static-element-interactions': [
        WARN,
        {handlers: ['onClick']},
      ],
      'jsx-a11y/role-has-required-aria-props': WARN,
      'jsx-a11y/role-supports-aria-props': WARN,
      'jsx-a11y/tabindex-no-positive': WARN,
      'jsx-quotes': [ERROR, 'prefer-double'],
      'keyword-spacing': [ERROR, {after: true, before: true}],
      'max-len': OFF,
      'no-array-constructor': ERROR,
      'no-bitwise': OFF,
      'no-caller': ERROR,
      'no-console': [ERROR, {allow: ['warn', 'error', 'time', 'timeEnd']}],
      'no-debugger': ERROR,
      'no-eval': ERROR,
      'no-extend-native': WARN,
      'no-extra-bind': WARN,
      'no-function-declare-after-return/no-function-declare-after-return':
        ERROR,
      'no-implied-eval': ERROR,
      'no-inner-declarations': [ERROR, 'functions'],
      'no-label-var': WARN,
      'no-labels': [ERROR, {allowLoop: true, allowSwitch: true}],
      'no-lone-blocks': WARN,
      'no-multi-spaces': ERROR,
      'no-multi-str': ERROR,
      'no-new': WARN,
      'no-new-func': ERROR,
      'no-new-object': WARN,
      'no-new-wrappers': WARN,
      'no-octal-escape': WARN,
      'no-only-tests/no-only-tests': ERROR,
      'no-proto': ERROR,
      'no-restricted-globals': [ERROR].concat(restrictedGlobals),
      'no-restricted-syntax': [ERROR, 'WithStatement'],
      'no-script-url': ERROR,
      'no-self-compare': WARN,
      'no-sequences': WARN,
      'no-shadow': ERROR,
      'no-throw-literal': ERROR,
      'no-unneeded-ternary': WARN,
      'no-unused-expressions': ERROR,
      'no-unused-vars': [
        WARN,
        {
          args: 'none',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'no-use-before-define': OFF,
      'no-useless-assignment': OFF,
      'no-useless-call': WARN,
      'no-useless-computed-key': OFF,
      'no-useless-concat': OFF,
      'no-var': ERROR,
      'one-var': [WARN, {initialized: 'never'}],
      'operator-assignment': [WARN, 'always'],
      'preserve-caught-error': OFF,
      quotes: [
        ERROR,
        'single',
        {allowTemplateLiterals: true, avoidEscape: true},
      ],
      radix: WARN,
      'react/jsx-boolean-value': [ERROR, 'always'],
      'react/jsx-key': ERROR,
      'react/jsx-no-undef': ERROR,
      'react/jsx-sort-prop-types': OFF,
      'react/jsx-tag-spacing': ERROR,
      'react/jsx-uses-react': OFF,
      'react/jsx-wrap-multilines': [
        ERROR,
        {assignment: false, declaration: false},
      ],
      'react/no-is-mounted': OFF,
      'react/react-in-jsx-scope': OFF,
      'react/self-closing-comp': ERROR,
      'simple-import-sort/exports': ERROR,
      'simple-import-sort/imports': [
        ERROR,
        {
          groups: [['^.*\\u0000$'], ['^\\u0000'], ['^@?\\w'], ['^'], ['^\\.']],
        },
      ],
      'sort-keys-fix/sort-keys-fix': ERROR,
      'space-before-blocks': ERROR,
      'space-before-function-paren': OFF,
      strict: [ERROR, 'global'],
      'valid-typeof': [ERROR, {requireStringLiterals: true}],
    },
  },

  // React hooks recommended
  {
    plugins: {
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
      // react-hooks/refs has too many false positives (in ^7.0.1)
      'react-hooks/refs': OFF,
    },
  },

  // Override: Package source files (module sourceType)
  {
    files: [
      'packages/*/src/**/*.js',
      'packages/*/__tests__/**/*.?(m)js',
      'packages/*/src/**/*.jsx',
    ],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {jsx: true},
      },
      sourceType: 'module',
    },
    rules: {
      'no-var': ERROR,
      'prefer-const': ERROR,
      strict: OFF,
    },
  },

  // Override: Scripts (no header required, allow console)
  {
    files: ['scripts/**/*.js', 'scripts/**/*.mjs'],
    rules: {
      'header/header': OFF,
      'no-console': OFF,
    },
  },

  // Override: TypeScript files
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
  })),
  lexicalPlugin.configs['flat/all'],
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parser: tseslint.parser,
      parserOptions: {
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      header: headerPlugin,
      react: reactPlugin,
    },
    rules: {
      '@lexical/rules-of-lexical': [
        WARN,
        /** @type {import('./packages/lexical-eslint-plugin/src').RulesOfLexicalOptions} */ ({
          isDollarFunction: ['^INTERNAL_\\$'],
          isIgnoredFunction: [
            // @lexical/yjs
            'createBinding',
          ],
          isLexicalProvider: ['updateEditor', 'updateEditorSync'],
          isSafeDollarFunction: ['$createRootNode', '$createCollabElementNode'],
        }),
      ],
      '@typescript-eslint/array-type': [ERROR, {default: 'array'}],
      '@typescript-eslint/ban-ts-comment': OFF,
      // The build compiles with @babel/preset-typescript, which only elides an
      // import when it is explicitly type-only. Enforce `import type` so that
      // type-only imports never emit a runtime dependency. `separate-type-imports`
      // keeps pure type imports as `import type {X}` (fully elided); mixed
      // imports keep the value import and inline `type` on the type specifiers.
      '@typescript-eslint/consistent-type-imports': [
        ERROR,
        {disallowTypeAnnotations: false, fixStyle: 'separate-type-imports'},
      ],
      '@typescript-eslint/no-this-alias': OFF,
      '@typescript-eslint/no-unused-vars': [
        ERROR,
        {
          args: 'none',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'header/header': [2, 'scripts/www/headerTemplate.js'],
      // Ensure no-shadow fires in TS files the same as in the old config
      'no-shadow': [
        ERROR,
        {
          ignoreFunctionTypeParameterNameValueShadow: false,
          ignoreTypeValueShadow: false,
        },
      ],
      // Disable base rule in favor of @typescript-eslint version
      'no-unused-vars': OFF,
    },
  },

  // Override: ESM files (.mjs) - 'use strict' is not relevant to ESM
  {
    files: ['**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
    },
    rules: {
      strict: OFF,
    },
  },

  // Override: Tests - allow optional chaining
  {
    files: [
      'scripts/__tests__/**',
      'packages/**/src/__tests__/**',
      'packages/lexical-playground/**',
      'packages/lexical-devtools/**',
    ],
    rules: {
      '@lexical/internal/no-optional-chaining': OFF,
    },
  },

  // Override: Library sources — ban direct `document.X` and `window.X` member
  // access so editors inside Shadow DOM or cross-frame iframes use the correct
  // realm. Uses `no-restricted-syntax` with MemberExpression selectors so that
  // `typeof window/document` (SSR guards) and helper definitions in
  // LexicalUtils.ts that use parameters (not globals) are exempt automatically.
  // See AGENTS.md "Shadow DOM and iframe realm safety" for the full pattern table.
  {
    files: ['packages/**/src/**'],
    ignores: [
      'packages/**/__tests__/**',
      'packages/**/__bench__/**',
      'packages/lexical-playground/**',
      'packages/lexical-devtools/**',
      'packages/lexical-website/**',
    ],
    rules: {
      '@lexical/no-document-in-dom-methods': ERROR,
      'no-restricted-syntax': [
        ERROR,
        'WithStatement',
        {
          message:
            'Use $getDocument(), ownerDocument, or getRootOwnerDocument() instead of document.* for Shadow DOM / iframe safety. See AGENTS.md.',
          selector: 'MemberExpression[object.name="document"]',
        },
        {
          message:
            'Use getDefaultView() or getWindow() instead of window.* for Shadow DOM / iframe safety. See AGENTS.md.',
          selector: 'MemberExpression[object.name="window"]',
        },
      ],
    },
  },

  // Override: the /* @__PURE__ */ annotations on module-scope calls to the
  // side-effect-free lexical factories are injected at build time by
  // @lexical/compiler, so they do not belong in the sources. The
  // rule is autofixable, which is how a branch written before the transform
  // existed migrates: `pnpm run lint:fix`. Annotations on anything else
  // (a third-party factory, a call inside a function body) are untouched.
  {
    files: ['packages/**', 'examples/**', 'dev-examples/**'],
    ignores: ['packages/lexical-compiler/**'],
    rules: {
      '@lexical/internal/no-pure-annotation': ERROR,
    },
  },

  // Override: Tests - allow imports from self
  {
    files: ['packages/**/__tests__/**'],
    rules: {
      '@lexical/internal/no-imports-from-self': OFF,
    },
  },

  // Override: Tests - disable react-hooks rules that flag patterns we
  // intentionally use in tests (reassigning module-scoped variables and
  // mutating captured objects from inside test components/hooks).
  {
    files: ['packages/**/__tests__/**', 'scripts/__tests__/**'],
    rules: {
      'react-hooks/globals': OFF,
      'react-hooks/immutability': OFF,
    },
  },

  // Override: Playwright e2e tests - flag unawaited promise-returning
  // Playwright calls. An un-awaited `page.setViewportSize(...)` (or any
  // method with `pause: true` metainfo) under `--debug` leaves
  // `Debugger._pausedCall` set indefinitely, causing every subsequent
  // `page.pause()` to bail at the "already paused" early-return.
  {
    files: ['packages/lexical-playground/__tests__/**/*.?(m)js'],
    rules: {
      'no-restricted-syntax': [
        ERROR,
        'WithStatement',
        {
          message:
            'Promise-returning Playwright call must be awaited (or returned). Unawaited calls poison Debugger._pausedCall under --debug and break page.pause().',
          selector:
            'ExpressionStatement > CallExpression > MemberExpression[object.name=/^(page|frame|leftFrame|rightFrame|context)$/][property.name=/^(addInitScript|addScriptTag|addStyleTag|bringToFront|check|click|close|dblclick|dispatchEvent|emulateMedia|evaluate|evaluateHandle|exposeBinding|exposeFunction|fill|focus|goBack|goForward|goto|hover|pause|press|reload|screenshot|selectOption|setChecked|setContent|setExtraHTTPHeaders|setInputFiles|setViewportSize|tap|type|uncheck|waitForEvent|waitForFunction|waitForLoadState|waitForNavigation|waitForRequest|waitForResponse|waitForSelector|waitForTimeout|waitForURL)$/]',
        },
        {
          message:
            'Promise-returning Playwright call must be awaited (or returned). Unawaited calls poison Debugger._pausedCall under --debug and break page.pause().',
          selector:
            "ExpressionStatement > CallExpression > MemberExpression[object.type='MemberExpression'][object.object.name=/^(page|frame|leftFrame|rightFrame)$/][object.property.name=/^(keyboard|mouse|touchscreen)$/]",
        },
      ],
    },
  },

  // Override: Index exports - restrict default exports
  {
    files: [
      'packages/*/src/index.ts',
      'packages/*/src/index.tsx',
      'packages/lexical-react/src/*.ts',
      'packages/lexical-react/src/*.tsx',
    ],
    rules: {
      'no-restricted-exports': [
        'error',
        {
          restrictDefaultExports: {
            defaultFrom: true,
            direct: true,
            named: true,
            namedFrom: true,
            namespaceFrom: true,
          },
        },
      ],
    },
  },

  // Prettier must be last to override formatting rules
  prettierConfig,

  // Compatibility with browserslist
  compat.configs['flat/recommended'],
];
