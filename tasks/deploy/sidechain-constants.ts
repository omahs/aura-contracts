import { chainIds } from "../../hardhat.config";
import { config as goerliConfig } from "./goerli-config";
import { config as arbitrumGoerliConfig } from "./arbitrumGoerli-config";
import { config as goerliSidechainConfig } from "./goerliSidechain-config";
import { SidechainNaming } from "../../types/sidechain-types";

export const sideChains = [
    chainIds.arbitrum,
    chainIds.arbitrumGoerli,
    chainIds.polygon,
    // Goerli is just use as a sidechain for testing
    chainIds.goerli,
];

export const canonicalChains = [chainIds.goerli, chainIds.mainnet];

export const remoteChainMap = {
    [chainIds.goerli]: chainIds.arbitrumGoerli,
    [chainIds.arbitrum]: chainIds.mainnet,
    [chainIds.arbitrumGoerli]: chainIds.goerli,
    [chainIds.polygon]: chainIds.mainnet,
};

export const lzChainIds = {
    [chainIds.mainnet]: 101,
    [chainIds.arbitrum]: 110,
    [chainIds.goerli]: 10121,
    [chainIds.arbitrumGoerli]: 10143,
};

export const canonicalConfigs = {
    [chainIds.goerli]: goerliConfig,
};

export const sidechainConfigs = {
    [chainIds.goerli]: goerliSidechainConfig,
    [chainIds.arbitrumGoerli]: arbitrumGoerliConfig,
};

export const sidechainNaming: SidechainNaming = {
    coordinatorName: "Aura",
    coordinatorSymbol: "AURA",
    tokenFactoryNamePostfix: " Aura Deposit",
};
