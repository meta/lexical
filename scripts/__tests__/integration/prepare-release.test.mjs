/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check
import fs from 'fs-extra';
import {glob} from 'glob';
import path from 'node:path';
import {describe, expect, test} from 'vitest';

import {packagesManager} from '../../shared/packagesManager.mjs';
import {
  describeDevExample,
  describeExample,
  describeLinkedFixture,
  hasLinkProtocolDeps,
} from './utils.mjs';

describe('prepare-release tests', () => {
  for (const pkg of packagesManager.getPublicPackages()) {
    describe(pkg.getNpmName(), () => {
      const tgzPath = path.join(
        'npm',
        `${pkg.getDirectoryName()}-${pkg.packageJson.version}.tgz`,
      );
      test(`${tgzPath} exists`, () =>
        expect(fs.existsSync(tgzPath)).toBe(true));
    });
  }
});
// Fixtures that declare `link:` deps are exercised through pnpm's symlink
// flow; the rest are installed from the packed tarballs prepare-release just
// produced, layered into each project's pnpm-workspace.yaml as overrides.
['examples', 'scripts/__tests__/integration/fixtures']
  .flatMap(packagesDir =>
    glob.sync(`${packagesDir}/*/package.json`, {windowsPathsNoEscape: true}),
  )
  .forEach(packageJsonPath => {
    const packageJson = fs.readJsonSync(packageJsonPath);
    if (hasLinkProtocolDeps(packageJson)) {
      describeLinkedFixture(packageJsonPath);
    } else {
      describeExample(packageJsonPath);
    }
  });
// dev-examples use workspace:* deps and are tested with pnpm workspace
// linking rather than published tarballs
glob
  .sync('dev-examples/*/package.json', {windowsPathsNoEscape: true})
  .forEach(exampleJsonPath => describeDevExample(exampleJsonPath));
