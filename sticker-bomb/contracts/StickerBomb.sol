// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract TestUSDT is ERC20 {
    mapping(address => bool) public claimed;

    constructor() ERC20("Sticker Bomb Test USDT", "tUSDT") {}
    function decimals() public pure override returns (uint8) { return 6; }

    function claim() external {
        require(block.chainid == 11155111, "Sepolia only");
        require(!claimed[msg.sender], "Already claimed");
        claimed[msg.sender] = true;
        _mint(msg.sender, 2_000e6);
    }
}

contract BombRewards is ERC20 {
    address immutable issuer;
    constructor() ERC20("Sticker Bomb", "BOMB") { issuer = msg.sender; }

    function reward(address worker) external {
        require(msg.sender == issuer, "Escrow only");
        _mint(worker, 10 ether);
    }
}

contract CampaignEscrow is ERC721, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Campaign {
        address company;
        address printer;
        uint128 unitPrice;
        uint16 quantity;
        uint16 completed;
    }

    IERC20 public immutable payment;
    BombRewards public immutable rewards;
    mapping(bytes32 => Campaign) public campaigns;
    mapping(bytes32 => mapping(uint16 => bool)) public placed;
    mapping(address => uint256) public placementCount;

    event Funded(bytes32 indexed id, address indexed company, address indexed printer, uint16 quantity, uint256 total);
    event Placed(bytes32 indexed id, uint16 indexed index, address indexed worker, bytes32 proof, uint256 payout);

    constructor(IERC20 token) ERC721("Sticker Bomb Worker", "SBWORK") {
        require(block.chainid == 11155111, "Sepolia only");
        require(address(token).code.length != 0, "Token contract required");
        payment = token;
        rewards = new BombRewards();
    }

    function fund(bytes32 id, uint8 format, uint16 quantity, address printer) external nonReentrant {
        require(campaigns[id].company == address(0), "Campaign exists");
        require(quantity > 0 && quantity <= 500 && printer != address(0), "Invalid campaign");
        uint128[4] memory prices = [uint128(1e6), 2e6, 3e6, 5e5];
        require(format < prices.length, "Invalid format");
        uint128 price = prices[format];
        uint256 total = uint256(price) * quantity;
        campaigns[id] = Campaign(msg.sender, printer, price, quantity, 0);
        payment.safeTransferFrom(msg.sender, address(this), total);
        payment.safeTransfer(printer, total / 2);
        emit Funded(id, msg.sender, printer, quantity, total);
    }

    // Company assigns each placement to a worker after receiving their proof.
    function settle(bytes32 id, uint16 index, address worker, bytes32 proof) external nonReentrant {
        Campaign storage campaign = campaigns[id];
        require(msg.sender == campaign.company, "Campaign company only");
        require(index < campaign.quantity && !placed[id][index], "Invalid or paid placement");
        require(worker != address(0) && proof != bytes32(0), "Missing placement proof");
        placed[id][index] = true;
        campaign.completed++;
        if (++placementCount[worker] == 1) _mint(worker, uint256(uint160(worker)));
        rewards.reward(worker);
        uint256 payout = campaign.unitPrice / 2;
        payment.safeTransfer(worker, payout);
        emit Placed(id, index, worker, proof, payout);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        require(_ownerOf(tokenId) == address(0), "Worker profile is nontransferable");
        return super._update(to, tokenId, auth);
    }
}
