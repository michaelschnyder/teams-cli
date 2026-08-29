import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "src", "skills");
const destination = join(root, "dist", "skills");
if (!existsSync(source)) throw new Error(`Missing skill resources at ${source}`);
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
