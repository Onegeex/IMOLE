// Copies contract ABIs from the Foundry build into the web app.
import { readFileSync, writeFileSync } from "node:fs";
for (const name of ["ImolePAYG", "ImoleKYC"]) {
  const art = JSON.parse(readFileSync(`../contracts/out/${name}.sol/${name}.json`, "utf8"));
  writeFileSync(`src/abi/${name}.ts`, `export const ${name}Abi = ${JSON.stringify(art.abi, null, 2)} as const;\n`);
  console.log("wrote", name);
}
