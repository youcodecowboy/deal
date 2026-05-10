# Tenancy and Authentication Architecture

**Date:** 2026-05-10
**Status:** Approved (design phase)
**Stack:** Next.js (App Router) · Convex · Clerk

## Overview

Specifies the multi-tenancy data model and authentication flow for a deal-management application. Defines:

- A **workspace** abstraction that unifies individual users and Clerk Organizations under one tenant key
- The **Clerk → Convex** authentication and authorization flow
- The **role-based access model** for deals (Owner / Editor / Reviewer / Viewer)
- The **lifecycle flows**: signup, org sync, invitations, role changes, deletions

The deal data model itself — what attributes a deal stores, lifecycle states, custom fields per deal — is intentionally **out of scope** here. Deals are modeled minimally as containers; their full shape is the subject of a separate design.

## Scope

**In scope:**

- Schema for `users`, `orgs`, `workspaces`, `deals` (minimal), `dealMembers`, `dealInvites`, `dealFiles`, `personalFiles`
- Clerk JWT template + Convex `auth.config.ts`
- Three authorization helpers covering every access check in the app
- Invitation flow: existing-user direct path + new-email magic-link path + pending resolution
- Workspace lifecycle (creation, soft-delete via Clerk webhook)
- Last-owner protection invariant
- Active workspace switching via Clerk

**Out of scope (future specs / later iterations):**

- Deal data model (custom attributes, lifecycle stages, deal-specific fields)
- Email provider for invite delivery (Resend / Loops / Postmark — chosen at implementation)
- In-app notifications and activity feed
- Audit logs
- Billing and subscription plans
- Hard delete / GDPR purge / data export
- Two-factor / SSO configuration in Clerk (handled by Clerk; we just consume the JWT)
- Org-level shared file vault (only personal vault and deal-scoped files in v1)
- Custom Clerk roles beyond the built-in `org:admin` and `org:member`

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Deal–user model | Owner + invited collaborators, with promote-to-co-owner | Most deals are owner-led; co-ownership is just `role: "owner"` on a second membership row |
| Permission model | Preset roles: `owner`, `editor`, `reviewer`, `viewer` | Clear UX, single field per membership, room to grow into composable permissions later |
| Files | Personal vault separate from deal files | Two surfaces, one switch in authorization (`scope`); supports cross-deal "my working library" |
| Tenant boundary | Hybrid: individual users by default, optional Clerk Organizations | Day-1 simple; firm-level workspaces possible without rework |
| Workspace abstraction | Single `workspaces` table unifying personal + org | One tenant key; every query and authorization check has one shape |
| Org admin → deal access | Implicit `owner` on org-owned deals (no `dealMembers` row needed) | Org admins manage org deals; non-admin org members are invitation-only |
| Org-level shared vault | Not in v1 | Punted unless a use case emerges |
| Deletion | Soft delete (archive flag) everywhere | Recoverable; no destructive cascades in v1 |

## Data model

### Diagram

```
Clerk (identity)                       Convex (data + authorization)
───────────────────                    ──────────────────────────────
User (clerkId)         ──lazy sync──▶  users
Organization (clerkOrgId) ──webhook──▶ orgs
                                        │
                                        ▼
                          workspaces ── (type: "personal" | "org")
                                        │
                          ┌─────────────┴─────────────┐
                          ▼                           ▼
                        deals                  personalFiles
                       (workspaceId)         (workspaceId, only "personal")
                          │
                          ├──▶ dealMembers (dealId, userId, role)
                          ├──▶ dealInvites (dealId, email, token, expiresAt)
                          └──▶ dealFiles   (dealId, uploaderId, storageId)
```

### Tables (Convex sketch)

