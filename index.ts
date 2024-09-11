/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Rei Hakurei
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import definePlugin, {
  pluginInterceptors, defineInterceptor,
} from "@utils/types";

const log = new Logger('HideRecentActivity');

function interceptContentInventoryLog(event: any) : boolean {
  if (event.type.indexOf('CONTENT_INVENTORY') == -1) return false;
  // log.info(event.type, event);
  return false;
}
function interceptContentInventory(event: any) : boolean {
  return true;
}
const fluxInterceptors = pluginInterceptors(
  defineInterceptor(interceptContentInventory, 'CONTENT_INVENTORY_SET_FEED'),
);

/* plugin */

export default definePlugin({
  name: 'HideRecentActivityInventory',
  authors: [{name: 'Rei Hakurei', id: 212483631631958016n}],
  description: 'Debloat member list from Recent Activity experiment.',
  /* patches: [
    {
      find: ".GLOBAL_FEED",
      replacement: {
        match: /(?<=[(](?:[[,](?:\w+[.])+(?:PLAYED_GAME|WATCHED_MEDIA|TOP_GAME|TOP_ARTIST|LISTENED_SESSION|LAUNCHED_ACTIVITY))+[\]][)][;])(?:[^;]+[;])+return \w+=\w+[,]/,
        replace: "return {requestId: null, entries: [], impressionCappedEntryIds: new Set([])}; return $1"
      }
    },
  ], */
  fluxInterceptors,
});
