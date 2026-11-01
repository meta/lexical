/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

function StackBlitzIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 28 28"
      fill="currentColor"
      width="14"
      height="14"
      aria-hidden="true">
      <path d="M12.747 16.273h-7.46L18.925 1.5l-3.671 10.227h7.46L9.075 26.5z" />
    </svg>
  );
}

interface StackBlitzButtonProps {
  examplePath: string;
  file?: string;
}

export default function StackBlitzButton({
  examplePath,
  file = 'src/Editor.tsx',
}: StackBlitzButtonProps) {
  const {siteConfig} = useDocusaurusContext();
  let stackblitzPrefix;
  if (siteConfig.customFields) {
    stackblitzPrefix = siteConfig.customFields.STACKBLITZ_PREFIX as string;
  }

  return (
    <Link
      href={`${stackblitzPrefix}examples/${examplePath}?file=${encodeURIComponent(file)}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-md border border-solid border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 no-underline transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-700 hover:no-underline dark:border-white/10 dark:bg-white/5 dark:text-zinc-300 dark:hover:border-white/20 dark:hover:bg-white/10">
      <StackBlitzIcon />
      Open in StackBlitz
    </Link>
  );
}
