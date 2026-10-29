CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  submissions_open_at TEXT NOT NULL,
  submissions_close_at TEXT NOT NULL,
  max_photos_per_person INTEGER NOT NULL CHECK (max_photos_per_person >= 1),
  max_likes_per_person INTEGER CHECK (max_likes_per_person IS NULL OR max_likes_per_person >= 1),
  results_published_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  max_photos_per_person INTEGER CHECK (max_photos_per_person IS NULL OR max_photos_per_person >= 1),
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX categories_competition ON categories(competition_id);

CREATE TABLE applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  UNIQUE (competition_id, user_id)
);

CREATE TABLE photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  taken_at TEXT,
  latitude REAL,
  longitude REAL,
  location_name TEXT,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  full_key TEXT NOT NULL,
  thumb_key TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  winner_label TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX photos_competition ON photos(competition_id, category_id);
CREATE INDEX photos_user ON photos(competition_id, user_id);

CREATE TABLE votes (
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (photo_id, user_id)
);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX comments_photo ON comments(photo_id);

-- Points added by the admin on behalf of external judges (admin-only until results are published).
CREATE TABLE judge_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  judge_name TEXT NOT NULL,
  points INTEGER NOT NULL CHECK (points >= 1),
  created_at TEXT NOT NULL
);
CREATE INDEX judge_votes_photo ON judge_votes(photo_id);
