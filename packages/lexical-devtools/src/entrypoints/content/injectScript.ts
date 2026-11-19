/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {PublicPath} from 'wxt/browser';

export default function injectScript(
  src: PublicPath,
  params: Readonly<Record<string, string>> = {},
) {
  const url = new URL(browser.runtime.getURL(src));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const s = document.createElement('script');
  s.src = url.toString();
  s.type = 'module'; // ESM module support
  s.onload = () => s.remove();
  (document.head || document.documentElement).append(s);
}
