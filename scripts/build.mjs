/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check

import alias from '@rollup/plugin-alias';
import babel from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import nodeResolve from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';
import fs from 'fs-extra';
import {glob} from 'glob';
import minimist from 'minimist';
import path from 'path';
import {rollup} from 'rollup';

import {pureAnnotations} from '../packages/lexical-compiler/src/passes/pureAnnotations.mjs';
import transformErrorMessages from './error-codes/transform-error-messages.mjs';
import {exec} from './shared/childProcess.mjs';
import {packagesManager} from './shared/packagesManager.mjs';
import {
  getTypeScriptTooOldStub,
  TYPESCRIPT_TOO_OLD_BASENAME,
} from './shared/typescriptTooOld.mjs';
import npmToWwwName from './www/npmToWwwName.mjs';

const __dirname = import.meta.dirname;

const argv = minimist(process.argv.slice(2));

const headerTemplate = fs.readFileSync(
  path.resolve(__dirname, 'www', 'headerTemplate.js'),
  'utf8',
);

// Arguments are parsed as flags by minimist
const isProduction = argv.prod;
const isRelease = argv.release;
const isWWW = argv.www;
const extractCodes = argv.codes;

// @lexical/internal is a published package (so its source resolves for the
// `source` export condition and for direct consumers), but within the
// monorepo build we keep inlining it into every other package — exactly as
// the old private `shared` alias did. Excluding it here keeps it out of the
// externals/www-rewrite sets and the undeclared-dependency check, so the
// `@lexical/internal` alias below bundles it.
const INLINED_PACKAGES = new Set(['@lexical/internal']);

const modulePackageMappings = Object.fromEntries(
  packagesManager
    .getPublicPackages()
    .filter(pkg => !INLINED_PACKAGES.has(pkg.getNpmName()))
    .flatMap(pkg => {
      const pkgName = pkg.getNpmName();
      return pkg.getExportedNpmModuleNames().map(npm => [npm, pkgName]);
    }),
);

/**
 * @param {string} assetType
 * @returns {string[]}
 */
function getShikiAssets(assetType) {
  return glob
    .sync(
      path.resolve(
        path.dirname(__dirname),
        'node_modules/@shikijs/' + assetType + '/dist/*.mjs',
      ),
      {windowsPathsNoEscape: true},
    )
    .map(p => path.basename(p.replaceAll('\\', '/'), '.mjs'));
}

const wwwMappings = {
  ...Object.fromEntries(
    Object.keys(modulePackageMappings).map(npm => [npm, npmToWwwName(npm)]),
  ),
  ...Object.fromEntries(
    getShikiAssets('langs').map(name => [
      `@shikijs/langs/${name}`,
      `shikijs-langs-${name}`,
    ]),
  ),
  ...Object.fromEntries(
    getShikiAssets('themes').map(name => [
      `@shikijs/themes/${name}`,
      `shikijs-themes-${name}`,
    ]),
  ),
  'happy-dom': 'jsdom',
  'prismjs/components/prism-c': 'prism-c',
  'prismjs/components/prism-clike': 'prism-clike',
  'prismjs/components/prism-core': 'prismjs',
  'prismjs/components/prism-cpp': 'prism-cpp',
  'prismjs/components/prism-css': 'prism-css',
  'prismjs/components/prism-java': 'prism-java',
  'prismjs/components/prism-javascript': 'prism-javascript',
  'prismjs/components/prism-markdown': 'prism-markdown',
  'prismjs/components/prism-markup': 'prism-markup',
  'prismjs/components/prism-objectivec': 'prism-objectivec',
  'prismjs/components/prism-powershell': 'prism-powershell',
  'prismjs/components/prism-python': 'prism-python',
  'prismjs/components/prism-rust': 'prism-rust',
  'prismjs/components/prism-sql': 'prism-sql',
  'prismjs/components/prism-swift': 'prism-swift',
  'prismjs/components/prism-typescript': 'prism-typescript',
  'react-dom': 'ReactDOM',
  'react-dom/client': 'ReactDOM',
  // The react entrypoint in fb includes the jsx runtime
  'react/jsx-runtime': 'react',
};

