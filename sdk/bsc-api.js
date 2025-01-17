const Eth = require("web3-eth");
const Etherscan = require("./lib/etherscan");
const Bottleneck = require("bottleneck");
const BEP20 = require("./abis/bep20.json");
const tokenList = require("./data/bscTokenLists.json");
const { getBalance, getBalances, getLogs, singleCall, multiCall } = require("./lib/web3");
const debug = require("debug")("open-tvl:bsc-api");
const { applyDecimals } = require("./lib/big-number");

if (!process.env.BSC_RPC_URL) {
  throw new Error(`Please set environment variable BSC_RPC_URL`);
}

if (!process.env.BSC_SCAN_KEY) {
  throw new Error(`Please set environment variable BSC_SCAN_KEY`);
}

const BSC_RPC_URL = process.env.BSC_RPC_URL;
const BSC_SCAN_KEY = process.env.BSC_SCAN_KEY;

const BSC_WEB3 = new Eth(BSC_RPC_URL);
const BSC_SCAN = new Etherscan(BSC_SCAN_KEY, "https://api.bscscan.com/api");
const BSC_LIMITER = new Bottleneck({ maxConcurrent: 10, minTime: 50 });
const BSC_MULTICALL_PROVIDER = "0xe7144e57d832c9005D252f415d205b4b8D78228e";

const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";
const NATIVE_TOKEN_SYMBOL = "BNB";
const NATIVE_TOKEN_DECIMALS = 18;

function mapStringToABI(abiString) {
  let abi;
  switch (abiString) {
    case "bep20:symbol": {
      abi = BEP20.filter(t => t.name === "symbol")[0];
      break;
    }
    case "bep20:decimals": {
      abi = BEP20.filter(t => t.name === "decimals")[0];
      break;
    }
    case "bep20:balanceOf": {
      abi = BEP20.filter(t => t.name === "balanceOf")[0];
      break;
    }
    case "bep20:totalSupply": {
      abi = BEP20.filter(t => t.name === "totalSupply")[0];
      break;
    }
    default:
      throw new Error("Unknown string ABI");
  }
  return abi;
}

async function bep20(method, target, params = []) {
  const abi = BEP20.find(item => item.type === "function" && item.name === method);

  return singleCall({
    web3: BSC_WEB3,
    limiter: BSC_LIMITER,
    target,
    abi,
    params
  });
}

async function abiCall({ target, abi, block, params }) {
  if (typeof abi === "string") {
    abi = mapStringToABI(abi);
  }
  debug("bsc.abi.call", { target, abi, block, params });

  return singleCall({ web3: BSC_WEB3, limiter: BSC_LIMITER, target, abi, block, params });
}

async function abiMultiCall({ target, abi, block, calls }) {
  if (typeof abi === "string") {
    abi = mapStringToABI(abi);
  }
  debug("bsc.abi.multiCall", { target, abi, block, calls });

  return multiCall({
    web3: BSC_WEB3,
    limiter: BSC_LIMITER,
    multiCallProvider: BSC_MULTICALL_PROVIDER,
    target,
    abi,
    block,
    calls
  });
}

async function utilGetLogs({ target, topic, keys, fromBlock, toBlock }) {
  debug("bsc.util.getLogs", { target, topic, fromBlock, toBlock });

  return getLogs({
    web3: BSC_WEB3,
    scan: BSC_SCAN,
    limiter: BSC_LIMITER,
    target,
    topic,
    keys,
    fromBlock,
    toBlock
  });
}

async function utilTokenList() {
  debug("bsc.util.tokenList");

  return tokenList;
}

