// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ImolePAYG} from "../src/ImolePAYG.sol";
import {ImoleKYC} from "../src/ImoleKYC.sol";
import {MockQUSDC, MockFeed, MockRouter} from "../test/Mocks.sol";

/// @notice Local end-to-end fixture: anvil --chain-id 1990, mocks for QUSDC, oracle, QIEDEX.
contract LocalDemo is Script {
    function run() external {
        uint256 ownerKey = vm.envUint("OWNER_KEY");
        uint256 custKey = vm.envUint("CUSTOMER_KEY");
        address owner = vm.addr(ownerKey);
        address customer = vm.addr(custKey);

        vm.startBroadcast(ownerKey);
        MockQUSDC qusdc = new MockQUSDC();
        MockFeed feed = new MockFeed();
        MockRouter router = new MockRouter(qusdc);
        ImoleKYC kyc = new ImoleKYC(owner);
        ImolePAYG payg = new ImolePAYG(owner, owner, qusdc, feed, router, kyc);
        kyc.setAttester(owner, true);
        payg.registerInstaller("Sunrise Solar Co.");
        kyc.attest(customer, ImoleKYC.Source.InPerson, keccak256("visit-001"));
        qusdc.mint(customer, 1_000e6);
        ImolePAYG.Specs memory specs = ImolePAYG.Specs(1200, 2400, 1500, "Dhaka, Bangladesh");
        // kit 1: active weekly plan
        payg.listKit(customer, specs, ImolePAYG.Terms(450e6, 45e6, 9e6, 7 days, 2 days, 30 days, true));
        // kit 2: pending plan waiting for the customer
        payg.listKit(customer, ImolePAYG.Specs(600, 1200, 1000, "Kisumu, Kenya"), ImolePAYG.Terms(250e6, 25e6, 5e6, 7 days, 2 days, 30 days, true));
        vm.stopBroadcast();

        vm.startBroadcast(custKey);
        qusdc.approve(address(payg), type(uint256).max);
        payg.acceptPlan(1);
        payg.pay(1, 18e6);
        vm.stopBroadcast();

        console2.log("PAYG", address(payg));
        console2.log("KYC", address(kyc));
        console2.log("QUSDC", address(qusdc));
        console2.log("ROUTER", address(router));
    }
}
