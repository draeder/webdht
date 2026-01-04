import { spawn } from 'node:child_process';

const projects = ['chromium', 'firefox', 'webkit'];

function run(cmd, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) return reject(new Error(`Command terminated by signal: ${signal}`));
      if (code !== 0) return reject(new Error(`Command failed with exit code: ${code}`));
      resolve();
    });
  });
}

async function main() {
  // Ensure consistent output ordering; do not interleave projects.
  for (const project of projects) {
    console.log(`\n=== Playwright: ${project} ===\n`);
    await run('npx', ['playwright', 'test', '--workers=1', '--reporter=line', `--project=${project}`]);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
