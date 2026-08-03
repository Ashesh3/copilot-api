# Model Routing GitHub Usernames

## Goal

Make each Model Routing account column identifiable without exposing its GitHub token. Keep the stable numeric account identifier while adding the GitHub username associated with that token.

## User Experience

Each account column keeps `Account #N` as its primary label. Its muted supporting line shows `@username · N models` when a username is available, and retains the existing `N models` text when it is not.

The health indicator, model switches, column order, and numeric account identifiers remain unchanged. The accessible account summary and tooltip include the username only when available.

## Data Flow

During account initialization, the token pool requests the authenticated user from GitHub's `/user` endpoint with that account's GitHub token. The returned login is stored only in the in-memory account object.

The authenticated `GET /dashboard/api/model-routing` response adds an optional `githubUsername` field for each account. The dashboard type mirrors this optional field and renders it in the account header. Tokens are never included in the response.

## Failure Handling

Username discovery is supplemental. A failed `/user` request must not make an otherwise valid Copilot account unhealthy or prevent startup. The failure is logged without the token, the username remains absent, and the UI falls back to the current `N models` supporting text.

Username discovery happens once during account initialization rather than on each dashboard request. Copilot token refreshes do not repeat it because a token's account identity is stable for the process lifetime.

## Testing and Verification

- Token-pool coverage verifies successful username discovery and non-fatal lookup failure.
- Dashboard API coverage verifies that an available username is returned and no GitHub token is exposed.
- UI typechecking and the dashboard build verify the optional field and regenerate `src/routes/dashboard/page-generated.ts`.
- Focused tests, repository typechecking, build, lint for changed source files, and `git diff --check` provide final verification.

## Scope

This change affects only the Model Routing account headers and the in-memory metadata needed to support them. It does not persist usernames, rename accounts elsewhere, change routing behavior, or add dashboard-time GitHub calls.
