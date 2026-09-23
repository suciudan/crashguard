# gh --paginate --slurp returns an array of pages, each containing PR records.
# Commit association alone is insufficient: deploy only the actual merge result.
any(.[][];
  .merged_at != null and
  .merge_commit_sha == $sha and
  .head.repo.full_name == $repo and
  .base.repo.full_name == $repo and
  .head.ref == "main" and
  .base.ref == "production"
)
