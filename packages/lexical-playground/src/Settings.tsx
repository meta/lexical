/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {type JSX, useMemo, useState} from 'react';

import {isDevPlayground} from './appSettings';
import {useSettings} from './context/SettingsContext';
import Switch from './ui/Switch';

export default function Settings(): JSX.Element {
  const windowLocation = window.location;
  const {
    setOption,
    settings: {
      measureTypingPerf,
      isCollab,
      isRichText,
      hasNestedTables,
      hasFitNestedTables,
      isMaxLength,
      hasLinkAttributes,
      isCharLimit,
      isCharLimitUtf8,
      isAutocomplete,
      isVisibleNonPrinting,
      showTreeView,
      showNestedEditorTreeView,
      showTableOfContents,
      shouldUseLexicalContextMenu,
      shouldPreserveNewLinesInMarkdown,
      shouldAllowHighlightingWithBrackets,
      selectionAlwaysOnDisplay,
      selectBlock,
      isCodeHighlighted,
      isCodeShiki,
      isCodeLineNumbers,
      isShadowDOM,
    },
  } = useSettings();
  const [showSettings, setShowSettings] = useState(false);
  const [isSplitScreen, search] = useMemo(() => {
    const parentWindow = window.parent;
    const _search = windowLocation.search;
    const _isSplitScreen =
      parentWindow && parentWindow.location.pathname === '/split/';
    return [_isSplitScreen, _search];
  }, [windowLocation]);

  return (
    <>
      <button
        id="options-button"
        data-test-id="options-button"
        className={`editor-dev-button ${showSettings ? 'active' : ''}`}
        onClick={() => setShowSettings(!showSettings)}
      />
      {showSettings ? (
        <div className="switches">
          {isRichText && isDevPlayground && (
            <Switch
              onClick={() => {
                setOption('isCollab', !isCollab);
                window.location.reload();
              }}
              checked={isCollab}
              text="Collaboration"
            />
          )}
          {isDevPlayground && (
            <Switch
              onClick={() => {
                if (isSplitScreen) {
                  window.parent.location.href = `/${search}`;
                } else {
                  window.location.href = `/split/${search}`;
                }
              }}
              checked={isSplitScreen}
              text="Split Screen"
            />
          )}
          <Switch
            onClick={() => setOption('measureTypingPerf', !measureTypingPerf)}
            checked={measureTypingPerf}
            text="Measure Perf"
          />
          <Switch
            onClick={() => setOption('showTreeView', !showTreeView)}
            checked={showTreeView}
            text="Debug View"
          />
          <Switch
            onClick={() =>
              setOption('showNestedEditorTreeView', !showNestedEditorTreeView)
            }
            checked={showNestedEditorTreeView}
            text="Nested Editors Debug View"
          />
          <Switch
            onClick={() => {
              setOption('isRichText', !isRichText);
              setOption('isCollab', false);
            }}
            checked={isRichText}
            text="Rich Text"
          />
          <Switch
            onClick={() => {
              setOption('hasNestedTables', !hasNestedTables);
            }}
            checked={hasNestedTables}
            text="Nested Tables"
          />
          <Switch
            onClick={() => {
              setOption('hasFitNestedTables', !hasFitNestedTables);
            }}
            checked={hasFitNestedTables}
            text="Fit nested tables"
          />
          <Switch
            onClick={() => setOption('isCharLimit', !isCharLimit)}
            checked={isCharLimit}
            text="Char Limit"
          />
          <Switch
            onClick={() => setOption('isCharLimitUtf8', !isCharLimitUtf8)}
            checked={isCharLimitUtf8}
            text="Char Limit (UTF-8)"
          />
          <Switch
            onClick={() => setOption('hasLinkAttributes', !hasLinkAttributes)}
            checked={hasLinkAttributes}
            text="Link Attributes"
          />
          <Switch
            onClick={() => setOption('isMaxLength', !isMaxLength)}
            checked={isMaxLength}
            text="Max Length"
          />
          <Switch
            onClick={() => setOption('isAutocomplete', !isAutocomplete)}
            checked={isAutocomplete}
            text="Autocomplete"
          />
          <Switch
            onClick={() =>
              setOption('isVisibleNonPrinting', !isVisibleNonPrinting)
            }
            checked={isVisibleNonPrinting}
            text="Visible Non-Printing"
          />
          <Switch
            onClick={() => {
              setOption('showTableOfContents', !showTableOfContents);
            }}
            checked={showTableOfContents}
            text="Table Of Contents"
          />
          <Switch
            onClick={() => {
              setOption(
                'shouldUseLexicalContextMenu',
                !shouldUseLexicalContextMenu,
              );
            }}
            checked={shouldUseLexicalContextMenu}
            text="Use Lexical Context Menu"
          />
          <Switch
            onClick={() => {
              setOption(
                'shouldPreserveNewLinesInMarkdown',
                !shouldPreserveNewLinesInMarkdown,
              );
            }}
            checked={shouldPreserveNewLinesInMarkdown}
            text="Preserve newlines in Markdown"
          />
          <Switch
            onClick={() => {
              setOption(
                'shouldAllowHighlightingWithBrackets',
                !shouldAllowHighlightingWithBrackets,
              );
            }}
            checked={shouldAllowHighlightingWithBrackets}
            text="Use Brackets for Highlighting"
          />

          <Switch
            onClick={() => {
              setOption('selectionAlwaysOnDisplay', !selectionAlwaysOnDisplay);
            }}
            checked={selectionAlwaysOnDisplay}
            text="Retain selection"
          />

          <Switch
            onClick={() => {
              setOption('selectBlock', !selectBlock);
            }}
            checked={selectBlock}
            text="Block selection"
          />

          <Switch
            onClick={() => {
              setOption('isCodeHighlighted', !isCodeHighlighted);
            }}
            checked={isCodeHighlighted}
            text="Enable Code Highlighting"
          />

          <Switch
            onClick={() => {
              setOption('isCodeShiki', !isCodeShiki);
            }}
            checked={isCodeShiki}
            text="Use Shiki for Code Highlighting"
          />

          <Switch
            onClick={() => {
              setOption('isCodeLineNumbers', !isCodeLineNumbers);
            }}
            checked={isCodeLineNumbers}
            text="Per Line Numbers in All Code Blocks"
          />

          <Switch
            onClick={() => {
              setOption('isShadowDOM', !isShadowDOM);
            }}
            checked={isShadowDOM}
            text="Render in Shadow DOM"
          />
        </div>
      ) : null}
    </>
  );
}