/**
 * Fix ESM imports of prismjs components that rely on a wildcard export, these
 * must have a '.js' extension to be resolved correctly.
 *
 * @param {string} id the module id to resolve
 * @returns {string} the module name with '.js' extension if necessary
 */
function resolveExternalEsm(id) {
  if (/^prismjs\/components\/prism-/.test(id)) {
    return `${id}.js`;
  }
  return id;
}

/**
 * The set of all modules that should remain external to our published
 * packages, should include all public monorepo packages and the third
 * party dependencies or peerDependencies that we do not want to include
 * in the bundles.
 */
const monorepoExternalsSet = new Set(Object.entries(wwwMappings).flat());
const thirdPartyExternals = [
  // @lexical/compiler is a build-time tool: it wraps @babel/parser
  // and magic-string (declared dependencies that must not be inlined into
  // its published bundle) and reads relatively imported modules from disk.
  '@babel/parser',
  'magic-string',
  'node:[a-z_]+',
  'react',
  'react-dom',
  'yjs',
  'y-websocket',
  'happy-dom',
  'jsdom',
  // The @lexical/code-shiki package declares shiki and @shikijs/* as
  // npm dependencies and loads languages/themes via dynamic import, so
  // they must remain external in the published bundle rather than be
  // inlined by Rollup.
  'shiki',
  '@shikijs',
  ...(isWWW
    ? [':server-only-hack:.*']
    : [
        '@floating-ui/react',
        // @lexical/mdast delegates parsing/serialization to the
        // micromark/mdast ecosystem. Keep those (declared) dependencies
        // external in the npm build so consumer bundlers resolve them with
        // their own export conditions and tree-shaking — e.g. the browser
        // condition of decode-named-character-reference (transitive, via
        // mdast-util-from-markdown) decodes entities through the DOM
        // instead of inlining a ~36 kB character-entities table — and so
        // they dedupe with any other unified/remark tooling in the app.
        'mdast-util-from-markdown',
        'mdast-util-to-markdown',
        'mdast-util-to-string',
        'mdast-util-gfm-autolink-literal',
        'mdast-util-gfm-strikethrough',
        'mdast-util-gfm-table',
        'mdast-util-gfm-task-list-item',
        'micromark-extension-gfm-autolink-literal',
        'micromark-extension-gfm-strikethrough',
        'micromark-extension-gfm-table',
        'micromark-extension-gfm-task-list-item',
      ]),
];
const thirdPartyExternalsRegExp = new RegExp(
  `^(${thirdPartyExternals.join('|')})(\\/|$)`,
);

/** @type {Record<string, string>} */
const strictWWWMappings = {};

// Add quotes around mappings to make them more strict.
Object.entries(wwwMappings).forEach(([mapping, target]) => {
  strictWWWMappings[`'${mapping}'`] = `'${target}'`;
});

/**
 * @param {'esm'|'cjs'} format
 * @returns {'.mjs'|'.js'} the correct file extension for this export format
 */
function getExtension(format) {
  return `.${format === 'esm' ? 'm' : ''}js`;
}

/**
 *
 * @param {string} name
 * @param {string} inputFile
 * @param {string} outputPath
 * @param {string} outputFile
 * @param {boolean} isProd
 * @param {'cjs'|'esm'} format
 * @param {string} version
 * @param {import('./shared/PackageMetadata.mjs').PackageMetadata} pkg
 * @returns {Promise<Array<string>>} the exports of the built module
 */
