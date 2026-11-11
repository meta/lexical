/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {createReadStream, existsSync, statSync} from 'node:fs';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BUILD_DIR = path.resolve(__dirname, '..', 'build');

const CONTENT_TYPES = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

export function startServer({baseUrl = '/'} = {}) {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (!urlPath.startsWith(baseUrl)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    let filePath = path.join(BUILD_DIR, urlPath.slice(baseUrl.length));
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!existsSync(filePath)) {
      // Only fall back to the SPA shell for extension-less client routes;
      // a missing asset must 404 so it surfaces as a real failure.
      if (path.extname(urlPath) === '') {
        filePath = path.join(BUILD_DIR, 'index.html');
      } else {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
    }
    res.writeHead(200, {
      'Content-Type':
        CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
    });
    createReadStream(filePath).pipe(res);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
