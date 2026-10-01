// node examples/status.mjs /path/to/directory-with-the-binary
import path from "node:path";
import { connectOrLaunch, resolveBinaryName } from "../dist/esm/index.js";

const binDir = process.argv[2];
if (!binDir) {
  console.error("usage: node examples/status.mjs <directory-with-the-binary>");
  process.exit(1);
}

const { client, server } = await connectOrLaunch({
  clientOptions: { onLog: (line) => console.log("[sdk]", line) },
  launch: {
    binaryPath: path.join(
      binDir,
      resolveBinaryName(process.platform, process.arch),
    ),
    onLog: (line) => console.log("[server]", line),
  },
});

console.log("dongle:", await client.getDongle());

const config = await client.getConfiguration();
console.log("licensed serials:", config.serials);

client.close();
server?.kill();
