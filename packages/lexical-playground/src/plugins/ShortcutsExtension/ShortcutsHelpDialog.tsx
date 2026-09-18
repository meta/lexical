/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './ShortcutsHelpDialog.css';

import {IS_APPLE} from 'lexical';
import {Fragment, type JSX, useLayoutEffect, useState} from 'react';

import {getShortcuts} from './shortcuts';

function humanize(key: string): string {
  return key
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/(\d+)/g, ' $1')
    .trim()
    .replace(/^(\w)/, c => c.toUpperCase());
}

const PLATFORMS = [
  {icon: 'apple', label: 'macOS', value: true},
  {icon: 'windows', label: 'Windows / Linux', value: false},
] as const;

export default function ShortcutsHelpDialog(): JSX.Element {
  const [isApple, setIsApple] = useState(false);
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsApple(IS_APPLE);
  }, []);
  return (
    <div className="ShortcutsHelpDialog">
      <div
        className="ShortcutsHelpDialog__platforms"
        role="radiogroup"
        aria-label="Keyboard layout">
        {PLATFORMS.map(platform => (
          <button
            key={+platform.value}
            type="button"
            role="radio"
            aria-checked={isApple === platform.value}
            className="ShortcutsHelpDialog__platform"
            onClick={e => {
              e.preventDefault();
              setIsApple(platform.value);
            }}>
            <i
              className={`ShortcutsHelpDialog__platformIcon ${platform.icon}`}
            />
            {platform.label}
          </button>
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th className="ShortcutsHelpDialog__heading__action">Action</th>
            <th className="ShortcutsHelpDialog__heading__shortcut">Shortcut</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(getShortcuts(isApple)).map(([action, keys]) => (
            <tr key={action}>
              <td className="ShortcutsHelpDialog__action">
                {humanize(action)}
              </td>
              <td
                className="ShortcutsHelpDialog__shortcut"
                data-platform={isApple ? 'apple' : 'other'}>
                {keys.map((v, i) => (
                  <Fragment key={v}>
                    {i > 0 && (
                      <span className="ShortcutsHelpDialog__separator" />
                    )}
                    <kbd>{v}</kbd>
                  </Fragment>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
