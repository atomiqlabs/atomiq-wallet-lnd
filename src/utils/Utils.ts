import {ChainTransaction} from "lightning";
import {BtcTx} from "@atomiqlabs/base";
import {OutScript, Script, Transaction} from "@scure/btc-signer";
import {Buffer} from "buffer";
import {TransactionInput} from "@scure/btc-signer/psbt";
import {CoinselectAddressTypes, CoinselectTxInput} from "./coinselect2/utils";
import {createHash} from "crypto";

export function getLogger(prefix: string) {
    return {
        debug: (msg, ...args) => console.debug(prefix+msg, ...args),
        info: (msg, ...args) => console.info(prefix+msg, ...args),
        warn: (msg, ...args) => console.warn(prefix+msg, ...args),
        error: (msg, ...args) => console.error(prefix+msg, ...args)
    };
}

export function shuffle(array: any[]) {
    let currentIndex = array.length;

    // While there remain elements to shuffle...
    while (currentIndex != 0) {

        // Pick a remaining element...
        let randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;

        // And swap it with the current element.
        [array[currentIndex], array[randomIndex]] = [
            array[randomIndex], array[currentIndex]];
    }
}

/**
 * Handles & throws LND error if the error is:
 *  - network error
 *  - server side (LND) internal error
 *  - malformed input data error
 *
 * @param e
 */
export function handleLndError(e: any) {
    if(!Array.isArray(e)) throw e; //Throw errors that are not originating from the SDK
    if(typeof(e[0])!=="number") throw e; //Throw errors that don't have proper format
    if(e[0]>=500 && e[0]<600) throw e; //Throw server errors 5xx
    if(e[0]===400) throw e; //Throw malformed request data errors
}

export function bitcoinTxToBtcTx(btcTx: Transaction): BtcTx {
    const txWithoutWitness = btcTx.toBytes(true, false);
    return {
        locktime: btcTx.lockTime,
        version: btcTx.version,
        blockhash: null,
        confirmations: 0,
        txid: createHash("sha256").update(
            createHash("sha256").update(
                txWithoutWitness
            ).digest()
        ).digest().reverse().toString("hex"),
        hex: Buffer.from(txWithoutWitness).toString("hex"),
        raw: Buffer.from(btcTx.toBytes(true, true)).toString("hex"),
        vsize: btcTx.isFinal ? btcTx.vsize : null,

        outs: Array.from({length: btcTx.outputsLength}, (_, i) => i).map((index) => {
            const output = btcTx.getOutput(index);
            return {
                value: Number(output.amount),
                n: index,
                scriptPubKey: {
                    asm: Script.decode(output.script).map(val => typeof(val)==="object" ? Buffer.from(val).toString("hex") : val.toString()).join(" "),
                    hex: Buffer.from(output.script).toString("hex")
                }
            }
        }),
        ins: Array.from({length: btcTx.inputsLength}, (_, i) => i).map(index => {
            const input = btcTx.getInput(index);
            return {
                txid: Buffer.from(input.txid).toString("hex"),
                vout: input.index,
                scriptSig: {
                    asm: Script.decode(input.finalScriptSig).map(val => typeof(val)==="object" ? Buffer.from(val).toString("hex") : val.toString()).join(" "),
                    hex: Buffer.from(input.finalScriptSig).toString("hex")
                },
                sequence: input.sequence,
                txinwitness: input.finalScriptWitness==null ? [] : input.finalScriptWitness.map(witness => Buffer.from(witness).toString("hex"))
            }
        })
    }
}

export function toCoinselectInput(input: TransactionInput): CoinselectTxInput {
    let amount: bigint;
    let outputScript: Uint8Array;
    if(input.witnessUtxo!=null) {
        outputScript = input.witnessUtxo.script;
        amount = input.witnessUtxo.amount;
    } else if(input.nonWitnessUtxo!=null) {
        const prevUtxo = input.nonWitnessUtxo.outputs[input.index];
        outputScript = prevUtxo.script;
        amount = prevUtxo.amount;
    } else {
        throw new Error("Input needs to have either witnessUtxo or nonWitnessUtxo specified!");
    }

    let inputType: CoinselectAddressTypes;

    switch(OutScript.decode(outputScript).type) {
        case "pkh":
            inputType = "p2pkh";
            break;
        case "wpkh":
            inputType = "p2wpkh";
            break;
        case "tr":
            inputType = "p2tr";
            break;
        case "sh":
            inputType = "p2sh-p2wpkh";
            break;
        case "wsh":
            inputType = "p2wsh";
            break;
        default:
            throw new Error("Invalid input type!");
    }

    return {
        txId: Buffer.from(input.txid).toString("hex"),
        vout: input.index,
        value: Number(amount),
        type: inputType
    }
}