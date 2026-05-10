# Tenancy and Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the tenancy + auth foundation per [docs/superpowers/specs/2026-05-10-tenancy-and-auth-design.md](../specs/2026-05-10-tenancy-and-auth-design.md). After this plan: a user can sign up via Clerk, gets a personal workspace auto-created, can create deals, invite collaborators by email, accept invites via magic link, change member roles (with last-owner protection), upload personal-vault and deal-shared files, and (optionally) operate inside a Clerk Organization that mirrors into Convex via webhook.

**Architecture:** A single `workspaces` table unifies personal and org tenants. Every Convex query/mutation gates on one of three `assert*` helpers as its first line. Identity flows Clerk → JWT → `ConvexProviderWithClerk` → Convex. The active workspace is always derived from the JWT, never client-passed. All deletions are soft (archive flag).

**Tech Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · Convex 1.38 · `@clerk/nextjs` · `convex/react-clerk` · Vitest + `convex-test` · `svix` for webhook signature verification.

---

## Pre-requisites (manual, one-time, before Task 5)

These steps require a human at a browser; record them as a checklist for whoever runs the plan.

- [ ] **Clerk:** create application at https://dashboard.clerk.com, copy `Publishable Key` and `Secret Key` into `.env.local` as `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`
- [ ] **Clerk:** in *Organizations Settings*, enable Organizations (toggle on)
- [ ] **Clerk JWT Templates:** create a new template named `convex` with default issuer (Clerk Frontend API URL) and audience set to `convex`. Copy the issuer URL — it is required for `convex/auth.config.ts`. Save it as `CLERK_FRONTEND_API_URL` in `.env.local` (and as a Convex environment variable via `npx convex env set`)
- [ ] **Clerk Webhooks:** add an endpoint pointing at `<NEXT_PUBLIC_CONVEX_SITE_URL>/clerk-webhook` (the `*.convex.site` domain, not `*.convex.cloud`) subscribing to `organization.created`, `organization.updated`, `organization.deleted`, `user.deleted`. Copy the signing secret into `.env.local` as `CLERK_WEBHOOK_SECRET` and via `npx convex env set CLERK_WEBHOOK_SECRET <value>`

---

## File structure

Files this plan creates or modifies:

```
deal/
├── app/
│   ├── (auth)/
│   │   ├── sign-in/[[...sign-in]]/page.tsx       # CREATE — Clerk SignIn
│   │   └── sign-up/[[...sign-up]]/page.tsx       # CREATE — Clerk SignUp
│   ├── invites/[token]/page.tsx                  # CREATE — magic-link handler (Server)
│   ├── invites/[token]/AcceptInviteClient.tsx    # CREATE — client island
│   ├── ConvexClientProvider.tsx                  # MODIFY — swap to ConvexProviderWithClerk
│   ├── EnsureUser.tsx                            # CREATE — client bootstrap
│   └── layout.tsx                                # MODIFY — wrap with ClerkProvider, add EnsureUser
├── convex/
│   ├── lib/
│   │   ├── auth.ts                               # CREATE — getCurrentUser, three asserts (plain TS)
│   │   ├── auth.test.ts                          # CREATE — helper tests
│   │   └── roles.ts                              # CREATE — role enum, ordering, predicates
│   ├── auth.config.ts                            # CREATE — Clerk provider config
│   ├── schema.ts                                 # CREATE — all tables
│   ├── http.ts                                   # CREATE — webhook router
│   ├── clerk.ts                                  # CREATE — webhook handlers
│   ├── clerk.test.ts                             # CREATE
│   ├── users.ts                                  # CREATE — ensureUser, getMe
│   ├── users.test.ts                             # CREATE
│   ├── workspaces.ts                             # CREATE — listMyWorkspaces
│   ├── deals.ts                                  # CREATE — createDeal, listMyDeals, getDealById
│   ├── deals.test.ts                             # CREATE
│   ├── dealMembers.ts                            # CREATE — listMembers, changeMemberRole, removeMember
│   ├── dealMembers.test.ts                       # CREATE
│   ├── dealInvites.ts                            # CREATE — inviteToDeal, getInviteByToken, acceptInvite
│   ├── dealInvites.test.ts                       # CREATE
│   ├── personalFiles.ts                          # CREATE — upload, list, delete
│   └── dealFiles.ts                              # CREATE — upload, list, delete
├── middleware.ts                                 # CREATE — Clerk middleware
├── vitest.config.ts                              # CREATE — convex-test config
├── package.json                                  # MODIFY — add deps + test script
└── .env.local                                    # MODIFY — add Clerk + webhook secrets
```

---

## Task 1: Install Clerk and testing dependencies

**Files:**
- Modify: `package.json` (via npm)

- [ ] **Step 1: Install Clerk runtime + Convex/Clerk integration**

```bash
npm install @clerk/nextjs convex/react-clerk svix
```

Expected: packages added; no errors. (Note: `convex/react-clerk` is exported from the existing `convex` package — npm will warn that nothing new was added if so; that's fine.)

- [ ] **Step 2: Install testing dependencies**

```bash
npm install -D vitest @edge-runtime/vm convex-test
```

Expected: `vitest`, `@edge-runtime/vm`, `convex-test` added to `devDependencies`.

- [ ] **Step 3: Add npm test script to package.json**

In `package.json`, in the `"scripts"` block, add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

So the scripts block reads (existing scripts preserved):

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install Clerk, convex/react-clerk, vitest, convex-test"
```

---

## Task 2: Configure Vitest for convex-test

**Files:**
- Create: `vitest.config.ts`

- [ ] **Step 1: Create vitest.config.ts**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
```

- [ ] **Step 2: Verify vitest runs (no tests yet)**

Run:
```bash
npm test
```

Expected: `No test files found, exiting with code 0` or similar. Vitest is wired up.

- [ ] **Step 3: Commit**

```bash
git add vitest.config.ts
git commit -m "test: configure vitest with edge-runtime for convex-test"
```

---

## Task 3: Define Convex schema

**Files:**
- Create: `convex/schema.ts`

- [ ] **Step 1: Write the schema**

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.string(),
    imageUrl: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
  })
    .index("by_clerkId", ["clerkId"])
    .index("by_email", ["email"]),

  orgs: defineTable({
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    imageUrl: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
  }).index("by_clerkOrgId", ["clerkOrgId"]),

  workspaces: defineTable({
    type: v.union(v.literal("personal"), v.literal("org")),
    ownerUserId: v.optional(v.id("users")),
    orgId: v.optional(v.id("orgs")),
    name: v.string(),
    status: v.union(v.literal("active"), v.literal("archived")),
  })
    .index("by_owner", ["ownerUserId"])
    .index("by_org", ["orgId"]),

  deals: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    status: v.union(v.literal("active"), v.literal("archived")),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_status", ["workspaceId", "status"]),

  dealMembers: defineTable({
    dealId: v.id("deals"),
    userId: v.id("users"),
    role: v.union(
      v.literal("owner"),
      v.literal("editor"),
      v.literal("reviewer"),
      v.literal("viewer"),
    ),
    invitedBy: v.id("users"),
    invitedAt: v.number(),
  })
    .index("by_deal_user", ["dealId", "userId"])
    .index("by_user", ["userId"]),

  dealInvites: defineTable({
    dealId: v.id("deals"),
    email: v.string(),
    role: v.union(v.literal("editor"), v.literal("reviewer"), v.literal("viewer")),
    invitedBy: v.id("users"),
    invitedAt: v.number(),
    expiresAt: v.number(),
    token: v.string(),
  })
    .index("by_email", ["email"])
    .index("by_token", ["token"])
    .index("by_deal", ["dealId"]),

  dealFiles: defineTable({
    dealId: v.id("deals"),
    uploaderId: v.id("users"),
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    uploadedAt: v.number(),
  }).index("by_deal", ["dealId"]),

  personalFiles: defineTable({
    workspaceId: v.id("workspaces"),
    ownerUserId: v.id("users"),
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    uploadedAt: v.number(),
  }).index("by_owner", ["ownerUserId"]),
});
```

- [ ] **Step 2: Validate the schema with convex dev**

In a separate terminal, ensure `npx convex dev` is running. The dev process pushes the schema to your dev deployment and reports any validation errors.

Expected: dashboard shows the new tables; no validation errors in the terminal.

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(convex): define schema for users, orgs, workspaces, deals, members, invites, files"
```

---

## Task 4: Wire Clerk middleware + sign-in/sign-up routes

**Files:**
- Create: `middleware.ts`
- Create: `app/(auth)/sign-in/[[...sign-in]]/page.tsx`
- Create: `app/(auth)/sign-up/[[...sign-up]]/page.tsx`

- [ ] **Step 1: Create the middleware**

```ts
// middleware.ts
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/invites/(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
```

- [ ] **Step 2: Create sign-in page**

```tsx
// app/(auth)/sign-in/[[...sign-in]]/page.tsx
import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return (
    <main className="flex min-h-full items-center justify-center p-8">
      <SignIn />
    </main>
  );
}
```

- [ ] **Step 3: Create sign-up page**

```tsx
// app/(auth)/sign-up/[[...sign-up]]/page.tsx
import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return (
    <main className="flex min-h-full items-center justify-center p-8">
      <SignUp />
    </main>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add middleware.ts app/\(auth\)
git commit -m "feat(auth): add Clerk middleware and sign-in/sign-up routes"
```

---

## Task 5: Wire Clerk to Convex (auth.config.ts + ConvexProviderWithClerk)

