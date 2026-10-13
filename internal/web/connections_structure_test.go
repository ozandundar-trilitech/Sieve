package web

import (
	"io"
	"regexp"
	"strings"
	"testing"

	"github.com/trilitech/Sieve/internal/connector"
	asanaconn "github.com/trilitech/Sieve/internal/connectors/asana"
	githubconn "github.com/trilitech/Sieve/internal/connectors/github"
	gitlabconn "github.com/trilitech/Sieve/internal/connectors/gitlab"
	"github.com/trilitech/Sieve/internal/connectors/gmail"
	"github.com/trilitech/Sieve/internal/connectors/httpproxy"
	linearconn "github.com/trilitech/Sieve/internal/connectors/linear"
	"github.com/trilitech/Sieve/internal/connectors/mcpproxy"
	notionconn "github.com/trilitech/Sieve/internal/connectors/notion"
	slackconn "github.com/trilitech/Sieve/internal/connectors/slack"
)

// TestConnectionsPage_AccordionRowsAreSiblings guards the connector accordion
// markup: every row must be a top-level <details class="accordion">, never
// nested in another row. A misplaced </details> once put each catalog row
// inside the previous one (GitHub under GitLab, Asana under Linear). The page
// is rendered with several connectors per category so that shows up.
func TestConnectionsPage_AccordionRowsAreSiblings(t *testing.T) {
	ts, env, _ := eventsTestServer(t)
	for _, r := range []struct {
		meta    connector.ConnectorMeta
		factory connector.Factory
	}{
		{gmail.Meta, gmail.Factory},
		{httpproxy.Meta, httpproxy.Factory},
		{mcpproxy.Meta, mcpproxy.Factory},
		{githubconn.Meta(), githubconn.Factory()},
		{gitlabconn.Meta(), gitlabconn.Factory()},
		{slackconn.Meta(), slackconn.Factory()},
		{linearconn.Meta(), linearconn.Factory()},
		{notionconn.Meta(), notionconn.Factory()},
		{asanaconn.Meta(), asanaconn.Factory()},
	} {
		env.Registry.Register(r.meta, r.factory)
	}

	resp, err := env.AdminClient().Get(ts.URL + "/connections")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("GET /connections = %d", resp.StatusCode)
	}

	rows, problems := accordionNesting(string(body))
	for _, p := range problems {
		t.Error(p)
	}
	for _, want := range []string{"github", "gitlab", "linear", "asana", "slack", "llm-anthropic", "cloud-aws"} {
		if !rows[want] {
			t.Errorf("connector row %q missing from the page", want)
		}
	}
}

var (
	tagRE    = regexp.MustCompile(`<(/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>`)
	idRE     = regexp.MustCompile(`\bid="([^"]*)"`)
	skipRE   = regexp.MustCompile(`(?s)<!--.*?-->|<script\b.*?</script>|<style\b.*?</style>`)
	voidTags = map[string]bool{
		"area": true, "base": true, "br": true, "col": true, "embed": true, "hr": true, "img": true,
		"input": true, "link": true, "meta": true, "source": true, "track": true, "wbr": true,
		"path": true, "circle": true, "rect": true, "line": true, "polyline": true, "polygon": true,
		"ellipse": true, "stop": true, "use": true,
	}
)

// accordionNesting scans HTML, returning the ids of accordion rows and any
// structural problems: a row opened inside another row, or a closing tag that
// does not match the innermost open element.
func accordionNesting(doc string) (rows map[string]bool, problems []string) {
	doc = skipRE.ReplaceAllString(doc, "")
	rows = map[string]bool{}
	type open struct{ tag, id string }
	var stack []open
	for _, m := range tagRE.FindAllStringSubmatch(doc, -1) {
		closing, tag, attrs := m[1] == "/", strings.ToLower(m[2]), m[3]
		if voidTags[tag] || strings.HasSuffix(strings.TrimSpace(attrs), "/") {
			continue
		}
		if !closing {
			id := ""
			if im := idRE.FindStringSubmatch(attrs); im != nil {
				id = im[1]
			}
			if tag == "details" && strings.Contains(attrs, "accordion") {
				rows[id] = true
				for _, o := range stack {
					if o.tag == "details" && o.id != "" {
						problems = append(problems, "row "+id+" is nested inside row "+o.id)
					}
				}
			}
			stack = append(stack, open{tag, id})
			continue
		}
		if len(stack) == 0 || stack[len(stack)-1].tag != tag {
			top := "(nothing)"
			if len(stack) > 0 {
				top = "<" + stack[len(stack)-1].tag + ">"
			}
			problems = append(problems, "</"+tag+"> does not close the innermost open element "+top)
			// Recover like a browser would: pop to the matching element if any.
			for i := len(stack) - 1; i >= 0; i-- {
				if stack[i].tag == tag {
					stack = stack[:i]
					break
				}
			}
			continue
		}
		stack = stack[:len(stack)-1]
	}
	return rows, problems
}
