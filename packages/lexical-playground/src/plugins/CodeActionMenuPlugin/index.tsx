/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './index.css';

import {$isCodeNode, CodeNode} from '@lexical/code';
import {DEFAULT_CODE_LANGUAGE} from '@lexical/code-core';
import {
  getLanguageFriendlyName,
  normalizeCodeLanguage,
} from '@lexical/code-prism';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  getComposedEventTarget,
  isHTMLElement,
  mergeRegister,
  type NodeKey,
  registerEventListener,
} from 'lexical';
import * as React from 'react';
import {type JSX, useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

import {CopyButton} from './components/CopyButton';
import {PrettierButton} from './components/PrettierButton';
import {WrapButton} from './components/WrapButton';
import {canBePrettier} from './formatCodeWithPrettier';
import {useDebounce} from './utils';

const CODE_PADDING = 8;

interface Position {
  top: string;
  right: string;
}

function CodeActionMenuContainer({
  anchorElem,
}: {
  anchorElem: HTMLElement;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();

  const [lang, setLang] = useState('');
  const [isWrapped, setWrapped] = useState(false);
  const [isShown, setShown] = useState<boolean>(false);
  const [shouldListenMouseMove, setShouldListenMouseMove] =
    useState<boolean>(false);
  const [position, setPosition] = useState<Position>({
    right: '0',
    top: '0',
  });
  const codeSetRef = useRef<Set<string>>(new Set());
  const codeDOMNodeRef = useRef<HTMLElement | null>(null);
  const codeKeyRef = useRef<NodeKey | null>(null);

  function getCodeDOMNode(): HTMLElement | null {
    return codeDOMNodeRef.current;
  }

  function getCodeKey(): NodeKey | null {
    return codeKeyRef.current;
  }

  const debouncedOnMouseMove = useDebounce(
    (event: MouseEvent) => {
      const {codeDOMNode, isOutside} = getMouseInfo(event);
      if (isOutside) {
        setShown(false);
        return;
      }

      if (!codeDOMNode) {
        return;
      }

      codeDOMNodeRef.current = codeDOMNode;

      let codeNode: CodeNode | null = null;
      let _lang = '';
      let _wordWrap = false;

      editor.update(() => {
        const maybeCodeNode = $getNearestNodeFromDOMNode(codeDOMNode);

        if ($isCodeNode(maybeCodeNode)) {
          codeNode = maybeCodeNode;
          _lang = codeNode.getLanguage() || '';
          _wordWrap = codeNode.getWordWrap();
          codeKeyRef.current = codeNode.getKey();
        }
      });

      if (codeNode) {
        const {y: editorElemY, right: editorElemRight} =
          anchorElem.getBoundingClientRect();
        const {y, right} = codeDOMNode.getBoundingClientRect();
        setLang(_lang);
        setWrapped(_wordWrap);
        setShown(true);
        setPosition({
          right: `${editorElemRight - right + CODE_PADDING}px`,
          top: `${y - editorElemY}px`,
        });
      }
    },
    50,
    1000,
  );

  useEffect(() => {
    if (!shouldListenMouseMove) {
      return;
    }

    return mergeRegister(
      registerEventListener(document, 'mousemove', debouncedOnMouseMove),
      () => {
        setShown(false);
        debouncedOnMouseMove.cancel();
      },
    );
  }, [shouldListenMouseMove, debouncedOnMouseMove]);

  useEffect(() => {
    return editor.registerMutationListener(
      CodeNode,
      mutations => {
        editor.read('latest', () => {
          for (const [key, type] of mutations) {
            switch (type) {
              case 'created':
                codeSetRef.current.add(key);
                break;

              case 'destroyed':
                codeSetRef.current.delete(key);
                if (key === codeKeyRef.current) {
                  codeKeyRef.current = null;
                  setShown(false);
                }
                break;

              case 'updated':
                if (key === codeKeyRef.current) {
                  const node = $getNodeByKey(key);
                  if ($isCodeNode(node)) {
                    setLang(node.getLanguage() || '');
                    setWrapped(node.getWordWrap());
                  }
                }
                break;

              default:
                break;
            }
          }
        });
        setShouldListenMouseMove(codeSetRef.current.size > 0);
      },
      {skipInitialization: false},
    );
  }, [editor]);

  // Code blocks created without an explicit language (markdown ``` with
  // no info string, the `/code` slash menu) leave `__language` as
  // `undefined`, which surfaces here as an empty `lang`. Show the same
  // `(No language)` label the main toolbar uses, but still hand prettier
  // the highlight default so users can format these blocks.
  const normalizedLang = normalizeCodeLanguage(lang || DEFAULT_CODE_LANGUAGE);
  const codeFriendlyName = lang
    ? getLanguageFriendlyName(lang)
    : '(No language)';

  return (
    <>
      {isShown ? (
        <div className="code-action-menu-container" style={{...position}}>
          <div className="code-highlight-language">{codeFriendlyName}</div>
          <CopyButton editor={editor} getCodeDOMNode={getCodeDOMNode} />
          <WrapButton
            editor={editor}
            getCodeKey={getCodeKey}
            isWrapped={isWrapped}
          />
          {canBePrettier(normalizedLang) ? (
            <PrettierButton
              editor={editor}
              getCodeDOMNode={getCodeDOMNode}
              lang={normalizedLang}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function getMouseInfo(event: MouseEvent): {
  codeDOMNode: HTMLElement | null;
  isOutside: boolean;
} {
  const target = getComposedEventTarget(event);

  if (isHTMLElement(target)) {
    const codeDOMNode = target.closest<HTMLElement>(
      'code.PlaygroundEditorTheme__code',
    );
    const isOutside = !(
      codeDOMNode ||
      target.closest<HTMLElement>('div.code-action-menu-container')
    );

    return {codeDOMNode, isOutside};
  } else {
    return {codeDOMNode: null, isOutside: true};
  }
}

export default function CodeActionMenuPlugin({
  anchorElem = document.body,
}: {
  anchorElem?: HTMLElement;
}): React.ReactPortal | null {
  return createPortal(
    <CodeActionMenuContainer anchorElem={anchorElem} />,
    anchorElem,
  );
}
