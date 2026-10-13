package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/trilitech/Sieve/internal/scriptgen"
	"github.com/trilitech/Sieve/internal/testing/testenv"
)

// TestDocsServedFromEmbeddedFS proves /docs works regardless of the working
// directory. Go runs this package's tests from internal/web, where there is
// no docs/ folder, so this fails if any handler still reads the filesystem.
// (The desktop app runs the server from its data folder; the Docker image
// ships only the binary.)
func TestDocsServedFromEmbeddedFS(t *testing.T) {
	if _, err := os.Stat("docs"); err == nil {
		t.Skip("a docs/ folder exists in the test cwd; this test needs it absent")
	}
	env := testenv.New(t).WithOperator("test-pass", "test-op")
	srv := NewServer(
		env.Tokens, env.Connections, env.Roles,
		env.Registry, env.Approval, env.Audit,
		"", env.Settings, scriptgen.NewService(env.Connections, env.Settings),
		env.Keyring, env.DB, "127.0.0.1:0",
	)
	srv.SetAuth(env.Operator, env.Session)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { ts.Close(); srv.Close() })

	for path, want := range map[string]string{
		"/docs":                   "Setting Up Connections",
		"/docs/connections-guide": "Connection",
	} {
		resp, err := env.AdminClient().Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s = %d: %s", path, resp.StatusCode, strings.TrimSpace(string(body)))
		}
		if !strings.Contains(string(body), want) {
			t.Fatalf("GET %s: page does not contain %q", path, want)
		}
	}
}
