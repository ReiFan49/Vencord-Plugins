/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Rei Hakurei
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Message } from "discord-types/general";

import { definePluginSettings } from "@api/Settings";
import definePlugin, {
  pluginInterceptors, defineInterceptor,
  OptionType
} from "@utils/types";
import { Forms, FluxDispatcher, UtilTypes } from "@webpack/common";

const settings = definePluginSettings({
  emojiNames: {
    type: OptionType.STRING,
    description: 'Emoji Names to Filter',
    default: 'blob ~elgoog ~urodap ~foo GWinfx',
  },
  emojiIDs: {
    type: OptionType.STRING,
    description: 'Emoji IDs to Filter',
    default: '',
  },
});

const filteredMessage = '-# This message has been filtered.';

/* utility */

interface FilterExtension {
  _filterData?: {
    original: string;
    after: string;
  };
}
type FilteredMessage = Message & FilterExtension;

function emojiName(s : string) : string {
  return (s[0] === '~') ? reverseString(s.slice(1)) : s;
}
function reverseString(s : string) : string {
  return Array.from(String(s)).reverse().join('');
}

function subscribePriority(type, callback: UtilTypes.FluxCallbackAction) {
  const subs : Set<any> = FluxDispatcher._subscriptions[type];
  if (!subs)
    return FluxDispatcher.subscribe(type, callback);
  FluxDispatcher._subscriptions[type] = new Set([callback, ...subs]);
}

function filterArray(array : any[], callback: (data: any) => boolean) {
  array.push(...array.splice(0).filter(callback));
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

function _redactEmojiFromContent(message: FilteredMessage) {
  const toRemove : RegExp[] = [];
  // @ts-ignore
  const baseContent = ('_filterData' in message) ? message._filterData.after : message.content;
  message.content = baseContent;
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
    // @ts-ignore
    message._filterData = {
      original: baseContent,
      after:    message.content.trim(),
    };
  }
  if ('_filterData' in message) {
    // @ts-ignore
    message.content = [message._filterData.after, filteredMessage].join('\n').trim();
  }
}

function _redactEmojiFromReactions(message: FilteredMessage) {
  if (!message.reactions?.length) return;
  filterArray(message.reactions, reaction => _isEmojiGood(reaction.emoji));
}

function _redactEmojiFromMessageData(message: FilteredMessage) {
  try {
    _redactEmojiFromContent(message);
    _redactEmojiFromReactions(message);
  } catch (e) {
    new Logger('FilterUnwantedEmoji').error('Unable to cleanup unwanted emojis.', e);
  }
}

/* interceptors */
function interceptReactionOne(event: any) : boolean {
  if (_isEmojiGood(event.emoji)) return false;
  return true;
};
function interceptReactionMany(event: any) : boolean {
  filterArray(event.reactions, reaction => _isEmojiGood(reaction.emoji));
  if (event.reactions.size) return false;
  return true;
};
const fluxInterceptors = pluginInterceptors(
  defineInterceptor(interceptReactionOne, 'MESSAGE_REACTION_ADD'),
  defineInterceptor(interceptReactionMany, 'MESSAGE_REACTION_ADD_MANY'),
);

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

        Emoji Names are case-insensitive and treated as any-side wildcard. <br />
        Prefixing Emoji Name with a tilde "~" reverses the given entry.
        Mainly used to avoid detection or high sterilization environment. <br /><br />

        <em>Emojis filtered will not be fully restored <strong>without restarting</strong> the client.</em>
      </Forms.FormText>
    </>
  ),
  settings,
  /* patches: [
    ...[
      '="MessageStore",',
      '="ThreadMessageStore",',
      '"displayName","ReadStateStore")',
    ].map(find => ({
      find,
      replacement: [{
        match: /(?<=(?:MESSAGE_CREATE|MESSAGE_UPDATE):function\((\i)\){)/,
        replace: (_, event) => `$self.onMessageFilterOne(${event}.message);`,
      },{
        match: /(?<=LOAD_MESSAGES_SUCCESS:function\((\i)\){)/,
        replace: (_, event) => `${event}.messages.forEach(msg=>$self.emojiRedactFromMessage(msg));`,
      }],
    })),
  ], */
  fluxInterceptors,

  start() {
    FluxDispatcher.subscribe('MESSAGE_CREATE', this.onMessageFilterOne);
    FluxDispatcher.subscribe('MESSAGE_UPDATE', this.onMessageFilterOne);
    FluxDispatcher.subscribe('LOAD_MESSAGES_SUCCESS', this.onMessageFilterMany);
  },
  stop() {
    FluxDispatcher.unsubscribe('MESSAGE_CREATE', this.onMessageFilterOne);
    FluxDispatcher.unsubscribe('MESSAGE_UPDATE', this.onMessageFilterOne);
    FluxDispatcher.unsubscribe('LOAD_MESSAGES_SUCCESS', this.onMessageFilterMany);
  },

  onMessageFilterOne(event) {
    const oldMessage = JSON.stringify(event.message);
    _redactEmojiFromMessageData(event.message);
    const newMessage = JSON.stringify(event.message);
    if (oldMessage !== newMessage)
      FluxDispatcher.dispatch(event);
  },
  onMessageFilterMany(event) {
    const oldMessages = JSON.stringify(event.messages);
    event.messages.forEach(msg => _redactEmojiFromMessageData(msg));
    const newMessages = JSON.stringify(event.messages);
    if (oldMessages !== newMessages)
      FluxDispatcher.dispatch(event);
  },
});
