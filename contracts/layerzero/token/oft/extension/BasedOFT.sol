// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "../OFT.sol";

contract BasedOFT is OFT {
    constructor(
        string memory _name,
        string memory _symbol,
        address _lzEndpoint
    ) OFT(_name, _symbol, _lzEndpoint) {}

    function circulatingSupply() public view virtual override returns (uint256) {
        unchecked {
            return totalSupply() - balanceOf(address(this));
        }
    }

    function _debitFrom(
        address _from,
        uint16,
        bytes memory,
        uint256 _amount
    ) internal virtual override returns (uint256) {
        address spender = _msgSender();
        // TODO:
        // if (_from != spender) _spendAllowance(_from, spender, _amount);
        if (_from != spender) revert();
        _transfer(_from, address(this), _amount);
        return _amount;
    }

    function _creditTo(
        uint16,
        address _toAddress,
        uint256 _amount
    ) internal virtual override returns (uint256) {
        _transfer(address(this), _toAddress, _amount);
        return _amount;
    }
}
