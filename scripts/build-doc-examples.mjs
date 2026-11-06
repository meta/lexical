/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Build the actual standalone starter apps for same-origin documentation embeds.
// The workspace install is sufficient; the examples do not need their own install.
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';

const monorepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const websiteRoot = path.join(monorepoRoot, 'packages/lexical-website');
const require = createRequire(path.join(websiteRoot, 'package.json'));
const emojiRoot = path.dirname(
  require.resolve('emoji-datasource-facebook/package.json'),
);
const examples = [
  'node-state-review',
  'vanilla-js',
  'vanilla-js-plugin',
  'react-plain-text',
  'react-rich',
];

for (const name of examples) {
  const root = path.join(monorepoRoot, 'examples', name);
  console.log(`Building examples/${name} -> /examples/${name}/`);
  await build({
    // Resolve assets beside index.html, including under a site's baseUrl.
    base: './',
    build: {
      emptyOutDir: true,
      outDir: path.join(websiteRoot, 'static/examples', name),
    },
    configFile: path.join(root, 'vite.config.monorepo.ts'),
    logLevel: 'warn',
    mode: 'development',
    resolve: {
      alias: {
        'emoji-datasource-facebook': emojiRoot,
        // Keep the apps and local Lexical packages on the website's React,
        // even when a standalone example has its own node_modules directory.
        react: path.dirname(require.resolve('react/package.json')),
        'react-dom': path.dirname(require.resolve('react-dom/package.json')),
      },
    },
    root,
  });
}

console.log(`Built ${examples.length} documentation examples.`);
