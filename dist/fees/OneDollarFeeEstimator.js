"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OneDollarFeeEstimator = void 0;
const Utils_1 = require("../utils/Utils");
const dynamicImport = new Function('specifier', 'return import(specifier)');
const importPromise = dynamicImport('one-dollar-fee-estimator-failover');
const logger = (0, Utils_1.getLogger)("OneDollarFeeEstimator: ");
class OneDollarFeeEstimator {
    startFeeEstimator() {
        logger.info("startFeeEstimator(): starting fee estimator worker");
        importPromise.then(({ FeeEstimator }) => {
            this.estimator = new FeeEstimator({
                mode: 'bundles',
                refresh: 30,
                rpcOptions: {
                    host: this.host,
                    port: this.port,
                    username: this.username,
                    password: this.password
                }
            });
            this.estimator.on('error', (err) => {
                logger.error("on(error): fee estimator error", err);
                if (err.message.startsWith("FeeEstimator worker stopped")) {
                    logger.info("on(error): restarting fee estimator worker");
                    this.receivedFee = null;
                    this.iterations = 0;
                    this.startFeeEstimator();
                }
            });
            // receive live fee rate updates from the FeeEstimator
            this.estimator.on('fees', (fees) => {
                this.receivedFee = fees;
                this.iterations++;
            });
        });
    }
    constructor(host, port, username, password, addFee, feeMultiplier) {
        this.iterations = 0;
        this.host = host;
        this.port = port;
        this.username = username;
        this.password = password;
        this.addFee = addFee;
        this.feeMultiplier = feeMultiplier;
        this.startFeeEstimator();
        process.on('exit', () => {
            logger.info("process(exit): process exiting, stopping estimator");
            if (this.estimator != null)
                this.estimator.stop();
        });
        process.on('SIGINT', () => {
            logger.info("process(SIGINT): process exiting, stopping estimator");
            if (this.estimator != null)
                this.estimator.stop();
            process.exit();
        });
    }
    getFee() {
        let fee = this.receivedFee[3];
        if (this.feeMultiplier != null)
            fee *= this.feeMultiplier;
        if (this.addFee != null)
            fee += this.addFee;
        return fee;
    }
    estimateFee() {
        return Promise.resolve(this.iterations <= 1 ? null : this.getFee());
    }
}
exports.OneDollarFeeEstimator = OneDollarFeeEstimator;
