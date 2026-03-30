/**
 * Build all Leo programs in dependency order and copy imports.
 *
 * 1. Builds toka_token, tokb_token (leaf dependencies)
 * 2. Builds token_router (depends on both tokens)
 * 3. Copies built .aleo files into token_router/build/imports/
 *
 * Usage:
 *   DOTENV=testnet npx tsx scripts/build-programs.ts
 */
import { execSync } from "child_process";
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const LEO_BIN = process.env.LEO_BIN || "leo";

const PROGRAMS = [
  { name: "toka_token", dir: "toka_token" },
  { name: "tokb_token", dir: "tokb_token" },
  { name: "token_router", dir: "token_router" },
];

// token_router depends on these — their .aleo files need to be in its build/imports/
const ROUTER_IMPORTS = ["toka_token", "tokb_token"];

function buildProgram(dir: string): void {
  const projectDir = resolve(ROOT, dir);
  console.log(`Building ${dir}...`);
  try {
    execSync(`${LEO_BIN} build`, {
      cwd: projectDir,
      timeout: 120000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(`  ✓ ${dir} built`);
  } catch (error: unknown) {
    const err = error as { stderr?: string; stdout?: string };
    const output = (err.stderr || "") + (err.stdout || "");
    console.error(`  ✗ ${dir} failed:\n${output.substring(0, 500)}`);
    process.exit(1);
  }
}

function copyImports(): void {
  const importsDir = resolve(ROOT, "token_router/build/imports");
  mkdirSync(importsDir, { recursive: true });

  for (const dep of ROUTER_IMPORTS) {
    const src = resolve(ROOT, dep, "build/main.aleo");
    const dst = resolve(importsDir, `${dep}.aleo`);
    if (!existsSync(src)) {
      console.error(`  ✗ Missing build artifact: ${src}`);
      process.exit(1);
    }
    copyFileSync(src, dst);
    console.log(`  ✓ Copied ${dep}.aleo → token_router/build/imports/`);
  }
}

// Build all programs in order
for (const prog of PROGRAMS) {
  buildProgram(prog.dir);
}

// Copy dependency .aleo files into token_router/build/imports/
console.log("\nCopying imports for token_router...");
copyImports();

console.log("\nAll programs built.");
