import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, "..");

const copies = [
  { from: join(root, "prompts"), to: join(root, "dist", "prompts") },
];

for (const item of copies) {
  if (!existsSync(item.from)) continue;
  mkdirSync(item.to, { recursive: true });
  cpSync(item.from, item.to, { recursive: true, force: true });
}
