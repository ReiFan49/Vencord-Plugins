/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Rei Hakurei
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Message } from "discord-types/general";

import { Logger } from "@utils/Logger";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Forms } from "@webpack/common";

const settings = definePluginSettings({
  emojiNames: {
    type: OptionType.STRING,
    description: 'Emoji Names to Filter',
    default: 'blob ~elgoog ~urodap ~foo GWinfx',
  },
  emojiIDs: {
    type: OptionType.STRING,
    description: 'Emoji IDs to Filter',
    default: '268029172880769025 268029172641693696 268049559169531904 268029174134865920',
  },
});

/* utility */

function emojiName(s : string) : string {
  return (s[0] === '~') ? reverseString(s.slice(1)) : s;
}
function reverseString(s : string) : string {
  return Array.from(String(s)).reverse().join('');
}

function subscribePriority(type, callback: (data: any) => void) {
  const subs : Set<any> = FluxDispatcher._subscriptions[type];
  if (!subs)
    return FluxDispatcher.subscribe(type, callback);
  FluxDispatcher._subscriptions[type] = new Set([callback, ...subs]);
}

function filterArray(array : any[], callback: (data: any) => boolean) {
  array.push(...array.splice(0).filter(callback));
}

function interceptor(types, callback: (event: any) => boolean) {
  function wrap(event) {
    if (!(types.indexOf(event.type) + 1)) return false;
    return callback(event);
  }

  interceptor.map.push([callback, wrap]);
  // @ts-ignore
  FluxDispatcher.addInterceptor(wrap);
}

interceptor.map = [];

function removeInterceptor(types, callback: (event: any) => boolean) {
  const pairIndex = interceptor.map.findIndex(pair => pair[0] === callback);
  if (typeof pairIndex !== 'number') return;

  const wrap = interceptor.map.splice(pairIndex, 1).pop().pop();
  // @ts-ignore
  FluxDispatcher._interceptors.splice(wrap, 1);
}

/* blacklist settings */

function blacklistNames() : string[] {
  return settings.store.emojiNames.split(/\s+/)
    .map(name => emojiName(name))
    .filter(name => /^[A-Za-z0-9_]{2,}/.test(name));
}
function blacklistIDs() : string[] {
  return settings.store.emojiIDs.split(/\s+/)
    .filter(id => /^[1-9][0-9]+/.test(id));
}

/* internal functions */

function _isEmojiGood(emoji) {
  if (emoji.id === null) return true;
  if (blacklistNames().some(name => emoji.name.indexOf(name) + 1)) return false;
  if (blacklistIDs().indexOf(String(emoji.id)) + 1) return false;
  return true;
}

function _redactEmojiFromContent(message: Message) {
  const toRemove : RegExp[] = [];
  const baseContent = message.content;
  blacklistNames().forEach(name => {
    toRemove.push(new RegExp(`<a?[:]\\w*${name}\\w*[:](?:\\d+)>`, 'ig'));
  });
  blacklistIDs().forEach(emojiID => {
    toRemove.push(new RegExp(`<a?[:](?:\\w+)[:]${emojiID}>`, 'ig'));
  });
  toRemove.forEach(expr => {
    message.content = message.content.replace(expr, '');
  });
  if (baseContent !== message.content) {
    message.content = [message.content, "-# This message has been filtered."].join("\n").trim();
  }
}

function _redactEmojiFromReactions(message: Message) {
  if (!message.reactions?.length) return;
  filterArray(message.reactions, reaction => _isEmojiGood(reaction.emoji));
}

function _redactEmojiFromMessageData(message: Message) {
  try {
    _redactEmojiFromContent(message);
    _redactEmojiFromReactions(message);
  } catch (e) {
    new Logger("FilterUnwantedEmoji").error("Unable to cleanup unwanted emojis.", e);
  }
}

/* plugin */

export default definePlugin({
  name: 'FilterUnwantedEmoji',
  authors: [{name: 'Rei Hakurei', id: 212483631631958016n}],
  description: 'Removes specific emoji from viewing.',
  settingsAboutComponent: () => (
    <>
      <Forms.FormTitle tag="h3">Entry Format</Forms.FormTitle>
      <Forms.FormText>
        Each field supports a space-separated entries. <br /><br />

        Emoji Names are case-insensitive and treated as any-side wildcard.
        Prefixing Emoji Name with a tilde "~" reverses the given entry.
        Mainly used to avoid detection or high sterilization environment.
      </Forms.FormText>
    </>
  ),
  settings,
  patches: [
    ...[
      '="MessageStore",',
      '="ThreadMessageStore",',
      '"displayName","ReadStateStore")',
    ].map(find => ({
      find,
      replacement: [{
        match: /(?<=(?:MESSAGE_CREATE|MESSAGE_UPDATE):function\((\i)\){)/,
        replace: (_, event) => `$self.emojiRedactFromMessage(${event}.message);`,
      },{
        match: /(?<=LOAD_MESSAGES_SUCCESS:function\((\i)\){)/,
        replace: (_, event) => `${event}.messages.forEach(msg=>$self.emojiRedactFromMessage(msg));`,
      }],
    })),
  ],
  emojiRedactFromContent(message: Message) {
    const toRemove : RegExp[] = [];
    blacklistNames().forEach(name => {
      toRemove.push(new RegExp(`<a?[:]\\w*${name}\\w*[:](?:\\d+)>`, 'ig'));
    });
    blacklistIDs().forEach(emojiID => {
      toRemove.push(new RegExp(`<a?[:](?:\\w+)[:]${emojiID}>`, 'ig'));
    });
    toRemove.forEach(expr => {
      message.content = message.content.replace(expr, '');
    });
  },
  emojiRedactFromReaction(message: Message) {
    if (!message.reactions?.length) return;
    message.reactions.push(
      ...message.reactions.splice(0).filter(
        reaction => {
          if (reaction?.emoji.id === null) return true;
          if (blacklistNames().some(name => reaction.emoji.name.indexOf(name) + 1)) return false;
          if (blacklistIDs().indexOf(String(reaction.emoji.id)) + 1) return false;
          return true;
        }
      ));
  },
  emojiRedactFromMessage(message: Message) {
    try {
      this.emojiRedactFromContent(message);
      this.emojiRedactFromReaction(message);
    } catch (e) {
      new Logger("FilterUnwantedEmoji").error("Unable to cleanup unwanted emojis.", e);
    }
  },
});
