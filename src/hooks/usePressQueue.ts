import {useCallback, useRef, useState} from 'react';

/**
 * Typing on the device's buttons, one tap at a time, without losing any.
 *
 * PRESSES ARE QUEUED, NOT DROPPED
 * (FINDING-pin-taps-are-dropped-not-queued.md).
 *
 * A press is not instantaneous: it is ten firmware loop iterations at ~36ms
 * each, plus the poll that notices the release, so about 400ms. A finger moving
 * between two keys takes half that. Ignoring a tap that arrives mid-press -
 * which is what a `working` guard does - threw away roughly every second digit,
 * and the firmware's PIN buffer CANNOT BE CLEARED except by running it to its
 * rollover, so one lost digit costs the entry twice over.
 *
 * Serialising is still required - okemu_set_button_ticks holds one counter per
 * button, and a second press starting before the first is released overwrites
 * the count being aged - but a chain serialises without discarding anything.
 *
 * ## Why this is a hook rather than a line in one screen
 *
 * Because it was a line in one screen, and the other screen that needed it did
 * not get it. The unlock pad had the chain; first-time setup was given the bare
 * press handler instead and called it fire-and-forget, so every second digit of
 * a new PIN was silently overwritten and setup could not be completed. The two
 * screens are the same act - someone typing a PIN on six buttons - so they are
 * now the same code, and a third caller cannot repeat the mistake.
 */
export function usePressQueue(onPress: (button: number) => Promise<void> | void) {
  const queue = useRef<Promise<void>>(Promise.resolve());

  /**
   * How many presses are typed but not yet delivered.
   *
   * STATE, not a ref, because this is drawn. It is the honest thing to show
   * while someone types: the queue GROWS as taps land and SHRINKS as each one
   * reaches the device, so a fast PIN visibly backs up and then drains. A
   * screen that instead draws one dot per digit typed says the work is done
   * the instant the finger lifts, which is false by about 400ms per press and
   * is exactly when someone reaches for the next button.
   *
   * Counted with the updater form throughout. React batches, so two taps in
   * one render both computing from the same captured number would lose one -
   * which is a bug this screen has already had.
   */
  const [pending, setPending] = useState(0);

  const press = useCallback(
    (button: number) => {
      setPending(n => n + 1);

      queue.current = queue.current
        .then(() => onPress(button))
        .then(
          () => {},
          () => {
            /*
             * A refused press must not break the chain. Whatever went wrong
             * was reported by onPress itself; swallowing it here keeps the
             * digits behind it moving, which is the whole point of a queue.
             */
          },
        )
        .then(() => setPending(n => n - 1));
    },
    [onPress],
  );

  return {press, pending, working: pending > 0};
}
