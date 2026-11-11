/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {PlaywrightTestConfig} from '@playwright/test';

const PORT = 4327;

const config: PlaywrightTestConfig = {
  testDir: 'tests',
  testMatch: /(.+\.)?(test|spec)\.[jt]s/,
  use: {baseURL: `http://localhost:${PORT}`},
  webServer: {
    command: 'pnpm run dev',
    port: PORT,
    reuseExistingServer: true,
  },
};

export default config;
