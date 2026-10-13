package web_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/trilitech/Sieve/internal/web/assetsum"
)

// TestAdminCSSFresh fails when static/admin.css was not regenerated after
// a change to styles/theme.css or any template (templates are scanned for
// Tailwind class names, so a new class in a template needs a rebuild).
// Mirrors the Cedar schema staleness test in cmd/sieve.
func TestAdminCSSFresh(t *testing.T) {
	css, err := os.ReadFile("static/admin.css")
	if err != nil {
		t.Fatalf("read admin.css: %v", err)
	}
	want, err := assetsum.Sum(os.DirFS("."))
	if err != nil {
		t.Fatal(err)
	}
	first, _, _ := strings.Cut(string(css), "\n")
	if !strings.HasPrefix(first, assetsum.HeaderPrefix) {
		t.Fatalf("admin.css has no inputs header; regenerate with: go generate ./internal/web")
	}
	got := strings.TrimPrefix(first, assetsum.HeaderPrefix)
	if !strings.HasPrefix(got, want) {
		t.Errorf("internal/web/static/admin.css is stale (built from inputs %.12s, current inputs %.12s); run: go generate ./internal/web", got, want)
	}
}

// TestStaticAssetsServed checks the /static route on the admin handler:
// reachable without a session (the login page needs it), correct
// content types, cacheable, and no directory listing.
func TestStaticAssetsServed(t *testing.T) {
	h, _ := newTestWebServer(t)
	cases := []struct{ path, ctype string }{
		{"/static/admin.css", "text/css"},
		{"/static/favicon.svg", "image/svg+xml"},
		{"/static/fonts/geist-latin-wght-normal.woff2", "font/woff2"},
		{"/static/vendor/htmx-2.0.4.min.js", "javascript"},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, c.path+"?v=1", nil))
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s: status %d, want 200", c.path, rec.Code)
			continue
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, c.ctype) {
			t.Errorf("GET %s: Content-Type %q, want %q", c.path, ct, c.ctype)
		}
		if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
			t.Errorf("GET %s: Cache-Control %q, want immutable for a versioned URL", c.path, cc)
		}
		if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("GET %s: security headers missing", c.path)
		}
	}
	body, _ := io.ReadAll(func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/static/admin.css", nil))
		return rec
	}().Body)
	if !strings.Contains(string(body), "--background") {
		t.Error("admin.css does not carry the theme tokens")
	}
	for _, p := range []string{"/static/", "/static/fonts/", "/static/nope.css"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s: status %d, want 404", p, rec.Code)
		}
	}
}