async function build(
  name,
  inputFile,
  outputPath,
  outputFile,
  isProd,
  format,
  version,
  pkg,
) {
  const extensions = ['.js', '.jsx', '.ts', '.tsx'];
  /** @type {import('rollup').RollupOptions} */
  const inputOptions = {
    external(modulePath, src) {
      const modulePkgName = modulePackageMappings[modulePath];
      if (
        typeof modulePkgName === 'string' &&
        !(
          modulePkgName in (pkg.packageJson.dependencies || {}) ||
          modulePkgName === pkg.getNpmName()
        )
      ) {
        console.error(
          `Error: ${path.relative(
            '.',
            src ?? inputFile,
          )} has an undeclared dependency in its import of ${modulePath}.\nAdd the following to the dependencies in ${path.relative(
            '.',
            pkg.resolve('package.json'),
          )}: "${modulePkgName}": "${version}"`,
        );
        process.exit(1);
      }
      return (
        monorepoExternalsSet.has(modulePath) ||
        thirdPartyExternalsRegExp.test(modulePath)
      );
    },
    input: inputFile,
    onwarn(warning) {
      if (warning.code === 'CIRCULAR_DEPENDENCY') {
        // Ignored
      } else if (warning.code === 'UNUSED_EXTERNAL_IMPORT') {
        // Important, but not enough to stop the build
        console.error();
        console.error(warning.message || warning);
        console.error();
      } else if (
        warning.code === 'SOURCEMAP_ERROR' &&
        warning.message.endsWith(`Can't resolve original location of error.`)
      ) {
        // Ignored
      } else if (
        isWWW &&
        warning.code === 'MODULE_LEVEL_DIRECTIVE' &&
        /"use client"/.test(warning.message)
      ) {
        // Ignored in WWW
      } else if (typeof warning.code === 'string') {
        console.error(warning);
        // This is a warning coming from Rollup itself.
        // These tend to be important (e.g. clashes in namespaced exports)
        // so we'll fail the build on any of them.
        console.error();
        console.error(warning.message || warning);
        console.error();
        process.exit(1);
      } else {
        // The warning is from one of the plugins.
        // Maybe it's not important, so just print it.
        console.warn(warning.message || warning);
      }
    },
    plugins: [
      ...(isWWW
        ? [
            /* in www we do not use export conditions so we build a virtual fork module instead */
            {
              name: 'server-only-hack',
              renderChunk(/** @type {string} */ source) {
                // Ugly hack to effectively undo the hoist of require('jsdom')
                const m = source.match(
                  /require\(':server-only-hack:([^']+)'\);/,
                );
                if (m) {
                  const matchIndex = m.index ?? 0;
                  return (
                    source.slice(0, matchIndex) +
                    `typeof window === 'undefined' ? require('${m[1]}') : undefined;` +
                    source.slice(matchIndex + m[0].length)
                  );
                }
              },
            },
          ]
        : []),
      alias({
        entries: [
          {
            find: '@lexical/internal',
            replacement: path.resolve('packages/lexical-internal/src'),
          },
          {find: 'buffer', replacement: 'buffer'},
        ],
      }),
      nodeResolve({
        extensions,
        preferBuiltins: false,
      }),
      babel({
        babelHelpers: 'bundled',
        babelrc: false,
        configFile: false,
        exclude: '**/node_modules/**',
        extensions,
        // JSX only parses in .jsx/.tsx files. Applying preset-react
        // unconditionally would enable the jsx syntax plugin for plain .ts
        // too, where `<T>` in a generic arrow function (`<T>(x: T) => ...`)
        // is ambiguous with an opening JSX element and fails to parse.
        overrides: [
          {
            presets: [
              // Pin development:false so the automatic runtime always emits the
              // production `jsx`/`jsxs` helpers, never `jsxDEV`. Babel 8 flipped the
              // default to infer development mode from the environment, which made
              // the dev builds import `react/jsx-dev-runtime`; consumers that bundle
              // those dev builds (e.g. the Docusaurus website SSG) then crash with
              // "jsxDEV is not a function".
              [
                '@babel/preset-react',
                {development: false, runtime: 'automatic'},
              ],
            ],
            test: /\.[jt]sx$/,
          },
        ],
        plugins: [
          [transformErrorMessages, {extractCodes, noMinify: !isProd}],
          '@babel/plugin-transform-optional-catch-binding',
        ],
        presets: ['@babel/preset-typescript'],
      }),
      // Runs on the JavaScript babel emits so that every module-scope call
      // to a side-effect-free factory (defineExtension, createCommand, ...)
      // carries a /* @__PURE__ */ annotation. The sources do not carry them:
      // they are injected here (and by the same plugin for consumers that
      // build from the `source` export condition) so that both this build
      // and downstream bundlers can drop unused definitions.
      //
      // `inline` additionally replaces the calls whose result is a trivial
      // expression over their arguments with that expression. It is off by
      // default in the published plugin because it reproduces those bodies,
      // but here the Lexical being built is this one.
      //
      // `strict` fails the build on a call inside one of those definitions
      // that nothing has established is side-effect free, because such a
      // call pins the definition into every bundle that imports the module.
      pureAnnotations({inline: true, strict: true}),
      commonjs(),
      json(),
      replace(
        Object.assign(
          {
            delimiters: ['', ''],
            preventAssignment: true,
            'process.env.LEXICAL_VERSION': JSON.stringify(
              `${version}+${isProd ? 'prod' : 'dev'}.${format}`,
            ),
            // Lexical source branches on `process.env.NODE_ENV !== 'production'`
            // (no bare `__DEV__` global). Baking the literal per-variant lets
            // terser dead-code-eliminate the dev branches in prod builds, and
            // lets source-mode consumers rely on their bundler's standard
            // `process.env.NODE_ENV` substitution with no extra config.
            'process.env.NODE_ENV': isProd ? '"production"' : '"development"',
          },
          isWWW && strictWWWMappings,
        ),
      ),
      // terser is used because @ampproject/rollup-plugin-closure-compiler
      // doesn't compile `export default function X()` correctly and hasn't
      // been updated since Aug 2021
      isProd &&
        terser({
          ecma: 2019,
          // Keep /* @__PURE__ */ and @__NO_SIDE_EFFECTS__ annotations in the
          // prod output so downstream bundlers can tree-shake unused
          // extension/command/rule definitions out of application bundles.
          format: {ascii_only: true, preserve_annotations: true},
          module: format === 'esm',
        }),
      isProd && {
        name: 'strip-misplaced-pure-annotations',
        renderChunk(/** @type {string} */ source) {
          // terser prints the annotation of `return /*#__PURE__*/ f()` (added
          // by @babel/preset-react for JSX) before the `return` keyword, where
          // it no longer precedes a call expression. Bundlers ignore it there
          // and rolldown-based Vite warns with INVALID_ANNOTATION (#8785), so
          // drop those comments; only an annotation directly before a
          // call/new expression has any effect.
          return source.replace(
            /\/\*\s*[#@]__PURE__\s*\*\/(?=\s*return\b)/g,
            '',
          );
        },
      },
      {
        name: 'lexical-comment-banner',
        renderChunk(source) {
          // Assets pipeline might use "export" word in the beginning of the line
          // as a dependency, avoiding it with empty comment in front
          const patchedSource = isWWW
            ? source.replace(/^(export(?!s))/gm, '/**/$1')
            : source;
          return `${getComment()}\n${patchedSource}`;
        },
      },
    ],
    // Lexical Code: this ensures PrismJS imports get included in the bundle
    treeshake: name === 'Lexical Code Prism' ? false : 'smallest',
  };
  /** @type {import('rollup').OutputOptions} */
  const outputOptions = {
    esModule: false,
    exports:
      // Special case for lexical-eslint-plugin which is written in cjs and
      // requires a default export. Default exports in all other modules are
      // deprecated.
      name === 'Lexical Eslint Plugin' ? 'auto' : 'named',
    externalLiveBindings: false,
    file: outputFile,
    format, // change between es and cjs modules
    freeze: false,
    // pnpm's module resolution causes Rollup to detect dynamic imports that
    // npm's flat structure didn't. Inline them to avoid code-splitting.
    inlineDynamicImports: true,
    interop: format === 'esm' ? 'esModule' : undefined,
    paths: format === 'esm' ? resolveExternalEsm : undefined,
  };
  const result = await rollup(inputOptions);
  const {output} = await result.write(outputOptions);
  return output[0].exports;
}

