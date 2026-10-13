package connections_test

import (
	"testing"
	"time"

	"github.com/trilitech/Sieve/internal/connections"
	"github.com/trilitech/Sieve/internal/events"
)

func TestConnectionEvents_ReauthTransitionNotifiesOnce(t *testing.T) {
	svc, _ := setup(t)
	hub := events.NewHub()
	svc.SetEvents(hub)
	if err := svc.Add("work", "mock", "Work Gmail", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	ch, cancel := hub.Subscribe()
	defer cancel()

	// Transition active → reauth_required: one event.
	if err := svc.SetStatusWithReason("work", connections.StatusReauthRequired, "invalid_grant"); err != nil {
		t.Fatal(err)
	}
	// Repeats (hourly sweep, second refresh failure, plain SetStatus): none.
	_ = svc.SetStatusWithReason("work", connections.StatusReauthRequired, "invalid_grant again")
	_ = svc.SetStatus("work", connections.StatusReauthRequired)

	var got []events.Event
	timeout := time.After(200 * time.Millisecond)
loop:
	for {
		select {
		case e := <-ch:
			got = append(got, e)
		case <-timeout:
			break loop
		}
	}
	if len(got) != 1 {
		t.Fatalf("want exactly one reauth event, got %d: %+v", len(got), got)
	}
	e := got[0]
	if e.Type != events.TypeConnectionReauthRequired || e.Data["connection_id"] != "work" ||
		e.Data["display_name"] != "Work Gmail" || e.Data["reason"] != "invalid_grant" {
		t.Fatalf("unexpected event %+v", e)
	}

	// Recover, then fail again: a fresh transition notifies again.
	_ = svc.SetStatus("work", connections.StatusActive)
	_ = svc.SetStatus("work", connections.StatusReauthRequired)
	select {
	case e := <-ch:
		if e.Type != events.TypeConnectionReauthRequired {
			t.Fatalf("unexpected %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("re-entering reauth_required after recovery should notify")
	}
}

func TestConnectionEvents_DisableDoesNotNotify(t *testing.T) {
	svc, _ := setup(t)
	hub := events.NewHub()
	svc.SetEvents(hub)
	_ = svc.Add("work", "mock", "Work", map[string]any{})
	ch, cancel := hub.Subscribe()
	defer cancel()
	_ = svc.SetStatus("work", connections.StatusDisabled)
	select {
	case e := <-ch:
		t.Fatalf("disable is an operator action, not a notification: %+v", e)
	case <-time.After(100 * time.Millisecond):
	}
}
