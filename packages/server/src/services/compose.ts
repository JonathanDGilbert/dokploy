import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type apiCreateCompose,
	buildAppName,
	cleanAppName,
	compose,
	deployments,
} from "@dokploy/server/db/schema";
import { getBuildComposeCommand } from "@dokploy/server/utils/builders/compose";
import type { ComposeNested } from "@dokploy/server/utils/builders/compose";
import { randomizeSpecificationFile } from "@dokploy/server/utils/docker/compose";
import {
	cloneCompose,
	loadDockerCompose,
	loadDockerComposeRemote,
} from "@dokploy/server/utils/docker/domain";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { sendBuildErrorNotifications } from "@dokploy/server/utils/notifications/build-error";
import { sendBuildSuccessNotifications } from "@dokploy/server/utils/notifications/build-success";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { cloneBitbucketRepository } from "@dokploy/server/utils/providers/bitbucket";
import {
	cloneGitRepository,
	getGitCommitInfo,
} from "@dokploy/server/utils/providers/git";
import { cloneGiteaRepository } from "@dokploy/server/utils/providers/gitea";
import { cloneGithubRepository } from "@dokploy/server/utils/providers/github";
import { cloneGitlabRepository } from "@dokploy/server/utils/providers/gitlab";
import { getCreateComposeFileCommand } from "@dokploy/server/utils/providers/raw";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { encodeBase64 } from "../utils/docker/utils";
import { getDokployUrl } from "./admin";
import {
	createDeploymentCompose,
	createDeploymentComposePreview,
	updateDeployment,
	updateDeploymentStatus,
} from "./deployment";
import { type Domain, getDomainHost } from "./domain";
import {
	getIssueComment,
	issueCommentExists,
	updateIssueComment,
} from "./github";
import {
	createComposePreviewDeploymentComment,
	findComposePreviewDeploymentById,
	updateComposePreviewDeployment,
} from "./compose-preview-deployment";
import { generateApplyPatchesCommand } from "./patch";
import { validUniqueServerAppName } from "./project";

export type Compose = typeof compose.$inferSelect;

const filterPrimaryComposeDomains = (domains: Domain[] = []) => {
	return domains.filter(
		(domain) =>
			domain.domainType !== "preview" && !domain.composePreviewDeploymentId,
	);
};

export const createCompose = async (
	input: z.infer<typeof apiCreateCompose>,
) => {
	const appName = buildAppName("compose", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			composeFile: input.composeFile || "",
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const createComposeByTemplate = async (
	input: typeof compose.$inferInsert,
) => {
	const appName = cleanAppName(input.appName);
	if (appName) {
		const valid = await validUniqueServerAppName(appName);

		if (!valid) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Service with this 'AppName' already exists",
			});
		}
	}
	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const findComposeById = async (composeId: string) => {
	const result = await db.query.compose.findFirst({
		where: eq(compose.composeId, composeId),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
			deployments: true,
			mounts: true,
			domains: true,
			github: true,
			gitlab: true,
			bitbucket: true,
			gitea: true,
			server: true,
			backups: {
				with: {
					destination: true,
					deployments: true,
				},
			},
			composePreviewDeployments: {
				with: {
					domain: true,
					deployments: {
						orderBy: desc(deployments.createdAt),
					},
				},
			},
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

export const loadServices = async (
	composeId: string,
	type: "fetch" | "cache" = "fetch",
) => {
	const compose = await findComposeById(composeId);

	if (type === "fetch") {
		const command = await cloneCompose(compose);
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
	}

	let composeData: ComposeSpecification | null;

	if (compose.serverId) {
		composeData = await loadDockerComposeRemote(compose);
	} else {
		composeData = await loadDockerCompose(compose);
	}

	if (compose.randomize && composeData) {
		const randomizedCompose = randomizeSpecificationFile(
			composeData,
			compose.suffix,
		);
		composeData = randomizedCompose;
	}

	if (!composeData?.services) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Services not found",
		});
	}

	const services = Object.keys(composeData.services);

	return [...services];
};

