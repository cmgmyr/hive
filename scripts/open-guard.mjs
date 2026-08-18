import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function installFakeOpen() {
  const bin = mkdtempSync(join(tmpdir(), "hive-fake-open-bin-"));
  const log = join(bin, "calls.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "open"),
    "#!/bin/sh\n" +
      "{\n" +
      "  printf 'ARGS: %s\\n' \"$*\"\n" +
      "  printf 'CWD: %s\\n' \"$PWD\"\n" +
      "  printf 'HIVE_DATA_DIR: %s\\n' \"$HIVE_DATA_DIR\"\n" +

      "  pid=$PPID\n" +
      "  i=0\n" +
      "  while [ $i -lt 6 ] && [ -n \"$pid\" ]; do\n" +
      "    cmd=$(ps -o command= -p \"$pid\" 2>/dev/null)\n" +
      "    [ -z \"$cmd\" ] && break\n" +
      "    printf 'ANCESTOR[%s] pid=%s cmd=%s\\n' \"$i\" \"$pid\" \"$cmd\"\n" +
      "    pid=$(ps -o ppid= -p \"$pid\" 2>/dev/null | tr -d ' ')\n" +
      "    i=$((i+1))\n" +
      "  done\n" +
      "  printf -- '---\\n'\n" +
      `} >> ${JSON.stringify(log)}\n` +
      "exit 0\n",
  );
  chmodSync(join(bin, "open"), 0o755);
  return { bin, log, reap: () => rmSync(bin, { recursive: true, force: true }) };
}

export function readOpenCalls(log) {
  const raw = readFileSync(log, "utf8").trim();
  if (raw.length === 0) return [];
  return raw
    .split(/^---$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function describeOpenCalls(calls) {
  if (calls.length === 0) return ["no `open` calls reached the suite-wide fake"];
  return [
    `${calls.length} \`open\` call(s) reached the suite-wide fake (todo 419) - either fake ` +
      "it locally ahead of this one on PATH (test/dashboard-open.test.mjs), or pass " +
      "--no-dashboard, or the escape is real and needs closing:",
    ...calls.flatMap((call) => call.split("\n").map((line) => `  ${line}`)),
  ];
}

export function openCallsFailed(calls) {
  return calls.length > 0;
}
