// Run: npx tsx scripts/test-codes.mts — checks the unlock-code scheme against fixed vectors.
// The same vectors are checked in the firmware's self-test (imole-controller.ino, selfTest()).
import assert from "node:assert/strict";
import { deviceKey, makeCode, t10For, EPOCH, FOREVER } from "../api/_lib.ts";
const k = deviceKey("00".repeat(31) + "01", 1);
assert.equal(k.toString("hex"), "e6cac227a15b89af5a20920ddea5f0ae995a25781c52dcebd4c8881fc7cf3f73");
assert.equal(t10For(EPOCH + 600 * 12345 + 59), 12345);
assert.equal(makeCode(k, 1, 12345), "000809065665");
assert.equal(makeCode(k, 1, FOREVER), "549755766337");
assert.notEqual(makeCode(deviceKey("00".repeat(31) + "01", 2), 2, 12345), "000809065665");
console.log("unlock-code vectors OK");
