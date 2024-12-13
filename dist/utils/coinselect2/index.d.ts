import { CoinselectAddressTypes, CoinselectTxInput, CoinselectTxOutput } from "./utils";
/**
 * Runs a coinselection algorithm on given inputs, outputs and fee rate
 *
 * @param utxos Utxo pool to select additional inputs from
 * @param outputs Outputs of the transaction
 * @param feeRate Feerate in sats/vB
 * @param changeType Change address type
 * @param requiredInputs Utxos that need to be included as inputs to the transaction
 * @param randomize Randomize the UTXO order before running the coinselection algorithm
 */
export declare function coinSelect(utxos: CoinselectTxInput[], outputs: CoinselectTxOutput[], feeRate: number, changeType: CoinselectAddressTypes, requiredInputs?: CoinselectTxInput[], randomize?: boolean): {
    inputs?: CoinselectTxInput[];
    outputs?: CoinselectTxOutput[];
    fee: number;
};
