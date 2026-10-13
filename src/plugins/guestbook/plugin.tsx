import React, {useEffect} from 'react';
import {Linking} from 'react-native';

import type {RecipientsService} from '../recipients';
import type {TabsService} from '../tabs';
import {GuestBookScreen} from './GuestBookScreen';
import {recipientSource} from './service';
import {isInvite, openInvite} from './swapNative';
import {CONTACT_LABEL} from './swapLink';
import {nameDerive} from '../../pressAsk';

/* what the press sheet says when the swap asks this OnlyKey to open the other phone's seal */
nameDerive(CONTACT_LABEL, 'Guest Book key swap: prove this OnlyKey to the other phone');
import type {WatchContext} from '../types';

/*
 * okrn://connect LINKS (the swap invite, read by the phone's own camera instead of Guest Book's
 * scanner): Android opens the app with it, and this watch - mounted with the app, tab shown or
 * not - brings Guest Book forward and hands it the invite. Anything else is not ours.
 */
function InviteLinks({openTab}: WatchContext) {
  useEffect(() => {
    const take = (url: string | null | undefined) => {
      if (!isInvite(url)) return;
      openInvite(String(url));
      openTab('Guest Book');
    };
    Linking.getInitialURL().then(take, () => {});
    const sub = Linking.addEventListener('url', e => take(e.url));
    return () => sub.remove();
  }, [openTab]);
  return null;
}

/*
 * GUEST BOOK as an app plugin (Brad, 2026-10-12: "its should be its own plugin like we did
 * password manager"). Its lib half is node-onlykey-lib/guestbook. Removing it = this folder and
 * its one line in src/plugins/index.ts.
 *
 * The tab sits after Passwords (Brad, 2026-10-12): your keys (Key Chain), your secrets
 * (Passwords), other people's keys (Guest Book).
 */
export default function setup({tabs, recipients}: {tabs: TabsService; recipients: RecipientsService}, register: (err: Error | null, services: {guestbook: object}) => void) {
  tabs.add({name: 'Guest Book', after: 'Passwords', render: ctx => <GuestBookScreen ctx={ctx} />}, InviteLinks);
  /* Messages' "Add from Guest Book" and "Save to Guest Book" */
  recipients.add(recipientSource);
  register(null, {guestbook: {}});
}
setup.consumes = ['tabs', 'recipients'];
setup.provides = ['guestbook'];
