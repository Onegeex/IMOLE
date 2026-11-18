/*
  Imole kit controller (ESP32)

  Reads the kit's state straight from the Imole contract on QIE Mainnet and switches
  the inverter output through a relay. No server of ours sits in between: the device
  makes a read-only eth_call to a public QIE RPC.

  Wiring (same as diagram.json for Wokwi):
    GPIO 26 -> relay IN  (relay switches the inverter's AC output, or a DC load in the demo)
    GPIO 2  -> green LED (power on)
    GPIO 4  -> red LED   (payment due)
    SDA 21 / SCL 22 -> 16x2 I2C LCD, address 0x27

  Behaviour
    - Polls kitStatus(kitId) every POLL_MS, rotating across QIE's RPC endpoints.
    - Counts the paid-up time down locally between polls. If the device loses its
      connection it keeps power on only for the time already paid for, then locks.
      Pulling the Wi-Fi antenna can't keep a kit on for free.
    - A paid-off kit (secondsLeft = max) unlocks permanently and stops polling.
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Preferences.h>

// ---------------------------------------------------------------- configure me
const char* WIFI_SSID = "Wokwi-GUEST";  // Wokwi's simulated network; use your own on real hardware
const char* WIFI_PASS = "";
const char* PAYG_ADDRESS = "0x0000000000000000000000000000000000000000";  // ImolePAYG on QIE Mainnet
const uint32_t KIT_ID = 1;
const uint32_t POLL_MS = 30000;
// ------------------------------------------------------------------------------

const char* RPCS[] = {
  "https://rpc1mainnet.qie.digital",
  "https://rpc2mainnet.qie.digital",
  "https://rpc5mainnet.qie.digital",
};
const int RPC_COUNT = sizeof(RPCS) / sizeof(RPCS[0]);

const int PIN_RELAY = 26;
const int PIN_LED_ON = 2;
const int PIN_LED_DUE = 4;

LiquidCrystal_I2C lcd(0x27, 16, 2);
Preferences prefs;

bool owned = false;
uint64_t secondsLeft = 0;      // paid-up time left, counted down locally
uint32_t percentPaid = 0;
uint32_t lastTick = 0;
uint32_t lastPoll = 0;
uint32_t lastGoodRead = 0;
int rpcIndex = 0;

// kitStatus(uint256) selector 0x3114e208 + kitId as a 32-byte word
String callData() {
  char buf[75];
  snprintf(buf, sizeof(buf), "0x3114e208%064x", KIT_ID);
  return String(buf);
}

// Parse one 32-byte word (64 hex chars) from the eth_call result.
// Returns UINT64_MAX if the value doesn't fit in 64 bits (used for "forever").
uint64_t word(const String& hex, int index) {
  int start = 2 + index * 64;
  if ((int)hex.length() < start + 64) return 0;
  for (int i = start; i < start + 48; i++) {
    if (hex[i] != '0') return UINT64_MAX;
  }
  return strtoull(hex.substring(start + 48, start + 64).c_str(), nullptr, 16);
}

bool readChain() {
  WiFiClientSecure tls;
  // Demo shortcut: no certificate pinning. The call is read-only, so the worst a
  // network attacker can do is report "on" for a while; see README for the
  // production plan (pinned CA + signed status).
  tls.setInsecure();

  for (int attempt = 0; attempt < RPC_COUNT; attempt++) {
    const char* url = RPCS[(rpcIndex + attempt) % RPC_COUNT];
    HTTPClient http;
    if (!http.begin(tls, url)) continue;
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(8000);
    String body = String("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"") +
                  PAYG_ADDRESS + "\",\"data\":\"" + callData() + "\"},\"latest\"]}";
    int code = http.POST(body);
    if (code == 200) {
      String resp = http.getString();
      http.end();
      int at = resp.indexOf("\"result\":\"");
      if (at < 0) continue;
      String result = resp.substring(at + 10, resp.indexOf('"', at + 10));
      if (result.length() < 2 + 64 * 3) continue;

      bool active = word(result, 0) != 0;
      uint64_t left = word(result, 1);
      percentPaid = (uint32_t)word(result, 2);
      owned = (left == UINT64_MAX);
      secondsLeft = active ? left : 0;
      rpcIndex = (rpcIndex + attempt) % RPC_COUNT;
      lastGoodRead = millis();
      if (owned) {
        prefs.putBool("owned", true);  // survives reboots
      }
      Serial.printf("[chain] %s active=%d left=%llu paid=%u%%\n", url, active, left, percentPaid);
      return true;
    }
    Serial.printf("[chain] %s HTTP %d\n", url, code);
    http.end();
  }
  return false;
}

void applyOutput() {
  bool on = owned || secondsLeft > 0;
  digitalWrite(PIN_RELAY, on ? HIGH : LOW);
  digitalWrite(PIN_LED_ON, on ? HIGH : LOW);
  digitalWrite(PIN_LED_DUE, on ? LOW : HIGH);

  char top[17], bottom[17];
  if (owned) {
    snprintf(top, sizeof(top), "Kit %-4u  OWNED", KIT_ID);
    snprintf(bottom, sizeof(bottom), "Power on for good");
  } else if (on) {
    uint32_t d = secondsLeft / 86400, h = (secondsLeft % 86400) / 3600, m = (secondsLeft % 3600) / 60;
    snprintf(top, sizeof(top), "ON  %02ud %02uh %02um", d > 99 ? 99 : d, h, m);
    snprintf(bottom, sizeof(bottom), "Paid %3u%%  Kit%u", percentPaid, KIT_ID);
  } else {
    snprintf(top, sizeof(top), "OFF  Pay to use");
    snprintf(bottom, sizeof(bottom), "imole kit %u", KIT_ID);
  }
  lcd.setCursor(0, 0);
  lcd.print(top);
  for (int i = strlen(top); i < 16; i++) lcd.print(' ');
  lcd.setCursor(0, 1);
  lcd.print(bottom);
  for (int i = strlen(bottom); i < 16; i++) lcd.print(' ');
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_RELAY, OUTPUT);
  pinMode(PIN_LED_ON, OUTPUT);
  pinMode(PIN_LED_DUE, OUTPUT);
  digitalWrite(PIN_RELAY, LOW);  // locked until the chain says otherwise

  lcd.init();
  lcd.backlight();
  lcd.print("Imole  QIE");
  lcd.setCursor(0, 1);
  lcd.print("Connecting...");

  prefs.begin("imole", false);
  owned = prefs.getBool("owned", false);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) delay(250);
  Serial.printf("[wifi] %s\n", WiFi.status() == WL_CONNECTED ? "connected" : "offline");

  if (!owned) readChain();
  lastTick = lastPoll = millis();
  applyOutput();
}

void loop() {
  uint32_t now = millis();

  // local countdown, one second at a time
  if (now - lastTick >= 1000) {
    uint32_t elapsed = (now - lastTick) / 1000;
    lastTick += elapsed * 1000;
    if (!owned) secondsLeft = secondsLeft > elapsed ? secondsLeft - elapsed : 0;
    applyOutput();
  }

  if (!owned && now - lastPoll >= POLL_MS) {
    lastPoll = now;
    if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
    if (!readChain()) Serial.println("[chain] all RPCs failed, using local countdown");
    applyOutput();
  }
  delay(20);
}
