/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Rei Hakurei
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Message } from "discord-types/general";

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import definePlugin, {
  pluginInterceptors, defineInterceptor,
  OptionType
} from "@utils/types";
import { Logger } from "@utils/Logger";
import {
  ChannelStore,
  Forms,
  FluxDispatcher,
  SnowflakeUtils,
  UserStore,
  UtilTypes
} from "@webpack/common";

const RECENT_PINGS_KEY = 'PingPunish_RecentPings';
const DELAYED_EVENTS_KEY = 'PingPunish_DelayedEvents';

const DELAYED_EVENT_INTERVAL = 995;
const PING_TOLERANCE_IMPLEMENTED = false;

const log = new Logger('PingPunish', '#ff0000');

enum MentionShadowType {
  Auto, Keep, Delay, Remove,
};

enum AutoAckType {
  Auto, Disabled, Instant, RandomDelayed,
};

interface MessageExtension {
  guild_id: string;
  referenced_message: MessageExtra;
}
type MessageExtra = Message & MessageExtension;

type SnowflakeCompatible = string | number;
type UserID = SnowflakeCompatible;
type LocalContent<T> = Record<UserID, T>;
type PingHistory = Map<SnowflakeCompatible, SnowflakeCompatible[]>;
type PingHistoryEntry = [SnowflakeCompatible, SnowflakeCompatible[]];
type DelayedEvents = any[];
type StoredPingHistory = LocalContent<PingHistory>;
type StoredDelayedEvents = LocalContent<DelayedEvents>;

function simpleTimeFormat(value) {
  const valueMin = value / 60;
  const valueHour = (value / 3600) | 0;
  const valueDay = (value / 86400) | 0;
  return (valueDay > 0) ? `${valueDay}d` : (
    (valueHour > 0) ? `${valueHour}h` : `${valueMin}min`
  );
}

function generateOptions(defaultValue, values, formatFunction) {
  return values.map(function(value){
    const defaultFlag = defaultValue === value ? { default: true } : null;

    return {
      label: typeof formatFunction === 'function' ? formatFunction(value) : value,
      value,
      ...defaultFlag,
    }
  });
}

const settings = definePluginSettings({
  pingTolerateCount: {
    /* description: 'Tolerates the amount of pings received in a server before punishing all upcoming pings.', */
    description: 'Pings to tolerate',
    type: OptionType.NUMBER,
    default: 1,
    hidden: !PING_TOLERANCE_IMPLEMENTED,
    disabled: () => !PING_TOLERANCE_IMPLEMENTED,
    componentProps: {
      min: 0,
    },
  },
  pingTimeWindow: {
    /* description: 'Adjusts how far from current active time pings are tolerated.', */
    description: 'Pings tolerate duration',
    type: OptionType.SELECT,
    options: generateOptions(
      21600,
      [
        300, 3600, 7200, 10800,
        14400, 21600, 28800,
        43200, 57600, 72000,
        86400, 259200, 604800,
      ],
      simpleTimeFormat,
    ),
    hidden: !PING_TOLERANCE_IMPLEMENTED,
    disabled: () => !PING_TOLERANCE_IMPLEMENTED,
  },

  punishStripMention: {
    description: 'Removes mention flag in the message.',
    type: OptionType.BOOLEAN,
    default: true,
  },
  punishShadowMessageType: {
    description: 'Lowers message visibility of direct pings in message.',
    type: OptionType.SELECT,
    options: [
      {label: 'Keep',   value: MentionShadowType.Keep},
      {label: 'Delay',  value: MentionShadowType.Delay, default: true},
      {label: 'Remove', value: MentionShadowType.Remove},
    ],
  },
  punishShadowMessageReplyPingDelayAmount: {
    description: 'Specifies the delay for reply ping',
    type: OptionType.SELECT,
    options: generateOptions(
      180,
      [
        60, 120, 180,
        300, 450, 600,
        900, 1200, 1500,
        1800, 2700, 3600,
      ],
      simpleTimeFormat,
    ),
    disabled: () => settings.store.punishShadowMessageType !== MentionShadowType.Delay,
  },
  punishAutoReadMessage: {
    description: 'Automatically acks respective channel where ping happened.',
    type: OptionType.SELECT,
    options: [
      {label: 'Disabled', value: AutoAckType.Disabled},
      {label: 'Delayed',  value: AutoAckType.RandomDelayed, default: true},
      {label: 'Instant',  value: AutoAckType.Instant},
    ],
  },
});

/* utility */

function mentionContentIsId(id) {
  return function comparison(mentionContent) {
    if (typeof mentionContent === 'object' && 'id' in mentionContent)
      return mentionContent.id === id;
    else
      return mentionContent === id;
  }
}

