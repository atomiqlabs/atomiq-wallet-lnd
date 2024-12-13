import * as bitcoin from "bitcoinjs-lib";
import * as tinySecpk256Interface from "@bitcoinerlab/secp256k1";
bitcoin.initEccLib(tinySecpk256Interface);

export * from "./lnd/LNDClient";
export * from "./lnd/LNDBitcoinWallet";
export * from "./lnd/LNDLightningWallet";
export * from "./fees/OneDollarFeeEstimator";
