// Creator-facing publish glue: `snack push` uploads the built version and
// prints "Pushed version N (<uuid>)", and `snack publish` needs that uuid to
// activate it — this script chains the two so `npm run publish` stays a
// single command. Expects the client/server build to have run already (the
// package.json script does that).
import { spawnSync } from "node:child_process";

// npm puts node_modules/.bin on PATH; Windows needs a shell for the .cmd shim
const shell = process.platform === "win32";

function run(args) {
  const res = spawnSync("snack", args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
    shell,
  });
  process.stdout.write(res.stdout ?? "");
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
  return res.stdout ?? "";
}

const pushed = run(["push"]);
const version = pushed.match(/Pushed version \d+ \(([0-9a-f-]+)\)/);
if (!version) {
  console.error("snack push output had no version id; activate manually with: snack publish <id>");
  process.exit(1);
}
run(["publish", version[1]]);
