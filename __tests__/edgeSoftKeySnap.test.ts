/*
 * Runs overlap on the Edge tab (a sync queued behind a computer's hold, then
 * another): one run's endRun() must not break a head read still waiting for
 * the key in another (Pixel, 2026-10-06: "Cannot read property 'head' of null").
 */
import {SoftKeyEdge} from '../src/edgeSoftKey';

test('a run ending while another waits for the key\'s head: the waiting read still answers', async () => {
  let answer: (h: any) => void = () => undefined;
  const edge = {head: () => new Promise(r => { answer = r; })};
  const k: any = new (SoftKeyEdge as any)(edge, Uint8Array.of(1, 2, 3, 4));
  k.beginRun();
  const reading = k.keyHead();
  k.endRun(); /* the other run finished first */
  answer({seq: 7, head: new Uint8Array(32)});
  await expect(reading).resolves.toMatchObject({seq: 7});
});