```ts
users {
  clerkId: string,
  email: string,
  name: string,
  imageUrl?: string,
  deletedAt?: number,
}.index("by_clerkId", ["clerkId"])
 .index("by_email",   ["email"]),

orgs {
  clerkOrgId: string,
  name: string,
  slug: string,
  imageUrl?: string,
  deletedAt?: number,
}.index("by_clerkOrgId", ["clerkOrgId"]),

workspaces {
  type: "personal" | "org",
  ownerUserId?: Id<"users">,    // when type = "personal"
  orgId?: Id<"orgs">,           // when type = "org"
  name: string,
  status: "active" | "archived",
}.index("by_owner", ["ownerUserId"])
 .index("by_org",   ["orgId"]),

deals {
  workspaceId: Id<"workspaces">,
  name: string,
  status: "active" | "archived",
  createdBy: Id<"users">,
  createdAt: number,
  // full deal attributes are a future spec
}.index("by_workspace",        ["workspaceId"])
 .index("by_workspace_status", ["workspaceId", "status"]),

dealMembers {
  dealId: Id<"deals">,
  userId: Id<"users">,
  role: "owner" | "editor" | "reviewer" | "viewer",
  invitedBy: Id<"users">,
  invitedAt: number,
}.index("by_deal_user", ["dealId", "userId"])
 .index("by_user",      ["userId"]),

dealInvites {
  dealId: Id<"deals">,
  email: string,                              // lowercased
  role: "editor" | "reviewer" | "viewer",     // owner cannot be a pending invite
  invitedBy: Id<"users">,
  invitedAt: number,
  expiresAt: number,
  token: string,
}.index("by_email", ["email"])
 .index("by_token", ["token"])
 .index("by_deal",  ["dealId"]),

dealFiles {
  dealId: Id<"deals">,
  uploaderId: Id<"users">,
  storageId: Id<"_storage">,
  name: string,
  mimeType: string,
  size: number,
  uploadedAt: number,
}.index("by_deal", ["dealId"]),

personalFiles {
  workspaceId: Id<"workspaces">,    // always type:"personal"
  ownerUserId: Id<"users">,
  storageId: Id<"_storage">,
  name: string,
  mimeType: string,
  size: number,
  uploadedAt: number,
}.index("by_owner", ["ownerUserId"]),
```

### Invariants (enforced in mutations)

1. Exactly one Personal workspace per user; created on first authenticated request; never deleted while the user is active.
2. Exactly one Org workspace per Clerk org; created/updated/deleted via Clerk webhook.
3. Every active deal has at least one `dealMembers` row with `role: "owner"`.
4. `workspaces.type === "personal"` ⇔ `ownerUserId` set, `orgId` null (XOR with org).
5. `personalFiles.workspaceId` references a `type: "personal"` workspace.
6. `dealInvites` rows are unique per `(dealId, email)`; re-inviting upserts.

### Why two file tables, not one with a `scope` field

Personal files only filter `by_owner`; deal files only filter `by_deal`. A unified table would need both indexes plus a discriminator and conditional logic in every query. Splitting also keeps deletion/retention policies independent (personal files purge on user delete; deal files retain per deal lifecycle).

## Authentication and authorization

### Identity flow

1. User signs in via Clerk
2. Clerk creates a session and exposes a JWT via `useAuth().getToken({ template: "convex" })`
3. `ConvexProviderWithClerk` (from `convex/react-clerk`) attaches the token to every Convex request
4. Convex validates the JWT against Clerk's JWKS endpoint (configured in `convex/auth.config.ts`)
5. Inside any Convex function, `await ctx.auth.getUserIdentity()` returns parsed claims or `null`

### Configuration

**Clerk dashboard:**

- JWT template named `convex`, audience `convex`
- Default Clerk claims expose `sub` (user ID), `email`, plus `org_id`, `org_role`, `org_slug` when an org is active
- Webhook → Convex `httpAction` URL with org events (`organization.created`, `.updated`, `.deleted`) and user events (`user.deleted`)

**Convex `convex/auth.config.ts`:**

```ts
export default {
  providers: [
    {
      domain: process.env.CLERK_FRONTEND_API_URL!,
      applicationID: "convex",
    },
  ],
};
```

**Next.js app:**

- Wrap the app in `<ClerkProvider>` (uses `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`)
- Replace the existing `ConvexClientProvider` with `ConvexProviderWithClerk` from `convex/react-clerk`
- Add `clerkMiddleware` from `@clerk/nextjs/server` to gate authenticated routes

### Identity ↔ users join

`getUserIdentity()` returns Clerk claims, not a Convex `users` row. A helper bridges:

```ts
// convex/_helpers/auth.ts
export async function getCurrentUser(ctx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  const user = await ctx.db.query("users")
    .withIndex("by_clerkId", q => q.eq("clerkId", identity.subject))
    .unique();
  if (!user) throw new Error("User not yet provisioned");
  return user;
}
```

Lazy provisioning lives in a dedicated `ensureUser` mutation called once on first authenticated load (see Lifecycle § 1).

### Authorization helpers (the entire surface)

