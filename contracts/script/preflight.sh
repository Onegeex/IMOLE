#!/usr/bin/env bash
# Read-only checks against QIE mainnet before deploying. Sends no transactions.
set -euo pipefail
RPC=${RPC:-https://rpc1mainnet.qie.digital}
QUSDC=${QUSDC:-0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5}
FEED=${QIE_USD_FEED:-0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17}
ROUTER=${QIEDEX_ROUTER:-0x08cd2e72e156D8563B4351eb4065C262A9f553Ef}

echo "chain id:        $(cast chain-id --rpc-url "$RPC")   (expect 1990)"
echo "QUSDC symbol:    $(cast call "$QUSDC" 'symbol()(string)' --rpc-url "$RPC")"
echo "QUSDC decimals:  $(cast call "$QUSDC" 'decimals()(uint8)' --rpc-url "$RPC")"
echo "feed decimals:   $(cast call "$FEED" 'decimals()(uint8)' --rpc-url "$RPC")"
echo "feed latest:     $(cast call "$FEED" 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$RPC" | tr '\n' ' ')"
WQIE=$(cast call "$ROUTER" 'WETH()(address)' --rpc-url "$RPC")
echo "router WETH:     $WQIE"
echo "quote 1 QIE ->   $(cast call "$ROUTER" 'getAmountsOut(uint256,address[])(uint256[])' 1000000000000000000 "[$WQIE,$QUSDC]" --rpc-url "$RPC") QUSDC units"
echo
echo "If the quote is within a few % of the feed price, payWithQIE will work with the default 3% guard."
