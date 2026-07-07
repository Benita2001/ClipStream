// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Per-campaign USDC escrow for ClipStream. USDC is Arc's native gas
/// currency, not an ERC20 token — organizers fund a campaign by sending
/// native value with the transaction itself, and this contract tracks each
/// campaign's remaining balance in its own storage (there is no external
/// token contract to query). An authorized off-chain Settlement Agent
/// releases nanopayments to clippers as view events are validated.
contract CampaignEscrow is ReentrancyGuard {
    struct Campaign {
        address organizer;
        address authorizedAgent;
        uint256 baseRate; // reference rate, informational — payout math lives off-chain
        uint256 maxDuration; // seconds from creation after which the organizer may reclaim unspent funds
        uint256 balance; // funds remaining in escrow
        uint256 createdAt;
        bool closed;
    }

    uint256 public campaignCount;

    mapping(uint256 => Campaign) public campaigns;

    /// @dev Tracks every settlementId ever released, across all campaigns.
    /// A retried settlement request (e.g. the Settlement Agent's HTTP call times out
    /// and it retries) must never be able to pay a clipper twice for the same watch
    /// window — checking this mapping before every release is what guarantees that.
    mapping(bytes32 => bool) public usedSettlementIds;

    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed organizer,
        address indexed authorizedAgent,
        uint256 baseRate,
        uint256 maxDuration,
        uint256 initialDeposit
    );
    event CampaignFunded(uint256 indexed campaignId, address indexed organizer, uint256 amount, uint256 newBalance);
    event PayoutReleased(
        uint256 indexed campaignId, address indexed clipper, uint256 amount, bytes32 indexed settlementId
    );
    event CampaignClosed(uint256 indexed campaignId, address indexed organizer, uint256 amountReturned);

    error NotOrganizer();
    error NotAuthorizedAgent();
    error CampaignDoesNotExist();
    error CampaignAlreadyClosed();
    error InsufficientCampaignBalance();
    error SettlementAlreadyUsed(bytes32 settlementId);
    error MaxDurationNotElapsed();
    error ZeroAddress();
    error ZeroAmount();
    error NativeTransferFailed();

    modifier onlyAuthorizedAgent(uint256 campaignId) {
        if (msg.sender != campaigns[campaignId].authorizedAgent) revert NotAuthorizedAgent();
        _;
    }

    modifier campaignExists(uint256 campaignId) {
        if (campaigns[campaignId].organizer == address(0)) revert CampaignDoesNotExist();
        _;
    }

    /// @notice Creates a campaign and funds it in the same transaction with native
    /// value (msg.value).
    /// @dev We require the initial deposit here (rather than a separate `fund()` call
    /// after creation) so a campaign can never exist in a state where it's authorized
    /// to release funds but has none — organizer and agent both see one atomic action.
    /// Subsequent top-ups use `topUp`.
    function createCampaign(uint256 baseRate, uint256 maxDuration, address authorizedAgent)
        external
        payable
        returns (uint256 campaignId)
    {
        if (authorizedAgent == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();

        campaignId = campaignCount++;

        campaigns[campaignId] = Campaign({
            organizer: msg.sender,
            authorizedAgent: authorizedAgent,
            baseRate: baseRate,
            maxDuration: maxDuration,
            balance: msg.value,
            createdAt: block.timestamp,
            closed: false
        });

        emit CampaignCreated(campaignId, msg.sender, authorizedAgent, baseRate, maxDuration, msg.value);
    }

    /// @notice Adds more USDC (native value) to an existing, still-open campaign.
    function topUp(uint256 campaignId) external payable campaignExists(campaignId) {
        Campaign storage campaign = campaigns[campaignId];
        if (campaign.closed) revert CampaignAlreadyClosed();
        if (msg.value == 0) revert ZeroAmount();

        campaign.balance += msg.value;

        emit CampaignFunded(campaignId, msg.sender, msg.value, campaign.balance);
    }

    /// @notice Releases a nanopayment to a clipper. Callable only by the campaign's
    /// authorized Settlement Agent.
    /// @param settlementId Unique id for the off-chain settlement decision (e.g. a UUID
    /// hashed to bytes32) being paid out. Must not have been used before, on this or
    /// any other campaign — this is the idempotency guarantee that makes `release`
    /// safe to retry from the agent's side without risking a double-pay.
    function release(uint256 campaignId, address clipper, uint256 amount, bytes32 settlementId)
        external
        nonReentrant
        campaignExists(campaignId)
        onlyAuthorizedAgent(campaignId)
    {
        if (clipper == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (usedSettlementIds[settlementId]) revert SettlementAlreadyUsed(settlementId);

        Campaign storage campaign = campaigns[campaignId];
        if (campaign.closed) revert CampaignAlreadyClosed();
        if (campaign.balance < amount) revert InsufficientCampaignBalance();

        usedSettlementIds[settlementId] = true;
        campaign.balance -= amount;

        // Low-level call, not .transfer()/.send(): those forward a fixed 2300 gas
        // stipend that can break on smart-contract wallets or Circle-managed
        // wallets on the receiving end. nonReentrant above is what keeps this safe
        // despite the recipient controlling arbitrary code on receipt — it matters
        // more here than it did with a SafeERC20 transfer.
        (bool success,) = clipper.call{value: amount}("");
        if (!success) revert NativeTransferFailed();

        emit PayoutReleased(campaignId, clipper, amount, settlementId);
    }

    /// @notice Lets the organizer reclaim unspent escrow once `maxDuration` has elapsed
    /// since campaign creation. Closes the campaign permanently.
    function withdrawRemaining(uint256 campaignId) external nonReentrant campaignExists(campaignId) {
        Campaign storage campaign = campaigns[campaignId];
        if (msg.sender != campaign.organizer) revert NotOrganizer();
        if (campaign.closed) revert CampaignAlreadyClosed();
        if (block.timestamp < campaign.createdAt + campaign.maxDuration) revert MaxDurationNotElapsed();

        uint256 remaining = campaign.balance;
        campaign.balance = 0;
        campaign.closed = true;

        if (remaining > 0) {
            (bool success,) = campaign.organizer.call{value: remaining}("");
            if (!success) revert NativeTransferFailed();
        }

        emit CampaignClosed(campaignId, campaign.organizer, remaining);
    }

    function getCampaignBalance(uint256 campaignId) external view campaignExists(campaignId) returns (uint256) {
        return campaigns[campaignId].balance;
    }

    function getCampaignDetails(uint256 campaignId)
        external
        view
        campaignExists(campaignId)
        returns (
            address organizer,
            address authorizedAgent,
            uint256 baseRate,
            uint256 maxDuration,
            uint256 balance,
            uint256 createdAt,
            bool closed
        )
    {
        Campaign storage campaign = campaigns[campaignId];
        return (
            campaign.organizer,
            campaign.authorizedAgent,
            campaign.baseRate,
            campaign.maxDuration,
            campaign.balance,
            campaign.createdAt,
            campaign.closed
        );
    }
}
