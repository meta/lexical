/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {Alias} from 'vite';

import babel from '@rollup/plugin-babel';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import * as path from 'path';
import {defineConfig, type UserManifest} from 'wxt';

import transformErrorMessages from '../../scripts/error-codes/transform-error-messages.mjs';
import moduleResolution from '../../scripts/vite/viteModuleResolution.ts';

// See https://wxt.dev/api/config.html
export default defineConfig({
  debug: !!process.env.DEBUG_WXT,
  manifest: configEnv => {
    const browserName =
      configEnv.browser.charAt(0).toUpperCase() + configEnv.browser.slice(1);

    let buildVersion = 0; // For dev purposes
    if (process.env.BUILD_VERSION) {
      buildVersion = parseInt(process.env.BUILD_VERSION, 10);
    }
    if (isNaN(buildVersion)) {
      throw new Error('BUILD_VERSION must be a number');
    }

    let version = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, 'package.json')).toString(),
    ).version;

    if (configEnv.browser === 'safari') {
      const [v1, v2, v3] = version.split('.');
      // App Store requires a version number in the format of X.X.X and we need to fit a build number there as well
      version = `${v1}${v2}`.replace(/^0+/, '') + `.${v3}`;
    }

    const manifestConf: UserManifest = {
      description: `Adds Lexical debugging tools to the ${browserName} Developer Tools.`,
      homepage_url: 'https://lexical.dev/',
      icons: {
        128: '/icon/128.png',
        16: '/icon/16.png',
        32: '/icon/32.png',
        48: '/icon/48.png',
      },
      name: 'Lexical Developer Tools',
      permissions: ['storage'],
      version: version + `.${buildVersion}`,
      web_accessible_resources: [
        {
          matches: ['<all_urls>'],
          resources: ['injected.js'],
        },
      ],
    };

    if (configEnv.mode === 'development') {
      // When building the local development version of the
      // extension we want to be able to have a stable extension ID
      // for the local build (in order to be able to reliably detect
      // duplicate installations of DevTools).
      // By specifying a key in the built manifest.json file,
      // we can make it so the generated extension ID is stable.
      // For more details see the docs here: https://developer.chrome.com/docs/extensions/reference/manifest/key
      // Generated via:
      // $ openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out key.pem # private key
      // $ openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A # this key below (strip % at the end)
      // $ openssl rsa -in key.pem -pubout -outform DER | shasum -a 256 | head -c32 | tr 0-9a-f a-p # extension ID
      manifestConf.key =
        'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAve7nOT9MtnECslFqKw5x0a/OvR/ZzsDBvcR3SIpQg446O7tKwFZTOQWgmceKZJAPT03Ztwdj7qJfAteSwaW4Aeoo6gK5BU7lAAAXeZNhzmuLSJhE4eu8KVDwck16iEx1C/IBKCypM+7H1wjwSVsjGpij2EDiH4Pw/aJ9LLRia7LO3xXTQTYzaJCzx1A+5JiFo5Y9tTtORdyFV/5bfaxibentXNxm52sj3spBe3wC7BuNoYmto9YdKhYk8Xsvs0u8tC7lRae9h57flLCmqPTi9ho4PkJXs4v/okxtGN2Lhwf3Az3ws1LAUqzGJrNK598IRU70a5ONtqXUc3vdGVJxtwIDAQAB';
    }

    return manifestConf;
  },
  srcDir: './src',
  vite: configEnv => {
    const isProd = configEnv.mode !== 'development';
    const {version} = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, 'package.json'), {
        encoding: 'utf8',
      }),
    );

    return {
      define: {
        __DEV__: !isProd,
        'process.env.LEXICAL_VERSION': JSON.stringify(
          `${version}+${isProd ? 'prod' : 'dev'}.devtools`,
        ),
      },
      plugins: [
        babel({
          babelHelpers: 'bundled',
          babelrc: false,
          configFile: false,
          exclude: '**/node_modules/**',
          extensions: ['jsx', 'js', 'ts', 'tsx', 'mjs'],
          plugins: [
            '@babel/plugin-transform-flow-strip-types',
            [
              transformErrorMessages,
              {
                noMinify: true,
              },
            ],
          ],
          presets: [['@babel/preset-react', {runtime: 'automatic'}]],
        }),
        react(),
      ],
      resolve: {
        alias: [
          // See lexicalForExtension.ts for more details
          {
            find: /lexical$/,
            replacement: path.resolve('./src/lexicalForExtension.ts'),
          },
          {
            find: 'lexicalOriginal',
            replacement: path.resolve('../lexical/src/index.ts'),
          },
          ...(moduleResolution('source') as Alias[]),
        ],
      },
    };
  },
  webExt: {
    binaries: {
      edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    },
    chromiumArgs: [
      '--auto-open-devtools-for-tabs',
      // Open chrome://version to validate it works
      // We use this instead of chromiumProfile because of https://github.com/wxt-dev/wxt/issues/366
      `--user-data-dir=${path.join(__dirname, '.browser-profiles/chromium')}`,
      '--hide-crash-restore-bubble',
      '--enable-extension-activity-logging',
    ],
    startUrls: [
      'https://playground.lexical.dev/',
      'about:debugging#/runtime/this-firefox',
      // Doesn't work due to https://github.com/mozilla/web-ext/pull/2774
      // 'chrome://inspect/#service-workers',
    ],
  },
  zip: {
    sourcesRoot: path.resolve('../..'),
  },
});
