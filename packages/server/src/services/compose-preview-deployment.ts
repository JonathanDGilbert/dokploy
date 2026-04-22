import { db } from "@dokploy/server/db";
import {
	type apiCreateComposePreviewDeployment,
	compose,
	composePreviewDeployments,
	deployments,
	organization,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { getPreviewDeploymentNamePrefix } from "../constants";
import { generatePassword, truncateDnsLabel } from "../templates";
import { authGithub } from "../utils/providers/github";
import { createDomain } from "./domain";
import { findGithubById, type Github, getIssueComment } from "./github";
import { removeDeploymentsByComposePreviewDeploymentId } from "./deployment";
import { getWebServerSettings } from "./web-server-settings";

const findComposeForPreview = async (composeId: string) => {
	const result = await db.query.compose.findFirst({
		where: eq(compose.composeId, composeId),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
			github: true,
			server: true,
		},
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Compose not found",
		});
	}
	return result;
};

export type ComposePreviewDeployment =
	typeof composePreviewDeployments.$inferSelect;

export const findComposePreviewDeploymentById = async (
	composePreviewDeploymentId: string,
) => {
	const row = await db.query.composePreviewDeployments.findFirst({
		where: eq(
			composePreviewDeployments.composePreviewDeploymentId,
			composePreviewDeploymentId,
		),
		with: {
			domain: true,
			compose: {
				with: {
					server: true,
					environment: {
						with: {
							project: true,
						},
					},
					github: true,
				},
			},
		},
	});
	if (!row) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Compose preview deployment not found",
		});
	}
	return row;
};

export const updateComposePreviewDeployment = async (
	composePreviewDeploymentId: string,
	data: Partial<ComposePreviewDeployment>,
) => {
	const [updated] = await db
		.update(composePreviewDeployments)
		.set({
			...data,
		})
		.where(
			eq(
				composePreviewDeployments.composePreviewDeploymentId,
				composePreviewDeploymentId,
			),
		)
		.returning();

	return updated;
};

export const findComposePreviewDeploymentsByComposeId = async (
	composeId: string,
) => {
	return await db.query.composePreviewDeployments.findMany({
		where: eq(composePreviewDeployments.composeId, composeId),
		orderBy: desc(composePreviewDeployments.createdAt),
		with: {
			deployments: {
				orderBy: desc(deployments.createdAt),
			},
			domain: true,
		},
	});
};

const generateWildcardDomain = async (
	baseDomain: string,
	appName: string,
	serverIp: string,
	_userId: string,
): Promise<string> => {
	if (!baseDomain.startsWith("*.")) {
		throw new Error('The base domain must start with "*."');
	}
	const hash = `${appName}`;
	if (baseDomain.includes("traefik.me")) {
		let ip = "";

		if (process.env.NODE_ENV === "development") {
			ip = "127.0.0.1";
		}

		if (serverIp) {
			ip = serverIp;
		}

		if (!ip) {
			const settings = await getWebServerSettings();
			ip = settings?.serverIp || "";
		}

		const slugIp = ip.replaceAll(".", "-").replaceAll(":", "-");
		const fullLabel = `${hash}${slugIp === "" ? "" : `-${slugIp}`}`;
		return baseDomain.replace("*", truncateDnsLabel(fullLabel));
	}

	return baseDomain.replace("*", truncateDnsLabel(hash));
};