function getComment() {
  if (!isWWW) {
    return headerTemplate;
  }
  const lines = headerTemplate.split(/\n/g);
  const idx = lines.indexOf(' */');
  if (idx === -1) {
    throw new Error(
      `Expecting scripts/www/headerTemplate.js to have a ' */' line`,
    );
  }
  lines.splice(
    idx,
    0,
    ' *',
    ' * @fullSyntaxTransform',
    ' * @es6-async_DO_NOT_USE',
    ' * @generated',
    ' * @noflow',
    ' * @nolint',
    ' * @oncall lexical_web_text_editor',
    ' * @preserve-invariant-messages',
    ' * @preserve-whitespace',
    ' * @preventMunge',
  );
  return lines.join('\n');
}

/**
 * @param {string} fileName
 * @param {boolean} isProd
 * @param {'esm' | 'cjs'} format
 * @returns {string}
 */
function getFileName(fileName, isProd, format) {
  // Both www and npm builds use the `.dev`/`.prod` suffix. The bare
  // `Foo.mjs`/`Foo.js` names are reserved for the fork module emitted by
  // buildForkModules so the published exports map can resolve cleanly
  // regardless of which variants were built.
  return `${fileName}.${isProd ? 'prod' : 'dev'}${getExtension(format)}`;
}