> **Pre-requisite check:** the manual setup at the top of this plan must be complete (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_FRONTEND_API_URL` set in `.env.local`; the `convex` JWT template exists in Clerk).

**Files:**
- Create: `convex/auth.config.ts`
- Modify: `app/ConvexClientProvider.tsx`
- Modify: `app/layout.tsx`

- [ ] **Step 1: Create convex/auth.config.ts**

```ts
// convex/auth.config.ts
export default {
  providers: [
    {
      domain: process.env.CLERK_FRONTEND_API_URL!,
      applicationID: "convex",
    },
  ],
};
```

- [ ] **Step 2: Set CLERK_FRONTEND_API_URL in Convex env**

```bash
npx convex env set CLERK_FRONTEND_API_URL <issuer-url-from-clerk-jwt-template>
```

Expected: `npx convex dev` (running in the other terminal) re-syncs and `auth.config.ts` is accepted.

- [ ] **Step 3: Replace ConvexClientProvider to use ConvexProviderWithClerk**

```tsx
// app/ConvexClientProvider.tsx
"use client";

import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { useAuth } from "@clerk/nextjs";
import { ReactNode } from "react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}
```

- [ ] **Step 4: Wrap the app in ClerkProvider in layout.tsx**

```tsx
// app/layout.tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import { ConvexClientProvider } from "./ConvexClientProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Deal",
  description: "Deal management",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
```

- [ ] **Step 5: Verify in browser**

Run `npm run dev` (in addition to `npx convex dev` in another terminal). Visit `http://localhost:3000`. Expected: middleware redirects you to `/sign-in`. Sign in or sign up with a Clerk-managed credential. After signing in, the home page renders (still the default Next.js launcher; identity is now flowing through Convex).

- [ ] **Step 6: Commit**

```bash
git add convex/auth.config.ts app/ConvexClientProvider.tsx app/layout.tsx
git commit -m "feat(auth): wire Clerk identity into Convex via ConvexProviderWithClerk"
```

---

## Task 6: Role utilities + getCurrentUser helper (TDD)

**Files:**
- Create: `convex/lib/roles.ts`
- Create: `convex/lib/auth.ts`
- Create: `convex/lib/auth.test.ts`

- [ ] **Step 1: Create role utilities**

```ts
// convex/lib/roles.ts
export type DealRole = "viewer" | "reviewer" | "editor" | "owner";

const ORDER: Record<DealRole, number> = {
  viewer: 0,
  reviewer: 1,
  editor: 2,
  owner: 3,
};

export function roleAtLeast(actual: DealRole, required: DealRole): boolean {
  return ORDER[actual] >= ORDER[required];
}

export type WorkspaceRole = "admin" | "member";
```

- [ ] **Step 2: Write the failing test for getCurrentUser**

```ts
// convex/lib/auth.test.ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../schema";
import { getCurrentUser } from "./auth";

test("getCurrentUser throws when unauthenticated", async () => {
  const t = convexTest(schema);
  await expect(
    t.run(async (ctx) => getCurrentUser(ctx)),
  ).rejects.toThrow("Unauthenticated");
});

test("getCurrentUser throws when user not provisioned", async () => {
  const t = convexTest(schema);
  await expect(
    t
      .withIdentity({ subject: "user_unknown" })
      .run(async (ctx) => getCurrentUser(ctx)),
  ).rejects.toThrow("User not yet provisioned");
});

test("getCurrentUser returns the users row when present", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
  });
  const me = await t
    .withIdentity({ subject: "user_alice" })
    .run(async (ctx) => getCurrentUser(ctx));
  expect(me.email).toBe("alice@example.com");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- lib/auth`
Expected: 3 failures (function does not exist).

- [ ] **Step 4: Implement getCurrentUser as plain TypeScript**

```ts
// convex/lib/auth.ts
import { Doc } from "../_generated/dataModel";
import { QueryCtx, MutationCtx } from "../_generated/server";

export async function getCurrentUser(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
    .unique();
  if (!user) throw new Error("User not yet provisioned");
  return user;
}
```

Note: helpers in `convex/lib/` are plain TypeScript modules — they're synced (the folder doesn't start with underscore) but contain no Convex registrations (`query`, `mutation`, etc.), so nothing is exposed via the API. Tests call them directly through `t.withIdentity(...).run(async (ctx) => ...)`, which gives the helper a real Convex `ctx` with the identity from the test.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- lib/auth`
Expected: 3 passes.

- [ ] **Step 6: Commit**

```bash
git add convex/lib
git commit -m "feat(auth): add getCurrentUser helper and role utilities (TDD)"
```

---

## Task 7: assertWorkspaceAccess helper (TDD)

**Files:**
- Modify: `convex/lib/auth.ts`
- Modify: `convex/lib/auth.test.ts`

- [ ] **Step 1: Write failing tests for assertWorkspaceAccess**

First, update the import at the top of `convex/lib/auth.test.ts`:

```ts
import { getCurrentUser, assertWorkspaceAccess } from "./auth";
```

Then append:

```ts
test("assertWorkspaceAccess passes for the owner of a personal workspace", async () => {
  const t = convexTest(schema);
  const workspaceId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
    return await ctx.db.insert("workspaces", {
      type: "personal",
      ownerUserId: userId,
      name: "Alice's Workspace",
      status: "active",
    });
  });
  const result = await t
    .withIdentity({ subject: "user_alice" })
    .run(async (ctx) => assertWorkspaceAccess(ctx, workspaceId));
  expect(result.workspaceRole).toBe("admin");
});

test("assertWorkspaceAccess throws for a stranger on a personal workspace", async () => {
  const t = convexTest(schema);
  const workspaceId = await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
    await ctx.db.insert("users", {
      clerkId: "user_bob",
      email: "bob@example.com",
      name: "Bob",
    });
    return await ctx.db.insert("workspaces", {
      type: "personal",
      ownerUserId: aliceId,
      name: "Alice's Workspace",
      status: "active",
    });
  });
  await expect(
    t
      .withIdentity({ subject: "user_bob" })
      .run(async (ctx) => assertWorkspaceAccess(ctx, workspaceId)),
  ).rejects.toThrow("Forbidden");
});

test("assertWorkspaceAccess passes for an org member with admin role", async () => {
  const t = convexTest(schema);
  const workspaceId = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: "org_acme",
      name: "Acme",
      slug: "acme",
    });
    return await ctx.db.insert("workspaces", {
      type: "org",
      orgId,
      name: "Acme",
      status: "active",
    });
  });
  const result = await t
    .withIdentity({
      subject: "user_alice",
      org_id: "org_acme",
      org_role: "org:admin",
    })
    .run(async (ctx) => assertWorkspaceAccess(ctx, workspaceId));
  expect(result.workspaceRole).toBe("admin");
});

test("assertWorkspaceAccess passes for an org member with member role", async () => {
  const t = convexTest(schema);
  const workspaceId = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: "org_acme",
      name: "Acme",
      slug: "acme",
    });
    return await ctx.db.insert("workspaces", {
      type: "org",
      orgId,
      name: "Acme",
      status: "active",
    });
  });
  const result = await t
    .withIdentity({
      subject: "user_alice",
      org_id: "org_acme",
      org_role: "org:member",
    })
    .run(async (ctx) => assertWorkspaceAccess(ctx, workspaceId));
  expect(result.workspaceRole).toBe("member");
});

test("assertWorkspaceAccess throws when org_id mismatch", async () => {
  const t = convexTest(schema);
  const workspaceId = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: "org_acme",
      name: "Acme",
      slug: "acme",
    });
    return await ctx.db.insert("workspaces", {
      type: "org",
      orgId,
      name: "Acme",
      status: "active",
    });
  });
  await expect(
    t
      .withIdentity({
        subject: "user_alice",
        org_id: "org_other",
        org_role: "org:admin",
      })
      .run(async (ctx) => assertWorkspaceAccess(ctx, workspaceId)),
  ).rejects.toThrow("Forbidden");
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `npm test -- lib/auth`
Expected: 5 new failures (function does not exist).

- [ ] **Step 3: Implement assertWorkspaceAccess**

Add to `convex/lib/auth.ts` (and add `Id` to the existing imports from `_generated/dataModel`):

```ts
import { Doc, Id } from "../_generated/dataModel";
import type { WorkspaceRole } from "./roles";

export async function assertWorkspaceAccess(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<{
  user: Doc<"users">;
  workspace: Doc<"workspaces">;
  workspaceRole: WorkspaceRole;
}> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  const user = await getCurrentUser(ctx);
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) throw new Error("Workspace not found");

  if (workspace.type === "personal") {
    if (workspace.ownerUserId !== user._id) throw new Error("Forbidden");
    return { user, workspace, workspaceRole: "admin" };
  }

  // org workspace
  if (!workspace.orgId) throw new Error("Workspace misconfigured");
  const org = await ctx.db.get(workspace.orgId);
  if (!org) throw new Error("Org not found");
  const claimOrgId = (identity as unknown as { org_id?: string }).org_id;
  const claimOrgRole = (identity as unknown as { org_role?: string }).org_role;
  if (claimOrgId !== org.clerkOrgId) throw new Error("Forbidden");
  const workspaceRole: WorkspaceRole =
    claimOrgRole === "org:admin" ? "admin" : "member";
  return { user, workspace, workspaceRole };
}
```

- [ ] **Step 4: Run tests, verify passes**

Run: `npm test -- lib/auth`
Expected: all 8 pass.

- [ ] **Step 5: Commit**

```bash
git add convex/lib
git commit -m "feat(auth): add assertWorkspaceAccess helper (TDD)"
```

---

## Task 8: assertDealAccess helper (TDD)

**Files:**
- Modify: `convex/lib/auth.ts`
- Modify: `convex/lib/auth.test.ts`

- [ ] **Step 1: Write failing tests for assertDealAccess**

Update the import at the top of `convex/lib/auth.test.ts`:

```ts
import { getCurrentUser, assertWorkspaceAccess, assertDealAccess } from "./auth";
```

Then append:

