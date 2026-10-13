// Package events is an in-process publish/subscribe hub for operator-facing
// notifications: an approval is waiting, a connection needs re-auth, an agent
// was denied. The admin UI streams these to the desktop shell over
// server-sent events (GET /events), which turns them into native OS
// notifications.
//
// Design constraints:
//   - Publishing never blocks a request path. Each subscriber has a bounded
//     buffer; when it is full the OLDEST queued event is dropped, so a stalled
//     client can neither slow agents down nor grow memory without bound.
//   - A nil *Hub is a valid no-op publisher, so services wire it optionally
//     and tests that don't care need no setup.
//   - Payloads are notification-sized summaries. Publishers must never put
//     message bodies, credentials, or raw request params in Data: a
//     notification can be visible on a locked screen.
package events

import (
	"sync"
	"time"
)

// Event types. The desktop shell switches on these strings; treat them as a
// stable contract.
const (
	TypeApprovalPending          = "approval.pending"
	TypeApprovalResolved         = "approval.resolved"
	TypeConnectionReauthRequired = "connection.reauth_required"
	TypePolicyDenied             = "policy.denied"
)

// Event is one notification. Data must be JSON-serialisable.
type Event struct {
	Type string         `json:"type"`
	Time time.Time      `json:"time"`
	Data map[string]any `json:"data"`
}

// DefaultBuffer is the per-subscriber queue depth.
const DefaultBuffer = 64

// Hub fans events out to subscribers.
type Hub struct {
	mu     sync.Mutex
	subs   map[*subscriber]struct{}
	closed bool
	buffer int
	now    func() time.Time
}

type subscriber struct {
	ch chan Event
}

// NewHub returns an empty hub.
func NewHub() *Hub {
	return &Hub{subs: make(map[*subscriber]struct{}), buffer: DefaultBuffer, now: time.Now}
}

// Publish delivers e to every current subscriber without blocking. A zero
// e.Time is stamped with the current time. Safe on a nil Hub (no-op).
func (h *Hub) Publish(e Event) {
	if h == nil {
		return
	}
	if e.Time.IsZero() {
		e.Time = h.now().UTC()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	for s := range h.subs {
		select {
		case s.ch <- e:
		default:
			// Full: drop the oldest queued event, then enqueue. Holding h.mu
			// means no other publisher races us for the freed slot; the
			// consumer may also have drained it, which is fine.
			select {
			case <-s.ch:
			default:
			}
			select {
			case s.ch <- e:
			default:
			}
		}
	}
}

// Subscribe registers a subscriber. The returned channel is closed when
// cancel is called or the hub is closed. cancel is idempotent.
func (h *Hub) Subscribe() (<-chan Event, func()) {
	s := &subscriber{ch: make(chan Event, h.buffer)}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		close(s.ch)
		return s.ch, func() {}
	}
	h.subs[s] = struct{}{}
	h.mu.Unlock()

	var once sync.Once
	return s.ch, func() {
		once.Do(func() {
			h.mu.Lock()
			if _, ok := h.subs[s]; ok {
				delete(h.subs, s)
				close(s.ch)
			}
			h.mu.Unlock()
		})
	}
}

// Close closes every subscriber channel and rejects future subscriptions.
// Wire it to http.Server.RegisterOnShutdown so open SSE streams end before
// graceful shutdown waits on them. Idempotent.
func (h *Hub) Close() {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	for s := range h.subs {
		delete(h.subs, s)
		close(s.ch)
	}
}

// Subscribers reports the current subscriber count (tests, diagnostics).
func (h *Hub) Subscribers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

// Throttle suppresses repeats of the same key within a window and reports how
// many were suppressed, so a looping agent produces one notification per
// window ("denied 37 times") instead of a flood.
type Throttle struct {
	mu     sync.Mutex
	window time.Duration
	now    func() time.Time
	last   map[string]time.Time
	count  map[string]int
}

// NewThrottle returns a throttle with the given window.
func NewThrottle(window time.Duration) *Throttle {
	return &Throttle{window: window, now: time.Now, last: map[string]time.Time{}, count: map[string]int{}}
}

// Allow records one occurrence of key. It returns ok=true when the caller
// should emit, with n = occurrences since the previous emission (including
// this one). Within the window it returns ok=false and counts silently.
func (t *Throttle) Allow(key string) (ok bool, n int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	t.count[key]++
	if last, seen := t.last[key]; seen && now.Sub(last) < t.window {
		return false, 0
	}
	n = t.count[key]
	t.last[key] = now
	t.count[key] = 0
	// Opportunistic GC so keys from long-gone agents don't accumulate.
	if len(t.last) > 4096 {
		for k, ts := range t.last {
			if now.Sub(ts) >= t.window && t.count[k] == 0 {
				delete(t.last, k)
				delete(t.count, k)
			}
		}
	}
	return true, n
}
