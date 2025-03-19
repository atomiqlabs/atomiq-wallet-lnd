import { BtcTx } from "@atomiqlabs/base";
import { Transaction } from "@scure/btc-signer";
export declare function getLogger(prefix: string): {
    debug: (msg: any, ...args: any[]) => void;
    info: (msg: any, ...args: any[]) => void;
    warn: (msg: any, ...args: any[]) => void;
    error: (msg: any, ...args: any[]) => void;
};
export declare function shuffle(array: any[]): void;
/**
 * Handles & throws LND error if the error is:
 *  - network error
 *  - server side (LND) internal error
 *  - malformed input data error
 *
 * @param e
 */
export declare function handleLndError(e: any): void;
export declare function bitcoinTxToBtcTx(btcTx: Transaction): BtcTx;
