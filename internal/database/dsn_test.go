package database

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestNew_PathWithSpaces covers the desktop app's data dir on macOS
// (~/Library/Application Support/…), which contains a space.
func TestNew_PathWithSpaces(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Application Support", "Sieve")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "sieve.db")
	db, err := New(path)
	if err != nil {
		t.Fatalf("New(%q): %v", path, err)
	}
	defer db.Close()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("db file not created at the literal path: %v", err)
	}
	fi, _ := os.Stat(path)
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("perm = %o, want 600", fi.Mode().Perm())
	}
}

// TestNew_PragmasOnEveryConnection proves foreign keys are enforced on all
// pooled connections, not just the first one.
func TestNew_PragmasOnEveryConnection(t *testing.T) {
	db, err := New(filepath.Join(t.TempDir(), "p.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(4)
	conns := make([]interface{ Close() error }, 0, 4)
	for i := 0; i < 4; i++ {
		c, err := db.Conn(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		var fk int
		if err := c.QueryRowContext(t.Context(), "PRAGMA foreign_keys").Scan(&fk); err != nil {
			t.Fatal(err)
		}
		if fk != 1 {
			t.Errorf("connection %d: foreign_keys = %d, want 1", i, fk)
		}
		conns = append(conns, c)
	}
	for _, c := range conns {
		c.Close()
	}
}

// TestNew_TimeRoundTrip guards the _time_format choice: a time.Time written
// through the driver scans back as the same instant from a DATETIME column.
func TestNew_TimeRoundTrip(t *testing.T) {
	db, err := New(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE tt (at DATETIME)`); err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 10, 13, 12, 0, 0, 123456789, time.UTC)
	if _, err := db.Exec(`INSERT INTO tt (at) VALUES (?)`, want); err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := db.QueryRow(`SELECT CAST(at AS TEXT) FROM tt`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if raw != "2026-10-13 12:00:00.123456789+00:00" {
		t.Errorf("stored layout = %q, want the sqlite layout the CGO driver used", raw)
	}
	var got time.Time
	if err := db.QueryRow(`SELECT at FROM tt`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if !got.Equal(want) {
		t.Errorf("round trip = %v, want %v", got, want)
	}
}
