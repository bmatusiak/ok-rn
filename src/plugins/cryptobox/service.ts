import AsyncStorage from '@react-native-async-storage/async-storage';

import {store} from 'node-onlykey-lib/cryptobox';
import {currentNet} from '../../net';

/*
 * CRYPTOBOX'S STORAGE (its lib half: node-onlykey-lib/cryptobox - the store refuses anything but an
 * encrypted or signed PGP block). One list per net, as Guest Book's: the testnet's is its own.
 */

declare const crypto: {getRandomValues<T extends Uint8Array>(array: T): T};

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const storageKey = () => (currentNet() === 'test' ? 'okrn.cryptobox.test:v1' : store.KEY);
export const openBox = () => store.createCryptobox({storage: AsyncStorage, randomBytes, key: storageKey()});

export type BoxMessage = {id: string; contact: string; dir: 'out' | 'in'; armored: string; kind: 'encrypted' | 'signed'; signed: boolean; at: string};

/* the thread id for messages to and from yourself (the recipients service's Me) */
export const ME = 'me';
