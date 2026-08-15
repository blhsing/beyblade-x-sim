// Beyblade X sim — combined web host + game room relay.
//
// One binary serves the whole tier: the built web app (embedded webroot, or
// -static DIR during development) at "/", and a deliberately dumb WebSocket
// room relay under "/game/..." in the style of the DeskFerry relays: rooms
// are created lazily, state is in-memory, and the server never parses game
// semantics — it forwards JSON text frames between room members and
// announces membership changes. Battle outcomes are computed client-side by
// deterministic lockstep (see docs/PROTOCOL.md).
//
// The optional -forward flag reverse-proxies every path OUTSIDE "/" static
// and "/game/..." (notably "/relay/...") to another local server, so this
// binary can sit on port 80 in front of a DeskFerry relay on the OCI tier
// without disturbing its URLs.
//
// Deploy tiers (docs/PLAN.md §3.2): local `go run .`; Azure App Service
// (WSS, via httpPlatformHandler); OCI Always Free VM behind systemd. Relay
// URLs are client configuration — never hardcode deployment hosts here.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

//go:embed all:webroot
var embeddedWebroot embed.FS

const (
	maxPlayers      = 2
	maxSpectators   = 8
	maxMessageBytes = 64 * 1024
	pingInterval    = 20 * time.Second
	writeTimeout    = 10 * time.Second
)

type client struct {
	conn *websocket.Conn
	name string
	role string // "player" | "spectator"
	slot int    // 0/1 for players, -1 for spectators
	send chan []byte
	done chan struct{}
	once sync.Once
}

func (c *client) close() {
	c.once.Do(func() { close(c.done) })
}

type room struct {
	id         string
	mu         sync.Mutex
	players    [maxPlayers]*client
	spectators map[*client]struct{}
}

type hub struct {
	mu    sync.Mutex
	rooms map[string]*room
}

func newHub() *hub { return &hub{rooms: make(map[string]*room)} }

// roomID normalization matches the DeskFerry relay family: lowercase,
// keep [a-z0-9-_.], collapse others to '-', trim, cap 64, empty => default.
func roomID(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-.")
	if len(out) > 64 {
		out = out[:64]
	}
	if out == "" {
		out = "default"
	}
	return out
}

func (h *hub) room(id string) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[id]
	if !ok {
		r = &room{id: id, spectators: make(map[*client]struct{})}
		h.rooms[id] = r
	}
	return r
}

func (h *hub) drop(r *room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r.mu.Lock()
	empty := r.players[0] == nil && r.players[1] == nil && len(r.spectators) == 0
	r.mu.Unlock()
	if empty {
		delete(h.rooms, r.id)
	}
}

