// Accounts: email-identified, password-authenticated, email-verified.
//
// Docs live in private collections (_users/_emails/_sessions) that are
// excluded from the public /game/db API and only exchanged between tiers
// when the peer presents the shared BEYBLADE_PEER_KEY. Verification codes
// are delivered by SMTP when BEYBLADE_SMTP_* is configured; otherwise the
// code is logged, and with BEYBLADE_DEV_MAIL=1 it is also returned in the
// API response (developer-only convenience, remove for production).
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/smtp"
	"os"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

var emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// sessions live until explicit sign-out: effectively non-expiring, and /me
// slides the expiry forward on every app launch
const sessionTTL = 10 * 365 * 24 * time.Hour

type userDoc struct {
	Email        string `json:"email"`
	Nickname     string `json:"nickname"`
	Hash         string `json:"hash"`
	Verified     bool   `json:"verified"`
	Code         string `json:"code,omitempty"`
	CodeExp      int64  `json:"codeExp,omitempty"`
	PendingEmail string `json:"pendingEmail,omitempty"`
}

type sessionDoc struct {
	UserID string `json:"userId"`
	Exp    int64  `json:"exp"`
}

func hexID(s string) string   { return hex.EncodeToString([]byte(strings.ToLower(strings.TrimSpace(s)))) }
func randHex(n int) string    { b := make([]byte, n); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func randCode() string        { b := make([]byte, 4); _, _ = rand.Read(b); return fmt.Sprintf("%06d", (uint32(b[0])<<16|uint32(b[1])<<8|uint32(b[2]))%1000000) }
func nowMs() int64            { return time.Now().UnixMilli() }
func devMail() bool           { return os.Getenv("BEYBLADE_DEV_MAIL") == "1" }

func sendMail(to, code string) {
	host := os.Getenv("BEYBLADE_SMTP_HOST")
	if host == "" {
		log.Printf("auth: verification code for %s: %s (no SMTP configured)", to, code)
		return
	}
	user := os.Getenv("BEYBLADE_SMTP_USER")
	pass := os.Getenv("BEYBLADE_SMTP_PASS")
	from := os.Getenv("BEYBLADE_SMTP_FROM")
	if from == "" {
		from = user
	}
	msg := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: BEYBLADE X verification code\r\n\r\n驗證碼 Verification code: %s\r\n", from, to, code)
	addr := host
	if !strings.Contains(addr, ":") {
		addr += ":587"
	}
	go func() {
		if err := smtp.SendMail(addr, smtp.PlainAuth("", user, pass, strings.Split(addr, ":")[0]), from, []string{to}, []byte(msg)); err != nil {
			log.Printf("auth: smtp send to %s failed: %v", to, err)
		}
	}()
}

func (s *Store) getDoc(col, id string, out any) bool {
	for _, d := range s.List(col) {
		if d.ID == id {
			return json.Unmarshal(d.Data, out) == nil
		}
	}
	return false
}

func (s *Store) putDoc(col, id string, v any) {
	raw, _ := json.Marshal(v)
	s.Put(Doc{Col: col, ID: id, UpdatedAt: nowMs(), Data: raw})
}

// SessionUser returns the userId for a valid bearer token, or "".
func (s *Store) SessionUser(r *http.Request) string {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if tok == "" || !idPattern.MatchString(tok) {
		return ""
	}
	var sess sessionDoc
	if !s.getDoc("_sessions", tok, &sess) || sess.Exp < nowMs() {
		return ""
	}
	return sess.UserID
}

func (s *Store) ServeAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
		return
	}
	op := strings.TrimPrefix(r.URL.Path, "/game/auth/")
	var body struct {
		Email       string `json:"email"`
		Nickname    string `json:"nickname"`
		Password    string `json:"password"`
		Current     string `json:"current"`
		NewPassword string `json:"newPassword"`
		NewEmail    string `json:"newEmail"`
		Code        string `json:"code"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil {
		http.Error(w, `{"error":"bad-json"}`, http.StatusBadRequest)
		return
	}
	fail := func(code int, msg string) { http.Error(w, fmt.Sprintf(`{"error":%q}`, msg), code) }
	ok := func(v any) { _ = json.NewEncoder(w).Encode(v) }

	email := strings.ToLower(strings.TrimSpace(body.Email))
	switch op {
	case "signup":
		if !emailRe.MatchString(email) || len(body.Password) < 6 || strings.TrimSpace(body.Nickname) == "" {
			fail(400, "invalid-fields")
			return
		}
		var existing struct{ UserID string `json:"userId"` }
		if s.getDoc("_emails", hexID(email), &existing) && existing.UserID != "" {
			var u userDoc
			if s.getDoc("_users", existing.UserID, &u) && u.Verified {
				fail(409, "email-taken")
				return
			}
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
		userID := "u" + randHex(8)
		code := randCode()
		s.putDoc("_users", userID, userDoc{
			Email: email, Nickname: strings.TrimSpace(body.Nickname), Hash: string(hash),
			Verified: false, Code: code, CodeExp: nowMs() + 30*60*1000,
		})
		s.putDoc("_emails", hexID(email), map[string]string{"userId": userID})
		sendMail(email, code)
		resp := map[string]any{"status": "verify-sent"}
		if devMail() {
			resp["devCode"] = code
		}
		ok(resp)
	case "verify":
		var idx struct{ UserID string `json:"userId"` }
		var u userDoc
		if !s.getDoc("_emails", hexID(email), &idx) || !s.getDoc("_users", idx.UserID, &u) {
			fail(404, "not-found")
			return
		}
		if u.Code == "" || u.Code != body.Code || u.CodeExp < nowMs() {
			fail(400, "bad-code")
			return
		}
		u.Verified, u.Code = true, ""
		s.putDoc("_users", idx.UserID, u)
		ok(map[string]string{"status": "verified"})
	case "signin":
		var idx struct{ UserID string `json:"userId"` }
		var u userDoc
		if !s.getDoc("_emails", hexID(email), &idx) || !s.getDoc("_users", idx.UserID, &u) {
			fail(401, "bad-credentials")
			return
		}
		if bcrypt.CompareHashAndPassword([]byte(u.Hash), []byte(body.Password)) != nil {
			fail(401, "bad-credentials")
			return
		}
		if !u.Verified {
			fail(403, "not-verified")
			return
		}
		tok := randHex(24)
		s.putDoc("_sessions", tok, sessionDoc{UserID: idx.UserID, Exp: nowMs() + sessionTTL.Milliseconds()})
		ok(map[string]string{"token": tok, "nickname": u.Nickname, "email": u.Email})
	case "me":
		uid := s.SessionUser(r)
		var u userDoc
		if uid == "" || !s.getDoc("_users", uid, &u) {
			fail(401, "no-session")
			return
		}
		// sliding renewal: stay signed in until explicit sign-out
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if idPattern.MatchString(tok) {
			s.putDoc("_sessions", tok, sessionDoc{UserID: uid, Exp: nowMs() + sessionTTL.Milliseconds()})
		}
		ok(map[string]string{"email": u.Email, "nickname": u.Nickname})
	case "signout":
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if idPattern.MatchString(tok) {
			s.putDoc("_sessions", tok, sessionDoc{UserID: "", Exp: 0})
		}
		ok(map[string]string{"status": "ok"})
	case "change-password":
		uid := s.SessionUser(r)
		var u userDoc
		if uid == "" || !s.getDoc("_users", uid, &u) {
			fail(401, "no-session")
			return
		}
		if bcrypt.CompareHashAndPassword([]byte(u.Hash), []byte(body.Current)) != nil || len(body.NewPassword) < 6 {
			fail(400, "bad-current-or-weak")
			return
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(body.NewPassword), bcrypt.DefaultCost)
		u.Hash = string(hash)
		s.putDoc("_users", uid, u)
		ok(map[string]string{"status": "ok"})
	case "change-email":
		uid := s.SessionUser(r)
		var u userDoc
		newEmail := strings.ToLower(strings.TrimSpace(body.NewEmail))
		if uid == "" || !s.getDoc("_users", uid, &u) {
			fail(401, "no-session")
			return
		}
		if !emailRe.MatchString(newEmail) {
			fail(400, "invalid-email")
			return
		}
		u.PendingEmail = newEmail
		u.Code = randCode()
		u.CodeExp = nowMs() + 30*60*1000
		s.putDoc("_users", uid, u)
		sendMail(newEmail, u.Code)
		resp := map[string]any{"status": "verify-sent"}
		if devMail() {
			resp["devCode"] = u.Code
		}
		ok(resp)
	case "confirm-email":
		uid := s.SessionUser(r)
		var u userDoc
		if uid == "" || !s.getDoc("_users", uid, &u) {
			fail(401, "no-session")
			return
		}
		if u.PendingEmail == "" || u.Code != body.Code || u.CodeExp < nowMs() {
			fail(400, "bad-code")
			return
		}
		s.putDoc("_emails", hexID(u.Email), map[string]string{"userId": ""}) // tombstone old
		u.Email, u.PendingEmail, u.Code = u.PendingEmail, "", ""
		s.putDoc("_users", uid, u)
		s.putDoc("_emails", hexID(u.Email), map[string]string{"userId": uid})
		ok(map[string]string{"status": "ok", "email": u.Email})
	default:
		fail(404, "unknown-op")
	}
}
