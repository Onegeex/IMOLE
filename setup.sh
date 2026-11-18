#!/usr/bin/env bash
# One-time setup after unzipping: creates the git repo and pulls the two contract
# dependencies (forge-std, OpenZeppelin v5.0.2) as submodules.
set -euo pipefail
cd "$(dirname "$0")"
[ -d .git ] || git init -q
rm -f .gitmodules
git submodule add -q https://github.com/foundry-rs/forge-std contracts/lib/forge-std
git submodule add -q https://github.com/OpenZeppelin/openzeppelin-contracts contracts/lib/openzeppelin-contracts
(cd contracts/lib/openzeppelin-contracts && git checkout -q v5.0.2)
git add -A
echo "Ready. Next: cd contracts && forge test"