```ts
test("assertDealAccess passes for an explicit owner member", async () => {
  const t = convexTest(schema);
  const dealId = await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
    const wsId = await ctx.db.insert("workspaces", {
      type: "personal",
      ownerUserId: aliceId,
      name: "Alice",
      status: "active",
    });
    const dealId = await ctx.db.insert("deals", {
      workspaceId: wsId,
      name: "D1",
      status: "active",
      createdBy: aliceId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("dealMembers", {
      dealId,
      userId: aliceId,
      role: "owner",
      invitedBy: aliceId,
      invitedAt: Date.now(),
    });
    return dealId;
  });
  const result = await t
    .withIdentity({ subject: "user_alice" })
    .run(async (ctx) => assertDealAccess(ctx, dealId, "owner"));
  expect(result.dealRole).toBe("owner");
});

test("assertDealAccess throws when role is insufficient", async () => {
  const t = convexTest(schema);
  const dealId = await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
    const bobId = await ctx.db.insert("users", {
      clerkId: "user_bob",
      email: "bob@example.com",
      name: "Bob",
    });
    const wsId = await ctx.db.insert("workspaces", {
      type: "personal",
      ownerUserId: aliceId,
      name: "Alice",
      status: "active",
    });
    const dealId = await ctx.db.insert("deals", {
      workspaceId: wsId,
      name: "D1",
      status: "active",
      createdBy: aliceId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("dealMembers", {
      dealId,
      userId: aliceId,
      role: "owner",
      invitedBy: aliceId,
      invitedAt: Date.now(),
    });
    await ctx.db.insert("dealMembers", {
      dealId,
      userId: bobId,
      role: "viewer",
      invitedBy: aliceId,
      invitedAt: Date.now(),
    });
    return dealId;
  });
  await expect(
    t
      .withIdentity({ subject: "user_bob" })
      .run(async (ctx) => assertDealAccess(ctx, dealId, "editor")),
  ).rejects.toThrow("Forbidden");
});

test("assertDealAccess passes when role meets requirement (viewer >= viewer)", async () => {
  const t = convexTest(schema);
  const dealId = await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
    const bobId = await ctx.db.insert("users", {
      clerkId: "user_bob",
      email: "bob@example.com",
      name: "Bob",
    });
    const wsId = await ctx.db.insert("workspaces", {
      type: "personal",
      ownerUserId: aliceId,
      name: "Alice",
      status: "active",
    });
    const dealId = await ctx.db.insert("deals", {
      workspaceId: wsId,
      name: "D1",
      status: "active",
      createdBy: aliceId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("dealMembers", {
      dealId,
      userId: bobId,
      role: "viewer",
      invitedBy: aliceId,
      invitedAt: Date.now(),
    });
    return dealId;
  });
  const result = await t
    .withIdentity({ subject: "user_bob" })
    .run(async (ctx) => assertDealAccess(ctx, dealId, "viewer"));
  expect(result.dealRole).toBe("viewer");
});

test("assertDealAccess grants implicit owner to org admin without explicit row", async () => {
  const t = convexTest(schema);
  const dealId = await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: "org_acme",
      name: "Acme",
      slug: "acme",
    });
    const wsId = await ctx.db.insert("workspaces", {
      type: "org",
      orgId,
      name: "Acme",
      status: "active",
    });
    return await ctx.db.insert("deals", {
      workspaceId: wsId,
      name: "D1",
      status: "active",
      createdBy: aliceId,
      createdAt: Date.now(),
    });
  });
  const result = await t
    .withIdentity({
      subject: "user_alice",
      org_id: "org_acme",
      org_role: "org:admin",
    })
    .run(async (ctx) => assertDealAccess(ctx, dealId, "owner"));
  expect(result.dealRole).toBe("owner");
});

test("assertDealAccess throws for a non-admin org member without explicit row", async () => {
  const t = convexTest(schema);
  const dealId = await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: "org_acme",
      name: "Acme",
      slug: "acme",
    });
    const wsId = await ctx.db.insert("workspaces", {
      type: "org",
      orgId,
      name: "Acme",
      status: "active",
    });
    return await ctx.db.insert("deals", {
      workspaceId: wsId,
      name: "D1",
      status: "active",
      createdBy: aliceId,
      createdAt: Date.now(),
    });
  });
  await expect(
    t
      .withIdentity({
        subject: "user_alice",
        org_id: "org_acme",
        org_role: "org:member",
      })
      .run(async (ctx) => assertDealAccess(ctx, dealId, "viewer")),
  ).rejects.toThrow("Forbidden");
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `npm test -- lib/auth`
Expected: 5 new failures.

- [ ] **Step 3: Implement assertDealAccess**

Append to `convex/lib/auth.ts`:

```ts
import { roleAtLeast, type DealRole } from "./roles";

export async function assertDealAccess(
  ctx: QueryCtx | MutationCtx,
  dealId: Id<"deals">,
  requiredRole: DealRole,
): Promise<{
  user: Doc<"users">;
  deal: Doc<"deals">;
  dealRole: DealRole;
}> {
  const user = await getCurrentUser(ctx);
  const deal = await ctx.db.get(dealId);
  if (!deal) throw new Error("Deal not found");

  // Check explicit membership
  const member = await ctx.db
    .query("dealMembers")
    .withIndex("by_deal_user", (q) =>
      q.eq("dealId", dealId).eq("userId", user._id),
    )
    .unique();

  let dealRole: DealRole | null = member?.role ?? null;

  // If no explicit row, check for implicit org-admin owner
  if (!dealRole) {
    const workspace = await ctx.db.get(deal.workspaceId);
    if (workspace && workspace.type === "org" && workspace.orgId) {
      const org = await ctx.db.get(workspace.orgId);
      const identity = await ctx.auth.getUserIdentity();
      const claimOrgId = (identity as unknown as { org_id?: string } | null)
        ?.org_id;
      const claimOrgRole = (identity as unknown as { org_role?: string } | null)
        ?.org_role;
      if (
        org &&
        claimOrgId === org.clerkOrgId &&
        claimOrgRole === "org:admin"
      ) {
        dealRole = "owner";
      }
    }
  }

  if (!dealRole) throw new Error("Forbidden");
  if (!roleAtLeast(dealRole, requiredRole)) throw new Error("Forbidden");
  return { user, deal, dealRole };
}
```

- [ ] **Step 4: Run tests, verify passes**

Run: `npm test -- lib/auth`
Expected: all 13 pass.

- [ ] **Step 5: Commit**

```bash
git add convex/lib
git commit -m "feat(auth): add assertDealAccess helper with org-admin implicit owner (TDD)"
```

---

## Task 9: assertPersonalFileAccess helper (TDD)

**Files:**
- Modify: `convex/lib/auth.ts`
- Modify: `convex/lib/auth.test.ts`

- [ ] **Step 1: Write failing tests**

Update the import at the top of `convex/lib/auth.test.ts`:

```ts
import {
  getCurrentUser,
  assertWorkspaceAccess,
  assertDealAccess,
  assertPersonalFileAccess,
} from "./auth";
```

Then append:

```ts
test("assertPersonalFileAccess passes for the file owner", async () => {
  const t = convexTest(schema);
  const fileId = await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
    const wsId = await ctx.db.insert("workspaces", {
      type: "personal",
      ownerUserId: aliceId,
      name: "Alice",
      status: "active",
    });
    const storageId = await ctx.storage.store(new Blob(["x"]));
    return await ctx.db.insert("personalFiles", {
      workspaceId: wsId,
      ownerUserId: aliceId,
      storageId,
      name: "x.txt",
      mimeType: "text/plain",
      size: 1,
      uploadedAt: Date.now(),
    });
  });
  const result = await t
    .withIdentity({ subject: "user_alice" })
    .run(async (ctx) => assertPersonalFileAccess(ctx, fileId));
  expect(result.file.name).toBe("x.txt");
});

test("assertPersonalFileAccess throws for a non-owner", async () => {
  const t = convexTest(schema);
  const fileId = await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
    await ctx.db.insert("users", {
      clerkId: "user_bob",
      email: "bob@example.com",
      name: "Bob",
    });
    const wsId = await ctx.db.insert("workspaces", {
      type: "personal",
      ownerUserId: aliceId,
      name: "Alice",
      status: "active",
    });
    const storageId = await ctx.storage.store(new Blob(["x"]));
    return await ctx.db.insert("personalFiles", {
      workspaceId: wsId,
      ownerUserId: aliceId,
      storageId,
      name: "x.txt",
      mimeType: "text/plain",
      size: 1,
      uploadedAt: Date.now(),
    });
  });
  await expect(
    t
      .withIdentity({ subject: "user_bob" })
      .run(async (ctx) => assertPersonalFileAccess(ctx, fileId)),
  ).rejects.toThrow("Forbidden");
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `npm test -- lib/auth`
Expected: 2 new failures.

- [ ] **Step 3: Implement assertPersonalFileAccess**

Append to `convex/lib/auth.ts`:

```ts
export async function assertPersonalFileAccess(
  ctx: QueryCtx | MutationCtx,
  fileId: Id<"personalFiles">,
): Promise<{ user: Doc<"users">; file: Doc<"personalFiles"> }> {
  const user = await getCurrentUser(ctx);
  const file = await ctx.db.get(fileId);
  if (!file) throw new Error("File not found");
  if (file.ownerUserId !== user._id) throw new Error("Forbidden");
  return { user, file };
}
```

- [ ] **Step 4: Run tests, verify passes**

Run: `npm test -- lib/auth`
Expected: 15 total passes.

- [ ] **Step 5: Commit**

```bash
git add convex/lib
git commit -m "feat(auth): add assertPersonalFileAccess helper (TDD)"
```

---

## Task 10: ensureUser mutation (TDD)

**Files:**
- Create: `convex/users.ts`
- Create: `convex/users.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// convex/users.test.ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

test("ensureUser creates the user and personal workspace on first call", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({
    subject: "user_alice",
    email: "alice@example.com",
    name: "Alice Doe",
  });
  const { user, personalWorkspace } = await asAlice.mutation(
    api.users.ensureUser,
    {},
  );
  expect(user.email).toBe("alice@example.com");
  expect(user.clerkId).toBe("user_alice");
  expect(personalWorkspace.type).toBe("personal");
  expect(personalWorkspace.ownerUserId).toBe(user._id);
});

test("ensureUser is idempotent on repeat", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({
    subject: "user_alice",
    email: "alice@example.com",
    name: "Alice Doe",
  });
  const first = await asAlice.mutation(api.users.ensureUser, {});
  const second = await asAlice.mutation(api.users.ensureUser, {});
  expect(second.user._id).toBe(first.user._id);
  expect(second.personalWorkspace._id).toBe(first.personalWorkspace._id);
  // exactly one users row + one workspaces row
  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const workspaces = await ctx.db.query("workspaces").collect();
    expect(users.length).toBe(1);
    expect(workspaces.length).toBe(1);
  });
});

test("ensureUser resolves pending invites for the user's email", async () => {
  const t = convexTest(schema);
  const { dealId } = await t.run(async (ctx) => {
    const inviterId = await ctx.db.insert("users", {
      clerkId: "user_owner",
      email: "owner@example.com",
      name: "Owner",
    });
    const wsId = await ctx.db.insert("workspaces", {
      type: "personal",
      ownerUserId: inviterId,
      name: "Owner",
      status: "active",
    });
    const dealId = await ctx.db.insert("deals", {
      workspaceId: wsId,
      name: "D1",
      status: "active",
      createdBy: inviterId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("dealInvites", {
      dealId,
      email: "alice@example.com",
      role: "editor",
      invitedBy: inviterId,
      invitedAt: Date.now(),
      expiresAt: Date.now() + 86400000,
      token: "tok_1",
    });
    return { dealId };
  });
  const asAlice = t.withIdentity({
    subject: "user_alice",
    email: "alice@example.com",
    name: "Alice",
  });
  await asAlice.mutation(api.users.ensureUser, {});
  await t.run(async (ctx) => {
    const members = await ctx.db.query("dealMembers").collect();
    const invites = await ctx.db.query("dealInvites").collect();
    expect(members.length).toBe(1);
    expect(members[0].dealId).toBe(dealId);
    expect(members[0].role).toBe("editor");
    expect(invites.length).toBe(0);
  });
});

test("ensureUser throws when called unauthenticated", async () => {
  const t = convexTest(schema);
  await expect(t.mutation(api.users.ensureUser, {})).rejects.toThrow(
    "Unauthenticated",
  );
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `npm test -- users`
Expected: 4 failures.

- [ ] **Step 3: Implement ensureUser**

```ts
// convex/users.ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";