export const createComposePreviewDeployment = async (
	schema: z.infer<typeof apiCreateComposePreviewDeployment>,
) => {
	const compose = await findComposeForPreview(schema.composeId);
	const appName = `${getPreviewDeploymentNamePrefix()}-${compose.appName}-${generatePassword(6)}`;

	const org = await db.query.organization.findFirst({
		where: eq(organization.id, compose.environment.project.organizationId),
	});
	const host = await generateWildcardDomain(
		compose.previewWildcard || "*.traefik.me",
		appName,
		compose.server?.ipAddress || "",
		org?.ownerId || "",
	);

	const octokit = authGithub(compose.github as Github);

	const runningComment = getIssueComment(
		compose.name,
		"initializing",
		`${compose.previewHttps ? "https" : "http"}://${host}`,
	);

	const issue = await octokit.rest.issues.createComment({
		owner: compose.owner || "",
		repo: compose.repository || "",
		issue_number: Number.parseInt(schema.pullRequestNumber),
		body: `### Dokploy Compose Preview Deployment\n\n${runningComment}`,
	});

	const [previewRow] = await db
		.insert(composePreviewDeployments)
		.values({
			...schema,
			appName,
			pullRequestCommentId: `${issue.data.id}`,
		})
		.returning();

	if (!previewRow) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the compose preview deployment",
		});
	}

	const newDomain = await createDomain({
		host,
		path: compose.previewPath,
		port: compose.previewPort,
		https: compose.previewHttps,
		certificateType: compose.previewCertificateType,
		customCertResolver: compose.previewCustomCertResolver,
		domainType: "preview",
		composeId: compose.composeId,
		serviceName: compose.previewServiceName || "gateway",
		composePreviewDeploymentId: previewRow.composePreviewDeploymentId,
	});

	await db
		.update(composePreviewDeployments)
		.set({
			domainId: newDomain.domainId,
		})
		.where(
			eq(
				composePreviewDeployments.composePreviewDeploymentId,
				previewRow.composePreviewDeploymentId,
			),
		);

	return previewRow;
};

export const createComposePreviewDeploymentComment = async ({
	owner,
	repository,
	issue_number,
	previewDomain,
	appName,
	githubId,
	composePreviewDeploymentId,
}: {
	owner: string;
	repository: string;
	issue_number: string;
	previewDomain: string;
	appName: string;
	githubId: string;
	composePreviewDeploymentId: string;
}) => {
	const github = await findGithubById(githubId);
	const octokit = authGithub(github);

	const runningComment = getIssueComment(
		appName,
		"initializing",
		previewDomain,
	);

	const issue = await octokit.rest.issues.createComment({
		owner: owner || "",
		repo: repository || "",
		issue_number: Number.parseInt(issue_number),
		body: `### Dokploy Compose Preview Deployment\n\n${runningComment}`,
	});

	return await updateComposePreviewDeployment(composePreviewDeploymentId, {
		pullRequestCommentId: `${issue.data.id}`,
	});
};

export const findComposePreviewDeploymentsByPullRequestId = async (
	pullRequestId: string,
) => {
	return await db.query.composePreviewDeployments.findMany({
		where: eq(composePreviewDeployments.pullRequestId, pullRequestId),
	});
};

export const findComposePreviewDeploymentByComposeAndPullRequest = async (
	composeId: string,
	pullRequestId: string,
) => {
	return await db.query.composePreviewDeployments.findFirst({
		where: and(
			eq(composePreviewDeployments.composeId, composeId),
			eq(composePreviewDeployments.pullRequestId, pullRequestId),
		),
	});
};

export const removeComposePreviewDeployment = async (
	composePreviewDeploymentId: string,
) => {
	try {
		const previewDeployment =
			await findComposePreviewDeploymentById(composePreviewDeploymentId);
		const { findComposeById, removeCompose } = await import("./compose");
		const composeEntity = await findComposeById(previewDeployment.composeId);

		const composeForTeardown = {
			...composeEntity,
			appName: previewDeployment.appName,
		};

		const cleanupOperations = [
			async () =>
				await removeDeploymentsByComposePreviewDeploymentId(
					previewDeployment,
					composeEntity.serverId,
				),
			async () => removeCompose(composeForTeardown, false),
			async () =>
				await db
					.delete(composePreviewDeployments)
					.where(
						eq(
							composePreviewDeployments.composePreviewDeploymentId,
							composePreviewDeploymentId,
						),
					)
					.returning(),
		];
		for (const operation of cleanupOperations) {
			try {
				await operation();
			} catch (error) {
				console.error(error);
			}
		}
		return previewDeployment;
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Error deleting this compose preview deployment";
		throw new TRPCError({
			code: "BAD_REQUEST",
			message,
		});
	}
};
