/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Rei Hakurei
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Message } from "discord-types/general";

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Forms, FluxDispatcher } from "@webpack/common";

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

const filteredMessage = '-# This message has been filtered.';

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
  if (typeof types === 'string') types = types.split(/\s+/);

  function wrap(event) {
    if (!(types.indexOf(event.type) + 1)) return false;
    return callback(event);
  }

  interceptor.map.push([callback, types, wrap]);
  // @ts-ignore
  FluxDispatcher.addInterceptor(wrap);
}

interceptor.map = [];

function removeInterceptor(types, callback: (event: any) => boolean) {
  if (typeof types === 'string') types = types.split(/\s+/);

  const pairIndex = interceptor.map.findIndex(pair => pair[0] === callback);
  if (typeof pairIndex !== 'number') return;

  const [pairFun, pairTypes, wrap] = interceptor.map.splice(pairIndex, 1).pop().pop();
  filterArray(pairTypes, type => !(types.indexOf(type) + 1));
  // do not remove the interceptor if it's not empty yet
  if (pairTypes.length > 0) return;
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

function _redactEmojiFromReactions(message: Message) {
  if (!message.reactions?.length) return;
  filterArray(message.reactions, reaction => _isEmojiGood(reaction.emoji));
}

function _redactEmojiFromMessageData(message: Message) {
  try {
    _redactEmojiFromContent(message);
    _redactEmojiFromReactions(message);
  } catch (e) {
    new Logger('FilterUnwantedEmoji').error('Unable to cleanup unwanted emojis.', e);
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

  start() {
    FluxDispatcher.subscribe('MESSAGE_CREATE', this.onMessageFilterOne);
    FluxDispatcher.subscribe('MESSAGE_UPDATE', this.onMessageFilterOne);
    FluxDispatcher.subscribe('LOAD_MESSAGES_SUCCESS', this.onMessageFilterMany);

    // subscribePriority('MESSAGE_REACTION_ADD', this.onReactionFilterOne);
    interceptor(['MESSAGE_REACTION_ADD'], this.interceptReactionOne);
    subscribePriority('MESSAGE_REACTION_ADD_MANY', this.onReactionFilterMany);
  },
  stop() {
    FluxDispatcher.unsubscribe('MESSAGE_CREATE', this.onMessageFilterOne);
    FluxDispatcher.unsubscribe('MESSAGE_UPDATE', this.onMessageFilterOne);
    FluxDispatcher.unsubscribe('LOAD_MESSAGES_SUCCESS', this.onMessageFilterMany);

    // FluxDispatcher.unsubscribe('MESSAGE_REACTION_ADD', this.onReactionFilterOne);
    removeInterceptor(['MESSAGE_REACTION_ADD'], this.interceptReactionOne);
    FluxDispatcher.unsubscribe('MESSAGE_REACTION_ADD_MANY', this.onReactionFilterMany);
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
  onReactionFilterOne(event) {
    if (_isEmojiGood(event.emoji)) return;
    Object.assign(event, {emoji: {id: null, name: '�'}});
  },
  onReactionFilterMany(event) {
    filterArray(event.reactions, reaction => _isEmojiGood(reaction.emoji));
  },
  // cancel MESSAGE_REACTION_ADD event if blacklisted emoji
  interceptReactionOne(event) {
    if (!(['MESSAGE_REACTION_ADD'].indexOf(event.type) + 1)) return false;
    try {
      if (_isEmojiGood(event.emoji)) return false;
    } catch (e) {
      new Logger('FilterUnwantedEmoji').error('Unable to halt emoji reaction.', e);
      return false;
    }
    return true;
  },
  // cancel MESSAGE_REACTION_ADD_MANY event if all emojis wiped out
  interceptReactionMany(event) {
    if (!(['MESSAGE_REACTION_ADD_MANY'].indexOf(event.type) + 1)) return false;
    filterArray(event.reactions, reaction => _isEmojiGood(reaction.emoji));
    if (event.reactions.size) return false;
    return true;
  },
});
