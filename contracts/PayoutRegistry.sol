// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @notice Append-only on-chain log of the Settlement/Pacing Agent's payout decisions.
/// Deliberately holds no funds and enforces no business logic — `CampaignEscrow` is the
/// source of truth for money movement. This just gives anyone an independently
/// verifiable, timestamped record of *why* a payout happened (watch seconds, rationale
/// hash) next to the escrow's record of *that* it happened, without trusting our dashboard.
contract PayoutRegistry {
    /// @dev This registry is a single shared log across all campaigns (recordPayout
    /// takes campaignId as a parameter, unlike CampaignEscrow's per-campaign agent).
    /// One immutable agent for the whole deployment assumes one Settlement Agent
    /// service operates across all campaigns, which holds for this hackathon's scope.
    /// If campaigns ever need distinct agents, this assumption needs revisiting.
    address public immutable authorizedAgent;

    event PayoutRecorded(
        bytes32 indexed settlementId,
        uint256 indexed campaignId,
        address indexed clipper,
        uint256 viewDelta,
        uint256 amount,
        bytes32 agentRationaleHash
    );

    error SettlementAlreadyRecorded(bytes32 settlementId);
    error NotAuthorizedAgent();
    error ZeroAddress();

    mapping(bytes32 => bool) public recorded;

    modifier onlyAuthorizedAgent() {
        if (msg.sender != authorizedAgent) revert NotAuthorizedAgent();
        _;
    }

    constructor(address _authorizedAgent) {
        if (_authorizedAgent == address(0)) revert ZeroAddress();
        authorizedAgent = _authorizedAgent;
    }

    /// @notice Records a settlement decision. Callable only by the authorized
    /// Settlement Agent (typically right after or alongside `CampaignEscrow.release`) —
    /// this is what makes the log an independently verifiable audit trail rather than
    /// something anyone could pad with fake entries. Each settlementId may only be
    /// recorded once so the log can't be duplicated or spammed for a single real payout.
    function recordPayout(
        bytes32 settlementId,
        uint256 campaignId,
        address clipper,
        uint256 viewDelta,
        uint256 amount,
        bytes32 agentRationaleHash
    ) external onlyAuthorizedAgent {
        if (recorded[settlementId]) revert SettlementAlreadyRecorded(settlementId);
        recorded[settlementId] = true;

        emit PayoutRecorded(settlementId, campaignId, clipper, viewDelta, amount, agentRationaleHash);
    }
}