async function buildTSDeclarationFiles() {
  await exec('tsc -p ./tsconfig.build.json');
}

/**
 *
 * @param {string} packageName
 * @param {string} outputPath
 */
function moveTSDeclarationFilesIntoDist(packageName, outputPath) {
  fs.copySync(`./.ts-temp/packages/${packageName}/src`, outputPath);
}

/**
 * @typedef {Object} ForkModuleContentOptions
 * @property {string} devFileName
 * @property {Array<string>} exports
 * @property {'dev'|'prod'|'both'} mode which variants this build produced
 * @property {string} outputFileName
 * @property {string} prodFileName
 */

/**
 *
 * @param {ForkModuleContentOptions} opts
 * @param {'cjs'|'esm'|'node'} target
 * @returns {string}
 */
function forkModuleContent(
  {devFileName, exports, mode, outputFileName, prodFileName},
  target,
) {
  const lines = [getComment()];
  if (target === 'cjs') {
    lines.push(`'use strict'`);
    if (mode === 'both') {
      lines.push(
        `const ${outputFileName} = process.env.NODE_ENV !== 'production' ? require('${devFileName}') : require('${prodFileName}');`,
      );
    } else if (mode === 'dev') {
      lines.push(`const ${outputFileName} = require('${devFileName}');`);
    } else {
      lines.push(`const ${outputFileName} = require('${prodFileName}');`);
    }
    lines.push(`module.exports = ${outputFileName};`);
  } else {
    if (target === 'esm') {
      if (mode === 'both') {
        lines.push(
          `import * as modDev from '${devFileName}';`,
          `import * as modProd from '${prodFileName}';`,
          `const mod = process.env.NODE_ENV !== 'production' ? modDev : modProd;`,
        );
      } else if (mode === 'dev') {
        lines.push(`import * as mod from '${devFileName}';`);
      } else {
        lines.push(`import * as mod from '${prodFileName}';`);
      }
    } else if (target === 'node') {
      if (mode === 'both') {
        lines.push(
          `const mod = await (process.env.NODE_ENV !== 'production' ? import('${devFileName}') : import('${prodFileName}'));`,
        );
      } else if (mode === 'dev') {
        lines.push(`const mod = await import('${devFileName}');`);
      } else {
        lines.push(`const mod = await import('${prodFileName}');`);
      }
    }
    for (const name of exports) {
      lines.push(
        name === 'default'
          ? `export default mod.default;`
          : `export const ${name} = mod.${name};`,
      );
    }
  }
  return lines.join('\n');
}

/**
 *
 * @param {string} outputPath
 * @param {string} outputFileName
 * @param {'cjs'|'esm'} format
 * @param {Array<string>} exports
 * @param {'dev'|'prod'|'both'} mode
 */
function buildForkModules(outputPath, outputFileName, format, exports, mode) {
  const extension = getExtension(format);
  const devFileName = `./${outputFileName}.dev${extension}`;
  const prodFileName = `./${outputFileName}.prod${extension}`;
  const opts = {devFileName, exports, mode, outputFileName, prodFileName};
  fs.outputFileSync(
    path.resolve(outputPath, `${outputFileName}${extension}`),
    forkModuleContent(opts, format),
  );
  if (format === 'esm') {
    fs.outputFileSync(
      path.resolve(outputPath, `${outputFileName}.node${extension}`),
      forkModuleContent(opts, 'node'),
    );
  }
}

