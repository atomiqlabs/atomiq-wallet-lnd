import { IBtcFeeEstimator } from "@atomiqlabs/lp-lib";
export declare class OneDollarFeeEstimator implements IBtcFeeEstimator {
    estimator: any;
    receivedFee: [number, number, number, number];
    iterations: number;
    host: string;
    port: number;
    username: string;
    password: string;
    addFee: number;
    feeMultiplier: number;
    startFeeEstimator(): void;
    constructor(host: string, port: number, username: string, password: string, addFee?: number, feeMultiplier?: number);
    getFee(): number;
    estimateFee(): Promise<number | null>;
}
