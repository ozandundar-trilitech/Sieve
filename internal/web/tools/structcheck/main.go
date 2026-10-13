// Command structcheck proves that a restyle of the admin templates changed
// only presentation. It compares two copies of each template (before and
// after) and fails if any behaviour-bearing piece differs:
//
//   - every Go template action ({{...}}), in order: the data the page uses
//     and the control flow around it;
//   - every behaviour attribute, as a multiset of (tag, attr, value):
//     action, method, name, value, id, for, type, href, target, hx-*,
//     data-*, on* handlers, role, aria-*, required, disabled, checked,
//     selected, multiple, autocomplete, pattern, min/max/step, accept,
//     form, rel, src, integrity;
//   - every <script> body, after dropping tokens that are CSS class names
//     (so class strings built in inline JS may change, nothing else may).
//
// Usage:
//
//	go run ./internal/web/tools/structcheck -old <dir> -new internal/web/templates [-allow id=foo,onclick=bar()]
//
// <dir> is a snapshot of the templates directory taken before the restyle
// (for example `git archive <ref> internal/web/templates | tar -x -C /tmp/old`).
// -allow lists attr=value pairs that may appear only in the new version
// (deliberate additions such as the theme toggle).
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var (
	actionRe    = regexp.MustCompile(`(?s)\{\{.*?\}\}`)
	scriptRe    = regexp.MustCompile(`(?is)<script\b([^>]*)>(.*?)</script>`)
	commentRe   = regexp.MustCompile(`(?s)<!--.*?-->`)
	tagRe       = regexp.MustCompile(`(?s)<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>`)
	attrRe      = regexp.MustCompile(`([a-zA-Z_:@][-a-zA-Z0-9_:.@]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+))?`)
	classRe     = regexp.MustCompile(`(?:class|className)\s*[=:]\s*("[^"]*"|'[^']*')`)
	listArgRe   = regexp.MustCompile(`classList\.(?:add|remove|toggle|contains|replace)\(([^)]*)\)`)
	jsTokRe     = regexp.MustCompile(`[A-Za-z0-9_:/.\-\[\]%#!]+|[^\sA-Za-z0-9_:/.\-\[\]%#!]`)
	classWordRe = regexp.MustCompile(`^[a-z!-][A-Za-z0-9_:/.\-\[\]%#!]*$`)
	colourRe    = regexp.MustCompile(`^(?:[a-z-]+:)*-?(?:bg|text|border|ring|ring-offset|divide|placeholder|from|to|via|fill|stroke|outline|accent|shadow|decoration)-[a-z]+(?:-[0-9]+)?(?:/[0-9]+)?$`)
)

var behaviourAttrs = map[string]bool{
	"action": true, "method": true, "name": true, "value": true, "id": true,
	"for": true, "type": true, "href": true, "target": true, "role": true,
	"required": true, "disabled": true, "checked": true, "selected": true,
	"multiple": true, "autocomplete": true, "pattern": true, "min": true,
	"max": true, "step": true, "accept": true, "form": true, "rel": true,
	"src": true, "integrity": true, "crossorigin": true, "readonly": true,
	"maxlength": true, "minlength": true, "enctype": true, "autofocus": true,
	"open": true, "hidden": true, "tabindex": true, "spellcheck": true,
	"placeholder": true, "title": true, "download": true, "contenteditable": true,
}

func isBehaviourAttr(a string) bool {
	a = strings.ToLower(a)
	return behaviourAttrs[a] || strings.HasPrefix(a, "hx-") || strings.HasPrefix(a, "data-") ||
		strings.HasPrefix(a, "on") || strings.HasPrefix(a, "aria-")
}

type extract struct {
	actions []string
	attrs   map[string]int
	scripts []string
	classes map[string]bool
}

func classTokens(src string) map[string]bool {
	out := map[string]bool{}
	for _, m := range classRe.FindAllStringSubmatch(src, -1) {
		for _, t := range strings.Fields(strings.Trim(m[1], `"'`)) {
			// Only class-shaped words: a class string built in JS
			// (class="a ' + x + '") also yields quotes and operators,
			// which must stay visible to the script comparison.
			if classWordRe.MatchString(t) {
				out[t] = true
			}
		}
	}
	for _, m := range listArgRe.FindAllStringSubmatch(src, -1) {
		for _, t := range regexp.MustCompile(`'([^']*)'|"([^"]*)"`).FindAllStringSubmatch(m[1], -1) {
			for _, f := range strings.Fields(t[1] + t[2]) {
				out[f] = true
			}
		}
	}
	return out
}

// headRe matches the document <head>. Heads are boilerplate (stylesheet,
// fonts, vendored script tags) that the restyle replaces on purpose, so
// their markup is excluded; inline head scripts are still compared.
var headRe = regexp.MustCompile(`(?is)<head>.*?</head>`)