/**
 * Copy the package's hand-written Flow stubs from `flow/` into the build
 * output directory so Flow consumers find `<Name>.js.flow` next to the
 * matching `<Name>.js` shipped in the published package.
 *
 * @param {import('./shared/PackageMetadata.mjs').PackageMetadata} pkg
 * @param {string} outputPath
 */
function copyFlowStubsIntoDist(pkg, outputPath) {
  const flowDir = pkg.resolve('flow');
  if (!fs.existsSync(flowDir)) {
    return;
  }
  for (const fn of fs.readdirSync(flowDir)) {
    if (fn.endsWith('.flow')) {
      fs.copySync(path.resolve(flowDir, fn), path.resolve(outputPath, fn));
    }
  }
}

/**
 * Emit the "TypeScript too old" stub declaration into the build output. The
 * package.json `types`, `typesVersions`, and `types@<min>` export condition
 * (set by scripts/updateVersion.mjs) all point at this file so a consumer
 * whose TypeScript cannot read the package.json "exports" map gets a clear
 * upgrade message instead of a misleading "Cannot find module".
 *
 * @param {string} outputPath
 */
function writeTypeScriptTooOldStub(outputPath) {
  fs.writeFileSync(
    path.resolve(outputPath, TYPESCRIPT_TOO_OLD_BASENAME),
    getTypeScriptTooOldStub(),
  );
}

async function buildAll() {
  // Always emit .d.ts for npm builds so a `pnpm link` consumer gets types
  // out of the box. Skip for www (it consumes Flow stubs instead).
  if (!isWWW) {
    await buildTSDeclarationFiles();
  }

  /** @type {Array<'cjs' | 'esm'>} */
  const formats = isWWW ? ['cjs'] : ['cjs', 'esm'];
  for (const pkg of packagesManager.getPublicPackages()) {
    const {name, sourcePath, outputPath, packageName, modules} =
      pkg.getPackageBuildDefinition({consolidateBrowserSource: isWWW});
    const {version} = pkg.packageJson;
    for (const module of modules) {
      for (const format of formats) {
        const {sourceFileName, outputFileName} = module;
        let inputFile = path.resolve(sourcePath, sourceFileName);
        if (
          isWWW &&
          module.browserSourceFileName &&
          module.sourceFileName.endsWith('.ts')
        ) {
          const wwwCjs = inputFile.replace(/\.ts$/, '.www.cjs');
          if (fs.existsSync(wwwCjs)) {
            inputFile = wwwCjs;
          }
        }
        const primaryExports = await build(
          name,
          inputFile,
          outputPath,
          path.resolve(
            outputPath,
            getFileName(outputFileName, isProduction, format),
          ),
          isProduction,
          format,
          version,
          pkg,
        );

        // In release mode, also build the opposite variant so the published
        // package contains both .dev and .prod files for every entry point.
        let secondaryExports;
        if (isRelease) {
          secondaryExports = await build(
            name,
            inputFile,
            outputPath,
            path.resolve(
              outputPath,
              getFileName(outputFileName, !isProduction, format),
            ),
            !isProduction,
            format,
            version,
            pkg,
          );
        }

        // www has its own consolidation step (prepare-www) and does not use
        // the npm-style fork modules.
        if (!isWWW) {
          const mode = isRelease ? 'both' : isProduction ? 'prod' : 'dev';
          buildForkModules(
            outputPath,
            outputFileName,
            format,
            primaryExports.length > 0
              ? primaryExports
              : (secondaryExports ?? []),
            mode,
          );
        }
      }
    }

    if (!isWWW) {
      moveTSDeclarationFilesIntoDist(packageName, outputPath);
      writeTypeScriptTooOldStub(outputPath);
      copyFlowStubsIntoDist(pkg, outputPath);
    }
  }
}

buildAll();