export const ensureUser = mutation({
  args: {},
  handler: async (ctx): Promise<{
    user: Doc<"users">;
    personalWorkspace: Doc<"workspaces">;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const email = (identity.email ?? "").toLowerCase();
    const name =
      (identity.name as string | undefined) ??
      (identity.givenName as string | undefined) ??
      "User";
    const imageUrl = identity.pictureUrl as string | undefined;

    // Upsert user row
    let user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user) {
      const userId = await ctx.db.insert("users", {
        clerkId: identity.subject,
        email,
        name,
        imageUrl,
      });
      user = (await ctx.db.get(userId))!;
    } else {
      // refresh email/name in case they changed in Clerk
      await ctx.db.patch(user._id, { email, name, imageUrl });
      user = (await ctx.db.get(user._id))!;
    }

    // Ensure personal workspace
    let personalWorkspace = await ctx.db
      .query("workspaces")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
      .filter((q) => q.eq(q.field("type"), "personal"))
      .unique();
    if (!personalWorkspace) {
      const firstName = name.split(" ")[0] || "My";
      const wsId = await ctx.db.insert("workspaces", {
        type: "personal",
        ownerUserId: user._id,
        name: `${firstName}'s Workspace`,
        status: "active",
      });
      personalWorkspace = (await ctx.db.get(wsId))!;
    }

    // Resolve pending invites for this email
    if (email) {
      const pending = await ctx.db
        .query("dealInvites")
        .withIndex("by_email", (q) => q.eq("email", email))
        .collect();
      for (const inv of pending) {
        if (inv.expiresAt < Date.now()) {
          await ctx.db.delete(inv._id);
          continue;
        }
        const existing = await ctx.db
          .query("dealMembers")
          .withIndex("by_deal_user", (q) =>
            q.eq("dealId", inv.dealId).eq("userId", user._id),
          )
          .unique();
        if (!existing) {
          await ctx.db.insert("dealMembers", {
            dealId: inv.dealId,
            userId: user._id,
            role: inv.role,
            invitedBy: inv.invitedBy,
            invitedAt: Date.now(),
          });
        }
        await ctx.db.delete(inv._id);
      }
    }

    return { user, personalWorkspace };
  },
});

export const getMe = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();
    return user ?? null;
  },
});
```

- [ ] **Step 4: Run tests, verify passes**

Run: `npm test -- users`
Expected: 4 passes.

- [ ] **Step 5: Commit**

```bash
git add convex/users.ts convex/users.test.ts
git commit -m "feat(users): add ensureUser mutation with workspace creation and invite resolution (TDD)"
```

---

## Task 11: Client-side EnsureUser bootstrap

**Files:**
- Create: `app/EnsureUser.tsx`
- Modify: `app/layout.tsx`

- [ ] **Step 1: Create the bootstrap component**

```tsx
// app/EnsureUser.tsx
"use client";

import { useConvexAuth, useMutation } from "convex/react";
import { useEffect } from "react";
import { api } from "../convex/_generated/api";

export function EnsureUser() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const ensureUser = useMutation(api.users.ensureUser);

  useEffect(() => {
    if (isLoading || !isAuthenticated) return;
    ensureUser().catch((err) => {
      console.error("ensureUser failed", err);
    });
  }, [isAuthenticated, isLoading, ensureUser]);

  return null;
}
```

- [ ] **Step 2: Mount EnsureUser in the layout**

Modify `app/layout.tsx` body so it reads:

```tsx
<body className="min-h-full flex flex-col">
  <ConvexClientProvider>
    <EnsureUser />
    {children}
  </ConvexClientProvider>
</body>
```

And import:

```tsx
import { EnsureUser } from "./EnsureUser";
```

- [ ] **Step 3: Manual smoke check**

Run `npm run dev` (and `npx convex dev`). Sign in via Clerk. Open Convex dashboard → `users` table — there should be a row matching your Clerk identity. `workspaces` should have one personal workspace.

- [ ] **Step 4: Commit**

```bash
git add app/EnsureUser.tsx app/layout.tsx
git commit -m "feat(client): bootstrap user + personal workspace via EnsureUser"
```

---

## Task 12: Clerk webhook httpAction (TDD)

> **Pre-requisite:** the Clerk webhook from the manual setup at the top must be registered, and `CLERK_WEBHOOK_SECRET` must be set both in `.env.local` and via `npx convex env set CLERK_WEBHOOK_SECRET <value>`.

**Files:**
- Create: `convex/clerk.ts`
- Create: `convex/http.ts`
- Create: `convex/clerk.test.ts`

- [ ] **Step 1: Write failing tests for the org-handlers (skip signature verification — tested via integration)**

```ts
// convex/clerk.test.ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

test("organization.created creates orgs row + org workspace", async () => {
  const t = convexTest(schema);
  await t.mutation(internal.clerk.handleOrgCreated, {
    clerkOrgId: "org_acme",
    name: "Acme",
    slug: "acme",
    imageUrl: undefined,
  });
  await t.run(async (ctx) => {
    const orgs = await ctx.db.query("orgs").collect();
    const workspaces = await ctx.db.query("workspaces").collect();
    expect(orgs.length).toBe(1);
    expect(orgs[0].clerkOrgId).toBe("org_acme");
    expect(workspaces.length).toBe(1);
    expect(workspaces[0].type).toBe("org");
    expect(workspaces[0].orgId).toBe(orgs[0]._id);
  });
});

test("organization.created is idempotent (re-delivery is safe)", async () => {
  const t = convexTest(schema);
  await t.mutation(internal.clerk.handleOrgCreated, {
    clerkOrgId: "org_acme",
    name: "Acme",
    slug: "acme",
    imageUrl: undefined,
  });
  await t.mutation(internal.clerk.handleOrgCreated, {
    clerkOrgId: "org_acme",
    name: "Acme",
    slug: "acme",
    imageUrl: undefined,
  });
  await t.run(async (ctx) => {
    const orgs = await ctx.db.query("orgs").collect();
    const workspaces = await ctx.db.query("workspaces").collect();
    expect(orgs.length).toBe(1);
    expect(workspaces.length).toBe(1);
  });
});

test("organization.updated patches orgs and workspaces.name", async () => {
  const t = convexTest(schema);
  await t.mutation(internal.clerk.handleOrgCreated, {
    clerkOrgId: "org_acme",
    name: "Acme",
    slug: "acme",
    imageUrl: undefined,
  });
  await t.mutation(internal.clerk.handleOrgUpdated, {
    clerkOrgId: "org_acme",
    name: "Acme Co",
    slug: "acme-co",
    imageUrl: "https://x/img.png",
  });
  await t.run(async (ctx) => {
    const org = (await ctx.db.query("orgs").collect())[0];
    const ws = (await ctx.db.query("workspaces").collect())[0];
    expect(org.name).toBe("Acme Co");
    expect(org.slug).toBe("acme-co");
    expect(org.imageUrl).toBe("https://x/img.png");
    expect(ws.name).toBe("Acme Co");
  });
});

test("organization.deleted soft-deletes org and archives workspace + deals", async () => {
  const t = convexTest(schema);
  await t.mutation(internal.clerk.handleOrgCreated, {
    clerkOrgId: "org_acme",
    name: "Acme",
    slug: "acme",
    imageUrl: undefined,
  });
  await t.run(async (ctx) => {
    const ws = (await ctx.db.query("workspaces").collect())[0];
    const aliceId = await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
    await ctx.db.insert("deals", {
      workspaceId: ws._id,
      name: "D1",
      status: "active",
      createdBy: aliceId,
      createdAt: Date.now(),
    });
  });
  await t.mutation(internal.clerk.handleOrgDeleted, {
    clerkOrgId: "org_acme",
  });
  await t.run(async (ctx) => {
    const org = (await ctx.db.query("orgs").collect())[0];
    const ws = (await ctx.db.query("workspaces").collect())[0];
    const deals = await ctx.db.query("deals").collect();
    expect(org.deletedAt).toBeTypeOf("number");
    expect(ws.status).toBe("archived");
    expect(deals[0].status).toBe("archived");
  });
});

test("user.deleted soft-deletes the user and archives their personal workspace", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert("users", {
      clerkId: "user_alice",
      email: "alice@example.com",
      name: "Alice",
    });
    await ctx.db.insert("workspaces", {
      type: "personal",
      ownerUserId: aliceId,
      name: "Alice",
      status: "active",
    });
  });
  await t.mutation(internal.clerk.handleUserDeleted, {
    clerkUserId: "user_alice",
  });
  await t.run(async (ctx) => {
    const user = (await ctx.db.query("users").collect())[0];
    const ws = (await ctx.db.query("workspaces").collect())[0];
    expect(user.deletedAt).toBeTypeOf("number");
    expect(ws.status).toBe("archived");
  });
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `npm test -- clerk`
Expected: 5 failures.

- [ ] **Step 3: Implement the internal mutation handlers**