const Utility = {
  get userId() {
    return UserStore.getCurrentUser().id;
  },
  isPing(message: MessageExtra) {
    return !('mentioned' in message) || message.mentioned;
  },
  isDirectPing(message: MessageExtra) {
    const isFound = message.mentions.some(mentionContentIsId(this.userId));
    return true &&
      this.isPing(message) &&
      isFound;
  },
  isReplyPing(message: MessageExtra) {
    return true &&
      this.isDirectPing(message) &&
      message.type == 19 &&
      message.referenced_message.author.id == this.userId;
  },
  isNormalPing(message: MessageExtra) {
    const id = this.userId;
    return true &&
      this.isDirectPing(message) && (
        message.content.includes(`<@${id}>`) ||
        message.content.includes(`<@!${id}>`)
      );
  },
};

/* internal functions */

function messageStripDirectMention(message: MessageExtra) {
  if (!settings.store.punishStripMention) return;

  if ('mentioned' in message) message.mentioned = false;
  const index = message.mentions.findIndex(mentionContentIsId(Utility.userId));
  if (index >= 0) message.mentions.splice(index, 1);
}

function delayMessage(event: any) {
  const ctime = new Date().getTime();
  const delayAmount = settings.store.punishShadowMessageReplyPingDelayAmount * 1000;
  const canDelay = (ctime - Date.parse(event.message.timestamp)) < delayAmount;
  if (!canDelay) return false;

  const index = delayedMessages.findIndex(function(delayed){
    return event.message.id == delayed.message.id;
  });
  if (index >= 0) delayedMessages.splice(index, 1);
  autoMarkReadChannel(event);
  delayedMessages.push(event);
  storeDelayedEvents();

  return true;
}

function autoMarkReadChannel(event: any) {
  if (settings.store.punishAutoReadMessage === AutoAckType.Disabled) return;

  let delayTime = (settings.store.punishAutoReadMessage === AutoAckType.RandomDelayed ? (2000 + Math.random() * 1000) : 0) | 0;
  
  function fn() {
    FluxDispatcher.dispatch({
      type: 'CHANNEL_ACK',
      channelId: event.message.channel_id,
      messageId: event.message.id,
      context: 'APP',
    });
  }

  if (delayTime > 5)
    setTimeout(fn, delayTime);
  else
    fn();
}

const pingHistory : PingHistory = new Map();
const delayedMessages : DelayedEvents = [];
let intervalId;

async function initPingHistory() {
  const table = await DataStore.get<StoredPingHistory>(RECENT_PINGS_KEY) ?? {};
  pingHistory.clear();
  Object.entries(table[Utility.userId] ?? {}).forEach(function([serverId, messageIds]: PingHistoryEntry){
    pingHistory.set(serverId, messageIds);
  });
}

async function initDelayedEvents() {
  const table = await DataStore.get<StoredDelayedEvents>(DELAYED_EVENTS_KEY) ?? {};
  delayedMessages.splice(0);
  delayedMessages.push.apply(
    pingHistory,
    table[Utility.userId] ?? [],
  );
}

async function initData() {
  initPingHistory();
  initDelayedEvents();
}

async function storePingHistory() {
  const table = await DataStore.get<StoredPingHistory>(RECENT_PINGS_KEY) ?? {};
  table[Utility.userId] = Object.fromEntries(pingHistory.entries());
  await DataStore.set(RECENT_PINGS_KEY, table);
}

async function storeDelayedEvents() {
  const table = await DataStore.get<StoredDelayedEvents>(DELAYED_EVENTS_KEY) ?? {};
  table[Utility.userId] = delayedMessages;
  await DataStore.set(DELAYED_EVENTS_KEY, table);
}

function pollDelayedMessage() {
  if (!delayedMessages.length) return;
  const ctime = new Date().getTime();
  const delayAmount = settings.store.punishShadowMessageReplyPingDelayAmount * 1000;

  const shadowedEvents = delayedMessages.filter(function(delayed){
    return (ctime - Date.parse(delayed.message.timestamp)) >= delayAmount;
  });
  const shadowedIds = shadowedEvents.map(function(delayed){ return delayed.message.id; });
  if (!shadowedEvents.length) return;

  shadowedEvents.forEach(function(delayed){ FluxDispatcher.dispatch(delayed); });
  delayedMessages.push.apply(
    delayedMessages,
    delayedMessages.splice(0).filter(function(delayed){
      return !shadowedIds.includes(delayed.message.id);
    }),
  );
  storeDelayedEvents();
}

const interceptFlag = {
  DirectPing(interceptFunction) {
    return function (event: any) : boolean {
      if (!Utility.isDirectPing(event.message)) return false;
      return interceptFunction(event);
    };
  },
  ReplyPing(interceptFunction) {
    return function (event: any) : boolean {
      if (!Utility.isReplyPing(event.message)) return false;
      return interceptFunction(event);
    };
  },
  NormalPing(interceptFunction) {
    return function (event: any) : boolean {
      if (!Utility.isNormalPing(event.message)) return false;
      return interceptFunction(event);
    };
  },
  EnsureNonDM(interceptFunction) {
    return function (event: any) : boolean {
      if (!('channelId' in event)) return false;

      const channelId = event.channelId;
      const channel = ChannelStore.getChannel(channelId);

      if (!channel) return false;
      if (channel.guild_id === null) return false;

      const guildId = event.guildId ?? channel.guild_id;

      event.channelId = channelId;
      event.guildId = guildId;

      return interceptFunction(event);
    };
  },
};
function wrapInterceptor(interceptFunction, flags: string[]) {
  const validFlags = Object.getOwnPropertyNames(interceptFlag);
  let fun = interceptFunction;
  flags = [...new Set(flags)];
  flags.filter(function(key){
    return validFlags.includes(key);
  }).forEach(function(key){ fun = interceptFlag[key](fun); });
  Object.defineProperties(fun, {
    'toString': Object.assign(Object.getOwnPropertyDescriptor(Function.prototype, 'toString')!, {value: Function.prototype.toString.bind(interceptFunction)}),
    'name': Object.getOwnPropertyDescriptor(interceptFunction, 'name')!,
  });
  return fun;
}

