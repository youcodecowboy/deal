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