```ts
// convex/clerk.ts
import { internalMutation, httpAction } from "./_generated/server";
import { v } from "convex/values";
import { Webhook } from "svix";
import { internal } from "./_generated/api";

export const handleOrgCreated = internalMutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (existing) {
      // already created — patch in case fields drifted
      await ctx.db.patch(existing._id, {
        name: args.name,
        slug: args.slug,
        imageUrl: args.imageUrl,
      });
      // ensure workspace exists too
      const ws = await ctx.db
        .query("workspaces")
        .withIndex("by_org", (q) => q.eq("orgId", existing._id))
        .unique();
      if (!ws) {
        await ctx.db.insert("workspaces", {
          type: "org",
          orgId: existing._id,
          name: args.name,
          status: "active",
        });
      }
      return;
    }
    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: args.clerkOrgId,
      name: args.name,
      slug: args.slug,
      imageUrl: args.imageUrl,
    });
    await ctx.db.insert("workspaces", {
      type: "org",
      orgId,
      name: args.name,
      status: "active",
    });
  },
});

export const handleOrgUpdated = internalMutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (!org) return; // unknown org — drop silently; could log
    await ctx.db.patch(org._id, {
      name: args.name,
      slug: args.slug,
      imageUrl: args.imageUrl,
    });
    const ws = await ctx.db
      .query("workspaces")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .unique();
    if (ws && ws.name !== args.name) {
      await ctx.db.patch(ws._id, { name: args.name });
    }
  },
});

export const handleOrgDeleted = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (!org) return;
    await ctx.db.patch(org._id, { deletedAt: Date.now() });
    const ws = await ctx.db
      .query("workspaces")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .unique();
    if (ws) {
      await ctx.db.patch(ws._id, { status: "archived" });
      const deals = await ctx.db
        .query("deals")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", ws._id))
        .collect();
      for (const deal of deals) {
        await ctx.db.patch(deal._id, { status: "archived" });
      }
    }
  },
});

export const handleUserDeleted = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkUserId))
      .unique();
    if (!user) return;
    await ctx.db.patch(user._id, { deletedAt: Date.now() });
    const personal = await ctx.db
      .query("workspaces")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
      .filter((q) => q.eq(q.field("type"), "personal"))
      .unique();
    if (personal) {
      await ctx.db.patch(personal._id, { status: "archived" });
      const deals = await ctx.db
        .query("deals")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", personal._id))
        .collect();
      for (const deal of deals) {
        await ctx.db.patch(deal._id, { status: "archived" });
      }
    }
  },
});

// HTTP action — called by Clerk webhook
export const clerkWebhook = httpAction(async (ctx, req) => {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook secret not configured", { status: 500 });

  const payload = await req.text();
  const headers = {
    "svix-id": req.headers.get("svix-id") ?? "",
    "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
    "svix-signature": req.headers.get("svix-signature") ?? "",
  };

  let evt: { type: string; data: Record<string, unknown> };
  try {
    evt = new Webhook(secret).verify(payload, headers) as typeof evt;
  } catch {
    return new Response("Invalid signature", { status: 401 });
  }

  switch (evt.type) {
    case "organization.created": {
      const d = evt.data as {
        id: string;
        name: string;
        slug: string;
        image_url?: string;
      };
      await ctx.runMutation(internal.clerk.handleOrgCreated, {
        clerkOrgId: d.id,
        name: d.name,
        slug: d.slug,
        imageUrl: d.image_url,
      });
      break;
    }
    case "organization.updated": {
      const d = evt.data as {
        id: string;
        name: string;
        slug: string;
        image_url?: string;
      };
      await ctx.runMutation(internal.clerk.handleOrgUpdated, {
        clerkOrgId: d.id,
        name: d.name,
        slug: d.slug,
        imageUrl: d.image_url,
      });
      break;
    }
    case "organization.deleted": {
      const d = evt.data as { id: string };
      await ctx.runMutation(internal.clerk.handleOrgDeleted, {
        clerkOrgId: d.id,
      });
      break;
    }
    case "user.deleted": {
      const d = evt.data as { id: string };
      await ctx.runMutation(internal.clerk.handleUserDeleted, {
        clerkUserId: d.id,
      });
      break;
    }
    // ignore others
  }

  return new Response("ok", { status: 200 });
});
```

- [ ] **Step 4: Register the route**

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { clerkWebhook } from "./clerk";

const http = httpRouter();

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: clerkWebhook,
});

export default http;
```

- [ ] **Step 5: Run tests, verify passes**

Run: `npm test -- clerk`
Expected: 5 passes.

- [ ] **Step 6: Manual smoke (optional)**

Create or rename a Clerk Organization in the dashboard. Check Convex logs (`npx convex logs`) for `/clerk-webhook` POSTs and 200 responses. Verify the `orgs` and `workspaces` tables show the change.

- [ ] **Step 7: Commit**

```bash
git add convex/clerk.ts convex/http.ts convex/clerk.test.ts
git commit -m "feat(webhook): handle Clerk org/user events with idempotent upserts (TDD)"
```

---

## Task 13: createDeal + listMyDeals + getDealById

**Files:**
- Create: `convex/deals.ts`
- Create: `convex/deals.test.ts`
- Create: `convex/workspaces.ts`

- [ ] **Step 1: Write failing tests**

```ts
// convex/deals.test.ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

test("createDeal creates a deal in personal workspace and grants creator owner role", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({
    subject: "user_alice",
    email: "alice@example.com",
    name: "Alice",
  });
  const { personalWorkspace } = await asAlice.mutation(api.users.ensureUser, {});
  const dealId = await asAlice.mutation(api.deals.createDeal, {
    workspaceId: personalWorkspace._id,
    name: "Project Phoenix",
  });
  await t.run(async (ctx) => {
    const deal = await ctx.db.get(dealId);
    expect(deal?.name).toBe("Project Phoenix");
    expect(deal?.workspaceId).toBe(personalWorkspace._id);
    const members = await ctx.db
      .query("dealMembers")
      .withIndex("by_deal_user", (q) => q.eq("dealId", dealId))
      .collect();
    expect(members.length).toBe(1);
    expect(members[0].role).toBe("owner");
  });
});

test("createDeal in someone else's personal workspace throws", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({ subject: "user_alice", email: "a@x", name: "A" });
  const asBob = t.withIdentity({ subject: "user_bob", email: "b@x", name: "B" });
  const { personalWorkspace } = await asAlice.mutation(api.users.ensureUser, {});
  await asBob.mutation(api.users.ensureUser, {});
  await expect(
    asBob.mutation(api.deals.createDeal, {
      workspaceId: personalWorkspace._id,
      name: "Sneaky",
    }),
  ).rejects.toThrow("Forbidden");
});

