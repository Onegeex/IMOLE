// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ImolePAYG} from "../src/ImolePAYG.sol";
import {ImoleKYC} from "../src/ImoleKYC.sol";
import {IAggregatorV3, IQieDexRouter} from "../src/interfaces/IQie.sol";

/// @notice Deploys Imole to QIE mainnet (chain 1990).
/// Usage (see README):
///   forge script script/Deploy.s.sol --rpc-url qie_mainnet --broadcast --account imole-deployer
contract Deploy is Script {
    // QIE mainnet addresses (sources in README). Override with env vars if any change.
    address constant QUSDC = 0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5;
    address constant QIE_USD_FEED = 0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17;
    address constant QIEDEX_ROUTER = 0x08cd2e72e156D8563B4351eb4065C262A9f553Ef;

    function run() external {
        require(block.chainid == 1990 || block.chainid == 1983, "not a QIE chain");
        address qusdc = vm.envOr("QUSDC", QUSDC);
        address feed = vm.envOr("QIE_USD_FEED", QIE_USD_FEED);
        address router = vm.envOr("QIEDEX_ROUTER", QIEDEX_ROUTER);

        vm.startBroadcast();
        address me = msg.sender;
        address treasury = vm.envOr("TREASURY", me);

        ImoleKYC kyc = new ImoleKYC(me);
        ImolePAYG payg = new ImolePAYG(me, treasury, IERC20(qusdc), IAggregatorV3(feed), IQieDexRouter(router), kyc);
        kyc.setAttester(me, true); // the Imole backend / field agent key
        vm.stopBroadcast();

        console2.log("ImoleKYC  ", address(kyc));
        console2.log("ImolePAYG ", address(payg));
        console2.log("QUSDC decimals read on deploy:", payg.qusdcDecimals());
    }
}
