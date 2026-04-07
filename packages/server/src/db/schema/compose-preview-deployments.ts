import { relations } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { compose } from "./compose";
import { deployments } from "./deployment";
import { domains } from "./domain";
import { applicationStatus } from "./shared";
import { generateAppName } from "./utils";

export const composePreviewDeployments = pgTable("compose_preview_deployments", {
	composePreviewDeploymentId: text("composePreviewDeploymentId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	branch: text("branch").notNull(),
	pullRequestId: text("pullRequestId").notNull(),
	pullRequestNumber: text("pullRequestNumber").notNull(),
	pullRequestURL: text("pullRequestURL").notNull(),
	pullRequestTitle: text("pullRequestTitle").notNull(),
	pullRequestCommentId: text("pullRequestCommentId").notNull(),
	previewStatus: applicationStatus("previewStatus").notNull().default("idle"),
	appName: text("appName")
		.notNull()
		.$defaultFn(() => generateAppName("compose-preview"))
		.unique(),
	composeId: text("composeId")
		.notNull()
		.references(() => compose.composeId, {
			onDelete: "cascade",
		}),
	domainId: text("domainId").references(() => domains.domainId, {
		onDelete: "cascade",
	}),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	expiresAt: text("expiresAt"),
});

export const composePreviewDeploymentsRelations = relations(
	composePreviewDeployments,
	({ one, many }) => ({
		deployments: many(deployments),
		domain: one(domains, {
			fields: [composePreviewDeployments.domainId],
			references: [domains.domainId],
		}),
		compose: one(compose, {
			fields: [composePreviewDeployments.composeId],
			references: [compose.composeId],
		}),
	}),
);

export const createComposePreviewDeploymentSchema = createInsertSchema(
	composePreviewDeployments,
	{
		composeId: z.string(),
	},
);

export const apiCreateComposePreviewDeployment = z.object({
	composeId: z.string().min(1),
	domainId: z.string().optional(),
	branch: z.string().min(1),
	pullRequestId: z.string().min(1),
	pullRequestNumber: z.string().min(1),
	pullRequestURL: z.string().min(1),
	pullRequestTitle: z.string().min(1),
});

export const apiFindAllByComposePreview = z.object({
	composeId: z.string().min(1),
});