test("listMyDeals returns only deals where the user is a member", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({ subject: "user_alice", email: "a@x", name: "A" });
  const asBob = t.withIdentity({ subject: "user_bob", email: "b@x", name: "B" });
  const { personalWorkspace: aliceWs } = await asAlice.mutation(
    api.users.ensureUser,
    {},
  );
  const { personalWorkspace: bobWs } = await asBob.mutation(
    api.users.ensureUser,
    {},
  );
  await asAlice.mutation(api.deals.createDeal, {
    workspaceId: aliceWs._id,
    name: "A1",
  });
  await asBob.mutation(api.deals.createDeal, {
    workspaceId: bobWs._id,
    name: "B1",
  });
  const aliceDeals = await asAlice.query(api.deals.listMyDeals, {});
  expect(aliceDeals.map((d) => d.name)).toEqual(["A1"]);
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `npm test -- deals`
Expected: 3 failures.

- [ ] **Step 3: Implement deals.ts and workspaces.ts**

```ts
// convex/workspaces.ts
import { query } from "./_generated/server";
import { getCurrentUser } from "./lib/auth";

export const listMyWorkspaces = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    const personal = await ctx.db
      .query("workspaces")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
      .collect();
    // org workspaces are derivable from JWT org_id, fetched on demand;
    // listing them is a future task
    return personal;
  },
});
```

```ts
// convex/deals.ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  assertWorkspaceAccess,
  assertDealAccess,
  getCurrentUser,
} from "./lib/auth";

export const createDeal = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await assertWorkspaceAccess(ctx, args.workspaceId);
    const dealId = await ctx.db.insert("deals", {
      workspaceId: args.workspaceId,
      name: args.name,
      status: "active",
      createdBy: user._id,
      createdAt: Date.now(),
    });
    await ctx.db.insert("dealMembers", {
      dealId,
      userId: user._id,
      role: "owner",
      invitedBy: user._id,
      invitedAt: Date.now(),
    });
    return dealId;
  },
});

export const listMyDeals = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    const memberships = await ctx.db
      .query("dealMembers")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const deals = await Promise.all(
      memberships.map((m) => ctx.db.get(m.dealId)),
    );
    return deals.filter((d): d is NonNullable<typeof d> => d !== null);
  },
});

export const getDealById = query({
  args: { dealId: v.id("deals") },
  handler: async (ctx, { dealId }) => {
    const { deal } = await assertDealAccess(ctx, dealId, "viewer");
    return deal;
  },
});

export const archiveDeal = mutation({
  args: { dealId: v.id("deals") },
  handler: async (ctx, { dealId }) => {
    await assertDealAccess(ctx, dealId, "owner");
    await ctx.db.patch(dealId, { status: "archived" });
  },
});
```

- [ ] **Step 4: Run tests, verify passes**

Run: `npm test -- deals`
Expected: 3 passes.

- [ ] **Step 5: Commit**

```bash
git add convex/deals.ts convex/deals.test.ts convex/workspaces.ts
git commit -m "feat(deals): add createDeal, listMyDeals, getDealById, archiveDeal (TDD)"
```

---

## Task 14: inviteToDeal mutation (TDD)

**Files:**
- Create: `convex/dealInvites.ts`
- Create: `convex/dealInvites.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// convex/dealInvites.test.ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

test("inviteToDeal inserts dealMember directly when invitee already exists", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({ subject: "user_alice", email: "a@x", name: "A" });
  const asBob = t.withIdentity({ subject: "user_bob", email: "bob@example.com", name: "B" });
  const { personalWorkspace } = await asAlice.mutation(api.users.ensureUser, {});
  await asBob.mutation(api.users.ensureUser, {});
  const dealId = await asAlice.mutation(api.deals.createDeal, {
    workspaceId: personalWorkspace._id,
    name: "D1",
  });
  await asAlice.mutation(api.dealInvites.inviteToDeal, {
    dealId,
    email: "BOB@Example.com",
    role: "editor",
  });
  await t.run(async (ctx) => {
    const members = await ctx.db
      .query("dealMembers")
      .withIndex("by_deal_user", (q) => q.eq("dealId", dealId))
      .collect();
    expect(members.length).toBe(2);
    const invites = await ctx.db.query("dealInvites").collect();
    expect(invites.length).toBe(0);
  });
});

test("inviteToDeal creates dealInvites row when invitee is unknown email", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({ subject: "user_alice", email: "a@x", name: "A" });
  const { personalWorkspace } = await asAlice.mutation(api.users.ensureUser, {});
  const dealId = await asAlice.mutation(api.deals.createDeal, {
    workspaceId: personalWorkspace._id,
    name: "D1",
  });
  await asAlice.mutation(api.dealInvites.inviteToDeal, {
    dealId,
    email: "ghost@example.com",
    role: "viewer",
  });
  await t.run(async (ctx) => {
    const invites = await ctx.db.query("dealInvites").collect();
    expect(invites.length).toBe(1);
    expect(invites[0].email).toBe("ghost@example.com");
    expect(invites[0].role).toBe("viewer");
    expect(invites[0].expiresAt).toBeGreaterThan(Date.now());
    expect(invites[0].token.length).toBeGreaterThan(10);
  });
});

test("inviteToDeal upserts pending invite (re-invite updates role + expiry)", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({ subject: "user_alice", email: "a@x", name: "A" });
  const { personalWorkspace } = await asAlice.mutation(api.users.ensureUser, {});
  const dealId = await asAlice.mutation(api.deals.createDeal, {
    workspaceId: personalWorkspace._id,
    name: "D1",
  });
  await asAlice.mutation(api.dealInvites.inviteToDeal, {
    dealId,
    email: "ghost@example.com",
    role: "viewer",
  });
  await asAlice.mutation(api.dealInvites.inviteToDeal, {
    dealId,
    email: "ghost@example.com",
    role: "editor",
  });
  await t.run(async (ctx) => {
    const invites = await ctx.db.query("dealInvites").collect();
    expect(invites.length).toBe(1);
    expect(invites[0].role).toBe("editor");
  });
});

test("inviteToDeal as non-owner throws", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({ subject: "user_alice", email: "a@x", name: "A" });
  const asBob = t.withIdentity({ subject: "user_bob", email: "bob@example.com", name: "B" });
  const { personalWorkspace } = await asAlice.mutation(api.users.ensureUser, {});
  await asBob.mutation(api.users.ensureUser, {});
  const dealId = await asAlice.mutation(api.deals.createDeal, {
    workspaceId: personalWorkspace._id,
    name: "D1",
  });
  // Bob is not yet a member of the deal
  await expect(
    asBob.mutation(api.dealInvites.inviteToDeal, {
      dealId,
      email: "ghost@example.com",
      role: "viewer",
    }),
  ).rejects.toThrow("Forbidden");
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `npm test -- dealInvites`
Expected: 4 failures.

- [ ] **Step 3: Implement inviteToDeal (and related queries we'll use later)**

```ts
// convex/dealInvites.ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertDealAccess, getCurrentUser } from "./lib/auth";

function makeToken(): string {
  // 32 random bytes hex (Edge runtime compatible)
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

export const inviteToDeal = mutation({
  args: {
    dealId: v.id("deals"),
    email: v.string(),
    role: v.union(
      v.literal("editor"),
      v.literal("reviewer"),
      v.literal("viewer"),
    ),
  },
  handler: async (ctx, args) => {
    const { user: inviter } = await assertDealAccess(ctx, args.dealId, "owner");
    const email = args.email.toLowerCase().trim();
    if (!email.includes("@")) throw new Error("Invalid email");

    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    if (existingUser) {
      const existingMember = await ctx.db
        .query("dealMembers")
        .withIndex("by_deal_user", (q) =>
          q.eq("dealId", args.dealId).eq("userId", existingUser._id),
        )
        .unique();
      if (existingMember) {
        // Update role only; never demote an existing owner via invite
        if (existingMember.role !== "owner") {
          await ctx.db.patch(existingMember._id, { role: args.role });
        }
      } else {
        await ctx.db.insert("dealMembers", {
          dealId: args.dealId,
          userId: existingUser._id,
          role: args.role,
          invitedBy: inviter._id,
          invitedAt: Date.now(),
        });
      }
      return { kind: "directMember" as const };
    }

    // Pending invite path: upsert by (dealId, email)
    const existingInvite = await ctx.db
      .query("dealInvites")
      .withIndex("by_email", (q) => q.eq("email", email))
      .filter((q) => q.eq(q.field("dealId"), args.dealId))
      .unique();
    if (existingInvite) {
      await ctx.db.patch(existingInvite._id, {
        role: args.role,
        expiresAt: Date.now() + FOURTEEN_DAYS_MS,
        invitedAt: Date.now(),
        invitedBy: inviter._id,
      });
      return { kind: "pendingInvite" as const, token: existingInvite.token };
    }
    const token = makeToken();
    await ctx.db.insert("dealInvites", {
      dealId: args.dealId,
      email,
      role: args.role,
      invitedBy: inviter._id,
      invitedAt: Date.now(),
      expiresAt: Date.now() + FOURTEEN_DAYS_MS,
      token,
    });
    return { kind: "pendingInvite" as const, token };
  },
});

export const getInviteByToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const invite = await ctx.db
      .query("dealInvites")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!invite) return null;
    const deal = await ctx.db.get(invite.dealId);
    return {
      invite: {
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
      },
      deal: deal ? { name: deal.name } : null,
      expired: invite.expiresAt < Date.now(),
    };
  },
});

export const listInvitesForDeal = query({
  args: { dealId: v.id("deals") },
  handler: async (ctx, { dealId }) => {
    await assertDealAccess(ctx, dealId, "owner");
    return await ctx.db
      .query("dealInvites")
      .withIndex("by_deal", (q) => q.eq("dealId", dealId))
      .collect();
  },
});
```

- [ ] **Step 4: Run tests, verify passes**

Run: `npm test -- dealInvites`
Expected: 4 passes.

- [ ] **Step 5: Commit**

```bash
git add convex/dealInvites.ts convex/dealInvites.test.ts
git commit -m "feat(invites): add inviteToDeal with direct + pending paths (TDD)"
```

---

## Task 15: acceptInvite mutation + magic-link page

**Files:**
- Modify: `convex/dealInvites.ts`
- Modify: `convex/dealInvites.test.ts`
- Create: `app/invites/[token]/page.tsx`
- Create: `app/invites/[token]/AcceptInviteClient.tsx`

- [ ] **Step 1: Write failing tests for acceptInvite**

Append to `convex/dealInvites.test.ts`:

```ts
test("acceptInvite creates dealMember and deletes invite when token + email match", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({ subject: "user_alice", email: "a@x", name: "A" });
  const { personalWorkspace } = await asAlice.mutation(api.users.ensureUser, {});
  const dealId = await asAlice.mutation(api.deals.createDeal, {
    workspaceId: personalWorkspace._id,
    name: "D1",
  });
  const result = await asAlice.mutation(api.dealInvites.inviteToDeal, {
    dealId,
    email: "bob@example.com",
    role: "editor",
  });
  if (result.kind !== "pendingInvite") throw new Error("expected pending");
  // Pre-create Bob's user row WITHOUT calling ensureUser (which would auto-resolve the invite)
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: "user_bob",
      email: "bob@example.com",
      name: "B",
    });
  });
  const asBob = t.withIdentity({
    subject: "user_bob",
    email: "bob@example.com",
    name: "B",
  });
  const accepted = await asBob.mutation(api.dealInvites.acceptInvite, {
    token: result.token,
  });
  expect(accepted.dealId).toBe(dealId);
  await t.run(async (ctx) => {
    const members = await ctx.db
      .query("dealMembers")
      .withIndex("by_deal_user", (q) => q.eq("dealId", dealId))
      .collect();
    expect(members.length).toBe(2); // Alice owner + Bob editor
    expect(members.find((m) => m.role === "editor")).toBeTruthy();
    const invites = await ctx.db.query("dealInvites").collect();
    expect(invites.length).toBe(0);
  });
});

test("acceptInvite throws on email mismatch", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({ subject: "user_alice", email: "a@x", name: "A" });
  const { personalWorkspace } = await asAlice.mutation(api.users.ensureUser, {});
  const dealId = await asAlice.mutation(api.deals.createDeal, {
    workspaceId: personalWorkspace._id,
    name: "D1",
  });
  const result = await asAlice.mutation(api.dealInvites.inviteToDeal, {
    dealId,
    email: "right@example.com",
    role: "viewer",
  });
  if (result.kind !== "pendingInvite") throw new Error("expected pending");
  const asWrong = t.withIdentity({
    subject: "user_wrong",
    email: "wrong@example.com",
    name: "W",
  });
  await asWrong.mutation(api.users.ensureUser, {});
  await expect(
    asWrong.mutation(api.dealInvites.acceptInvite, { token: result.token }),
  ).rejects.toThrow("Email mismatch");
});

test("acceptInvite throws when token is expired", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({ subject: "user_alice", email: "a@x", name: "A" });
  const { personalWorkspace } = await asAlice.mutation(api.users.ensureUser, {});
  const dealId = await asAlice.mutation(api.deals.createDeal, {
    workspaceId: personalWorkspace._id,
    name: "D1",
  });
  const result = await asAlice.mutation(api.dealInvites.inviteToDeal, {
    dealId,
    email: "bob@example.com",
    role: "viewer",
  });
  if (result.kind !== "pendingInvite") throw new Error("expected pending");
  // Pre-create Bob's user (so getCurrentUser succeeds inside acceptInvite)
  // and expire the invite — both in one transaction so neither side auto-resolves
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: "user_bob",
      email: "bob@example.com",
      name: "B",
    });
    const inv = await ctx.db
      .query("dealInvites")
      .withIndex("by_token", (q) => q.eq("token", result.token))
      .unique();
    if (inv) await ctx.db.patch(inv._id, { expiresAt: Date.now() - 1000 });
  });
  const asBob = t.withIdentity({
    subject: "user_bob",
    email: "bob@example.com",
    name: "B",
  });
  await expect(
    asBob.mutation(api.dealInvites.acceptInvite, { token: result.token }),
  ).rejects.toThrow("Invite expired");
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `npm test -- dealInvites`
Expected: the new tests fail (function does not exist).

- [ ] **Step 3: Implement acceptInvite**

Append to `convex/dealInvites.ts`:

