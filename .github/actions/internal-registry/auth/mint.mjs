/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Mints a short-lived registry credential from the job's GitHub OIDC identity.
//
// Two hops: the Actions token service issues an OIDC id_token for a fixed
// audience, and the identity provider exchanges that for a registry
// credential. Nothing is cached or persisted beyond the job.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OIDC_AUDIENCE = 'meta_jwt_access_token';
const EXCHANGE_URL =
  'https://www.internalfb.com/intern/crypto_jwt/access_token_exchange/';
const EXCHANGE_PEER = 'metaccio';
const EXCHANGE_AUDIENCE = 'metaccio';

// Neither hop has a default timeout under Node's global fetch, and a hung
// request would burn the job's whole timeout budget with no useful log line.
const OIDC_TIMEOUT_MS = 20_000;
const EXCHANGE_TIMEOUT_MS = 25_000;

const REGISTRY_URL = (process.env.REGISTRY_URL ?? '').trim();
const SCOPES = (process.env.REGISTRY_SCOPES ?? '').split(/\s+/).filter(Boolean);
const WRITE_NPMRC = (process.env.WRITE_NPMRC ?? 'true') !== 'false';
const ON_MISSING_OIDC = (process.env.ON_MISSING_OIDC ?? 'fail').trim();

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function setOutput(name, value) {
  // A delimiter rather than `name=value`, so a value that is not what we
  // expect cannot inject further workflow commands.
  const delimiter = `ghadelim_${name}`;
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
  );
}

if (!REGISTRY_URL) {
  fail('registry-url is empty.');
}

let registry;
try {
  registry = new URL(REGISTRY_URL);
} catch {
  fail(`registry-url is not a valid URL: ${REGISTRY_URL}`);
}

const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

if (!requestUrl || !requestToken) {
  if (ON_MISSING_OIDC === 'skip') {
    console.warn(
      '::notice::No OIDC identity available (most likely a fork pull request) — skipping.',
    );
    setOutput('token', '');
    setOutput('subject', '');
    process.exit(0);
  }
  fail(
    'This job has no OIDC identity. Add `permissions: id-token: write` to the ' +
      'job — a job-level permissions block replaces the workflow-level one, so ' +
      'it has to be set on the job itself, not only on the workflow.',
  );
}

async function fetchIdToken() {
  const response = await fetch(`${requestUrl}&audience=${OIDC_AUDIENCE}`, {
    headers: {Authorization: `bearer ${requestToken}`},
    signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
  });
  if (!response.ok) {
    fail(`Could not obtain an OIDC id_token (HTTP ${response.status}).`);
  }
  const {value} = await response.json();
  if (!value) {
    fail('The OIDC token service returned an empty id_token.');
  }
  return value;
}

async function exchangeForCredential(idToken) {
  const response = await fetch(EXCHANGE_URL, {
    body: new URLSearchParams({
      audience: EXCHANGE_AUDIENCE,
      id_token: idToken,
      peer: EXCHANGE_PEER,
    }),
    headers: {
      Accept: 'application/jwt',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    method: 'POST',
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
  if (!response.ok) {
    fail(
      `Token exchange failed (HTTP ${response.status}). A 403 usually means ` +
        'this repository has not been granted access to the registry yet.',
    );
  }
  const credential = (await response.text()).trim();
  // A JWS is three dot-separated segments; anything else is an error page.
  if (credential.split('.').length !== 3) {
    fail('Token exchange did not return a credential.');
  }
  return credential;
}

function subjectOf(credential) {
  try {
    const claims = JSON.parse(
      Buffer.from(credential.split('.')[1], 'base64url').toString('utf8'),
    );
    return claims.sub;
  } catch {
    return undefined;
  }
}

const credential = await exchangeForCredential(await fetchIdToken());

// Mask before the credential can reach any later log line.
process.stdout.write(`::add-mask::${credential}\n`);

// The subject is not a secret, and it is the exact string the registry
// authorizes against. Printing it turns an opaque rejection into a
// self-diagnosing one.
const subject = subjectOf(credential) ?? '<could not decode>';
console.warn(`Credential minted for subject: ${subject}`);

setOutput('token', credential);
setOutput('subject', subject);

if (WRITE_NPMRC) {
  // setup-node points npm at a config under RUNNER_TEMP when its own
  // `registry-url` is set; respect that, or npm reads ~/.npmrc and never sees
  // these lines. Writing *user* config also means npm finds the credential
  // from any working directory — a project-local .npmrc does not, because npm
  // does not walk up from the directory it publishes from.
  const npmrc =
    process.env.NPM_CONFIG_USERCONFIG || path.join(os.homedir(), '.npmrc');
  const authKey = `//${registry.host}${registry.pathname.replace(/\/?$/, '/')}:_authToken`;
  const lines = [
    ...SCOPES.map(scope => `${scope}:registry=${REGISTRY_URL}`),
    `${authKey}=${credential}`,
  ];
  // Appended, not overwritten: setup-node may already have written an entry
  // that a dual-target publish still needs. npm's ini parse is last-wins, so a
  // scope written above is redirected by ours.
  fs.mkdirSync(path.dirname(npmrc), {recursive: true});
  fs.appendFileSync(npmrc, `\n${lines.join('\n')}\n`);
  console.warn(
    SCOPES.length > 0
      ? `Routed ${SCOPES.join(', ')} to ${REGISTRY_URL} (${npmrc})`
      : `Wrote the registry credential to ${npmrc}`,
  );
}
