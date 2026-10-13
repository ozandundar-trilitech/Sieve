package events

import (
	"sync"
	"testing"
	"time"
)

func TestPublishSubscribe(t *testing.T) {
	h := NewHub()
	ch, cancel := h.Subscribe()
	defer cancel()
	h.Publish(Event{Type: TypeApprovalPending, Data: map[string]any{"id": "a1"}})
	select {
	case e := <-ch:
		if e.Type != TypeApprovalPending || e.Data["id"] != "a1" || e.Time.IsZero() {
			t.Fatalf("got %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("no event")
	}
}

func TestNilHubIsNoop(t *testing.T) {
	var h *Hub
	h.Publish(Event{Type: "x"}) // must not panic
	h.Close()
}

func TestSlowSubscriberDropsOldestAndNeverBlocks(t *testing.T) {
	h := NewHub()
	h.buffer = 3
	ch, cancel := h.Subscribe()
	defer cancel()
	done := make(chan struct{})
	go func() {
		for i := 0; i < 10; i++ {
			h.Publish(Event{Type: "n", Data: map[string]any{"i": i}})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Publish blocked on a full subscriber")
	}
	var got []int
	for len(ch) > 0 {
		got = append(got, (<-ch).Data["i"].(int))
	}
	if len(got) != 3 || got[0] != 7 || got[2] != 9 {
		t.Fatalf("want the newest 3 events [7 8 9], got %v", got)
	}
}

func TestCancelAndCloseCloseChannels(t *testing.T) {
	h := NewHub()
	ch1, cancel1 := h.Subscribe()
	ch2, _ := h.Subscribe()
	cancel1()
	cancel1() // idempotent
	if _, open := <-ch1; open {
		t.Fatal("ch1 should be closed after cancel")
	}
	h.Close()
	if _, open := <-ch2; open {
		t.Fatal("ch2 should be closed after hub Close")
	}
	ch3, cancel3 := h.Subscribe()
	defer cancel3()
	if _, open := <-ch3; open {
		t.Fatal("subscribe after Close should return a closed channel")
	}
	h.Publish(Event{Type: "after-close"}) // must not panic
}

func TestConcurrentPublishCancel(t *testing.T) {
	h := NewHub()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(2)
		ch, cancel := h.Subscribe()
		go func() {
			defer wg.Done()
			for range ch {
			}
		}()
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				h.Publish(Event{Type: "x"})
			}
			cancel()
		}()
	}
	wg.Wait()
	if n := h.Subscribers(); n != 0 {
		t.Fatalf("subscribers leaked: %d", n)
	}
}

func TestThrottle(t *testing.T) {
	now := time.Unix(0, 0)
	th := NewThrottle(time.Minute)
	th.now = func() time.Time { return now }

	if ok, n := th.Allow("k"); !ok || n != 1 {
		t.Fatalf("first: ok=%v n=%d", ok, n)
	}
	for i := 0; i < 5; i++ {
		now = now.Add(time.Second)
		if ok, _ := th.Allow("k"); ok {
			t.Fatal("repeat inside window should be suppressed")
		}
	}
	if ok, _ := th.Allow("other"); !ok {
		t.Fatal("a different key is independent")
	}
	now = now.Add(time.Minute)
	if ok, n := th.Allow("k"); !ok || n != 6 {
		t.Fatalf("after window: ok=%v n=%d, want true 6 (5 suppressed + this one)", ok, n)
	}
}
