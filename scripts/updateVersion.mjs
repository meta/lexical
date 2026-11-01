/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import fs from 'fs-extra';
import {glob} from 'glob';
import path from 'node:path';
import prettier from 'prettier';

import {PackageMetadata} from './shared/PackageMetadata.mjs';
import {packagesManager} from './shared/packagesManager.mjs';
import readMonorepoPackageJson from './shared/readMonorepoPackageJson.mjs';
import {
  MIN_TYPESCRIPT_VERSION,
  tooOldStubPath,
  tooOldTypesVersions,
  TYPESCRIPT_TOO_OLD_CONDITION,
} from './shared/typescriptTooOld.mjs';
import npmToWwwName from './www/npmToWwwName.mjs';

const monorepoPackageJson = readMonorepoPackageJson();
// get version from monorepo package.json version
const version = monorepoPackageJson.version;

const publicNpmNames = new Set(
  packagesManager.getPublicPackages().map(pkg => pkg.getNpmName()),
);

/**
 * @typedef {import('./shared/PackageMetadata.mjs').ExportConditions} ExportConditions
 * @typedef {import('./shared/PackageMetadata.mjs').NpmModuleExports} NpmModuleExports
 */

/**
 * - Set the version to the monorepo ./package.json version
 * - Update dependencies, devDependencies, and peerDependencies
 * - Update the exports map and set other required default fields
 * @param {PackageMetadata} pkg
 */
function updatePackage(pkg) {
  pkg.packageJson.version = version;
  updateDependencies(pkg);
  if (!pkg.isPrivate()) {
    updatePublicPackage(pkg);
  }
  pkg.writeSync();
}

/**
 * Update every package.json in the packages/ and examples/ directories
 *
 * - Set the version to the monorepo ./package.json version
 * - Update the versions of monorepo dependencies, devDependencies, and peerDependencies
 * - Update the exports map and set other required default fields
 *
 */
async function updateVersion() {
  await regenerateVersionModules();
  await regenerateSupportedYjsVersion();
  packagesManager.getPackages().forEach(updatePackage);
  glob
    .sync([
      './examples/*/package.json',
      './scripts/__tests__/integration/fixtures/*/package.json',
    ])
    .forEach(packageJsonPath =>
      updatePackage(new PackageMetadata(packageJsonPath)),
    );
}

const INTERNAL_PACKAGE_NAME = '@lexical/internal';

/**
 * The modules that carry the monorepo version as a generated literal. In a
 * Rollup build `process.env.LEXICAL_VERSION` is statically replaced with a
 * build-specific string; the literal is the fallback used when the source is
 * consumed without that build step.
 */
const VERSION_MODULES = [
  'packages/lexical-internal/src/version.ts',
  'packages/lexical-eslint-plugin/src/version.js',
];

/**
 * Rewrite the generated literal in each version module to the current
 * monorepo version.
 */
async function regenerateVersionModules() {
  for (const relPath of VERSION_MODULES) {
    const versionPath = path.resolve(relPath);
    if (!fs.existsSync(versionPath)) {
      continue;
    }
    const next = fs
      .readFileSync(versionPath, 'utf8')
      .replace(/'[^']*\+source'/, `'${version}+source'`);
    const prettierConfig = (await prettier.resolveConfig(versionPath)) || {};
    fs.writeFileSync(
      versionPath,
      await prettier.format(next, {...prettierConfig, filepath: versionPath}),
    );
  }
}

/**
 * The module that carries the one `@y/y` version `@lexical/y` supports, as a
 * literal generated from that package's exact `@y/y` peer dependency (its
 * runtime check reports it; YjsContract.test fails when the two differ).
 */
const SUPPORTED_YJS_MODULE = 'packages/lexical-y/src/internal/SupportedYjs.ts';

/**
 * Rewrite the generated `SUPPORTED_YJS_VERSION` literal to `@lexical/y`'s
 * `@y/y` peer dependency.
 */
