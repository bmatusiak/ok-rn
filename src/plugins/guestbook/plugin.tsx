import React from 'react';

import type {RecipientsService} from '../recipients';
import type {TabsService} from '../tabs';
import {GuestBookScreen} from './GuestBookScreen';
import {recipientSource} from './service';

/*
 * GUEST BOOK as an app plugin (Brad, 2026-10-12: "its should be its own plugin like we did
 * password manager"). Its lib half is node-onlykey-lib/guestbook. Removing it = this folder and
 * its one line in src/plugins/index.ts.
 *
 * The tab sits after Passwords (Brad, 2026-10-12): your keys (Key Chain), your secrets
 * (Passwords), other people's keys (Guest Book).
 */
export default function setup({tabs, recipients}: {tabs: TabsService; recipients: RecipientsService}, register: (err: Error | null, services: {guestbook: object}) => void) {
  tabs.add({name: 'Guest Book', after: 'Passwords', render: ctx => <GuestBookScreen ctx={ctx} />});
  /* Messages' "Add from Guest Book" and "Save to Guest Book" */
  recipients.add(recipientSource);
  register(null, {guestbook: {}});
}
setup.consumes = ['tabs', 'recipients'];
setup.provides = ['guestbook'];
