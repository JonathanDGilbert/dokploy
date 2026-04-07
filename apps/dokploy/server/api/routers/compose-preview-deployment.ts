import {
	findComposeById,
	findComposePreviewDeploymentById,
	findComposePreviewDeploymentsByComposeId,
	IS_CLOUD,
	removeComposePreviewDeployment,
} from "@dokploy/server";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { apiFindAllByComposePreview } from "@/server/db/schema";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";
import { deploy } from "@/server/utils/deploy";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const composePreviewDeploymentRouter = createTRPCRouter({
	all: protectedProcedure
		.input(apiFindAllByComposePreview)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["read"],
			});
			return await findComposePreviewDeploymentsByComposeId(input.composeId);
		}),

	one: protectedProcedure
		.input(z.object({ composePreviewDeploymentId: z.string() }))
		.query(async ({ input, ctx }) => {
			const previewDeployment = await findComposePreviewDeploymentById(
				input.composePreviewDeploymentId,
			);
			await checkServicePermissionAndAccess(ctx, previewDeployment.composeId, {
				deployment: ["read"],
			});
			return previewDeployment;
		}),

	delete: protectedProcedure
		.input(z.object({ composePreviewDeploymentId: z.string() }))
		.mutation(async ({ input, ctx }) => {
			const previewDeployment = await findComposePreviewDeploymentById(
				input.composePreviewDeploymentId,
			);
			await checkServicePermissionAndAccess(ctx, previewDeployment.composeId, {
				deployment: ["cancel"],
			});
			await removeComposePreviewDeployment(input.composePreviewDeploymentId);
			await audit(ctx, {
				action: "delete",
				resourceType: "composePreviewDeployment",
				resourceId: input.composePreviewDeploymentId,
			});
			return true;
		}),

	redeploy: protectedProcedure
		.input(
			z.object({
				composePreviewDeploymentId: z.string(),
				title: z.string().optional(),
				description: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const previewDeployment = await findComposePreviewDeploymentById(
				input.composePreviewDeploymentId,
			);
			await checkServicePermissionAndAccess(ctx, previewDeployment.composeId, {
				deployment: ["create"],
			});
			const compose = await findComposeById(previewDeployment.composeId);
			const jobData: DeploymentJob = {
				composeId: previewDeployment.composeId,
				titleLog: input.title || "Rebuild Compose Preview Deployment",
				descriptionLog: input.description || "",
				type: "redeploy",
				applicationType: "compose-preview",
				composePreviewDeploymentId: input.composePreviewDeploymentId,
				server: !!compose.serverId,
			};

			if (IS_CLOUD && compose.serverId) {
				jobData.serverId = compose.serverId;
				deploy(jobData).catch((error) => {
					console.error("Background deployment failed:", error);
				});
				await audit(ctx, {
					action: "redeploy",
					resourceType: "composePreviewDeployment",
					resourceId: input.composePreviewDeploymentId,
				});
				return true;
			}
			await myQueue.add(
				"deployments",
				{ ...jobData },
				{
					removeOnComplete: true,
					removeOnFail: true,
				},
			);
			await audit(ctx, {
				action: "redeploy",
				resourceType: "composePreviewDeployment",
				resourceId: input.composePreviewDeploymentId,
			});
			return true;
		}),
});