export const updateCompose = async (
	composeId: string,
	composeData: Partial<Compose>,
) => {
	const { appName, ...rest } = composeData;
	const composeResult = await db
		.update(compose)
		.set({
			...rest,
		})
		.where(eq(compose.composeId, composeId))
		.returning();

	return composeResult[0];
};

export const deployCompose = async ({
	composeId,
	titleLog = "Manual deployment",
	descriptionLog = "",
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const compose = await findComposeById(composeId);
	const primaryComposeDomains = filterPrimaryComposeDomains(
		compose.domains as Domain[],
	);

	const buildLink = `${await getDokployUrl()}/dashboard/project/${
		compose.environment.projectId
	}/environment/${compose.environmentId}/services/compose/${compose.composeId}?tab=deployments`;
	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		const entity = {
			...compose,
			domains: primaryComposeDomains,
			type: "compose" as const,
		};
		let command = "set -e;";
		if (compose.sourceType === "github") {
			command += await cloneGithubRepository(entity);
		} else if (compose.sourceType === "gitlab") {
			command += await cloneGitlabRepository(entity);
		} else if (compose.sourceType === "bitbucket") {
			command += await cloneBitbucketRepository(entity);
		} else if (compose.sourceType === "git") {
			command += await cloneGitRepository(entity);
		} else if (compose.sourceType === "gitea") {
			command += await cloneGiteaRepository(entity);
		} else if (compose.sourceType === "raw") {
			command += getCreateComposeFileCommand(entity);
		}

		let commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}
		if (compose.sourceType !== "raw") {
			command = "set -e;";
			command += await generateApplyPatchesCommand({
				id: compose.composeId,
				type: "compose",
				serverId: compose.serverId,
			});
			commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}
		}

		command = "set -e;";
		command += await getBuildComposeCommand(entity);
		commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateCompose(composeId, {
			composeStatus: "done",
		});

		await sendBuildSuccessNotifications({
			projectName: compose.environment.project.name,
			applicationName: compose.name,
			applicationType: "compose",
			buildLink,
			organizationId: compose.environment.project.organizationId,
			domains: primaryComposeDomains,
			environmentName: compose.environment.name,
		});
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		await sendBuildErrorNotifications({
			projectName: compose.environment.project.name,
			applicationName: compose.name,
			applicationType: "compose",
			// @ts-ignore
			errorMessage: error?.message || "Error building",
			buildLink,
			organizationId: compose.environment.project.organizationId,
		});
		throw error;
	} finally {
		if (compose.sourceType !== "raw") {
			const commitInfo = await getGitCommitInfo({
				...compose,
				type: "compose",
			});
			if (commitInfo) {
				await updateDeployment(deployment.deploymentId, {
					title: commitInfo.message,
					description: `Commit: ${commitInfo.hash}`,
				});
			}
		}
	}
};

export const rebuildCompose = async ({
	composeId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const compose = await findComposeById(composeId);
	const primaryComposeDomains = filterPrimaryComposeDomains(
		compose.domains as Domain[],
	);
	const composeForBuild = {
		...compose,
		domains: primaryComposeDomains,
	} as ComposeNested;

	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		let command = "set -e;";
		if (compose.sourceType === "raw") {
			command += getCreateComposeFileCommand(compose);
		}

		let commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		if (compose.sourceType !== "raw") {
			command = "set -e;";
			command += await generateApplyPatchesCommand({
				id: compose.composeId,
				type: "compose",
				serverId: compose.serverId,
			});
			commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}
		}

		command = "set -e;";
		command += await getBuildComposeCommand(composeForBuild);
		commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateCompose(composeId, {
			composeStatus: "done",
		});
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};

