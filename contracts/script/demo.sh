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
INST=$(cast wallet address --account imole-deployer)
CUST=$(cast wallet address --account imole-customer)
send() { cast send --rpc-url "$RPC" "$@"; }
echo "installer $INST  customer $CUST"

# 1. installer profile
send --account imole-deployer "$PAYG" 'registerInstaller(string)' "Imole Demo Installer (Lagos)" || true

# 2. KYC attestation (source 1 = QiePass, 2 = InPerson). Ref is a hash, never personal data.
send --account imole-deployer "$KYC" 'attest(address,uint8,bytes32)' "$CUST" 2 "$(cast keccak demo-in-person-check-001)"

# 3. list a demo kit with fast terms so judges can watch it lock:
#    price 1.00 QUSDC, no deposit, 0.05 QUSDC buys 10 minutes, 2 min grace, repossess after 1 hour overdue
#    (QUSDC amounts below assume 6 decimals; preflight.sh prints the real value)
send --account imole-deployer "$PAYG" \
  'listKit(address,(uint32,uint32,uint32,string),(uint128,uint128,uint128,uint32,uint32,uint32,bool))' \
  "$CUST" "(1200,2400,1500,\"Ile-Ife Osun\")" "(1000000,0,50000,600,120,3600,true)"
PLAN=$(( $(cast call "$PAYG" 'nextPlanId()(uint256)' --rpc-url "$RPC") - 1 ))
KIT=$(( $(cast call "$PAYG" 'nextKitId()(uint256)' --rpc-url "$RPC") - 1 ))
echo "plan $PLAN  kit $KIT"

# 4. customer accepts and pays 1 QIE (swapped to QUSDC on QIEDEX, checked against the QIE Oracle)
send --account imole-customer "$PAYG" 'acceptPlan(uint256)' "$PLAN"
DEADLINE=$(( $(date +%s) + 600 ))
send --account imole-customer --value 1ether "$PAYG" 'payWithQIE(uint256,uint256,uint256)' "$PLAN" 0 "$DEADLINE"
echo "kitStatus: $(cast call "$PAYG" 'kitStatus(uint256)(bool,uint256,uint256)' "$KIT" --rpc-url "$RPC" | tr '\n' ' ')"

# 5. trust proofs: these MUST fail on-chain. A fixed gas limit makes cast broadcast them anyway.
echo "--- proof: installer tries to repossess a customer who is paid up (expect revert NotOverdue)"
send --account imole-deployer --gas-limit 120000 "$PAYG" 'repossess(uint256)' "$PLAN" || true
echo "--- proof: installer tries to cancel an accepted plan (expect revert WrongStatus)"
send --account imole-deployer --gas-limit 120000 "$PAYG" 'cancelPlan(uint256)' "$PLAN" || true
echo "--- proof: customer tries to self-verify KYC (expect revert NotAttester)"
send --account imole-customer --gas-limit 120000 "$KYC" 'attest(address,uint8,bytes32)' "$CUST" 1 0x00 || true

echo
echo "Done. Put the failed tx hashes above into README.md under 'Trust proofs'."
echo "Point the Wokwi firmware at kit $KIT."
