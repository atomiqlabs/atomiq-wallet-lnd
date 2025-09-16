import { IBtcFeeEstimator } from "@atomiqlabs/lp-lib";
export declare enum FeeRateInclusionProbability {
    Percent50 = 0,
    Percent90 = 1,
    Percent99 = 2,
    Percent99_9 = 3
}
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
    feeRateProbabilityTarget?: FeeRateInclusionProbability;
    startFeeEstimator(): void;
    constructor(host: string, port: number, username: string, password: string, addFee?: number, feeMultiplier?: number, feeRateProbabilityTarget?: FeeRateInclusionProbability);
    getFee(): number;
    estimateFee(): Promise<number | null>;
}
