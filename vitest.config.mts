/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Plugin} from 'vite';

import react from '@vitejs/plugin-react';
import {playwright} from '@vitest/browser-playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {configDefaults, defineConfig} from 'vitest/config';

import {browserCommands} from './scripts/vitest/browserCommands.ts';

// @vitest/browser adds @vitest/mocker's interceptor plugin with
// `registerWebSocketEvents: false`, which still defines a configureServer
// hook that does nothing, so Vite warns on every browser run that the hook is
// ignored. Vitest installs its own logger, so drop the warning from the
// resolved one.
const IGNORED_INTERCEPTOR_WARNING =
  'Plugin "vitest:mocks:interceptor" defines Vite-specific hooks (configureServer)';
function ignoreInterceptorWarning(): Plugin {
  return {
    configResolved(config) {
      const {logger} = config;
      const {warnOnce} = logger;
      logger.warnOnce = (message, options) => {
        if (!message.startsWith(IGNORED_INTERCEPTOR_WARNING)) {
          warnOnce(message, options);
        }
      };
    },
    name: 'lexical:ignore-interceptor-warning',
  };
}

// Resolve monorepo imports to TypeScript source from the test tsconfig's
// `paths`. This includes the cross-package and deep `*/src/__tests__/utils`
// aliases that the unit tests rely on but that the lean root tsconfig (which
// resolves via the `source` export condition) intentionally omits. Vite's
// native `resolve.tsconfigPaths` only reads the root tsconfig, so we build
// the aliases explicitly from tsconfig.test.json instead.
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function tsconfigTestAliases(): {find: RegExp; replacement: string}[] {
  const {compilerOptions} = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'tsconfig.test.json'), 'utf8'),
  );
  return Object.entries(
    (compilerOptions.paths || {}) as Record<string, string[]>,
  ).map(([find, [replacement]]) => {
    // Wildcard entries like `lexical/src/*` -> `./packages/lexical/src/*`
    // become a capture-group alias so deep source imports resolve.
    if (find.endsWith('/*') && replacement.endsWith('/*')) {
      return {
        find: new RegExp(`^${escapeRegExp(find.slice(0, -2))}/(.*)$`),
        replacement: `${path.resolve(ROOT_DIR, replacement.slice(0, -2))}/$1`,
      };
    }
    return {
      find: new RegExp(`^${escapeRegExp(find)}$`),
      replacement: path.resolve(ROOT_DIR, replacement),
    };
  });
}

// Browser-mode tests (packages/**/__tests__/browser) run in a real browser via
// Playwright instead of jsdom, so unit tests that lean heavily on jsdom mocks
// can be ported to a more realistic environment. The browsers to launch are
// taken from the comma-separated VITEST_BROWSER env var (default: chromium) so
// the default CI job can stay on linux + chromium while the extended matrix
// fans out across firefox/webkit and additional operating systems.
const browserInstances = (process.env.VITEST_BROWSER || 'chromium')
  .split(',')
  .map(name => name.trim())
  .filter(
    name => name === 'webkit' || name === 'chromium' || name === 'firefox',
  )
  // Test files run in parallel pages of one browser. Playwright's Firefox
  // activates a page's window for every mouse event it dispatches, so a click
  // or drag in one file deactivates the window of a file that is pressing
  // keys, and Firefox can drop caret navigation (arrow keys, Home, End) in an
  // inactive window. Chromium and WebKit pages each behave as focused, so
  // only Firefox runs its files one at a time.
  //
  // A mouse move that Playwright dispatches in Chromium or Firefox completes
  // at the next frame, and both pace frames at 60Hz, so tests that drag the
  // mouse spent most of their time waiting for frames. Both draw frames as
  // soon as they can instead.
  .map(browser =>
    browser === 'firefox'
      ? {
          browser,
          maxWorkers: 1,
          provider: playwright({
            launchOptions: {firefoxUserPrefs: {'layout.frame_rate': 0}},
          }),
        }
      : browser === 'chromium'
        ? {
            browser,
            provider: playwright({
              launchOptions: {
                args: ['--disable-frame-rate-limit', '--disable-gpu-vsync'],
              },
            }),
          }
        : {browser},
  );

const compilerUnitTests =
  'packages/lexical-compiler/**/__tests__/unit/**/*.test{.ts,.tsx,.js,.jsx}';

// jsdom's dependencies use require(esm), which VM pools only support on
// Node 24.9+. Older Node versions also lack disposal symbols in VM contexts.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const unitPool =
  nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 9)
    ? 'vmThreads'
    : 'forks';

