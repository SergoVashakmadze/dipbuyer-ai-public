// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DecisionRegistry} from "../contracts/DecisionRegistry.sol";

/// Minimal slice of the Foundry cheatcode interface, so the suite needs no forge-std checkout.
interface Vm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes calldata) external;
    function expectRevert() external;
    function expectEmit(bool, bool, bool, bool) external;
}

contract DecisionRegistryTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    DecisionRegistry internal reg;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    bytes32 internal constant CONFIG = keccak256("strategy.lynch.json@v0.4.0");

    event BatchAnchored(
        bytes32 indexed root, bytes32 indexed configHash, uint32 decisionCount, address indexed anchoredBy, uint64 anchoredAt
    );

    function setUp() public {
        reg = new DecisionRegistry();
    }

    // ---- reference Merkle implementation, written independently of the contract ----------------
    // Same rules as OpenZeppelin MerkleProof: double-hashed leaves, sorted pairs, odd node promoted.

    function _leaf(bytes32 d) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(bytes.concat(d))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(bytes.concat(a, b)) : keccak256(bytes.concat(b, a));
    }

    function _decisions(uint256 n, uint256 seed) internal pure returns (bytes32[] memory d) {
        d = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) d[i] = keccak256(abi.encode(seed, i));
    }

    /// Returns the root and a proof for every leaf.
    function _tree(bytes32[] memory decisions) internal pure returns (bytes32 root, bytes32[][] memory proofs) {
        uint256 n = decisions.length;
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) level[i] = _leaf(decisions[i]);

        proofs = new bytes32[][](n);
        for (uint256 i = 0; i < n; i++) proofs[i] = new bytes32[](0);
        // position[i] = index of leaf i's ancestor at the current level
        uint256[] memory position = new uint256[](n);
        for (uint256 i = 0; i < n; i++) position[i] = i;

        while (level.length > 1) {
            uint256 next = (level.length + 1) / 2;
            bytes32[] memory up = new bytes32[](next);
            for (uint256 i = 0; i < level.length; i += 2) {
                up[i / 2] = i + 1 < level.length ? _pair(level[i], level[i + 1]) : level[i];
            }
            for (uint256 leafIdx = 0; leafIdx < n; leafIdx++) {
                uint256 p = position[leafIdx];
                uint256 sib = p % 2 == 0 ? p + 1 : p - 1;
                if (sib < level.length) proofs[leafIdx] = _append(proofs[leafIdx], level[sib]);
                position[leafIdx] = p / 2;
            }
            level = up;
        }
        root = level[0];
    }

    function _append(bytes32[] memory a, bytes32 x) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](a.length + 1);
        for (uint256 i = 0; i < a.length; i++) out[i] = a[i];
        out[a.length] = x;
    }

    // ---- deployment ---------------------------------------------------------------------------

    function test_deployerIsOwnerAndAnchorer() public view {
        require(reg.owner() == address(this), "owner");
        require(reg.anchorers(address(this)), "anchorer");
        require(!reg.anchorers(ALICE), "stranger is not an anchorer");
    }

    // ---- anchoring ----------------------------------------------------------------------------

    function test_anchorStoresBatchAndEmits() public {
        bytes32 root = keccak256("root");
        vm.warp(1_760_000_000);
        vm.expectEmit(true, true, true, true);
        emit BatchAnchored(root, CONFIG, 500, address(this), 1_760_000_000);
        reg.anchorBatch(root, CONFIG, 500);

        (bytes32 cfg, uint64 anchoredAt, uint32 count, address by) = reg.batches(root);
        require(cfg == CONFIG && anchoredAt == 1_760_000_000 && count == 500 && by == address(this), "stored");
        require(reg.isAnchored(root), "isAnchored");
        require(!reg.isAnchored(keccak256("other")), "other root not anchored");
    }

    function test_onlyAnchorersMayAnchor() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DecisionRegistry.NotAnchorer.selector));
        reg.anchorBatch(keccak256("r"), CONFIG, 1);
    }

    function test_rejectsZeroRootAndEmptyBatch() public {
        vm.expectRevert(abi.encodeWithSelector(DecisionRegistry.ZeroRoot.selector));
        reg.anchorBatch(bytes32(0), CONFIG, 1);
        vm.expectRevert(abi.encodeWithSelector(DecisionRegistry.EmptyBatch.selector));
        reg.anchorBatch(keccak256("r"), CONFIG, 0);
    }

    function test_reanchoringIsRejectedAndFirstTimestampStands() public {
        bytes32 root = keccak256("root");
        vm.warp(1000);
        reg.anchorBatch(root, CONFIG, 10);
        vm.warp(9999);
        vm.expectRevert(abi.encodeWithSelector(DecisionRegistry.AlreadyAnchored.selector, root));
        reg.anchorBatch(root, keccak256("different config"), 99);

        (bytes32 cfg, uint64 anchoredAt, uint32 count,) = reg.batches(root);
        require(anchoredAt == 1000 && cfg == CONFIG && count == 10, "first anchor stands");
    }

    // ---- access control -----------------------------------------------------------------------

    function test_ownerManagesAnchorers() public {
        reg.setAnchorer(ALICE, true);
        vm.prank(ALICE);
        reg.anchorBatch(keccak256("a"), CONFIG, 1);

        reg.setAnchorer(ALICE, false);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DecisionRegistry.NotAnchorer.selector));
        reg.anchorBatch(keccak256("b"), CONFIG, 1);
    }

    function test_nonOwnerCannotChangeAnchorersOrOwner() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DecisionRegistry.NotOwner.selector));
        reg.setAnchorer(ALICE, true);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(DecisionRegistry.NotOwner.selector));
        reg.transferOwnership(ALICE);
    }

    function test_zeroAddressRejected() public {
        vm.expectRevert(abi.encodeWithSelector(DecisionRegistry.ZeroAddress.selector));
        reg.setAnchorer(address(0), true);
        vm.expectRevert(abi.encodeWithSelector(DecisionRegistry.ZeroAddress.selector));
        reg.transferOwnership(address(0));
    }

    function test_transferOwnershipHandsOverControl() public {
        reg.transferOwnership(BOB);
        require(reg.owner() == BOB, "new owner");
        vm.expectRevert(abi.encodeWithSelector(DecisionRegistry.NotOwner.selector));
        reg.setAnchorer(ALICE, true); // the old owner is locked out
        vm.prank(BOB);
        reg.setAnchorer(ALICE, true);
        require(reg.anchorers(ALICE), "new owner can act");
    }

    // ---- verification -------------------------------------------------------------------------

    function test_unanchoredRootVerifiesFalseRatherThanReverting() public view {
        bytes32[] memory none = new bytes32[](0);
        require(!reg.verifyDecision(keccak256("never anchored"), keccak256("d"), none), "false");
    }

    function test_singleDecisionBatchHasAnEmptyProof() public {
        bytes32 d = keccak256("only decision");
        reg.anchorBatch(_leaf(d), CONFIG, 1);
        require(reg.verifyDecision(_leaf(d), d, new bytes32[](0)), "single leaf");
        require(!reg.verifyDecision(_leaf(d), keccak256("other"), new bytes32[](0)), "other decision");
    }

    /// Every decision in a batch of any size verifies; nothing else does.
    function testFuzz_everyLeafVerifiesAndNothingElseDoes(uint8 size, uint256 seed) public {
        uint256 n = (uint256(size) % 64) + 1;
        bytes32[] memory decisions = _decisions(n, seed);
        (bytes32 root, bytes32[][] memory proofs) = _tree(decisions);
        reg.anchorBatch(root, CONFIG, uint32(n));

        for (uint256 i = 0; i < n; i++) {
            require(reg.verifyDecision(root, decisions[i], proofs[i]), "member verifies");
            // an altered decision with the genuine proof is refused
            require(!reg.verifyDecision(root, keccak256(abi.encode(decisions[i], "altered")), proofs[i]), "altered");
            // a genuine decision with someone else's proof is refused
            if (n > 1) {
                uint256 j = (i + 1) % n;
                if (keccak256(abi.encode(proofs[j])) != keccak256(abi.encode(proofs[i]))) {
                    require(!reg.verifyDecision(root, decisions[i], proofs[j]), "wrong proof");
                }
            }
        }
    }

    /// An internal tree node must not be passable as a decision (second-preimage resistance).
    function testFuzz_internalNodeIsNotAValidLeaf(uint8 size, uint256 seed) public {
        uint256 n = (uint256(size) % 62) + 3; // at least 3 leaves, so there is a real internal node
        bytes32[] memory decisions = _decisions(n, seed);
        (bytes32 root,) = _tree(decisions);
        reg.anchorBatch(root, CONFIG, uint32(n));

        bytes32 internalNode = _pair(_leaf(decisions[0]), _leaf(decisions[1]));
        bytes32[] memory proofForNode = new bytes32[](0);
        require(!reg.verifyDecision(root, internalNode, proofForNode), "internal node as decision");
        require(!reg.verifyDecision(root, root, proofForNode), "root as decision");
    }

    function testFuzz_truncatedOrExtendedProofIsRefused(uint8 size, uint256 seed) public {
        uint256 n = (uint256(size) % 62) + 3;
        bytes32[] memory decisions = _decisions(n, seed);
        (bytes32 root, bytes32[][] memory proofs) = _tree(decisions);
        reg.anchorBatch(root, CONFIG, uint32(n));

        bytes32[] memory p = proofs[0];
        require(p.length > 0, "proof exists");
        bytes32[] memory shorter = new bytes32[](p.length - 1);
        for (uint256 i = 0; i < shorter.length; i++) shorter[i] = p[i];
        require(!reg.verifyDecision(root, decisions[0], shorter), "truncated");
        require(!reg.verifyDecision(root, decisions[0], _append(p, keccak256("extra"))), "extended");
    }

    // ---- the real anchored batch --------------------------------------------------------------

    /// A real decision from the v0.4.0 backtest (53,384 decisions), its proof produced by the
    /// TypeScript builder, checked by this contract against the root that is on Monad testnet.
    /// If the TypeScript and Solidity encodings ever drift, this fails.
    function test_realAnchoredDecisionVerifiesAgainstTheLiveRoot() public {
        bytes32 root = 0x9b361f4620dda3d51aa6c3806928e52a981970c0740594bde912d8e5f3e6e911;
        bytes32 decisionHash = 0x551ff3d9c3ea85d0c23e3bffee4e9115c82fb9079ea99ba75dee1aae2f7b8990;
        bytes32[] memory proof = new bytes32[](16);
        proof[0] = 0xce9ea2e039ec04e3db9b1da652872eedce6f28f74ee1c69bd4fcf325105166ce;
        proof[1] = 0x2f43e8fe41d44f912bd5a57a2c1f813bc2eb8bce5b26c52bb14deda43f88be50;
        proof[2] = 0x9c065751b29248cb84b035eca9f2c9ecf1438d86c919a519a665fc62a937bfb0;
        proof[3] = 0x5b03c5151a1e771b15ed3c6d335e864b313f0c706adebee4331e6d8acead118a;
        proof[4] = 0x01033b0bf905233b379905db2c22f4ec452e64fb13b49f874090fb21922b9057;
        proof[5] = 0xdac2bec4ca121ca28060cec6940d370c23b17ce181c66984d337368698efa38f;
        proof[6] = 0x117cd192e041761e58f239da43efe465a1b5ab0514df1664d9bd038031404e49;
        proof[7] = 0x2a686255055c7e9d26050df87e85e630598630e7bb78526bd37c9a3934d97d22;
        proof[8] = 0x1ea36a6e391b4ab207c8cdecec5e9fbbd310f14c0137a5ced371d0c84541c36c;
        proof[9] = 0x5e4fc61836c9b421795386079ed6567dd1fc060c5ccf3d73041dc061c20e1b66;
        proof[10] = 0xedfb94b5405270b1b612a046db93305f1528a25e4d2f5735ee9c92464d305c9d;
        proof[11] = 0xa5286be5721b7264e538bd0032abc4c219e4eaa30783e963c28d1970e0f802b2;
        proof[12] = 0xe6dbe1c8aa55fe7c94496b54c4def5520c566c04cdf3f1318ec6c00b55fed5d8;
        proof[13] = 0xff4e0f59cefab1c518eb82da6b0ac76f2ffb73aed94b3975408bf39a70d8949c;
        proof[14] = 0xff7664e4de757501910f120a478f71a4ccc78d0c24438804e9b99c9cd458e0da;
        proof[15] = 0xc9f34994de843ae6dc7589cbfec4b6f7be501660da241b6a855e67a9ec2f5785;
        reg.anchorBatch(root, CONFIG, 53_384);
        require(reg.verifyDecision(root, decisionHash, proof), "real decision verifies");
        require(!reg.verifyDecision(root, keccak256("a decision that was never made"), proof), "forgery refused");
    }
}
