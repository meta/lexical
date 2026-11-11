/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @ts-check

import {sync as globSync} from 'glob';
import minimist from 'minimist';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {gt as semverGt} from 'semver';

import {spawn} from './shared/childProcess.mjs';
import {PackageMetadata} from './shared/PackageMetadata.mjs';

async function main() {
  const argv = minimist(process.argv.slice(2));
  const {version} = new PackageMetadata('package.json').packageJson;
  /** @type {string[]} */
  const paths =
    argv._.length > 0
      ? argv._
      : ['examples/*', 'scripts/__tests__/integration/fixtures/*'];
  for (const fn of paths.flatMap(dir =>
    globSync(path.join(dir, 'package.json'), {windowsPathsNoEscape: true}),
  )) {
    const pkg = new PackageMetadata(fn);
    console.log(`\nUpdating example ${path.dirname(fn)}\n`);
    // assume that pnpm run update-packages has already updated the version and lexical deps
    const json = pkg.packageJson;
    const {lexicalUnreleasedDependencies = {}} = json;
    let hasUnreleasedDependency = false;
    for (const [k, v] of Object.entries(lexicalUnreleasedDependencies)) {
      if (semverGt(version, v)) {
        delete lexicalUnreleasedDependencies[k];
        json.dependencies[k] = version;
      } else {
        hasUnreleasedDependency = true;
      }
    }
    pkg
      .sortDependencies('dependencies')
      .sortDependencies(
        'lexicalUnreleasedDependencies',
        lexicalUnreleasedDependencies,
      )
      .writeSync();
    /**
     * @param {...string} args arguments to pass to the pnpm command
     * @returns {Promise<void>}
     */
    const pnpm = async (...args) => {
      console.log(['>', 'pnpm', ...args].join(' '));
      try {
        await spawn('pnpm', args, {
          cwd: pkg.resolve(),
          env: {...process.env, PNPM_SCRIPT_SRC_DIR: pkg.resolve()},
          stdio: 'inherit',
        });
      } catch (err) {
        console.error(`\nFailed to update example ${path.dirname(fn)}`);
        // `spawn` rejects with an Error that carries an optional numeric `code`
        const error = /** @type {{code?: unknown}} */ (err);
        process.exit(
          'code' in error && typeof error.code === 'number' ? error.code : 1,
        );
      }
    };
    // No --ignore-workspace: each example carries its own
    // pnpm-workspace.yaml, which already keeps the install out of the
    // monorepo workspace, and which the flag would suppress along with
    // the example's own overrides and build-script decisions.
    await pnpm('--no-frozen-lockfile', 'i');
    if (hasUnreleasedDependency) {
      console.log(
        'Unreleased lexical dependencies required, removing local versions',
      );
      for (const dir of [
        pkg.resolve('node_modules', '{lexical,@lexical}'),
      ].flatMap(v => globSync(v))) {
        console.log(`> rm -rf ${dir}`);
        fs.rmSync(dir, {force: true, recursive: true});
      }
    }
    await pnpm(
      'run',
      'build',
      ...(hasUnreleasedDependency
        ? ['--', '-c', 'vite.config.monorepo.ts']
        : []),
    );
  }
}

main();
