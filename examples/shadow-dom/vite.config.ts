/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig({
  plugins: [react()],
  // Pinned so the Playwright config can point a webServer at it.
  preview: {port: 4326, strictPort: true},
  server: {port: 4326, strictPort: true},
});
