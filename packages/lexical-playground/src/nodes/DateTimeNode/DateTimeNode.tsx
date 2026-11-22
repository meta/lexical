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
  $create,
  $getDocument,
  $getState,
  $getStateChange,
  $setState,
  createState,
  type DOMExportOutput,
  type LexicalNode,
  type Spread,
  stringValue,
  transformValue,
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

// An all-day date is stored as just its calendar date (`2026-11-04`), so it
// is the same day in every time zone. Every other value is an instant
// (`2026-11-04T05:00:00.000Z`), and a node without a date stores ''.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function padNumber(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

// The year, month (1-12) and day of a date-only value that is a calendar
// date, or null. setUTCFullYear keeps years 0-99, which Date.UTC would read
// as 1900-1999.
function parseDateOnly(value: string): [number, number, number] | null {
  const match = DATE_ONLY.exec(value);
  if (match === null) {
    return null;
  }
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? [year, month, day]
    : null;
}

function formatDateOnly(year: number, month: number, day: number): string {
  return `${padNumber(year, 4)}-${padNumber(month, 2)}-${padNumber(day, 2)}`;
}

function getInstantValue(dateTime: Date): string {
  return isNaN(dateTime.getTime()) ? '' : dateTime.toISOString();
}

/**
 * Keeps a date-only value that is a calendar date as written, and reads any
 * other value as an instant the way older versions did.
 */
export function normalizeDateTime(value: string): string {
  if (DATE_ONLY.test(value)) {
    return parseDateOnly(value) === null ? '' : value;
  }
  const time = Date.parse(value);
  return isNaN(time) ? '' : new Date(time).toISOString();
}

/**
 * The local `HH:MM` of an instant, or '' for an all-day date, a missing date
 * or an instant at local midnight (shown without a time).
 */
export function getTimeValue(value: string): string {
  if (DATE_ONLY.test(value)) {
    return '';
  }
  const dateTime = new Date(value);
  const hours = dateTime.getHours();
  const minutes = dateTime.getMinutes();
  return isNaN(dateTime.getTime()) || (hours === 0 && minutes === 0)
    ? ''
    : `${padNumber(hours, 2)}:${padNumber(minutes, 2)}`;
}

// Matches Date.prototype.toDateString(), computed from the calendar date
// itself so that a day the local time zone skipped is still shown.
function getDateTimeText(value: string): string {
  const fields = parseDateOnly(value);
  if (fields !== null) {
    const [year, month, day] = fields;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return `${DAYS[date.getUTCDay()]} ${MONTHS[month - 1]} ${padNumber(
      day,
      2,
    )} ${padNumber(year, 4)}`;
  }
  const dateTime = new Date(value);
  const time = getTimeValue(value);
  return dateTime.toDateString() + (time === '' ? '' : ` ${time}`);
}

export type SerializedDateTimeNode = Spread<
  {
    dateTime?: string;
  },
  SerializedDecoratorTextNode
>;

const dateTimeState = createState('dateTime', {
  parse: transformValue(stringValue(), normalizeDateTime),
});

export class DateTimeNode extends DecoratorTextNode {
  $config() {
    return this.config('datetime', {
      extends: DecoratorTextNode,
      stateConfigs: [{flat: true, stateConfig: dateTimeState}],
    });
  }

  /**
   * The date as a Date: an instant as itself, and an all-day date as local
   * midnight of that day (or the nearest local time when the local time zone
   * skipped that midnight or that day).
   */
  getDateTime(): Date {
    const value = this.getDateTimeValue();
    const fields = parseDateOnly(value);
    if (fields === null) {
      return new Date(value);
    }
    const [year, month, day] = fields;
    // Midnight first: the time of day new Date(0) starts with could be one
    // the local time zone skipped on that day, moving it to the next day
    const dateTime = new Date(0);
    dateTime.setHours(0, 0, 0, 0);
    dateTime.setFullYear(year, month - 1, day);
    return dateTime;
  }

  /**
   * Stores an instant. An updater that returns the same instant writes
   * nothing, so it keeps an all-day date all-day.
   */
  setDateTime(valueOrUpdater: Date | ((prevValue: Date) => Date)): this {
    if (typeof valueOrUpdater !== 'function') {
      return $setState(this, dateTimeState, getInstantValue(valueOrUpdater));
    }
    const prevValue = this.getDateTime();
    const prevTime = prevValue.getTime();
    const nextValue = valueOrUpdater(prevValue);
    return Object.is(nextValue.getTime(), prevTime)
      ? this
      : $setState(this, dateTimeState, getInstantValue(nextValue));
  }

  /** The stored value: `YYYY-MM-DD`, an ISO instant, or ''. */
  getDateTimeValue(): string {
    return $getState(this, dateTimeState);
  }

  isAllDay(): boolean {
    return DATE_ONLY.test(this.getDateTimeValue());
  }

  /**
   * Stores the local calendar date of `date` as an all-day date. A year
   * outside 0-9999 is stored as an instant, and an invalid date is ignored.
   */
  setAllDayDate(date: Date): this {
    if (isNaN(date.getTime())) {
      return this;
    }
    const year = date.getFullYear();
    const value =
      year < 0 || year > 9999
        ? date.toISOString()
        : formatDateOnly(year, date.getMonth() + 1, date.getDate());
    return value === this.getDateTimeValue()
      ? this
      : $setState(this, dateTimeState, value);
  }

  getTextContent(): string {
    return getDateTimeText(this.getDateTimeValue());
  }

  exportDOM(): DOMExportOutput {
    const element = $getDocument().createElement('span');
    const textDom: HTMLElement | Text = $getDocument().createTextNode(
      this.getTextContent(),
    );
    element.setAttribute('data-lexical-datetime', this.getDateTimeValue());
    element.appendChild(applyFormatToDom(this, textDom, tagToFormat));

    return {element};
  }

  createDOM(): HTMLElement {
    const element = $getDocument().createElement('span');
    element.setAttribute('data-lexical-datetime', this.getDateTimeValue());
    element.style.display = 'inline-block';
    return element;
  }

  updateDOM(prevNode: this, dom: HTMLElement): false {
    if ($getStateChange(this, prevNode, dateTimeState)) {
      dom.setAttribute('data-lexical-datetime', this.getDateTimeValue());
    }
    return false;
  }

  decorate(): JSX.Element {
    return (
      <DateTimeComponent
        dateTime={this.getDateTime()}
        format={this.getFormat()}
        nodeKey={this.__key}
        text={this.getTextContent()}
        value={this.getDateTimeValue()}
      />
    );
  }
}

export function $createDateTimeNode(dateTime: Date): DateTimeNode {
  return new DateTimeNode().setDateTime(dateTime);
}

/**
 * Creates a node from a stored or attribute value without going through a
 * Date, so an all-day date keeps its day. Returns null when the value is not
 * a date.
 */
export function $createDateTimeNodeFromValue(
  value: string,
): DateTimeNode | null {
  const normalized = normalizeDateTime(value);
  return normalized === ''
    ? null
    : $setState($create(DateTimeNode), dateTimeState, normalized);
}

export function $isDateTimeNode(
  node: LexicalNode | null | undefined,
): node is DateTimeNode {
  return node instanceof DateTimeNode;
}
