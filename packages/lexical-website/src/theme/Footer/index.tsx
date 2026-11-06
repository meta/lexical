/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import Link from '@docusaurus/Link';
import {useColorMode} from '@docusaurus/theme-common';
import React from 'react';

function Footer() {
  const {colorMode} = useColorMode();
  return (
    <footer
      className="w-full text-sm"
      style={{
        backgroundColor: colorMode === 'dark' ? '#27272A' : '#E4E4E7',
        color: colorMode === 'dark' ? '#A1A1AA' : '#4B5563',
      }}>
      <div className="flex flex-col items-center gap-2 px-6 py-10">
        <div className="pt-6 text-center text-sm">
          Copyright © Meta Platforms, Inc. Built with Docusaurus.
        </div>
        <div className="space-x-4">
          <Link href={'https://opensource.fb.com/legal/privacy/'}>
            Privacy Policy
          </Link>
          <Link href={'https://opensource.fb.com/legal/terms/'}>
            Terms of Use
          </Link>
        </div>
      </div>
    </footer>
  );
}

export default React.memo(Footer);