export default defineConfig({
  resolve: {
    alias: tsconfigTestAliases(),
    conditions: ['development', 'import', 'module', 'browser', 'default'],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    clearMocks: true,
    projects: [
      {
        define: {
          // https://react.dev/blog/2022/03/08/react-18-upgrade-guide#configuring-your-testing-environment
          IS_REACT_ACT_ENVIRONMENT: true,
        },
        extends: true,
        plugins: [react()],
        test: {
          env: {
            LEXICAL_VERSION: JSON.stringify(
              `${process.env.npm_package_version}+git`,
            ),
          },
          environment: 'jsdom',
          exclude: [...configDefaults.exclude, compilerUnitTests],
          include: [
            'packages/**/__tests__/unit/**/*.test{.ts,.tsx,.js,.jsx}',
            'dev-examples/**/__tests__/unit/**/*.test{.ts,.tsx,.js,.jsx}',
          ],
          name: 'unit',
          // Reuse jsdom's implementation while keeping each file's window and
          // module graph isolated (platform mocks depend on that isolation).
          pool: unitPool,
          setupFiles: ['./vitest.setup.mts', './vitest.setup.node.mts'],
          typecheck: {
            tsconfig: './tsconfig.test.json',
          },
        },
      },
      {
        define: {
          // https://react.dev/blog/2022/03/08/react-18-upgrade-guide#configuring-your-testing-environment
          IS_REACT_ACT_ENVIRONMENT: true,
        },
        extends: true,
        // Pre-bundle React (and react-dom/client) together so browser tests
        // that render React share a single React instance with the
        // source-aliased @lexical/react packages. Without this the optimized
        // react-dom/client bundle gets its own copy and hooks fail with a null
        // dispatcher ("Cannot read properties of null (reading 'useMemo')").
        optimizeDeps: {
          include: [
            'react',
            'react/jsx-dev-runtime',
            'react-dom',
            'react-dom/client',
          ],
        },
        plugins: [react(), ignoreInterceptorWarning()],
        test: {
          api: {port: 8315},
          browser: {
            commands: browserCommands,
            // Vitest's default browser server port (63315) is in the
            // ephemeral range, and Windows reserves randomized blocks of
            // that range (Hyper-V excluded port ranges), so on Windows CI
            // runners listen() occasionally fails with EACCES
            // (vitest-dev/vitest#9035). Pin a port below the ephemeral
            // range instead; if it happens to be busy, Vite falls back to
            // the next free port rather than failing.
            enabled: true,
            // Headless everywhere by default so the suite runs the same way in
            // CI and in headless dev containers. Pass `--browser.headless=false`
            // (or use the Vitest UI) to debug in a real window locally.
            headless: true,
            instances: browserInstances,
            provider: playwright(),
          },
          env: {
            LEXICAL_VERSION: JSON.stringify(
              `${process.env.npm_package_version}+git`,
            ),
          },
          include: [
            'packages/**/__tests__/browser/**/*.test{.ts,.tsx}',
            'dev-examples/**/__tests__/browser/**/*.test{.ts,.tsx}',
          ],
          name: 'browser',
          setupFiles: ['./vitest.setup.mts'],
          typecheck: {
            tsconfig: './tsconfig.test.json',
          },
        },
      },
      {
        extends: true,
        test: {
          environment: 'node',
          // Compiler tests exercise native build tools whose realm-sensitive
          // arguments (such as RegExp) cannot cross a VM context boundary.
          include: [
            'scripts/**/__tests__/unit/**/*.test.ts',
            compilerUnitTests,
          ],
          name: 'scripts-unit',
        },
      },
      {
        extends: true,
        test: {
          environment: 'node',
          globalSetup: './scripts/__tests__/integration/setup.mjs',
          include: ['scripts/__tests__/integration/**/*.test.mjs'],
          name: 'integration',
        },
      },
      {
        extends: true,
        test: {
          benchmark: {
            exclude: ['**/node_modules/**', '**/__bench__/dom/**'],
            include: ['packages/*/src/__bench__/*.bench.ts'],
          },
          environment: 'node',
          include: [],
          name: 'bench',
        },
      },
      {
        define: {
          IS_REACT_ACT_ENVIRONMENT: true,
        },
        extends: true,
        plugins: [react()],
        test: {
          benchmark: {
            exclude: ['**/node_modules/**'],
            include: ['packages/*/src/__bench__/dom/**/*.bench.ts'],
          },
          env: {
            LEXICAL_VERSION: JSON.stringify(
              `${process.env.npm_package_version}+git`,
            ),
          },
          environment: 'jsdom',
          include: [],
          name: 'bench-dom',
          setupFiles: ['./vitest.setup.mts'],
          typecheck: {
            tsconfig: './tsconfig.test.json',
          },
        },
      },
    ],
    // VM contexts retain modules until their worker is recycled. Keep the
    // limit at the root: Vitest's pool reads it from the global config.
    vmMemoryLimit: '512MB',
  },
});
