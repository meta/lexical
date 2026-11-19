/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import * as webStreams from 'node:stream/web';

// jsdom's VM context does not inherit Node's Web Streams globals. Use the
// native implementations for jsdom/undici and document compression tests,
// just as the non-VM jsdom environment does. Keep this out of browser setup.
for (const [name, value] of Object.entries(webStreams)) {
  if (name !== 'default' && !(name in globalThis)) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true,
    });
  }
}
