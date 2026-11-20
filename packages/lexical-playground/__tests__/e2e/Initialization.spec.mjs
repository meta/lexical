/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {expect, initialize, test} from '../utils/index.mjs';

test.skip(({isCollab}) => !isCollab);
test('collaboration startup does not require an unrelated image to load', async ({
  page,
  isCollab,
}) => {
  const pending = [];
  await page.route('**/__test_pending_image.png', route => {
    pending.push(route);
  });
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const image = document.createElement('img');
      image.hidden = true;
      image.src = '/__test_pending_image.png';
      document.body.append(image);
    });
  });
  try {
    await initialize({isCollab, page});
    await expect.poll(() => pending.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.readyState)).toBe('interactive');
  } finally {
    await Promise.all(pending.map(route => route.abort().catch(() => {})));
  }
});
