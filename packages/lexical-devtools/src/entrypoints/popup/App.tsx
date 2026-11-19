/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import './App.css';

import {Box, Flex, Text} from '@chakra-ui/react';
import * as React from 'react';
import {useState} from 'react';

import EditorsRefreshCTA from '../../components/EditorsRefreshCTA';
import {useExtensionStore} from '../../store';

interface Props {
  tabID: number;
}

function App({tabID}: Props) {
  const {editorCount} = useExtensionStore();
  const [errorMessage, setErrorMessage] = useState('');

  const count = editorCount[tabID];
  const lexicalCount = count ?? 0;

  return (
    <Flex direction="column">
      {errorMessage !== '' ? (
        <Box className="error" mb={2} color="red">
          <Text fontSize="xs">{errorMessage}</Text>
        </Box>
      ) : null}
      <Box>
        {count === null ? (
          <Text fontSize="xs">
            This is a restricted browser page. Lexical DevTools cannot access
            this page.
          </Text>
        ) : count === undefined ? (
          <Text fontSize="xs">Loading...</Text>
        ) : (
          <>
            <Box>
              <Text fontSize="xs">
                Found <b>{lexicalCount}</b> editor
                {lexicalCount > 1 || lexicalCount === 0 ? 's' : ''} on the page
                {lexicalCount > 0 ? (
                  <>
                    {' '}
                    &#x2705;
                    <br />
                    Open the developer tools, and "Lexical" tab will appear to
                    the right.
                  </>
                ) : null}
              </Text>
            </Box>

            <Box mt={1}>
              <EditorsRefreshCTA
                tabID={tabID}
                setErrorMessage={setErrorMessage}
              />
            </Box>
          </>
        )}
      </Box>
    </Flex>
  );
}

export default App;
