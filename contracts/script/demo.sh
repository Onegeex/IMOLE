#!/usr/bin/env bash
# Seeds a live demo on QIE mainnet and records the "trust proofs" judges can click.
#
# Needs two Foundry keystore accounts (created with `cast wallet import`):
#   imole-deployer  - deployed the contracts; acts as installer and KYC attester
#   imole-customer  - a second wallet holding ~3 QIE
#
# Env: PAYG and KYC = deployed addresses.
set -euo pipefail
RPC=${RPC:-https://rpc1mainnet.qie.digital}
: "${PAYG:?set PAYG}" "${KYC:?set KYC}"
# Passwords come from the launcher (DEPLOYER_PASSWORD / CUSTOMER_PASSWORD); without them cast prompts.
DEP=(--account imole-deployer);  [ -n "${DEPLOYER_PASSWORD:-}" ] && DEP+=(--password "$DEPLOYER_PASSWORD")
CUS=(--account imole-customer);  [ -n "${CUSTOMER_PASSWORD:-}" ] && CUS+=(--password "$CUSTOMER_PASSWORD")
INST=$(cast wallet address "${DEP[@]}")
CUST=$(cast wallet address "${CUS[@]}")
send() { cast send --rpc-url "$RPC" "$@"; }
echo "installer $INST  customer $CUST"

# 1. installer profile
send "${DEP[@]}" "$PAYG" 'registerInstaller(string)' "Imole Demo Installer (Lagos)" || true

# 2. KYC attestation (source 1 = QiePass, 2 = InPerson). Ref is a hash, never personal data.
send "${DEP[@]}" "$KYC" 'attest(address,uint8,bytes32)' "$CUST" 2 "$(cast keccak demo-in-person-check-001)"

# 3. list a demo kit with fast terms so judges can watch it lock:
#    price 1.00 QUSDC, no deposit, 0.05 QUSDC buys 10 minutes, 2 min grace, repossess after 1 hour overdue
#    (QUSDC amounts below assume 6 decimals; preflight.sh prints the real value)
send "${DEP[@]}" "$PAYG" \
  'listKit(address,(uint32,uint32,uint32,string),(uint128,uint128,uint128,uint32,uint32,uint32,bool))' \
  "$CUST" "(1200,2400,1500,\"Ile-Ife Osun\")" "(1000000,0,50000,600,120,3600,true)"
PLAN=$(( $(cast call "$PAYG" 'nextPlanId()(uint256)' --rpc-url "$RPC" | awk '{print $1}') - 1 ))
KIT=$(( $(cast call "$PAYG" 'nextKitId()(uint256)' --rpc-url "$RPC" | awk '{print $1}') - 1 ))
echo "plan $PLAN  kit $KIT"

# 4. customer accepts and pays 1 QIE (swapped to QUSDC on QIEDEX, checked against the QIE Oracle)
send "${CUS[@]}" "$PAYG" 'acceptPlan(uint256)' "$PLAN"
DEADLINE=$(( $(date +%s) + 600 ))
send "${CUS[@]}" --value 1ether "$PAYG" 'payWithQIE(uint256,uint256,uint256)' "$PLAN" 0 "$DEADLINE"
echo "kitStatus: $(cast call "$PAYG" 'kitStatus(uint256)(bool,uint256,uint256)' "$KIT" --rpc-url "$RPC" | tr '\n' ' ')"

# 5. trust proofs: these MUST fail on-chain. A fixed gas limit makes cast broadcast them anyway.
echo "--- proof: installer tries to repossess a customer who is paid up (expect revert NotOverdue)"
send "${DEP[@]}" --gas-limit 120000 "$PAYG" 'repossess(uint256)' "$PLAN" || true
echo "--- proof: installer tries to cancel an accepted plan (expect revert WrongStatus)"
send "${DEP[@]}" --gas-limit 120000 "$PAYG" 'cancelPlan(uint256)' "$PLAN" || true
echo "--- proof: customer tries to self-verify KYC (expect revert NotAttester)"
send "${CUS[@]}" --gas-limit 120000 "$KYC" 'attest(address,uint8,bytes32)' "$CUST" 1 "$(cast keccak self-attest-attempt)" || true

echo
echo "Done. Put the failed tx hashes above into README.md under 'Trust proofs'."
echo "Point the Wokwi firmware at kit $KIT."
