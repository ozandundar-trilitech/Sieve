// Builds the Go server binary that the app bundles and supervises.
//
//   npm run build:sidecar                 # host OS/arch → resources/bin/sieve[.exe]
//   GOOS=windows GOARCH=amd64 npm run build:sidecar
//
// CGO is off: the server uses the pure-Go SQLite driver, so every target
// cross-compiles from one machine. Requires `go` on PATH (or GO=/path/to/go).
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const goos = process.env.GOOS || { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform];
const goarch = process.env.GOARCH || { arm64: 'arm64', x64: 'amd64' }[process.arch];
const outDir = join(here, '..', 'resources', 'bin');
const out = join(outDir, goos === 'windows' ? 'sieve.exe' : 'sieve');
mkdirSync(outDir, { recursive: true });

// Optional public OAuth client IDs baked in at release time (PKCE clients;
// see docs/oauth-pkce.md). Empty in dev builds.
const ldflags = ['-s', '-w'];
if (process.env.SIEVE_GOOGLE_CLIENT_ID) {
  ldflags.push(`-X github.com/trilitech/Sieve/internal/web.defaultGoogleClientID=${process.env.SIEVE_GOOGLE_CLIENT_ID}`);
}

execFileSync(process.env.GO || 'go', ['build', '-trimpath', '-ldflags', ldflags.join(' '), '-o', out, './cmd/sieve'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
});
console.log(`sidecar: ${out} (${goos}/${goarch})`);
