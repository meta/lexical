/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './App.css';

import {Alert, Box, ButtonGroup, Flex, Spacer, Text} from '@chakra-ui/react';
import * as React from 'react';
import {useState} from 'react';

import EditorsRefreshCTA from '../../components/EditorsRefreshCTA';
import {useExtensionStore} from '../../store';
import {EditorInspectorButton} from './components/EditorInspectorButton';
import {EditorsList} from './components/EditorsList';

interface Props {
  tabID: number;
}

function App({tabID}: Props) {
  const [errorMessage, setErrorMessage] = useState('');

  const {editorCount} = useExtensionStore();
  const count = editorCount[tabID];
  const lexicalCount = count ?? 0;

  return count === null ? (
    <Alert.Root status="warning">
      <Alert.Indicator />
      <Alert.Content>
        This is a restricted browser page. Lexical DevTools cannot access this
        page.
      </Alert.Content>
    </Alert.Root>
  ) : (
    <>
      <Flex
        as="header"
        position="fixed"
        top="0"
        height="50px"
        backgroundColor="rgba(255,
 255, 255, 0.97)"
        backdropFilter="saturate(180%) blur(5px)"
        w="100%"
        boxShadow="md"
        zIndex={99}>
        <Box paddingX="2" alignContent="center">
          <ButtonGroup variant="outline" gap="2">
            <EditorInspectorButton
              tabID={tabID}
              setErrorMessage={setErrorMessage}
            />
            <EditorsRefreshCTA
              tabID={tabID}
              setErrorMessage={setErrorMessage}
            />
          </ButtonGroup>
        </Box>
        <Box pl="4" alignContent="center">
          {count === undefined ? (
            <Text fontSize="xs">Loading...</Text>
          ) : (
            <Text fontSize="xs">
              Found <b>{lexicalCount}</b> editor
              {lexicalCount > 1 || lexicalCount === 0 ? 's' : ''} on the page.
            </Text>
          )}
        </Box>
        <Spacer />
        <Box px="2" alignContent="center">
          <a href="https://lexical.dev" target="_blank">
            <img
              src="/lexical.svg"
              className="logo"
              width={134}
              height={30}
              alt="Lexical logo"
            />
          </a>
        </Box>
      </Flex>
      <Box as="main" mt="50px">
        {errorMessage !== '' ? (
          <div className="card error">{errorMessage}</div>
        ) : null}

        <Box pt={5}>
          {lexicalCount > 0 ? (
            <EditorsList tabID={tabID} setErrorMessage={setErrorMessage} />
          ) : (
            <Alert.Root status="info">
              <Alert.Indicator />
              <Alert.Content>
                No Lexical editors found on the page.
              </Alert.Content>
            </Alert.Root>
          )}
        </Box>
      </Box>
    </>
  );
}

export default App;
