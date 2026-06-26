package store

import (
	"context"
	"database/sql"
	"fmt"
)

// InTx runs fn inside a single database transaction, passing a tx-bound *Queries.
// It commits when fn returns nil and rolls back (discarding all writes) on error,
// making a batch of inserts atomic — a mid-batch failure leaves zero rows, so a
// job retry replaces rather than appends.
func InTx(ctx context.Context, db *sql.DB, fn func(*Queries) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	if err := fn(New(tx)); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}
