/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @ts-check

import fs from 'fs-extra';
import path from 'node:path';

import {packagesManager} from './shared/packagesManager.mjs';

/**
 * @param {string} npmName the npm package name, e.g. '@lexical/rich-text'
 * @param {string} description the package description
 * @param {boolean} hasRootModule whether typedoc documents the package itself
 * @returns {string} the rendered README.md contents
 */
function readmeTemplate(npmName, description, hasRootModule) {
  // Derived from the npm name the way typedoc derives the module page it
  // links to: drop the leading `@` and turn the scope separator into an
  // underscore. Deriving it from the directory name instead (replacing every
  // hyphen) produced a 404 for any package with a hyphen of its own —
  // `@lexical/code-core` is documented at `lexical_code-core`, not
  // `lexical_code_core`.
  const apiModuleName = npmName.replace(/^@/, '').replace('/', '_');
  // Typedoc emits one page per entry point, so a package that does not export
  // its own name — `@lexical/react`, which is only ever imported one plugin at
  // a time — has no page under that name to link to. Linking it anyway is the
  // 404 the derivation above exists to avoid, one level up.
  const badge = hasRootModule
    ? `\n\n[![See API Documentation](https://lexical.dev/img/see-api-documentation.svg)](https://lexical.dev/docs/api/modules/${apiModuleName})`
    : '';
  return (
    `
    # \`${npmName}\`${badge}

${description}
`.trim() + '\n'
  );
}

function createDocs() {
  packagesManager.getPublicPackages().forEach(pkg => {
    const npmName = pkg.getNpmName();
    const root = pkg.resolve('..', '..');
    const readmePath = pkg.resolve('README.md');
    if (!fs.existsSync(readmePath)) {
      console.log(`Creating ${path.relative(root, readmePath)}`);
      fs.writeFileSync(
        readmePath,
        readmeTemplate(
          npmName,
          pkg.packageJson.description ||
            'TODO: This package needs a description!',
          pkg.getExportedNpmModuleNames().includes(npmName),
        ),
      );
    }
  });
}

createDocs();
