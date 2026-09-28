package api

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
)

const defaultStaticPagesRoot = "/vol1/1000/nginx/public/resume/muse"

type staticPage struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	URL      string `json:"url"`
	Size     int64  `json:"size"`
	Modified string `json:"modified"`
	Revision string `json:"revision"`
}

func pageRevision(info fs.FileInfo) string {
	return fmt.Sprintf(`"%x-%x"`, info.ModTime().UnixNano(), info.Size())
}
func validPagePath(p string) bool {
	if p == "" || p != path.Clean(p) || strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00") {
		return false
	}
	for _, part := range strings.Split(p, "/") {
		if strings.HasPrefix(part, ".") {
			return false
		}
	}
	ext := strings.ToLower(path.Ext(p))
	return ext == ".html" || ext == ".htm"
}
func (h *Handler) openStaticPagesRoot() (*os.Root, error) {
	root := h.staticPagesRoot
	if root == "" {
		root = defaultStaticPagesRoot
	}
	return os.OpenRoot(root)
}
func (h *Handler) registerStaticPageRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/static-pages", h.handleStaticPages)
	mux.HandleFunc("DELETE /api/static-pages", h.handleDeleteStaticPage)
}
func (h *Handler) handleStaticPages(w http.ResponseWriter, r *http.Request) {
	root, err := h.openStaticPagesRoot()
	if err != nil {
		http.Error(w, "page directory unavailable", 503)
		return
	}
	defer root.Close()
	pages := []staticPage{}
	err = fs.WalkDir(root.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if r.Context().Err() != nil {
			return r.Context().Err()
		}
		if p != "." && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 || d.IsDir() || !validPagePath(p) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		u := url.URL{Scheme: "https", Host: "render.mrtreasure.cc", Path: "/muse/" + p}
		pages = append(pages, staticPage{p, path.Base(p), u.String(), info.Size(), info.ModTime().UTC().Format("2006-01-02T15:04:05Z"), pageRevision(info)})
		return nil
	})
	if err != nil {
		http.Error(w, "unable to list pages", 500)
		return
	}
	sort.Slice(pages, func(i, j int) bool {
		if pages[i].Modified == pages[j].Modified {
			return pages[i].Path < pages[j].Path
		}
		return pages[i].Modified > pages[j].Modified
	})
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(pages)
}
func (h *Handler) handleDeleteStaticPage(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if !validPagePath(p) {
		http.Error(w, "invalid page path", 400)
		return
	}
	root, err := h.openStaticPagesRoot()
	if err != nil {
		http.Error(w, "page directory unavailable", 503)
		return
	}
	defer root.Close()
	// Refuse all symlink components, including links within the allowed root.
	parts := strings.Split(p, "/")
	for i := range parts {
		info, e := root.Lstat(strings.Join(parts[:i+1], "/"))
		if os.IsNotExist(e) {
			http.Error(w, "page not found", 404)
			return
		}
		if e != nil {
			http.Error(w, "page unavailable", 500)
			return
		}
		if info.Mode()&os.ModeSymlink != 0 {
			http.Error(w, "symlink pages are not supported", 400)
			return
		}
	}
	info, err := root.Lstat(p)
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "page unavailable", 400)
		return
	}
	if r.Header.Get("If-Match") != "" && r.Header.Get("If-Match") != pageRevision(info) {
		http.Error(w, "page changed; refresh before deleting", 412)
		return
	}
	if r.Header.Get("If-Match") == "" {
		http.Error(w, "page revision required", 428)
		return
	}
	if err = root.Remove(p); err != nil {
		http.Error(w, "unable to delete page", 500)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
