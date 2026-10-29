export interface User {
  id: number
  name: string
  email: string
  picture: string | null
}

export interface Competition {
  id: number
  admin_id: number
  admin_name: string
  title: string
  description: string
  status: 'draft' | 'published'
  submissions_open_at: string
  submissions_close_at: string
  max_photos_per_person: number
  max_likes_per_person: number | null
  results_published_at: string | null
}

export interface Category {
  id: number
  name: string
  description: string
  max_photos_per_person: number | null
}

export interface CompetitionDetail {
  competition: Competition
  categories: Category[]
  is_admin: boolean
  application: 'pending' | 'approved' | 'rejected' | null
  my_counts: { total: number; by_category: Record<number, number> }
  likes_used: number
  upload_blocked: string | null
}

export interface PhotoSummary {
  id: number
  category_id: number
  title: string
  width: number
  height: number
  uploader_id: number
  uploader_name: string
  taken_at: string | null
  hidden: boolean
  winner_label: string | null
  liked_by_me: boolean
  is_mine: boolean
  comment_count: number
  // Only present for the competition admin, or once results are published:
  vote_count?: number
  judge_points?: number
  total_score?: number
}

export interface PhotoDetail {
  id: number
  competition: { id: number; title: string; results_published_at: string | null }
  category_name: string
  title: string
  uploader_name: string
  taken_at: string | null
  latitude: number | null
  longitude: number | null
  location_name: string | null
  hidden: boolean
  winner_label: string | null
  liked_by_me: boolean
  is_mine: boolean
  is_admin: boolean
  can_vote: boolean
  can_edit: boolean
  can_delete: boolean
  vote_count?: number
  judge_points?: number
  total_score?: number
}

export interface CommentItem {
  id: number
  author_name: string
  body: string
  hidden: boolean
  created_at: string
  can_delete: boolean
  can_hide: boolean
}
