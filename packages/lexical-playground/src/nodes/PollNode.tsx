/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';

import {
  $getDocument,
  $getState,
  $setState,
  createState,
  DecoratorNode,
  type DOMExportOutput,
  type LexicalNode,
  type SerializedLexicalNode,
  type Spread,
  type StateConfigValue,
  type StateValueOrUpdater,
} from 'lexical';
import * as React from 'react';

export type Options = readonly Option[];

export type Option = Readonly<{
  text: string;
  uid: string;
  votes: string[];
}>;

const PollComponent = React.lazy(() => import('./PollComponent'));

function createUID(): string {
  return Math.random()
    .toString(36)
    .replace(/[^a-z]+/g, '')
    .substring(0, 5);
}

export function createPollOption(text = ''): Option {
  return {
    text,
    uid: createUID(),
    votes: [],
  };
}

function cloneOption(option: Option, text: string, votes?: string[]): Option {
  return {
    text,
    uid: option.uid,
    votes: votes || Array.from(option.votes),
  };
}

export type SerializedPollNode = Spread<
  {
    question: string;
    options: Options;
  },
  SerializedLexicalNode
>;

function parseOptions(json: unknown): Options {
  const options = [];
  if (Array.isArray(json)) {
    for (const row of json) {
      if (
        row &&
        typeof row.text === 'string' &&
        typeof row.uid === 'string' &&
        Array.isArray(row.votes) &&
        row.votes.every((v: unknown) => typeof v === 'string')
      ) {
        options.push(row);
      }
    }
  }
  return options;
}

const questionState = createState('question', {
  parse: v => (typeof v === 'string' ? v : ''),
});
const optionsState = createState('options', {
  isEqual: (a, b) =>
    a.length === b.length && JSON.stringify(a) === JSON.stringify(b),
  parse: parseOptions,
});

export class PollNode extends DecoratorNode<JSX.Element> {
  $config() {
    return this.config('poll', {
      extends: DecoratorNode,
      stateConfigs: [
        {flat: true, stateConfig: questionState},
        {flat: true, stateConfig: optionsState},
      ],
    });
  }

  getQuestion(): StateConfigValue<typeof questionState> {
    return $getState(this, questionState);
  }
  setQuestion(valueOrUpdater: StateValueOrUpdater<typeof questionState>): this {
    return $setState(this, questionState, valueOrUpdater);
  }
  getOptions(): StateConfigValue<typeof optionsState> {
    return $getState(this, optionsState);
  }
  setOptions(valueOrUpdater: StateValueOrUpdater<typeof optionsState>): this {
    return $setState(this, optionsState, valueOrUpdater);
  }

  addOption(option: Option): this {
    return this.setOptions(options => [...options, option]);
  }

  deleteOption(option: Option): this {
    return this.setOptions(prevOptions => {
      const index = prevOptions.indexOf(option);
      if (index === -1) {
        return prevOptions;
      }
      const options = Array.from(prevOptions);
      options.splice(index, 1);
      return options;
    });
  }

  setOptionText(option: Option, text: string): this {
    return this.setOptions(prevOptions => {
      const clonedOption = cloneOption(option, text);
      const options = Array.from(prevOptions);
      const index = options.indexOf(option);
      options[index] = clonedOption;
      return options;
    });
  }

  toggleVote(option: Option, username: string): this {
    return this.setOptions(prevOptions => {
      const index = prevOptions.indexOf(option);
      if (index === -1) {
        return prevOptions;
      }
      const votes = option.votes;
      const votesClone = Array.from(votes);
      const voteIndex = votes.indexOf(username);
      if (voteIndex === -1) {
        votesClone.push(username);
      } else {
        votesClone.splice(voteIndex, 1);
      }
      const clonedOption = cloneOption(option, option.text, votesClone);
      const options = Array.from(prevOptions);
      options[index] = clonedOption;
      return options;
    });
  }

  exportDOM(): DOMExportOutput {
    const element = $getDocument().createElement('span');
    element.setAttribute('data-lexical-poll-question', this.getQuestion());
    element.setAttribute(
      'data-lexical-poll-options',
      JSON.stringify(this.getOptions()),
    );
    return {element};
  }

  createDOM(): HTMLElement {
    const elem = $getDocument().createElement('span');
    elem.style.display = 'inline-block';
    return elem;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): JSX.Element {
    return (
      <PollComponent
        question={this.getQuestion()}
        options={this.getOptions()}
        nodeKey={this.__key}
      />
    );
  }
}

export function $createPollNode(question: string, options: Options): PollNode {
  return new PollNode().setQuestion(question).setOptions(options);
}

export function $isPollNode(
  node: LexicalNode | null | undefined,
): node is PollNode {
  return node instanceof PollNode;
}
