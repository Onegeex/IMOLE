/*
  Imole kit controller (ESP32)

  Switches a solar kit's output on or off from what has been PAID on QIE Mainnet.
  Two ways to learn that, so it works with and without internet:

  1. Online: a read-only eth_call to kitStatus(kitId) on a public QIE RPC every POLL_MS.
     The chain's block time also sets the controller's clock.
  2. Offline: the customer types a 12-digit unlock code on the keypad. The code encodes
     "powered until <time>" plus a 16-bit HMAC made with this kit's device key. Codes are only
     issued (by https://imole-ten.vercel.app/api/code) for time already paid on-chain, so a code
     can't sell power nobody paid for. Older codes are refused, so they can't be replayed.
     Five wrong codes lock the keypad for ten minutes.

  Wiring (same as diagram.json):
    GPIO 26 -> relay IN (switches the inverter's AC output, or a DC load in the demo)
    GPIO 2  -> green LED (power on)        GPIO 4 -> red LED (payment due)
    SDA 21 / SCL 22 -> 16x2 I2C LCD, address 0x27
    Keypad rows 13 12 14 27, columns 25 33 32 23   (* = clear, # = enter)
    GPIO 15 -> "Internet" slide switch to GND (demo only: slide it to simulate no internet)

  The paid-up time counts down locally between reads, so pulling the antenna doesn't keep a
  kit on for free. A paid-off kit unlocks permanently.
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Preferences.h>
#include <Keypad.h>
#include "mbedtls/md.h"

// ---------------------------------------------------------------- configure me
const char* WIFI_SSID = "Wokwi-GUEST";  // Wokwi's simulated network; use your own on real hardware
const char* WIFI_PASS = "";
const char* PAYG_ADDRESS = "0xae6501e9c96EaDFB835f11b581D8353cF5e7d8AD";  // ImolePAYG on QIE Mainnet
const uint32_t KIT_ID = 1;
// This kit's device key. Installers get it from the Imole app (Installers -> Controller key),
// signed with the wallet that listed the kit. Kit 1 is the public demo kit, so its key is public.
const char* DEVICE_KEY_HEX = "dfe0199460e6cabe7ab9aae3c54a33e891dd57f3a1a655e6f8e5c16f679a5444";
const uint32_t POLL_MS = 30000;
// ------------------------------------------------------------------------------

const uint64_t EPOCH = 1767225600ULL;  // 2026-01-01T00:00:00Z, same as the code service
const uint32_t FOREVER_T10 = (1UL << 23) - 1;

const char* RPCS[] = {
  "https://rpc1mainnet.qie.digital",
  "https://rpc2mainnet.qie.digital",
  "https://rpc5mainnet.qie.digital",
};
const int RPC_COUNT = sizeof(RPCS) / sizeof(RPCS[0]);

const int PIN_RELAY = 26, PIN_LED_ON = 2, PIN_LED_DUE = 4, PIN_NET = 15;

LiquidCrystal_I2C lcd(0x27, 16, 2);
Preferences prefs;

const byte ROWS = 4, COLS = 4;
char KEYS[ROWS][COLS] = {{'1', '2', '3', 'A'}, {'4', '5', '6', 'B'}, {'7', '8', '9', 'C'}, {'*', '0', '#', 'D'}};
byte rowPins[ROWS] = {13, 12, 14, 27};
byte colPins[COLS] = {25, 33, 32, 23};
Keypad keypad = Keypad(makeKeymap(KEYS), rowPins, colPins, ROWS, COLS);

uint8_t deviceKey[32];
bool owned = false;
uint64_t unlockUntil = 0;    // epoch seconds the kit stays on until
uint32_t bestT10 = 0;        // newest accepted code
uint64_t syncEpoch = 0;      // chain time at last sync
uint32_t syncMillis = 0;
uint32_t percentPaid = 0;
uint32_t lastPoll = 0, lastDraw = 0, lastSave = 0, lockoutUntilMs = 0, msgUntilMs = 0;
int rpcIndex = 0, strikes = 0;
String entry = "", message = "";

// ---------------------------------------------------------------- helpers
uint64_t nowEpoch() { return syncEpoch + (millis() - syncMillis) / 1000; }
bool online() { return digitalRead(PIN_NET) == HIGH && WiFi.status() == WL_CONNECTED; }

void hexToBytes(const char* hex, uint8_t* out, size_t n) {
  for (size_t i = 0; i < n; i++) {
    char b[3] = {hex[2 * i], hex[2 * i + 1], 0};
    out[i] = (uint8_t)strtoul(b, nullptr, 16);
  }
}

void hmac256(const uint8_t* key, size_t keyLen, const char* msg, uint8_t out[32]) {
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, key, keyLen);
  mbedtls_md_hmac_update(&ctx, (const uint8_t*)msg, strlen(msg));
  mbedtls_md_hmac_finish(&ctx, out);
  mbedtls_md_free(&ctx);
}

uint16_t mac16(const uint8_t* key, uint32_t kit, uint32_t t10) {
  char msg[48];
  snprintf(msg, sizeof(msg), "imole:%u:%u", kit, t10);
  uint8_t h[32];
  hmac256(key, 32, msg, h);
  return ((uint16_t)h[0] << 8) | h[1];
}

void say(const String& m, uint32_t ms = 3000) { message = m; msgUntilMs = millis() + ms; }

void save() {
  prefs.putBool("owned", owned);
  prefs.putULong64("until", unlockUntil);
  prefs.putULong("t10", bestT10);
  prefs.putULong64("clock", nowEpoch());
}

// Same vectors as web/scripts/test-codes.mts
bool selfTest() {
  uint8_t k[32];
  hexToBytes("e6cac227a15b89af5a20920ddea5f0ae995a25781c52dcebd4c8881fc7cf3f73", k, 32);
  uint64_t v1 = (uint64_t)12345 * 65536 + mac16(k, 1, 12345);
  uint64_t v2 = (uint64_t)FOREVER_T10 * 65536 + mac16(k, 1, FOREVER_T10);
  return v1 == 809065665ULL && v2 == 549755766337ULL;
}

// ---------------------------------------------------------------- offline codes
void tryCode(const String& digits) {
  if (millis() < lockoutUntilMs) { say("Keypad locked"); return; }
  if (digits.length() != 12) { say("Need 12 digits"); return; }
  uint64_t v = strtoull(digits.c_str(), nullptr, 10);
  uint32_t t10 = (uint32_t)(v >> 16);
  uint16_t mac = (uint16_t)(v & 0xFFFF);
  if (t10 > FOREVER_T10 || mac != mac16(deviceKey, KIT_ID, t10)) {
    strikes++;
    Serial.printf("[code] rejected (%d/5)\n", strikes);
    if (strikes >= 5) { lockoutUntilMs = millis() + 600000; strikes = 0; say("Locked 10 min", 5000); }
    else say("Wrong code");
    return;
  }
  strikes = 0;
  if (t10 == FOREVER_T10) {
    owned = true; save(); say("Kit is yours!", 5000);
    Serial.println("[code] accepted: paid off");
    return;
  }
  if (t10 <= bestT10) { say("Old code"); return; }
  bestT10 = t10;
  unlockUntil = EPOCH + (uint64_t)t10 * 600;
  save();
  Serial.printf("[code] accepted: on until %llu\n", unlockUntil);
  say("Code accepted", 4000);
}

// ---------------------------------------------------------------- chain
String rpcPost(const char* url, const String& body) {
  WiFiClientSecure tls;
  // Demo shortcut: no certificate pinning. The calls are read-only; see README for the production plan.
  tls.setInsecure();
  HTTPClient http;
  if (!http.begin(tls, url)) return "";
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(8000);
  int code = http.POST(body);
  String resp = code == 200 ? http.getString() : "";
  http.end();
  return resp;
}

String field(const String& resp, const char* key) {
  String k = String("\"") + key + "\":\"";
  int at = resp.indexOf(k);
  if (at < 0) return "";
  return resp.substring(at + k.length(), resp.indexOf('"', at + k.length()));
}

uint64_t word(const String& hex, int index) {
  int start = 2 + index * 64;
  if ((int)hex.length() < start + 64) return 0;
  for (int i = start; i < start + 48; i++) if (hex[i] != '0') return UINT64_MAX;
  return strtoull(hex.substring(start + 48, start + 64).c_str(), nullptr, 16);
}

bool readChain() {
  char data[75];
  snprintf(data, sizeof(data), "0x3114e208%064x", KIT_ID);  // kitStatus(uint256)
  String call = String("[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"") + PAYG_ADDRESS +
                "\",\"data\":\"" + data + "\"},\"latest\"]},{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"eth_getBlockByNumber\",\"params\":[\"latest\",false]}]";
  for (int attempt = 0; attempt < RPC_COUNT; attempt++) {
    const char* url = RPCS[(rpcIndex + attempt) % RPC_COUNT];
    String resp = rpcPost(url, call);
    String result = field(resp, "result");
    String ts = field(resp, "timestamp");
    if (result.length() < 2 + 64 * 3 || ts.length() < 3) { Serial.printf("[chain] %s failed\n", url); continue; }
    syncEpoch = strtoull(ts.c_str() + 2, nullptr, 16);
    syncMillis = millis();
    bool active = word(result, 0) != 0;
    uint64_t left = word(result, 1);
    percentPaid = (uint32_t)word(result, 2);
    if (left == UINT64_MAX) owned = true;
    else unlockUntil = active ? syncEpoch + left : syncEpoch;
    rpcIndex = (rpcIndex + attempt) % RPC_COUNT;
    save();
    Serial.printf("[chain] %s active=%d left=%llu paid=%u%% time=%llu\n", url, active, left, percentPaid, syncEpoch);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- output
void pad(const char* s) { lcd.print(s); for (int i = strlen(s); i < 16; i++) lcd.print(' '); }

void draw() {
  uint64_t now = nowEpoch();
  bool on = owned || unlockUntil > now;
  digitalWrite(PIN_RELAY, on ? HIGH : LOW);
  digitalWrite(PIN_LED_ON, on ? HIGH : LOW);
  digitalWrite(PIN_LED_DUE, on ? LOW : HIGH);

  char top[17], bottom[17];
  if (owned) snprintf(top, sizeof(top), "Kit %u OWNED", KIT_ID);
  else if (on) {
    uint64_t s = unlockUntil - now;
    uint32_t d = s / 86400, h = (s % 86400) / 3600, m = (s % 3600) / 60;
    snprintf(top, sizeof(top), "ON  %02ud %02uh %02um", d > 99 ? 99 : d, h, m);
  } else snprintf(top, sizeof(top), "OFF Pay to use");

  if (entry.length()) snprintf(bottom, sizeof(bottom), "#%s", entry.c_str());
  else if (millis() < msgUntilMs) snprintf(bottom, sizeof(bottom), "%s", message.c_str());
  else if (!online()) snprintf(bottom, sizeof(bottom), "No net:type code");
  else if (owned) snprintf(bottom, sizeof(bottom), "Power for good");
  else snprintf(bottom, sizeof(bottom), "Paid %3u%% Online", percentPaid);
  lcd.setCursor(0, 0); pad(top);
  lcd.setCursor(0, 1); pad(bottom);
}

// ---------------------------------------------------------------- main
void setup() {
  Serial.begin(115200);
  pinMode(PIN_RELAY, OUTPUT); pinMode(PIN_LED_ON, OUTPUT); pinMode(PIN_LED_DUE, OUTPUT);
  pinMode(PIN_NET, INPUT_PULLUP);
  digitalWrite(PIN_RELAY, LOW);  // locked until we know better

  lcd.init(); lcd.backlight();
  lcd.print("Imole  QIE"); lcd.setCursor(0, 1); lcd.print("Starting...");

  hexToBytes(DEVICE_KEY_HEX, deviceKey, 32);
  Serial.printf("[selftest] %s\n", selfTest() ? "ok" : "FAILED");

  prefs.begin("imole", false);
  owned = prefs.getBool("owned", false);
  unlockUntil = prefs.getULong64("until", 0);
  bestT10 = prefs.getULong("t10", 0);
  syncEpoch = prefs.getULong64("clock", EPOCH);  // last known time; corrected at the next chain read
  syncMillis = millis();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) delay(250);
  Serial.printf("[wifi] %s\n", WiFi.status() == WL_CONNECTED ? "connected" : "offline");
  if (online()) readChain();
  lastPoll = millis();
  draw();
}

void loop() {
  char k = keypad.getKey();
  if (k) {
    if (k >= '0' && k <= '9' && entry.length() < 12) entry += k;
    else if (k == '*') entry = "";
    else if (k == '#') { tryCode(entry); entry = ""; }
    draw();
  }
  uint32_t ms = millis();
  if (ms - lastDraw >= 1000) { lastDraw = ms; draw(); }
  if (ms - lastSave >= 60000) { lastSave = ms; save(); }
  if (!owned && online() && ms - lastPoll >= POLL_MS) {
    lastPoll = ms;
    if (!readChain()) Serial.println("[chain] all RPCs failed, using local countdown");
    draw();
  }
  delay(10);
}
