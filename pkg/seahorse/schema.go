package seahorse

import (
	"database/sql"
	"fmt"

	"github.com/sipeed/picoclaw/pkg/logger"
)

// SQL statements for FTS5 tables with trigram tokenizer.
const (
	sqlCreateSummariesFTS = `CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
		summary_id,
		content,
		tokenize="trigram"
	)`
	sqlCreateMessagesFTS = `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
		message_id,
		content,
		tokenize="trigram"
	)`
	sqlCheckFTS5Available    = `CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_check USING fts5(content)`
	sqlCheckTrigramAvailable = `CREATE VIRTUAL TABLE IF NOT EXISTS _trigram_check USING fts5(content, tokenize="trigram")`
	sqlDropFTS5Check         = `DROP TABLE IF EXISTS _fts5_check`
	sqlDropTrigramCheck      = `DROP TABLE IF EXISTS _trigram_check`
)

// runSchema creates or upgrades the database schema.
// All schemas are idempotent (safe to run multiple times).
func runSchema(db *sql.DB) error {
	// Check FTS5 support before creating tables
	if err := checkFTS5Support(db); err != nil {
		return fmt.Errorf("FTS5 check: %w", err)
	}

	stmts := []string{
		`CREATE TABLE IF NOT EXISTS conversations (
			conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_key     TEXT NOT NULL UNIQUE,
			active_generation INTEGER NOT NULL DEFAULT 0,
			active_turn_count INTEGER NOT NULL DEFAULT 0,
			last_summary_turn INTEGER NOT NULL DEFAULT 0,
			created_at      TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
		)`,

		`CREATE TABLE IF NOT EXISTS messages (
			message_id      INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id),
			role            TEXT NOT NULL,
			content         TEXT NOT NULL DEFAULT '',
			model_name      TEXT NOT NULL DEFAULT '',
			reasoning_content TEXT NOT NULL DEFAULT '',
			token_count     INTEGER NOT NULL DEFAULT 0,
			created_at      TEXT NOT NULL DEFAULT (datetime('now'))
		)`,

		`CREATE TABLE IF NOT EXISTS message_parts (
			part_id     INTEGER PRIMARY KEY AUTOINCREMENT,
			message_id  INTEGER NOT NULL REFERENCES messages(message_id),
			type        TEXT NOT NULL,
			text        TEXT,
			name        TEXT,
			arguments   TEXT,
			tool_call_id TEXT,
			media_uri   TEXT,
			mime_type   TEXT,
			ordinal     INTEGER NOT NULL DEFAULT 0
		)`,

		`CREATE TABLE IF NOT EXISTS summaries (
			summary_id                TEXT PRIMARY KEY,
			conversation_id           INTEGER NOT NULL REFERENCES conversations(conversation_id),
			kind                      TEXT NOT NULL,
			depth                     INTEGER NOT NULL DEFAULT 0,
			content                   TEXT NOT NULL,
			token_count               INTEGER NOT NULL DEFAULT 0,
			earliest_at               TEXT,
			latest_at                 TEXT,
			descendant_count          INTEGER NOT NULL DEFAULT 0,
			descendant_token_count    INTEGER NOT NULL DEFAULT 0,
			source_message_token_count INTEGER NOT NULL DEFAULT 0,
			model                     TEXT,
			created_at                TEXT NOT NULL DEFAULT (datetime('now'))
		)`,

		`CREATE TABLE IF NOT EXISTS summary_parents (
			summary_id        TEXT NOT NULL,
			parent_summary_id TEXT NOT NULL,
			PRIMARY KEY (summary_id, parent_summary_id)
		)`,

		`CREATE TABLE IF NOT EXISTS summary_messages (
			summary_id TEXT NOT NULL,
			message_id INTEGER NOT NULL,
			ordinal    INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (summary_id, message_id)
		)`,

		`CREATE TABLE IF NOT EXISTS context_items (
			conversation_id INTEGER NOT NULL,
			generation      INTEGER NOT NULL DEFAULT 0,
			ordinal         INTEGER NOT NULL,
			item_type       TEXT NOT NULL,
			summary_id      TEXT,
			message_id      INTEGER,
			token_count     INTEGER NOT NULL DEFAULT 0,
			created_at      TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (conversation_id, ordinal)
		)`,

		// FTS5 virtual table with trigram tokenizer for CJK support
		sqlCreateSummariesFTS,

		// FTS5 virtual table for message search with trigram tokenizer
		sqlCreateMessagesFTS,

		// Indexes for common query patterns
		`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`,
		`CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(conversation_id, created_at)`,
		// message_parts is looked up by message_id on every message load and every
		// delete. Without this index each lookup scans the whole table and builds a
		// temp B-tree for the ORDER BY ordinal; bootstrap loads every message of a
		// conversation one at a time, so the cost was quadratic in session size
		// (measured 4.24ms -> 0.01ms per lookup on a 13k-row table). The ordinal
		// column makes it covering, which also removes the temp B-tree.
		`CREATE INDEX IF NOT EXISTS idx_message_parts_message ON message_parts(message_id, ordinal)`,
		`CREATE INDEX IF NOT EXISTS idx_summaries_conversation ON summaries(conversation_id)`,
		`CREATE INDEX IF NOT EXISTS idx_summaries_kind_depth ON summaries(conversation_id, kind, depth)`,
		`CREATE INDEX IF NOT EXISTS idx_summary_parents_parent ON summary_parents(parent_summary_id)`,
		`CREATE INDEX IF NOT EXISTS idx_summary_messages_message ON summary_messages(message_id)`,
		`CREATE INDEX IF NOT EXISTS idx_context_items_conv ON context_items(conversation_id, ordinal)`,

		// Drop old triggers before creating new ones so existing DBs get updated bodies.
		// (CREATE TRIGGER IF NOT EXISTS does NOT replace an existing trigger body.)
		`DROP TRIGGER IF EXISTS summaries_ai`,
		`DROP TRIGGER IF EXISTS summaries_ad`,
		`DROP TRIGGER IF EXISTS summaries_au`,
		`DROP TRIGGER IF EXISTS messages_ai`,
		`DROP TRIGGER IF EXISTS messages_ad`,
		`DROP TRIGGER IF EXISTS messages_au`,

		// FTS5 triggers to keep summaries_fts in sync with summaries table
		`CREATE TRIGGER summaries_ai AFTER INSERT ON summaries BEGIN
			INSERT INTO summaries_fts (summary_id, content) VALUES (new.summary_id, new.content);
		END`,
		`CREATE TRIGGER summaries_ad AFTER DELETE ON summaries BEGIN
			DELETE FROM summaries_fts WHERE summary_id = old.summary_id;
		END`,
		`CREATE TRIGGER summaries_au AFTER UPDATE ON summaries BEGIN
			DELETE FROM summaries_fts WHERE summary_id = old.summary_id;
			INSERT INTO summaries_fts (summary_id, content) VALUES (new.summary_id, new.content);
		END`,

		// FTS5 triggers to keep messages_fts in sync with messages table
		`CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
			INSERT INTO messages_fts (message_id, content) VALUES (new.message_id, new.content);
		END`,
		`CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
			DELETE FROM messages_fts WHERE message_id = old.message_id;
		END`,
		`CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
			DELETE FROM messages_fts WHERE message_id = old.message_id;
			INSERT INTO messages_fts (message_id, content) VALUES (new.message_id, new.content);
		END`,
	}

	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			return err
		}
	}

	if err := ensureMessagesReasoningContentColumn(db); err != nil {
		return err
	}
	if err := ensureMessagesModelNameColumn(db); err != nil {
		return err
	}
	if err := ensureActiveContextColumns(db); err != nil {
		return err
	}
	return nil
}