func parse(src string) extract {
	var headScripts []string
	if h := headRe.FindString(src); h != "" {
		for _, m := range scriptRe.FindAllStringSubmatch(h, -1) {
			if !strings.Contains(m[1], "src=") && strings.TrimSpace(m[2]) != "" {
				headScripts = append(headScripts, m[0])
			}
		}
		src = headRe.ReplaceAllString(src, strings.Join(headScripts, "\n"))
	}
	e := extract{attrs: map[string]int{}, classes: classTokens(src)}
	for _, a := range actionRe.FindAllString(src, -1) {
		e.actions = append(e.actions, a)
	}
	// Replace actions with a neutral placeholder so nested quotes inside
	// {{if eq .X "y"}} do not confuse the attribute scanner.
	noAct := actionRe.ReplaceAllString(src, "\x00")
	for _, m := range scriptRe.FindAllStringSubmatch(noAct, -1) {
		e.scripts = append(e.scripts, m[2])
	}
	markup := scriptRe.ReplaceAllString(noAct, "<script$1></script>")
	markup = commentRe.ReplaceAllString(markup, "")
	for _, t := range tagRe.FindAllStringSubmatch(markup, -1) {
		tag := strings.ToLower(t[1])
		for _, a := range attrRe.FindAllStringSubmatch(t[2], -1) {
			if !isBehaviourAttr(a[1]) {
				continue
			}
			val := strings.Trim(a[2], `"'`)
			e.attrs[tag+" "+strings.ToLower(a[1])+"="+val]++
		}
	}
	return e
}

func scriptTokens(s string, classes map[string]bool) []string {
	var out []string
	for _, t := range jsTokRe.FindAllString(s, -1) {
		if classes[t] || colourRe.MatchString(t) {
			continue
		}
		out = append(out, t)
	}
	return out
}

func diffStrings(a, b []string) (int, string, string) {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return i, a[i], b[i]
		}
	}
	if len(a) != len(b) {
		var x, y string
		if n < len(a) {
			x = a[n]
		}
		if n < len(b) {
			y = b[n]
		}
		return n, x, y
	}
	return -1, "", ""
}

func compare(name, oldSrc, newSrc string, allow map[string]bool) []string {
	var problems []string
	o, n := parse(oldSrc), parse(newSrc)
	if i, x, y := diffStrings(o.actions, n.actions); i >= 0 {
		problems = append(problems, fmt.Sprintf("template action #%d differs: old %q new %q", i, x, y))
	}
	keys := map[string]bool{}
	for k := range o.attrs {
		keys[k] = true
	}
	for k := range n.attrs {
		keys[k] = true
	}
	sorted := make([]string, 0, len(keys))
	for k := range keys {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)
	for _, k := range sorted {
		if o.attrs[k] == n.attrs[k] {
			continue
		}
		attr := k[strings.Index(k, " ")+1:]
		if n.attrs[k] > o.attrs[k] && allow[attr] {
			continue
		}
		problems = append(problems, fmt.Sprintf("attr %s: old x%d new x%d", k, o.attrs[k], n.attrs[k]))
	}
	classes := map[string]bool{}
	for k := range o.classes {
		classes[k] = true
	}
	for k := range n.classes {
		classes[k] = true
	}
	if len(o.scripts) != len(n.scripts) {
		problems = append(problems, fmt.Sprintf("script block count: old %d new %d", len(o.scripts), len(n.scripts)))
	} else {
		for i := range o.scripts {
			a, b := scriptTokens(o.scripts[i], classes), scriptTokens(n.scripts[i], classes)
			if j, x, y := diffStrings(a, b); j >= 0 {
				problems = append(problems, fmt.Sprintf("script #%d token %d differs: old %q new %q", i, j, x, y))
			}
		}
	}
	return problems
}

func main() {
	oldDir := flag.String("old", "", "directory with the pre-restyle templates")
	newDir := flag.String("new", "internal/web/templates", "directory with the restyled templates")
	allowFlag := flag.String("allow", "", "comma-separated attr=value pairs allowed only in the new version")
	flag.Parse()
	if *oldDir == "" {
		fmt.Fprintln(os.Stderr, "usage: structcheck -old <dir> [-new <dir>] [-allow a=b,c=d]")
		os.Exit(2)
	}
	allow := map[string]bool{}
	for _, a := range strings.Split(*allowFlag, ",") {
		if a = strings.TrimSpace(a); a != "" {
			allow[a] = true
		}
	}
	files, _ := filepath.Glob(filepath.Join(*oldDir, "*.html"))
	failed := false
	for _, f := range files {
		base := filepath.Base(f)
		ob, err := os.ReadFile(f)
		if err != nil {
			fmt.Println(err)
			os.Exit(2)
		}
		nb, err := os.ReadFile(filepath.Join(*newDir, base))
		if err != nil {
			fmt.Printf("FAIL %s: %v\n", base, err)
			failed = true
			continue
		}
		p := compare(base, string(ob), string(nb), allow)
		if len(p) == 0 {
			oe := parse(string(ob))
			total := 0
			for _, c := range oe.attrs {
				total += c
			}
			fmt.Printf("ok   %-26s %4d actions, %4d behaviour attrs, %2d scripts identical\n", base, len(oe.actions), total, len(oe.scripts))
			continue
		}
		failed = true
		fmt.Printf("FAIL %s\n", base)
		for _, x := range p {
			fmt.Println("     " + x)
		}
	}
	if failed {
		os.Exit(1)
	}
}
