/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import useBaseUrl from '@docusaurus/useBaseUrl';

import StackBlitzButton from './StackBlitzButton';

const EXAMPLES = {
  'node-state-review': {
    file: 'src/ReviewExtension.ts',
    title: 'Paragraph review',
  },
  'react-plain-text': {file: 'src/App.tsx', title: 'React plain text'},
  'react-rich': {file: 'src/App.tsx', title: 'React rich text'},
  'vanilla-js': {file: 'src/main.ts', title: 'Vanilla JavaScript'},
  'vanilla-js-plugin': {
    file: 'src/emoji-plugin/EmojiExtension.ts',
    title: 'Emoji extension',
  },
};

export default function GettingStartedExample({
  example,
}: {
  example: keyof typeof EXAMPLES;
}) {
  const {file, title} = EXAMPLES[example];
  const src = useBaseUrl(`/examples/${example}/?embed`);
  return (
    <div className="my-6 flex flex-col gap-3" data-doc-example={example}>
      <iframe
        src={src}
        title={`${title} example editor`}
        loading="lazy"
        width="100%"
        height="500"
        className="rounded-lg border border-solid border-zinc-300 dark:border-white/20"
      />
      <div className="flex justify-end">
        <StackBlitzButton examplePath={example} file={file} />
      </div>
    </div>
  );
}