func ensureActiveContextColumns(db *sql.DB) error {
	columns := []struct {
		table, name, definition string
	}{
		{"conversations", "active_generation", "INTEGER NOT NULL DEFAULT 0"},
		{"conversations", "active_turn_count", "INTEGER NOT NULL DEFAULT 0"},
		{"conversations", "last_summary_turn", "INTEGER NOT NULL DEFAULT 0"},
		{"context_items", "generation", "INTEGER NOT NULL DEFAULT 0"},
	}
	for _, column := range columns {
		hasColumn, err := tableHasColumn(db, column.table, column.name)
		if err != nil {
			return fmt.Errorf("check %s.%s: %w", column.table, column.name, err)
		}
		if !hasColumn {
			if _, err := db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", column.table, column.name, column.definition)); err != nil {
				return fmt.Errorf("add %s.%s: %w", column.table, column.name, err)
			}
		}
	}

	// Existing databases predate active-window counters. Generation zero contains
	// the current context, so initialize its completed user-turn count once.
	_, err := db.Exec(`UPDATE conversations
		SET active_turn_count = (
			SELECT COUNT(*) FROM messages
			WHERE messages.conversation_id = conversations.conversation_id
			  AND lower(trim(messages.role)) = 'user'
		)
		WHERE active_generation = 0 AND active_turn_count = 0`)
	if err != nil {
		return fmt.Errorf("backfill active turn counts: %w", err)
	}
	return nil
}

