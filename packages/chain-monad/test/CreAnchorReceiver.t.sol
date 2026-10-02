// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DecisionRegistry} from "../contracts/DecisionRegistry.sol";
import {CreAnchorReceiver} from "../contracts/CreAnchorReceiver.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function expectRevert() external;
}

contract CreAnchorReceiverTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    DecisionRegistry internal reg;
    CreAnchorReceiver internal rx;
    address internal constant FORWARDER = address(0xF0);
    address internal constant WF_OWNER = address(0xAB1E);
    bytes32 internal constant ROOT = keccak256("root");
    bytes32 internal constant CONFIG = keccak256("config");

    function setUp() public {
        reg = new DecisionRegistry();
        rx = new CreAnchorReceiver(address(reg), FORWARDER, WF_OWNER);
        reg.setAnchorer(address(rx), true);
    }

    function _meta(address wfOwner) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), bytes10("dipbuyer"), wfOwner, bytes2(0));
    }

    function _report(bytes32 root, uint32 n) internal pure returns (bytes memory) {
        return abi.encode(root, CONFIG, n);
    }

    function test_forwarderReportAnchorsBatch() public {
        vm.prank(FORWARDER);
        rx.onReport(_meta(WF_OWNER), _report(ROOT, 7));
        require(reg.isAnchored(ROOT), "not anchored");
        (bytes32 cfg,, uint32 count, address by) = reg.batches(ROOT);
        require(cfg == CONFIG && count == 7 && by == address(rx), "bad batch");
    }

    function test_rejectsOtherCallers() public {
        vm.expectRevert(abi.encodeWithSelector(CreAnchorReceiver.NotForwarder.selector));
        rx.onReport(_meta(WF_OWNER), _report(ROOT, 7));
    }

    function test_rejectsWrongWorkflowOwner() public {
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(CreAnchorReceiver.WrongWorkflowOwner.selector, address(0xBAD)));
        rx.onReport(_meta(address(0xBAD)), _report(ROOT, 7));
    }

    function test_anyOwnerAllowedWhenUnset() public {
        rx.setWorkflowOwner(address(0));
        vm.prank(FORWARDER);
        rx.onReport(_meta(address(0xBAD)), _report(ROOT, 7));
        require(reg.isAnchored(ROOT), "not anchored");
    }

    function test_rejectsShortMetadata() public {
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(CreAnchorReceiver.BadMetadata.selector));
        rx.onReport(hex"01", _report(ROOT, 7));
    }

    function test_registryRejectsDuplicateRoot() public {
        vm.prank(FORWARDER);
        rx.onReport(_meta(WF_OWNER), _report(ROOT, 7));
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(DecisionRegistry.AlreadyAnchored.selector, ROOT));
        rx.onReport(_meta(WF_OWNER), _report(ROOT, 7));
    }

    function test_onlyOwnerCanReconfigure() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(CreAnchorReceiver.NotOwner.selector));
        rx.setForwarder(address(1));
    }

    function test_supportsInterface() public view {
        require(rx.supportsInterface(0x805f2132), "IReceiver");
        require(rx.supportsInterface(0x01ffc9a7), "ERC165");
        require(!rx.supportsInterface(0xffffffff), "bogus");
    }
}