async function regenerateSupportedYjsVersion() {
  const modulePath = path.resolve(SUPPORTED_YJS_MODULE);
  const packageJsonPath = path.resolve('packages/lexical-y/package.json');
  if (!fs.existsSync(modulePath) || !fs.existsSync(packageJsonPath)) {
    return;
  }
  const {peerDependencies = {}} = fs.readJsonSync(packageJsonPath);
  const supported = peerDependencies['@y/y'];
  if (
    typeof supported !== 'string' ||
    !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(supported)
  ) {
    throw new Error(
      `packages/lexical-y/package.json: peerDependencies['@y/y'] must be one exact version (got ${String(supported)})`,
    );
  }
  const next = fs
    .readFileSync(modulePath, 'utf8')
    .replace(
      /(export const SUPPORTED_YJS_VERSION: string = )'[^']*'/,
      `$1'${supported}'`,
    );
  const prettierConfig = (await prettier.resolveConfig(modulePath)) || {};
  fs.writeFileSync(
    modulePath,
    await prettier.format(next, {...prettierConfig, filepath: modulePath}),
  );
}

/**
 * Return true if any non-test source file in the package imports from
 * `@lexical/internal/...`, meaning the package needs it as a runtime
 * dependency (so the `source` export condition resolves for npm consumers).
 *
 * @param {PackageMetadata} pkg
 * @returns {boolean}
 */
