package audit_test

import (
	"testing"
	"time"

	"github.com/trilitech/Sieve/internal/audit"
	"github.com/trilitech/Sieve/internal/events"
	"github.com/trilitech/Sieve/internal/testing/testenv"
)

func drain(ch <-chan events.Event) []events.Event {
	var out []events.Event
	for {
		select {
		case e := <-ch:
			out = append(out, e)
		case <-time.After(100 * time.Millisecond):
			return out
		}
	}
}

func TestAuditEvents_DenyPublishesThrottled(t *testing.T) {
	env := testenv.New(t)
	hub := events.NewHub()
	env.Audit.SetEvents(hub)
	ch, cancel := hub.Subscribe()
	defer cancel()

	deny := &audit.LogRequest{
		TokenID: "t1", TokenName: "claude-desktop", ConnectionID: "work",
		Operation: "send_email", PolicyResult: "deny", ResponseSummary: "no grant",
		Params: map[string]any{"body": "SECRET"},
	}
	for i := 0; i < 5; i++ {
		if err := env.Audit.Log(deny); err != nil {
			t.Fatal(err)
		}
	}
	got := drain(ch)
	if len(got) != 1 {
		t.Fatalf("5 identical denies in the window should notify once, got %d", len(got))
	}
	e := got[0]
	if e.Type != events.TypePolicyDenied || e.Data["token_name"] != "claude-desktop" || e.Data["reason"] != "no grant" || e.Data["count"] != 1 {
		t.Fatalf("unexpected event %+v", e)
	}
	if _, ok := e.Data["params"]; ok {
		t.Fatal("params must never be in a notification")
	}
}

func TestAuditEvents_OnlyAgentDenies(t *testing.T) {
	env := testenv.New(t)
	hub := events.NewHub()
	env.Audit.SetEvents(hub)
	ch, cancel := hub.Subscribe()
	defer cancel()

	_ = env.Audit.Log(&audit.LogRequest{TokenID: "t", Operation: "list", PolicyResult: "allow"})
	_ = env.Audit.Log(&audit.LogRequest{Operation: "x", PolicyResult: "deny", ActorKind: "operator"})
	_ = env.Audit.LogOperator("admin", "token.create", "t", nil, "deny")
	if got := drain(ch); len(got) != 0 {
		t.Fatalf("allow / operator rows must not notify, got %+v", got)
	}
}
