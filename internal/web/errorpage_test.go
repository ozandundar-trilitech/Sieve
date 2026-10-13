package web_test

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/trilitech/Sieve/internal/events"
	"github.com/trilitech/Sieve/internal/scriptgen"
	"github.com/trilitech/Sieve/internal/testing/testenv"
	"github.com/trilitech/Sieve/internal/web"
)

func navGet(h http.Handler, cookie *http.Cookie, path string, nav bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	if nav {
		req.Header.Set("Sec-Fetch-Mode", "navigate")
		req.Header.Set("Accept", "text/html,application/xhtml+xml")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func assertAdminSecurityHeaders(t *testing.T, h http.Header) {
	t.Helper()
	if h.Get("Content-Security-Policy") == "" || h.Get("X-Frame-Options") != "DENY" || h.Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("security headers missing: %v", h)
	}
	if !strings.Contains(h.Get("Cache-Control"), "no-store") {
		t.Errorf("Cache-Control = %q, want no-store", h.Get("Cache-Control"))
	}
}

func TestStyledErrors_NotFoundNavigation(t *testing.T) {
	h, env := newTestWebServer(t)
	rec := navGet(h, env.SessionCookie(), "/definitely-not-a-page", true)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type %q, want text/html", ct)
	}
	body := rec.Body.String()
	for _, want := range []string{"Page not found", "404 page not found", `href="/"`, "error-back"} {
		if !strings.Contains(body, want) {
			t.Errorf("styled 404 missing %q", want)
		}
	}
	assertAdminSecurityHeaders(t, rec.Header())
}

func TestStyledErrors_NonNavigationStaysPlain(t *testing.T) {
	h, env := newTestWebServer(t)
	rec := navGet(h, env.SessionCookie(), "/definitely-not-a-page", false)
	if rec.Code != http.StatusNotFound || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain") {
		t.Fatalf("got %d %q, want plain-text 404", rec.Code, rec.Header().Get("Content-Type"))
	}
	if strings.TrimSpace(rec.Body.String()) != "404 page not found" {
		t.Errorf("body %q", rec.Body.String())
	}
	// fetch() from a page: Sec-Fetch-Mode cors, Accept */* — untouched.
	req := httptest.NewRequest(http.MethodGet, "/definitely-not-a-page", nil)
	req.AddCookie(env.SessionCookie())
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Accept", "text/html")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain") {
		t.Errorf("fetch caller got %q, want text/plain", rec.Header().Get("Content-Type"))
	}
	// htmx request: untouched even with navigation-looking headers.
	req = httptest.NewRequest(http.MethodGet, "/definitely-not-a-page", nil)
	req.AddCookie(env.SessionCookie())
	req.Header.Set("Accept", "text/html")
	req.Header.Set("HX-Request", "true")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain") {
		t.Errorf("htmx caller got %q, want text/plain", rec.Header().Get("Content-Type"))
	}
}

func TestStyledErrors_FormHandlerError(t *testing.T) {
	h, env := newTestWebServer(t)
	form := url.Values{"id": {"x"}} // display_name + bot_token missing -> http.Error 400
	req := httptest.NewRequest(http.MethodPost, "/connections/slack/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Sec-Fetch-Mode", "navigate")
	req.Header.Set("Accept", "text/html")
	req.AddCookie(env.SessionCookie())
	req.Header.Set("X-CSRF-Token", env.CSRFToken())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") || !strings.Contains(body, "Something went wrong with that request") {
		t.Fatalf("not styled: %q %q", rec.Header().Get("Content-Type"), body)
	}
	if !strings.Contains(body, "id, display_name, and bot_token are required") {
		t.Errorf("original message lost: %q", body)
	}
	assertAdminSecurityHeaders(t, rec.Header())
}

func TestStyledErrors_EscapesMessage(t *testing.T) {
	h, env := newTestWebServer(t)
	rec := navGet(h, env.SessionCookie(), "/docs/<script>", true)
	if strings.Contains(rec.Body.String(), "<script>alert") || strings.Contains(rec.Body.String(), "/docs/<script>") {
		t.Errorf("unescaped path in error page")
	}
}

func TestStyledErrors_LeavesJSONAndStreamsAlone(t *testing.T) {
	h, env := newTestWebServer(t)
	rec := navGet(h, env.SessionCookie(), "/approvals/pending.json", true)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Header().Get("Content-Type"), "json") {
		t.Errorf("pending.json: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}

	// A server with the event hub wired, so /events actually streams.
	env2 := testenv.New(t).WithOperator("test-pass", "test-op")
	wsrv := web.NewServer(env2.Tokens, env2.Connections, env2.Roles, env2.Registry,
		env2.Approval, env2.Audit, "", env2.Settings,
		scriptgen.NewService(env2.Connections, env2.Settings), env2.Keyring, env2.DB, "127.0.0.1:0")
	wsrv.SetAuth(env2.Operator, env2.Session)
	hub := events.NewHub()
	wsrv.SetEvents(hub)
	srv := httptest.NewServer(wsrv.Handler())
	t.Cleanup(func() { hub.Close(); srv.Close(); wsrv.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/events", nil)
	req.AddCookie(env2.SessionCookie())
	req.Header.Set("Sec-Fetch-Mode", "navigate")
	req.Header.Set("Accept", "text/event-stream, text/html")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /events: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("/events: %d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	// The stream must flush its first bytes without the handler returning.
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil {
		t.Fatalf("no flushed bytes from /events: %v", err)
	}
	_ = line
}
