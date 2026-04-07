CREATE TABLE IF NOT EXISTS "compose_preview_deployments" (
	"composePreviewDeploymentId" text PRIMARY KEY NOT NULL,
	"branch" text NOT NULL,
	"pullRequestId" text NOT NULL,
	"pullRequestNumber" text NOT NULL,
	"pullRequestURL" text NOT NULL,
	"pullRequestTitle" text NOT NULL,
	"pullRequestCommentId" text NOT NULL,
	"previewStatus" "applicationStatus" DEFAULT 'idle' NOT NULL,
	"appName" text NOT NULL,
	"composeId" text NOT NULL,
	"domainId" text,
	"createdAt" text NOT NULL,
	"expiresAt" text,
	CONSTRAINT "compose_preview_deployments_appName_unique" UNIQUE("appName")
);
--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewEnv" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewLabels" text[];--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewWildcard" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewPort" integer DEFAULT 3000;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewHttps" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewPath" text DEFAULT '/';--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewCertificateType" "certificateType" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewCustomCertResolver" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewLimit" integer DEFAULT 3;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "isPreviewDeploymentsActive" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewRequireCollaboratorPermissions" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "previewServiceName" text DEFAULT 'gateway';--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "composePreviewDeploymentId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "composePreviewDeploymentId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "compose_preview_deployments" ADD CONSTRAINT "compose_preview_deployments_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "compose_preview_deployments" ADD CONSTRAINT "compose_preview_deployments_domainId_domain_domainId_fk" FOREIGN KEY ("domainId") REFERENCES "public"."domain"("domainId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain" ADD CONSTRAINT "domain_composePreviewDeploymentId_compose_preview_deployments_composePreviewDeploymentId_fk" FOREIGN KEY ("composePreviewDeploymentId") REFERENCES "public"."compose_preview_deployments"("composePreviewDeploymentId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployment" ADD CONSTRAINT "deployment_composePreviewDeploymentId_compose_preview_deployments_composePreviewDeploymentId_fk" FOREIGN KEY ("composePreviewDeploymentId") REFERENCES "public"."compose_preview_deployments"("composePreviewDeploymentId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
