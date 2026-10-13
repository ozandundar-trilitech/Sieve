package web

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// TestCSPSelfHostedAssets pins the admin CSP after the redesign vendored
// every asset (compiled Tailwind CSS, fonts, htmx, marked, DOMPurify)
// under /static/. Script, style, font and connect sources must be
// same-origin only; reintroducing a CDN host is a regression (it would
// also break the offline desktop app). form-action keeps the OAuth hosts.
func TestCSPSelfHostedAssets(t *testing.T) {
	w := httptest.NewRecorder()
	writeSecurityHeaders(w)
	csp := w.Header().Get("Content-Security-Policy")
	if csp == "" {
		t.Fatal("CSP header empty")
	}

	for _, directive := range []string{"script-src", "style-src", "font-src", "connect-src"} {
		for _, part := range strings.Split(csp, ";") {
			p := strings.TrimSpace(part)
			if !strings.HasPrefix(p, directive+" ") {
				continue
			}
			for _, src := range strings.Fields(strings.TrimPrefix(p, directive)) {
				if strings.Contains(src, "://") {
					t.Errorf("CSP %s allows third-party host %s; assets must be served from /static/", directive, src)
				}
			}
		}
	}
	for _, host := range []string{"cdn.tailwindcss.com", "cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"} {
		if strings.Contains(csp, host) {
			t.Errorf("CSP still names %s", host)
		}
	}

	// form-action covers both the initial POST target AND any
	// redirects from it. The reauth / OAuth-install flows POST
	// same-origin and the server returns a 302 to the provider —
	// without these hosts the redirect is blocked at the browser.
	for _, host := range []string{"https://accounts.google.com", "https://slack.com", "https://github.com", "https://api.notion.com", "https://app.notion.com", "https://app.asana.com"} {
		if !cspDirectiveContains(csp, "form-action", host) {
			t.Errorf("CSP form-action is missing %s", host)
		}
	}

	// Sanity: the strict invariants we don't want to lose.
	for _, must := range []string{"object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"} {
		if !strings.Contains(csp, must) {
			t.Errorf("CSP missing required directive %q; got: %s", must, csp)
		}
	}
}

// cspDirectiveContains returns true when the CSP string carries the
// given directive and the directive's source list contains the host.
func cspDirectiveContains(csp, directive, host string) bool {
	for _, part := range strings.Split(csp, ";") {
		p := strings.TrimSpace(part)
		if !strings.HasPrefix(p, directive+" ") && p != directive {
			continue
		}
		sources := strings.TrimPrefix(p, directive)
		for _, src := range strings.Fields(sources) {
			if src == host {
				return true
			}
		}
	}
	return false
}
