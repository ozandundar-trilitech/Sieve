// Command genadmincss compiles internal/web/styles/theme.css into
// internal/web/static/admin.css with the Tailwind v4 standalone CLI.
//
// Run from the repository root or via `go generate ./internal/web` (the
// directive lives in internal/web/static.go and runs with internal/web as
// the working directory).
//
// The Tailwind binary is resolved in this order:
//  1. $TAILWINDCSS (path to an existing binary);
//  2. <repo>/.tools/tailwindcss-v<version>[.exe] (gitignored cache);
//  3. downloaded from the pinned GitHub release into that cache, and
//     verified against the pinned SHA-256 below before it is executed.
//
// The output starts with an inputs fingerprint (see internal/web/assetsum)
// so TestAdminCSSFresh can detect a stale committed stylesheet without
// needing the binary.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/trilitech/Sieve/internal/web/assetsum"
)

const tailwindVersion = "4.3.3"

// sha256 of each release asset, from the release's sha256sums.txt.
var tailwindSHA256 = map[string]string{
	"tailwindcss-linux-arm64":     "55fd0b241214eff3de1e8ee4f22796662f2d2e7a49bcfca7477cfd0bac398195",
	"tailwindcss-linux-x64":       "dc61b3ac6b8c9ca874c0cc4c57b2409791a64c5540404ca5f5367360babc313a",
	"tailwindcss-macos-arm64":     "cdf646702987a743464dff4d9c60fd4480d1c1e73dd819a9a67f1078815dce9d",
	"tailwindcss-macos-x64":       "7922e0953f2110c05976e3bf58f14e643d90427575e766b7d433f5f80cbee7e1",
	"tailwindcss-windows-x64.exe": "e0e260ce048014e9268f6237ff18f8ccf02cef521cbd0ae04e82c2cdf7aa3955",
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "genadmincss:", err)
		os.Exit(1)
	}
}

func run() error {
	webDir, err := findWebDir()
	if err != nil {
		return err
	}
	repo := filepath.Dir(filepath.Dir(webDir))
	bin, err := tailwindBinary(repo)
	if err != nil {
		return err
	}
	out := filepath.Join(webDir, "static", "admin.css")
	tmp := out + ".tmp"
	cmd := exec.Command(bin, "--input", filepath.Join("styles", "theme.css"), "--output", tmp, "--minify")
	cmd.Dir = webDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("tailwind build: %w", err)
	}
	css, err := os.ReadFile(tmp)
	_ = os.Remove(tmp)
	if err != nil {
		return err
	}
	sum, err := assetsum.Sum(os.DirFS(webDir))
	if err != nil {
		return err
	}
	if err := os.WriteFile(out, append([]byte(assetsum.Header(sum)), css...), 0o644); err != nil {
		return err
	}
	fmt.Printf("wrote %s (%d bytes, inputs %s)\n", out, len(css), sum[:12])
	return nil
}

// findWebDir locates internal/web from either the repo root or
// internal/web itself (go generate's working directory).
func findWebDir() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for _, cand := range []string{wd, filepath.Join(wd, "internal", "web")} {
		if _, err := os.Stat(filepath.Join(cand, "styles", "theme.css")); err == nil {
			return cand, nil
		}
	}
	return "", fmt.Errorf("run from the repo root or internal/web (no styles/theme.css under %s)", wd)
}

func assetName() (string, error) {
	osName := map[string]string{"darwin": "macos", "linux": "linux", "windows": "windows"}[runtime.GOOS]
	arch := map[string]string{"arm64": "arm64", "amd64": "x64"}[runtime.GOARCH]
	if osName == "" || arch == "" {
		return "", fmt.Errorf("no Tailwind standalone build for %s/%s; set TAILWINDCSS", runtime.GOOS, runtime.GOARCH)
	}
	name := "tailwindcss-" + osName + "-" + arch
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if _, ok := tailwindSHA256[name]; !ok {
		return "", fmt.Errorf("no pinned checksum for %s; set TAILWINDCSS", name)
	}
	return name, nil
}

func tailwindBinary(repo string) (string, error) {
	if p := os.Getenv("TAILWINDCSS"); p != "" {
		return p, nil
	}
	name, err := assetName()
	if err != nil {
		return "", err
	}
	cacheDir := filepath.Join(repo, ".tools")
	bin := filepath.Join(cacheDir, "tailwindcss-v"+tailwindVersion)
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	if ok, _ := verify(bin, tailwindSHA256[name]); ok {
		return bin, nil
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return "", err
	}
	url := "https://github.com/tailwindlabs/tailwindcss/releases/download/v" + tailwindVersion + "/" + name
	fmt.Println("downloading", url)
	resp, err := http.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download %s: %s", url, resp.Status)
	}
	f, err := os.CreateTemp(cacheDir, "tailwindcss-*")
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(f.Name())
		return "", err
	}
	f.Close()
	if ok, got := verify(f.Name(), tailwindSHA256[name]); !ok {
		os.Remove(f.Name())
		return "", fmt.Errorf("checksum mismatch for %s: got %s", name, got)
	}
	if err := os.Chmod(f.Name(), 0o755); err != nil {
		return "", err
	}
	return bin, os.Rename(f.Name(), bin)
}

func verify(path, want string) (bool, string) {
	f, err := os.Open(path)
	if err != nil {
		return false, ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false, ""
	}
	got := hex.EncodeToString(h.Sum(nil))
	return got == want, got
}
