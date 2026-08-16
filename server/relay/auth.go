// Accounts: Google Sign-In (primary) plus a nickname/password fallback.
//
// There is NO email verification and no mail sending: Google already
// verifies the address it hands us, and password accounts treat email as a
// plain identifier. Docs in private collections (_users/_emails/_sessions)
// are excluded from the public /game/db API and exchanged between tiers only
// when the peer presents the shared BEYBLADE_PEER_KEY.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

var emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// sessions last until explicit sign-out; /me slides the expiry forward
const sessionTTL = 10 * 365 * 24 * time.Hour

type userDoc struct {
	Email     string `json:"email"`
	Nickname  string `json:"nickname"`
	Hash      string `json:"hash,omitempty"`      // empty for Google-only accounts
	GoogleSub string `json:"googleSub,omitempty"` // stable Google account id
}

type sessionDoc struct {
	UserID string `json:"userId"`
	Exp    int64  `json:"exp"`
}

func hexID(s string) string {
	return hex.EncodeToString([]byte(strings.ToLower(strings.TrimSpace(s))))
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func nowMs() int64 { return time.Now().UnixMilli() }

func googleClientID() string { return os.Getenv("BEYBLADE_GOOGLE_CLIENT_ID") }

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
	if !s.getDoc("_sessions", tok, &sess) || sess.UserID == "" || sess.Exp < nowMs() {
		return ""
	}
	return sess.UserID
}

func (s *Store) newSession(userID string) string {
	tok := randHex(24)
	s.putDoc("_sessions", tok, sessionDoc{UserID: userID, Exp: nowMs() + sessionTTL.Milliseconds()})
	return tok
}

// ---- Google Sign-In ------------------------------------------------------

type googleClaims struct {
	Iss           string `json:"iss"`
	Aud           string `json:"aud"`
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified string `json:"email_verified"`
	Name          string `json:"name"`
	Exp           string `json:"exp"`
}

// verifyGoogleIDToken validates the ID token issued to our web client.
//
// Validation is delegated to Google's tokeninfo endpoint (signature + key
// rotation handled upstream) and the security-relevant claims are then
// checked here: audience must be OUR client id, issuer must be Google, the
// token must not be expired, and the email must be Google-verified. At this
// project's sign-in volume that is well within tokeninfo's intended use; a
// high-traffic deployment should switch to local JWKS validation.
func verifyGoogleIDToken(cred string) (*googleClaims, error) {
	clientID := googleClientID()
	if clientID == "" {
		return nil, errors.New("google-not-configured")
	}
	if cred == "" || len(cred) > 8192 {
		return nil, errors.New("bad-credential")
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get("https://oauth2.googleapis.com/tokeninfo?id_token=" + url.QueryEscape(cred))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("token-rejected")
	}
	var c googleClaims
	if err := json.NewDecoder(resp.Body).Decode(&c); err != nil {
		return nil, err
	}
	if c.Aud != clientID {
		return nil, errors.New("audience-mismatch")
	}
	if c.Iss != "accounts.google.com" && c.Iss != "https://accounts.google.com" {
		return nil, errors.New("issuer-mismatch")
	}
	if exp, err := strconv.ParseInt(c.Exp, 10, 64); err != nil || time.Now().Unix() > exp {
		return nil, errors.New("token-expired")
	}
	if c.EmailVerified != "true" || c.Email == "" || c.Sub == "" {
		return nil, errors.New("email-unverified")
	}
	return &c, nil
}

// ---- HTTP ----------------------------------------------------------------

