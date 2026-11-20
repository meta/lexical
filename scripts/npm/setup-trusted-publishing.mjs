#!/usr/bin/env node

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import fs from 'fs-extra';
import minimist from 'minimist';
import os from 'node:os';
import path from 'node:path';

import {exec} from '../shared/childProcess.mjs';
import {packagesManager} from '../shared/packagesManager.mjs';

// Declare the boolean flags explicitly. Otherwise minimist greedily
// consumes the following token as the flag's value, so
// `--setup-trust @lexical/a11y` parses as {'setup-trust': '@lexical/a11y'}
// with an empty `_` — the positional package name is swallowed and every
// package gets processed instead of just the one requested.
const argv = minimist(process.argv.slice(2), {
  boolean: ['bootstrap', 'setup-trust', 'dry-run', 'replace'],
});
const bootstrap = !!argv.bootstrap;
const setupTrust = !!argv['setup-trust'];
const dryRun = !!argv['dry-run'];
const registry = (argv.registry || 'https://registry.npmjs.org').replace(
  /\/+$/,
  '',
);
const stubVersion = argv['stub-version'] || '0.0.0-bootstrap.0';
// `workflow` is the *calling* workflow filename — the one that
// triggered the run, not the reusable workflow that contains the
// publish job. npm matches `claims.workflow_ref.file` against the OIDC
// token's `workflow_ref` claim, which is the caller (same as PyPI;
// the OIDC `job_workflow_ref` claim points at the reusable file but
// npm doesn't check that).
//
// npm currently enforces one trust configuration per package — POSTing
// a second config (even for a different workflow) returns E409. So
// `--workflow` takes a single filename; switching workflows means
// revoking the old config first, which `--replace` automates.
const workflow = argv.workflow || 'pre-release.yml';
if (typeof workflow !== 'string' || workflow.includes(',')) {
  console.error(
    `--workflow takes a single filename (npm allows one trust config per package). Got: ${workflow}`,
  );
  process.exit(1);
}
const replace = !!argv.replace;
const repo = argv.repo || 'meta/lexical';

const [repoOwner, repoName] = repo.split('/');
if (!repoOwner || !repoName) {
  console.error(`Invalid --repo value '${repo}'. Expected owner/name.`);
  process.exit(1);
}

// Optional package targeting. Positional args and/or repeated `--package`
// restrict the run to just those packages (matched by npm name, e.g.
// `@lexical/a11y`, or the unscoped short name, e.g. `a11y`). The common
// workflow going forward is bootstrapping one new package and configuring its
// trust without re-touching the 30+ already-configured ones. With no targets,
// every public package is processed (the original behavior).
const targetNames = [
  ...argv._.map(String),
  ...(argv.package === undefined ? [] : [].concat(argv.package).map(String)),
];

/**
 * @param {string} name
 * @returns {Promise<boolean>}
 */
async function packageExistsOnRegistry(name) {
  const res = await fetch(`${registry}/${name}`, {method: 'HEAD'});
  if (res.status === 404) {
    return false;
  }
  if (res.ok) {
    return true;
  }
  throw new Error(`Unexpected status ${res.status} from ${registry}/${name}`);
}

/**
 * @param {string} dir
 * @param {import('../shared/PackageMetadata.mjs').PackageMetadata} pkg
 */
async function writeStubFiles(dir, pkg) {
  await fs.writeJson(
    path.join(dir, 'package.json'),
    {
      description:
        'Placeholder published to claim the npm name during trusted publishing setup. Do not install.',
      homepage: 'https://lexical.dev',
      license: 'MIT',
      name: pkg.getNpmName(),
      repository: {
        type: 'git',
        url: `git+https://github.com/${repo}.git`,
      },
      version: stubVersion,
    },
    {spaces: 2},
  );
  await fs.writeFile(
    path.join(dir, 'README.md'),
    `# ${pkg.getNpmName()}\n\n` +
      `This ${stubVersion} placeholder was published only to claim the npm ` +
      `package name so trusted publishing can be configured on npmjs.com. ` +
      `It contains no code; a future release will replace it.\n`,
  );
  const license = pkg.resolve('LICENSE');
  if (await fs.pathExists(license)) {
    await fs.copy(license, path.join(dir, 'LICENSE'));
  }
}

