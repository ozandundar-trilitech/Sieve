package web

import (
	"bufio"
	"bytes"
	"errors"
	"net"
	"net/http"
	"strings"
)

// styledErrors renders the admin server's plain-text error responses (what
// http.Error and the mux's default 404 write) as a styled HTML page, for
// top-level browser navigations only. Presentation only: the status code and
// the message text are unchanged, and noCacheAllAdmin (which wraps this) has
// already set the security and no-store headers.
//
// Never touched: fetch/XHR/htmx callers (no navigation signal, or an
// HX-Request header), the SSE stream (/events), JSON and API endpoints, static
// assets, any successful response, and any error that is not text/plain. A
// response is only buffered once the handler has committed to a >=400
// text/plain status, so 200s and streams pass straight through. The agent API
// port (19817) has its own router and is not affected.
func (s *Server) styledErrors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !wantsStyledError(r) {
			next.ServeHTTP(w, r)
			return
		}
		ew := &errorPageWriter{ResponseWriter: w}
		next.ServeHTTP(ew, r)
		if ew.buffering {
			s.writeErrorPage(w, ew.status, ew.buf.String())
		}
	})
}

func wantsStyledError(r *http.Request) bool {
	p := r.URL.Path
	if p == "/events" || strings.HasPrefix(p, "/static/") || strings.HasPrefix(p, "/api/") || strings.HasSuffix(p, ".json") {
		return false
	}
	if r.Header.Get("HX-Request") != "" {
		return false
	}
	if r.Header.Get("Sec-Fetch-Mode") == "navigate" {
		return true
	}
	if r.Header.Get("Sec-Fetch-Mode") != "" {
		return false // cors / same-origin / no-cors: a script fetch
	}
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

// errorPageWriter passes everything through unless the handler writes a
// >=400 status with a text/plain body, in which case it captures the body.
type errorPageWriter struct {
	http.ResponseWriter
	wroteHeader bool
	buffering   bool
	status      int
	buf         bytes.Buffer
}

func (e *errorPageWriter) WriteHeader(code int) {
	if e.wroteHeader {
		return
	}
	e.wroteHeader = true
	ct := e.Header().Get("Content-Type")
	if code >= 400 && strings.HasPrefix(ct, "text/plain") {
		e.buffering = true
		e.status = code
		return
	}
	e.ResponseWriter.WriteHeader(code)
}

func (e *errorPageWriter) Write(b []byte) (int, error) {
	if !e.wroteHeader {
		e.WriteHeader(http.StatusOK)
	}
	if e.buffering {
		return e.buf.Write(b)
	}
	return e.ResponseWriter.Write(b)
}

// Flush and Unwrap keep http.ResponseController and streaming handlers
// working through the wrapper.
func (e *errorPageWriter) Flush() {
	if e.buffering {
		return
	}
	if f, ok := e.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (e *errorPageWriter) Unwrap() http.ResponseWriter { return e.ResponseWriter }

func (e *errorPageWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := e.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, errors.New("hijack not supported")
}

type errorPageData struct {
	Status  int
	Title   string
	Message string
}

func errorTitle(status int, msg string) string {
	switch {
	case status == http.StatusNotFound:
		return "Page not found"
	case status == http.StatusForbidden:
		return "Not allowed"
	case status == http.StatusUnauthorized:
		return "Sign in required"
	case status == http.StatusServiceUnavailable && strings.Contains(strings.ToLower(msg), "lock"):
		return "Sieve is locked"
	case status >= 500:
		return "Sieve hit an error"
	default:
		return "Something went wrong with that request"
	}
}

func (s *Server) writeErrorPage(w http.ResponseWriter, status int, msg string) {
	msg = strings.TrimSpace(msg)
	h := w.Header()
	h.Del("Content-Length")
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	t, ok := s.templates["error"]
	if !ok {
		_, _ = w.Write([]byte(msg))
		return
	}
	_ = t.ExecuteTemplate(w, "error", errorPageData{Status: status, Title: errorTitle(status, msg), Message: msg})
}