type envelope struct {
	Type    string          `json:"type"`
	From    int             `json:"from,omitempty"`
	Name    string          `json:"name,omitempty"`
	Slot    int             `json:"slot"`
	Players []string        `json:"players,omitempty"`
	Reason  string          `json:"reason,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (r *room) join(c *client) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if c.role == "player" {
		for i := range r.players {
			if r.players[i] == nil {
				r.players[i] = c
				c.slot = i
				return nil
			}
		}
		return fmt.Errorf("room-full")
	}
	if len(r.spectators) >= maxSpectators {
		return fmt.Errorf("room-full")
	}
	c.slot = -1
	r.spectators[c] = struct{}{}
	return nil
}

func (r *room) leave(c *client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.players {
		if r.players[i] == c {
			r.players[i] = nil
		}
	}
	delete(r.spectators, c)
}

func (r *room) membersLocked() []*client {
	out := make([]*client, 0, maxPlayers+len(r.spectators))
	for _, p := range r.players {
		if p != nil {
			out = append(out, p)
		}
	}
	for s := range r.spectators {
		out = append(out, s)
	}
	return out
}

func (r *room) broadcast(except *client, payload []byte) {
	r.mu.Lock()
	members := r.membersLocked()
	r.mu.Unlock()
	for _, m := range members {
		if m == except {
			continue
		}
		select {
		case m.send <- payload:
		default:
			m.close() // slow consumer: drop the connection, not the room
		}
	}
}

func (r *room) announce() {
	r.mu.Lock()
	names := make([]string, maxPlayers)
	for i, p := range r.players {
		if p != nil {
			names[i] = p.name
		}
	}
	r.mu.Unlock()
	msg, _ := json.Marshal(envelope{Type: "room", Slot: -1, Players: names})
	r.broadcast(nil, msg)
}

func serveWS(h *hub, w http.ResponseWriter, req *http.Request, roomRaw string) {
	role := req.URL.Query().Get("role")
	if role != "player" && role != "spectator" {
		role = "player"
	}
	name := strings.TrimSpace(req.URL.Query().Get("name"))
	if name == "" {
		name = "玩家"
	}
	if len(name) > 24 {
		name = name[:24]
	}

	conn, err := websocket.Accept(w, req, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"}, // dev-only project; tighten before wider use
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(maxMessageBytes)

	c := &client{
		conn: conn,
		name: name,
		role: role,
		send: make(chan []byte, 64),
		done: make(chan struct{}),
	}
	rm := h.room(roomID(roomRaw))
	if err := rm.join(c); err != nil {
		msg, _ := json.Marshal(envelope{Type: "error", Slot: -1, Reason: err.Error()})
		_ = writeWithTimeout(conn, msg)
		conn.Close(websocket.StatusPolicyViolation, err.Error())
		return
	}
	defer func() {
		rm.leave(c)
		rm.announce()
		h.drop(rm)
		conn.Close(websocket.StatusNormalClosure, "bye")
	}()

	welcome, _ := json.Marshal(envelope{Type: "welcome", Slot: c.slot, Name: name})
	if err := writeWithTimeout(conn, welcome); err != nil {
		return
	}
	rm.announce()

	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-c.done:
				return
			case payload := <-c.send:
				if writeWithTimeout(conn, payload) != nil {
					c.close()
					return
				}
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
				err := conn.Ping(ctx)
				cancel()
				if err != nil {
					c.close()
					return
				}
			}
		}
	}()

	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		typ, data, err := conn.Read(ctx)
		cancel()
		if err != nil {
			c.close()
			return
		}
		if typ != websocket.MessageText || !json.Valid(data) {
			continue
		}
		out, _ := json.Marshal(envelope{Type: "msg", From: c.slot, Slot: c.slot, Data: data})
		rm.broadcast(c, out)
		select {
		case <-c.done:
			return
		default:
		}
	}
}

func writeWithTimeout(conn *websocket.Conn, payload []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, payload)
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// defaultListen honors the hosting conventions of each tier:
// BEYBLADE_RELAY_LISTEN explicit > Azure Windows httpPlatformHandler
// (HTTP_PLATFORM_PORT, loopback) > Linux App Service (PORT, all interfaces)
// > local dev loopback.
func defaultListen() string {
	if v := os.Getenv("BEYBLADE_RELAY_LISTEN"); v != "" {
		return v
	}
	if p := os.Getenv("HTTP_PLATFORM_PORT"); p != "" {
		return "127.0.0.1:" + p
	}
	if p := os.Getenv("PORT"); p != "" {
		return "0.0.0.0:" + p
	}
	return "127.0.0.1:8080"
}

func main() {
	listen := flag.String("listen", defaultListen(), "listen address")
	staticDir := flag.String("static", envOrDefault("BEYBLADE_RELAY_STATIC", ""), "serve web app from this directory instead of the embedded copy")
	forward := flag.String("forward", envOrDefault("BEYBLADE_RELAY_FORWARD", ""), "reverse-proxy unknown paths (e.g. /relay/*) to this base URL")
	pathBase := flag.String("pathbase", envOrDefault("BEYBLADE_RELAY_PATHBASE", ""), "strip this URL prefix (hosting as an IIS virtual application, e.g. /beyblade)")
	dataPath := flag.String("data", envOrDefault("BEYBLADE_RELAY_DATA", "beyblade-db.json"), "path of the persistent document store")
	peer := flag.String("peer", envOrDefault("BEYBLADE_RELAY_PEER", ""), "base URL of the other tier to sync the store with")
	flag.Parse()

	h := newHub()
	mux := http.NewServeMux()
	mux.HandleFunc("/game/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","service":"beyblade-relay","time":%q}`, time.Now().UTC().Format(time.RFC3339))
	})
	mux.HandleFunc("/game/status", func(w http.ResponseWriter, _ *http.Request) {
		h.mu.Lock()
		type roomInfo struct {
			ID      string   `json:"id"`
			Players []string `json:"players"`
			Specs   int      `json:"spectators"`
		}
		infos := make([]roomInfo, 0, len(h.rooms))
		for _, r := range h.rooms {
			r.mu.Lock()
			ri := roomInfo{ID: r.id, Specs: len(r.spectators)}
			for _, p := range r.players {
				if p != nil {
					ri.Players = append(ri.Players, p.name)
				}
			}
			r.mu.Unlock()
			infos = append(infos, ri)
		}
		h.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"rooms": infos})
	})
	store := NewStore(*dataPath)
	if *peer != "" {
		store.StartPeerSync(*peer)
		log.Printf("syncing store with peer %s", *peer)
	}
	mux.HandleFunc("/game/", func(w http.ResponseWriter, req *http.Request) {
		rest := strings.TrimPrefix(req.URL.Path, "/game/")
		if strings.HasPrefix(rest, "db/") {
			store.ServeHTTP(w, req)
			return
		}
		parts := strings.Split(rest, "/")
		if len(parts) == 2 && parts[1] == "ws" {
			serveWS(h, w, req, parts[0])
			return
		}
		http.NotFound(w, req)
	})

	// Static web app at "/" (embedded webroot, or -static DIR in dev).
	var webFS http.FileSystem
	if *staticDir != "" {
		webFS = http.Dir(*staticDir)
	} else {
		sub, err := fs.Sub(embeddedWebroot, "webroot")
		if err != nil {
			log.Fatal(err)
		}
		webFS = http.FS(sub)
	}
	fileServer := http.FileServer(webFS)
	mux.HandleFunc("/", func(w http.ResponseWriter, req *http.Request) {
		p := strings.TrimPrefix(req.URL.Path, "/")
		if p != "" {
			if f, err := webFS.Open(p); err == nil {
				f.Close()
				fileServer.ServeHTTP(w, req)
				return
			}
			// unknown extension-less path → SPA index fallback
			if strings.Contains(p, ".") {
				http.NotFound(w, req)
				return
			}
		}
		req.URL.Path = "/"
		fileServer.ServeHTTP(w, req)
	})

	// Optional front-proxy for a co-hosted DeskFerry relay (OCI port-80 plan):
	// keeps /relay/* URLs working while this binary owns the port.
	if *forward != "" {
		target, err := url.Parse(*forward)
		if err != nil {
			log.Fatalf("bad -forward URL: %v", err)
		}
		proxy := httputil.NewSingleHostReverseProxy(target)
		mux.Handle("/relay/", proxy)
		log.Printf("forwarding /relay/* to %s", target)
	}

	var handler http.Handler = mux
	if *pathBase != "" {
		base := "/" + strings.Trim(*pathBase, "/")
		inner := handler
		handler = http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			p := req.URL.Path
			if p == base || strings.HasPrefix(p, base+"/") {
				req.URL.Path = strings.TrimPrefix(p, base)
				if req.URL.Path == "" {
					req.URL.Path = "/"
				}
			}
			inner.ServeHTTP(w, req)
		})
		log.Printf("path base: %s", base)
	}

	log.Printf("beyblade relay listening on %s", *listen)
	srv := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
