/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {SerializedRawEditorState} from '../../../types';
import type {IInjectedPegasusService} from '../../injected/InjectedPegasusService';
import type {EditorState} from 'lexical';

// import './App.css';
import {Accordion, Box} from '@chakra-ui/react';
import {TreeView} from '@lexical/devtools-core';
import {getRPCService} from '@webext-pegasus/rpc';
import * as React from 'react';
import {useEffect, useMemo, useRef, useState} from 'react';

import {useExtensionStore} from '../../../store';

interface Props {
  tabID: number;
  setErrorMessage: (value: string) => void;
}

export function EditorsList({tabID, setErrorMessage}: Props) {
  const tabRefs = useRef(new Map<number, HTMLDivElement | null>());
  const [expandedItems, setExpandedItems] = useState<string[]>(['0']);
  const {lexicalState, selectedEditorKey} = useExtensionStore();
  const states = lexicalState[tabID] ?? {};
  const selectedEditorIdx = Object.keys(states).findIndex(
    key => key === selectedEditorKey[tabID],
  );

  useEffect(() => {
    if (selectedEditorIdx !== -1) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExpandedItems([String(selectedEditorIdx)]);
      setTimeout(
        () =>
          tabRefs.current
            .get(selectedEditorIdx)
            ?.scrollIntoView({behavior: 'smooth', block: 'start'}),
        // Delay scrolling to let accordion finish it's animation first
        100,
      );
    }
  }, [selectedEditorIdx]);

  const injectedPegasusService = useMemo(
    () =>
      getRPCService<IInjectedPegasusService>('InjectedPegasusService', {
        context: 'window',
        tabId: tabID,
      }),
    [tabID],
  );

  return (
    <Accordion.Root
      multiple={true}
      collapsible={true}
      value={expandedItems}
      onValueChange={details => setExpandedItems(details.value)}>
      {Object.entries(states).map(([key, state], idx) => (
        <Accordion.Item
          key={key}
          value={String(idx)}
          ref={el => {
            tabRefs.current.set(idx, el);
          }}>
          <h2>
            <Accordion.ItemTrigger>
              <Box as="span" flex="1" textAlign="left">
                ID: {key}
              </Box>
              <Accordion.ItemIndicator />
            </Accordion.ItemTrigger>
          </h2>
          <Accordion.ItemContent pb={4}>
            <TreeView
              viewClassName="tree-view-output"
              treeTypeButtonClassName="debug-treetype-button"
              timeTravelPanelClassName="debug-timetravel-panel"
              timeTravelButtonClassName="debug-timetravel-button"
              timeTravelPanelSliderClassName="debug-timetravel-panel-slider"
              timeTravelPanelButtonClassName="debug-timetravel-panel-button"
              setEditorReadOnly={isReadonly =>
                injectedPegasusService
                  .setEditorReadOnly(key, isReadonly)
                  .catch(e => setErrorMessage(e.stack))
              }
              editorState={state as EditorState}
              setEditorState={editorState =>
                injectedPegasusService
                  .setEditorState(key, editorState as SerializedRawEditorState)
                  .catch(e => setErrorMessage(e.stack))
              }
              generateContent={exportDOM =>
                // The panel is open, so the user is deliberately inspecting
                // this editor: ask for its text unmasked.
                injectedPegasusService.generateTreeViewContent(
                  key,
                  exportDOM,
                  false,
                )
              }
            />
          </Accordion.ItemContent>
        </Accordion.Item>
      ))}
    </Accordion.Root>
  );
}