function srcImportsInternalPackage(pkg) {
  const srcDir = pkg.resolve('src');
  if (!fs.existsSync(srcDir)) {
    return false;
  }
  const stack = [srcDir];
  while (stack.length > 0) {
    const dir = /** @type {string} */ (stack.pop());
    for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
      if (ent.isDirectory()) {
        if (ent.name !== '__tests__' && ent.name !== '__bench__') {
          stack.push(path.join(dir, ent.name));
        }
      } else if (/\.tsx?$/.test(ent.name)) {
        const contents = fs.readFileSync(path.join(dir, ent.name), 'utf8');
        if (contents.includes(`from '${INTERNAL_PACKAGE_NAME}/`)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Replace the extension in a .js or .mjs filename with another extension.
 * Used to convert between the two or to add a prefix before the extension.
 *
 * `ext` may contain $1 to use the original extension in the
 * replacement, e.g. replaceExtension('foo.js', '.bar$1') -> 'foo.bar.js'
 *
 * @param {string} fileName
 * @param {string} ext
 * @returns {string} fileName with ext as the new extension
 */
function replaceExtension(fileName, ext) {
  return fileName.replace(/(\.m?js)$/, ext);
}

/**
 * webpack can use these conditions to choose a dev or prod
 * build without a fork module.
 *
 * @param {string} fileName may have .js or .mjs extension
 * @returns {Record<'development'|'production', string>}
 */
function withEnvironments(fileName) {
  return {
    development: replaceExtension(fileName, '.dev$1'),
    production: replaceExtension(fileName, '.prod$1'),
  };
}

/**
 * The subdirectory of a package that holds built artifacts (and is what
 * the public exports/main/types fields resolve into). Keeping this in one
 * place makes the package directory itself a publishable npm package and
 * allows `pnpm link` / `file:` consumers to point at the package root.
 */
const DIST_DIR = 'dist';

/**
 * Build an export map for a particular entry point in the package.json
 *
 * Only ESM is published (the CommonJS build is www-only, see
 * scripts/build.mjs), so the conditions are not split into `import` and
 * `require`: both resolve to the same `.js` ES modules. A CommonJS consumer on
 * any supported Node.js (>= 20.19) loads them through require(esm), which
 * is why the fork module and everything it imports has no top-level await,
 * and bundlers do not care about the extension.
 *
 * @param {string} basename the name of the entry point module without an extension (e.g. 'index')
 * @param {string} [typesBasename]
 * @param {string} [sourceRelPath] path relative to the package root for the
 *   TypeScript (or CJS) source backing this entry. When provided, a
 *   `source` condition is added so bundlers configured with
 *   `resolve.conditions: ['source', ...]` can consume the package
 *   without a build step (useful for `pnpm link` / `file:` consumers).
 * @returns {NpmModuleExports} The export map for this file
 */
function exportEntry(
  basename,
  typesBasename = `${basename}.d.ts`,
  sourceRelPath,
) {
  // Bundlers such as webpack require 'types' to be first and 'default' to be
  // last per #5731. Keys are in descending priority order.
  const prefix = `./${DIST_DIR}/${basename}`;
  const types = `./${DIST_DIR}/${typesBasename}`;
  // Redirect consumers that read "exports" but are below the minimum supported
  // TypeScript version (TypeScript 4.9 understands `types@`, up to but not
  // including the minimum) to the "too old" stub. Must precede `types`.
  const tooOld = tooOldStubPath(DIST_DIR);
  return {
    ...(sourceRelPath ? {source: `./${sourceRelPath}`} : null),
    [TYPESCRIPT_TOO_OLD_CONDITION]: tooOld,
    types,
    ...withEnvironments(`${prefix}.js`),
    default: `${prefix}.js`,
  };
}

/**
 * Add a browser condition for a particular entry point in the package.json
 *
 * @param {NpmModuleExports} exports
 * @returns {NpmModuleExports} The export map for this file
 */
function withBrowser(exports) {
  const {source, browser: _ignored, ...conditions} = exports;
  const browser = /** @type {ExportConditions} */ (
    Object.fromEntries(
      Object.entries(conditions).map(([k, v]) => {
        if (k === 'types' || k.startsWith('types@')) {
          // `types` and the versioned `types@<min>` condition point at .d.ts
          // files, never a browser bundle; pass them through unchanged.
          return [k, v];
        }
        return [k, v.replace(/((?:\.dev|\.prod)?\.js)$/, '.browser$1')];
      }),
    )
  );
  // Keep `source` first so a consumer that opts in with
  // `resolve.conditions: ['source', ...]` always wins over `browser`.
  return {...(source ? {source} : null), browser, ...conditions};
}

/**
 * Strip any leading './' or 'dist/' segment from a path stored in
 * package.json. Existing package.json fields may be `Lexical.js`,
 * `./Lexical.js`, or `./dist/Lexical.js` depending on when they were
 * last written; normalize to the bare basename for derivation.
 *
 * @param {string} value
 * @returns {string}
 */
function stripDistPrefix(value) {
  return value.replace(/^(\.\/)?(dist\/)?/, '');
}

/**
 * Files that should be present alongside package.json in every public
 * package directory so it ships as a complete npm package without any
 * separate copy-into-`npm/` step. `src` is included (minus tests and
 * benchmarks) so the `source` export condition (added by `exportEntry`)
 * resolves for npm consumers that opt in via
 * `resolve.conditions: ['source', ...]`.
 */
const PUBLIC_FILES_FIELD = [
  'dist',
  'src',
  '!src/__tests__',
  '!src/__bench__',
  '!src/__mocks__',
  '!src/**/*.test.ts',
  '!src/**/*.test.tsx',
  '!src/**/*.bench.ts',
  '!src/**/*.bench.tsx',
  'README.md',
  'LICENSE',
];

/**
 * Copy the monorepo LICENSE into the package directory. The published
 * tarball must contain the LICENSE next to package.json; doing this
 * during `update-packages` keeps the working tree publishable without
 * relying on the previous prepare-release copy step.
 *
 * @param {PackageMetadata} pkg
 */
function ensureLicense(pkg) {
  const dest = pkg.resolve('LICENSE');
  fs.copySync(path.resolve('LICENSE'), dest);
}

/**
 * Find the source file backing a `main`-style entry. The build always
 * compiles `src/index.{ts,tsx}` into the `main` output regardless of
 * what `main` is named, so check for index first; fall back to
 * `src/<basename>.{ts,tsx,js}` to cover any custom layout.
 *
 * @param {PackageMetadata} pkg
 * @param {string} basename
 * @returns {string | undefined}
 */
function findMainSourceRelPath(pkg, basename) {
  const candidates = [
    'index.ts',
    'index.tsx',
    'index.js',
    `${basename}.ts`,
    `${basename}.tsx`,
    `${basename}.js`,
  ];
  for (const fn of candidates) {
    if (fs.existsSync(pkg.resolve('src', fn))) {
      return `src/${fn}`;
    }
  }
  return undefined;
}

/**
 * Update the public package's packageJson in-place to add default configurations
 * for `sideEffects` and `module` as well as to maintain the `exports` map.
 *
 * @param {PackageMetadata} pkg
 */
function updatePublicPackage(pkg) {
  const {packageJson} = pkg;
  if (packageJson.sideEffects === undefined) {
    packageJson.sideEffects = false;
  }
  // Only ESM is published, so a package is an ES module package and its
  // `.js` build is ESM.
  packageJson.type = 'module';
  // If there's a main we expect a single entry point
  if (packageJson.main) {
    // `main` is the one resolver-agnostic entry, so it names the ESM fork
    // module: a package.json written when the build had another extension
    // (`.mjs`) is normalized here.
    const mainBase = replaceExtension(stripDistPrefix(packageJson.main), '.js');
    packageJson.main = `./${DIST_DIR}/${mainBase}`;
    packageJson.module = packageJson.main;
    const sourceRelPath = findMainSourceRelPath(
      pkg,
      replaceExtension(mainBase, ''),
    );
    // Derive the declaration basename from the entry source (the build emits
    // e.g. src/index.ts -> dist/index.d.ts) rather than from the existing
    // `types` field: `types` is rewritten to the "too old" stub below, so
    // reading it here would corrupt the real types on a second run.
    const typesBase = sourceRelPath
      ? `${path.basename(sourceRelPath).replace(/\.(tsx?|js)$/, '')}.d.ts`
      : 'index.d.ts';
    packageJson.exports = {
      '.': exportEntry(
        replaceExtension(mainBase, ''),
        typesBase,
        sourceRelPath,
      ),
    };
  } else {
    /** @type {Record<string, unknown>} */
    const exports = {};
    // Export all src/*.tsx? files that do not have a prefix extension (e.g. no .d.ts)
    for (const fn of fs.readdirSync(pkg.resolve('src'))) {
      if (/^[^.]+\.tsx?$/.test(fn)) {
        const basename = fn.replace(/\.tsx?$/, '');
        const hasBrowser = fs.existsSync(
          pkg.resolve('src', fn.replace(/(\.tsx?)$/, '.browser$1')),
        );
        const packageName = pkg.getNpmName();
        const isIndex = basename === 'index';
        const entryNameInput = isIndex
          ? packageName
          : `${packageName}/${basename}`;
        const entryName = npmToWwwName(entryNameInput);
        let entry = exportEntry(entryName, `${basename}.d.ts`, `src/${fn}`);
        if (hasBrowser) {
          entry = withBrowser(entry);
        }
        // support for import "@lexical/react/LexicalComposer"
        exports[isIndex ? '.' : `./${basename}`] = entry;
        if (!hasBrowser && !isIndex) {
          // support for import "@lexical/react/LexicalComposer.js"
          // @mdxeditor/editor uses this at least as of v3.46.0
          exports[`./${basename}.js`] = entry;
        }
      }
    }
    packageJson.exports = exports;
  }
  // Tombstone the legacy type-resolution fields. A consumer whose TypeScript
  // cannot read "exports" (classic moduleResolution, at any version) resolves
  // `types` for the package root and `typesVersions` for every subpath; point
  // both at the "too old" stub so they get a clear upgrade message instead of
  // a misleading "Cannot find module". Modern resolvers ignore both fields
  // because "exports" takes priority over them (TypeScript >= 4.9).
  packageJson.types = tooOldStubPath(DIST_DIR);
  packageJson.typesVersions = tooOldTypesVersions(DIST_DIR);
  // Advise (but do not require) a supported TypeScript at install time. npm and
  // pnpm surface a peer-dependency warning when an out-of-range `typescript` is
  // present; `optional` keeps it from being installed or hard-required for
  // consumers that don't use TypeScript. This complements the type-check-time
  // guard above with an earlier, install-time signal.
  packageJson.peerDependencies = {
    ...packageJson.peerDependencies,
    typescript: `>=${MIN_TYPESCRIPT_VERSION}`,
  };
  packageJson.peerDependenciesMeta = {
    ...packageJson.peerDependenciesMeta,
    typescript: {optional: true},
  };
  pkg.sortDependencies('peerDependencies');
  // Whitelist what ships to npm. The package root is the publish root, so
  // we no longer need a separate `npm/` copy step.
  packageJson.files = [...PUBLIC_FILES_FIELD];
  if (pkg.getNpmName() === 'lexical') {
    // Every app that uses Lexical installs `lexical`, so the full release
    // history ships with it (node_modules/lexical/CHANGELOG.md) for people
    // and tools upgrading from any version. prepare-release copies the
    // root CHANGELOG.md into the package; the copy is not committed.
    packageJson.files.push('CHANGELOG.md');
  }
  ensureLicense(pkg);
}

/**
 * Update dependencies and peerDependencies in pkg in-place.
 * All entries for monorepo packages will be updated to version.
 * All peerDependencies for monorepo packages will be moved to dependencies.
 *
 * @param {PackageMetadata} pkg
 */
function updateDependencies(pkg) {
  // examples should use exact versions since they
  // are not currently in the workspace
  const depVersion =
    path.basename(pkg.resolve('..')) !== 'packages' ? version : 'workspace:*';
  const {packageJson} = pkg;
  const {
    dependencies = {},
    peerDependencies = {},
    devDependencies = {},
  } = packageJson;
  // Pinned-locally deps (link:..., file:...) are intentional — a fixture
  // or example may want to resolve through pnpm's link protocol against
  // the local checkout. Leave those alone; only normalize semver-style
  // pins to the canonical monorepo version.
  const isLocalProtocol = (/** @type {unknown} */ v) =>
    typeof v === 'string' && /^(link|file|portal):/.test(v);
  [dependencies, devDependencies].forEach(deps => {
    Object.keys(deps).forEach(dep => {
      if (publicNpmNames.has(dep) && !isLocalProtocol(deps[dep])) {
        deps[dep] = depVersion;
      }
    });
  });
  // Move peerDependencies on lexical monorepo packages to dependencies
  // per #5783
  Object.keys(peerDependencies).forEach(peerDep => {
    if (publicNpmNames.has(peerDep)) {
      delete peerDependencies[peerDep];
      dependencies[peerDep] = depVersion;
    }
  });
  // Reconcile the @lexical/internal dependency: a package needs it iff its
  // source imports it (so the `source` export condition resolves for npm
  // consumers). Add it when imported, remove it when no longer imported.
  // (@lexical/internal must not depend on itself; leave local-protocol pins.)
  if (
    pkg.getNpmName() !== INTERNAL_PACKAGE_NAME &&
    !isLocalProtocol(dependencies[INTERNAL_PACKAGE_NAME])
  ) {
    if (srcImportsInternalPackage(pkg)) {
      dependencies[INTERNAL_PACKAGE_NAME] = depVersion;
    } else {
      delete dependencies[INTERNAL_PACKAGE_NAME];
    }
  }
  pkg
    .sortDependencies('dependencies', dependencies)
    .sortDependencies('devDependencies', devDependencies)
    .sortDependencies('peerDependencies', peerDependencies);
}

updateVersion();
