// Persistent document store with cross-tier sync.
//
// Collections of JSON docs keyed by id, each carrying updatedAt (unix ms).
// Merge policy is last-writer-wins on updatedAt — good enough for a
// dev-scale game (profiles, saved combos, match records). Persistence is a
// single JSON file written atomically. Sync: with -peer set, this server
// periodically pulls the peer's /game/db/changes and merges; with both tiers
// pointing at each other, writes propagate in ≤ one interval either way.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxDocBytes  = 32 * 1024
	maxDocs      = 8192
	syncInterval = 45 * time.Second
)

type Doc struct {
	Col       string          `json:"col"`
	ID        string          `json:"id"`
	UpdatedAt int64           `json:"updatedAt"` // unix ms
	Data      json.RawMessage `json:"data"`
}

type Store struct {
	mu   sync.Mutex
	path string
	docs map[string]Doc // key: col + "\x00" + id
}

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_.:\-]{1,128}$`)

func NewStore(path string) *Store {
	s := &Store{path: path, docs: make(map[string]Doc)}
	if raw, err := os.ReadFile(path); err == nil {
		var list []Doc
		if json.Unmarshal(raw, &list) == nil {
			for _, d := range list {
				s.docs[d.Col+"\x00"+d.ID] = d
			}
		}
	}
	return s
}

func (s *Store) saveLocked() {
	list := make([]Doc, 0, len(s.docs))
	for _, d := range s.docs {
		list = append(list, d)
	}
	raw, err := json.Marshal(list)
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil && filepath.Dir(s.path) != "." {
		log.Printf("store mkdir: %v", err)
	}
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		log.Printf("store write: %v", err)
		return
	}
	if err := os.Rename(tmp, s.path); err != nil {
		log.Printf("store rename: %v", err)
	}
}

// Put merges a doc (LWW). Returns true when the doc was accepted (newer).
func (s *Store) Put(d Doc) bool {
	if !idPattern.MatchString(d.Col) || !idPattern.MatchString(d.ID) || len(d.Data) > maxDocBytes {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := d.Col + "\x00" + d.ID
	if cur, ok := s.docs[key]; ok && cur.UpdatedAt >= d.UpdatedAt {
		return false
	}
	if len(s.docs) >= maxDocs {
		if _, ok := s.docs[key]; !ok {
			return false
		}
	}
	s.docs[key] = d
	s.saveLocked()
	return true
}

func (s *Store) List(col string) []Doc {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Doc{}
	for _, d := range s.docs {
		if d.Col == col {
			out = append(out, d)
		}
	}
	return out
}

func (s *Store) Changes(sinceMs int64) []Doc {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Doc{}
	for _, d := range s.docs {
		if d.UpdatedAt > sinceMs {
			out = append(out, d)
		}
	}
	return out
}

// ---- HTTP API under /game/db/ --------------------------------------------

// peerKeyOK: the other tier authenticates with the shared BEYBLADE_PEER_KEY.
func peerKeyOK(req *http.Request) bool {
	k := os.Getenv("BEYBLADE_PEER_KEY")
	return k != "" && req.Header.Get("X-Beyblade-Peer-Key") == k
}

func isPrivateCol(col string) bool { return strings.HasPrefix(col, "_") }

func (s *Store) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	rest := strings.TrimPrefix(req.URL.Path, "/game/db/")
	w.Header().Set("Content-Type", "application/json")
	switch {
	case rest == "changes" && req.Method == http.MethodGet:
		since, _ := strconv.ParseInt(req.URL.Query().Get("since"), 10, 64)
		docs := s.Changes(since)
		if !peerKeyOK(req) {
			filtered := docs[:0]
			for _, d := range docs {
				if !isPrivateCol(d.Col) {
					filtered = append(filtered, d)
				}
			}
			docs = filtered
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"docs": docs,
			"now":  time.Now().UnixMilli(),
		})
	case rest == "sync" && req.Method == http.MethodPost:
		n := s.pullPeerOnce()
		fmt.Fprintf(w, `{"merged":%d}`, n)
	case req.Method == http.MethodGet && idPattern.MatchString(rest):
		if isPrivateCol(rest) {
			http.Error(w, `{"error":"private"}`, http.StatusForbidden)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"docs": s.List(rest)})
	case req.Method == http.MethodPut:
		parts := strings.SplitN(rest, "/", 2)
		if len(parts) != 2 {
			http.Error(w, `{"error":"bad-path"}`, http.StatusBadRequest)
			return
		}
		if isPrivateCol(parts[0]) && !peerKeyOK(req) {
			http.Error(w, `{"error":"private"}`, http.StatusForbidden)
			return
		}
		if !isPrivateCol(parts[0]) && !peerKeyOK(req) && s.SessionUser(req) == "" {
			http.Error(w, `{"error":"signin-required"}`, http.StatusUnauthorized)
			return
		}
		body, err := io.ReadAll(io.LimitReader(req.Body, maxDocBytes+1024))
		if err != nil {
			http.Error(w, `{"error":"read"}`, http.StatusBadRequest)
			return
		}
		var in struct {
			UpdatedAt int64           `json:"updatedAt"`
			Data      json.RawMessage `json:"data"`
		}
		if json.Unmarshal(body, &in) != nil || in.UpdatedAt <= 0 || !json.Valid(in.Data) {
			http.Error(w, `{"error":"bad-doc"}`, http.StatusBadRequest)
			return
		}
		ok := s.Put(Doc{Col: parts[0], ID: parts[1], UpdatedAt: in.UpdatedAt, Data: in.Data})
		fmt.Fprintf(w, `{"accepted":%v}`, ok)
	default:
		http.NotFound(w, req)
	}
}

// ---- peer sync ------------------------------------------------------------

var (
	peerBase   string
	peerCursor int64
	peerMu     sync.Mutex
)

func (s *Store) StartPeerSync(base string) {
	peerBase = strings.TrimRight(base, "/")
	go func() {
		for {
			time.Sleep(syncInterval)
			s.pullPeerOnce()
		}
	}()
}

func (s *Store) pullPeerOnce() int {
	if peerBase == "" {
		return 0
	}
	peerMu.Lock()
	cursor := peerCursor
	peerMu.Unlock()
	client := &http.Client{Timeout: 20 * time.Second}
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/game/db/changes?since=%d", peerBase, cursor), nil)
	if k := os.Getenv("BEYBLADE_PEER_KEY"); k != "" {
		req.Header.Set("X-Beyblade-Peer-Key", k) // include private (auth) collections
	}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("peer sync: %v", err)
		return 0
	}
	defer resp.Body.Close()
	var out struct {
		Docs []Doc `json:"docs"`
		Now  int64 `json:"now"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&out) != nil {
		return 0
	}
	n := 0
	for _, d := range out.Docs {
		if s.Put(d) {
			n++
		}
	}
	peerMu.Lock()
	if out.Now > 0 {
		peerCursor = out.Now
	}
	peerMu.Unlock()
	if n > 0 {
		log.Printf("peer sync: merged %d docs", n)
	}
	return n
}
