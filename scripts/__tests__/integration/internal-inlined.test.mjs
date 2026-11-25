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
import {describe, expect, test} from 'vitest';

import {packagesManager} from '../../shared/packagesManager.mjs';

// @lexical/internal is published only so its source resolves for the `source`
// export condition; the build inlines it into every other package rather than
// leaving a runtime dependency. Guard that invariant: no published build
// artifact (JS, MJS, or .d.ts) of any other package may reference the
// `@lexical/internal` specifier. A failure means it leaked out as an external
// (e.g. it was added to the build's externals/wwwMappings sets). Only a quoted
// specifier counts: dev builds keep comments, and an
// `eslint-disable @lexical/internal/...` directive in one is not a reference.
const INTERNAL_SPECIFIER = /(['"])@lexical\/internal(\/[^'"]*)?\1/;
describe('@lexical/internal is inlined out of published builds', () => {
  for (const pkg of packagesManager.getPublicPackages()) {
    if (pkg.getNpmName() === '@lexical/internal') {
      continue;
    }
    test(pkg.getNpmName(), () => {
      const files = glob.sync(pkg.resolve('dist', '**', '*.{js,mjs,d.ts}'), {
        windowsPathsNoEscape: true,
      });
      expect(files).not.toHaveLength(0);
      const offenders = files.filter(fn =>
        INTERNAL_SPECIFIER.test(fs.readFileSync(fn, 'utf8')),
      );
      expect(offenders).toEqual([]);
    });
  }
});
