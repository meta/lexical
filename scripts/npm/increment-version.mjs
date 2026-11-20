#!/usr/bin/env node

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import minimist from 'minimist';
import path from 'node:path';

import {breakingChangesets} from '../changesets/release.mjs';
import {readPending, ROOT} from '../changesets/repo.mjs';
import {spawn} from '../shared/childProcess.mjs';

const argv = minimist(process.argv.slice(2));

const increment = argv.i || process.env.INCREMENT;
const channel = argv.channel || process.env.CHANNEL;

const validChannels = new Set(['next', 'latest', 'nightly', 'dev']);
if (!validChannels.has(channel)) {
  console.error(`Invalid value for channel: ${channel}`);
  process.exit(1);
}

const validIncrements = new Set(['minor', 'patch', 'prerelease']);
if (
  !validIncrements.has(increment) ||
  (channel === 'nightly' && increment !== 'prerelease')
) {
  console.error(
    `Invalid value for increment in ${channel} channel: ${increment}`,
  );
  process.exit(1);
}

// A pending [breaking] changeset can only ship in a minor release. Refuse a
// latest patch release up front, before anything is bumped or pushed;
// postversion's update-changelog repeats the check as a safety net.
if (channel === 'latest' && increment === 'patch') {
  const breaking = breakingChangesets(
    readPending(path.join(ROOT, '.changeset'), ROOT),
  );
  if (breaking.length > 0) {
    console.error(
      `Refusing a patch release: ${breaking.length} pending [breaking] changeset(s) need a minor release:\n` +
        breaking.map(c => `  - ${c.file}: ${c.entry.summary}`).join('\n') +
        '\nRun the "Create New Release Branch" workflow with the "minor" increment.',
    );
    process.exit(1);
  }
}

function incrementArgs() {
  return [
    ...(increment === 'prerelease'
      ? [
          '--preid',
          channel === 'nightly'
            ? `${channel}.${new Date()
                .toISOString()
                .split('T')[0]
                .replaceAll('-', '')}`
            : channel,
        ]
      : []),
    increment,
  ];
}

async function incrementVersion() {
  const commandArr = [
    'pnpm',
    'version',
    '--no-git-tag-version',
    ...incrementArgs(),
  ];
  console.log(commandArr.join(' '));
  await spawn(commandArr[0], commandArr.slice(1), {stdio: 'inherit'});
}

incrementVersion();