```ts
export const acceptInvite = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await getCurrentUser(ctx);
    const invite = await ctx.db
      .query("dealInvites")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!invite) throw new Error("Invite not found");
    if (invite.expiresAt < Date.now()) {
      await ctx.db.delete(invite._id);
      throw new Error("Invite expired");
    }
    if (invite.email !== user.email.toLowerCase()) {
      throw new Error("Email mismatch");
    }
    const existing = await ctx.db
      .query("dealMembers")
      .withIndex("by_deal_user", (q) =>
        q.eq("dealId", invite.dealId).eq("userId", user._id),
      )
      .unique();
    if (!existing) {
      await ctx.db.insert("dealMembers", {
        dealId: invite.dealId,
        userId: user._id,
        role: invite.role,
        invitedBy: invite.invitedBy,
        invitedAt: Date.now(),
      });
    }
    await ctx.db.delete(invite._id);
    return { dealId: invite.dealId };
  },
});
```

- [ ] **Step 4: Run tests, verify passes**

Run: `npm test -- dealInvites`
Expected: all pass.

- [ ] **Step 5: Build the magic-link page (Server Component)**

```tsx
// app/invites/[token]/page.tsx
import { fetchQuery } from "convex/nextjs";
import { api } from "../../../convex/_generated/api";
import { AcceptInviteClient } from "./AcceptInviteClient";

export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const data = await fetchQuery(api.dealInvites.getInviteByToken, { token });

  if (!data) {
    return (
      <main className="mx-auto max-w-md p-8 text-center space-y-3">
        <h1 className="text-xl font-semibold">Invite not found</h1>
        <p className="text-sm opacity-70">
          This invite link is invalid or has been used already.
        </p>
      </main>
    );
  }
  if (data.expired) {
    return (
      <main className="mx-auto max-w-md p-8 text-center space-y-3">
        <h1 className="text-xl font-semibold">Invite expired</h1>
        <p className="text-sm opacity-70">Ask the deal owner for a new link.</p>
      </main>
    );
  }
  return (
    <AcceptInviteClient
      token={token}
      inviteEmail={data.invite.email}
      role={data.invite.role}
      dealName={data.deal?.name ?? "the deal"}
    />
  );
}
```

- [ ] **Step 6: Build the client island for accept flow**

```tsx
// app/invites/[token]/AcceptInviteClient.tsx
"use client";

import { useUser } from "@clerk/nextjs";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";

export function AcceptInviteClient({
  token,
  inviteEmail,
  role,
  dealName,
}: {
  token: string;
  inviteEmail: string;
  role: "editor" | "reviewer" | "viewer";
  dealName: string;
}) {
  const { isLoaded, isSignedIn, user } = useUser();
  const acceptInvite = useMutation(api.dealInvites.acceptInvite);
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!isLoaded) return null;

  if (!isSignedIn) {
    return (
      <main className="mx-auto max-w-md p-8 space-y-3 text-center">
        <h1 className="text-xl font-semibold">You're invited to {dealName}</h1>
        <p className="text-sm opacity-70">Role: {role}</p>
        <Link
          className="inline-block rounded bg-black px-4 py-2 text-white text-sm"
          href={`/sign-up?redirect_url=${encodeURIComponent(`/invites/${token}`)}`}
        >
          Sign up with {inviteEmail} to accept
        </Link>
      </main>
    );
  }

  const userEmail = user.primaryEmailAddress?.emailAddress?.toLowerCase() ?? "";
  if (userEmail !== inviteEmail) {
    return (
      <main className="mx-auto max-w-md p-8 space-y-3 text-center">
        <h1 className="text-xl font-semibold">Wrong account</h1>
        <p className="text-sm opacity-70">
          This invite was sent to <strong>{inviteEmail}</strong>. You're signed
          in as <strong>{userEmail}</strong>. Sign out and sign in with the
          invited email to accept.
        </p>
      </main>
    );
  }

  const onAccept = async () => {
    setBusy(true);
    try {
      const { dealId } = await acceptInvite({ token });
      router.push(`/?accepted=${dealId}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-md p-8 space-y-3 text-center">
      <h1 className="text-xl font-semibold">Accept invite to {dealName}</h1>
      <p className="text-sm opacity-70">You'll join as: {role}</p>
      <button
        onClick={onAccept}
        disabled={busy}
        className="rounded bg-black px-4 py-2 text-white text-sm disabled:opacity-50"
      >
        {busy ? "Accepting…" : "Accept"}
      </button>
    </main>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add convex/dealInvites.ts convex/dealInvites.test.ts app/invites
git commit -m "feat(invites): add acceptInvite mutation and magic-link UI (TDD)"
```

---

## Task 16: changeMemberRole + removeMember (TDD with last-owner protection)

**Files:**
- Create: `convex/dealMembers.ts`
- Create: `convex/dealMembers.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// convex/dealMembers.test.ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

async function setupDealWithTwoOwners(t: ReturnType<typeof convexTest>) {
  const asAlice = t.withIdentity({ subject: "user_alice", email: "a@x", name: "A" });
  const asBob = t.withIdentity({
    subject: "user_bob",
    email: "bob@example.com",
    name: "B",
  });
  const { personalWorkspace } = await asAlice.mutation(api.users.ensureUser, {});
  await asBob.mutation(api.users.ensureUser, {});
  const dealId = await asAlice.mutation(api.deals.createDeal, {
    workspaceId: personalWorkspace._id,
    name: "D1",
  });
  await asAlice.mutation(api.dealInvites.inviteToDeal, {
    dealId,
    email: "bob@example.com",
    role: "editor",
  });
  // Promote Bob to owner
  const bobMember = await t.run(async (ctx) => {
    const bob = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", "user_bob"))
      .unique();
    const m = await ctx.db
      .query("dealMembers")
      .withIndex("by_user", (q) => q.eq("userId", bob!._id))
      .first();
    return m!;
  });
  await asAlice.mutation(api.dealMembers.changeMemberRole, {
    dealId,
    userId: bobMember.userId,
    role: "owner",
  });
  return { asAlice, asBob, dealId, bobUserId: bobMember.userId };
}

test("changeMemberRole promotes editor to owner", async () => {
  const t = convexTest(schema);
  const { dealId, bobUserId } = await setupDealWithTwoOwners(t);
  await t.run(async (ctx) => {
    const m = await ctx.db
      .query("dealMembers")
      .withIndex("by_deal_user", (q) =>
        q.eq("dealId", dealId).eq("userId", bobUserId),
      )
      .unique();
    expect(m?.role).toBe("owner");
  });
});

test("changeMemberRole throws when removing last owner via demotion", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({ subject: "user_alice", email: "a@x", name: "A" });
  const { personalWorkspace } = await asAlice.mutation(api.users.ensureUser, {});
  const dealId = await asAlice.mutation(api.deals.createDeal, {
    workspaceId: personalWorkspace._id,
    name: "D1",
  });
  const aliceUserId = (await t.run(async (ctx) =>
    (await ctx.db.query("users").collect())[0]._id,
  ));
  await expect(
    asAlice.mutation(api.dealMembers.changeMemberRole, {
      dealId,
      userId: aliceUserId,
      role: "editor",
    }),
  ).rejects.toThrow("Cannot demote last owner");
});

test("changeMemberRole allows demotion when another owner remains", async () => {
  const t = convexTest(schema);
  const { asAlice, dealId, bobUserId } = await setupDealWithTwoOwners(t);
  // Two owners exist (Alice + Bob). Demoting Bob is allowed.
  await asAlice.mutation(api.dealMembers.changeMemberRole, {
    dealId,
    userId: bobUserId,
    role: "editor",
  });
  await t.run(async (ctx) => {
    const owners = (await ctx.db
      .query("dealMembers")
      .withIndex("by_deal_user", (q) => q.eq("dealId", dealId))
      .collect()).filter((m) => m.role === "owner");
    expect(owners.length).toBe(1);
  });
});

test("removeMember throws when removing last owner", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({ subject: "user_alice", email: "a@x", name: "A" });
  const { personalWorkspace } = await asAlice.mutation(api.users.ensureUser, {});
  const dealId = await asAlice.mutation(api.deals.createDeal, {
    workspaceId: personalWorkspace._id,
    name: "D1",
  });
  const aliceUserId = (await t.run(async (ctx) =>
    (await ctx.db.query("users").collect())[0]._id,
  ));
  await expect(
    asAlice.mutation(api.dealMembers.removeMember, {
      dealId,
      userId: aliceUserId,
    }),
  ).rejects.toThrow("Cannot remove last owner");
});

