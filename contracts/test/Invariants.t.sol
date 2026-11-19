// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ImolePAYG} from "../src/ImolePAYG.sol";
import {ImoleKYC} from "../src/ImoleKYC.sol";
import {MockQUSDC, MockFeed, MockRouter} from "./Mocks.sol";

/// @dev Drives random sequences of real user actions against the contract.
contract Handler is Test {
    ImolePAYG public payg;
    MockQUSDC public qusdc;
    MockFeed public feed;
    address public installer;
    address[] public payers;
    uint256[] public planIds;
    uint256 public ghostPaid; // QUSDC the handler saw accepted

    constructor(ImolePAYG p, MockQUSDC q, MockFeed f, address inst, address[] memory ps, uint256[] memory plans) {
        payg = p; qusdc = q; feed = f; installer = inst; payers = ps; planIds = plans;
    }

    function pay(uint256 planSeed, uint256 payerSeed, uint96 amount) external {
        uint256 planId = planIds[planSeed % planIds.length];
        if (payg.getPlan(planId).status != ImolePAYG.Status.Active) return;
        address payer = payers[payerSeed % payers.length];
        amount = uint96(bound(amount, 1, 600e6));
        uint256 before = payg.getPlan(planId).totalPaid;
        vm.prank(payer);
        payg.pay(planId, amount);
        ghostPaid += payg.getPlan(planId).totalPaid - before;
    }

    function payQIE(uint256 planSeed, uint256 payerSeed, uint64 qie) external {
        uint256 planId = planIds[planSeed % planIds.length];
        if (payg.getPlan(planId).status != ImolePAYG.Status.Active) return;
        address payer = payers[payerSeed % payers.length];
        uint256 value = bound(qie, 1 ether, 5_000 ether);
        feed.set(15_000_000, block.timestamp); // keep the oracle fresh
        uint256 before = payg.getPlan(planId).totalPaid;
        vm.deal(payer, value);
        vm.prank(payer);
        payg.payWithQIE{value: value}(planId, 0, block.timestamp + 300);
        ghostPaid += payg.getPlan(planId).totalPaid - before;
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 45 days));
    }

    /// The installer tries to take the kit back. Must only ever succeed when overdue.
    function tryRepossess(uint256 planSeed) external {
        uint256 planId = planIds[planSeed % planIds.length];
        ImolePAYG.Plan memory p = payg.getPlan(planId);
        bool overdue = p.status == ImolePAYG.Status.Active && block.timestamp > uint256(p.paidUntil) + p.terms.repossessAfter;
        vm.prank(installer);
        try payg.repossess(planId) {
            assertTrue(overdue, "repossessed a customer who was not overdue");
        } catch {
            assertFalse(overdue, "could not repossess an overdue kit");
        }
    }

    function planCount() external view returns (uint256) { return planIds.length; }
}

contract ImoleInvariants is StdInvariant, Test {
    ImolePAYG payg;
    MockQUSDC qusdc;
    MockFeed feed;
    Handler handler;
    address installer = makeAddr("installer");
    address treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(1_750_000_000);
        qusdc = new MockQUSDC();
        feed = new MockFeed();
        MockRouter router = new MockRouter(qusdc);
        ImoleKYC kyc = new ImoleKYC(address(this));
        payg = new ImolePAYG(address(this), treasury, qusdc, feed, router, kyc);
        vm.prank(installer);
        payg.registerInstaller("Sunrise Solar Co.");

        address[] memory payers = new address[](3);
        uint256[] memory plans = new uint256[](3);
        for (uint256 i; i < 3; i++) {
            address c = makeAddr(string(abi.encodePacked("customer", i)));
            payers[i] = c;
            qusdc.mint(c, 1e15);
            vm.prank(c);
            qusdc.approve(address(payg), type(uint256).max);
            vm.prank(installer);
            (, uint256 planId) = payg.listKit(
                c,
                ImolePAYG.Specs(600, 1200, 1000, "Kisumu, Kenya"),
                ImolePAYG.Terms(uint128(300e6 + i * 50e6), 20e6, 8e6, 7 days, 2 days, 30 days, false)
            );
            vm.prank(c);
            payg.acceptPlan(planId);
            plans[i] = planId;
        }
        handler = new Handler(payg, qusdc, feed, installer, payers, plans);
        targetContract(address(handler));
    }

    /// Money is never held by the contract: every payment goes straight to installer + treasury.
    function invariant_contractHoldsNoQUSDC() public view {
        assertEq(qusdc.balanceOf(address(payg)), 0);
    }

    /// Nobody ever pays more than the kit's price.
    function invariant_neverOverpaid() public view {
        for (uint256 id = 1; id < payg.nextPlanId(); id++) {
            ImolePAYG.Plan memory p = payg.getPlan(id);
            assertLe(p.totalPaid, p.terms.price);
        }
    }

    /// A paid-up customer is always powered; a paid-off kit is always powered and owned by the customer.
    function invariant_paidUpMeansPowered() public view {
        for (uint256 id = 1; id < payg.nextPlanId(); id++) {
            ImolePAYG.Plan memory p = payg.getPlan(id);
            if (p.status == ImolePAYG.Status.Active && block.timestamp <= uint256(p.paidUntil) + p.terms.grace) {
                assertTrue(payg.isKitActive(p.kitId));
            }
            if (p.status == ImolePAYG.Status.PaidOff) {
                assertTrue(payg.isKitActive(p.kitId));
                assertEq(payg.ownerOf(p.kitId), p.customer);
            }
        }
    }

    /// Accounting adds up: totalVolume = deposits + everything the handler paid, and splits 99/1.
    function invariant_accountingAddsUp() public view {
        uint256 deposits = 20e6 * 3;
        assertEq(payg.totalVolume(), deposits + handler.ghostPaid());
        uint256 vol = payg.totalVolume();
        assertEq(qusdc.balanceOf(installer) + qusdc.balanceOf(treasury), vol);
        assertApproxEqAbs(qusdc.balanceOf(treasury), vol / 100, payg.paymentCount());
    }
}
