// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ImolePAYG} from "../src/ImolePAYG.sol";
import {ImoleKYC} from "../src/ImoleKYC.sol";
import {MockQUSDC, MockFeed, MockRouter} from "./Mocks.sol";

contract ImolePAYGTest is Test {
    ImolePAYG payg;
    ImoleKYC kyc;
    MockQUSDC qusdc;
    MockFeed feed;
    MockRouter router;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address installer = makeAddr("installer");
    address customer = makeAddr("customer");
    address relative = makeAddr("relative");
    address attester = makeAddr("attester");

    uint128 constant PRICE = 400e6; // 400 QUSDC
    uint128 constant DEPOSIT = 40e6;
    uint128 constant WEEKLY = 10e6;
    uint32 constant WEEK = 7 days;

    function setUp() public {
        vm.warp(1_750_000_000);
        qusdc = new MockQUSDC();
        feed = new MockFeed();
        router = new MockRouter(qusdc);
        kyc = new ImoleKYC(owner);
        payg = new ImolePAYG(owner, treasury, qusdc, feed, router, kyc);

        vm.prank(owner);
        kyc.setAttester(attester, true);

        vm.prank(installer);
        payg.registerInstaller("Ikeja Solar Works");

        qusdc.mint(customer, 1_000e6);
        qusdc.mint(relative, 1_000e6);
        vm.prank(customer);
        qusdc.approve(address(payg), type(uint256).max);
        vm.prank(relative);
        qusdc.approve(address(payg), type(uint256).max);
        vm.deal(customer, 10_000 ether);
    }

    function _terms(bool requireKyc) internal pure returns (ImolePAYG.Terms memory) {
        return ImolePAYG.Terms({
            price: PRICE,
            deposit: DEPOSIT,
            installment: WEEKLY,
            period: WEEK,
            grace: 2 days,
            repossessAfter: 30 days,
            requireKyc: requireKyc
        });
    }

    function _specs() internal pure returns (ImolePAYG.Specs memory) {
        return ImolePAYG.Specs({panelWatts: 1200, batteryWh: 2400, inverterVA: 1500, location: "Ikeja, Lagos"});
    }

    function _list(bool requireKyc) internal returns (uint256 kitId, uint256 planId) {
        vm.prank(installer);
        (kitId, planId) = payg.listKit(customer, _specs(), _terms(requireKyc));
    }

    function _verifyCustomer() internal {
        vm.prank(attester);
        kyc.attest(customer, ImoleKYC.Source.QiePass, keccak256("qiepass-verification-123"));
    }

    function _listAndAccept() internal returns (uint256 kitId, uint256 planId) {
        (kitId, planId) = _list(true);
        _verifyCustomer();
        vm.prank(customer);
        payg.acceptPlan(planId);
    }

    // ------------------------------------------------------------------ listing

    function test_listKit_mintsIntoEscrow() public {
        (uint256 kitId, uint256 planId) = _list(true);
        assertEq(payg.ownerOf(kitId), address(payg));
        assertEq(uint8(payg.getPlan(planId).status), uint8(ImolePAYG.Status.Pending));
        assertFalse(payg.isKitActive(kitId));
    }

    function test_listKit_rejectsUnregisteredInstaller() public {
        vm.prank(relative);
        vm.expectRevert(ImolePAYG.NotInstaller.selector);
        payg.listKit(customer, _specs(), _terms(true));
    }

    function test_listKit_rejectsBadTerms() public {
        ImolePAYG.Terms memory t = _terms(true);
        t.deposit = PRICE + 1;
        vm.prank(installer);
        vm.expectRevert(ImolePAYG.BadTerms.selector);
        payg.listKit(customer, _specs(), t);
    }

    // ------------------------------------------------------------------ accepting

    function test_accept_requiresKyc() public {
        (, uint256 planId) = _list(true);
        vm.prank(customer);
        vm.expectRevert(ImolePAYG.NotVerified.selector);
        payg.acceptPlan(planId);
    }

    function test_accept_onlyNamedCustomer() public {
        (, uint256 planId) = _list(false);
        vm.prank(relative);
        vm.expectRevert(ImolePAYG.NotCustomer.selector);
        payg.acceptPlan(planId);
    }

    function test_accept_paysDepositAndPowersOn() public {
        (uint256 kitId, uint256 planId) = _listAndAccept();
        ImolePAYG.Plan memory p = payg.getPlan(planId);
        assertEq(uint8(p.status), uint8(ImolePAYG.Status.Active));
        assertEq(p.totalPaid, DEPOSIT);
        // 40 QUSDC deposit at 10 QUSDC/week buys 4 weeks
        assertEq(p.paidUntil, block.timestamp + 4 * WEEK);
        assertTrue(payg.isKitActive(kitId));
        // 1% fee to treasury, the rest straight to the installer
        assertEq(qusdc.balanceOf(treasury), DEPOSIT / 100);
        assertEq(qusdc.balanceOf(installer), DEPOSIT - DEPOSIT / 100);
        assertEq(qusdc.balanceOf(address(payg)), 0);
    }

    // ------------------------------------------------------------------ power state

    function test_locksAfterGrace_andUnlocksOnPayment() public {
        (uint256 kitId, uint256 planId) = _listAndAccept();
        vm.warp(block.timestamp + 4 * WEEK + 2 days); // last second of grace
        assertTrue(payg.isKitActive(kitId));
        vm.warp(block.timestamp + 1);
        assertFalse(payg.isKitActive(kitId));

        vm.prank(customer);
        payg.pay(planId, WEEKLY);
        assertTrue(payg.isKitActive(kitId));
        // credit starts from now, not from the old paidUntil
        assertEq(payg.getPlan(planId).paidUntil, block.timestamp + WEEK);
    }

    function test_paymentWhileCurrent_extendsFromPaidUntil() public {
        (, uint256 planId) = _listAndAccept();
        uint64 before = payg.getPlan(planId).paidUntil;
        vm.prank(customer);
        payg.pay(planId, 5e6); // half a week
        assertEq(payg.getPlan(planId).paidUntil, before + WEEK / 2);
    }

    function test_anyoneCanPay_eg_relativeAbroad() public {
        (uint256 kitId, uint256 planId) = _listAndAccept();
        vm.warp(block.timestamp + 60 days);
        assertFalse(payg.isKitActive(kitId));
        vm.prank(relative);
        payg.pay(planId, 20e6);
        assertTrue(payg.isKitActive(kitId));
        assertEq(payg.uniquePayers(), 2);
    }

    function test_kitStatus_forController() public {
        (uint256 kitId,) = _listAndAccept();
        (bool active, uint256 left, uint256 pct) = payg.kitStatus(kitId);
        assertTrue(active);
        assertEq(left, 4 * WEEK + 2 days);
        assertEq(pct, 10);
    }

    // ------------------------------------------------------------------ payoff

    function test_payoff_transfersKitAndUnlocksForever() public {
        (uint256 kitId, uint256 planId) = _listAndAccept();
        vm.prank(customer);
        payg.pay(planId, 999e6); // more than remaining: only the remainder is taken
        ImolePAYG.Plan memory p = payg.getPlan(planId);
        assertEq(uint8(p.status), uint8(ImolePAYG.Status.PaidOff));
        assertEq(p.totalPaid, PRICE);
        assertEq(payg.ownerOf(kitId), customer);
        assertEq(qusdc.balanceOf(customer), 1_000e6 - PRICE);

        vm.warp(block.timestamp + 3650 days);
        assertTrue(payg.isKitActive(kitId));
        assertEq(payg.kitsPaidOff(), 1);
    }

    function test_payoff_cannotPayAgain() public {
        (, uint256 planId) = _listAndAccept();
        vm.prank(customer);
        payg.pay(planId, PRICE);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(ImolePAYG.WrongStatus.selector, ImolePAYG.Status.PaidOff));
        payg.pay(planId, 1e6);
    }

    // ------------------------------------------------------------------ installer limits

    function test_repossess_refusedWhileCustomerIsCurrent() public {
        (, uint256 planId) = _listAndAccept();
        uint256 overdueAt = payg.getPlan(planId).paidUntil + 30 days;
        vm.warp(overdueAt); // still not past the line
        vm.prank(installer);
        vm.expectRevert(abi.encodeWithSelector(ImolePAYG.NotOverdue.selector, overdueAt));
        payg.repossess(planId);
    }

    function test_repossess_afterLongDefault() public {
        (uint256 kitId, uint256 planId) = _listAndAccept();
        vm.warp(payg.getPlan(planId).paidUntil + 30 days + 1);
        vm.prank(installer);
        payg.repossess(planId);
        assertEq(payg.ownerOf(kitId), installer);
        assertFalse(payg.isKitActive(kitId));
    }

    function test_repossess_onlyInstaller() public {
        (, uint256 planId) = _listAndAccept();
        vm.warp(block.timestamp + 365 days);
        vm.prank(relative);
        vm.expectRevert(ImolePAYG.NotInstaller.selector);
        payg.repossess(planId);
    }

    function test_relist_afterRepossession() public {
        (uint256 kitId, uint256 planId) = _listAndAccept();
        vm.warp(payg.getPlan(planId).paidUntil + 31 days);
        vm.prank(installer);
        payg.repossess(planId);
        vm.prank(installer);
        uint256 plan2 = payg.relistKit(kitId, relative, _terms(false));
        assertEq(payg.ownerOf(kitId), address(payg));
        vm.prank(relative);
        payg.acceptPlan(plan2);
        assertTrue(payg.isKitActive(kitId));
    }

    function test_relist_refusedWhileActive() public {
        (uint256 kitId,) = _listAndAccept();
        vm.prank(installer);
        vm.expectRevert(ImolePAYG.NotYourKit.selector); // kit sits in escrow, not with the installer
        payg.relistKit(kitId, relative, _terms(false));
    }

    function test_cancel_onlyBeforeAcceptance() public {
        (uint256 kitId, uint256 planId) = _list(false);
        vm.prank(installer);
        payg.cancelPlan(planId);
        assertEq(payg.ownerOf(kitId), installer);

        (, uint256 planId2) = _listAndAccept();
        vm.prank(installer);
        vm.expectRevert(abi.encodeWithSelector(ImolePAYG.WrongStatus.selector, ImolePAYG.Status.Active));
        payg.cancelPlan(planId2);
    }

    // ------------------------------------------------------------------ paying in QIE

    function test_payWithQIE_swapsAndCredits() public {
        (, uint256 planId) = _listAndAccept();
        uint256 balBefore = qusdc.balanceOf(installer);
        vm.prank(customer);
        payg.payWithQIE{value: 100 ether}(planId, 0, block.timestamp + 300); // 100 QIE ≈ 15 QUSDC
        ImolePAYG.Plan memory p = payg.getPlan(planId);
        assertEq(p.totalPaid, DEPOSIT + 15e6);
        assertEq(qusdc.balanceOf(installer) - balBefore, 15e6 - 15e6 / 100);
        assertEq(qusdc.balanceOf(address(payg)), 0);
    }

    function test_payWithQIE_refundsOverpayment() public {
        (uint256 kitId, uint256 planId) = _listAndAccept();
        vm.prank(customer);
        payg.payWithQIE{value: 5_000 ether}(planId, 0, block.timestamp + 300); // ≈ 750 QUSDC, 360 needed
        assertEq(payg.ownerOf(kitId), customer);
        assertEq(qusdc.balanceOf(customer), 1_000e6 - DEPOSIT + (750e6 - (PRICE - DEPOSIT)));
    }

    function test_payWithQIE_rejectsPoolPriceFarBelowOracle() public {
        (, uint256 planId) = _listAndAccept();
        router.setRate(100_000); // pool pays $0.10 while oracle says $0.15
        vm.prank(customer);
        vm.expectRevert("INSUFFICIENT_OUTPUT_AMOUNT"); // floor passed to the router as amountOutMin
        payg.payWithQIE{value: 100 ether}(planId, 0, block.timestamp + 300);
    }

    function test_payWithQIE_rejectsStaleOracle() public {
        (, uint256 planId) = _listAndAccept();
        feed.set(15_000_000, block.timestamp - 2 days);
        vm.prank(customer);
        vm.expectRevert(ImolePAYG.StaleOracle.selector);
        payg.payWithQIE{value: 100 ether}(planId, 0, block.timestamp + 300);
    }

    // ------------------------------------------------------------------ admin + metadata

    function test_fee_capped() public {
        vm.prank(owner);
        vm.expectRevert(ImolePAYG.FeeTooHigh.selector);
        payg.setFee(501);
    }

    function test_tokenURI_reflectsState() public {
        (uint256 kitId, uint256 planId) = _listAndAccept();
        string memory uri = payg.tokenURI(kitId);
        assertGt(bytes(uri).length, 100);
        vm.prank(customer);
        payg.pay(planId, PRICE);
        assertTrue(keccak256(bytes(payg.tokenURI(kitId))) != keccak256(bytes(uri)));
    }

    function test_kyc_onlyAttester() public {
        vm.prank(relative);
        vm.expectRevert(ImoleKYC.NotAttester.selector);
        kyc.attest(relative, ImoleKYC.Source.InPerson, bytes32(0));
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_paymentsNeverExceedPrice(uint96 a, uint96 b, uint96 c) public {
        (, uint256 planId) = _listAndAccept();
        uint256[3] memory amts = [uint256(a) % 500e6 + 1, uint256(b) % 500e6 + 1, uint256(c) % 500e6 + 1];
        for (uint256 i; i < 3; i++) {
            if (payg.getPlan(planId).status != ImolePAYG.Status.Active) break;
            vm.prank(customer);
            payg.pay(planId, amts[i]);
        }
        assertLe(payg.getPlan(planId).totalPaid, PRICE);
        assertEq(qusdc.balanceOf(address(payg)), 0);
    }
}
