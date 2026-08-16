import { checkAbi, describeAbi } from "./abi.js";

const status = checkAbi();

process.stdout.write(
  `${JSON.stringify({
    execPath: process.execPath,
    version: process.version,
    ok: status.ok,
    failure: status.failure,
    detail: describeAbi(status),
  })}\n`,
);
