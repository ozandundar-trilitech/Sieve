package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/trilitech/Sieve/internal/approval"
	"github.com/trilitech/Sieve/internal/events"
	"github.com/trilitech/Sieve/internal/session"
)

// events.go serves the desktop shell's two notification endpoints:
//
//   GET /events                 server-sent events stream (internal/events)
//   GET /approvals/pending.json pending approvals snapshot (tray badge,
//                               resync after a reconnect)
//
// Both sit behind requireOperatorSession (neither path is auth-exempt), so
// they need a live operator session cookie and refuse agent bearer tokens.
// Payloads are notification-sized: ids, names, operation, param NAMES — never
// param values, message bodies, or credentials.

// eventsHeartbeat is how often /events writes a keep-alive comment and
// re-checks the session. A var so tests can shorten it.
var eventsHeartbeat = 15 * time.Second

// SetEvents wires the notification hub streamed at GET /events.
func (s *Server) SetEvents(h *events.Hub) { s.events = h }

// pendingApprovalView is one approval in the JSON snapshot and the enriched
// approval.pending event.
type pendingApprovalView struct {
	ID           string    `json:"id"`
	TokenID      string    `json:"token_id"`
	TokenName    string    `json:"token_name"`
	ConnectionID string    `json:"connection_id"`
	Operation    string    `json:"operation"`
	ParamKeys    []string  `json:"param_keys"`
	CreatedAt    time.Time `json:"created_at"`
}

func (s *Server) tokenName(id string) string {
	if id == "" || s.tokens == nil {
		return ""
	}
	if tok, err := s.tokens.Get(id); err == nil {
		return tok.Name
	}
	return ""
}

func (s *Server) handleApprovalsPendingJSON(w http.ResponseWriter, r *http.Request) {
	items, err := s.approval.ListPending()
	if err != nil {
		http.Error(w, "list pending approvals: "+err.Error(), http.StatusInternalServerError)
		return
	}
	names := map[string]string{}
	out := make([]pendingApprovalView, 0, len(items))
	for _, it := range items {
		if _, ok := names[it.TokenID]; !ok {
			names[it.TokenID] = s.tokenName(it.TokenID)
		}
		out = append(out, pendingApprovalView{
			ID: it.ID, TokenID: it.TokenID, TokenName: names[it.TokenID],
			ConnectionID: it.ConnectionID, Operation: it.Operation,
			ParamKeys: approval.ParamKeys(it.RequestData), CreatedAt: it.CreatedAt,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"count": len(out), "approvals": out})
}

// handleEvents streams hub events as server-sent events.
//
// Wire format (one frame per event):
//
//	event: approval.pending
//	data: {"type":"approval.pending","time":"…","data":{…}}
//
// The first frame is "hello", carrying the session's CSRF token (so the shell
// can POST approve/reject without scraping HTML) and the pending count. A
// ": ping" comment every eventsHeartbeat keeps proxies and idle timers from
// closing the stream. On each heartbeat the session is re-checked WITHOUT
// sliding its expiry; when it has ended the stream sends "session_ended" and
// closes, and the shell re-authenticates.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if s.events == nil {
		http.Error(w, "event stream not configured", http.StatusServiceUnavailable)
		return
	}
	rc := http.NewResponseController(w)

	var cookieValue string
	if c, err := r.Cookie(session.CookieName); err == nil {
		cookieValue = c.Value
	}
	var csrfToken string
	if sess := sessionFromContext(r); sess != nil {
		csrfToken = sess.CSRFToken
	}
	pending := 0
	if items, err := s.approval.ListPending(); err == nil {
		pending = len(items)
	}

	// Subscribe BEFORE writing hello so nothing published in between is lost.
	ch, cancel := s.events.Subscribe()
	defer cancel()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	write := func(e events.Event) bool {
		b, err := json.Marshal(e)
		if err != nil {
			return true // skip an unserialisable event, keep the stream
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e.Type, b); err != nil {
			return false
		}
		return rc.Flush() == nil
	}

	if !write(events.Event{Type: "hello", Time: time.Now().UTC(), Data: map[string]any{
		"csrf_token":        csrfToken,
		"pending_approvals": pending,
		"heartbeat_seconds": int(eventsHeartbeat / time.Second),
	}}) {
		return
	}

	tick := time.NewTicker(eventsHeartbeat)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e, ok := <-ch:
			if !ok {
				return // hub closed: server shutting down
			}
			if !write(s.enrichEvent(e)) {
				return
			}
		case <-tick.C:
			if s.sessionMgr != nil && !s.sessionMgr.Valid(cookieValue) {
				write(events.Event{Type: "session_ended", Time: time.Now().UTC(), Data: map[string]any{}})
				return
			}
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil || rc.Flush() != nil {
				return
			}
		}
	}
}

// enrichEvent adds display names the publishers don't have (the approval
// queue only knows token IDs). It copies Data so the hub's shared map is
// never mutated across subscribers.
func (s *Server) enrichEvent(e events.Event) events.Event {
	if e.Type != events.TypeApprovalPending {
		return e
	}
	data := make(map[string]any, len(e.Data)+1)
	for k, v := range e.Data {
		data[k] = v
	}
	if id, _ := data["token_id"].(string); id != "" {
		data["token_name"] = s.tokenName(id)
	}
	e.Data = data
	return e
}