async function utilToSymbols(addressesBalances) {
  debug("bsc.util.toSymbols", addressesBalances);

  const normalAddresses = Object.keys(addressesBalances).filter(addr => addr !== NATIVE_TOKEN_ADDRESS);

  const symbolsRequests = await abiMultiCall({
    abi: "bep20:symbol",
    calls: normalAddresses.map(t => {
      return { target: t };
    })
  });
  const symbolsByAddresses = symbolsRequests.output.reduce(
    (acc, t) => {
      acc[t.input.target] = t.output;
      return acc;
    },
    {
      [NATIVE_TOKEN_ADDRESS]: NATIVE_TOKEN_SYMBOL
    }
  );

  const decimalsRequests = await abiMultiCall({
    abi: "bep20:decimals",
    calls: normalAddresses.map(t => {
      return { target: t };
    })
  });
  const decimalsByAddresses = decimalsRequests.output.reduce(
    (acc, t) => {
      acc[t.input.target] = t.output;
      return acc;
    },
    {
      [NATIVE_TOKEN_ADDRESS]: NATIVE_TOKEN_DECIMALS
    }
  );

  const output = Object.keys(addressesBalances).reduce((acc, addr) => {
    acc[symbolsByAddresses[addr]] = applyDecimals(addressesBalances[addr], decimalsByAddresses[addr]);

    return acc;
  }, {});

  return {
    callCount: symbolsRequests.callCount + decimalsRequests.callCount,
    output
  };
}

async function bnbGetBalance({ target, block, decimals }) {
  debug("bsc.bnb.getBalance", { target, block, decimals });

  let { callCount, output } = await getBalance({
    web3: BSC_WEB3,
    limiter: BSC_LIMITER,
    target,
    block
  });

  if (decimals) {
    output = applyDecimals(output, decimals);
  }

  return { callCount, output };
}

async function bnbGetBalances({ targets, block, decimals }) {
  debug("bsc.bnb.getBalances", { targets, block, decimals });

  let { callCount, output } = await getBalances({
    web3: BSC_WEB3,
    limiter: BSC_LIMITER,
    targets,
    block
  });

  if (decimals) {
    output = applyDecimals(output, decimals);
  }

  return { callCount, output };
}

async function bep20Info(target) {
  debug("bsc.bep20.info", { target });

  const { callCount: symbolCallCount, output: symbol } = await bep20("symbol", target);
  const { callCount: decimalsCallCount, output: decimals } = await bep20("decimals", target);

  return {
    callCount: symbolCallCount + decimalsCallCount,
    output: {
      symbol,
      decimals: parseInt(decimals)
    }
  };
}

async function bep20Symbol(target) {
  debug("bsc.bep20.symbol", { target });

  return bep20("symbol", target);
}

async function bep20Decimals(target) {
  debug("bsc.bep20.decimals", { target });

  const { callCount: decimalsCallCount, output: decimals } = await bep20("decimals", target);
  return {
    callCount: decimalsCallCount,
    output: parseInt(decimals)
  };
}

async function bep20TotalSupply({ target, block, decimals }) {
  debug("bsc.bep20.totalSupply", { target, block, decimals });

  let { callCount, output } = await bep20("totalSupply", target);

  if (decimals) {
    output = applyDecimals(output, decimals);
  }

  return { callCount, output };
}

async function bep20BalanceOf({ target, owner, block, decimals }) {
  debug("bsc.bep20.balanceOf", { target, owner, block, decimals });

  let { callCount, output } = await bep20("balanceOf", target, [owner]);

  if (decimals) {
    output = applyDecimals(output, decimals);
  }

  return { callCount, output };
}

module.exports = {
  abi: {
    call: abiCall,
    multiCall: abiMultiCall
  },
  util: {
    getLogs: utilGetLogs,
    tokenList: utilTokenList,
    toSymbols: utilToSymbols
  },
  bnb: {
    getBalance: bnbGetBalance,
    getBalances: bnbGetBalances
  },
  bep20: {
    info: bep20Info,
    symbol: bep20Symbol,
    decimals: bep20Decimals,
    totalSupply: bep20TotalSupply,
    balanceOf: bep20BalanceOf
  }
};
