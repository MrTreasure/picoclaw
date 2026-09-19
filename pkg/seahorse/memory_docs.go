package seahorse

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// memoryDocHit is one matching daily note.
type memoryDocHit struct {
	Path    string `json:"path"`
	Date    string `json:"date"`
	Snippet string `json:"snippet"`
}

// docQuery is a pattern translated from the tool's FTS5-flavoured syntax into
// something that works against plain files.
type docQuery struct {
	// branches are OR-alternatives; every term inside one branch must appear.
	branches [][]string
	// excluded terms must not appear anywhere.
	excluded []string
}

// parseDocQuery turns the caller-facing pattern into a docQuery.
//
// The DB path speaks FTS5; files do not, so we support the subset the tool
// documents: "%" is stripped (FTS5 wildcard, no file equivalent), " OR " splits
// alternatives, " NOT x" excludes, and everything else in a branch must appear.
func parseDocQuery(pattern string) docQuery {
	flat := strings.ToLower(strings.ReplaceAll(pattern, "%", " "))

	var q docQuery
	for _, branch := range strings.Split(flat, " or ") {
		tokens := strings.Fields(branch)
		var terms []string
		for i := 0; i < len(tokens); i++ {
			tok := tokens[i]
			switch {
			case tok == "and" || tok == "&&" || tok == "or" || tok == "||" || tok == "":
				// Separators. Branch terms are conjunctive anyway; a bare "or"
				// (no surrounding spaces) carries no term of its own — treating
				// it as a search term would look for the literal word.
			case tok == "not" || tok == "!":
				if i+1 < len(tokens) {
					q.excluded = append(q.excluded, tokens[i+1])
					i++
				}
			default:
				terms = append(terms, tok)
			}
		}
		if len(terms) > 0 {
			q.branches = append(q.branches, terms)
		}
	}
	return q
}

// match reports whether content satisfies the query, and where the first
// matched term sits so the caller can pull a snippet around it.
func (q docQuery) match(content string) (int, bool) {
	low := strings.ToLower(content)
	for _, ex := range q.excluded {
		if strings.Contains(low, ex) {
			return 0, false
		}
	}
	for _, branch := range q.branches {
		first := -1
		ok := true
		for _, term := range branch {
			at := strings.Index(low, term)
			if at < 0 {
				ok = false
				break
			}
			if first < 0 || at < first {
				first = at
			}
		}
		if ok {
			return first, true
		}
	}
	return 0, false
}

// searchMemoryDocs greps the workspace memory directory for daily notes.
//
// Those notes were previously reachable only through the injected context
// window — three days wide — so anything older was effectively lost: they live
// on disk as markdown, not in seahorse's message or summary tables, so
// short_grep never saw them no matter how it was called. Scanning them here
// opens the whole archive to the same tool the agent already knows.
func searchMemoryDocs(workspace, pattern string, limit int) []memoryDocHit {
	if workspace == "" || strings.TrimSpace(pattern) == "" {
		return nil
	}
	query := parseDocQuery(pattern)
	if len(query.branches) == 0 {
		return nil
	}

	root := filepath.Join(workspace, "memory")
	var hits []memoryDocHit

	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(path, ".md") {
			return nil
		}
		// MEMORY.md is injected into every prompt already; re-surfacing it here
		// would only crowd out the notes the caller cannot otherwise reach.
		if entry.Name() == "MEMORY.md" {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		content := string(data)
		at, ok := query.match(content)
		if !ok {
			return nil
		}
		rel, relErr := filepath.Rel(workspace, path)
		if relErr != nil {
			rel = path
		}
		hits = append(hits, memoryDocHit{
			Path:    rel,
			Date:    docDateFromName(entry.Name()),
			Snippet: docSnippet(content, at),
		})
		return nil
	})

	// Newest first — recent context is usually what the caller is after.
	sort.Slice(hits, func(i, j int) bool { return hits[i].Date > hits[j].Date })
	if limit > 0 && len(hits) > limit {
		hits = hits[:limit]
	}
	return hits
}

const docSnippetWidth = 200

// docSnippet returns the line containing the match, trimmed and capped.
func docSnippet(content string, at int) string {
	if at < 0 {
		at = 0
	}
	if at > len(content) {
		at = len(content)
	}
	start := strings.LastIndexByte(content[:at], '\n') + 1
	end := strings.IndexByte(content[at:], '\n')
	if end < 0 {
		end = len(content) - at
	}
	line := strings.Join(strings.Fields(content[start:at+end]), " ")
	if len(line) > docSnippetWidth {
		line = line[:docSnippetWidth] + "…"
	}
	return line
}

// docDateFromName turns "20260919.md" into "2026-09-19" so results sort and
// read naturally. Anything unparseable is returned as-is.
func docDateFromName(name string) string {
	base := strings.TrimSuffix(name, ".md")
	if len(base) != 8 {
		return base
	}
	for _, r := range base {
		if r < '0' || r > '9' {
			return base
		}
	}
	return base[:4] + "-" + base[4:6] + "-" + base[6:]
}