/**
 * @param {import('../shared/PackageMetadata.mjs').PackageMetadata} pkg
 */
async function publishStub(pkg) {
  const name = pkg.getNpmName();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexical-stub-'));
  try {
    await writeStubFiles(tmpDir, pkg);
    if (dryRun) {
      console.log(`[dry-run] Would publish ${name}@${stubVersion}`);
      return;
    }
    // Publish via runNpm so stdin/stdout stay TTYs and npm can run its
    // interactive OTP / web-auth recovery — a captured exec() dies with
    // EOTP instead of prompting.
    console.log(
      `\nPublishing ${name}@${stubVersion} (npm may prompt for OTP / web auth):`,
    );
    const {code} = await runNpm(
      [
        'publish',
        '--registry',
        registry,
        '--access',
        'public',
        '--tag',
        'bootstrap',
      ],
      {cwd: tmpDir},
    );
    if (code !== 0) {
      throw new Error(`npm publish exited with code ${code}`);
    }
    console.log(`Published ${name}@${stubVersion}`);
    // Mark the stub as deprecated so anyone who accidentally installs it
    // sees a warning. Failure here is non-fatal — the stub is already
    // published, which is what unblocks trusted publishing setup.
    const deprecateResult = await runNpm([
      'deprecate',
      '--registry',
      registry,
      `${name}@${stubVersion}`,
      'Bootstrap placeholder for trusted publishing setup; do not install',
    ]);
    if (deprecateResult.code !== 0) {
      console.warn(
        `(Could not deprecate ${name}@${stubVersion}: npm exit ${deprecateResult.code})`,
      );
    }
  } finally {
    await fs.remove(tmpDir);
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract the workflow filename from a stored trust config. Handles
 * both the flattened shape returned by `npm trust list --json`
 * (`{file}`) and the raw registry shape (`{claims:{workflow_ref:
 * {file}}}`).
 *
 * @param {any} config
 * @returns {string | undefined}
 */
function configFile(config) {
  if (!config || typeof config !== 'object') {
    return undefined;
  }
  if (config.file) {
    return config.file;
  }
  const claims = config.claims || {};
  const ref = claims.workflow_ref || {};
  return ref.file;
}

/**
 * Extract the repository (owner/name) from a stored trust config,
 * handling both the flattened and raw shapes.
 *
 * @param {any} config
 * @returns {string | undefined}
 */
function configRepo(config) {
  if (!config || typeof config !== 'object') {
    return undefined;
  }
  return config.repository || (config.claims && config.claims.repository);
}

/**
 * Extract the environment name from a stored trust config (empty/
 * undefined means "no environment"), handling both shapes.
 *
 * @param {any} config
 * @returns {string | undefined}
 */
function configEnvironment(config) {
  if (!config || typeof config !== 'object') {
    return undefined;
  }
  return config.environment || (config.claims && config.claims.environment);
}

/**
 * Fetch the current list of trusted publisher configurations for a
 * package via `npm trust list --json`. This deliberately shells out to
 * the npm CLI so it uses npm's own auth resolution — exactly the auth
 * `npm whoami` and `npm trust github` already use — rather than a
 * hand-rolled token lookup that can silently come up empty (e.g. after
 * a browser `npm login` on macOS). It captures stdout to parse the
 * JSON; the session must already be authenticated (see warmTrustAuth)
 * because a captured (non-TTY-stdout) call can't satisfy a fresh OTP
 * challenge.
 *
 * Returns `{configs}` ([] when the package has no trust config, else
 * the parsed config entries), or `{error}` with a human-readable
 * message when the lookup genuinely failed (auth / network / OTP),
 * so the caller can surface it instead of silently swallowing it.
 *
 * @param {string} name
 * @returns {Promise<{configs?: Array<any>, error?: string}>}
 */
async function fetchTrustConfigs(name) {
  const {code, stdout, stderr} = await runNpm(
    ['trust', 'list', name, '--json', '--registry', registry],
    {captureStdout: true},
  );
  const combined = `${stdout}\n${stderr}`;
  // A package with no trust config yet 404s — treat as "no configs".
  if (/E404|not found/i.test(combined)) {
    return {configs: []};
  }
  const text = stdout.trim();
  if (text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (parsed && parsed.error) {
      const errCode = String(parsed.error.code || '');
      if (/E404/i.test(errCode)) {
        return {configs: []};
      }
      return {error: parsed.error.summary || errCode || 'unknown error'};
    }
    if (parsed) {
      const items = Array.isArray(parsed) ? parsed : [parsed];
      return {configs: items.filter(Boolean)};
    }
  }
  if (code === 0) {
    // Succeeded with no parseable output → no configs.
    return {configs: []};
  }
  // Surface the first meaningful stderr line so the failure isn't silent.
  const firstLine = stderr
    .split('\n')
    .map(l => l.replace(/^npm (error|warn)\s*/i, '').trim())
    .find(l => l && !/^code\s/i.test(l));
  return {error: firstLine || `npm exited ${code}`};
}

/**
 * One-line summary of a stored trust config for log lines.
 *
 * @param {any} config
 * @returns {string}
 */
function describeConfig(config) {
  return configFile(config) || (config && config.type) || '?';
}

/**
 * Check whether a stored trust configuration entry matches the
 * (repository, workflow, no-environment, publish) tuple we're about
 * to register.
 *
 * @param {any} config
 * @returns {boolean}
 */
function configMatches(config) {
  if (!config || config.type !== 'github') {
    return false;
  }
  if (configRepo(config) !== repo) {
    return false;
  }
  if (configFile(config) !== workflow) {
    return false;
  }
  if (configEnvironment(config)) {
    return false;
  }
  // The config must grant the publish permission we register with
  // (`--allow-publish`). npm has used more than one label for this over
  // 11.x (`publish`, and previously `createPackage`), so accept either
  // rather than reporting a spurious CONFLICT on re-runs.
  return (
    Array.isArray(config.permissions) &&
    (config.permissions.includes('publish') ||
      config.permissions.includes('createPackage'))
  );
}

// pnpm exports its own (and pnpm-only) settings as `npm_config_*` env
// vars when running scripts. npm 11+ warns about every one of these it
// doesn't recognise ("Unknown env config ...") and threatens to error
// in npm 12. The actual env var names use underscores in place of the
// hyphens you'd see in the config key (npm normalizes back to hyphens
// when reading), so we strip both spellings to cover all observed
// shapes.
const PNPM_ONLY_NPM_CONFIG_KEYS = [
  'npm-globalconfig',
  'verify-deps-before-run',
  '_jsr-registry',
  'manage-package-manager-versions',
];

/**
 * @returns {NodeJS.ProcessEnv}
 */
function npmCleanEnv() {
  const env = {...process.env};
  for (const key of PNPM_ONLY_NPM_CONFIG_KEYS) {
    delete env[`npm_config_${key}`];
    delete env[`npm_config_${key.replace(/-/g, '_')}`];
  }
  return env;
}

/**
 * Spawn `npm`, capturing stderr so we can classify failures (E409
 * already-configured, E429 rate-limit, etc.).
 *
 * stdin and stdout are inherited by default so npm's interactive
 * web-auth / OTP flow works — npm only attempts that recovery when
 * BOTH stdin and stdout are TTYs (see otplease in npm's source). For
 * commands whose stdout we need to read back (e.g. `npm trust list
 * --json`), pass `captureStdout: true`; note that piping stdout makes
 * it a non-TTY, so a fresh OTP challenge can't be satisfied during a
 * captured call — warm the auth session first (see warmTrustAuth).
 *
 * @param {string[]} args
 * @param {{captureStdout?: boolean, cwd?: string}} [options]
 * @returns {Promise<{code: number | null, stdout: string, stderr: string}>}
 */
function runNpm(args, {captureStdout = false, cwd} = {}) {
  return new Promise(resolve => {
    // Lazy import; keeps top of file tidy and avoids extra weight on
    // dry-run/check-only paths.
    import('node:child_process').then(({spawn: spawnCb}) => {
      const child = spawnCb('npm', args, {
        cwd,
        env: npmCleanEnv(),
        stdio: ['inherit', captureStdout ? 'pipe' : 'inherit', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      if (child.stdout) {
        child.stdout.on('data', chunk => {
          stdout += chunk.toString();
        });
      }
      if (child.stderr) {
        child.stderr.on('data', chunk => {
          process.stderr.write(chunk);
          stderr += chunk.toString();
        });
      }
      child.on('close', code => {
        resolve({code, stderr, stdout});
      });
      child.on('error', err => {
        resolve({code: -1, stderr: stderr + String(err), stdout});
      });
    });
  });
}

/**
 * Establish an authenticated trust-API session interactively, so the
 * captured `npm trust list` reads that follow don't each hit an OTP
 * challenge they can't satisfy (a captured call pipes stdout, and npm
 * only does web-auth when stdout is a TTY).
 *
 * Runs `npm trust list <sampleName>` with all stdio inherited (full
 * TTY) so npm can open the browser / prompt. The user should pick
 * "skip two-factor authentication for the next 5 minutes" so the rest
 * of the run sails through. Returns true if the sample read succeeded.
 *
 * @param {string} sampleName
 * @returns {Promise<boolean>}
 */
async function warmTrustAuth(sampleName) {
  console.log(
    `\nAuthenticating for trust API access via \`npm trust list ${sampleName}\`.`,
  );
  console.log(
    `If npm prompts, complete the web auth and choose "Skip two-factor`,
  );
  console.log(
    `authentication for the next 5 minutes" so the per-package checks and`,
  );
  console.log(`updates that follow don't each re-prompt.\n`);
  return new Promise(resolve => {
    import('node:child_process').then(({spawn: spawnCb}) => {
      const child = spawnCb(
        'npm',
        ['trust', 'list', sampleName, '--registry', registry],
        {env: npmCleanEnv(), stdio: 'inherit'},
      );
      child.on('close', code => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  });
}

// Per-package retry policy for E429 (registry rate-limit). Exponential
// backoff starting at 5 s, capped at 60 s, up to 4 attempts total.
const MAX_TRUST_ATTEMPTS = 4;
const RATE_LIMIT_BACKOFF_BASE_MS = 5_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 60_000;

/**
 * Revoke a single trust config by ID.
 *
 * @param {string} pkgName
 * @param {string} id
 * @returns {Promise<boolean>} true on success
 */
async function revokeTrustConfig(pkgName, id) {
  if (dryRun) {
    console.log(
      `  ${pkgName} ... [dry-run] npm trust revoke ${pkgName} --id=${id}`,
    );
    return true;
  }
  console.log(`\nRevoking existing trust config ${id} on ${pkgName}:`);
  const args = [
    'trust',
    'revoke',
    pkgName,
    `--id=${id}`,
    '--registry',
    registry,
  ];
  const {code} = await runNpm(args);
  if (code === 0) {
    console.log(`  ${pkgName} ... revoked ${id}\n`);
    return true;
  }
  console.error(`  ${pkgName} ... revoke FAILED (npm exit ${code})\n`);
  return false;
}

/**
 * Run `npm trust github` for one package. stdio is wired up so the
 * OTP / web-auth URL streams to the terminal while we still capture
 * stderr to tell an `E409 Conflict` (the registry's way of saying
 * "this exact trust config already exists") apart from real failures,
 * and to back off and retry on `E429 Too Many Requests`.
 *
 * @param {import('../shared/PackageMetadata.mjs').PackageMetadata} pkg
 * @returns {Promise<'configured' | 'already-configured' | 'dry-run' | 'failed'>}
 */
async function addTrustConfig(pkg) {
  const name = pkg.getNpmName();
  const args = [
    'trust',
    'github',
    name,
    '--file',
    workflow,
    '--repo',
    repo,
    // A permission flag is required: recent npm (>= 11.18) rejects
    // `npm trust github` with "At least one permission flag is required
    // (--allow-publish, --allow-stage-publish)" when none is given.
    // `--allow-publish` grants the ordinary publish permission.
    '--allow-publish',
    '--registry',
    registry,
    '-y',
  ];
  if (dryRun) {
    console.log(`  ${name} ... [dry-run] npm ${args.join(' ')}`);
    return 'dry-run';
  }
  console.log(`\nConfiguring ${name} (npm will prompt for OTP / web auth):`);
  for (let attempt = 1; attempt <= MAX_TRUST_ATTEMPTS; attempt++) {
    const {code, stderr} = await runNpm(args);
    if (code === 0) {
      console.log(`  ${name} ... configured\n`);
      return 'configured';
    }
    if (/code E409|409 Conflict/i.test(stderr)) {
      console.log(`  ${name} ... already configured (server returned 409)\n`);
      return 'already-configured';
    }
    if (
      /code E429|429 Too Many Requests/i.test(stderr) &&
      attempt < MAX_TRUST_ATTEMPTS
    ) {
      const backoff = Math.min(
        RATE_LIMIT_BACKOFF_MAX_MS,
        RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (attempt - 1),
      );
      console.log(
        `  ${name} ... rate-limited (E429); waiting ${Math.round(backoff / 1000)}s before retry (attempt ${attempt + 1}/${MAX_TRUST_ATTEMPTS})`,
      );
      await sleep(backoff);
      continue;
    }
    console.error(`  ${name} ... FAILED (npm exit ${code})\n`);
    return 'failed';
  }
  console.error(
    `  ${name} ... FAILED (gave up after ${MAX_TRUST_ATTEMPTS} attempts)\n`,
  );
  return 'failed';
}

async function checkAuth() {
  try {
    const {stdout} = await exec(`npm whoami --registry ${registry}`);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Ensure the local npm CLI supports `npm trust github`. The subcommand
 * was added in npm 11.5; we require 11.10+ to match the upstream
 * trusted-publishing docs.
 *
 * @returns {Promise<{ok: true, version: string} | {ok: false, reason: string}>}
 */
async function checkNpmTrustSupport() {
  /** @type {string} */
  let version;
  try {
    const {stdout} = await exec(`npm --version`);
    version = stdout.trim();
  } catch (err) {
    return {
      ok: false,
      reason: `Could not run 'npm --version': ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const parts = version.split('.').map(n => parseInt(n, 10));
  const [major = 0, minor = 0] = parts;
  if (major < 11 || (major === 11 && minor < 10)) {
    return {
      ok: false,
      reason: `npm ${version} is too old for 'npm trust github'. Upgrade to npm >= 11.10 (\`npm i -g npm@latest\`) and re-run.`,
    };
  }
  try {
    await exec(`npm trust --help`);
  } catch (err) {
    return {
      ok: false,
      reason: `'npm trust' is not available in this npm (${version}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return {ok: true, version};
}

/**
 * @param {Array<{pkg: import('../shared/PackageMetadata.mjs').PackageMetadata, existing: Array<any>}>} entries
 */
function printManualSetup(entries) {
  if (entries.length === 0) {
    return;
  }
  console.log('\n--- Trusted publishing setup ---');
  console.log(
    `Re-run with --setup-trust to configure these via \`npm trust github\``,
  );
  console.log(
    `(use --replace if any package already has a non-matching config),`,
  );
  console.log('or set them up manually on npmjs.com with:');
  console.log('  Publisher:         GitHub Actions');
  console.log(`  Repository owner:  ${repoOwner}`);
  console.log(`  Repository name:   ${repoName}`);
  console.log(`  Workflow filename: ${workflow}`);
  console.log('  Environment:       (leave empty)');
  console.log('  Permissions:       Allow publish');
  console.log('');
  for (const entry of entries) {
    const name = entry.pkg.getNpmName();
    const existingNote =
      entry.existing.length > 0
        ? ` (will conflict with ${entry.existing.length} existing config; use --replace)`
        : '';
    console.log(`  ${name}${existingNote}`);
    console.log(`    https://www.npmjs.com/package/${name}/access`);
  }
}

async function main() {
  let pkgs = packagesManager.getPublicPackages();
  if (targetNames.length > 0) {
    /** @type {Map<string, (typeof pkgs)[number]>} */
    const byKey = new Map();
    for (const pkg of pkgs) {
      const npmName = pkg.getNpmName();
      byKey.set(npmName, pkg);
      const slash = npmName.indexOf('/');
      if (slash !== -1) {
        byKey.set(npmName.slice(slash + 1), pkg);
      }
    }
    /** @type {typeof pkgs} */
    const selected = [];
    const seen = new Set();
    const unknown = [];
    for (const name of targetNames) {
      const pkg = byKey.get(name);
      if (!pkg) {
        unknown.push(name);
      } else if (!seen.has(pkg.getNpmName())) {
        seen.add(pkg.getNpmName());
        selected.push(pkg);
      }
    }
    if (unknown.length > 0) {
      console.error(
        `Unknown package(s): ${unknown.join(', ')}\n` +
          `Valid names: ${pkgs.map(p => p.getNpmName()).join(', ')}`,
      );
      process.exit(1);
    }
    pkgs = selected;
  }
  console.log(
    `Checking ${pkgs.length} public package(s) against ${registry}\n`,
  );

  const willWrite = (bootstrap || setupTrust) && !dryRun;
  if (willWrite) {
    const authedUser = await checkAuth();
    if (!authedUser) {
      console.error(
        `npm whoami failed for ${registry}. Run 'npm login --registry ${registry}' before re-running.`,
      );
      process.exit(1);
    }
    console.log(`Authenticated to ${registry} as ${authedUser}\n`);
  }

  if (setupTrust && !dryRun) {
    const trustSupport = await checkNpmTrustSupport();
    if (!trustSupport.ok) {
      console.error(trustSupport.reason);
      process.exit(1);
    }
    console.log(`Using npm ${trustSupport.version} (supports 'npm trust')\n`);
  }

  /** @type {Array<import('../shared/PackageMetadata.mjs').PackageMetadata>} */
  const missing = [];
  /** @type {Array<import('../shared/PackageMetadata.mjs').PackageMetadata>} */
  const existing = [];
  for (const pkg of pkgs) {
    const name = pkg.getNpmName();
    process.stdout.write(`  ${name} ... `);
    const exists = await packageExistsOnRegistry(name);
    if (exists) {
      console.log('exists');
      existing.push(pkg);
    } else {
      console.log('NOT FOUND');
      missing.push(pkg);
    }
  }

  /** @type {string[]} */
  const failures = [];

  if (missing.length > 0) {
    if (!bootstrap) {
      console.log(
        `\n${missing.length} package(s) are not on the registry yet:`,
      );
      for (const pkg of missing) {
        console.log(`  - ${pkg.getNpmName()}`);
      }
      console.log(
        `\nRe-run with --bootstrap to publish placeholder stubs that claim ` +
          `these names, then configure trusted publishing on npmjs.com.`,
      );
    } else {
      console.log(
        `\nPublishing ${missing.length} placeholder stub(s) at version ${stubVersion}...`,
      );
      for (const pkg of missing) {
        try {
          await publishStub(pkg);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `Failed to publish stub for ${pkg.getNpmName()}: ${message}`,
          );
          failures.push(pkg.getNpmName());
        }
      }
    }
  }

  // Packages that should get trust configured: everything that exists on
  // the registry, plus any stubs we just published.
  const trustCandidates = [
    ...existing,
    ...(bootstrap
      ? missing.filter(p => !failures.includes(p.getNpmName()))
      : []),
  ];

  // Pre-flight registry check: classify each package as
  //   - matching:  trust config already matches our target → skip
  //   - conflict:  has trust config but for a different workflow →
  //                blocked by npm's one-config-per-package limit;
  //                needs --replace to revoke first
  //   - none:      no trust config → safe to add
  //   - unknown:   couldn't check (auth issue / network) → try the
  //                add anyway and let npm decide
  /** @type {Array<{pkg: import('../shared/PackageMetadata.mjs').PackageMetadata, existing: Array<any>}>} */
  const toRegister = [];
  /** @type {Array<{pkg: import('../shared/PackageMetadata.mjs').PackageMetadata, existing: Array<any>}>} */
  const conflicts = [];
  if (trustCandidates.length > 0) {
    // Reading the trust API (`npm trust list`) requires auth and may
    // require OTP. npm only runs its interactive web-auth recovery when
    // BOTH stdin and stdout are TTYs, but the per-package checks below
    // capture stdout (so they can parse JSON), which makes stdout a
    // non-TTY and prevents a fresh OTP challenge from being satisfied.
    // So do one fully-interactive read first to establish the session;
    // the user can pick "skip 2FA for 5 minutes" and the captured reads
    // then succeed within the window.
    const warmed = await warmTrustAuth(trustCandidates[0].getNpmName());
    if (!warmed) {
      console.log(
        `\nWarning: could not establish a trust-API session (the warmup ` +
          `\`npm trust list\` failed). Per-package checks may report ` +
          `"unable to check". Make sure \`npm whoami\` works.`,
      );
    }

    console.log(`\nTarget workflow: ${workflow}`);
    console.log(`\nChecking existing trust configuration:`);
    let anyUnknown = false;
    for (const pkg of trustCandidates) {
      const name = pkg.getNpmName();
      process.stdout.write(`  ${name} ... `);
      const {configs, error} = await fetchTrustConfigs(name);
      if (error || !configs) {
        console.log(`unable to check (${error || 'unknown'}); will try anyway`);
        anyUnknown = true;
        toRegister.push({existing: [], pkg});
        continue;
      }
      if (configs.some(configMatches)) {
        console.log('already configured');
        continue;
      }
      if (configs.length > 0) {
        const summary = configs.map(c => describeConfig(c)).join(', ');
        console.log(`CONFLICT: existing config(s) for [${summary}]`);
        conflicts.push({existing: configs, pkg});
        continue;
      }
      console.log('needs configuration');
      toRegister.push({existing: [], pkg});
    }
    if (anyUnknown) {
      console.log(
        `\nWarning: some packages could not be pre-checked. For those, an ` +
          `existing config can't be revoked automatically, so ` +
          `\`npm trust github\` may return E409 if one is already present. ` +
          `Confirm \`npm whoami\` succeeds and re-run.`,
      );
    }
  }

  if (setupTrust) {
    if (conflicts.length > 0 && !replace) {
      console.log(
        `\n${conflicts.length} package(s) have a non-matching trust config that would block re-registration:`,
      );
      for (const {pkg, existing: conflictConfigs} of conflicts) {
        const files = conflictConfigs.map(c => describeConfig(c)).join(', ');
        console.log(`  - ${pkg.getNpmName()} (existing: ${files})`);
      }
      console.log(
        `\nnpm allows only one trust configuration per package, so adding a new one returns E409 while the old one is present.`,
      );
      console.log(
        `Re-run with --replace to revoke the old config(s) and register the new one (each revoke + add still requires npm auth; "Skip 2FA for the next 5 minutes" on the first prompt covers the run).`,
      );
    }
    const actionable = replace ? [...toRegister, ...conflicts] : toRegister;
    if (actionable.length > 0) {
      console.log(
        `\n${actionable.length} package(s) need a trusted publisher registered.`,
      );
      console.log(
        `\nOn the first OTP / web-auth prompt, open the URL npm prints in your`,
      );
      console.log(
        `browser and select "Skip two-factor authentication for the next 5`,
      );
      console.log(
        `minutes" — subsequent calls in this run will then go through`,
      );
      console.log(`without re-prompting.\n`);
      for (let i = 0; i < actionable.length; i++) {
        const {pkg, existing: toRevoke} = actionable[i];
        // Brief pause between calls to stay under the registry's
        // E429 rate limit (npm docs recommend a short delay between
        // back-to-back `npm trust` calls).
        if (i > 0) {
          await sleep(2000);
        }
        if (toRevoke.length > 0) {
          let revokeOk = true;
          for (const cfg of toRevoke) {
            const id = cfg && cfg.id;
            if (!id) {
              continue;
            }
            const ok = await revokeTrustConfig(pkg.getNpmName(), id);
            if (!ok) {
              revokeOk = false;
              break;
            }
            await sleep(2000);
          }
          if (!revokeOk) {
            failures.push(`${pkg.getNpmName()} (revoke failed)`);
            continue;
          }
        }
        const result = await addTrustConfig(pkg);
        if (result === 'failed') {
          failures.push(pkg.getNpmName());
        }
      }
    }
  } else if (toRegister.length > 0 || conflicts.length > 0) {
    printManualSetup([...toRegister, ...conflicts]);
  }

  if (failures.length > 0) {
    throw new Error(
      `Setup did not complete for ${failures.length} package(s):\n - ${failures.join(
        '\n - ',
      )}`,
    );
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
