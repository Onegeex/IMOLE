#!/bin/bash
# Imole one-time launcher for QIE Mainnet.
# Double-click this file (or run: bash ~/IMOLE/launch.command).
# It sets up your two wallets, deploys the contracts, verifies them, and seeds the demo kit.
# Private keys and passwords are typed into hidden prompts and never written to the log.

cd "$(dirname "$0")/contracts" || { echo "Can't find the contracts folder next to this file."; read -r; exit 1; }
ROOT="$(cd .. && pwd)"
LOG="$ROOT/launch-log.txt"
export PATH="$HOME/.foundry/bin:$PATH"
RPC=${RPC:-https://rpc1mainnet.qie.digital}
KS="$HOME/.foundry/keystores"
QUSDC=${QUSDC:-0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5}
FEED=${QIE_USD_FEED:-0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17}
ROUTER=${QIEDEX_ROUTER:-0x08cd2e72e156D8563B4351eb4065C262A9f553Ef}

say()  { printf "\n\033[1;33m%s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
fail() { printf "\n\033[1;31m✘ %s\033[0m\n" "$*"; echo "Copy this window's text to Claude if you're stuck."; read -r -p "Press Enter to close."; exit 1; }
log()  { echo "$*" >> "$LOG"; }

echo "=== Imole launch $(date) ===" >> "$LOG"
clear
say "Imole launcher: QIE Mainnet deploy"
echo "This takes about 5 minutes. You'll be asked for your two private keys (only if they're"
echo "not saved yet) and their passwords. Nothing you type is shown or saved in the log."

# ---------------------------------------------------------------- tools
if ! command -v forge >/dev/null 2>&1; then
  say "Installing Foundry…"
  curl -L https://foundry.paradigm.xyz | bash && "$HOME/.foundry/bin/foundryup" || fail "Foundry install failed."
fi
ok "Foundry $(forge --version | head -1 | awk '{print $3}')"
mkdir -p "$KS"

import_role() { # $1 role
  if [ "$1" = deployer ]; then what="MAIN wallet (about 5 QIE)"; else what="SECOND wallet (about 3 QIE)"; fi
  say "Add your $what"
  echo "Paste its private key from QIE Wallet and press Enter (nothing will appear as you paste)."
  echo "Then make up a password for it. Foundry asks only ONCE, so type it carefully."
  cast wallet import "imole-$1" --interactive || fail "Import of imole-$1 failed."
}
ask_pw() { # $1 role -> sets PW and ADDR
  local tries=0 err
  while true; do
    read -r -s -p "Password for imole-$1: " PW; echo
    if ADDR=$(cast wallet address --account "imole-$1" --password "$PW" 2>/tmp/imole-unlock.err); then return 0; fi
    err=$(head -c 300 /tmp/imole-unlock.err | tr '\n' ' ')
    echo "That didn't unlock imole-$1. (Foundry said: $err)"
    log "unlock failed for imole-$1: $err"
    tries=$((tries+1))
    if [ $tries -ge 2 ]; then
      read -r -p "Re-import imole-$1 with a new password instead? You'll need its private key. [y/n] " a
      if [[ "$a" =~ ^[Yy] ]]; then
        mv "$KS/imole-$1" "$KS/imole-$1.old-$(date +%s)" && import_role "$1"; tries=0
      elif [ $tries -ge 4 ]; then
        fail "Couldn't unlock imole-$1."
      fi
    fi
  done
}
# ---------------------------------------------------------------- wallet names
if [ -f "$KS/imole-customer" ] && [ ! -f "$KS/imole-deployer" ]; then
  say "You have one saved wallet, called imole-customer."
  read -r -p "Is that your MAIN wallet (the one with about 5 QIE)? [y/n] " a
  if [[ "$a" =~ ^[Yy] ]]; then
    mv "$KS/imole-customer" "$KS/imole-deployer" && ok "Renamed it to imole-deployer."
  fi
fi

for role in deployer customer; do
  [ -f "$KS/imole-$role" ] || import_role "$role"
done

# ---------------------------------------------------------------- passwords + addresses
say "Unlock your wallets"
ask_pw deployer; DEPLOYER_PASSWORD=$PW; DEPLOYER=$ADDR
ask_pw customer; CUSTOMER_PASSWORD=$PW; CUSTOMER=$ADDR
export DEPLOYER_PASSWORD CUSTOMER_PASSWORD

same() { [ "$(echo "$DEPLOYER" | tr A-F a-f)" = "$(echo "$CUSTOMER" | tr A-F a-f)" ]; }
while same; do
  say "Both names hold the SAME wallet: $DEPLOYER"
  echo "Check this address in QIE Wallet."
  read -r -p "Is $DEPLOYER your MAIN wallet (about 5 QIE)? [y/n] " a
  if [[ "$a" =~ ^[Yy] ]]; then
    mv "$KS/imole-customer" "$KS/imole-customer.old-$(date +%s)"; import_role customer
    ask_pw customer; CUSTOMER_PASSWORD=$PW; CUSTOMER=$ADDR
  else
    mv "$KS/imole-deployer" "$KS/imole-deployer.old-$(date +%s)"; import_role deployer
    ask_pw deployer; DEPLOYER_PASSWORD=$PW; DEPLOYER=$ADDR
  fi
  export DEPLOYER_PASSWORD CUSTOMER_PASSWORD
done

BD=$(cast balance "$DEPLOYER" --ether --rpc-url "$RPC") || fail "Can't reach QIE Mainnet. Check your internet."
BC=$(cast balance "$CUSTOMER" --ether --rpc-url "$RPC")
echo
echo "  Deployer (installer): $DEPLOYER   $BD QIE"
echo "  Customer:             $CUSTOMER   $BC QIE"
log "deployer $DEPLOYER $BD QIE"; log "customer $CUSTOMER $BC QIE"
awk "BEGIN{exit !($BD < 2)}" && fail "The deployer wallet needs at least 2 QIE (it has $BD)."
awk "BEGIN{exit !($BC < 1.2)}" && fail "The customer wallet needs at least 1.2 QIE (it has $BC)."
ok "Balances look fine."

read -r -p $'\nDeploy Imole to QIE Mainnet now? [y/n] ' a
[[ "$a" =~ ^[Yy] ]] || fail "Stopped before deploying. Nothing was sent."

# ---------------------------------------------------------------- deploy
say "Deploying contracts…"
OUT=$(forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast \
      --account imole-deployer --password "$DEPLOYER_PASSWORD" --sender "$DEPLOYER" 2>&1)
echo "$OUT" | grep -v -i password | tee -a "$LOG" | tail -25
KYC=$(echo "$OUT"  | grep -E "^ *ImoleKYC"  | grep -oE "0x[0-9a-fA-F]{40}" | head -1)
PAYG=$(echo "$OUT" | grep -E "^ *ImolePAYG" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)
[ -n "$KYC" ] && [ -n "$PAYG" ] || fail "Deploy didn't finish."
ok "ImoleKYC  $KYC"
ok "ImolePAYG $PAYG"
printf "PAYG=%s\nKYC=%s\nDEPLOYER=%s\nCUSTOMER=%s\n" "$PAYG" "$KYC" "$DEPLOYER" "$CUSTOMER" > "$ROOT/deployment.env"
log "PAYG $PAYG"; log "KYC $KYC"

# ---------------------------------------------------------------- verify (best effort)
say "Verifying source code on the QIE explorer…"
VURL=https://mainnet.qie.digital/api/
forge verify-contract "$KYC" src/ImoleKYC.sol:ImoleKYC --chain-id 1990 --verifier blockscout --verifier-url "$VURL" \
  --constructor-args "$(cast abi-encode 'constructor(address)' "$DEPLOYER")" 2>&1 | tail -4 | tee -a "$LOG"
forge verify-contract "$PAYG" src/ImolePAYG.sol:ImolePAYG --chain-id 1990 --verifier blockscout --verifier-url "$VURL" \
  --constructor-args "$(cast abi-encode 'constructor(address,address,address,address,address,address)' \
     "$DEPLOYER" "$DEPLOYER" "$QUSDC" "$FEED" "$ROUTER" "$KYC")" 2>&1 | tail -4 | tee -a "$LOG"
echo "(If verification failed, that's fine: Claude can retry it later. Nothing depends on it.)"

# ---------------------------------------------------------------- demo kit + trust proofs
say "Seeding the demo kit and recording the trust proofs…"
PAYG="$PAYG" KYC="$KYC" RPC="$RPC" bash script/demo.sh 2>&1 | grep -v -i password | tee -a "$LOG"
KIT=$(grep -oE "^plan [0-9]+  kit [0-9]+" "$LOG" | tail -1 | awk '{print $4}')
[ -n "$KIT" ] && echo "DEMO_KIT=$KIT" >> "$ROOT/deployment.env"

say "All done."
echo "Go back to Claude and type: done"
echo "(Claude reads launch-log.txt and deployment.env in your IMOLE folder. They contain addresses and"
echo " transaction hashes only, no keys or passwords.)"
unset DEPLOYER_PASSWORD CUSTOMER_PASSWORD
read -r -p "Press Enter to close this window."