func (s *Store) ServeAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	op := strings.TrimPrefix(r.URL.Path, "/game/auth/")

	// public: lets the client decide whether to offer the Google button
	if op == "config" {
		_ = json.NewEncoder(w).Encode(map[string]string{"googleClientId": googleClientID()})
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		Email       string `json:"email"`
		Nickname    string `json:"nickname"`
		Password    string `json:"password"`
		Current     string `json:"current"`
		NewPassword string `json:"newPassword"`
		NewEmail    string `json:"newEmail"`
		Credential  string `json:"credential"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384)).Decode(&body); err != nil {
		http.Error(w, `{"error":"bad-json"}`, http.StatusBadRequest)
		return
	}
	fail := func(code int, msg string) { http.Error(w, fmt.Sprintf(`{"error":%q}`, msg), code) }
	ok := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	email := strings.ToLower(strings.TrimSpace(body.Email))

	switch op {
	case "google":
		claims, err := verifyGoogleIDToken(body.Credential)
		if err != nil {
			if err.Error() == "google-not-configured" {
				fail(503, "google-not-configured")
				return
			}
			fail(401, "google-verify-failed")
			return
		}
		gmail := strings.ToLower(claims.Email)
		var idx struct {
			UserID string `json:"userId"`
		}
		var u userDoc
		userID := ""
		if s.getDoc("_emails", hexID(gmail), &idx) && idx.UserID != "" && s.getDoc("_users", idx.UserID, &u) {
			userID = idx.UserID // existing account: link it to this Google id
			u.GoogleSub = claims.Sub
			if u.Nickname == "" {
				u.Nickname = claims.Name
			}
			s.putDoc("_users", userID, u)
		} else {
			nickname := strings.TrimSpace(claims.Name)
			if nickname == "" {
				nickname = strings.SplitN(gmail, "@", 2)[0]
			}
			userID = "u" + randHex(8)
			u = userDoc{Email: gmail, Nickname: nickname, GoogleSub: claims.Sub}
			s.putDoc("_users", userID, u)
			s.putDoc("_emails", hexID(gmail), map[string]string{"userId": userID})
		}
		ok(map[string]string{"token": s.newSession(userID), "nickname": u.Nickname, "email": u.Email})

	case "signup":
		if !emailRe.MatchString(email) || len(body.Password) < 6 || strings.TrimSpace(body.Nickname) == "" {
			fail(400, "invalid-fields")
			return
		}
		var existing struct {
			UserID string `json:"userId"`
		}
		if s.getDoc("_emails", hexID(email), &existing) && existing.UserID != "" {
			fail(409, "email-taken")
			return
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
		userID := "u" + randHex(8)
		u := userDoc{Email: email, Nickname: strings.TrimSpace(body.Nickname), Hash: string(hash)}
		s.putDoc("_users", userID, u)
		s.putDoc("_emails", hexID(email), map[string]string{"userId": userID})
		ok(map[string]string{"token": s.newSession(userID), "nickname": u.Nickname, "email": u.Email})

	case "signin":
		var idx struct {
			UserID string `json:"userId"`
		}
		var u userDoc
		if !s.getDoc("_emails", hexID(email), &idx) || !s.getDoc("_users", idx.UserID, &u) {
			fail(401, "bad-credentials")
			return
		}
		if u.Hash == "" {
			fail(401, "use-google") // Google-only account
			return
		}
		if bcrypt.CompareHashAndPassword([]byte(u.Hash), []byte(body.Password)) != nil {
			fail(401, "bad-credentials")
			return
		}
		ok(map[string]string{"token": s.newSession(idx.UserID), "nickname": u.Nickname, "email": u.Email})

	case "me":
		uid := s.SessionUser(r)
		var u userDoc
		if uid == "" || !s.getDoc("_users", uid, &u) {
			fail(401, "no-session")
			return
		}
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

	case "nickname":
		uid := s.SessionUser(r)
		var u userDoc
		if uid == "" || !s.getDoc("_users", uid, &u) {
			fail(401, "no-session")
			return
		}
		nick := strings.TrimSpace(body.Nickname)
		if nick == "" || len(nick) > 24 {
			fail(400, "invalid-fields")
			return
		}
		u.Nickname = nick
		s.putDoc("_users", uid, u)
		ok(map[string]string{"status": "ok", "nickname": nick})

	case "change-password":
		uid := s.SessionUser(r)
		var u userDoc
		if uid == "" || !s.getDoc("_users", uid, &u) {
			fail(401, "no-session")
			return
		}
		if u.Hash == "" || bcrypt.CompareHashAndPassword([]byte(u.Hash), []byte(body.Current)) != nil || len(body.NewPassword) < 6 {
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
		var other struct {
			UserID string `json:"userId"`
		}
		if s.getDoc("_emails", hexID(newEmail), &other) && other.UserID != "" && other.UserID != uid {
			fail(409, "email-taken")
			return
		}
		s.putDoc("_emails", hexID(u.Email), map[string]string{"userId": ""}) // tombstone old
		u.Email = newEmail
		s.putDoc("_users", uid, u)
		s.putDoc("_emails", hexID(newEmail), map[string]string{"userId": uid})
		ok(map[string]string{"status": "ok", "email": newEmail})

	default:
		fail(404, "unknown-op")
	}
}
