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

import {transformPureAnnotations} from '../../../packages/lexical-compiler/src/passes/pureAnnotations.mjs';
import {packagesManager} from '../../shared/packagesManager.mjs';

// The sources carry no `/* @__PURE__ */` annotations and still call the
// trivial factories; the build injects the annotations and inlines those
// calls with @lexical/compiler, so that a consumer's bundler can drop
// the extension, command, and rule definitions their app never uses. Guard
// both: re-running the transform over each built artifact must find nothing
// left to annotate and nothing left to inline. A failure means the transform
// did not make it into the published output (e.g. the plugin was dropped from
// scripts/build.mjs, or it stopped recognizing the code it produced), which
// downstream consumers would only notice as a silently larger bundle.
describe('published builds carry the pure annotations', () => {
  for (const pkg of packagesManager.getPublicPackages()) {
    test(pkg.getNpmName(), () => {
      const files = glob.sync(pkg.resolve('dist', '*.{js,mjs}'), {
        windowsPathsNoEscape: true,
      });
      expect(files).not.toHaveLength(0);
      const offenders = files.flatMap(fn => {
        const result = transformPureAnnotations(fs.readFileSync(fn, 'utf8'), {
          filename: fn,
          inline: true,
        });
        return result === null
          ? []
          : [
              `${path.relative(process.cwd(), fn)}: ${result.count} to annotate, ${
                result.inlined
              } to inline`,
            ];
      });
      expect(offenders).toEqual([]);
    });
  }
});
