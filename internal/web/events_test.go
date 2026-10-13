package web

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/trilitech/Sieve/internal/approval"
	"github.com/trilitech/Sieve/internal/events"
	"github.com/trilitech/Sieve/internal/scriptgen"
	"github.com/trilitech/Sieve/internal/session"
	"github.com/trilitech/Sieve/internal/testing/testenv"
	"github.com/trilitech/Sieve/internal/tokens"
)

func eventsTestServer(t *testing.T) (*httptest.Server, *testenv.Env, *events.Hub) {
	t.Helper()
	env := testenv.New(t).WithOperator("test-pass", "test-op")
	srv := NewServer(
		env.Tokens, env.Connections, env.Roles,
		env.Registry, env.Approval, env.Audit,
		"", env.Settings, scriptgen.NewService(env.Connections, env.Settings),
		env.Keyring, env.DB, "127.0.0.1:0",
	)
	srv.SetAuth(env.Operator, env.Session)
	hub := events.NewHub()
	srv.SetEvents(hub)
	env.Approval.SetEvents(hub)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { hub.Close(); ts.Close(); srv.Close() })
	return ts, env, hub
}

// sseFrame is one parsed "event:/data:" frame.
type sseFrame struct {
	Event string
	Data  events.Event
}

// readFrames parses SSE frames off body onto a channel until EOF.
func readFrames(body io.Reader) <-chan sseFrame {
	out := make(chan sseFrame, 16)
	go func() {
		defer close(out)
		sc := bufio.NewScanner(body)
		var f sseFrame
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				f.Event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &f.Data)
			case line == "" && f.Event != "":
				out <- f
				f = sseFrame{}
			}
		}
	}()
	return out
}

func nextFrame(t *testing.T, ch <-chan sseFrame) sseFrame {
	t.Helper()
	select {
	case f, ok := <-ch:
		if !ok {
			t.Fatal("stream closed before the expected frame")
		}
		return f
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for an SSE frame")
	}
	return sseFrame{}
}

func openStream(t *testing.T, ts *httptest.Server, env *testenv.Env) (*http.Response, <-chan sseFrame) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/events", nil)
	req.AddCookie(env.SessionCookie())
	req.AddCookie(&http.Cookie{Name: session.CSRFCookieName, Value: env.CSRFToken()})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /events = %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q", ct)
	}
	return resp, readFrames(resp.Body)
}

func TestEvents_RequiresOperatorSession(t *testing.T) {
	ts, _, _ := eventsTestServer(t)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	resp, err := client.Get(ts.URL + "/events")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != "/login" {
		t.Fatalf("no session: got %d → %q, want 303 → /login", resp.StatusCode, resp.Header.Get("Location"))
	}

	for _, path := range []string{"/events", "/approvals/pending.json"} {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+path, nil)
		req.Header.Set("Authorization", "Bearer sieve_tok_deadbeef")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s with agent token = %d, want 403", path, resp.StatusCode)
		}
	}
}

func TestEvents_HelloThenEnrichedApproval(t *testing.T) {
	ts, env, _ := eventsTestServer(t)
	tok, err := env.Tokens.Create(&tokens.CreateRequest{Name: "claude-desktop"})
	if err != nil {
		t.Fatal(err)
	}
	_, frames := openStream(t, ts, env)

	hello := nextFrame(t, frames)
	if hello.Event != "hello" || hello.Data.Data["csrf_token"] != env.CSRFToken() || hello.Data.Data["pending_approvals"] != float64(0) {
		t.Fatalf("bad hello: %+v", hello)
	}

	item, err := env.Approval.Submit(&approval.SubmitRequest{
		TokenID: tok.Token.ID, ConnectionID: "work", Operation: "send_email",
		RequestData: map[string]any{"to": "ceo@example.com", "body": "TOP SECRET"},
	})
	if err != nil {
		t.Fatal(err)
	}
	f := nextFrame(t, frames)
	d := f.Data.Data
	if f.Event != events.TypeApprovalPending || d["id"] != item.ID || d["token_name"] != "claude-desktop" {
		t.Fatalf("bad approval frame: %+v", f)
	}
	raw, _ := json.Marshal(d)
	if strings.Contains(string(raw), "TOP SECRET") || strings.Contains(string(raw), "ceo@example.com") {
		t.Fatalf("param values leaked into the stream: %s", raw)
	}
}

func TestEvents_StreamEndsWhenSessionEnds(t *testing.T) {
	old := eventsHeartbeat
	eventsHeartbeat = 50 * time.Millisecond
	t.Cleanup(func() { eventsHeartbeat = old })

	ts, env, _ := eventsTestServer(t)
	_, frames := openStream(t, ts, env)
	nextFrame(t, frames) // hello

	if err := env.Session.Logout(env.SessionCookie().Value); err != nil {
		t.Fatal(err)
	}
	if f := nextFrame(t, frames); f.Event != "session_ended" {
		t.Fatalf("want session_ended, got %+v", f)
	}
	select {
	case _, ok := <-frames:
		if ok {
			t.Fatal("stream should close after session_ended")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not close")
	}
}

func TestEvents_HeartbeatDoesNotSlideSession(t *testing.T) {
	old := eventsHeartbeat
	eventsHeartbeat = 30 * time.Millisecond
	t.Cleanup(func() { eventsHeartbeat = old })

	ts, env, _ := eventsTestServer(t)
	_, frames := openStream(t, ts, env)
	nextFrame(t, frames)
	// Opening the stream goes through requireOperatorSession, which slides
	// the session once. The heartbeats that follow must not slide it again.
	var afterOpen, after string
	_ = env.DB.QueryRow(`SELECT expires_at FROM operator_session`).Scan(&afterOpen)
	time.Sleep(200 * time.Millisecond) // several heartbeats
	_ = env.DB.QueryRow(`SELECT expires_at FROM operator_session`).Scan(&after)
	if after != afterOpen {
		t.Fatalf("heartbeats slid the session: %s → %s", afterOpen, after)
	}
}

func TestEvents_HubCloseEndsStream(t *testing.T) {
	ts, env, hub := eventsTestServer(t)
	_, frames := openStream(t, ts, env)
	nextFrame(t, frames)
	hub.Close()
	select {
	case _, ok := <-frames:
		if ok {
			t.Fatal("no frames expected after hub close")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not end on hub close (graceful shutdown would hang)")
	}
}

func TestApprovalsPendingJSON(t *testing.T) {
	ts, env, _ := eventsTestServer(t)
	tok, _ := env.Tokens.Create(&tokens.CreateRequest{Name: "agent-a"})
	_, _ = env.Approval.Submit(&approval.SubmitRequest{
		TokenID: tok.Token.ID, ConnectionID: "work", Operation: "send_email",
		RequestData: map[string]any{"body": "TOP SECRET"},
	})
	resp, err := env.AdminClient().Get(ts.URL + "/approvals/pending.json")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	if strings.Contains(string(body), "TOP SECRET") {
		t.Fatal("param values leaked into pending.json")
	}
	var got struct {
		Count     int                   `json:"count"`
		Approvals []pendingApprovalView `json:"approvals"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Count != 1 || got.Approvals[0].TokenName != "agent-a" || got.Approvals[0].ParamKeys[0] != "body" {
		t.Fatalf("unexpected payload: %s", body)
	}
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Fatalf("admin JSON must carry no-store, got %q", cc)
	}
}