export const deployPreviewCompose = async ({
	composeId,
	titleLog = "Compose preview deployment",
	descriptionLog = "",
	composePreviewDeploymentId,
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
	composePreviewDeploymentId: string;
}) => {
	const compose = await findComposeById(composeId);

	const deployment = await createDeploymentComposePreview({
		title: titleLog,
		description: descriptionLog,
		composeId,
		composePreviewDeploymentId,
	});

	const previewDeployment =
		await findComposePreviewDeploymentById(composePreviewDeploymentId);

	await updateComposePreviewDeployment(composePreviewDeploymentId, {
		createdAt: new Date().toISOString(),
	});

	if (!previewDeployment.domain) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Compose preview domain not found",
		});
	}

	const previewDomain = getDomainHost(previewDeployment.domain as Domain);
	const issueParams = {
		owner: compose.owner || "",
		repository: compose.repository || "",
		issue_number: previewDeployment.pullRequestNumber,
		comment_id: Number.parseInt(previewDeployment.pullRequestCommentId),
		githubId: compose.githubId || "",
	};

	try {
		const commentExists = await issueCommentExists({
			...issueParams,
		});
		if (!commentExists) {
			const result = await createComposePreviewDeploymentComment({
				owner: issueParams.owner,
				repository: issueParams.repository,
				issue_number: issueParams.issue_number,
				previewDomain,
				appName: previewDeployment.appName,
				githubId: issueParams.githubId,
				composePreviewDeploymentId,
			});

			if (!result) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Pull request comment not found",
				});
			}

			issueParams.comment_id = Number.parseInt(result.pullRequestCommentId);
		}
		const buildingComment = getIssueComment(
			compose.name,
			"running",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Compose Preview Deployment\n\n${buildingComment}`,
		});

		const effectiveCompose = {
			...compose,
			appName: previewDeployment.appName,
			branch: previewDeployment.branch,
			env: `${compose.env ?? ""}\n${compose.previewEnv ?? ""}\nDOKPLOY_DEPLOY_URL=${previewDeployment.domain.host}`,
			domains: [previewDeployment.domain],
		} as ComposeNested;

		let command = "set -e;";
		if (compose.sourceType === "github") {
			command += await cloneGithubRepository({
				...effectiveCompose,
				type: "compose",
			});
		} else {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Compose preview deployments require a GitHub-backed compose service",
			});
		}

		let commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		command = "set -e;";
		command += await generateApplyPatchesCommand({
			id: compose.composeId,
			type: "compose",
			serverId: compose.serverId,
		});
		commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		command = "set -e;";
		command += await getBuildComposeCommand(effectiveCompose);
		commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		const successComment = getIssueComment(
			compose.name,
			"success",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Compose Preview Deployment\n\n${successComment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateComposePreviewDeployment(composePreviewDeploymentId, {
			previewStatus: "done",
		});
	} catch (error) {
		const comment = getIssueComment(compose.name, "error", previewDomain);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Compose Preview Deployment\n\n${comment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateComposePreviewDeployment(composePreviewDeploymentId, {
			previewStatus: "error",
		});
		throw error;
	}

	return true;
};

export const rebuildPreviewCompose = async ({
	composeId,
	titleLog = "Rebuild compose preview deployment",
	descriptionLog = "",
	composePreviewDeploymentId,
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
	composePreviewDeploymentId: string;
}) => {
	const compose = await findComposeById(composeId);
	const previewDeployment =
		await findComposePreviewDeploymentById(composePreviewDeploymentId);

	const deployment = await createDeploymentComposePreview({
		title: titleLog,
		description: descriptionLog,
		composeId,
		composePreviewDeploymentId,
	});

	if (!previewDeployment.domain) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Compose preview domain not found",
		});
	}

	const previewDomain = getDomainHost(previewDeployment.domain as Domain);
	const issueParams = {
		owner: compose.owner || "",
		repository: compose.repository || "",
		issue_number: previewDeployment.pullRequestNumber,
		comment_id: Number.parseInt(previewDeployment.pullRequestCommentId),
		githubId: compose.githubId || "",
	};

	try {
		const commentExists = await issueCommentExists({
			...issueParams,
		});
		if (!commentExists) {
			const result = await createComposePreviewDeploymentComment({
				owner: issueParams.owner,
				repository: issueParams.repository,
				issue_number: issueParams.issue_number,
				previewDomain,
				appName: previewDeployment.appName,
				githubId: issueParams.githubId,
				composePreviewDeploymentId,
			});

			if (!result) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Pull request comment not found",
				});
			}

			issueParams.comment_id = Number.parseInt(result.pullRequestCommentId);
		}

		const buildingComment = getIssueComment(
			compose.name,
			"running",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Compose Preview Deployment\n\n${buildingComment}`,
		});

		const effectiveCompose = {
			...compose,
			appName: previewDeployment.appName,
			branch: previewDeployment.branch,
			env: `${compose.env ?? ""}\n${compose.previewEnv ?? ""}\nDOKPLOY_DEPLOY_URL=${previewDeployment.domain.host}`,
			domains: [previewDeployment.domain],
		} as ComposeNested;

		let command = "set -e;";
		if (compose.sourceType === "github") {
			command += await cloneGithubRepository({
				...effectiveCompose,
				type: "compose",
			});
		} else {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Compose preview deployments require a GitHub-backed compose service",
			});
		}

		let commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		command = "set -e;";
		command += await generateApplyPatchesCommand({
			id: compose.composeId,
			type: "compose",
			serverId: compose.serverId,
		});
		commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		command = "set -e;";
		command += await getBuildComposeCommand(effectiveCompose);
		commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		const successComment = getIssueComment(
			compose.name,
			"success",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Compose Preview Deployment\n\n${successComment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateComposePreviewDeployment(composePreviewDeploymentId, {
			previewStatus: "done",
		});
	} catch (error) {
		const comment = getIssueComment(compose.name, "error", previewDomain);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Compose Preview Deployment\n\n${comment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateComposePreviewDeployment(composePreviewDeploymentId, {
			previewStatus: "error",
		});
		throw error;
	}

	return true;
};

export const removeCompose = async (
	compose: Compose,
	deleteVolumes: boolean,
) => {
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);
		const projectPath = join(COMPOSE_PATH, compose.appName);

		if (compose.composeType === "stack") {
			const command = `
			docker network disconnect ${compose.appName} dokploy-traefik;
			docker stack rm ${compose.appName};
			rm -rf ${projectPath}`;

			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
		} else {
			const command = `
			 docker network disconnect ${compose.appName} dokploy-traefik;
			cd ${projectPath} && env -i PATH="$PATH" docker compose -p ${compose.appName} down ${
				deleteVolumes ? "--volumes" : ""
			} && rm -rf ${projectPath}`;

			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command, {
					cwd: projectPath,
				});
			}
		}
	} catch (error) {
		throw error;
	}

	return true;
};

export const startCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);

		const projectPath = join(COMPOSE_PATH, compose.appName, "code");
		const path =
			compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
		const baseCommand = `env -i PATH="$PATH" docker compose -p ${compose.appName} -f ${path} up -d`;
		if (compose.composeType === "docker-compose") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`cd ${projectPath} && ${baseCommand}`,
				);
			} else {
				await execAsync(baseCommand, {
					cwd: projectPath,
				});
			}
		}

		await updateCompose(composeId, {
			composeStatus: "done",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "idle",
		});
		throw error;
	}

	return true;
};

export const stopCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);
		if (compose.composeType === "docker-compose") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`cd ${join(COMPOSE_PATH, compose.appName)} && env -i PATH="$PATH" docker compose -p ${
						compose.appName
					} stop`,
				);
			} else {
				await execAsync(
					`env -i PATH="$PATH" docker compose -p ${compose.appName} stop`,
					{
						cwd: join(COMPOSE_PATH, compose.appName),
					},
				);
			}
		}

		if (compose.composeType === "stack") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`docker stack rm ${compose.appName}`,
				);
			} else {
				await execAsync(`docker stack rm ${compose.appName}`);
			}
		}

		await updateCompose(composeId, {
			composeStatus: "idle",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};