func ensureMessagesReasoningContentColumn(db *sql.DB) error {
	hasColumn, err := tableHasColumn(db, "messages", "reasoning_content")
	if err != nil {
		return fmt.Errorf("check messages.reasoning_content: %w", err)
	}
	if hasColumn {
		return nil
	}

	if _, err := db.Exec(`ALTER TABLE messages ADD COLUMN reasoning_content TEXT NOT NULL DEFAULT ''`); err != nil {
		return fmt.Errorf("add messages.reasoning_content: %w", err)
	}
	return nil
}

func ensureMessagesModelNameColumn(db *sql.DB) error {
	hasColumn, err := tableHasColumn(db, "messages", "model_name")
	if err != nil {
		return fmt.Errorf("check messages.model_name: %w", err)
	}
	if hasColumn {
		return nil
	}

	if _, err := db.Exec(`ALTER TABLE messages ADD COLUMN model_name TEXT NOT NULL DEFAULT ''`); err != nil {
		return fmt.Errorf("add messages.model_name: %w", err)
	}
	return nil
}

func tableHasColumn(db *sql.DB, tableName, columnName string) (bool, error) {
	rows, err := db.Query(fmt.Sprintf(`PRAGMA table_info(%s)`, tableName))
	if err != nil {
		return false, err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			cid        int
			name       string
			columnType string
			notNull    int
			defaultVal sql.NullString
			pk         int
		)
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultVal, &pk); err != nil {
			return false, err
		}
		if name == columnName {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	return false, nil
}

// checkFTS5Support verifies that SQLite has FTS5 with trigram tokenizer enabled.
// This is required for full-text search with CJK (Chinese, Japanese, Korean) support.
func checkFTS5Support(db *sql.DB) error {
	// Check if FTS5 is compiled in
	var fts5Enabled int
	err := db.QueryRow(`SELECT sqlite_compileoption_used('ENABLE_FTS5')`).Scan(&fts5Enabled)
	if err != nil {
		// sqlite_compileoption_used might not exist in older SQLite
		// Try a different approach: create a test FTS5 table
		_, testErr := db.Exec(sqlCheckFTS5Available)
		if testErr != nil {
			return fmt.Errorf("SQLite FTS5 not available: %w (required for full-text search)", testErr)
		}
		db.Exec(sqlDropFTS5Check)
	} else if fts5Enabled == 0 {
		return fmt.Errorf("SQLite was compiled without FTS5 support (required for full-text search)")
	}

	// Check if trigram tokenizer is available by trying to create a test table
	// Not all SQLite builds include the trigram tokenizer
	_, err = db.Exec(sqlCheckTrigramAvailable)
	if err != nil {
		logger.WarnCF("seahorse", "SQLite trigram tokenizer not available, CJK search may be limited",
			map[string]any{"error": err.Error()})
		// Trigram is not strictly required, just better for CJK
		// Don't return error, just log warning
	} else {
		db.Exec(sqlDropTrigramCheck)
	}

	return nil
}
