/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import 'react-day-picker/style.css';
import './DateTimeNode.css';

import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingOverlay,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useLexicalNodeSelection} from '@lexical/react/useLexicalNodeSelection';
import {
  $getNodeByKey,
  IS_BOLD,
  IS_HIGHLIGHT,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_UNDERLINE,
  type NodeKey,
  registerEventListener,
} from 'lexical';
import * as React from 'react';
import {type JSX, useEffect, useRef, useState} from 'react';
import {DayPicker} from 'react-day-picker';

import {$isDateTimeNode, type DateTimeNode, getTimeValue} from './DateTimeNode';

const FORMAT_CLASSES = [
  [IS_BOLD, 'bold'],
  [IS_HIGHLIGHT, 'highlight'],
  [IS_ITALIC, 'italic'],
  [IS_STRIKETHROUGH, 'strikethrough'],
  [IS_UNDERLINE, 'underline'],
] as const;

const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// [hours, minutes] of a complete `HH:MM` from the time input, or null
function parseTime(time: string): [number, number] | null {
  const match = /^(\d{2}):(\d{2})/.exec(time);
  return match === null ? null : [Number(match[1]), Number(match[2])];
}

function withTime(date: Date, [hours, minutes]: [number, number]): Date {
  const dateTime = new Date(date);
  dateTime.setHours(hours, minutes, 0, 0);
  return dateTime;
}

export default function DateTimeComponent({
  dateTime,
  format,
  nodeKey,
  text,
  value,
}: {
  dateTime: Date;
  format: number;
  nodeKey: NodeKey;
  text: string;
  value: string;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef(null);
  // The picker is drawn from the node's value on every render. The only local
  // state is what the user did that the node does not hold yet: a checked
  // time box with no time, and the text of the time input.
  const [isTimeChecked, setIsTimeChecked] = useState(false);
  const [typedTime, setTypedTime] = useState<string | null>(null);
  // The value this component last wrote, to tell its own change coming back
  // from an outside one (undo, redo, a collaborator)
  const [ownValue, setOwnValue] = useState<string | null>(null);
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setOwnValue(null);
    if (value !== ownValue) {
      setIsTimeChecked(false);
      setTypedTime(null);
    }
  }
  const storedTime = getTimeValue(value);
  const includeTime = isTimeChecked || storedTime !== '';
  const timeValue = typedTime ?? storedTime;
  const selected = isNaN(dateTime.getTime()) ? undefined : dateTime;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [isNodeSelected, setNodeSelected, clearNodeSelection] =
    useLexicalNodeSelection(nodeKey);

  const {refs, floatingStyles, context} = useFloating({
    elements: {
      reference: ref.current,
    },
    middleware: [
      offset(5),
      flip({
        fallbackPlacements: ['top-start'],
      }),
      shift({padding: 10}),
    ],
    onOpenChange: open => {
      setIsOpen(open);
      if (!open) {
        setTypedTime(null);
      }
    },
    open: isOpen,
    placement: 'bottom-start',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
  });

  const role = useRole(context, {role: 'dialog'});
  const dismiss = useDismiss(context);

  const {getFloatingProps} = useInteractions([role, dismiss]);

  useEffect(() => {
    const dateTimePillRef = ref.current as HTMLElement | null;
    function onClick(e: MouseEvent) {
      e.preventDefault();
      setIsOpen(true);
    }

    return dateTimePillRef
      ? registerEventListener(dateTimePillRef, 'click', onClick)
      : () => {};
  }, [refs, editor]);

  const withDateTimeNode = (cb: (node: DateTimeNode) => void): void => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isDateTimeNode(node)) {
        const before = node.getDateTimeValue();
        cb(node);
        const after = node.getDateTimeValue();
        if (after !== before) {
          setOwnValue(after);
        }
      }
    });
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setIsTimeChecked(true);
      return;
    }
    setIsTimeChecked(false);
    setTypedTime(null);
    withDateTimeNode(node => {
      // An all-day date stays as it is: going through a Date could move a day
      // that the local time zone skipped
      if (!node.isAllDay()) {
        node.setAllDayDate(dateTime);
      }
    });
  };

  const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = e.target.value;
    setTypedTime(time);
    const parsed = parseTime(time);
    if (parsed === null || selected === undefined) {
      return;
    }
    setIsTimeChecked(true);
    withDateTimeNode(node => node.setDateTime(withTime(selected, parsed)));
  };

  const handleDaySelect = (date: Date | undefined) => {
    if (date === undefined) {
      return;
    }
    // A typed time, or else the time the chip already has. An instant shown
    // without a time is at local midnight, which can be a time set in another
    // time zone or a typed 00:00, so it keeps that midnight. Only an all-day
    // date or a chip without a date stays all-day.
    const time = parseTime(timeValue) ?? parseTime(storedTime);
    withDateTimeNode(node => {
      if (time !== null) {
        node.setDateTime(withTime(date, time));
      } else if (node.isAllDay() || node.getDateTimeValue() === '') {
        node.setAllDayDate(date);
      } else {
        node.setDateTime(withTime(date, [0, 0]));
      }
    });
  };

  const classNames = ['dateTimePill'];
  for (const [flag, className] of FORMAT_CLASSES) {
    if (format & flag) {
      classNames.push(className);
    }
  }
  if (isNodeSelected) {
    classNames.push('selected');
  }

  return (
    <div className={classNames.join(' ')} ref={ref}>
      {text}
      {isOpen && (
        <FloatingPortal>
          <FloatingOverlay lockScroll={true}>
            <FloatingFocusManager context={context} initialFocus={-1}>
              <div
                className={'dateTimePicker'}
                ref={refs.setFloating}
                style={floatingStyles}
                {...getFloatingProps()}>
                <DayPicker
                  captionLayout="dropdown"
                  navLayout="after"
                  fixedWeeks={false}
                  showOutsideDays={false}
                  mode="single"
                  selected={selected}
                  required={true}
                  // timeZone="BST" TODO: Support time zone selection
                  onSelect={handleDaySelect}
                  startMonth={new Date(1925, 0)}
                  endMonth={new Date(2042, 7)}
                />
                <form style={{marginBlockEnd: '1em'}}>
                  <div
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      width: '300px',
                    }}>
                    <input
                      type="checkbox"
                      id="option1"
                      name="option1"
                      value="value1"
                      checked={includeTime}
                      onChange={handleCheckboxChange}
                    />
                    <label>
                      <input
                        type="time"
                        value={timeValue}
                        onChange={handleTimeChange}
                        disabled={!includeTime}
                      />
                    </label>
                    <span> {userTimeZone}</span>
                  </div>
                </form>
              </div>
            </FloatingFocusManager>
          </FloatingOverlay>
        </FloatingPortal>
      )}
    </div>
  );
}
