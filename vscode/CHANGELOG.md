# Changelog

## 1.0.6

- Fixed Pull failing with "not something we can merge" / "Cannot rebase onto multiple branches" when pressed repeatedly: operations on the same repository now run one at a time.

## 1.0.5

- Sidebar highlights a single representative ref for the selected commit, even inside collapsed sections or folders.
- Clearer errors when applying a stash fails because of conflicts.
- Fixed the amend checkbox stretching out of line with its label.

## 1.0.4

- Webview UI state (collapsed sidebar sections and so on) is kept when the view is reopened.
- Commit details can sit on the right (default, with an inline message editor) or at the bottom.
- Edit a commit message from the details pencil or the graph context menu (amend for HEAD, reword rebase for older commits).
- Checkout blocked by local changes stashes them, switches and re-applies them.
- Drag tabs to reorder; search shows the list of matching commits.

## 1.0.3

- Redesigned commit details: the subject wraps up to three lines, the first body line is previewed under it (click to show the full message), and author, co-authors (by name), committer (when different), commit and parent hashes are shown compactly.
- Clicking a commit hash copies the full SHA.
- Pane splitters are thicker with a grip, like VS Code.
- Auto-fetch is on by default (every 5 minutes) and also runs when a repository is opened, so changes pushed elsewhere show up in the Pull badge.
- Fetch also gets tags that are not on any branch (local-only tags are kept).
- Deleting a branch checked out in another worktree offers to remove that worktree too; unmerged branches offer a force delete.
- Popping, applying or dropping a stash that no longer exists shows a notice and refreshes the list instead of an error.

## 1.0.2

- The git403 status bar item now always opens the full git403 view in an editor tab, regardless of the graph location setting.
- Failures are no longer shown as "nothing": settings, pull requests, remotes, changed files, Git LFS and git itself now show the real cause.
- If the GitHub account linked to a repository can't be verified, push and PRs stop with the reason instead of using another account.
- Rejected pushes show the actual cause (`! [rejected]`, `error:`) instead of a `hint:` line.

## 1.0.1

- License changed to GPL-3.0.

## 1.0.0

- First release: commit graph panel, inline blame and status bar, CodeLens, Branches/Tags/Stashes/Remotes views, File/Line History.
