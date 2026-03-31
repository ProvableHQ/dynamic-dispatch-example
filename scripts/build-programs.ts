/**
 * Build all Leo programs and copy dev-dependency imports.
 *
 * 1. Builds toka_token, tokb_token (leaf programs)
 * 2. Builds token_router (uses interface calls at runtime via --with)
 * 3. Copies token .aleo files into token_router/build/imports/ so
 *    `leo test` can resolve dev_dependencies
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

// token_router lists these as dev_dependencies — their .aleo files must be
// in build/imports/ for `leo test` to work.
const ROUTER_DEV_DEPS = ["toka_token", "tokb_token"];

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

function copyDevDeps(): void {
  const importsDir = resolve(ROOT, "token_router/build/imports");
  mkdirSync(importsDir, { recursive: true });

  for (const dep of ROUTER_DEV_DEPS) {
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

for (const prog of PROGRAMS) {
  buildProgram(prog.dir);
}

// Copy dev-dependency .aleo files for `leo test`
console.log("\nCopying dev-dependency imports for token_router...");
copyDevDeps();

console.log("\nAll programs built.");
