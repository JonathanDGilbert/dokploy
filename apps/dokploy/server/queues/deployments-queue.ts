import {
	deployApplication,
	deployCompose,
	deployPreviewApplication,
	deployPreviewCompose,
	IS_CLOUD,
	rebuildApplication,
	rebuildCompose,
	rebuildPreviewApplication,
	rebuildPreviewCompose,
	updateApplicationStatus,
	updateCompose,
	updateComposePreviewDeployment,
	updatePreviewDeployment,
} from "@dokploy/server";
import { type Job, Worker } from "bullmq";
import type { DeploymentJob } from "./queue-types";
import { redisConfig } from "./redis-connection";

const createDeploymentWorker = () =>
	new Worker(
		"deployments",
		async (job: Job<DeploymentJob>) => {
			try {
				if (job.data.applicationType === "application") {
					await updateApplicationStatus(job.data.applicationId, "running");

					if (job.data.type === "redeploy") {
						await rebuildApplication({
							applicationId: job.data.applicationId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
						});
					} else if (job.data.type === "deploy") {
						await deployApplication({
							applicationId: job.data.applicationId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
						});
					}
				} else if (job.data.applicationType === "compose") {
					await updateCompose(job.data.composeId, {
						composeStatus: "running",
					});
					if (job.data.type === "deploy") {
						await deployCompose({
							composeId: job.data.composeId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
						});
					} else if (job.data.type === "redeploy") {
						await rebuildCompose({
							composeId: job.data.composeId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
						});
					}
				} else if (job.data.applicationType === "application-preview") {
					await updatePreviewDeployment(job.data.previewDeploymentId, {
						previewStatus: "running",
					});

					if (job.data.type === "redeploy") {
						await rebuildPreviewApplication({
							applicationId: job.data.applicationId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
							previewDeploymentId: job.data.previewDeploymentId,
						});
					} else if (job.data.type === "deploy") {
						await deployPreviewApplication({
							applicationId: job.data.applicationId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
							previewDeploymentId: job.data.previewDeploymentId,
						});
					}
				} else if (job.data.applicationType === "compose-preview") {
					await updateComposePreviewDeployment(
						job.data.composePreviewDeploymentId,
						{
							previewStatus: "running",
						},
					);

					if (job.data.type === "redeploy") {
						await rebuildPreviewCompose({
							composeId: job.data.composeId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
							composePreviewDeploymentId: job.data.composePreviewDeploymentId,
						});
					} else if (job.data.type === "deploy") {
						await deployPreviewCompose({
							composeId: job.data.composeId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
							composePreviewDeploymentId: job.data.composePreviewDeploymentId,
						});
					}
				}
			} catch (error) {
				console.log("Error", error);
			}
		},
		{
			autorun: false,
			connection: redisConfig,
		},
	);

/** No-op worker when Redis is disabled (e.g. IS_CLOUD). Avoids BullMQ connection errors. */
const noopWorker = {
	run: () => Promise.resolve(),
	close: () => Promise.resolve(),
	cancelJob: () => Promise.resolve(),
	cancelAllJobs: () => Promise.resolve(),
};

export const deploymentWorker = !IS_CLOUD
	? createDeploymentWorker()
	: (noopWorker as unknown as Worker<DeploymentJob>);
