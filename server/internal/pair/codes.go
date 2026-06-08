package pair

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
)

const (
	codeLen = 8
	codeTTL = 5 * time.Minute
	charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no I/O/1/0 to avoid confusion
)

// Mint generates a new pairing code, stores it in the DB, and returns it.
func Mint(ctx context.Context, q *store.Queries) (code string, expiresAt time.Time, err error) {
	code, err = randomCode()
	if err != nil {
		return "", time.Time{}, fmt.Errorf("generate code: %w", err)
	}
	expiresAt = time.Now().UTC().Add(codeTTL)
	if err := q.InsertPairCode(ctx, store.InsertPairCodeParams{
		Code:      code,
		ExpiresAt: expiresAt.Format(time.RFC3339),
	}); err != nil {
		return "", time.Time{}, fmt.Errorf("insert pair code: %w", err)
	}
	return code, expiresAt, nil
}

// Claim validates and consumes a pairing code. Returns ErrInvalid if the code
// is unknown, expired, or already used.
func Claim(ctx context.Context, q *store.Queries, code string) error {
	row, err := q.GetPairCode(ctx, code)
	if err != nil {
		return ErrInvalid
	}
	if row.UsedAt != nil {
		return ErrInvalid
	}
	exp, err := time.Parse(time.RFC3339, row.ExpiresAt)
	if err != nil || time.Now().UTC().After(exp) {
		return ErrInvalid
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := q.MarkPairCodeUsed(ctx, store.MarkPairCodeUsedParams{
		UsedAt: &now,
		Code:   code,
	}); err != nil {
		return fmt.Errorf("mark used: %w", err)
	}
	return nil
}

var ErrInvalid = fmt.Errorf("invalid or expired pairing code")

func randomCode() (string, error) {
	b := make([]byte, codeLen)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
		if err != nil {
			return "", fmt.Errorf("rand int: %w", err)
		}
		b[i] = charset[n.Int64()]
	}
	return string(b), nil
}
