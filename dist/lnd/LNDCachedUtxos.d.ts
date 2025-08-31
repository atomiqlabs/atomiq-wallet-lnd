import { LNDClient } from "./LNDClient";
export declare class LNDCachedUtxos {
    private readonly lndClient;
    constructor(lndClient: LNDClient);
    subscribe(): Promise<void>;
    init(): Promise<void>;
}
