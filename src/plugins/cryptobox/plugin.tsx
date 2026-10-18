import React from 'react';

import type {RecipientsService} from '../recipients';
import type {TabsService} from '../tabs';
import {CryptoboxScreen} from './CryptoboxScreen';

/*
 * CRYPTOBOX as an app plugin (Brad, 2026-10-18: tab "Cryptobox", messages kept encrypted, chat-style).
 * Its lib half is node-onlykey-lib/cryptobox. Removing it = this folder and its one line in
 * src/plugins/index.ts. People come from the recipients service (Guest Book), never from a plugin
 * by name.
 *
 * The tab sits after Guest Book: your keys, your secrets, other people's keys, your messages with them.
 */
export default function setup({tabs, recipients}: {tabs: TabsService; recipients: RecipientsService}, register: (err: Error | null, services: {cryptobox: object}) => void) {
  tabs.add({name: 'Cryptobox', after: 'Guest Book', render: ctx => <CryptoboxScreen ctx={ctx} recipients={recipients} />});
  register(null, {cryptobox: {}});
}
setup.consumes = ['tabs', 'recipients'];
setup.provides = ['cryptobox'];
