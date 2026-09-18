/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

import lexicalMonorepoPlugin from '../../scripts/vite/lexicalMonorepoPlugin';

export default defineConfig({
  plugins: [react(), lexicalMonorepoPlugin()],
  preview: {port: 4328, strictPort: true},
  server: {port: 4328, strictPort: true},
});
