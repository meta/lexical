/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {transformAsync} from '@babel/core';
import {expect, test} from 'vitest';

import {getBuildBabelOptions} from '../../shared/buildOptions.mjs';

test('preserves native fields and lowers static blocks for supported browsers', async () => {
  const result = await transformAsync(
    `export class Example {
      value: string = 'ok';
      static { this.ready = true; }
    }`,
    {...getBuildBabelOptions(true), filename: 'Example.ts'},
  );
  expect(result?.code).toContain("value = 'ok'");
  expect(result?.code).not.toMatch(/static\s*\{/);
  expect(result?.code).toContain('export class Example');
});