function startTimer(event: any) {
  log.info('Starting delayed message polling of user', Utility.userId);
  if (intervalId) stopTimer(event);
  pollDelayedMessage();

  intervalId = setInterval(pollDelayedMessage, DELAYED_EVENT_INTERVAL);
}
function stopTimer(event: any) {
  clearInterval(intervalId);
  intervalId = undefined;
}

/* interceptors */

function interceptMessageMentionLog(event: any) : boolean {
  const message = event.message;
  const guildId = event.guildId;

  if (!pingHistory.has(guildId))
    pingHistory.set(guildId, []);

  const guildHistory = pingHistory.get(guildId)!;
  const guildFirstTime = guildHistory.length ? SnowflakeUtils.extractTimestamp(guildHistory[0] as string) : 0;
  const messageTime = Date.parse(message.timestamp);
  const maximumTime = settings.store.pingTimeWindow * 1000;
  if (messageTime - guildFirstTime >= maximumTime)
    guildHistory.splice(0);
  guildHistory.push(message.id);

  storePingHistory();

  return false;
}

function interceptMessageMentionShadow(event: any) : boolean {
  const isPing = Utility.isReplyPing(event.message);
  const delayLevel = isPing ?
    settings.store.punishShadowMessageType :
    MentionShadowType.Keep;

  switch(delayLevel) {
  case MentionShadowType.Keep:
    return false;
  case MentionShadowType.Delay:
    return delayMessage(event);
  case MentionShadowType.Remove:
    return true;
  }

  return false;
}

function interceptMessageMentionRead(event: any) : boolean {
  autoMarkReadChannel(event);
  return false;
}

function interceptMessageMentionStrip(event: any) : boolean {
  messageStripDirectMention(event.message);
  return false;
}

function interceptMessageBatch(event: any) : boolean {
  const channelId = event.channelId;
  const channel = ChannelStore.getChannel(channelId);
  if (channel.guild_id === null) return false;

  const guildId = event.guildId;

  function convertBatchToSingleEvent(message: MessageExtra) : any {
    return {
      type: 'MESSAGE_CREATE',
      channelId: channelId,
      guildId: guildId,
      message: message,
    };
  }

  const filteredList : MessageExtra[] = [];

  event.messages.forEach(function(message: MessageExtra) {
    const singleEvent = convertBatchToSingleEvent(message);
    const needDelay = [
      interceptMessageMentionShadow,
      interceptMessageMentionStrip,
    ].map(function(callback) {
      return callback(singleEvent);
    }).some(function(result) { return result; });

    if (!needDelay)
      filteredList.push(message);
  });

  event.messages.splice(0);
  event.messages.push.apply(
    event.messages,
    filteredList,
  );
  return false;
}

const fluxInterceptors = pluginInterceptors(
  defineInterceptor(interceptMessageBatch, 'LOAD_MESSAGES_SUCCESS'),
  defineInterceptor(wrapInterceptor(interceptMessageMentionLog, ['EnsureNonDM', 'NormalPing']), 'MESSAGE_CREATE'),
  defineInterceptor(wrapInterceptor(interceptMessageMentionShadow, ['EnsureNonDM', 'DirectPing']), 'MESSAGE_CREATE'),
  defineInterceptor(wrapInterceptor(interceptMessageMentionRead, ['EnsureNonDM', 'DirectPing']), 'MESSAGE_CREATE'),
  defineInterceptor(wrapInterceptor(interceptMessageMentionStrip, ['EnsureNonDM', 'DirectPing']), 'MESSAGE_CREATE'),
);

/* plugin */

export default definePlugin({
  name: 'PingPunish',
  authors: [{name: 'Rei Hakurei', id: 212483631631958016n}],
  description: 'Controls visibility of direct pings.',
  settings,
  fluxInterceptors,
  start() {
    FluxDispatcher.subscribe('CONNECTION_OPEN', initData);
    FluxDispatcher.subscribe('CONNECTION_OPEN', startTimer);
    FluxDispatcher.subscribe('CONNECTION_CLOSED', stopTimer);
    startTimer({});
  },
  stop() {
    FluxDispatcher.unsubscribe('CONNECTION_OPEN', initData);
    FluxDispatcher.unsubscribe('CONNECTION_OPEN', startTimer);
    FluxDispatcher.unsubscribe('CONNECTION_CLOSED', stopTimer);
    stopTimer({});
  },

});
