/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {mergeConfig} from 'vite';

import lexicalMonorepoPlugin from '../../scripts/vite/lexicalMonorepoPlugin';
import config from './vite.config';

export default mergeConfig(config, {
  plugins: [lexicalMonorepoPlugin()],
});
