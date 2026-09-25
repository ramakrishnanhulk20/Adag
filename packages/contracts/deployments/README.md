# Deployments

`arc-mainnet.json` is written by `bash deploy.sh --broadcast` once the receipt is in: `{"chainId":5042,"AdagBills":{"address":"0x...","txHash":"0x...","block":N,"deployer":"0x...","solc":"0.8.30","optimizerRuns":200,"evmVersion":"prague","deployedAt":"ISO time"}}`.
`arc-mainnet.dry-run.json` is written by `bash deploy.sh --dry-run` with the same shape: the predicted address, `"txHash":null`, and the block the simulation ran against.
`AdagBills.standard-json.json` is written by `bash verify.sh` and is the file to upload on explorer.arc.io.
