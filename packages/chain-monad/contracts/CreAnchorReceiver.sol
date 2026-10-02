// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDecisionRegistry {
    function anchorBatch(bytes32 root, bytes32 configHash, uint32 decisionCount) external;
}

/**
 * @title CreAnchorReceiver
 * @notice Lets a Chainlink CRE workflow anchor a decision batch on the DecisionRegistry.
 *
 * A CRE workflow does not call contracts directly: its signed report goes to a Chainlink forwarder,
 * which calls `onReport` on the consumer. This contract is that consumer. It must be allowlisted on
 * the registry (`setAnchorer`), so it appears as `anchoredBy` on chain.
 *
 * Trust: only the configured forwarder may call `onReport`, and, when `workflowOwner` is set, only
 * reports from workflows owned by that address are accepted (the forwarder passes the owner in the
 * metadata). Without the owner check any workflow on the network could anchor through this contract.
 * The registry still rejects a root that is already anchored, an empty batch and a zero root.
 */
contract CreAnchorReceiver {
    IDecisionRegistry public immutable registry;
    address public owner;
    /// @notice The forwarder allowed to deliver reports (the mock forwarder for simulation, the real one in production).
    address public forwarder;
    /// @notice If non-zero, the only workflow owner whose reports are accepted.
    address public workflowOwner;

    event ForwarderSet(address indexed forwarder);
    event WorkflowOwnerSet(address indexed workflowOwner);
    event ReportAnchored(bytes32 indexed root, bytes32 indexed configHash, uint32 decisionCount, address workflowOwner);

    error NotOwner();
    error NotForwarder();
    error WrongWorkflowOwner(address got);
    error BadMetadata();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address registry_, address forwarder_, address workflowOwner_) {
        registry = IDecisionRegistry(registry_);
        owner = msg.sender;
        forwarder = forwarder_;
        workflowOwner = workflowOwner_;
        emit ForwarderSet(forwarder_);
        emit WorkflowOwnerSet(workflowOwner_);
    }

    function setForwarder(address forwarder_) external onlyOwner {
        forwarder = forwarder_;
        emit ForwarderSet(forwarder_);
    }

    function setWorkflowOwner(address workflowOwner_) external onlyOwner {
        workflowOwner = workflowOwner_;
        emit WorkflowOwnerSet(workflowOwner_);
    }

    /**
     * @notice Called by the forwarder with the workflow's report.
     * @param metadata workflowId (32) | workflowName (10) | workflowOwner (20) | reportId (2).
     * @param report abi.encode(bytes32 root, bytes32 configHash, uint32 decisionCount).
     */
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert NotForwarder();
        if (metadata.length < 62) revert BadMetadata();

        address wfOwner = address(bytes20(metadata[42:62]));
        if (workflowOwner != address(0) && wfOwner != workflowOwner) revert WrongWorkflowOwner(wfOwner);

        (bytes32 root, bytes32 configHash, uint32 decisionCount) = abi.decode(report, (bytes32, bytes32, uint32));
        registry.anchorBatch(root, configHash, decisionCount);
        emit ReportAnchored(root, configHash, decisionCount, wfOwner);
    }

    /// @notice ERC-165: advertises IReceiver (onReport) and ERC-165 itself.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x805f2132 || interfaceId == 0x01ffc9a7;
    }
}