test("removeMember allows removing a non-owner member", async () => {
  const t = convexTest(schema);
  const asAlice = t.withIdentity({ subject: "user_alice", email: "a@x", name: "A" });
  const asBob = t.withIdentity({
    subject: "user_bob",
    email: "bob@example.com",
    name: "B",
  });
  const { personalWorkspace } = await asAlice.mutation(api.users.ensureUser, {});
  await asBob.mutation(api.users.ensureUser, {});
  const dealId = await asAlice.mutation(api.deals.createDeal, {
    workspaceId: personalWorkspace._id,
    name: "D1",
  });
  await asAlice.mutation(api.dealInvites.inviteToDeal, {
    dealId,
    email: "bob@example.com",
    role: "editor",
  });
  const bobUserId = (await t.run(async (ctx) =>
    (await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", "user_bob"))
      .unique())!._id,
  ));
  await asAlice.mutation(api.dealMembers.removeMember, {
    dealId,
    userId: bobUserId,
  });
  await t.run(async (ctx) => {
    const members = await ctx.db
      .query("dealMembers")
      .withIndex("by_deal_user", (q) => q.eq("dealId", dealId))
      .collect();
    expect(members.length).toBe(1); // only Alice remains
  });
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `npm test -- dealMembers`
Expected: 5 failures.

- [ ] **Step 3: Implement dealMembers.ts**

```ts
// convex/dealMembers.ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertDealAccess } from "./lib/auth";

async function ownerCount(
  db: { query: (table: "dealMembers") => any },
  dealId: any,
): Promise<number> {
  const all = await db
    .query("dealMembers")
    .withIndex("by_deal_user", (q: any) => q.eq("dealId", dealId))
    .collect();
  return all.filter((m: any) => m.role === "owner").length;
}

export const listMembers = query({
  args: { dealId: v.id("deals") },
  handler: async (ctx, { dealId }) => {
    await assertDealAccess(ctx, dealId, "viewer");
    return await ctx.db
      .query("dealMembers")
      .withIndex("by_deal_user", (q) => q.eq("dealId", dealId))
      .collect();
  },
});

export const changeMemberRole = mutation({
  args: {
    dealId: v.id("deals"),
    userId: v.id("users"),
    role: v.union(
      v.literal("owner"),
      v.literal("editor"),
      v.literal("reviewer"),
      v.literal("viewer"),
    ),
  },
  handler: async (ctx, args) => {
    await assertDealAccess(ctx, args.dealId, "owner");
    const member = await ctx.db
      .query("dealMembers")
      .withIndex("by_deal_user", (q) =>
        q.eq("dealId", args.dealId).eq("userId", args.userId),
      )
      .unique();
    if (!member) throw new Error("Member not found");
    if (member.role === args.role) return; // no-op

    // Last-owner protection: if demoting an owner, ensure another owner remains
    if (member.role === "owner" && args.role !== "owner") {
      const owners = await ownerCount(ctx.db, args.dealId);
      if (owners <= 1) throw new Error("Cannot demote last owner");
    }
    await ctx.db.patch(member._id, { role: args.role });
  },
});

export const removeMember = mutation({
  args: {
    dealId: v.id("deals"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await assertDealAccess(ctx, args.dealId, "owner");
    const member = await ctx.db
      .query("dealMembers")
      .withIndex("by_deal_user", (q) =>
        q.eq("dealId", args.dealId).eq("userId", args.userId),
      )
      .unique();
    if (!member) throw new Error("Member not found");
    if (member.role === "owner") {
      const owners = await ownerCount(ctx.db, args.dealId);
      if (owners <= 1) throw new Error("Cannot remove last owner");
    }
    await ctx.db.delete(member._id);
  },
});
```

- [ ] **Step 4: Run tests, verify passes**

Run: `npm test -- dealMembers`
Expected: 5 passes.

- [ ] **Step 5: Commit**

```bash
git add convex/dealMembers.ts convex/dealMembers.test.ts
git commit -m "feat(members): add changeMemberRole + removeMember with last-owner protection (TDD)"
```

---

## Task 17: Personal file mutations

**Files:**
- Create: `convex/personalFiles.ts`

- [ ] **Step 1: Implement upload + list + delete**

```ts
// convex/personalFiles.ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  assertWorkspaceAccess,
  assertPersonalFileAccess,
  getCurrentUser,
} from "./lib/auth";

export const generateUploadUrl = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const { workspace } = await assertWorkspaceAccess(ctx, workspaceId);
    if (workspace.type !== "personal") {
      throw new Error("Personal vault is only on personal workspaces");
    }
    return await ctx.storage.generateUploadUrl();
  },
});

export const recordUpload = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const { user, workspace } = await assertWorkspaceAccess(
      ctx,
      args.workspaceId,
    );
    if (workspace.type !== "personal") {
      throw new Error("Personal vault is only on personal workspaces");
    }
    return await ctx.db.insert("personalFiles", {
      workspaceId: args.workspaceId,
      ownerUserId: user._id,
      storageId: args.storageId,
      name: args.name,
      mimeType: args.mimeType,
      size: args.size,
      uploadedAt: Date.now(),
    });
  },
});

export const listMyPersonalFiles = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    return await ctx.db
      .query("personalFiles")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
      .collect();
  },
});

export const getDownloadUrl = query({
  args: { fileId: v.id("personalFiles") },
  handler: async (ctx, { fileId }) => {
    const { file } = await assertPersonalFileAccess(ctx, fileId);
    return await ctx.storage.getUrl(file.storageId);
  },
});

export const deletePersonalFile = mutation({
  args: { fileId: v.id("personalFiles") },
  handler: async (ctx, { fileId }) => {
    const { file } = await assertPersonalFileAccess(ctx, fileId);
    await ctx.storage.delete(file.storageId);
    await ctx.db.delete(file._id);
  },
});
```

- [ ] **Step 2: Verify Convex dev compiles**

The terminal running `npx convex dev` should show a successful sync after the file is saved. The Convex dashboard now lists `personalFiles` under Functions. Functional smoke via the app comes in Task 19.

- [ ] **Step 3: Commit**

```bash
git add convex/personalFiles.ts
git commit -m "feat(files): add personal-file upload, list, download, delete"
```

---

## Task 18: Deal file mutations

**Files:**
- Create: `convex/dealFiles.ts`

- [ ] **Step 1: Implement upload + list + delete**

```ts
// convex/dealFiles.ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertDealAccess } from "./lib/auth";

export const generateUploadUrl = mutation({
  args: { dealId: v.id("deals") },
  handler: async (ctx, { dealId }) => {
    await assertDealAccess(ctx, dealId, "editor");
    return await ctx.storage.generateUploadUrl();
  },
});

export const recordUpload = mutation({
  args: {
    dealId: v.id("deals"),
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const { user } = await assertDealAccess(ctx, args.dealId, "editor");
    return await ctx.db.insert("dealFiles", {
      dealId: args.dealId,
      uploaderId: user._id,
      storageId: args.storageId,
      name: args.name,
      mimeType: args.mimeType,
      size: args.size,
      uploadedAt: Date.now(),
    });
  },
});

export const listDealFiles = query({
  args: { dealId: v.id("deals") },
  handler: async (ctx, { dealId }) => {
    await assertDealAccess(ctx, dealId, "viewer");
    return await ctx.db
      .query("dealFiles")
      .withIndex("by_deal", (q) => q.eq("dealId", dealId))
      .collect();
  },
});

export const getDealFileDownloadUrl = query({
  args: { fileId: v.id("dealFiles") },
  handler: async (ctx, { fileId }) => {
    const file = await ctx.db.get(fileId);
    if (!file) throw new Error("File not found");
    await assertDealAccess(ctx, file.dealId, "viewer");
    return await ctx.storage.getUrl(file.storageId);
  },
});

export const deleteDealFile = mutation({
  args: { fileId: v.id("dealFiles") },
  handler: async (ctx, { fileId }) => {
    const file = await ctx.db.get(fileId);
    if (!file) throw new Error("File not found");
    await assertDealAccess(ctx, file.dealId, "editor");
    await ctx.storage.delete(file.storageId);
    await ctx.db.delete(file._id);
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add convex/dealFiles.ts
git commit -m "feat(files): add deal-file upload, list, download, delete"
```

---

## Task 19: End-to-end smoke checklist

This is a manual verification after implementation. Do not commit anything; this just produces confidence.

- [ ] **Step 1: Run both processes**

In two terminals:
```bash
npx convex dev
npm run dev
```

Open http://localhost:3000.

- [ ] **Step 2: First user signup**

- Get redirected to `/sign-in`
- Click "sign up" link, register a new test account (use a temp-email or `+test1` alias)
- Land on the home page (still default Next.js content for now)
- Open Convex dashboard → `users` should have one row matching your Clerk identity
- `workspaces` should have one row with `type: "personal"`, `ownerUserId` matching your user

- [ ] **Step 3: Create a deal via dashboard**

In Convex dashboard, run `deals:createDeal` with `{ workspaceId: <your personal workspace _id>, name: "Test Deal" }`. Verify a `deals` row and a `dealMembers` row (you as `owner`) appear.

- [ ] **Step 4: Invite a second email**

Run `dealInvites:inviteToDeal` from the dashboard with a fresh email like `bob+test@example.com` and role `editor`. Verify a `dealInvites` row appears with a token.

- [ ] **Step 5: Second user signup → invite resolves**

Open an incognito window. Sign up with `bob+test@example.com`. After landing on the home page, check the Convex dashboard:
- A second `users` row exists
- `dealMembers` shows two rows for the deal: User A as `owner`, User B as `editor`
- The `dealInvites` row is gone

- [ ] **Step 6: Promote Bob to co-owner**

From User A's dashboard session, run `dealMembers:changeMemberRole` with `{ dealId, userId: <Bob's userId>, role: "owner" }`. Verify Bob's row updates.

- [ ] **Step 7: Last-owner protection**

From User A's session, try `dealMembers:changeMemberRole` to demote *Alice* (you) to `editor`. Should succeed because Bob is now an owner. Now try removing Bob — should succeed. Then try demoting Alice again — should now throw `Cannot demote last owner`.

- [ ] **Step 8: Magic-link flow (in browser)**

Repeat Step 4 with a new fresh email, but this time visit `http://localhost:3000/invites/<token>` directly:
- Logged-out tab → sees "Sign up to accept" CTA
- Logged-in as wrong email → sees the "Wrong account" message
- Logged-in as the invited email → sees the Accept button; clicking accepts and redirects

If all of the above behave as documented, the foundation is complete.

---

## Self-review notes

Items the spec calls out, mapped to tasks:

| Spec section | Implemented in |
|---|---|
| Schema (users, orgs, workspaces, deals, dealMembers, dealInvites, dealFiles, personalFiles) | Task 3 |
| Clerk JWT template + auth.config.ts + ConvexProviderWithClerk | Task 5 |
| `getCurrentUser` helper | Task 6 |
| `assertWorkspaceAccess` helper | Task 7 |
| `assertDealAccess` (incl. org-admin implicit owner) | Task 8 |
| `assertPersonalFileAccess` | Task 9 |
| `ensureUser` mutation incl. pending-invite resolution | Task 10 |
| Client-side `EnsureUser` bootstrap | Task 11 |
| Clerk webhook (`organization.*`, `user.deleted`) with idempotency | Task 12 |
| Deal mutations (`createDeal`, listing) | Task 13 |
| Invitation flow (`inviteToDeal`, `acceptInvite`, magic link) | Tasks 14, 15 |
| Membership ops (`changeMemberRole`, `removeMember`, last-owner protection) | Task 16 |
| Personal vault file ops | Task 17 |
| Deal-file ops with role gates | Task 18 |
| Two-account smoke flow | Task 19 |

Items intentionally not in this plan (per spec "Out of scope" + "Future work"):

- Email provider for invite delivery — `inviteToDeal` returns the token; sending the email is hooked up in a follow-up task once a provider is chosen
- Notifications, audit logs, billing
- Hard delete / GDPR purge
- Org-level shared file vault
- Custom Clerk roles
- Production-grade UI for deal listing, member management, and file browsing — only the magic-link page is built here; rest of the UI is a future plan against this same spec
