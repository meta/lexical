/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import './index.css';

import {useCollaborationContext} from '@lexical/react/LexicalCollaborationContext';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  $getYChangeState,
  CLEAR_DIFF_VERSIONS_COMMAND__EXPERIMENTAL,
  DIFF_VERSIONS_COMMAND__EXPERIMENTAL,
} from '@lexical/yjs';
import {
  $getNodeByKeyOrThrow,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  type LexicalCommand,
  mergeRegister,
  TextNode,
} from 'lexical';
import _ from 'lodash';
import {useCallback, useEffect, useState} from 'react';
import {
  PermanentUserData,
  type Snapshot,
  snapshot as createSnapshot,
  XmlElement,
} from 'yjs';

import Button from '../../ui/Button';
import Modal from '../../ui/Modal';

interface Version {
  name: string;
  timestamp: number;
  snapshot: Snapshot;
}

const COLORS = [
  '#4a90e288',
  '#bd10e088',
  '#d0021b88',
  '#8b572a88',
  '#41750588',
  '#f5a62388',
];

type User = string; // username

export const SHOW_VERSIONS_COMMAND: LexicalCommand<void> = createCommand(
  'SHOW_VERSIONS_COMMAND',
);

export function VersionsPlugin({id}: {id: string}) {
  const [editor] = useLexicalComposerContext();
  const {name: username, yjsDocMap} = useCollaborationContext();
  const yDoc = yjsDocMap.get(id);

  const [isDiffMode, setIsDiffMode] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);

  const [pudInitialised, setPudInitialised] = useState(false);

  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(
          SHOW_VERSIONS_COMMAND,
          () => {
            setShowModal(true);
            return false;
          },
          COMMAND_PRIORITY_EDITOR,
        ),
        editor.registerCommand(
          DIFF_VERSIONS_COMMAND__EXPERIMENTAL,
          () => {
            editor.setEditable(false);
            setIsDiffMode(true);
            return false;
          },
          COMMAND_PRIORITY_CRITICAL,
        ),
        editor.registerCommand(
          CLEAR_DIFF_VERSIONS_COMMAND__EXPERIMENTAL,
          () => {
            editor.setEditable(true);
            setIsDiffMode(false);
            return false;
          },
          COMMAND_PRIORITY_CRITICAL,
        ),
        editor.registerEditableListener(isEditable => {
          if (isEditable && isDiffMode) {
            editor.dispatchCommand(CLEAR_DIFF_VERSIONS_COMMAND__EXPERIMENTAL);
          }
        }),
      ),
    [editor, isDiffMode],
  );

  useEffect(() => {
    if (pudInitialised || !yDoc) {
      return;
    }

    const root = yDoc.get('root-v2', XmlElement);
    const handleChange: Parameters<typeof root.observeDeep>[0] = (
      _events,
      transaction,
    ) => {
      if (transaction.local) {
        // User's made a local change. Register PUD mapping.
        const permanentUserData = new PermanentUserData(yDoc);
        permanentUserData.setUserMapping(yDoc, yDoc.clientID, username);
        setPudInitialised(true);
      }
    };

    root.observeDeep(handleChange);
    return () => root.unobserveDeep(handleChange);
  }, [yDoc, username, pudInitialised]);

  useEffect(() => {
    if (!isDiffMode) {
      return;
    }
    return editor.registerMutationListener(
      TextNode,
      nodes => {
        const userToColor = new Map<User, string>();
        const getUserColor = (user: User): string => {
          if (userToColor.has(user)) {
            return userToColor.get(user)!;
          }
          const color = COLORS[userToColor.size % COLORS.length];
          userToColor.set(user, color);
          return color;
        };
        editor.read('latest', () => {
          for (const [nodeKey, mutation] of nodes.entries()) {
            if (mutation === 'destroyed') {
              continue;
            }
            const node = $getNodeByKeyOrThrow(nodeKey);
            const ychange = $getYChangeState<User>(node);
            const element = editor.getElementByKey(nodeKey);
            if (!ychange || !element) {
              continue;
            }
            const {type, user: changeUser} = ychange;
            if (!changeUser) {
              continue;
            }
            const color = getUserColor(changeUser);
            switch (type) {
              case 'removed':
                element.style.color = color;
                element.style.textDecoration = 'line-through';
                break;
              case 'added':
                element.style.backgroundColor = color;
                break;
              default:
              // no change
            }
          }
        });
      },
      {skipInitialization: true},
    );
  }, [editor, isDiffMode]);

  const handleAddVersion = useCallback(() => {
    if (!yDoc) {
      return;
    }

    const now = Date.now();
    setVersions(prevVersions => [
      ...prevVersions,
      {
        name: `Snapshot ${new Date(now).toLocaleString()}`,
        snapshot: createSnapshot(yDoc),
        timestamp: now,
      },
    ]);
  }, [setVersions, yDoc]);

  if (!showModal) {
    return null;
  }

  return (
    <VersionsModal
      versions={versions}
      isDiffMode={isDiffMode}
      onAddVersion={handleAddVersion}
      onClose={() => setShowModal(false)}
    />
  );
}

function VersionsModal({
  versions,
  isDiffMode,
  onAddVersion,
  onClose,
}: {
  versions: Version[];
  isDiffMode: boolean;
  onAddVersion: () => void;
  onClose: () => void;
}) {
  const [editor] = useLexicalComposerContext();
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);

  return (
    <Modal onClose={onClose} title="Version History">
      <div className="VersionsPlugin_Container">
        <div className="VersionsPlugin_Header">
          <Button onClick={onAddVersion}>+ Add snapshot</Button>
          {isDiffMode && (
            <Button
              onClick={() => {
                editor.dispatchCommand(
                  CLEAR_DIFF_VERSIONS_COMMAND__EXPERIMENTAL,
                );
                onClose();
              }}>
              Exit compare view
            </Button>
          )}
        </div>

        {/* Version list */}
        <div className="VersionsPlugin_VersionList">
          {versions.length === 0 ? (
            <button className="VersionsPlugin_VersionItem" disabled={true}>
              Add a snapshot to get started
            </button>
          ) : (
            versions.map((version, idx) => {
              const isSelected = selectedVersion === idx;

              return (
                <button
                  key={version.name}
                  onClick={() => setSelectedVersion(idx)}
                  className={`VersionsPlugin_VersionItem ${
                    isSelected ? 'VersionsPlugin_VersionItem--selected' : ''
                  }`}>
                  Snapshot at {new Date(version.timestamp).toLocaleString()}
                </button>
              );
            })
          )}
        </div>
        <Button
          onClick={() => {
            editor.dispatchCommand(DIFF_VERSIONS_COMMAND__EXPERIMENTAL, {
              prevSnapshot: versions[selectedVersion!].snapshot,
            });
            onClose();
          }}
          disabled={selectedVersion === null}
          className="VersionsPlugin_CompareButton">
          Show changes since selected version
        </Button>
      </div>
    </Modal>
  );
}
