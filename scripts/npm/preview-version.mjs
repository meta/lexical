#!/usr/bin/env node

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Stamp the monorepo with a unique preview version before a pkg.pr.new
// continuous release (.github/workflows/pkg-pr-new.yml).
//
// Previews sit next to the npm channels in the same version line as the
// nightlies. From a monorepo at 0.52.0:
//
//   nightly (npm)       0.52.1-nightly.20261019.0
//   main (pkg.pr.new)   0.52.1-main.g4282a68
//   PR (pkg.pr.new)     0.52.1-pr.9372.g4282a68
//
// so every preview is newer than the latest release and older than the next
// one, and two commits never share a version. The commit hash carries git
// describe's `g` prefix because a bare abbreviated hash can be all digits with
// a leading zero, which is not a valid semver identifier.
//
// The version is written before the build (as postversion.mjs does for the
// npm channels) rather than with `pkg-pr-new --previewVersion`, which only
// rewrites package.json at pack time: building after the bump also stamps it
// into the bundles, so `LexicalEditor.version` names the preview a bug report
// came from.
//
// This deliberately does not run `pnpm version`, whose postversion hook
// commits, tags and pushes a release branch.

import fs from 'fs-extra';
import minimist from 'minimist';
import path from 'node:path';
import semver from 'semver';

import {spawn} from '../shared/childProcess.mjs';

const argv = minimist(process.argv.slice(2), {string: ['pr', 'sha']});

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} version
 * @param {{pr?: string, sha: string}} options
 * @returns {string}
 */
function previewVersion(version, {pr, sha}) {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    fail(`Expected --sha to be a commit hash, got: ${sha}`);
  }
  if (pr && !/^[1-9][0-9]*$/.test(pr)) {
    fail(`Expected --pr to be a pull request number, got: ${pr}`);
  }
  const base = semver.inc(version, 'patch');
  if (!base) {
    fail(`Cannot derive a preview version from ${version}`);
  }
  const channel = pr ? `pr.${pr}` : 'main';
  const next = `${base}-${channel}.g${sha.slice(0, 7).toLowerCase()}`;
  if (!semver.valid(next)) {
    fail(`Derived an invalid preview version: ${next}`);
  }
  return next;
}

async function main() {
  const packageJsonPath = path.resolve(
    import.meta.dirname,
    '../../package.json',
  );
  const packageJson = fs.readJsonSync(packageJsonPath);
  const version = previewVersion(packageJson.version, {
    pr: argv.pr || undefined,
    sha: argv.sha || '',
  });
  console.log(`Preview version: ${packageJson.version} -> ${version}`);
  packageJson.version = version;
  fs.writeJsonSync(packageJsonPath, packageJson, {spaces: 2});
  // Propagate to every package.json, workspace dependency and generated
  // version module, exactly as the npm release channels do.
  await spawn('pnpm', ['run', 'update-version'], {stdio: 'inherit'});
  const {GITHUB_OUTPUT} = process.env;
  if (GITHUB_OUTPUT) {
    fs.appendFileSync(GITHUB_OUTPUT, `version=${version}\n`);
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
