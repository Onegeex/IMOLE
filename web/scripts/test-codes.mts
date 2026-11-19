// Run: npx tsx scripts/test-codes.mts — checks the unlock-code scheme against fixed vectors.
// The same vectors are checked in the firmware's self-test (imole-controller.ino, selfTest()).
import assert from "node:assert/strict";
import { deviceKey, makeCode, makeResetCode, t10For, EPOCH, FOREVER, RESET } from "../api/_lib.ts";
import { makeResetCode as browserReset } from "../src/codes.ts";
const k = deviceKey("00".repeat(31) + "01", 1);
assert.equal(k.toString("hex"), "e6cac227a15b89af5a20920ddea5f0ae995a25781c52dcebd4c8881fc7cf3f73");
assert.equal(t10For(EPOCH + 600 * 12345 + 59), 12345);
assert.equal(makeCode(k, 1, 12345), "000809065665");
assert.equal(makeCode(k, 1, FOREVER), "549755766337");
assert.notEqual(makeCode(deviceKey("00".repeat(31) + "01", 2), 2, 12345), "000809065665");
const r1 = makeResetCode(k, 1, 1);
console.log("reset vector kit 1 count 1:", r1);
assert.equal(r1.slice(0, 7), (BigInt(RESET) * 65536n).toString().padStart(12, "0").slice(0, 7));
assert.equal(await browserReset(k.toString("hex"), 1, 1), r1);
assert.notEqual(makeResetCode(k, 1, 2), r1);
assert.ok(t10For(EPOCH + 600 * 2 ** 24) < RESET);
console.log("unlock-code vectors OK");
