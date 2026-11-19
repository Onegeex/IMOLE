#!/bin/bash
# Lists a fresh demo kit with neutral labels and powers it with 1 QIE.
# Roles are swapped from the first demo: imole-customer acts as the installer, imole-deployer as the customer.
# Double-click this file (or run: bash ~/IMOLE/new-demo-kit.command).

cd "$(dirname "$0")/contracts" || exit 1
ROOT="$(cd .. && pwd)"; LOG="$ROOT/launch-log.txt"
export PATH="$HOME/.foundry/bin:$PATH"
RPC=${RPC:-https://rpc1mainnet.qie.digital}
source "$ROOT/deployment.env" 2>/dev/null
: "${PAYG:?deployment.env missing PAYG}" "${KYC:?deployment.env missing KYC}"

say()  { printf "\n\033[1;33m%s\033[0m\n" "$*"; }
fail() { printf "\n\033[1;31m✘ %s\033[0m\n" "$*"; read -r -p "Press Enter to close."; exit 1; }
echo "=== New demo kit $(date) ===" >> "$LOG"

say "Unlock your wallets"
read -r -s -p "Password for imole-deployer: " DPW; echo
read -r -s -p "Password for imole-customer: " CPW; echo
DEP=(--account imole-deployer --password "$DPW"); CUS=(--account imole-customer --password "$CPW")
MAIN=$(cast wallet address "${DEP[@]}") || fail "Wrong password for imole-deployer."
CLIENT=$(cast wallet address "${CUS[@]}") || fail "Wrong password for imole-customer."
echo "  installer (client wallet): $CLIENT"; echo "  customer  (main wallet):   $MAIN"
send() { cast send --rpc-url "$RPC" "$@" 2>&1 | grep -E "^(status|transactionHash)" | tee -a "$LOG"; }

say "1/4 Registering the demo installer"
NAME=$(cast call "$PAYG" 'installers(address)(bool,bool,string,uint32,uint128)' "$CLIENT" --rpc-url "$RPC" | head -1)
[ "$NAME" = "true" ] && echo "already registered" || send "${CUS[@]}" "$PAYG" 'registerInstaller(string)' "Imole Demo Installer"

say "2/4 Recording the customer's ID check"
send "${DEP[@]}" "$KYC" 'attest(address,uint8,bytes32)' "$MAIN" 2 "$(cast keccak demo-kit-2-in-person-check)"

say "3/4 Listing the demo kit (1 QUSDC price, 0.05 QUSDC per 10 minutes)"
send "${CUS[@]}" "$PAYG" \
  'listKit(address,(uint32,uint32,uint32,string),(uint128,uint128,uint128,uint32,uint32,uint32,bool))' \
  "$MAIN" "(1200,2400,1500,\"Demo kit\")" "(1000000,0,50000,600,120,3600,true)"
PLAN=$(( $(cast call "$PAYG" 'nextPlanId()(uint256)' --rpc-url "$RPC" | awk '{print $1}') - 1 ))
KIT=$(( $(cast call "$PAYG" 'nextKitId()(uint256)' --rpc-url "$RPC" | awk '{print $1}') - 1 ))
echo "plan $PLAN  kit $KIT" | tee -a "$LOG"

say "4/4 Customer accepts and pays 1 QIE"
send "${DEP[@]}" "$PAYG" 'acceptPlan(uint256)' "$PLAN"
send "${DEP[@]}" --value 1ether "$PAYG" 'payWithQIE(uint256,uint256,uint256)' "$PLAN" 0 $(( $(date +%s) + 600 ))
echo "kitStatus: $(cast call "$PAYG" 'kitStatus(uint256)(bool,uint256,uint256)' "$KIT" --rpc-url "$RPC" | tr '\n' ' ')" | tee -a "$LOG"
grep -q '^DEMO_KIT=' "$ROOT/deployment.env" && sed -i '' "s/^DEMO_KIT=.*/DEMO_KIT=$KIT/" "$ROOT/deployment.env" || echo "DEMO_KIT=$KIT" >> "$ROOT/deployment.env"
echo "NEW_DEMO_KIT=$KIT" >> "$LOG"

unset DPW CPW
say "Done. Demo kit $KIT is live. Go back to Claude and type: done"
read -r -p "Press Enter to close."
