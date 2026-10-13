package approval_test

import (
	"testing"
	"time"

	"github.com/trilitech/Sieve/internal/approval"
	"github.com/trilitech/Sieve/internal/events"
	"github.com/trilitech/Sieve/internal/testing/testenv"
)

func next(t *testing.T, ch <-chan events.Event) events.Event {
	t.Helper()
	select {
	case e := <-ch:
		return e
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for event")
		return events.Event{}
	}
}

func TestQueueEvents_PendingCarriesKeysNotValues(t *testing.T) {
	env := testenv.New(t)
	hub := events.NewHub()
	env.Approval.SetEvents(hub)
	ch, cancel := hub.Subscribe()
	defer cancel()

	item, err := env.Approval.Submit(&approval.SubmitRequest{
		TokenID: "tok-1", ConnectionID: "work", Operation: "send_email",
		RequestData: map[string]any{"to": "ceo@example.com", "body": "TOP SECRET"},
	})
	if err != nil {
		t.Fatal(err)
	}
	e := next(t, ch)
	if e.Type != events.TypeApprovalPending || e.Data["id"] != item.ID || e.Data["operation"] != "send_email" {
		t.Fatalf("unexpected event %+v", e)
	}
	keys, _ := e.Data["param_keys"].([]string)
	if len(keys) != 2 || keys[0] != "body" || keys[1] != "to" {
		t.Fatalf("param_keys = %v, want [body to]", keys)
	}
	for k, v := range e.Data {
		if s, ok := v.(string); ok && (s == "TOP SECRET" || s == "ceo@example.com") {
			t.Fatalf("param value leaked into event field %q", k)
		}
	}

	if err := env.Approval.Approve(item.ID); err != nil {
		t.Fatal(err)
	}
	e = next(t, ch)
	if e.Type != events.TypeApprovalResolved || e.Data["id"] != item.ID || e.Data["status"] != "approved" {
		t.Fatalf("unexpected resolved event %+v", e)
	}
}

func TestQueueEvents_DoubleResolveDoesNotRepublish(t *testing.T) {
	env := testenv.New(t)
	hub := events.NewHub()
	env.Approval.SetEvents(hub)
	item := submitTestItem(t, env.Approval, "op")
	ch, cancel := hub.Subscribe()
	defer cancel()
	_ = env.Approval.Reject(item.ID)
	_ = env.Approval.Approve(item.ID) // already resolved → error, no event
	next(t, ch)
	select {
	case e := <-ch:
		t.Fatalf("second resolve must not publish, got %+v", e)
	case <-time.After(100 * time.Millisecond):
	}
}