```ts
// 1) Workspace access
assertWorkspaceAccess(ctx, workspaceId)
  → { user, workspace, workspaceRole: "admin" | "member" }
// Personal: identity.subject must match workspace.ownerUserId's clerkId
// Org:      identity.org_id must match workspace.orgId's clerkOrgId
// workspaceRole derived from identity.org_role

// 2) Deal access
assertDealAccess(ctx, dealId, requiredRole)
  → { user, deal, dealRole: "viewer" | "reviewer" | "editor" | "owner" }
// Look up dealMembers row by (dealId, userId).
// If no row, deal is org-owned, and identity.org_role == "org:admin", grant "owner".
// Throw if effective role < requiredRole.

// 3) Personal file access
assertPersonalFileAccess(ctx, fileId)
  → { user, file }
// file.ownerUserId must equal user._id.
```

Role ordering: `viewer < reviewer < editor < owner`. `requiredRole: "editor"` means "editor or higher passes."

**Assertions throw on failure.** Convex mutations are transactional; throwing aborts the entire transaction. There is no return-false variant — fail-closed by design. For UI gating, separate pure predicate functions (e.g., `canEditDeal(role)`) return booleans; these are imported by both Convex queries and React components.

### Authorization invariants

- Every Convex query/mutation that touches a workspace, deal, or file calls exactly one `assert*` helper as its first line.
- Active workspace context is always derived from the JWT inside Convex — never accepted as a client-passed argument.
- Role checks compare against the role ordering, not equality.

## Lifecycle flows

### 1. User signup → personal workspace

**Trigger:** user completes Clerk signup; lands on the app authenticated.

**Flow:**

1. Client `useEffect` calls `ensureUser` mutation on first authenticated render.
2. `ensureUser` runs in a single transaction:
   - Reads `getUserIdentity()` (subject, email, name, imageUrl)
   - Upserts `users` row by `by_clerkId`
   - Creates a `workspaces` row (`type: "personal"`, `ownerUserId`, name `"<FirstName>'s Workspace"`) if absent
   - Resolves any pending `dealInvites` matching `users.email`: inserts `dealMembers` rows, deletes the matching `dealInvites` rows
3. Returns `{ user, personalWorkspace }`.

**Why client-driven, not a `user.created` webhook:** webhooks are at-least-once with retries; the client call is synchronous on every load, so the user is always provisioned before they see the app. Pending-invite resolution piggybacks here for free.

### 2. Clerk Org sync → org workspace (webhook)

**Trigger:** Clerk emits `organization.created` / `organization.updated` / `organization.deleted`.

**Endpoint:** Convex `httpAction` mounted at `/clerk-webhook` (registered in `convex/http.ts`).

**Flow:**

1. Verify the webhook signature using `svix` headers + `CLERK_WEBHOOK_SECRET`.
2. Route by event type:
   - `created` → upsert `orgs` row by `clerkOrgId`; create `workspaces` row (`type: "org"`)
   - `updated` → patch `orgs` row (name, slug, imageUrl) and `workspaces.name` if changed
   - `deleted` → set `orgs.deletedAt`; archive workspace and its deals (`status: "archived"`); preserve data

All branches use upsert by `clerkOrgId` — re-delivery is safe.

**Reliability:** if a webhook fails verification or processing, the `httpAction` returns 4xx/5xx and Clerk retries with exponential backoff. There is no separate reconciliation job in v1; if drift is observed, manual replay of recent events is the recovery path.

### 3. Invitation: invite → accept

**Trigger:** owner submits an invite (email + role: `editor` | `reviewer` | `viewer`).

**Flow:**

1. `inviteToDeal` mutation:
   - Asserts caller has `owner` on the deal
   - Lowercases the email
   - Looks up `users` `by_email`
   - **Existing user** → insert `dealMembers` row; schedule notification
   - **New email** → insert `dealInvites` row with random token + `expiresAt = now + 14 days`; schedule a Convex `internalAction` to send a magic link `https://<app>/invites/<token>`

2. Magic-link handler `app/invites/[token]/page.tsx`:
   - Look up `dealInvites by_token`
   - Expired or missing → friendly error
   - Not signed in → redirect to Clerk sign-up with email pre-filled and `?after_sign_up_url=/invites/<token>`
   - Signed in, email matches → call `acceptInvite` mutation: insert `dealMembers`, delete `dealInvites`, redirect to the deal
   - Signed in, email mismatches → "Sign out and sign in with the invited email"

**Concurrency:** `acceptInvite` is a single transactional mutation; concurrent accepts cannot double-insert. Pending-invite resolution from `ensureUser` (Lifecycle § 1) takes the same insert path.

