/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';

import {
  applyFormatToDom,
  DecoratorTextNode,
  type SerializedDecoratorTextNode,
} from '@lexical/extension';
import {
  $getDocument,
  $getState,
  $setState,
  createState,
  type DOMExportOutput,
  type LexicalNode,
  type Spread,
  type StateConfigValue,
  type StateValueOrUpdater,
} from 'lexical';
import * as React from 'react';

const DateTimeComponent = React.lazy(() => import('./DateTimeComponent'));

const tagToFormat = {
  b: 'bold',
  i: 'italic',
  mark: 'highlight',
  s: 'strikethrough',
  u: 'underline',
} as const;

const getDateTimeText = (dateTime: Date) => {
  if (dateTime === undefined) {
    return '';
  }
  const hours = dateTime?.getHours();
  const minutes = dateTime?.getMinutes();
  return (
    dateTime.toDateString() +
    (hours === 0 && minutes === 0
      ? ''
      : ` ${hours.toString().padStart(2, '0')}:${minutes
          .toString()
          .padStart(2, '0')}`)
  );
};

export type SerializedDateTimeNode = Spread<
  {
    dateTime?: string;
  },
  SerializedDecoratorTextNode
>;

const dateTimeState = createState('dateTime', {
  parse: v => new Date(v as string),
  unparse: v => v.toISOString(),
});

export class DateTimeNode extends DecoratorTextNode {
  $config() {
    return this.config('datetime', {
      extends: DecoratorTextNode,
      stateConfigs: [{flat: true, stateConfig: dateTimeState}],
    });
  }

  getDateTime(): StateConfigValue<typeof dateTimeState> {
    return $getState(this, dateTimeState);
  }

  setDateTime(valueOrUpdater: StateValueOrUpdater<typeof dateTimeState>): this {
    return $setState(this, dateTimeState, valueOrUpdater);
  }

  getTextContent(): string {
    const dateTime = this.getDateTime();
    return getDateTimeText(dateTime);
  }

  exportDOM(): DOMExportOutput {
    const element = $getDocument().createElement('span');
    const textDom: HTMLElement | Text = $getDocument().createTextNode(
      getDateTimeText(this.getDateTime()),
    );
    element.setAttribute(
      'data-lexical-datetime',
      this.getDateTime()?.toString() || '',
    );
    element.appendChild(applyFormatToDom(this, textDom, tagToFormat));

    return {element};
  }

  createDOM(): HTMLElement {
    const element = $getDocument().createElement('span');
    element.setAttribute(
      'data-lexical-datetime',
      this.getDateTime()?.toString() || '',
    );
    element.style.display = 'inline-block';
    return element;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): JSX.Element {
    return (
      <DateTimeComponent
        dateTime={this.getDateTime()}
        format={this.getFormat()}
        nodeKey={this.__key}
      />
    );
  }
}

export function $createDateTimeNode(dateTime: Date): DateTimeNode {
  return new DateTimeNode().setDateTime(dateTime);
}

export function $isDateTimeNode(
  node: LexicalNode | null | undefined,
): node is DateTimeNode {
  return node instanceof DateTimeNode;
}
