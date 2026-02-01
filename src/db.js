/**
 * D1 Database helper functions for TeraBox proxy
 */

/**
 * Save share-level metadata to D1
 * @param {D1Database} db - D1 database binding
 * @param {string} shareId - The share URL identifier (surl)
 * @param {object} data - Upstream API response data
 */
export async function saveShare(db, shareId, data) {
  const stmt = db.prepare(`
    INSERT INTO shares (share_id, uk, title, server_time, cfrom_id, errno, request_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(share_id) DO UPDATE SET
      uk = excluded.uk,
      title = excluded.title,
      server_time = excluded.server_time,
      cfrom_id = excluded.cfrom_id,
      errno = excluded.errno,
      request_id = excluded.request_id,
      updated_at = CURRENT_TIMESTAMP
  `);

  await stmt.bind(
    shareId,
    data.uk?.toString() || null,
    data.title || null,
    data.server_time || null,
    data.cfrom_id || null,
    data.errno || 0,
    data.request_id?.toString() || null
  ).run();
}

/**
 * Save media file metadata to D1
 * @param {D1Database} db - D1 database binding
 * @param {string} shareId - The share URL identifier
 * @param {object} file - File object from API response
 */
export async function saveMediaFile(db, shareId, file) {
  const stmt = db.prepare(`
    INSERT INTO media_files (
      fs_id, share_id, category, isdir, local_ctime, local_mtime,
      md5, path, play_forbid, server_ctime, server_filename,
      server_mtime, size, is_adult, cmd5, dlink
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fs_id) DO UPDATE SET
      share_id = excluded.share_id,
      category = excluded.category,
      md5 = excluded.md5,
      path = excluded.path,
      server_filename = excluded.server_filename,
      server_mtime = excluded.server_mtime,
      size = excluded.size,
      is_adult = excluded.is_adult,
      cmd5 = excluded.cmd5,
      dlink = excluded.dlink
  `);

  await stmt.bind(
    file.fs_id,
    shareId,
    file.category || null,
    file.isdir || 0,
    file.local_ctime || null,
    file.local_mtime || null,
    file.md5 || null,
    file.path || null,
    file.play_forbid || 0,
    file.server_ctime || null,
    file.server_filename || null,
    file.server_mtime || null,
    file.size ? Number(file.size) : null,
    file.is_adult || 0,
    file.cmd5 || null,
    file.dlink || null
  ).run();

  // Save thumbnails if present
  if (file.thumbs) {
    await saveThumbnails(db, file.fs_id, file.thumbs);
  }
}

/**
 * Save thumbnail URLs to D1
 * @param {D1Database} db - D1 database binding
 * @param {string} fsId - File system ID
 * @param {object} thumbs - Thumbnails object with url1, url2, url3, icon
 */
export async function saveThumbnails(db, fsId, thumbs) {
  // Delete existing thumbnails for this file
  await db.prepare('DELETE FROM thumbnails WHERE fs_id = ?').bind(fsId).run();

  const thumbnailTypes = ['url1', 'url2', 'url3', 'icon'];
  const batch = [];

  for (const type of thumbnailTypes) {
    if (thumbs[type]) {
      batch.push(
        db.prepare('INSERT INTO thumbnails (fs_id, url, thumbnail_type) VALUES (?, ?, ?)')
          .bind(fsId, thumbs[type], type)
      );
    }
  }

  if (batch.length > 0) {
    await db.batch(batch);
  }
}

/**
 * Store complete upstream response in D1
 * @param {D1Database} db - D1 database binding
 * @param {string} shareId - The share URL identifier
 * @param {object} upstream - Complete upstream API response
 */
export async function storeUpstreamData(db, shareId, upstream) {
  try {
    // Save share metadata
    await saveShare(db, shareId, upstream);

    // Save all files in the list
    if (upstream.list && Array.isArray(upstream.list)) {
      for (const file of upstream.list) {
        await saveMediaFile(db, shareId, file);
      }
    }

    return true;
  } catch (err) {
    console.error('D1 storage error:', err);
    return false;
  }
}

/**
 * Get share data from D1
 * @param {D1Database} db - D1 database binding
 * @param {string} shareId - The share URL identifier
 */
export async function getShareFromDb(db, shareId) {
  const share = await db.prepare('SELECT * FROM shares WHERE share_id = ?')
    .bind(shareId)
    .first();

  if (!share) return null;

  const files = await db.prepare('SELECT * FROM media_files WHERE share_id = ?')
    .bind(shareId)
    .all();

  // Get thumbnails for each file
  const filesWithThumbs = await Promise.all(
    files.results.map(async (file) => {
      const thumbs = await db.prepare('SELECT url, thumbnail_type FROM thumbnails WHERE fs_id = ?')
        .bind(file.fs_id)
        .all();
      
      const thumbsObj = {};
      thumbs.results.forEach(t => {
        thumbsObj[t.thumbnail_type] = t.url;
      });

      return { ...file, thumbs: thumbsObj };
    })
  );

  return {
    ...share,
    list: filesWithThumbs
  };
}
