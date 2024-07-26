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

function emojiName(s) {
  return (s[0] === '~') ? reverseString(s.slice(1)) : s;
}
function reverseString(s) {
  return Array.from(String(s)).reverse().join('');
}

function blacklistNames() {
  return settings.store.emojiNames.split(/\s+/)
    .map(name => emojiName(name))
    .filter(name => /^[A-Za-z0-9_]{2,}/.test(name));
}
function blacklistIDs() {
  return settings.store.emojiIDs.split(/\s+/)
    .filter(id => /^[1-9][0-9]+/.test(id));
}

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
    const toRemove = [];
    blacklistNames().forEach(name => {
      toRemove.push(new RegExp(`<a?\:\\\w*${name}\\\w*\:(?:\\\d+)>`, 'ig'));
    });
    blacklistIDs().forEach(emojiID => {
      toRemove.push(new RegExp(`<a?\:(?:\\\w+)\:${emojiID}>`, 'ig'));
    });
    toRemove.forEach(expr => {
      message.content = message.content.replace(expr, '');
    });
  },
  emojiRedactFromReaction(message: Message) {
    if (!message.reactions?.length) return;
    [].push.apply(
      message.reactions,
      message.reactions.splice(0).filter(
        reaction => {
          if (reaction.emoji.id === null) return true;
          if (blacklistNames().some(name => reaction.emoji.name.indexOf(name) + 1)) return false;
          if (blacklistIDs().indexOf(reaction.emoji.id) + 1) return false;
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