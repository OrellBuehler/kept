import type {
  EndpointModule,
  PageModule,
  Route,
} from "$lib/server/app-api/bridge";

const page = (
  api: string,
  module: () => Promise<PageModule>,
  web = `/${api}`,
): Route<PageModule> => ({
  api,
  web,
  routeId: `/(app)${web === "/" ? "" : web}`,
  module,
});

/**
 * The web pages the apps can use. Pages that hand out or manage credentials
 * (security settings, API tokens), the integrations and the administrator
 * pages are left out on purpose: the apps open those in the browser. A page's `load` data and the fields of its
 * actions are the contract of `/api/app/v1/pages/…`: released apps depend on
 * them, so change them additively only (see docs/app-api.md).
 */
export const pages: readonly Route<PageModule>[] = [
  page("dashboard", () => import("../../../(app)/+page.server"), "/"),
  page("accounts", () => import("../../../(app)/accounts/+page.server")),
  page(
    "accounts/[id]",
    () => import("../../../(app)/accounts/[id]/+page.server"),
  ),
  page(
    "accounts/[id]/imports",
    () => import("../../../(app)/accounts/[id]/imports/+page.server"),
  ),
  page("bills", () => import("../../../(app)/bills/+page.server")),
  page("bills/new", () => import("../../../(app)/bills/new/+page.server")),
  page("bills/[id]", () => import("../../../(app)/bills/[id]/+page.server")),
  page("budgets", () => import("../../../(app)/budgets/+page.server")),
  page("forecast", () => import("../../../(app)/forecast/+page.server")),
  page("import", () => import("../../../(app)/import/+page.server")),
  page(
    "import/[pendingId]",
    () => import("../../../(app)/import/[pendingId]/+page.server"),
  ),
  page(
    "import/[pendingId]/mapping",
    () => import("../../../(app)/import/[pendingId]/mapping/+page.server"),
  ),
  page("investments", () => import("../../../(app)/investments/+page.server")),
  page("pillar-3a", () => import("../../../(app)/pillar-3a/+page.server")),
  page("recurring", () => import("../../../(app)/recurring/+page.server")),
  page("reports", () => import("../../../(app)/reports/+page.server")),
  page("review", () => import("../../../(app)/review/+page.server")),
  page("taxes", () => import("../../../(app)/taxes/+page.server")),
  page(
    "taxes/[year]",
    () => import("../../../(app)/taxes/[year]/+page.server"),
  ),
  page(
    "settings/account",
    () => import("../../../(app)/settings/account/+page.server"),
  ),
  page(
    "settings/categories",
    () => import("../../../(app)/settings/categories/+page.server"),
  ),
  page(
    "settings/market-data",
    () => import("../../../(app)/settings/market-data/+page.server"),
  ),
  page(
    "settings/notifications",
    () => import("../../../(app)/settings/notifications/+page.server"),
  ),
  page(
    "settings/preferences",
    () => import("../../../(app)/settings/preferences/+page.server"),
  ),
];

const endpoint = (
  api: string,
  routeId: string,
  module: () => Promise<EndpointModule>,
): Route<EndpointModule> => ({
  api,
  web: routeId.replace("/(app)", ""),
  routeId,
  module,
});

/** `+server.ts` handlers passed through as they are: documents, reports, logos and the JSON previews. */
export const endpoints: readonly Route<EndpointModule>[] = [
  endpoint(
    "bills/[id]/document",
    "/(app)/bills/[id]/document",
    () => import("../../../(app)/bills/[id]/document/+server"),
  ),
  endpoint(
    "reports/[kind]",
    "/(app)/reports/[kind]",
    () => import("../../../(app)/reports/[kind]/+server"),
  ),
  endpoint(
    "institutions/[id]/logo",
    "/(app)/institutions/[id]/logo",
    () => import("../../../(app)/institutions/[id]/logo/+server"),
  ),
  endpoint(
    "imports/[pendingId]/preview",
    "/api/imports/[pendingId]/preview",
    () => import("../../imports/[pendingId]/preview/+server"),
  ),
  endpoint(
    "pillar-3a/buy-in-check",
    "/api/pillar-3a/buy-in-check",
    () => import("../../pillar-3a/buy-in-check/+server"),
  ),
];
