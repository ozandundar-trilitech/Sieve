package web

//go:generate go run ./tools/genadmincss

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// staticFS holds the admin UI's build-time assets: the compiled
// stylesheet (static/admin.css, generated from styles/theme.css), the
// self-hosted fonts, the favicon, and vendored third-party scripts
// (htmx, marked, DOMPurify). Serving them from the binary keeps the admin
// UI working offline and lets the CSP drop every third-party host.
//
//go:embed static
var staticFS embed.FS

// staticRoot is staticFS rooted at static/, so URL paths map 1:1.
var staticRoot = func() fs.FS {
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err)
	}
	return sub
}()

// assetVersions maps a static file path to a short content hash, computed
// once at start-up. assetURL appends it as ?v= so browsers can cache the
// file indefinitely and still pick up a new build immediately.
var assetVersions = func() map[string]string {
	out := map[string]string{}
	_ = fs.WalkDir(staticRoot, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(staticRoot, p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		out[p] = hex.EncodeToString(sum[:])[:12]
		return nil
	})
	return out
}()

// assetURL is the template func behind {{asset "admin.css"}}.
func assetURL(name string) string {
	name = strings.TrimPrefix(path.Clean("/"+name), "/")
	if v, ok := assetVersions[name]; ok {
		return "/static/" + name + "?v=" + v
	}
	return "/static/" + name
}

// staticHandler serves /static/*. It is mounted on the ADMIN server only
// and is auth-exempt (see authExemptPrefixes): the login page needs its
// stylesheet before a session exists, and nothing under static/ is secret.
// Directory listings are refused.
func staticHandler() http.Handler {
	files := http.StripPrefix("/static/", http.FileServer(http.FS(staticRoot)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/") {
			http.NotFound(w, r)
			return
		}
		// noCacheAllAdmin stamped no-store on the way in; static assets
		// carry no credentials, so let browsers cache them. Versioned
		// URLs (?v=<hash>) never change content, so they are immutable.
		h := w.Header()
		h.Del("Pragma")
		h.Del("Expires")
		if r.URL.Query().Get("v") != "" {
			h.Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			h.Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}
