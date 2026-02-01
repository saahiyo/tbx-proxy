-- Shares table: stores share-level metadata
CREATE TABLE IF NOT EXISTS shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id TEXT UNIQUE NOT NULL,
    uk TEXT,
    title TEXT,
    server_time INTEGER,
    cfrom_id INTEGER,
    errno INTEGER DEFAULT 0,
    request_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Media files table: stores individual file metadata
CREATE TABLE IF NOT EXISTS media_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fs_id TEXT UNIQUE NOT NULL,
    share_id TEXT,
    category TEXT,
    isdir INTEGER DEFAULT 0,
    local_ctime TEXT,
    local_mtime TEXT,
    md5 TEXT,
    path TEXT,
    play_forbid INTEGER DEFAULT 0,
    server_ctime TEXT,
    server_filename TEXT,
    server_mtime TEXT,
    size INTEGER,
    is_adult INTEGER DEFAULT 0,
    cmd5 TEXT,
    dlink TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (share_id) REFERENCES shares(share_id) ON DELETE CASCADE
);

-- Thumbnails table: stores multiple thumbnail URLs per file
CREATE TABLE IF NOT EXISTS thumbnails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fs_id TEXT NOT NULL,
    url TEXT NOT NULL,
    thumbnail_type TEXT NOT NULL,
    FOREIGN KEY (fs_id) REFERENCES media_files(fs_id) ON DELETE CASCADE
);

-- Indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_shares_share_id ON shares(share_id);
CREATE INDEX IF NOT EXISTS idx_shares_uk ON shares(uk);
CREATE INDEX IF NOT EXISTS idx_media_files_fs_id ON media_files(fs_id);
CREATE INDEX IF NOT EXISTS idx_media_files_share_id ON media_files(share_id);
CREATE INDEX IF NOT EXISTS idx_media_files_path ON media_files(path);
CREATE INDEX IF NOT EXISTS idx_media_files_server_filename ON media_files(server_filename);
CREATE INDEX IF NOT EXISTS idx_thumbnails_fs_id ON thumbnails(fs_id);