**Re-invitation:** if the email already has a `dealInvites` row for the same `dealId`, the second invite updates the role and resets `expiresAt`. No duplicate rows.

### 4. Membership operations

`changeMemberRole(dealId, userId, role)` and `removeMember(dealId, userId)`:

1. Assert caller has `owner` on the deal
2. Apply the change inside the same transaction
3. **Last-owner protection:** if the change would leave zero `dealMembers` rows with `role: "owner"`, throw — caller must promote someone first or archive the deal

### 5. Active workspace switching

The active workspace is owned by Clerk via `setActive({ organization })` (or `null` for personal). The JWT updates with `org_id` / `org_role`; the Convex client refetches its token; queries re-run with the new claims.

UI surface: Clerk's `<OrganizationSwitcher />` or a custom switcher that calls `setActive`.

### 6. File operations

- **Upload (personal):** mutation creates `personalFiles` row, returns a Convex storage upload URL; client uploads bytes to Convex storage; mutation patches `storageId`. Auth: caller must own the workspace.
- **Upload (deal):** same shape into `dealFiles`. Auth: caller has `editor` or higher on the deal.
- **Download:** mutation returns a signed Convex storage URL after the access assertion; client fetches bytes from Convex storage directly.

### 7. Deletion semantics

| Trigger | Effect |
|---|---|
| User deletes Clerk account | `user.deleted` webhook → soft-delete `users`; archive personal workspace, deals, files |
| Org admin deletes Clerk org | `organization.deleted` webhook → archive org workspace + its deals |
| Owner archives a deal | `deals.status = "archived"`; deal becomes read-only; can be unarchived |
| Hard deletion / GDPR purge | Out of scope for v1; admin-only path later |

Soft delete is the default everywhere in v1. No data is permanently destroyed by user-initiated actions.

## Testing strategy

- **Unit tests** (using `convex-test`):
  - The three `assert*` helpers — every authorization branch (each role; personal workspace; org workspace with admin; org workspace with non-admin; missing membership)
  - `ensureUser` — first-time creation, idempotency on retry, pending invite resolution
  - `inviteToDeal`, `acceptInvite` — existing-user path, new-email path, expired token, mismatched email
  - `changeMemberRole`, `removeMember` — last-owner protection
- **Integration tests:**
  - Clerk webhook handler — signature verification (positive + negative), idempotent re-delivery
- **End-to-end smoke** (Playwright or similar, post-MVP):
  - Two-account flow: User A creates a deal, invites User B by email, User B signs up and accepts, User A promotes User B to co-owner

`convex-test` runs the backend in-memory, so unit tests are fast and run in CI without a Convex deployment.

## Open questions / future work

- **Email provider for invites** — Resend, Loops, Postmark, or Clerk's built-in email. Decide at implementation.
- **Notification system** — in-app notification table for invites and role changes. Out of scope for v1; can be added by introducing a `notifications` table without changing this design.
- **Deal-level audit log** — for compliance and trust. Likely its own spec.
- **Workspace name editing** — UI for renaming personal workspaces; org workspace name follows Clerk org name.
- **Org-level file vault** — if a use case emerges (firm-shared templates, brand assets), add an `orgFiles` table without changing the rest.
- **Hard-delete / GDPR data export** — admin-only paths to fully purge a user's data and produce export bundles.
- **Custom Clerk roles** — if `org:admin` and `org:member` aren't enough granularity, define custom Clerk roles. Not needed in v1.

## Implementation order (preview, not the plan)

The implementation plan will be produced separately by the writing-plans skill. A rough order:

1. Wire Clerk into Next.js (`<ClerkProvider>`, `clerkMiddleware`, sign-in / sign-up routes)
2. Configure Clerk JWT template + Convex `auth.config.ts` + swap `ConvexClientProvider` to `ConvexProviderWithClerk`
3. Define `convex/schema.ts` with the tables above
4. Implement `convex/_helpers/auth.ts` (the three assertions + `getCurrentUser`)
5. Implement `ensureUser` mutation + client-side bootstrap component
6. Implement Clerk webhook `httpAction` for org sync
7. Implement deal mutations (`createDeal`, `inviteToDeal`, `acceptInvite`, `changeMemberRole`, `removeMember`)
8. Implement file mutations (personal + deal)
9. Tests for assertions, last-owner protection, webhook idempotency
10. Manual smoke flow with two test accounts
