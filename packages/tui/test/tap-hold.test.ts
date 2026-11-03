import { expect, test } from "bun:test"
import { createTapHold, DOUBLE_MS, HOLD_MS, REPEAT_GAP_MS, SETTLE_MS } from "../src/component/prompt/tap-hold"

function track(releases: boolean) {
  const seen = { downs: 0, doubles: 0, holds: 0 }
  const key = createTapHold({
    releases: () => releases,
    down: () => seen.downs++,
    double: () => seen.doubles++,
    hold: () => seen.holds++,
  })
  return { key, seen }
}

/**
 * A key held down for `ms`, as a keyboard sends it: one press, then after the
 * repeat delay a press every interval. The defaults are a COSMIC desktop's.
 */
async function hold(key: { press: () => void }, ms: number, delay = 200, interval = 22) {
  const start = Date.now()
  key.press()
  await Bun.sleep(delay)
  while (Date.now() - start < ms) {
    key.press()
    await Bun.sleep(interval)
  }
}

async function tap(key: { press: () => void; release: () => void }) {
  key.press()
  await Bun.sleep(50)
  key.release()
}

test("the key going down is said at once, before anyone knows what it will be", () => {
  // Behind zellij a tap takes most of a second to be sure of, and the voice
  // is not to go on talking for all of it.
  const { key, seen } = track(false)
  key.press()
  expect(seen).toEqual({ downs: 1, doubles: 0, holds: 0 })
})

test("reported releases: a second tap close on the first is a double", async () => {
  const { key, seen } = track(true)
  await tap(key)
  await Bun.sleep(150)
  await tap(key)
  expect(seen).toEqual({ downs: 2, doubles: 1, holds: 0 })
})

test("reported releases: taps further apart are two taps", async () => {
  const { key, seen } = track(true)
  await tap(key)
  await Bun.sleep(DOUBLE_MS + 150)
  await tap(key)
  expect(seen).toEqual({ downs: 2, doubles: 0, holds: 0 })
})

test("reported releases: a hold acts when the key comes back up, not before", async () => {
  const { key, seen } = track(true)
  // Repeating all the while, which with releases reported is not pressing again.
  await hold(key, HOLD_MS + 150)
  expect(seen).toEqual({ downs: 1, doubles: 0, holds: 0 })
  key.release()
  expect(seen).toEqual({ downs: 1, doubles: 0, holds: 1 })
})

test("reported releases: a hold straight after a tap is a hold, not a double", async () => {
  const { key, seen } = track(true)
  await tap(key)
  await Bun.sleep(100)
  await hold(key, HOLD_MS + 150)
  key.release()
  expect(seen.doubles).toBe(0)
  expect(seen.holds).toBe(1)
})

test("no releases: a lone press is a tap once it has had time to repeat and did not", async () => {
  const { key, seen } = track(false)
  key.press()
  await Bun.sleep(SETTLE_MS + 100)
  expect(seen).toEqual({ downs: 1, doubles: 0, holds: 0 })
})

test("no releases: a key that keeps repeating is held, and acts once the repeats stop", async () => {
  const { key, seen } = track(false)
  await hold(key, HOLD_MS + 200)
  // Still repeating as far as anyone can tell: acting now would hand the
  // repeats still coming to whatever the key means after.
  expect(seen.holds).toBe(0)
  await Bun.sleep(REPEAT_GAP_MS + 100)
  expect(seen.holds).toBe(1)
  expect(seen.doubles).toBe(0)
})

test("no releases: a second tap as late as the first repeat would be is a double", async () => {
  const { key, seen } = track(false)
  // 200ms apart is exactly when this keyboard's first repeat would land. What
  // tells them apart is that no second repeat follows at once.
  key.press()
  await Bun.sleep(200)
  key.press()
  await Bun.sleep(REPEAT_GAP_MS + 100)
  expect(seen).toEqual({ downs: 2, doubles: 1, holds: 0 })
})

test("no releases: a key let go before it counts as held is not a hold", async () => {
  const { key, seen } = track(false)
  await hold(key, 300)
  await Bun.sleep(SETTLE_MS)
  expect(seen.holds).toBe(0)
  expect(seen.doubles).toBe(0)
})

test("cancelling forgets a press still being decided", async () => {
  const { key, seen } = track(false)
  key.press()
  key.cancel()
  await Bun.sleep(SETTLE_MS + 100)
  expect(seen).toEqual({ downs: 1, doubles: 0, holds: 0 })
})
