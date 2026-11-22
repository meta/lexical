/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {HashtagExtension} from '@lexical/hashtag';
import {HistoryExtension} from '@lexical/history';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import {$getRoot, defineExtension} from 'lexical';
import {useEffect, useState} from 'react';

const richInputTheme = {
  hashtag:
    'rounded-[3px] bg-indigo-500/[0.08] px-0.5 text-indigo-600 dark:bg-indigo-300/[0.12] dark:text-indigo-300',
  paragraph: 'm-0',
  text: {
    bold: 'font-bold',
    italic: 'italic',
    underline: 'underline',
  },
};

const richInputExtension = defineExtension({
  dependencies: [RichTextExtension, HistoryExtension, HashtagExtension],
  name: '@lexical/website/rich-input-editor',
  namespace: '@lexical/website/rich-input-editor',
  theme: richInputTheme,
});

interface CharacterCountPluginProps {
  setCount: (count: number) => void;
}

function CharacterCountPlugin({setCount}: CharacterCountPluginProps) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener(({editorState}) => {
      editorState.read(
        () => {
          setCount($getRoot().getTextContentSize());
        },
        {editor},
      );
    });
  }, [editor, setCount]);

  return null;
}

export default function Editor() {
  const [characterCount, setCharacterCount] = useState(0);
  const [modKey, setModKey] = useState('⌘ + ');

  useEffect(() => {
    if (
      typeof navigator !== 'undefined' &&
      !navigator.userAgent.includes('Mac') &&
      !navigator.userAgent.includes('iPhone') &&
      !navigator.userAgent.includes('iPad')
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModKey('Ctrl + ');
    }
  }, []);

  return (
    <LexicalExtensionComposer
      extension={richInputExtension}
      contentEditable={null}>
      <div className="relative rounded-[10px] border border-solid border-zinc-200 bg-white transition-[border-color] duration-150 dark:border-white/[0.12] dark:bg-[#1f1f21]">
        <div className="relative">
          <ContentEditable
            className="max-h-40 min-h-20 overflow-y-auto px-3.5 py-3 text-[0.9375rem] leading-[1.55] break-words outline-none"
            aria-label="Rich text input"
            aria-placeholder="How are you feeling? Use #hashtags too."
            placeholder={
              <div className="pointer-events-none absolute top-3 left-3.5 text-[0.9375rem] text-zinc-400 select-none">
                How are you feeling? Use #hashtags too.
              </div>
            }
          />
        </div>
        <div className="flex items-center justify-between gap-2 border-t [border-top-style:solid] border-[#f0f0f2] px-3 pt-1.5 pb-2 dark:border-white/[0.07]">
          <div className="hidden flex-wrap items-center gap-2.5 min-[997px]:flex">
            <span className="flex items-center gap-1 text-xs whitespace-nowrap text-zinc-500 dark:text-zinc-400">
              <kbd className="inline-flex items-center justify-center rounded-[4px] border border-solid border-zinc-300 bg-zinc-100 px-[5px] py-0.5 font-[inherit] text-[0.7rem] leading-none font-medium whitespace-nowrap text-zinc-600 dark:border-zinc-600 dark:bg-[#2e2e32] dark:text-zinc-300">
                {modKey}B
              </kbd>{' '}
              Bold
            </span>
            <span className="flex items-center gap-1 text-xs whitespace-nowrap text-zinc-500 dark:text-zinc-400">
              <kbd className="inline-flex items-center justify-center rounded-[4px] border border-solid border-zinc-300 bg-zinc-100 px-[5px] py-0.5 font-[inherit] text-[0.7rem] leading-none font-medium whitespace-nowrap text-zinc-600 dark:border-zinc-600 dark:bg-[#2e2e32] dark:text-zinc-300">
                {modKey}I
              </kbd>{' '}
              Italic
            </span>
            <span className="flex items-center gap-1 text-xs whitespace-nowrap text-zinc-500 dark:text-zinc-400">
              <kbd className="inline-flex items-center justify-center rounded-[4px] border border-solid border-zinc-300 bg-zinc-100 px-[5px] py-0.5 font-[inherit] text-[0.7rem] leading-none font-medium whitespace-nowrap text-zinc-600 dark:border-zinc-600 dark:bg-[#2e2e32] dark:text-zinc-300">
                {modKey}U
              </kbd>{' '}
              Underline
            </span>
          </div>
          <span className="ml-auto shrink-0 text-xs text-zinc-400 tabular-nums">
            {characterCount}
          </span>
        </div>
        <CharacterCountPlugin setCount={setCharacterCount} />
      </div>
    </LexicalExtensionComposer>
  );
}
