/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './PollNode.css';

import {useCollaborationContext} from '@lexical/react/LexicalCollaborationContext';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useLexicalNodeSelection} from '@lexical/react/useLexicalNodeSelection';
import {
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  type BaseSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  mergeRegister,
  type NodeKey,
} from 'lexical';
import {type JSX, useEffect, useMemo, useRef, useState} from 'react';

import Button from '../ui/Button';
import joinClasses from '../utils/joinClasses';
import {
  $isPollNode,
  createPollOption,
  type Option,
  type Options,
  type PollNode,
} from './PollNode';

function getTotalVotes(options: Options): number {
  return options.reduce((totalVotes, next) => {
    return totalVotes + next.votes.length;
  }, 0);
}

function PollOptionComponent({
  option,
  index,
  options,
  totalVotes,
  withPollNode,
}: {
  index: number;
  option: Option;
  options: Options;
  totalVotes: number;
  withPollNode: (
    cb: (pollNode: PollNode) => void,
    onSelect?: () => void,
  ) => void;
}): JSX.Element {
  const {name: username} = useCollaborationContext();
  const checkboxRef = useRef(null);
  const votesArray = option.votes;
  const checkedIndex = votesArray.indexOf(username);
  const checked = checkedIndex !== -1;
  const votes = votesArray.length;
  const text = option.text;

  return (
    <div className="PollNode__optionContainer">
      <div
        className={joinClasses(
          'PollNode__optionCheckboxWrapper',
          checked && 'PollNode__optionCheckboxChecked',
        )}>
        <input
          ref={checkboxRef}
          className="PollNode__optionCheckbox"
          type="checkbox"
          onChange={e => {
            withPollNode(node => {
              node.toggleVote(option, username);
            });
          }}
          checked={checked}
        />
      </div>
      <div className="PollNode__optionInputWrapper">
        <div
          className="PollNode__optionInputVotes"
          style={{width: `${votes === 0 ? 0 : (votes / totalVotes) * 100}%`}}
        />
        <span className="PollNode__optionInputVotesCount">
          {votes > 0 && (votes === 1 ? '1 vote' : `${votes} votes`)}
        </span>
        <input
          className="PollNode__optionInput"
          type="text"
          value={text}
          onChange={e => {
            const target = e.target;
            const value = target.value;
            const {selectionStart, selectionEnd} = target;
            withPollNode(
              node => {
                node.setOptionText(option, value);
              },
              () => {
                target.selectionStart = selectionStart;
                target.selectionEnd = selectionEnd;
              },
            );
          }}
          placeholder={`Option ${index + 1}`}
        />
      </div>
      <button
        disabled={options.length < 3}
        className={joinClasses(
          'PollNode__optionDelete',
          options.length < 3 && 'PollNode__optionDeleteDisabled',
        )}
        aria-label="Remove"
        onClick={() => {
          withPollNode(node => {
            node.deleteOption(option);
          });
        }}
      />
    </div>
  );
}

export default function PollComponent({
  question,
  options,
  nodeKey,
}: {
  nodeKey: NodeKey;
  options: Options;
  question: string;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const totalVotes = useMemo(() => getTotalVotes(options), [options]);
  const [isSelected, setSelected, clearSelection] =
    useLexicalNodeSelection(nodeKey);
  const [selection, setSelection] = useState<BaseSelection | null>(null);
  const ref = useRef(null);

  useEffect(() => {
    return mergeRegister(
      editor.registerUpdateListener(({editorState}) => {
        setSelection(editor.read(editorState, () => $getSelection()));
      }),
      editor.registerCommand(
        CLICK_COMMAND,
        payload => {
          const event = payload;

          if (event.target === ref.current) {
            if (!event.shiftKey) {
              clearSelection();
            }
            setSelected(!isSelected);
            return true;
          }

          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [clearSelection, editor, isSelected, nodeKey, setSelected]);

  const withPollNode = (
    cb: (node: PollNode) => void,
    onUpdate?: () => void,
  ): void => {
    editor.update(
      () => {
        const node = $getNodeByKey(nodeKey);
        if ($isPollNode(node)) {
          cb(node);
        }
      },
      {onUpdate},
    );
  };

  const addOption = () => {
    withPollNode(node => {
      node.addOption(createPollOption());
    });
  };

  const isFocused = $isNodeSelection(selection) && isSelected;

  return (
    <div
      className={`PollNode__container ${isFocused ? 'focused' : ''}`}
      ref={ref}>
      <div className="PollNode__inner">
        <h2 className="PollNode__heading">{question}</h2>
        {options.map((option, index) => {
          const key = option.uid;
          return (
            <PollOptionComponent
              key={key}
              withPollNode={withPollNode}
              option={option}
              index={index}
              options={options}
              totalVotes={totalVotes}
            />
          );
        })}
        <div className="PollNode__footer">
          <Button onClick={addOption} small={true}>
            Add Option
          </Button>
        </div>
      </div>
    </div>
  );
}
