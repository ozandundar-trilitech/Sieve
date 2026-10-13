// Package docs embeds the user-facing documentation pages (the top-level
// *.md files) so the admin UI's /docs pages work no matter what directory the
// server runs from: the desktop app runs it from its data folder, and the
// Docker image ships only the binary. Subdirectories (architecture notes) are
// not embedded.
package docs

import "embed"

//go:embed *.md
var FS embed.FS
