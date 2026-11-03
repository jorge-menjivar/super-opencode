// How long a key has to be down before it counts as held.
export const HOLD_MS = 400
// The widest gap between two repeats of a held key. Keyboards repeat ten to
// fifty times a second; a finger tapping twice is slower than that.
export const REPEAT_GAP_MS = 120
// How long a lone press waits for the key to start repeating before it counts
// as a tap. Longer than any usual repeat delay — desktops default to between
// 200 and 660ms — or a hold would be taken for a tap before its first repeat.
export const SETTLE_MS = 750
// How close the second of two taps has to come to count as a double tap rather
// than two taps.
export const DOUBLE_MS = 500

/**
 * Tells how a key is being used — pressed, tapped twice, or held — whichever
 * way the terminal can say it.
 *
 * A terminal that reports keys coming back up says a tap outright. Zellij asks
 * the terminal for none of that — only the first layer of the kitty keyboard
 * protocol — so behind it the only sign of a held key is that it goes on
 * repeating. A press there stays undecided until repeats close enough together
 * to be the keyboard's own say it is down, or long enough passes without any
 * that it cannot be.
 *
 * A hold acts once the key is back up, not the moment it counts as held. Until
 * then the key goes on repeating, and with the hold already acted on — a mode
 * left, say — those repeats would land on whatever the key means afterwards.
 * For escape that is the interrupt, and twice over it aborts the agent.
 */
export function createTapHold(input: {
  /**
   * The key went down: a fresh press, not the key repeating. Straight away,
   * before anyone can know whether it will be a tap or a hold — which, behind
   * zellij, takes most of a second.
   */
  down: () => void
  /** A second tap close on the first. */
  double: () => void
  /** The key was held, and has now been let go. */
  hold: () => void
  /** Whether the terminal has ever reported a key coming back up. */
  releases: () => boolean
}) {
  let presses: number[] = []
  let held = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // When the last tap went down, for as long as another could make it a double.
  // Kept across presses: where releases are reported each tap is over, and
  // forgotten, before the next begins.
  let tapped: number | undefined

  function reset() {
    clearTimeout(timer)
    timer = undefined
    presses = []
    held = false
  }

  function settle(then: () => void, ms: number) {
    clearTimeout(timer)
    timer = setTimeout(then, ms)
  }

  // The key is up. Each press was a tap of its own, unless the keyboard
  // repeated among them: then they were one press, let go too soon to count.
  function up() {
    const hold = held
    const current = presses
    reset()
    if (hold) {
      tapped = undefined
      return input.hold()
    }
    const repeated = current.some((at, index) => index > 0 && at - current[index - 1] <= REPEAT_GAP_MS)
    for (const at of repeated ? current.slice(0, 1) : current) {
      if (tapped !== undefined && at - tapped <= DOUBLE_MS) {
        tapped = undefined
        input.double()
        continue
      }
      tapped = at
    }
  }

  return {
    press() {
      const now = Date.now()
      const previous = presses.at(-1)
      // Behind zellij a press long after the last is either another tap or the
      // first repeat of a held key, and the voice is to stop either way.
      if (previous === undefined || (!input.releases() && now - previous > REPEAT_GAP_MS)) input.down()
      presses.push(now)
      if (previous === undefined) {
        // Where releases are reported, one will come; until then it is down.
        if (input.releases())
          return settle(() => {
            held = true
          }, HOLD_MS)
        return settle(up, SETTLE_MS)
      }
      // Nothing came back up in between, so this is the key repeating.
      if (input.releases()) return
      // The repeats stopping is how the key shows it went back up.
      if (now - previous <= REPEAT_GAP_MS) {
        if (now - presses[0] >= HOLD_MS) held = true
        return settle(up, REPEAT_GAP_MS)
      }
      // Another tap, or the first repeat, which comes after the keyboard's
      // longer delay. The next repeat would follow at once.
      settle(up, REPEAT_GAP_MS)
    },
    release() {
      if (presses.length > 0) up()
    },
    cancel() {
      reset()
      tapped = undefined
    },
  }
}
